import { describe, expect, it, vi } from 'vitest';
import { DESTINATION_TEXT_PROFILES, type DestinationTextProfile } from '@tracearr/shared';

const mockBuildMediaLinks = vi.fn();
vi.mock('../mediaLinks.js', () => ({
  buildMediaLinks: (...args: unknown[]) => mockBuildMediaLinks(...args) as unknown,
}));

import { createMockActiveSession } from '../../../test/fixtures.js';
import { priorityOf, renderText, type TextMessage } from '../destinations/text.js';
import { toNotificationPayload } from '../types.js';
import { KIDS, kidsSession, mediaAdded, mediaUpgraded, session, violation } from './fixtures.js';
import type { NotificationEvent, NotificationSource } from '../events.js';

mockBuildMediaLinks.mockResolvedValue([
  { label: 'Tracearr', url: 'https://t.example/media/1' },
  { label: 'Plex', url: 'https://plex.example/item' },
]);

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

const system: NotificationSource = { kind: 'system' };

const automation = (over: { title?: string; body?: string } = {}): NotificationSource => ({
  kind: 'automation',
  automationId: 'a-1',
  automationName: 'Now playing',
  ...over,
});

const render = async (
  event: NotificationEvent,
  source: NotificationSource = system,
  profile: DestinationTextProfile = DESTINATION_TEXT_PROFILES.gotify
): Promise<TextMessage> => (await renderText(event, source, profile)).text;

