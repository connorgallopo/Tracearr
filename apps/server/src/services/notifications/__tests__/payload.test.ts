import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ViolationWithDetails } from '@tracearr/shared';
import { createMockActiveSession } from '../../../test/fixtures.js';
import { PayloadBuilders, toNotificationPayload } from '../types.js';

const system = { kind: 'system' } as const;

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

const session = createMockActiveSession();

const pluginPayload = {
  serverId: 'server-1',
  serverName: 'Jellyfin',
  serverType: 'jellyfin',
  installedVersion: '0.2.0',
  latestVersion: '0.3.0',
  downloadUrl: 'https://example.com/plugin.zip',
};

const mediaPayload = {
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
};

const upgradedPayload = {
  ...mediaPayload,
  from: { ...mediaPayload.to, resolution: '1080p', fileSize: 8_000_000_000 },
  changed: ['resolution', 'fileSize'] as ('resolution' | 'fileSize')[],
};

describe('toNotificationPayload', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('matches PayloadBuilders for each event type', () => {
    expect(toNotificationPayload({ type: 'violation', payload: violation }, system)).toEqual(
      PayloadBuilders.fromViolation(violation)
    );
    expect(toNotificationPayload({ type: 'session_started', payload: session }, system)).toEqual(
      PayloadBuilders.fromSessionStarted(session)
    );
    expect(toNotificationPayload({ type: 'session_stopped', payload: session }, system)).toEqual(
      PayloadBuilders.fromSessionStopped(session)
    );
    expect(
      toNotificationPayload(
        { type: 'server_down', payload: { serverName: 'Plex', serverId: 's1' } },
        system
      )
    ).toEqual(PayloadBuilders.fromServerDown('Plex'));
    expect(
      toNotificationPayload(
        { type: 'server_up', payload: { serverName: 'Plex', serverId: 's1' } },
        system
      )
    ).toEqual(PayloadBuilders.fromServerUp('Plex'));
    expect(
      toNotificationPayload({ type: 'plugin_update_available', payload: pluginPayload }, system)
    ).toEqual(
      PayloadBuilders.fromPluginUpdate(
        pluginPayload.serverId,
        pluginPayload.serverName,
        pluginPayload.serverType,
        pluginPayload.installedVersion,
        pluginPayload.latestVersion,
        pluginPayload.downloadUrl
      )
    );
  });

  it('lets a rule source override title and message but keeps the event severity', () => {
    const payload = toNotificationPayload(
      { type: 'session_started', payload: session },
      { kind: 'rule', title: 'Rule fired', message: 'Too many streams' }
    );

    expect(payload.title).toBe('Rule fired');
    expect(payload.message).toBe('Too many streams');
    expect(payload.severity).toBe('low');
    expect(payload.event).toBe('stream_started');
    expect(payload.context).toEqual({ type: 'stream_started', session });
  });
});

const automation = (over: { title?: string; body?: string } = {}) =>
  ({ kind: 'automation', automationId: 'a-1', automationName: 'Now playing', ...over }) as const;

