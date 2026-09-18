/**
 * What the mobile app needs on a push beyond its copy: the category its action
 * buttons register against, the thread iOS groups by, the violation's session
 * while it can still be terminated, and the silent sessions sync that wakes the
 * widget. Everything below the message builder is stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExpoPushMessage } from 'expo-server-sdk';
import type { ViolationWithDetails } from '@tracearr/shared';
import { createMockActiveSession } from '../../test/fixtures.js';

const { sent, rows, activeSessionIds, claimSessionsSync } = vi.hoisted(() => ({
  sent: [] as ExpoPushMessage[],
  rows: [] as Record<string, unknown>[],
  activeSessionIds: [] as string[],
  claimSessionsSync: vi.fn(),
}));

vi.mock('expo-server-sdk', () => {
  class Expo {
    static isExpoPushToken = () => true;
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    chunkPushNotifications(messages: ExpoPushMessage[]) {
      return [messages];
    }
    // eslint-disable-next-line @typescript-eslint/class-methods-use-this
    async sendPushNotificationsAsync(messages: ExpoPushMessage[]) {
      sent.push(...messages);
      return messages.map(() => ({ status: 'ok' as const, id: 'receipt-1' }));
    }
  }
  return { Expo };
});

/** Every drizzle step returns the same thenable, so both queries resolve to `rows`. */
vi.mock('../../db/client.js', () => {
  const chain: Record<string, unknown> = {};
  for (const key of ['select', 'from', 'leftJoin', 'where', 'limit']) {
    chain[key] = () => chain;
  }
  chain['then'] = (resolve: (value: unknown) => unknown) => resolve(rows);
  return { db: chain };
});

vi.mock('../cache.js', () => ({
  getCacheService: () => ({ getActiveSessionIds: async () => activeSessionIds }),
}));
vi.mock('../pushRateLimiter.js', () => ({
  getPushRateLimiter: () => ({
    checkAndRecord: async () => ({ allowed: true }),
    claimSessionsSync,
  }),
}));
vi.mock('../quietHours.js', () => ({
  quietHoursService: { shouldSend: () => true, shouldSendEvent: () => true },
}));
vi.mock('../pushEncryption.js', () => ({
  pushEncryptionService: { encryptIfEnabled: (data: unknown) => data },
}));
vi.mock('../../routes/settings.js', () => ({
  getNetworkSettings: async () => ({ externalUrl: null }),
}));
vi.mock('../imageProxy.js', () => ({
  buildPushPosterUrl: () => null,
  buildPushAvatarUrl: () => null,
  buildLogoUrl: () => null,
}));

import { hashSha256 } from '../../utils/hash.js';
import { pushNotificationService } from '../pushNotification.js';

const SERVER_ID = '0b9f6a52-5c1e-4a63-9d0e-2f4f4d1c7a10';
const SERVER_USER_ID = '7d1c3e88-91a4-4f0b-8a55-c3b2e6f9d421';
const threadOf = (kind: 'server' | 'user', id: string) => `${kind}:${hashSha256(id).slice(0, 32)}`;

/** The message as Expo and APNs can read it: everything except the encrypted data. */
function outsideData(message: ExpoPushMessage | undefined): string {
  if (!message) throw new Error('nothing was sent');
  const { data: _data, ...visible } = message;
  return JSON.stringify(visible);
}

const session = createMockActiveSession({
  server: { id: SERVER_ID, name: 'Living Room', type: 'plex' },
});

const violation: ViolationWithDetails = {
  id: 'violation-1',
  ruleId: 'rule-1',
  serverUserId: 'su-1',
  sessionId: 'session-1',
  severity: 'warning',
  data: {},
  acknowledgedAt: null,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  user: {
    id: 'su-1',
    username: 'alice',
    serverId: 'srv-1',
    thumbUrl: null,
    identityName: 'Alice',
    userId: 'user-1',
  },
  rule: { id: 'rule-1', name: 'Too many streams', type: null },
  server: { id: SERVER_ID, name: 'Living Room', type: 'plex' },
};