describe('renderText text', () => {
  it('builds the violation message', async () => {
    expect(await render({ type: 'violation', payload: violation })).toEqual({
      title: 'Violation Detected',
      message: 'User Test User triggered Test Rule (High severity)',
    });
  });

  it('builds the stream started message', async () => {
    expect(await render({ type: 'session_started', payload: session })).toEqual({
      title: 'Stream Started',
      message: 'testuser started watching Test Movie - 2024',
    });
  });

  it('builds the stream stopped message with a formatted duration', async () => {
    expect(await render({ type: 'session_stopped', payload: session })).toEqual({
      title: 'Stream Ended',
      message: 'testuser finished watching Test Movie - 2024 (1h 2m)',
    });
  });

  it('names the non-main profile inline in a stream message', async () => {
    const text = await render(
      { type: 'session_started', payload: kidsSession },
      system,
      DESTINATION_TEXT_PROFILES.ntfy
    );
    expect(text.message).toBe('connor (Kids) started watching Bluey - 2024');
  });

  it('prints a removed profile by its last name', async () => {
    const text = await render({
      type: 'session_stopped',
      payload: { ...kidsSession, nonMainProfile: { ...KIDS, removed: true } },
    });
    expect(text.message).toMatch(/^connor \(Kids\) finished watching Bluey/);
  });

  it('builds the server down message', async () => {
    const text = await render({
      type: 'server_down',
      payload: { serverName: 'Plex Server', serverId: 's1' },
    });
    expect(text).toEqual({ title: 'Server Offline', message: 'Plex Server is not responding' });
  });

  it('builds the server up message', async () => {
    const text = await render({
      type: 'server_up',
      payload: { serverName: 'Plex Server', serverId: 's1' },
    });
    expect(text).toEqual({ title: 'Server Online', message: 'Plex Server is back online' });
  });

  it('builds the plugin update message', async () => {
    const text = await render({
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

    expect(text.title).toBe('Plugin Update Available');
    expect(text.message).toContain('Jellyfin: ');
    expect(text.message).toContain('latest 0.3.0');
  });
});

describe('renderText with an automation source', () => {
  it('keeps the builtin stream text when nothing is overridden', async () => {
    const text = await render({ type: 'session_started', payload: session }, automation());

    expect(text.title).toBe('Stream Started');
    expect(text.message).toBe('testuser started watching Test Movie - 2024');
  });

  it('renders a new device and a trust move from the payload text', async () => {
    const device = await render(newDevice, automation());
    expect(device.title).toBe('New device');
    expect(device.message).toBe(
      'Test User connected from a new device: Living Room TV from Boston, Massachusetts'
    );

    const trust = await render(trustChanged, automation());
    expect(trust.title).toBe('Trust score changed');
    expect(trust.message).toBe("Test User's trust score dropped from 90 to 40: Sharing penalty");
  });

  it('renders a media upgrade, and an override still wins', async () => {
    const text = await render(mediaUpgraded, automation());
    expect(text.title).toBe('Media upgraded');
    expect(text.message).toBe('Cars (2006) on Basement was upgraded: resolution 1080p → 4K');

    const overridden = await render(mediaUpgraded, automation({ body: '4K at last' }));
    expect(overridden.message).toBe('4K at last');
  });

  it('uses the rendered override for a stream start', async () => {
    const text = await render(
      { type: 'session_started', payload: session },
      automation({ title: 'Heads up', body: '{{user.username}} pressed play' })
    );

    expect(text.title).toBe('Heads up');
    expect(text.message).toBe('testuser pressed play');
  });

  it('honors an override on a violation', async () => {
    const text = await render(
      { type: 'violation', payload: violation },
      automation({ body: 'over the limit' })
    );

    expect(text.message).toBe('over the limit');
  });

  it('falls back to the builtin text when an override renders blank', async () => {
    const text = await render(
      { type: 'session_started', payload: session },
      automation({ title: '   ', body: ' ' })
    );

    expect(text).toEqual({
      title: 'Stream Started',
      message: 'testuser started watching Test Movie - 2024',
    });
  });

  it('carries the newsletter outcome as its own text', async () => {
    const text = await render(newsletterSend, automation());
    expect(text.title).toBe('Newsletter partly sent');
    expect(text.message).toBe('Weekly reached only part of its 42 recipients');
  });

  it('sends values as written', async () => {
    const text = await render(
      {
        type: 'session_started',
        payload: createMockActiveSession({ mediaTitle: 'a_b (2024) - x' }),
      },
      automation({ body: '**{{ session.mediaTitle }}**' })
    );
    expect(text.message).toBe('**a_b (2024) - x**');
  });

  it('cuts the title and message to the profile', async () => {
    const text = await render(
      { type: 'session_started', payload: session },
      automation({ title: 't'.repeat(300), body: 'b'.repeat(1500) }),
      DESTINATION_TEXT_PROFILES.pushover
    );
    expect(Array.from(text.title)).toHaveLength(250);
    expect(Array.from(text.message)).toHaveLength(1024);
  });

  it('cuts a multibyte body to the byte limit', async () => {
    const text = await render(
      { type: 'session_started', payload: session },
      automation({ body: '😀'.repeat(1100) }),
      DESTINATION_TEXT_PROFILES.ntfy
    );
    expect(new TextEncoder().encode(text.message).length).toBeLessThanOrEqual(4096);
    expect(text.message.endsWith('…')).toBe(true);
  });
});

const basePayload = toNotificationPayload(
  { type: 'server_down', payload: { serverName: 'Plex', serverId: 's1' } },
  { kind: 'system' }
);

describe('priorityOf', () => {
  it('maps severity low, warning and high to low, normal and high', () => {
    for (const [severity, expected] of [
      ['low', 'low'],
      ['warning', 'normal'],
      ['high', 'high'],
    ] as const) {
      expect(priorityOf({ ...basePayload, severity })).toBe(expected);
    }
  });

  it('prefers the automation priority when set', () => {
    expect(
      priorityOf({
        ...basePayload,
        severity: 'high',
        automation: { id: 'a', name: 'A', priority: 'lowest' },
      })
    ).toBe('lowest');
  });
});

describe('renderText links', () => {
  it('carries the media links on a media event and none otherwise', async () => {
    const media = await renderText(
      mediaUpgraded,
      { kind: 'system' },
      DESTINATION_TEXT_PROFILES.gotify
    );
    expect(media.links.map((l) => l.label)).toEqual(['Tracearr', 'Plex']);
    const stream = await renderText(
      { type: 'session_started', payload: session },
      { kind: 'system' },
      DESTINATION_TEXT_PROFILES.gotify
    );
    expect(stream.links).toEqual([]);
  });

  it('carries the media links on a media added event', async () => {
    const added = await renderText(mediaAdded, system, DESTINATION_TEXT_PROFILES.gotify);
    expect(added.links.map((l) => l.label)).toEqual(['Tracearr', 'Plex']);
  });

  it('carries no links when the lookup fails', async () => {
    mockBuildMediaLinks.mockRejectedValueOnce(new Error('db down'));
    const media = await renderText(mediaUpgraded, system, DESTINATION_TEXT_PROFILES.gotify);
    expect(media.links).toEqual([]);
  });

  it('skips the lookup when links are turned off', async () => {
    mockBuildMediaLinks.mockClear();
    const media = await renderText(mediaUpgraded, system, DESTINATION_TEXT_PROFILES.gotify, {
      links: false,
    });
    expect(media.links).toEqual([]);
    expect(mockBuildMediaLinks).not.toHaveBeenCalled();
  });
});
