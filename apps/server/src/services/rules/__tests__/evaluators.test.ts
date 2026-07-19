import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Condition, Session, ServerUser, Server, RuleV2 } from '@tracearr/shared';
import type { EvaluationContext, EvaluatorResult } from '../types.js';
import {
  evaluatorRegistry,
  getResolution,
  resolutionToNumber,
  normalizeDeviceType,
  normalizePlatform,
  calculateDistanceKm,
} from '../evaluators/index.js';

// Mock geoipService
vi.mock('../../geoip.js', () => ({
  geoipService: {
    isPrivateIP: (ip: string) => {
      if (!ip) return false;
      return (
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        ip.startsWith('127.') ||
        ip.startsWith('172.16.') ||
        ip === 'localhost'
      );
    },
  },
}));

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Helper to create a mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'user-1',
    sessionKey: 'sk-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: 'rk-1',
    externalSessionId: 'ext-1',
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 0,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '192.168.1.100',
    geoCity: 'New York',
    geoRegion: 'NY',
    geoCountry: 'US',
    geoContinent: 'NA',
    geoPostal: '10001',
    geoLat: 40.7128,
    geoLon: -74.006,
    geoAsnNumber: 7922,
    geoAsnOrganization: 'Comcast',
    playerName: 'Player 1',
    deviceId: 'device-1',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Web',
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 20000,
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    sourceVideoCodec: 'hevc',
    sourceAudioCodec: 'ac3',
    sourceAudioChannels: 6,
    sourceVideoWidth: 1920,
    sourceVideoHeight: 1080,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  };
}

