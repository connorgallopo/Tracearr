import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TRIGGERS, type TriggerType, type ViolationWithDetails } from '@tracearr/shared';
import { createMockActiveSession } from '../../../test/fixtures.js';
import { PayloadBuilders, toNotificationPayload } from '../types.js';
import type { NotificationEvent } from '../events.js';

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
});

const automation = (over: { title?: string; body?: string; defaultBody?: string } = {}) =>
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

  it('prints what the stream is playing, straight off a native event', () => {
    const episode = createMockActiveSession({
      mediaType: 'episode',
      mediaTitle: 'Grilled',
      seasonNumber: 2,
      episodeNumber: 2,
      sourceVideoCodec: 'HEVC',
      sourceVideoDetails: { dynamicRange: 'Dolby Vision' },
    });

    const payload = toNotificationPayload(
      { type: 'session_started', payload: episode },
      automation({
        body: 'S{{session.seasonNumber}}E{{session.episodeNumber}} in {{session.sourceDynamicRange}} ({{session.sourceVideoCodec}})',
      })
    );

    expect(payload.message).toBe('S2E2 in Dolby Vision (HEVC)');
  });

  it('leaves a movie blank rather than printing a season it does not have', () => {
    const payload = toNotificationPayload(
      { type: 'session_started', payload: createMockActiveSession({ mediaType: 'movie' }) },
      automation({ body: 'season [{{session.seasonNumber}}]' })
    );

    expect(payload.message).toBe('season []');
  });

  it('reads the same stream variables off a violation-shaped run', () => {
    const payload = toNotificationPayload(
      {
        type: 'violation',
        payload: {
          ...violation,
          data: {
            ...violation.data,
            sourceDynamicRange: 'HDR10',
            sourceVideoCodec: 'AV1',
            episodeNumber: 1,
          },
        },
      },
      automation({
        body: '{{session.sourceDynamicRange}} / {{session.sourceVideoCodec}} / {{session.episodeNumber}}',
      })
    );

    expect(payload.message).toBe('HDR10 / AV1 / 1');
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

  it('renders if blocks and defaults', () => {
    const payload = toNotificationPayload(
      { type: 'session_started', payload: session },
      automation({
        body: '{{ user.username }}{% if session.sourceVideoCodec %} in {{ session.sourceVideoCodec }}{% endif %} on {{ server.type | default: "?" }}',
      })
    );
    expect(payload.message).toBe(
      `${session.user.username}${session.sourceVideoCodec ? ` in ${session.sourceVideoCodec}` : ''} on ${session.server.type}`
    );
  });

  it('falls back to the builtin text when a template renders blank', () => {
    const payload = toNotificationPayload(
      { type: 'violation', payload: violation },
      automation({ title: '   ', body: '{{ session.sourceVideoCodec }}' })
    );
    expect(payload.title).toBe(PayloadBuilders.fromViolation(violation).title);
    expect(payload.message).toBe(PayloadBuilders.fromViolation(violation).message);
    expect(payload.automation).toEqual({ id: 'a-1', name: 'Now playing' });
  });

  it('uses defaultBody unparsed when the send has no body or it renders blank', () => {
    const risky = 'Account "{{ x }} {% if" has been inactive for 45 days';
    for (const over of [{ defaultBody: risky }, { body: ' ', defaultBody: risky }]) {
      const payload = toNotificationPayload(
        { type: 'violation', payload: violation },
        automation(over)
      );
      expect(payload.message).toBe(risky);
      expect(payload.automation?.message).toBe(risky);
    }
  });

  it('escapes inserted values with the escape it is given, not the template text', () => {
    const payload = toNotificationPayload(
      { type: 'session_started', payload: session },
      automation({ body: '**{{ user.username }}**' }),
      (value) => `<${value}>`
    );
    expect(payload.message).toBe(`**<${session.user.username}>**`);
  });

  it('renders stored text the grammar rejects the way it used to', () => {
    const payload = toNotificationPayload(
      { type: 'session_started', payload: session },
      automation({ body: '{{ a b }} {{user.username}}' })
    );
    expect(payload.message).toBe(`{{ a b }} ${session.user.username}`);
  });

  it('offers the tracearr update versions under the new names and the old ones', () => {
    const payload = toNotificationPayload(
      {
        type: 'tracearr_update_available',
        payload: { current: '2.5.1', latest: '2.5.2', releaseUrl: 'https://x.test/r' },
      },
      automation({ body: '{{ installedVersion }}>{{ latestVersion }} {{ current }}>{{ latest }}' })
    );
    expect(payload.message).toBe('2.5.1>2.5.2 2.5.1>2.5.2');
  });

  it('names an episode session by show and code, and anything else by title', () => {
    const episode = createMockActiveSession({
      mediaType: 'episode',
      grandparentTitle: 'The Bear',
      mediaTitle: 'Fish',
      seasonNumber: 1,
      episodeNumber: 6,
    });
    const named = toNotificationPayload(
      { type: 'session_started', payload: episode },
      automation({ body: '{{ session.name }}' })
    );
    expect(named.message).toBe(
      toNotificationPayload(
        {
          type: 'media_added',
          payload: {
            ...mediaPayload,
            mediaType: 'episode',
            title: 'Fish',
            grandparentTitle: 'The Bear',
            parentIndex: 1,
            itemIndex: 6,
          },
        },
        automation({ body: '{{ media.name }}' })
      ).message
    );
    const movie = toNotificationPayload(
      {
        type: 'session_started',
        payload: createMockActiveSession({ mediaType: 'movie', mediaTitle: 'Dune' }),
      },
      automation({ body: '{{ session.name }}' })
    );
    expect(movie.message).toBe('Dune');
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

describe('variables per trigger', () => {
  const stream = createMockActiveSession({
    mediaType: 'episode',
    grandparentTitle: 'The Bear',
    mediaTitle: 'Fish',
    seasonNumber: 1,
    episodeNumber: 6,
    sourceVideoCodec: 'HEVC',
    sourceVideoDetails: { dynamicRange: 'HDR10' },
    durationMs: 600_000,
  });
  const fullViolation: ViolationWithDetails = {
    ...violation,
    server: { id: 'server-1', name: 'Basement', type: 'plex' },
    data: {
      mediaTitle: 'Fish',
      mediaType: 'episode',
      grandparentTitle: 'The Bear',
      sourceDynamicRange: 'HDR10',
      sourceVideoCodec: 'HEVC',
      seasonNumber: 1,
      episodeNumber: 6,
      durationMinutes: 10,
      minutes: 30,
      days: 45,
      downloadTitle: 'Dune: Part Two',
      downloadApp: 'Jellyfin Android',
      downloadDevice: 'Pixel 8',
      downloadsLast24h: 6,
    },
  };
  const episodeMedia = {
    ...mediaPayload,
    mediaType: 'episode',
    title: 'Fish',
    grandparentTitle: 'The Bear',
    parentIndex: 1,
    itemIndex: 6,
    addedEpisodeCount: 3,
  };
  const events: Record<string, NotificationEvent> = {
    session_started: { type: 'session_started', payload: stream },
    session_stopped: { type: 'session_stopped', payload: stream },
    violation: { type: 'violation', payload: fullViolation },
    new_device: {
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
        platform: 'Roku',
        product: 'Plex for Roku',
        location: 'Boston, US',
      },
    },
    trust_score_changed: {
      type: 'trust_score_changed',
      payload: {
        serverId: 'server-1',
        serverName: 'Basement',
        serverType: 'plex',
        serverUserId: 'su-1',
        userName: 'Test User',
        username: 'testuser',
        identityName: 'Test User',
        previousScore: 100,
        newScore: 90,
        reason: 'new device',
      },
    },
    media_added: { type: 'media_added', payload: episodeMedia },
    media_upgraded: {
      type: 'media_upgraded',
      payload: { ...upgradedPayload, ...episodeMedia },
    },
    server_down: {
      type: 'server_down',
      payload: { serverName: 'Basement', serverId: 'server-1', serverType: 'plex' },
    },
    server_up: {
      type: 'server_up',
      payload: { serverName: 'Basement', serverId: 'server-1', serverType: 'plex' },
    },
    plugin_update_available: { type: 'plugin_update_available', payload: pluginPayload },
    server_update_available: {
      type: 'server_update_available',
      payload: {
        serverId: 'server-1',
        serverName: 'Basement',
        serverType: 'plex',
        installedVersion: '1.0.0',
        latestVersion: '1.1.0',
        releaseUrl: 'https://x.test/r',
      },
    },
    tracearr_update_available: {
      type: 'tracearr_update_available',
      payload: { current: '2.5.1', latest: '2.5.2', releaseUrl: 'https://x.test/r' },
    },
    newsletter_send: {
      type: 'newsletter_send',
      payload: {
        newsletterId: 'n-1',
        sendId: 's-1',
        name: 'Weekly',
        outcome: 'failed',
        trigger: 'schedule',
        recipientCount: 4,
        itemCounts: {},
        error: 'smtp refused',
        windowStart: '2026-01-01T00:00:00.000Z',
        windowEnd: '2026-01-08T00:00:00.000Z',
        historyUrl: null,
      },
    },
  };
  const eventsFor: Record<TriggerType, string[]> = {
    'session.started': ['session_started', 'violation'],
    'session.first_seen': ['session_started', 'violation'],
    'session.stopped': ['session_stopped', 'violation'],
    'session.transcode_changed': ['session_started', 'violation'],
    'session.paused': ['session_started', 'violation'],
    'session.held_for': ['violation'],
    'session.watched': ['session_started', 'violation'],
    'account.inactive_for': ['violation'],
    'account.new_device': ['new_device'],
    'account.trust_changed': ['trust_score_changed'],
    'account.media_downloaded': ['violation'],
    'media.added': ['media_added'],
    'media.upgraded': ['media_upgraded'],
    'server.down': ['server_down'],
    'server.up': ['server_up'],
    'plugin.update_available': ['plugin_update_available'],
    'server.update_available': ['server_update_available'],
    'tracearr.update_available': ['tracearr_update_available'],
    'newsletter.sent': ['newsletter_send'],
    'newsletter.failed': ['newsletter_send'],
  };

  for (const [trigger, names] of Object.entries(eventsFor) as [TriggerType, string[]][]) {
    it(`renders every variable ${trigger} offers`, () => {
      for (const eventName of names) {
        const event = events[eventName];
        if (!event) throw new Error(`no fixture for ${eventName}`);
        for (const name of TRIGGERS[trigger].variables) {
          const rendered = toNotificationPayload(event, automation({ body: `{{ ${name} }}` }));
          expect(rendered.automation?.message, `${trigger} ${eventName} ${name}`).toBeTruthy();
        }
      }
    });
  }
});
