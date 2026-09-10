import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViolationWithDetails } from '@tracearr/shared';
import { createMockActiveSession } from '../../../test/fixtures.js';
import { jsonWebhookType, type JsonWebhookBody } from '../destinations/jsonWebhook.js';
import type { NotificationEvent } from '../events.js';
import type { RenderContext } from '../destinations/types.js';

const config = { url: 'https://example.com/webhook' };
const destination = { id: 'dest-1', name: 'My Webhook' };
const systemCtx: RenderContext = { destination, source: { kind: 'system' } };
const ruleCtx: RenderContext = {
  destination,
  source: { kind: 'rule', title: 'Rule fired', message: 'Too many streams' },
};
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

const session = createMockActiveSession({
  mediaTitle: 'Test Movie',
  mediaType: 'movie',
  year: 2024,
  durationMs: 5000,
  ratingKey: 'media-123',
  parentRatingKey: 'parent-456',
  grandparentRatingKey: 'grandparent-789',
  mediaId: 'media-uuid-1',
  imdbId: 'tt1234567',
  tmdbId: 111,
  tvdbId: 222,
});

const render = async (
  event: Parameters<typeof jsonWebhookType.render>[0],
  ctx: RenderContext = systemCtx
): Promise<JsonWebhookBody> => jsonWebhookType.render(event, config, ctx);

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

describe('jsonWebhookType.render', () => {
  it('builds the violation body with user, rule and violation blocks', async () => {
    const body = await render({ type: 'violation', payload: violation });

    expect(body.event).toBe('violation_detected');
    expect(typeof body.timestamp).toBe('string');
    expect(body.data).toEqual({
      user: { id: 'user-789', username: 'testuser', displayName: 'Test User' },
      rule: { id: 'rule-456', type: 'concurrent_streams', name: 'Test Rule' },
      violation: {
        id: 'violation-123',
        severity: 'warning',
        details: { reason: 'test violation' },
      },
    });
  });

  it('builds the stream started body with the media identity block', async () => {
    const body = await render({ type: 'session_started', payload: session });

    expect(body.event).toBe('stream_started');
    expect(body.data.media).toEqual({
      title: 'Test Movie',
      subtitle: '2024',
      type: 'movie',
      year: 2024,
      mediaId: 'media-uuid-1',
      imdbId: 'tt1234567',
      tmdbId: 111,
      tvdbId: 222,
      ratingKey: 'media-123',
      parentRatingKey: 'parent-456',
      grandparentRatingKey: 'grandparent-789',
    });
    expect(body.data.playback).toEqual({
      type: 'Direct Play',
      quality: '1080p',
      player: 'Plex Web',
    });
    expect(body.data.location).toEqual({ city: 'New York', country: 'US' });
  });

  it('normalizes an empty ratingKey to null', async () => {
    const body = await render({
      type: 'session_started',
      payload: createMockActiveSession({ ratingKey: '' }),
    });

    expect((body.data.media as { ratingKey: string | null }).ratingKey).toBeNull();
  });

  it('builds the stream stopped body with the duration', async () => {
    const body = await render({ type: 'session_stopped', payload: session });

    expect(body.event).toBe('stream_stopped');
    expect(body.data.media).toEqual({
      title: 'Test Movie',
      subtitle: '2024',
      type: 'movie',
      mediaId: 'media-uuid-1',
      imdbId: 'tt1234567',
      tmdbId: 111,
      tvdbId: 222,
      ratingKey: 'media-123',
      parentRatingKey: 'parent-456',
      grandparentRatingKey: 'grandparent-789',
    });
    expect(body.data.session).toEqual({ durationMs: 5000 });
  });

  it('builds the server down body', async () => {
    const body = await render({
      type: 'server_down',
      payload: { serverName: 'Plex Server', serverId: 's1' },
    });

    expect(body.event).toBe('server_down');
    expect(body.data).toEqual({ serverName: 'Plex Server', serverType: undefined });
  });

  it('builds the server up body', async () => {
    const body = await render({
      type: 'server_up',
      payload: { serverName: 'Plex Server', serverId: 's1' },
    });

    expect(body.event).toBe('server_up');
    expect(body.data).toEqual({ serverName: 'Plex Server', serverType: undefined });
  });

  it('builds the plugin update body', async () => {
    const body = await render({
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

    expect(body.event).toBe('plugin_update_available');
    expect(body.data).toEqual({
      serverId: 'server-1',
      serverName: 'Jellyfin',
      serverType: 'jellyfin',
      installedVersion: '0.2.0',
      latestVersion: '0.3.0',
      downloadUrl: 'https://example.com/plugin.zip',
    });
  });

  it('keeps the structured body for a rule send', async () => {
    const body = await render({ type: 'violation', payload: violation }, ruleCtx);

    expect(body.event).toBe('violation_detected');
    expect(body).not.toHaveProperty('title');
    expect(body.data.rule).toEqual({
      id: 'rule-456',
      type: 'concurrent_streams',
      name: 'Test Rule',
    });
  });
});

describe('jsonWebhookType.deliver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the body as json', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);

    await jsonWebhookType.deliver(
      { event: 'server_up', timestamp: '2026-01-02T03:04:05.000Z', data: { serverName: 'Plex' } },
      config,
      deliverCtx
    );

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe(config.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      event: 'server_up',
      timestamp: '2026-01-02T03:04:05.000Z',
      data: { serverName: 'Plex' },
    });
  });

  it('throws when the endpoint rejects the post', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));

    await expect(
      jsonWebhookType.deliver(
        { event: 'server_up', timestamp: '2026-01-02T03:04:05.000Z', data: {} },
        config,
        deliverCtx
      )
    ).rejects.toThrow(/500 nope/);
  });

  it('posts the test body', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);

    await jsonWebhookType.test(config, deliverCtx);

    const body = JSON.parse(f.mock.calls[0]?.[1].body);
    expect(body.event).toBe('test');
    expect(body.data.message).toBe('This is a test notification from Tracearr');
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

describe('jsonWebhookType.render with an automation source', () => {
  it('names the automation and carries its rendered overrides', async () => {
    const body = await render(
      { type: 'session_started', payload: session },
      automationCtx({ title: 'Heads up', body: '{{user.username}} pressed play' })
    );

    expect(body.automation).toEqual({
      id: 'a-1',
      name: 'Now playing',
      title: 'Heads up',
      message: 'testuser pressed play',
    });
  });

  it('carries the account payloads flat, under the event name', async () => {
    const device = await render(newDevice, automationCtx());
    expect(device.event).toBe('new_device');
    expect(device.data).toEqual(newDevice.payload);

    const trust = await render(trustChanged, automationCtx());
    expect(trust.event).toBe('trust_score_changed');
    expect(trust.data).toEqual(trustChanged.payload);
  });

  it('carries the whole media payload as data under the event name', async () => {
    const body = await render(mediaUpgraded, automationCtx());

    expect(body.event).toBe('media_upgraded');
    expect(body.data).toEqual(mediaUpgraded.payload);
  });

  it('names the automation with no overrides to carry', async () => {
    const body = await render({ type: 'session_started', payload: session }, automationCtx());

    expect(body.automation).toEqual({ id: 'a-1', name: 'Now playing' });
  });

  it('leaves the automation out of a system event', async () => {
    const body = await render({ type: 'session_started', payload: session });

    expect(body.automation).toBeUndefined();
  });

  it('carries the whole newsletter payload as data under the event name', async () => {
    const body = await render(newsletterSend, automationCtx());
    expect(body.event).toBe('newsletter_send');
    expect(body.data).toEqual(newsletterSend.payload);
  });
});