function device(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expoPushToken: 'ExponentPushToken[ios-1]',
    mobileSessionId: 'mob-ios-1',
    platform: 'ios',
    deviceSecret: null,
    pushEnabled: true,
    onViolationDetected: true,
    onStreamStarted: true,
    onStreamStopped: true,
    onNewDevice: true,
    violationMinSeverity: 1,
    violationRuleTypes: [],
    ...overrides,
  };
}

beforeEach(() => {
  sent.length = 0;
  rows.length = 0;
  activeSessionIds.length = 0;
  claimSessionsSync.mockReset().mockResolvedValue(true);
  rows.push(device());
});

describe('push category and thread', () => {
  it('marks a violation and groups it with its server', async () => {
    await pushNotificationService.notifyViolation(violation);

    expect(sent[0]).toMatchObject({
      categoryId: 'violation',
      threadId: threadOf('server', SERVER_ID),
    });
    expect(outsideData(sent[0])).not.toContain(SERVER_ID);
  });

  it('marks stream starts and stops alike and groups them with their server', async () => {
    await pushNotificationService.notifySessionStarted(session);
    await pushNotificationService.notifySessionStopped(session);

    expect(sent).toHaveLength(2);
    for (const message of sent) {
      expect(message).toMatchObject({
        categoryId: 'stream',
        threadId: threadOf('server', SERVER_ID),
      });
      expect(outsideData(message)).not.toContain(SERVER_ID);
    }
  });

  it('groups a push about a person by that person', async () => {
    await pushNotificationService.notifyNewDevice({
      serverId: SERVER_ID,
      serverName: 'Living Room',
      serverType: 'plex',
      serverUserId: SERVER_USER_ID,
      sessionId: 'session-1',
      userName: 'Alice',
      username: 'alice',
      identityName: 'Alice',
      mediaTitle: 'Arrival',
      mediaType: 'movie',
      deviceName: 'Apple TV',
      platform: null,
      product: null,
      location: null,
    });

    expect(sent[0]).toMatchObject({
      categoryId: 'new_device',
      threadId: threadOf('user', SERVER_USER_ID),
    });
    expect(outsideData(sent[0])).not.toContain(SERVER_USER_ID);
    expect(outsideData(sent[0])).not.toContain(SERVER_ID);
  });
});

describe('violation sessionId', () => {
  it('carries the session while it is still active', async () => {
    activeSessionIds.push('session-1');

    await pushNotificationService.notifyViolation(violation);

    expect(sent[0]?.data).toMatchObject({ violationId: 'violation-1', sessionId: 'session-1' });
  });

  it('leaves it out once the session has ended', async () => {
    await pushNotificationService.notifyViolation(violation);

    expect(sent[0]?.data).toMatchObject({ violationId: 'violation-1' });
    expect(sent[0]?.data).not.toHaveProperty('sessionId');
  });
});

describe('silent sessions sync', () => {
  it('wakes an iOS device that has stream notifications off, and shows nothing', async () => {
    rows.length = 0;
    rows.push(
      device({ onStreamStarted: false, onStreamStopped: false }),
      device({ expoPushToken: 'ExponentPushToken[android-1]', platform: 'android' }),
      device({ expoPushToken: 'ExponentPushToken[ios-off]', pushEnabled: false })
    );

    await pushNotificationService.triggerSessionsSync();

    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message).toMatchObject({
      to: 'ExponentPushToken[ios-1]',
      _contentAvailable: true,
      data: { type: 'data_sync', syncType: 'sessions' },
    });
    expect(message).not.toHaveProperty('title');
    expect(message).not.toHaveProperty('body');
    expect(message).not.toHaveProperty('sound');
  });

  it('skips a device whose claim is still inside the window', async () => {
    claimSessionsSync.mockResolvedValue(false);

    await pushNotificationService.triggerSessionsSync();

    expect(claimSessionsSync).toHaveBeenCalledWith('mob-ios-1');
    expect(sent).toHaveLength(0);
  });
});
