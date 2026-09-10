import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViolationWithDetails } from '@tracearr/shared';
import { createMockActiveSession } from '../../../test/fixtures.js';
import {
  pushoverType,
  type PushoverConfig,
  type PushoverMessage,
} from '../destinations/pushover.js';
import type { NotificationEvent } from '../events.js';
import type { RenderContext } from '../destinations/types.js';

const config: PushoverConfig = { userKey: 'u_user_key_123', apiToken: 'a_api_token_456' };
const destination = { id: 'dest-1', name: 'My Pushover' };
const systemCtx: RenderContext = { destination, source: { kind: 'system' } };
const deliverCtx = { destination, signal: AbortSignal.timeout(5000) };

const violation: ViolationWithDetails = {
  id: 'violation-123',
  ruleId: 'rule-456',
  serverUserId: 'user-789',
  sessionId: 'session-123',
  severity: 'warning',
  data: { reason: 'test violation' },
  acknowledgedAt: null,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  user: {
    id: 'user-789',
    username: 'testuser',
    serverId: 'server-id',
    thumbUrl: null,
    identityName: 'Test User',
  },
  rule: { id: 'rule-456', name: 'Test Rule', type: 'concurrent_streams' },
};

const session = createMockActiveSession({ durationMs: 3_725_000 });

const render = async (
  event: Parameters<typeof pushoverType.render>[0],
  ctx: RenderContext = systemCtx
): Promise<PushoverMessage> => pushoverType.render(event, config, ctx);

const mediaUpgraded: NotificationEvent = {
  type: 'media_upgraded',
  payload: {
    serverId: 'server-1',
    serverName: 'Basement',
    serverType: 'plex',
    libraryItemId: 'item-1',
    ratingKey: 'rk-1',
    mediaId: null,
    parentTitle: null,
    grandparentRatingKey: null,
    parentRatingKey: null,
    parentIndex: null,
    itemIndex: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    thumbPath: null,
    title: 'Cars',
    grandparentTitle: null,
    mediaType: 'movie',
    year: 2006,
    libraryName: 'Movies',
    to: {
      resolution: '4k',
      dynamicRange: 'hdr10',
      videoCodec: 'HEVC',
      audioCodec: 'TRUEHD',
      audioChannels: 8,
      fileSize: 42_000_000_000,
    },
    from: {
      resolution: '1080p',
      dynamicRange: 'sdr',
      videoCodec: 'H264',
      audioCodec: 'AC3',
      audioChannels: 6,
      fileSize: 8_000_000_000,
    },
    changed: ['resolution'],
  },
};

describe('pushoverType.render', () => {
  it('builds the violation params with the severity priority', async () => {
    const message = await render({ type: 'violation', payload: violation });

    expect(message).toEqual({
      title: 'Violation Detected',
      message: 'User Test User triggered Test Rule (Warning severity)',
      priority: '0',
    });
  });

  it('maps a high severity violation to priority 1', async () => {
    const message = await render({
      type: 'violation',
      payload: { ...violation, severity: 'high' },
    });

    expect(message.priority).toBe('1');
  });

  it('builds the stream started params', async () => {
    const message = await render({ type: 'session_started', payload: session });

    expect(message).toEqual({
      title: 'Stream Started',
      message: 'testuser started watching Test Movie - 2024',
      priority: '-1',
    });
  });

  it('builds the stream stopped params with a formatted duration', async () => {
    const message = await render({ type: 'session_stopped', payload: session });

    expect(message).toEqual({
      title: 'Stream Ended',
      message: 'testuser finished watching Test Movie - 2024 (1h 2m)',
      priority: '-1',
    });
  });

  it('builds the server down params at priority 1', async () => {
    const message = await render({
      type: 'server_down',
      payload: { serverName: 'Plex Server', serverId: 's1' },
    });

    expect(message).toEqual({
      title: 'Server Offline',
      message: 'Plex Server is not responding',
      priority: '1',
    });
  });

  it('builds the server up params at priority 1', async () => {
    const message = await render({
      type: 'server_up',
      payload: { serverName: 'Plex Server', serverId: 's1' },
    });

    expect(message).toEqual({
      title: 'Server Online',
      message: 'Plex Server is back online',
      priority: '1',
    });
  });

  it('builds the plugin update params', async () => {
    const message = await render({
      type: 'plugin_update_available',
      payload: {
        serverId: 'server-1',
        serverName: 'Jellyfin',
        serverType: 'jellyfin',
        installedVersion: '0.2.0',
        latestVersion: '0.3.0',
        downloadUrl: 'https://example.com/plugin.zip',
      },
    });

    expect(message.title).toBe('Plugin Update Available');
    expect(message.message).toContain('Jellyfin: ');
    expect(message.message).toContain('latest 0.3.0');
    expect(message.priority).toBe('-1');
  });

  it('uses the rule source title for a rule send', async () => {
    const message = await render(
      { type: 'violation', payload: violation },
      { destination, source: { kind: 'rule', title: 'Rule fired', message: 'Too many streams' } }
    );

    expect(message.title).toBe('Rule fired');
    expect(message.message).toBe('User Test User triggered Test Rule (Warning severity)');
  });
});