describe('toNotificationPayload with an automation source', () => {
  it('substitutes the trigger variables into the body of a native event', () => {
    const payload = toNotificationPayload(
      { type: 'session_started', payload: session },
      automation({ body: '{{user.username}} started {{session.mediaTitle}}' })
    );

    expect(payload.message).toBe(`${session.user.username} started ${session.mediaTitle}`);
    expect(payload.automation).toEqual({
      id: 'a-1',
      name: 'Now playing',
      message: `${session.user.username} started ${session.mediaTitle}`,
    });
  });

  it('renders an unknown variable as nothing and keeps the builtin text without an override', () => {
    const rendered = toNotificationPayload(
      { type: 'session_started', payload: session },
      automation({ title: 'Playing on {{server.name}}{{nope}}' })
    );

    expect(rendered.title).toBe(`Playing on ${session.server.name}`);
    expect(rendered.message).toBe(PayloadBuilders.fromSessionStarted(session).message);
    expect(rendered.automation?.title).toBe(`Playing on ${session.server.name}`);
    expect(rendered.automation?.message).toBeUndefined();
  });

  it('carries the automation with no overrides at all', () => {
    const payload = toNotificationPayload({ type: 'violation', payload: violation }, automation());

    expect(payload.title).toBe(PayloadBuilders.fromViolation(violation).title);
    expect(payload.automation).toEqual({ id: 'a-1', name: 'Now playing' });
  });

  it('substitutes the update variables of a tracearr release', () => {
    const payload = toNotificationPayload(
      {
        type: 'tracearr_update_available',
        payload: { current: '2.0.0', latest: '2.1.0', releaseUrl: 'https://example.com/r' },
      },
      automation({ title: 'Tracearr {{latest}}', body: '{{current}} -> {{latest}}' })
    );

    expect(payload.title).toBe('Tracearr 2.1.0');
    expect(payload.message).toBe('2.0.0 -> 2.1.0');
    expect(payload.event).toBe('tracearr_update_available');
  });

  it('resolves the server name and type of a native server event', () => {
    const payload = toNotificationPayload(
      {
        type: 'server_down',
        payload: { serverName: 'Living Room', serverId: 's1', serverType: 'jellyfin' },
      },
      automation({ body: '{{server.name}} ({{server.type}}) is gone' })
    );

    expect(payload.message).toBe('Living Room (jellyfin) is gone');
    expect(payload.context).toEqual({
      type: 'server_down',
      serverName: 'Living Room',
      serverType: 'jellyfin',
    });
  });

  it('resolves the server name and type of a violation-shaped run', () => {
    const payload = toNotificationPayload(
      {
        type: 'violation',
        payload: { ...violation, server: { id: 's1', name: 'Living Room', type: 'emby' } },
      },
      automation({ body: '{{server.name}} / {{server.type}}' })
    );

    expect(payload.message).toBe('Living Room / emby');
  });

  it('reads the account name and media title off a violation-shaped run', () => {
    const payload = toNotificationPayload(
      {
        type: 'violation',
        payload: {
          ...violation,
          data: { ...violation.data, mediaTitle: 'Arrival', days: 45 },
        },
      },
      automation({ body: '{{user.identityName}} / {{session.mediaTitle}} / {{days}}' })
    );

    expect(payload.message).toBe('Test User / Arrival / 45');
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

describe('account events', () => {
  it('says who connected from where, and warns', () => {
    const payload = PayloadBuilders.fromNewDevice(newDevice.payload);

    expect(payload.event).toBe('new_device');
    expect(payload.title).toBe('New device');
    expect(payload.message).toBe(
      'Test User connected from a new device: Living Room TV from Boston, Massachusetts'
    );
    expect(payload.severity).toBe('warning');
  });

  it('drops the location clause when the session carries no geo', () => {
    const payload = PayloadBuilders.fromNewDevice({ ...newDevice.payload, location: null });

    expect(payload.message).toBe('Test User connected from a new device: Living Room TV');
  });

  it('names the direction of a trust move and warns only on a drop', () => {
    const dropped = PayloadBuilders.fromTrustScoreChanged(trustChanged.payload);

    expect(dropped.event).toBe('trust_score_changed');
    expect(dropped.title).toBe('Trust score changed');
    expect(dropped.message).toBe("Test User's trust score dropped from 90 to 40: Sharing penalty");
    expect(dropped.severity).toBe('warning');

    const rose = PayloadBuilders.fromTrustScoreChanged({
      ...trustChanged.payload,
      previousScore: 40,
      newScore: 90,
      reason: null,
    });

    expect(rose.message).toBe("Test User's trust score rose from 40 to 90");
    expect(rose.severity).toBe('low');
  });

  it('renders the device and trust variables an override names', () => {
    const device = toNotificationPayload(
      newDevice,
      automation({
        body: '{{user.username}} on {{device.product}} ({{device.location}}) - {{session.mediaTitle}}',
      })
    );

    expect(device.message).toBe('testuser on Plex for Apple TV (Boston, Massachusetts) - Cars');

    const trust = toNotificationPayload(
      trustChanged,
      automation({ body: '{{trust.previous}} -> {{trust.new}} ({{trust.reason}})' })
    );

    expect(trust.message).toBe('90 -> 40 (Sharing penalty)');
  });

  it('leaves a name the event does not carry empty rather than showing the braces', () => {
    const trust = toNotificationPayload(
      trustChanged,
      automation({ body: 'was [{{device.product}}]' })
    );

    expect(trust.message).toBe('was []');
  });
});

const newsletterSend = {
  type: 'newsletter_send',
  payload: {
    newsletterId: 'n-1',
    sendId: 'send-1',
    name: 'Weekly',
    outcome: 'failed',
    trigger: 'schedule',
    recipientCount: 0,
    itemCounts: { movies: 3, shows: 1, episodes: 4, albums: 0, mostWatched: 0 },
    error: 'The email destination is disabled',
    windowStart: '2026-08-26T00:00:00.000Z',
    windowEnd: '2026-09-02T00:00:00.000Z',
    historyUrl: 'https://tracearr.example.com/settings/notifications/newsletters/n-1',
  },
} as const;

describe('newsletter send', () => {
  it('reads the outcome into the title, message and severity', () => {
    const failed = PayloadBuilders.fromNewsletterSend(newsletterSend.payload);
    expect(failed.event).toBe('newsletter_send');
    expect(failed.title).toBe('Newsletter failed');
    expect(failed.message).toBe('Weekly reached nobody: The email destination is disabled');
    expect(failed.severity).toBe('high');
    expect(failed.context).toEqual({ type: 'newsletter_send', ...newsletterSend.payload });

    const sent = PayloadBuilders.fromNewsletterSend({
      ...newsletterSend.payload,
      outcome: 'sent',
      recipientCount: 42,
      error: null,
    });
    expect(sent.title).toBe('Newsletter sent');
    expect(sent.message).toBe('Weekly went to 42 recipients');
    expect(sent.severity).toBe('low');

    const partial = PayloadBuilders.fromNewsletterSend({
      ...newsletterSend.payload,
      outcome: 'partial',
      recipientCount: 42,
      error: null,
    });
    expect(partial.title).toBe('Newsletter partly sent');
    expect(partial.message).toBe('Weekly reached only part of its 42 recipients');
    expect(partial.severity).toBe('warning');
  });

  it('renders the newsletter variables an override names', () => {
    const payload = toNotificationPayload(
      newsletterSend,
      automation({
        body: '{{newsletter.name}} {{newsletter.outcome}} {{newsletter.recipientCount}} [{{newsletter.error}}]',
      })
    );
    expect(payload.message).toBe('Weekly failed 0 [The email destination is disabled]');
  });
});

describe('media events', () => {
  it('names the item, the library and the server by default', () => {
    const added = toNotificationPayload({ type: 'media_added', payload: mediaPayload }, system);

    expect(added.title).toBe('New media added');
    expect(added.message).toBe('Cars (2006) was added to Movies on Basement');
    expect(added.event).toBe('media_added');
    expect(added.context).toEqual({ type: 'media_added', ...mediaPayload });
  });

  it('names every field an upgrade moved, resolution first', () => {
    const upgraded = toNotificationPayload(
      { type: 'media_upgraded', payload: upgradedPayload },
      system
    );

    expect(upgraded.title).toBe('Media upgraded');
    expect(upgraded.message).toBe(
      'Cars (2006) on Basement was upgraded: resolution 1080p → 4K, size 7.5 GB → 39.1 GB'
    );
  });

  it('names whatever moved when the resolution held', () => {
    const upgraded = toNotificationPayload(
      {
        type: 'media_upgraded',
        payload: { ...upgradedPayload, changed: ['fileSize'] as 'fileSize'[] },
      },
      system
    );

    expect(upgraded.message).toBe('Cars (2006) on Basement was upgraded: size 7.5 GB → 39.1 GB');
  });

  it('renders the from and to variables an automation body names', () => {
    const upgraded = toNotificationPayload(
      { type: 'media_upgraded', payload: upgradedPayload },
      automation({ body: '{{media.title}}: {{media.from.resolution}} → {{media.to.resolution}}' })
    );

    expect(upgraded.message).toBe('Cars: 1080p → 4K');
  });

  it('names the show or artist an episode or track belongs to', () => {
    const episode = { ...mediaPayload, title: 'Pilot', grandparentTitle: 'Severance' };

    expect(toNotificationPayload({ type: 'media_added', payload: episode }, system).message).toBe(
      'Severance — Pilot (2006) was added to Movies on Basement'
    );
    expect(
      toNotificationPayload(
        { type: 'media_upgraded', payload: { ...upgradedPayload, ...episode } },
        system
      ).message
    ).toBe(
      'Severance — Pilot (2006) on Basement was upgraded: resolution 1080p → 4K, size 7.5 GB → 39.1 GB'
    );
  });

  it('renders a missing year and the item variables as the trigger offers them', () => {
    const added = toNotificationPayload(
      { type: 'media_added', payload: { ...mediaPayload, year: null } },
      automation({ body: '{{media.title}}|{{media.year}}|{{media.library}}|{{media.server}}' })
    );

    expect(added.message).toBe('Cars||Movies|Basement');
    expect(
      toNotificationPayload(
        { type: 'media_added', payload: { ...mediaPayload, year: null } },
        system
      ).message
    ).toBe('Cars was added to Movies on Basement');
  });
});