// Helper to create a mock server user
function createMockServerUser(overrides: Partial<ServerUser> = {}): ServerUser {
  return {
    id: 'user-1',
    serverId: 'server-1',
    userId: 'identity-1',
    externalId: 'ext-user-1',
    username: 'testuser',
    email: 'test@example.com',
    thumbUrl: null,
    isServerAdmin: false,
    sessionCount: 10,
    joinedAt: new Date(),
    lastActivityAt: new Date(),
    trustScore: 100,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to create a mock server
function createMockServer(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Test Server',
    type: 'plex',
    url: 'http://localhost:32400',
    displayOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to create a test rule
function createMockRule(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    description: null,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    severity: 'warning',
    conditions: { groups: [] },
    actions: { actions: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to create a test context
function createTestContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const server = createMockServer();
  const serverUser = createMockServerUser({ serverId: server.id });
  const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });

  return {
    session,
    serverUser,
    server,
    activeSessions: [session],
    recentSessions: [session],
    rule: createMockRule(),
    ...overrides,
  };
}

// Helper to create a condition
function createCondition(overrides: Partial<Condition>): Condition {
  return {
    field: 'concurrent_streams',
    operator: 'eq',
    value: 1,
    ...overrides,
  };
}

// Helper to extract matched result from evaluator (handles sync/async)
function matched(result: EvaluatorResult | Promise<EvaluatorResult>): boolean {
  if (result instanceof Promise) {
    throw new Error('Use await for async evaluators');
  }
  return result.matched;
}

describe('Helper Functions', () => {
  describe('getResolution', () => {
    it('returns 4K for 3840x2160', () => {
      expect(getResolution(3840, 2160)).toBe('4K');
    });

    it('returns 4K for ultrawide 3840x1600', () => {
      expect(getResolution(3840, 1600)).toBe('4K');
    });

    it('returns 1080p for 1920x1080', () => {
      expect(getResolution(1920, 1080)).toBe('1080p');
    });

    it('returns 1080p for widescreen 1920x804', () => {
      expect(getResolution(1920, 804)).toBe('1080p');
    });

    it('returns 1080p for 4:3 content 1440x1080', () => {
      expect(getResolution(1440, 1080)).toBe('1080p');
    });

    it('returns 720p for 1280x720', () => {
      expect(getResolution(1280, 720)).toBe('720p');
    });

    it('returns 480p for 720x480', () => {
      expect(getResolution(720, 480)).toBe('480p');
    });

    it('returns SD for low resolution', () => {
      expect(getResolution(640, 360)).toBe('SD');
    });

    it('returns unknown for null dimensions', () => {
      expect(getResolution(null, null)).toBe('unknown');
      expect(getResolution(null, 1080)).toBe('1080p');
      expect(getResolution(1920, null)).toBe('1080p');
    });

    // regression: issue #798, 1440p folds up to 4K since VideoResolution has no 1440p tier
    it('returns 4K for 1440p dimensions 2560x1440 (previously 1080p under the old ladder)', () => {
      expect(getResolution(2560, 1440)).toBe('4K');
    });
  });

  describe('resolutionToNumber', () => {
    it('converts resolution strings to numeric values', () => {
      expect(resolutionToNumber('4K')).toBe(2160);
      expect(resolutionToNumber('1080p')).toBe(1080);
      expect(resolutionToNumber('720p')).toBe(720);
      expect(resolutionToNumber('480p')).toBe(480);
      expect(resolutionToNumber('SD')).toBe(360);
      expect(resolutionToNumber('unknown')).toBe(0);
    });
  });

  describe('normalizeDeviceType', () => {
    it('detects TV devices', () => {
      expect(normalizeDeviceType('Samsung TV', null)).toBe('tv');
      expect(normalizeDeviceType(null, 'roku')).toBe('tv');
      expect(normalizeDeviceType(null, 'webos')).toBe('tv');
      expect(normalizeDeviceType(null, 'tizen')).toBe('tv');
      expect(normalizeDeviceType(null, 'firetv')).toBe('tv');
      expect(normalizeDeviceType(null, 'androidtv')).toBe('tv');
      expect(normalizeDeviceType(null, 'chromecast')).toBe('tv');
    });

    it('detects mobile devices', () => {
      expect(normalizeDeviceType('iPhone 14', null)).toBe('mobile');
      expect(normalizeDeviceType('My Phone', 'iOS')).toBe('mobile');
      expect(normalizeDeviceType(null, 'android')).toBe('mobile');
    });

    it('detects tablets', () => {
      expect(normalizeDeviceType('iPad Pro', null)).toBe('tablet');
      expect(normalizeDeviceType('Samsung Tablet', null)).toBe('tablet');
    });

    it('detects desktop', () => {
      expect(normalizeDeviceType(null, 'windows')).toBe('desktop');
      expect(normalizeDeviceType(null, 'macos')).toBe('desktop');
      expect(normalizeDeviceType(null, 'linux')).toBe('desktop');
    });

    it('detects browser', () => {
      expect(normalizeDeviceType('Chrome Browser', null)).toBe('browser');
      expect(normalizeDeviceType('Firefox', null)).toBe('browser');
      expect(normalizeDeviceType('Safari', null)).toBe('browser');
      expect(normalizeDeviceType('Microsoft Edge', null)).toBe('browser');
    });

    it('returns unknown for unrecognized devices', () => {
      expect(normalizeDeviceType(null, null)).toBe('unknown');
      expect(normalizeDeviceType('Unknown Device', 'Unknown Platform')).toBe('unknown');
    });

    // regression: issue #826, Plex Web sessions on macOS were misclassified as unknown
    it('classifies Plex Web (OSX/Chrome) as browser, not unknown', () => {
      expect(normalizeDeviceType('OSX', 'Chrome')).toBe('browser');
      expect(normalizeDeviceType('OSX', 'Chrome', 'Plex Web')).toBe('browser');
      expect(normalizeDeviceType('Chrome', 'OSX')).toBe('browser');
    });

    it('classifies native desktop app (no browser signal) as desktop', () => {
      expect(normalizeDeviceType('OSX', 'OSX', 'Plex for Mac')).toBe('desktop');
    });

    it('uses product to detect web player even when device/platform give no browser signal', () => {
      expect(normalizeDeviceType('Windows', null, 'Plex Web')).toBe('browser');
    });

    it('keeps tv devices as tv even though chromecast/webos contain browser substrings', () => {
      expect(normalizeDeviceType(null, 'chromecast')).toBe('tv');
      expect(normalizeDeviceType(null, 'webos')).toBe('tv');
    });
  });

  describe('normalizePlatform', () => {
    it('normalizes iOS platforms', () => {
      expect(normalizePlatform('iOS')).toBe('ios');
      expect(normalizePlatform('iPhone')).toBe('ios');
      expect(normalizePlatform('iPad')).toBe('ios');
    });

    it('normalizes Android platforms', () => {
      expect(normalizePlatform('Android')).toBe('android');
      expect(normalizePlatform('Android TV')).toBe('androidtv');
    });

    it('normalizes desktop platforms', () => {
      expect(normalizePlatform('Windows')).toBe('windows');
      expect(normalizePlatform('macOS')).toBe('macos');
      expect(normalizePlatform('Mac OS')).toBe('macos');
      expect(normalizePlatform('Darwin')).toBe('macos');
      expect(normalizePlatform('Linux')).toBe('linux');
    });

    it('normalizes TV platforms', () => {
      expect(normalizePlatform('tvOS')).toBe('tvos');
      expect(normalizePlatform('Apple TV')).toBe('tvos');
      expect(normalizePlatform('Roku')).toBe('roku');
      expect(normalizePlatform('webOS')).toBe('webos');
      expect(normalizePlatform('Tizen')).toBe('tizen');
    });

    it('returns unknown for null or unrecognized', () => {
      expect(normalizePlatform(null)).toBe('unknown');
      expect(normalizePlatform('SomeOS')).toBe('unknown');
    });
  });

  describe('calculateDistanceKm', () => {
    it('returns null when coordinates are missing', () => {
      expect(calculateDistanceKm(null, 0, 0, 0)).toBe(null);
      expect(calculateDistanceKm(0, null, 0, 0)).toBe(null);
      expect(calculateDistanceKm(0, 0, null, 0)).toBe(null);
      expect(calculateDistanceKm(0, 0, 0, null)).toBe(null);
    });

    it('returns 0 for same location', () => {
      expect(calculateDistanceKm(40.7128, -74.006, 40.7128, -74.006)).toBe(0);
    });

    it('calculates distance between NYC and LA', () => {
      const distance = calculateDistanceKm(40.7128, -74.006, 34.0522, -118.2437);
      expect(distance).toBeGreaterThan(3900);
      expect(distance).toBeLessThan(4000);
    });
  });
});

describe('Session Behavior Evaluators', () => {
  describe('concurrent_streams', () => {
    it('counts active sessions for user', async () => {
      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        deviceId: 'device-1',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        deviceId: 'device-2',
      }); // Different device
      const session3 = createMockSession({
        id: 's3',
        serverUserId: 'user-2',
        deviceId: 'device-3',
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        activeSessions: [session1, session2, session3],
      });

      const evaluator = evaluatorRegistry.concurrent_streams;

      const result1 = await evaluator(
        ctx,
        createCondition({ field: 'concurrent_streams', operator: 'eq', value: 2 })
      );
      expect(result1.matched).toBe(true);
      expect(result1.actual).toBe(2);

      const result2 = await evaluator(
        ctx,
        createCondition({ field: 'concurrent_streams', operator: 'gt', value: 1 })
      );
      expect(result2.matched).toBe(true);
      expect(result2.actual).toBe(2);

      const result3 = await evaluator(
        ctx,
        createCondition({ field: 'concurrent_streams', operator: 'gt', value: 2 })
      );
      expect(result3.matched).toBe(false);
      expect(result3.actual).toBe(2);
    });

    it('excludes sessions from same IP when exclude_same_ip is true', async () => {
      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        deviceId: 'device-1',
        ipAddress: '1.2.3.4',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        deviceId: 'device-2',
        ipAddress: '1.2.3.4', // Same IP as session1
      });
      const session3 = createMockSession({
        id: 's3',
        serverUserId: 'user-1',
        deviceId: 'device-3',
        ipAddress: '5.6.7.8', // Different IP
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        activeSessions: [session1, session2, session3],
      });

      const evaluator = evaluatorRegistry.concurrent_streams;

      // Without exclude_same_ip: counts all 3 sessions
      const result1 = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'eq',
          value: 3,
          params: { exclude_same_ip: false },
        })
      );
      expect(result1.matched).toBe(true);
      expect(result1.actual).toBe(3);

      // With exclude_same_ip: only counts sessions from different IPs (session1 + session3 = 2)
      const result2 = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'eq',
          value: 2,
          params: { exclude_same_ip: true },
        })
      );
      expect(result2.matched).toBe(true);
      expect(result2.actual).toBe(2);

      // With exclude_same_ip: rule for >1 unique IPs should match
      const result3 = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'gt',
          value: 1,
          params: { exclude_same_ip: true },
        })
      );
      expect(result3.matched).toBe(true);
      expect(result3.actual).toBe(2);
    });

    it('treats IPv6 addresses in the same /64 as one IP when exclude_same_ip is true', async () => {
      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        deviceId: 'device-1',
        ipAddress: '2001:db8:abcd:7800:58f:b385:9778:7ab6',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        deviceId: 'device-2',
        ipAddress: '2001:db8:abcd:7800:c969:3c04:cdd4:13bd', // Same /64 as session1
      });
      const session3 = createMockSession({
        id: 's3',
        serverUserId: 'user-1',
        deviceId: 'device-3',
        ipAddress: '2001:db8:abcd:7801:aaaa:bbbb:cccc:dddd', // Different /64
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        activeSessions: [session1, session2, session3],
      });

      const evaluator = evaluatorRegistry.concurrent_streams;

      // With exclude_same_ip: session1+session2 count as one IP, session3 is different → 2
      const result = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'eq',
          value: 2,
          params: { exclude_same_ip: true },
        })
      );
      expect(result.matched).toBe(true);
      expect(result.actual).toBe(2);
    });

    it('only counts sessions from listed device types when count_device_types is set', async () => {
      const tvSession = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        deviceId: 'device-1',
        ipAddress: '1.2.3.4',
        device: 'Apple TV',
        platform: 'tvOS',
      });
      const phoneSession = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        deviceId: 'device-2',
        ipAddress: '5.6.7.8',
        device: 'iPhone',
        platform: 'iOS',
      });

      const ctx = createTestContext({
        session: tvSession,
        serverUser: createMockServerUser({ id: 'user-1' }),
        activeSessions: [tvSession, phoneSession],
      });

      const evaluator = evaluatorRegistry.concurrent_streams;

      // Without the filter: phone + TV = 2 streams
      const unfiltered = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'gte',
          value: 2,
          params: { exclude_same_ip: true },
        })
      );
      expect(unfiltered.matched).toBe(true);
      expect(unfiltered.actual).toBe(2);

      // With the filter: the phone no longer counts toward the threshold
      const filtered = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'gte',
          value: 2,
          params: { exclude_same_ip: true, count_device_types: ['tv', 'desktop'] },
        })
      );
      expect(filtered.matched).toBe(false);
      expect(filtered.actual).toBe(1);

      // An empty filter behaves like no filter
      const emptyFilter = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'gte',
          value: 2,
          params: { exclude_same_ip: true, count_device_types: [] },
        })
      );
      expect(emptyFilter.matched).toBe(true);
      expect(emptyFilter.actual).toBe(2);
    });

    it('does not exempt the triggering session from the device type filter', async () => {
      const tvSession1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        deviceId: 'device-1',
        ipAddress: '1.2.3.4',
        device: 'Apple TV',
        platform: 'tvOS',
      });
      const tvSession2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        deviceId: 'device-2',
        ipAddress: '5.6.7.8',
        device: 'Samsung TV',
        platform: 'Tizen',
      });
      const phoneSession = createMockSession({
        id: 's3',
        serverUserId: 'user-1',
        deviceId: 'device-3',
        ipAddress: '9.10.11.12',
        device: 'iPhone',
        platform: 'iOS',
      });

      const ctx = createTestContext({
        session: phoneSession,
        serverUser: createMockServerUser({ id: 'user-1' }),
        activeSessions: [tvSession1, tvSession2, phoneSession],
      });

      const evaluator = evaluatorRegistry.concurrent_streams;

      // Phone triggers the evaluation, but only the two TVs count
      const result = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'gte',
          value: 2,
          params: { exclude_same_ip: true, count_device_types: ['tv'] },
        })
      );
      expect(result.matched).toBe(true);
      expect(result.actual).toBe(2);
      expect(result.relatedSessionIds).toEqual(['s1', 's2']);
    });

    // regression: issue #826 — Plex Web sessions were classified as 'unknown' instead of 'browser'
    // causing false triggers when count_device_types included 'unknown'
    it('does not count Plex Web (OSX/Chrome) sessions when filter is tv+unknown', async () => {
      const webSession1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        deviceId: 'device-1',
        ipAddress: '1.2.3.4',
        device: 'OSX',
        platform: 'Chrome',
        product: 'Plex Web',
      });
      const webSession2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        deviceId: 'device-2',
        ipAddress: '5.6.7.8',
        device: 'OSX',
        platform: 'Chrome',
        product: 'Plex Web',
      });

      const ctx = createTestContext({
        session: webSession1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        activeSessions: [webSession1, webSession2],
      });

      const evaluator = evaluatorRegistry.concurrent_streams;

      // tv+unknown filter: Plex Web sessions must NOT count (they're browser, not unknown)
      const tvUnknownResult = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'gte',
          value: 2,
          params: { exclude_same_ip: true, count_device_types: ['tv', 'unknown'] },
        })
      );
      expect(tvUnknownResult.matched).toBe(false);
      expect(tvUnknownResult.actual).toBe(0);

      // browser filter: both Plex Web sessions must count
      const browserResult = await evaluator(
        ctx,
        createCondition({
          field: 'concurrent_streams',
          operator: 'gte',
          value: 2,
          params: { exclude_same_ip: true, count_device_types: ['browser'] },
        })
      );
      expect(browserResult.matched).toBe(true);
      expect(browserResult.actual).toBe(2);
    });

    it('counts sessions from every server user of the identity when identityServerUserIds is provided', () => {
      const server = createMockServer();
      const serverUser = createMockServerUser({ serverId: server.id });
      const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });
      const siblingSession = createMockSession({
        serverId: 'other-server',
        serverUserId: 'sibling-server-user',
        deviceId: 'other-device',
      });
      const context = createTestContext({
        session,
        serverUser,
        server,
        activeSessions: [session, siblingSession],
        identityServerUserIds: [serverUser.id, 'sibling-server-user'],
      });

      const evaluator = evaluatorRegistry.concurrent_streams;
      const result = evaluator(
        context,
        createCondition({ field: 'concurrent_streams', operator: 'eq', value: 2 })
      );

      expect(matched(result)).toBe(true);
    });

    it('falls back to single server user counting when identityServerUserIds is absent', () => {
      const server = createMockServer();
      const serverUser = createMockServerUser({ serverId: server.id });
      const session = createMockSession({ serverId: server.id, serverUserId: serverUser.id });
      const siblingSession = createMockSession({
        serverId: 'other-server',
        serverUserId: 'sibling-server-user',
      });
      const context = createTestContext({
        session,
        serverUser,
        server,
        activeSessions: [session, siblingSession],
      });

      const evaluator = evaluatorRegistry.concurrent_streams;
      const result = evaluator(
        context,
        createCondition({ field: 'concurrent_streams', operator: 'eq', value: 1 })
      );

      expect(matched(result)).toBe(true);
    });
  });

  describe('active_session_distance_km', () => {
    it('returns 0 when no other active sessions', () => {
      const session = createMockSession({
        serverUserId: 'user-1',
        geoLat: 40.7128,
        geoLon: -74.006,
      });

      const ctx = createTestContext({
        session,
        serverUser: createMockServerUser({ id: 'user-1' }),
        activeSessions: [session],
      });

      const evaluator = evaluatorRegistry.active_session_distance_km;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'active_session_distance_km', operator: 'eq', value: 0 })
          )
        )
      ).toBe(true);
    });

    it('calculates max distance to other active sessions', () => {
      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        geoLat: 40.7128,
        geoLon: -74.006,
        deviceId: 'device-1',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        geoLat: 34.0522,
        geoLon: -118.2437,
        deviceId: 'device-2', // Different device
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        activeSessions: [session1, session2],
      });

      const evaluator = evaluatorRegistry.active_session_distance_km;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'active_session_distance_km', operator: 'gt', value: 3000 })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'active_session_distance_km', operator: 'gt', value: 5000 })
          )
        )
      ).toBe(false);
    });
  });

  describe('travel_speed_kmh', () => {
    it('calculates speed between current and previous session', () => {
      const now = new Date();
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      // NYC
      const currentSession = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        geoLat: 40.7128,
        geoLon: -74.006,
      });

      // Boston (~350km from NYC) - different device to test travel detection
      const previousSession = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: twoHoursAgo,
        geoLat: 42.3601,
        geoLon: -71.0589,
        deviceId: 'device-2', // Different device - same device sessions are excluded by default
      });

      const ctx = createTestContext({
        session: currentSession,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [currentSession, previousSession],
      });

      const evaluator = evaluatorRegistry.travel_speed_kmh;
      // ~350km in 2 hours = ~175 km/h
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'travel_speed_kmh', operator: 'gt', value: 100 }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'travel_speed_kmh', operator: 'gt', value: 300 }))
        )
      ).toBe(false);
    });

    it('returns 0 when no previous sessions', () => {
      const session = createMockSession({
        serverUserId: 'user-1',
        geoLat: 40.7128,
        geoLon: -74.006,
      });

      const ctx = createTestContext({
        session,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session],
      });

      const evaluator = evaluatorRegistry.travel_speed_kmh;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'travel_speed_kmh', operator: 'eq', value: 0 }))
        )
      ).toBe(true);
    });

    it('returns Infinity for simultaneous sessions with distance', () => {
      const now = new Date();

      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        geoLat: 40.7128,
        geoLon: -74.006,
      });

      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: now,
        geoLat: 34.0522,
        geoLon: -118.2437,
        deviceId: 'device-2', // Different device - same device sessions are excluded by default
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1, session2],
      });

      const evaluator = evaluatorRegistry.travel_speed_kmh;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'travel_speed_kmh', operator: 'gt', value: 10000 })
          )
        )
      ).toBe(true);
    });

    it('returns 0 when coordinates are missing', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        geoLat: null,
        geoLon: null,
      });

      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: oneHourAgo,
        geoLat: 40.7128,
        geoLon: -74.006,
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1, session2],
      });

      const evaluator = evaluatorRegistry.travel_speed_kmh;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'travel_speed_kmh', operator: 'eq', value: 0 }))
        )
      ).toBe(true);
    });
  });

  describe('unique_ips_in_window', () => {
    it('counts unique IPs within time window', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        ipAddress: '1.1.1.1',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: oneHourAgo,
        ipAddress: '2.2.2.2',
      });
      const session3 = createMockSession({
        id: 's3',
        serverUserId: 'user-1',
        startedAt: twoHoursAgo,
        ipAddress: '3.3.3.3',
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1, session2, session3],
      });

      const evaluator = evaluatorRegistry.unique_ips_in_window;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'unique_ips_in_window',
              operator: 'eq',
              value: 3,
              params: { window_hours: 24 },
            })
          )
        )
      ).toBe(true);
    });

    it('only counts IPs within the window', () => {
      const now = new Date();
      const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        ipAddress: '1.1.1.1',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: thirtyMinutesAgo,
        ipAddress: '2.2.2.2',
      });
      const session3 = createMockSession({
        id: 's3',
        serverUserId: 'user-1',
        startedAt: twoHoursAgo,
        ipAddress: '3.3.3.3',
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1, session2, session3],
      });

      const evaluator = evaluatorRegistry.unique_ips_in_window;
      // 1 hour window should only include sessions 1 and 2
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'unique_ips_in_window',
              operator: 'eq',
              value: 2,
              params: { window_hours: 1 },
            })
          )
        )
      ).toBe(true);
    });

    it('deduplicates same IPs', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        ipAddress: '1.1.1.1',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: oneHourAgo,
        ipAddress: '1.1.1.1',
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1, session2],
      });

      const evaluator = evaluatorRegistry.unique_ips_in_window;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'unique_ips_in_window',
              operator: 'eq',
              value: 1,
              params: { window_hours: 24 },
            })
          )
        )
      ).toBe(true);
    });

    it('uses default 24 hour window when not specified', () => {
      const now = new Date();
      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        ipAddress: '1.1.1.1',
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1],
      });

      const evaluator = evaluatorRegistry.unique_ips_in_window;
      // Should work without params
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'unique_ips_in_window',
              operator: 'eq',
              value: 1,
            })
          )
        )
      ).toBe(true);
    });

    it('counts IPv6 addresses in the same /64 as one unique IP', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        ipAddress: '2001:db8:abcd:7800:58f:b385:9778:7ab6',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: oneHourAgo,
        ipAddress: '2001:db8:abcd:7800:c969:3c04:cdd4:13bd',
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1, session2],
      });

      const evaluator = evaluatorRegistry.unique_ips_in_window;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'unique_ips_in_window',
              operator: 'eq',
              value: 1,
              params: { window_hours: 24 },
            })
          )
        )
      ).toBe(true);
    });
  });

  describe('unique_devices_in_window', () => {
    it('counts unique devices within time window', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        deviceId: 'device-1',
        playerName: 'Player 1',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: oneHourAgo,
        deviceId: 'device-2',
        playerName: 'Player 2',
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1, session2],
      });

      const evaluator = evaluatorRegistry.unique_devices_in_window;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'unique_devices_in_window',
              operator: 'eq',
              value: 2,
              params: { window_hours: 24 },
            })
          )
        )
      ).toBe(true);
    });

    it('falls back to playerName when deviceId is null', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        deviceId: null,
        playerName: 'iPhone',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: oneHourAgo,
        deviceId: null,
        playerName: 'iPad',
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1, session2],
      });

      const evaluator = evaluatorRegistry.unique_devices_in_window;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'unique_devices_in_window',
              operator: 'eq',
              value: 2,
              params: { window_hours: 24 },
            })
          )
        )
      ).toBe(true);
    });

    it('deduplicates same devices', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const session1 = createMockSession({
        id: 's1',
        serverUserId: 'user-1',
        startedAt: now,
        deviceId: 'device-1',
        playerName: 'Player 1',
      });
      const session2 = createMockSession({
        id: 's2',
        serverUserId: 'user-1',
        startedAt: oneHourAgo,
        deviceId: 'device-1',
        playerName: 'Player 1',
      });

      const ctx = createTestContext({
        session: session1,
        serverUser: createMockServerUser({ id: 'user-1' }),
        recentSessions: [session1, session2],
      });

      const evaluator = evaluatorRegistry.unique_devices_in_window;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'unique_devices_in_window',
              operator: 'eq',
              value: 1,
              params: { window_hours: 24 },
            })
          )
        )
      ).toBe(true);
    });
  });

  describe('inactive_days', () => {
    it('calculates days since last activity', () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const ctx = createTestContext({
        serverUser: createMockServerUser({ lastActivityAt: tenDaysAgo }),
      });

      const evaluator = evaluatorRegistry.inactive_days;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'inactive_days', operator: 'gte', value: 10 }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'inactive_days', operator: 'gt', value: 10 }))
        )
      ).toBe(false);
    });

    it('uses account age when no activity recorded', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const ctx = createTestContext({
        serverUser: createMockServerUser({ lastActivityAt: null, createdAt: thirtyDaysAgo }),
      });

      const evaluator = evaluatorRegistry.inactive_days;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'inactive_days', operator: 'gte', value: 30 }))
        )
      ).toBe(true);
    });
  });

  describe('current_pause_minutes', () => {
    it('returns true when session paused longer than threshold', () => {
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
      const session = createMockSession({
        state: 'paused',
        lastPausedAt: twentyMinutesAgo,
        pausedDurationMs: 0,
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.current_pause_minutes;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'current_pause_minutes', operator: 'gte', value: 15 })
          )
        )
      ).toBe(true);
    });

    it('returns false when session paused less than threshold', () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const session = createMockSession({
        state: 'paused',
        lastPausedAt: fiveMinutesAgo,
        pausedDurationMs: 0,
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.current_pause_minutes;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'current_pause_minutes', operator: 'gte', value: 15 })
          )
        )
      ).toBe(false);
    });

    it('returns false when session is not paused', () => {
      const session = createMockSession({
        state: 'playing',
        lastPausedAt: null,
        pausedDurationMs: 300000, // 5 min of previous pause time
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.current_pause_minutes;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'current_pause_minutes', operator: 'gte', value: 1 })
          )
        )
      ).toBe(false);
    });

    it('supports gt operator for strict comparison', () => {
      // Use fake timers to freeze Date.now() for exact boundary testing
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-06-01T12:00:00.000Z'));

      const fifteenMinutesAgo = new Date('2025-06-01T11:45:00.000Z');
      const session = createMockSession({
        state: 'paused',
        lastPausedAt: fifteenMinutesAgo,
        pausedDurationMs: 0,
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.current_pause_minutes;
      // gte should be true at exactly 15 minutes
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'current_pause_minutes', operator: 'gte', value: 15 })
          )
        )
      ).toBe(true);
      // gt should be false at exactly 15 minutes (need to be strictly greater)
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'current_pause_minutes', operator: 'gt', value: 15 })
          )
        )
      ).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('total_pause_minutes', () => {
    it('returns true when accumulated pause exceeds threshold', () => {
      const session = createMockSession({
        state: 'playing',
        lastPausedAt: null,
        pausedDurationMs: 30 * 60 * 1000, // 30 min accumulated
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.total_pause_minutes;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'total_pause_minutes', operator: 'gte', value: 25 })
          )
        )
      ).toBe(true);
    });

    it('includes ongoing pause in total calculation', () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const session = createMockSession({
        state: 'paused',
        lastPausedAt: tenMinutesAgo,
        pausedDurationMs: 20 * 60 * 1000, // 20 min accumulated + 10 min ongoing = 30 min
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.total_pause_minutes;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'total_pause_minutes', operator: 'gte', value: 30 })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'total_pause_minutes', operator: 'gte', value: 31 })
          )
        )
      ).toBe(false);
    });

    it('returns false when total pause is below threshold', () => {
      const session = createMockSession({
        state: 'playing',
        lastPausedAt: null,
        pausedDurationMs: 5 * 60 * 1000, // 5 min
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.total_pause_minutes;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'total_pause_minutes', operator: 'gte', value: 15 })
          )
        )
      ).toBe(false);
    });

    it('handles zero pause duration', () => {
      const session = createMockSession({
        state: 'playing',
        lastPausedAt: null,
        pausedDurationMs: 0,
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.total_pause_minutes;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'total_pause_minutes', operator: 'eq', value: 0 })
          )
        )
      ).toBe(true);
    });
  });
});