describe('pushoverType.deliver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const message: PushoverMessage = {
    title: 'Server Offline',
    message: 'Plex Server is not responding',
    priority: '1',
  };

  it('posts a form-encoded body to the pushover api', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', f);

    await pushoverType.deliver(message, config, deliverCtx);

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });

    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toEqual({
      token: 'a_api_token_456',
      user: 'u_user_key_123',
      title: 'Server Offline',
      message: 'Plex Server is not responding',
      priority: '1',
    });
  });

  it('throws when pushover rejects the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('invalid token', { status: 400 }))
    );

    await expect(pushoverType.deliver(message, config, deliverCtx)).rejects.toThrow(
      /400 invalid token/
    );
  });

  it('posts the test message', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', f);

    await pushoverType.test(config, deliverCtx);

    const body = new URLSearchParams(f.mock.calls[0]?.[1].body as string);
    expect(Object.fromEntries(body)).toEqual({
      token: 'a_api_token_456',
      user: 'u_user_key_123',
      title: 'Test Notification',
      message: 'This is a test notification from Tracearr',
      priority: '-1',
    });
  });
});

const newDevice = {
  type: 'new_device',
  payload: {
    serverId: 'server-1',
    serverName: 'Basement',
    serverType: 'plex',
    serverUserId: 'su-1',
    sessionId: 'sess-1',
    userName: 'Test User',
    username: 'testuser',
    identityName: 'Test User',
    mediaTitle: 'Cars',
    mediaType: 'movie',
    deviceName: 'Living Room TV',
    platform: 'tvOS',
    product: 'Plex for Apple TV',
    location: 'Boston, Massachusetts',
  },
} as const;

const trustChanged = {
  type: 'trust_score_changed',
  payload: {
    serverId: 'server-1',
    serverName: 'Basement',
    serverType: 'plex',
    serverUserId: 'su-1',
    userName: 'Test User',
    username: 'testuser',
    identityName: 'Test User',
    previousScore: 90,
    newScore: 40,
    reason: 'Sharing penalty',
  },
} as const;

const newsletterSend = {
  type: 'newsletter_send',
  payload: {
    newsletterId: 'n-1',
    sendId: 'send-1',
    name: 'Weekly',
    outcome: 'partial',
    trigger: 'schedule',
    recipientCount: 42,
    itemCounts: { movies: 3, shows: 1, episodes: 4, albums: 0, mostWatched: 0 },
    error: null,
    windowStart: '2026-08-26T00:00:00.000Z',
    windowEnd: '2026-09-02T00:00:00.000Z',
    historyUrl: null,
  },
} as const;

const automationCtx = (over: { title?: string; body?: string } = {}): RenderContext => ({
  destination,
  source: { kind: 'automation', automationId: 'a-1', automationName: 'Now playing', ...over },
});

describe('pushoverType.render with an automation source', () => {
  it('keeps the builtin stream text when nothing is overridden', async () => {
    const message = await render({ type: 'session_started', payload: session }, automationCtx());

    expect(message.title).toBe('Stream Started');
  });

  it('renders a new device and a trust move from the payload text', async () => {
    const device = await render(newDevice, automationCtx());
    expect(device.title).toBe('New device');
    expect(device.message).toBe(
      'Test User connected from a new device: Living Room TV from Boston, Massachusetts'
    );

    const trust = await render(trustChanged, automationCtx());
    expect(trust.title).toBe('Trust score changed');
    expect(trust.message).toBe("Test User's trust score dropped from 90 to 40: Sharing penalty");
  });

  it('renders a media upgrade, and an override still wins', async () => {
    const message = await render(mediaUpgraded, automationCtx());
    expect(message.title).toBe('Media upgraded');
    expect(message.message).toBe('Cars (2006) on Basement was upgraded: resolution 1080p → 4K');

    const overridden = await render(mediaUpgraded, automationCtx({ body: '4K at last' }));
    expect(overridden.message).toBe('4K at last');
  });

  it('uses the rendered override for a stream start', async () => {
    const message = await render(
      { type: 'session_started', payload: session },
      automationCtx({ title: 'Heads up', body: '{{user.username}} pressed play' })
    );

    expect(message.title).toBe('Heads up');
    expect(message.message).toBe('testuser pressed play');
  });

  it('carries the newsletter outcome as its own text', async () => {
    const message = await render(newsletterSend, automationCtx());
    expect(message.title).toBe('Newsletter partly sent');
    expect(message.message).toBe('Weekly reached only part of its 42 recipients');
  });
});
