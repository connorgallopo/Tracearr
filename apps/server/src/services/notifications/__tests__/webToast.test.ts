import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViolationWithDetails } from '@tracearr/shared';
import { getPubSubService, type PubSubService } from '../../cache.js';
import { createMockActiveSession } from '../../../test/fixtures.js';
import { webToastType, type ToastRendered } from '../destinations/webToast.js';
import type { RenderContext } from '../destinations/types.js';

vi.mock('../../cache.js', () => ({ getPubSubService: vi.fn() }));

const destination = { id: 'dest-toast', name: 'Browser toast' };
const systemCtx: RenderContext = { destination, source: { kind: 'system' } };
const ruleCtx: RenderContext = {
  destination,
  source: { kind: 'rule', title: 'Rule fired', message: 'Too many streams' },
};
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
const deliverCtx = { destination, signal: AbortSignal.timeout(5000) };

const violation: ViolationWithDetails = {
  id: 'violation-123',
  ruleId: 'rule-456',
  serverUserId: 'user-789',
  sessionId: 'session-123',
  severity: 'high',
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

const session = createMockActiveSession();

const render = async (
  event: Parameters<typeof webToastType.render>[0],
  ctx: RenderContext = systemCtx
): Promise<ToastRendered> => webToastType.render(event, {}, ctx);

describe('webToastType.render', () => {
  it('renders nothing for a server event a system source raised', async () => {
    const down = { serverName: 'Plex Server', serverId: 's1' };
    expect(await render({ type: 'server_down', payload: down })).toEqual({});
    expect(await render({ type: 'server_up', payload: down })).toEqual({});
  });

  it('renders nothing for system stream events', async () => {
    expect(await render({ type: 'session_started', payload: session })).toEqual({});
    expect(await render({ type: 'session_stopped', payload: session })).toEqual({});
  });

  it('renders nothing for a system violation', async () => {
    expect(await render({ type: 'violation', payload: violation })).toEqual({});
  });

  it('renders a rule violation as a toast', async () => {
    expect(await render({ type: 'violation', payload: violation }, ruleCtx)).toEqual({
      toast: {
        title: 'Rule fired',
        message: 'Too many streams',
        automationId: 'rule-456',
        automationName: 'Test Rule',
        severity: 'high',
      },
    });
  });

  it('toasts an automation-sourced stream start with the automation behind it', async () => {
    expect(
      await render(
        { type: 'session_started', payload: session },
        automationCtx({ body: '{{user.username}} pressed play' })
      )
    ).toEqual({
      toast: {
        title: 'Stream Started',
        message: 'testuser pressed play',
        automationId: 'a-1',
        automationName: 'Now playing',
        severity: 'low',
      },
    });
  });

  it('toasts an automation-sourced violation shape', async () => {
    expect(await render({ type: 'violation', payload: violation }, automationCtx())).toEqual({
      toast: {
        title: 'Violation Detected',
        message: 'User Test User triggered a rule violation',
        automationId: 'a-1',
        automationName: 'Now playing',
        severity: 'high',
      },
    });
  });

  it('carries only the toast for a server event, never the banner the producer publishes', async () => {
    const rendered = await render(
      { type: 'server_down', payload: { serverName: 'Plex Server', serverId: 's1' } },
      automationCtx({ title: '{{server.name}} is gone' })
    );

    expect(Object.keys(rendered)).toEqual(['toast']);
    expect(rendered.toast?.title).toBe('Plex Server is gone');
  });

  it('toasts a tracearr release the automation asked for', async () => {
    const rendered = await render(
      {
        type: 'tracearr_update_available',
        payload: { current: '2.0.0', latest: '2.1.0', releaseUrl: 'https://example.com/r' },
      },
      automationCtx()
    );

    expect(rendered.toast?.title).toBe('Tracearr Update Available');
  });

  it('toasts a new device and a trust move with the payload severity', async () => {
    const device = await webToastType.render(newDevice, {}, automationCtx());
    expect(device.toast?.title).toBe('New device');
    expect(device.toast?.severity).toBe('warning');

    const trust = await webToastType.render(trustChanged, {}, automationCtx());
    expect(trust.toast?.message).toBe(
      "Test User's trust score dropped from 90 to 40: Sharing penalty"
    );
    expect(trust.toast?.severity).toBe('warning');
  });

  it('toasts a media add with the automation behind it and nothing for a system source', async () => {
    const event = {
      type: 'media_added',
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
      },
    } as const;

    const rendered = await render(event, automationCtx());

    expect(rendered.toast).toEqual({
      title: 'New media added',
      message: 'Cars (2006) was added to Movies on Basement',
      automationId: 'a-1',
      automationName: 'Now playing',
      severity: 'low',
    });
    expect(await render(event)).toEqual({});
  });

  it('toasts a newsletter outcome from an automation', async () => {
    const out = await render(newsletterSend, automationCtx());
    expect(out.toast).toMatchObject({
      title: 'Newsletter partly sent',
      message: 'Weekly reached only part of its 42 recipients',
      severity: 'warning',
    });
  });
});

describe('webToastType.deliver', () => {
  const publish = vi.fn().mockResolvedValue(undefined);
  const mockGetPubSubService = vi.mocked(getPubSubService);

  beforeEach(() => {
    publish.mockClear();
    mockGetPubSubService.mockReturnValue({ publish } as unknown as PubSubService);
  });

  it('publishes the toast on notification:toast', async () => {
    const toast = {
      title: 'Rule fired',
      message: 'Too many streams',
      automationId: 'rule-456',
      automationName: 'Test Rule',
      severity: 'high',
    } as const;

    await webToastType.deliver({ toast }, {}, deliverCtx);

    expect(publish).toHaveBeenCalledWith('notification:toast', toast);
  });

  it('publishes nothing for an empty render', async () => {
    await webToastType.deliver({}, {}, deliverCtx);

    expect(publish).not.toHaveBeenCalled();
    expect(mockGetPubSubService).not.toHaveBeenCalled();
  });

  it('throws when pub/sub is unavailable', async () => {
    mockGetPubSubService.mockReturnValue(null);

    await expect(
      webToastType.deliver(
        {
          toast: {
            title: 'Rule fired',
            message: 'Too many streams',
            automationId: 'rule-456',
            automationName: 'Test Rule',
            severity: 'high',
          },
        },
        {},
        deliverCtx
      )
    ).rejects.toThrow('pub/sub unavailable');
  });
});