describe('Stream Quality Evaluators', () => {
  describe('source_resolution', () => {
    it('evaluates source video resolution', () => {
      const session = createMockSession({
        sourceVideoWidth: 3840,
        sourceVideoHeight: 2160,
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.source_resolution;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'source_resolution', operator: 'eq', value: '4K' })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'source_resolution', operator: 'in', value: ['4K', '1080p'] })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'source_resolution',
              operator: 'not_in',
              value: ['720p', '480p'],
            })
          )
        )
      ).toBe(true);
    });

    it('handles widescreen content correctly', () => {
      const session = createMockSession({
        sourceVideoWidth: 1920,
        sourceVideoHeight: 804,
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.source_resolution;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'source_resolution', operator: 'eq', value: '1080p' })
          )
        )
      ).toBe(true);
    });
  });

  describe('output_resolution', () => {
    it('evaluates output resolution from stream video details', () => {
      const session = createMockSession({
        isTranscode: true,
        streamVideoDetails: { width: 1920, height: 1080 },
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.output_resolution;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'output_resolution', operator: 'eq', value: '1080p' })
          )
        )
      ).toBe(true);
    });

    it('works with in/not_in operators', () => {
      const session = createMockSession({
        isTranscode: true,
        streamVideoDetails: { width: 1280, height: 720 },
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.output_resolution;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'output_resolution',
              operator: 'in',
              value: ['720p', '1080p'],
            })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'output_resolution',
              operator: 'not_in',
              value: ['4K'],
            })
          )
        )
      ).toBe(true);
    });

    it('returns unknown when streamVideoDetails is null', () => {
      const session = createMockSession({
        isTranscode: false,
        streamVideoDetails: null,
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.output_resolution;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'output_resolution', operator: 'eq', value: 'unknown' })
          )
        )
      ).toBe(true);
    });

    it('compares numeric resolution values for gt/lt operators', () => {
      const session = createMockSession({
        streamVideoDetails: { width: 3840, height: 2160 },
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.output_resolution;
      // 4K (2160) > 1080p (1080)
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'output_resolution', operator: 'gt', value: '1080p' })
          )
        )
      ).toBe(true);
    });
  });

  describe('is_transcoding', () => {
    it('evaluates "video" - matches when video is transcoding', () => {
      const session = createMockSession({
        isTranscode: true,
        videoDecision: 'transcode',
        audioDecision: 'copy',
      });
      const ctx = createTestContext({ session });
      const evaluator = evaluatorRegistry.is_transcoding;

      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'video' })
          )
        )
      ).toBe(true);
    });

    it('evaluates "video" - does not match when only audio is transcoding', () => {
      const session = createMockSession({
        isTranscode: true,
        videoDecision: 'copy',
        audioDecision: 'transcode',
      });
      const ctx = createTestContext({ session });
      const evaluator = evaluatorRegistry.is_transcoding;

      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'video' })
          )
        )
      ).toBe(false);
    });

    it('evaluates "audio" - matches when audio is transcoding', () => {
      const session = createMockSession({
        isTranscode: true,
        videoDecision: 'copy',
        audioDecision: 'transcode',
      });
      const ctx = createTestContext({ session });
      const evaluator = evaluatorRegistry.is_transcoding;

      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'audio' })
          )
        )
      ).toBe(true);
    });

    it('evaluates "audio" - does not match when only video is transcoding', () => {
      const session = createMockSession({
        isTranscode: true,
        videoDecision: 'transcode',
        audioDecision: 'copy',
      });
      const ctx = createTestContext({ session });
      const evaluator = evaluatorRegistry.is_transcoding;

      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'audio' })
          )
        )
      ).toBe(false);
    });

    it('evaluates "video_or_audio" - matches when either is transcoding', () => {
      const evaluator = evaluatorRegistry.is_transcoding;

      // Video only transcoding
      const videoOnly = createMockSession({
        isTranscode: true,
        videoDecision: 'transcode',
        audioDecision: 'copy',
      });
      expect(
        matched(
          evaluator(
            createTestContext({ session: videoOnly }),
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'video_or_audio' })
          )
        )
      ).toBe(true);

      // Audio only transcoding
      const audioOnly = createMockSession({
        isTranscode: true,
        videoDecision: 'copy',
        audioDecision: 'transcode',
      });
      expect(
        matched(
          evaluator(
            createTestContext({ session: audioOnly }),
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'video_or_audio' })
          )
        )
      ).toBe(true);

      // Both transcoding
      const both = createMockSession({
        isTranscode: true,
        videoDecision: 'transcode',
        audioDecision: 'transcode',
      });
      expect(
        matched(
          evaluator(
            createTestContext({ session: both }),
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'video_or_audio' })
          )
        )
      ).toBe(true);
    });

    it('evaluates "video_or_audio" - does not match direct play', () => {
      const session = createMockSession({
        isTranscode: false,
        videoDecision: 'directplay',
        audioDecision: 'directplay',
      });
      const ctx = createTestContext({ session });
      const evaluator = evaluatorRegistry.is_transcoding;

      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'video_or_audio' })
          )
        )
      ).toBe(false);
    });

    it('evaluates "neither" - matches direct play', () => {
      const session = createMockSession({
        isTranscode: false,
        videoDecision: 'directplay',
        audioDecision: 'directplay',
      });
      const ctx = createTestContext({ session });
      const evaluator = evaluatorRegistry.is_transcoding;

      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'neither' })
          )
        )
      ).toBe(true);
    });

    it('evaluates "neither" - does not match when transcoding', () => {
      const session = createMockSession({
        isTranscode: true,
        videoDecision: 'transcode',
        audioDecision: 'copy',
      });
      const ctx = createTestContext({ session });
      const evaluator = evaluatorRegistry.is_transcoding;

      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_transcoding', operator: 'eq', value: 'neither' })
          )
        )
      ).toBe(false);
    });

    // Backwards compatibility tests
    it('backwards compatibility: boolean true behaves like video_or_audio', () => {
      const session = createMockSession({ isTranscode: true });
      const ctx = createTestContext({ session });
      const evaluator = evaluatorRegistry.is_transcoding;

      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'is_transcoding', operator: 'eq', value: true }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'is_transcoding', operator: 'eq', value: false }))
        )
      ).toBe(false);
    });

    it('backwards compatibility: boolean false behaves like neither', () => {
      const session = createMockSession({
        isTranscode: false,
        videoDecision: 'directplay',
        audioDecision: 'directplay',
      });
      const ctx = createTestContext({ session });
      const evaluator = evaluatorRegistry.is_transcoding;

      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'is_transcoding', operator: 'eq', value: false }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'is_transcoding', operator: 'eq', value: true }))
        )
      ).toBe(false);
    });
  });

  describe('is_transcode_downgrade', () => {
    it('detects resolution downgrade during transcode', () => {
      const session = createMockSession({
        isTranscode: true,
        sourceVideoWidth: 3840,
        sourceVideoHeight: 2160,
        streamVideoDetails: { width: 1920, height: 1080 },
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.is_transcode_downgrade;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_transcode_downgrade', operator: 'eq', value: true })
          )
        )
      ).toBe(true);
    });

    it('returns false when not transcoding', () => {
      const session = createMockSession({
        isTranscode: false,
        sourceVideoWidth: 3840,
        sourceVideoHeight: 2160,
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.is_transcode_downgrade;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_transcode_downgrade', operator: 'eq', value: true })
          )
        )
      ).toBe(false);
    });
  });

  describe('source_bitrate_mbps', () => {
    it('evaluates source bitrate in Mbps', () => {
      const session = createMockSession({
        bitrate: 25_000_000,
        sourceVideoDetails: { bitrate: 25_000_000 },
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.source_bitrate_mbps;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'source_bitrate_mbps', operator: 'gt', value: 20 })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'source_bitrate_mbps', operator: 'lt', value: 30 })
          )
        )
      ).toBe(true);
    });
  });
});

