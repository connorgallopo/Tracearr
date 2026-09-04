import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViolationWithDetails } from '@tracearr/shared';
import { pushNotificationService } from '../../pushNotification.js';
import { createMockActiveSession } from '../../../test/fixtures.js';
import { pushType, type PushRendered } from '../destinations/push.js';
import type { RenderContext } from '../destinations/types.js';

const destination = { id: 'dest-push', name: 'Mobile push' };
const systemCtx: RenderContext = { destination, source: { kind: 'system' } };
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
  severity: 'warning',
  data: { serverId: 'server-1', thumbPath: '/thumb.jpg', userThumbUrl: '/avatar.jpg' },
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

const tracearrUpdate = {
  type: 'tracearr_update_available',
  payload: { current: '2.0.0', latest: '2.1.0', releaseUrl: 'https://example.com/r' },
} as const;

const mediaAdded = {
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

const render = async (
  event: Parameters<typeof pushType.render>[0],
  ctx: RenderContext = systemCtx
): Promise<PushRendered> => pushType.render(event, {}, ctx);

describe('pushType.render', () => {
  it('renders a system event as the raw event with no override', async () => {
    const event = { type: 'violation', payload: violation } as const;

    expect(await render(event)).toEqual({ kind: 'event', event });
  });

  it('carries an automation override alongside the event', async () => {
    const event = {
      type: 'server_down',
      payload: { serverName: 'Plex Server', serverId: 's1' },
    } as const;

    expect(await render(event, automationCtx({ title: '{{server.name}} is gone' }))).toEqual({
      kind: 'event',
      event,
      override: { title: 'Plex Server is gone' },
    });
  });

  it('leaves a system-sourced update event on the no-op arm', async () => {
    expect(await render(tracearrUpdate)).toEqual({ kind: 'event', event: tracearrUpdate });
  });

  it('renders the three update events with their resolved text', async () => {
    expect(await render(tracearrUpdate, automationCtx())).toEqual({
      kind: 'text',
      subject: 'update',
      title: 'Tracearr Update Available',
      body: 'Tracearr 2.1.0 is out (running 2.0.0)',
      data: {
        type: 'tracearr_update_available',
        current: '2.0.0',
        latest: '2.1.0',
        releaseUrl: 'https://example.com/r',
      },
    });
  });

  it('keeps the account events on the event arm, so the device toggles still gate them', async () => {
    expect(await render(newDevice, automationCtx())).toEqual({ kind: 'event', event: newDevice });
    expect(await render(trustChanged, automationCtx({ body: 'trust moved' }))).toEqual({
      kind: 'event',
      event: trustChanged,
      override: { body: 'trust moved' },
    });
  });

  it('renders a media event as library text', async () => {
    expect(await render(mediaAdded, automationCtx())).toEqual({
      kind: 'text',
      subject: 'library',
      title: 'New media added',
      body: 'Cars (2006) was added to Movies on Basement',
      data: { ...mediaAdded.payload, type: 'media_added' },
    });
  });

  it('renders a newsletter outcome as text under the newsletter subject', async () => {
    const out = await render(newsletterSend, automationCtx());
    expect(out).toEqual({
      kind: 'text',
      subject: 'newsletter',
      title: 'Newsletter partly sent',
      body: 'Weekly reached only part of its 42 recipients',
      data: { ...newsletterSend.payload, type: 'newsletter_send' },
    });
  });
});

function spyOnNotifiers() {
  return {
    notifyViolation: vi
      .spyOn(pushNotificationService, 'notifyViolation')
      .mockResolvedValue(undefined),
    notifySessionStarted: vi
      .spyOn(pushNotificationService, 'notifySessionStarted')
      .mockResolvedValue(undefined),
    notifySessionStopped: vi
      .spyOn(pushNotificationService, 'notifySessionStopped')
      .mockResolvedValue(undefined),
    notifyServerDown: vi
      .spyOn(pushNotificationService, 'notifyServerDown')
      .mockResolvedValue(undefined),
    notifyServerUp: vi
      .spyOn(pushNotificationService, 'notifyServerUp')
      .mockResolvedValue(undefined),
    notifyUpdate: vi.spyOn(pushNotificationService, 'notifyUpdate').mockResolvedValue(undefined),
    notifyLibrary: vi.spyOn(pushNotificationService, 'notifyLibrary').mockResolvedValue(undefined),
    notifyNewDevice: vi
      .spyOn(pushNotificationService, 'notifyNewDevice')
      .mockResolvedValue(undefined),
    notifyTrustChanged: vi
      .spyOn(pushNotificationService, 'notifyTrustChanged')
      .mockResolvedValue(undefined),
    notifyNewsletter: vi
      .spyOn(pushNotificationService, 'notifyNewsletter')
      .mockResolvedValue(undefined),
  };
}

describe('pushType.deliver', () => {
  let spies: ReturnType<typeof spyOnNotifiers>;

  beforeEach(() => {
    spies = spyOnNotifiers();
  });

  it('sends a violation shape through notifyViolation, per-device filters and all', async () => {
    await pushType.deliver(
      { kind: 'event', event: { type: 'violation', payload: violation } },
      {},
      deliverCtx
    );

    expect(spies.notifyViolation).toHaveBeenCalledWith(violation, undefined);
  });

  it('hands notifyViolation the automation override', async () => {
    await pushType.deliver(
      {
        kind: 'event',
        event: { type: 'violation', payload: violation },
        override: { body: 'over the limit' },
      },
      {},
      deliverCtx
    );

    expect(spies.notifyViolation).toHaveBeenCalledWith(violation, { body: 'over the limit' });
  });

  it('sends a stream start through notifySessionStarted with any override', async () => {
    await pushType.deliver(
      {
        kind: 'event',
        event: { type: 'session_started', payload: session },
        override: { title: 'Playing' },
      },
      {},
      deliverCtx
    );

    expect(spies.notifySessionStarted).toHaveBeenCalledWith(session, { title: 'Playing' });
  });

  it('sends a stream stop through notifySessionStopped', async () => {
    await pushType.deliver(
      { kind: 'event', event: { type: 'session_stopped', payload: session } },
      {},
      deliverCtx
    );

    expect(spies.notifySessionStopped).toHaveBeenCalledWith(session, undefined);
  });

  it('sends server down with the name, the id and any override', async () => {
    await pushType.deliver(
      {
        kind: 'event',
        event: { type: 'server_down', payload: { serverName: 'Plex Server', serverId: 's1' } },
        override: { title: 'Plex is gone' },
      },
      {},
      deliverCtx
    );

    expect(spies.notifyServerDown).toHaveBeenCalledWith('Plex Server', 's1', {
      title: 'Plex is gone',
    });
  });

  it('sends server up with the name and id', async () => {
    await pushType.deliver(
      {
        kind: 'event',
        event: { type: 'server_up', payload: { serverName: 'Plex Server', serverId: 's1' } },
      },
      {},
      deliverCtx
    );

    expect(spies.notifyServerUp).toHaveBeenCalledWith('Plex Server', 's1', undefined);
  });

  it('sends a new device and a trust move to their own notifiers', async () => {
    await pushType.deliver({ kind: 'event', event: newDevice }, {}, deliverCtx);
    await pushType.deliver(
      { kind: 'event', event: trustChanged, override: { title: 'Trust dropped' } },
      {},
      deliverCtx
    );

    expect(spies.notifyNewDevice).toHaveBeenCalledWith(newDevice.payload, undefined);
    expect(spies.notifyTrustChanged).toHaveBeenCalledWith(trustChanged.payload, {
      title: 'Trust dropped',
    });
    expect(spies.notifyLibrary).not.toHaveBeenCalled();
  });

  it('sends a tracearr release through notifyUpdate', async () => {
    await pushType.deliver(
      {
        kind: 'text',
        subject: 'update',
        title: 'Tracearr 2.1.0',
        body: 'time to pull',
        data: { type: 'x' },
      },
      {},
      deliverCtx
    );

    expect(spies.notifyUpdate).toHaveBeenCalledWith('Tracearr 2.1.0', 'time to pull', {
      type: 'x',
    });
    expect(spies.notifyViolation).not.toHaveBeenCalled();
  });

  it('sends a library announcement through notifyLibrary', async () => {
    await pushType.deliver(
      {
        kind: 'text',
        subject: 'library',
        title: 'New media added',
        body: 'Cars (2006) was added to Movies on Basement',
        data: { type: 'media_added' },
      },
      {},
      deliverCtx
    );

    expect(spies.notifyLibrary).toHaveBeenCalledWith(
      'New media added',
      'Cars (2006) was added to Movies on Basement',
      { type: 'media_added' }
    );
    expect(spies.notifyUpdate).not.toHaveBeenCalled();
  });

  it('sends a newsletter outcome through notifyNewsletter', async () => {
    await pushType.deliver(
      {
        kind: 'text',
        subject: 'newsletter',
        title: 'Newsletter failed',
        body: 'Weekly reached nobody',
        data: { type: 'newsletter_send' },
      },
      {},
      deliverCtx
    );
    expect(spies.notifyNewsletter).toHaveBeenCalledWith(
      'Newsletter failed',
      'Weekly reached nobody',
      {
        type: 'newsletter_send',
      }
    );
    expect(spies.notifyUpdate).not.toHaveBeenCalled();
  });
});