describe('User Attribute Evaluators', () => {
  describe('user_id', () => {
    it('matches user by ID', () => {
      const ctx = createTestContext({
        serverUser: createMockServerUser({ id: 'user-123' }),
      });

      const evaluator = evaluatorRegistry.user_id;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'user_id', operator: 'eq', value: 'user-123' }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'user_id', operator: 'in', value: ['user-123', 'user-456'] })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'user_id', operator: 'not_in', value: ['user-456'] })
          )
        )
      ).toBe(true);
    });

    it('returns identityName as actual when available', () => {
      const ctx = createTestContext({
        serverUser: createMockServerUser({
          id: 'user-123',
          username: 'plexuser',
          identityName: 'John Doe',
        }),
      });

      const evaluator = evaluatorRegistry.user_id;
      const result = evaluator(
        ctx,
        createCondition({ field: 'user_id', operator: 'eq', value: 'user-123' })
      ) as EvaluatorResult; // user_id evaluator is synchronous

      // Should use identityName for display (follows identityName ?? username pattern)
      expect(result.actual).toBe('John Doe');
      // Should include userId in details for debugging
      expect(result.details).toEqual({ userId: 'user-123' });
    });

    it('falls back to username when identityName is null', () => {
      const ctx = createTestContext({
        serverUser: createMockServerUser({
          id: 'user-456',
          username: 'plexuser',
          identityName: null,
        }),
      });

      const evaluator = evaluatorRegistry.user_id;
      const result = evaluator(
        ctx,
        createCondition({ field: 'user_id', operator: 'eq', value: 'user-456' })
      ) as EvaluatorResult; // user_id evaluator is synchronous

      // Should fall back to username when identityName is null
      expect(result.actual).toBe('plexuser');
      expect(result.details).toEqual({ userId: 'user-456' });
    });
  });

  describe('trust_score', () => {
    it('evaluates trust score', () => {
      const ctx = createTestContext({
        serverUser: createMockServerUser({ trustScore: 75 }),
      });

      const evaluator = evaluatorRegistry.trust_score;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'trust_score', operator: 'lt', value: 80 }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'trust_score', operator: 'gte', value: 70 }))
        )
      ).toBe(true);
    });
  });

  describe('account_age_days', () => {
    it('calculates account age in days', () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const ctx = createTestContext({
        serverUser: createMockServerUser({ createdAt: sevenDaysAgo }),
      });

      const evaluator = evaluatorRegistry.account_age_days;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'account_age_days', operator: 'lt', value: 30 }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'account_age_days', operator: 'gte', value: 7 }))
        )
      ).toBe(true);
    });
  });
});

describe('Device/Client Evaluators', () => {
  describe('device_type', () => {
    it('evaluates normalized device type', () => {
      const session = createMockSession({ device: 'iPhone 14', platform: 'iOS' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.device_type;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'device_type', operator: 'eq', value: 'mobile' }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'device_type', operator: 'not_in', value: ['tv', 'desktop'] })
          )
        )
      ).toBe(true);
    });
  });

  describe('client_name', () => {
    it('evaluates client/product name', () => {
      const session = createMockSession({ product: 'Plex for iOS', playerName: 'iPhone' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.client_name;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'client_name', operator: 'contains', value: 'Plex' })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'client_name', operator: 'eq', value: 'Plex for iOS' })
          )
        )
      ).toBe(true);
    });
  });

  describe('platform', () => {
    it('evaluates normalized platform', () => {
      const session = createMockSession({ platform: 'iOS' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.platform;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'platform', operator: 'eq', value: 'ios' }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'platform', operator: 'in', value: ['ios', 'android'] })
          )
        )
      ).toBe(true);
    });

    it('handles null platform (Jellyfin/Emby)', () => {
      const session = createMockSession({ platform: null });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.platform;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'platform', operator: 'eq', value: 'unknown' }))
        )
      ).toBe(true);
    });
  });
});

describe('Network/Location Evaluators', () => {
  describe('is_local_network', () => {
    it('detects private/local IPs', () => {
      const session = createMockSession({ ipAddress: '192.168.1.100' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.is_local_network;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_local_network', operator: 'eq', value: true })
          )
        )
      ).toBe(true);
    });

    it('detects public IPs', () => {
      const session = createMockSession({ ipAddress: '8.8.8.8' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.is_local_network;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'is_local_network', operator: 'eq', value: false })
          )
        )
      ).toBe(true);
    });
  });

  describe('country', () => {
    it('evaluates country code', () => {
      const session = createMockSession({ geoCountry: 'US' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.country;
      expect(
        matched(evaluator(ctx, createCondition({ field: 'country', operator: 'eq', value: 'US' })))
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'country', operator: 'in', value: ['US', 'CA', 'UK'] })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'country', operator: 'not_in', value: ['CN', 'RU'] })
          )
        )
      ).toBe(true);
    });
  });

  describe('ip_in_range', () => {
    it('matches IP within CIDR range using in operator', () => {
      const session = createMockSession({ ipAddress: '192.168.1.100' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.ip_in_range;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'ip_in_range', operator: 'in', value: ['192.168.0.0/16'] })
          )
        )
      ).toBe(true);
    });

    it('matches IP within multiple CIDR ranges', () => {
      const session = createMockSession({ ipAddress: '10.0.5.25' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.ip_in_range;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'ip_in_range',
              operator: 'in',
              value: ['192.168.0.0/16', '10.0.0.0/8'],
            })
          )
        )
      ).toBe(true);
    });

    it('returns false when IP not in any CIDR range', () => {
      const session = createMockSession({ ipAddress: '8.8.8.8' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.ip_in_range;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'ip_in_range', operator: 'in', value: ['192.168.0.0/16'] })
          )
        )
      ).toBe(false);
    });

    it('works with not_in operator', () => {
      const session = createMockSession({ ipAddress: '8.8.8.8' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.ip_in_range;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'ip_in_range',
              operator: 'not_in',
              value: ['192.168.0.0/16', '10.0.0.0/8'],
            })
          )
        )
      ).toBe(true);
    });

    it('works with eq operator for single CIDR', () => {
      const session = createMockSession({ ipAddress: '172.16.5.10' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.ip_in_range;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'ip_in_range', operator: 'eq', value: '172.16.0.0/12' })
          )
        )
      ).toBe(true);
    });

    it('handles /32 prefix (exact IP match)', () => {
      const session = createMockSession({ ipAddress: '192.168.1.1' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.ip_in_range;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'ip_in_range', operator: 'eq', value: '192.168.1.1/32' })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'ip_in_range', operator: 'eq', value: '192.168.1.2/32' })
          )
        )
      ).toBe(false);
    });

    it('returns false when ipAddress is missing', () => {
      const session = createMockSession({ ipAddress: undefined });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.ip_in_range;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'ip_in_range', operator: 'in', value: ['0.0.0.0/0'] })
          )
        )
      ).toBe(false);
    });

    it('works with IPv6 CIDR ranges', () => {
      const session = createMockSession({
        ipAddress: '2001:db8:abcd:7800:58f:b385:9778:7ab6',
      });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.ip_in_range;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'ip_in_range',
              operator: 'eq',
              value: '2001:db8:abcd:7800::/64',
            })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'ip_in_range',
              operator: 'eq',
              value: '2001:db8:abcd:7801::/64',
            })
          )
        )
      ).toBe(false);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'ip_in_range',
              operator: 'neq',
              value: '2001:db8:abcd:7800::/64',
            })
          )
        )
      ).toBe(false);
    });
  });
});

describe('Scope Evaluators', () => {
  describe('server_id', () => {
    it('matches server by ID', () => {
      const server = createMockServer({ id: 'server-abc' });
      const ctx = createTestContext({ server });

      const evaluator = evaluatorRegistry.server_id;
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'server_id', operator: 'eq', value: 'server-abc' })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({
              field: 'server_id',
              operator: 'in',
              value: ['server-abc', 'server-def'],
            })
          )
        )
      ).toBe(true);
    });
  });

  describe('media_type', () => {
    it('evaluates media type', () => {
      const session = createMockSession({ mediaType: 'movie' });
      const ctx = createTestContext({ session });

      const evaluator = evaluatorRegistry.media_type;
      expect(
        matched(
          evaluator(ctx, createCondition({ field: 'media_type', operator: 'eq', value: 'movie' }))
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'media_type', operator: 'in', value: ['movie', 'episode'] })
          )
        )
      ).toBe(true);
      expect(
        matched(
          evaluator(
            ctx,
            createCondition({ field: 'media_type', operator: 'not_in', value: ['track'] })
          )
        )
      ).toBe(true);
    });
  });
});

describe('Evaluator Registry', () => {
  it('has evaluators for all condition fields', () => {
    const expectedFields = [
      'concurrent_streams',
      'active_session_distance_km',
      'travel_speed_kmh',
      'unique_ips_in_window',
      'unique_devices_in_window',
      'inactive_days',
      'current_pause_minutes',
      'total_pause_minutes',
      'source_resolution',
      'output_resolution',
      'is_transcoding',
      'is_transcode_downgrade',
      'source_bitrate_mbps',
      'user_id',
      'trust_score',
      'account_age_days',
      'device_type',
      'client_name',
      'platform',
      'is_local_network',
      'country',
      'ip_in_range',
      'server_id',
      'library_id',
      'media_type',
    ];

    for (const field of expectedFields) {
      expect(evaluatorRegistry).toHaveProperty(field);
      expect(typeof evaluatorRegistry[field as keyof typeof evaluatorRegistry]).toBe('function');
    }
  });
});
