/**
 * Quality-Change Fallout & Grace-Period Stop Timing Tests (Task 14)
 *
 * createSessionWithRulesAtomic's quality-change detection stops a
 * same-content twin and returns `qualityChange`. The consumer paths that
 * still call it immediately must react the same way (clear DB-write throttle
 * tracking, remove the twin from cache, publish its stop):
 *  - resolvePendingSession's confirmed-create (covered in
 *    pendingSessionReconciliation.test.ts)
 *  - the stale-recovery path (cached key with no matching active DB row)
 * A brand-new session (nothing pending, nothing cached) now defers creation
 * to a pending entry instead, so quality-change detection for it only runs
 * once that entry confirms - the same confirmed-create path above.
 *
 * Also covers sweepGracePeriod stamping the DB stop with the session's last
 * confirmed-alive timestamp instead of the sweep-tick's `now`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession } from '@tracearr/shared';
import type { CacheService, PubSubService } from '../../../services/cache.js';
import type { ProcessedSession } from '../types.js';

const mockDbSelect = vi.fn();
const {
  mockCreateMediaServerClient,
  mockGetActiveAutomations,
  mockFindActiveSession,
  mockStopSessionAtomic,
  mockCreateSessionWithRulesAtomic,
  mockHandleQualityChangeFallout,
  mockHandleMediaChangeAtomic,
  mockBatchFindActiveSessionsByKey,
  mockDetectMediaChange,
  mockBuildActiveSession,
  mockProcessPollResults,
} = vi.hoisted(() => ({
  mockCreateMediaServerClient: vi.fn(),
  mockGetActiveAutomations: vi.fn().mockResolvedValue([]),
  mockFindActiveSession: vi.fn().mockResolvedValue(null),
  mockStopSessionAtomic: vi.fn(),
  mockCreateSessionWithRulesAtomic: vi.fn(),
  mockHandleQualityChangeFallout: vi.fn().mockResolvedValue(undefined),
  mockHandleMediaChangeAtomic: vi.fn(),
  mockBatchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  mockDetectMediaChange: vi.fn().mockReturnValue(false),
  mockBuildActiveSession: vi.fn(),
  mockProcessPollResults: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../services/leaderLease.js', () => ({
  isLeader: () => true,
}));

vi.mock('../../../db/client.js', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));

vi.mock('../../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

vi.mock('../../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));

vi.mock('../../../services/settings.js', () => ({
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));

vi.mock('../../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../services/mediaServer/index.js', () => ({
  createMediaServerClient: mockCreateMediaServerClient,
}));

vi.mock('../../../services/plexGeoip.js', () => ({
  lookupGeoIP: vi.fn().mockResolvedValue({ city: null, country: null }),
}));

vi.mock('../../../services/serverLocations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSessionGeo: vi.fn().mockResolvedValue({ city: null, country: null, isLocal: true }),
}));

vi.mock('../../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

vi.mock('../../../services/sseManager.js', () => ({
  sseManager: {
    isInFallback: vi.fn().mockReturnValue(true),
    nudgeReconnect: vi.fn(),
  },
}));

const mockEnqueueNotification = vi.fn().mockResolvedValue('job-id');
vi.mock('../../notificationQueue.js', () => ({
  enqueueNotification: (...args: unknown[]) => mockEnqueueNotification(...args),
}));

vi.mock('../database.js', () => ({
  onActiveAutomationsRefill: vi.fn(),
  getCachedServers: () => mockDbSelect().from(servers),
  getActiveAutomations: mockGetActiveAutomations,
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: vi.fn(),
}));

vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: (...args: unknown[]) => mockBatchFindActiveSessionsByKey(...args),
  buildActiveSession: (...args: unknown[]) => mockBuildActiveSession(...args),
  buildPendingActiveSession: vi.fn(),
  createSessionWithRulesAtomic: (...args: unknown[]) => mockCreateSessionWithRulesAtomic(...args),
  findActiveSession: (...args: unknown[]) => mockFindActiveSession(...args),
  findActiveSessionByComposite: vi.fn().mockResolvedValue(null),
  handleMediaChangeAtomic: (...args: unknown[]) => mockHandleMediaChangeAtomic(...args),
  handleQualityChangeFallout: (...args: unknown[]) => mockHandleQualityChangeFallout(...args),
  processPollResults: (...args: unknown[]) => mockProcessPollResults(...args),
  stopSessionAtomic: (...args: unknown[]) => mockStopSessionAtomic(...args),
}));

const mockDispatch = vi.fn().mockResolvedValue({ violations: [], outcomes: [] });
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));

vi.mock('../stateTracker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StateTrackerModule>();
  return {
    ...actual,
    detectMediaChange: (...args: Parameters<typeof actual.detectMediaChange>) =>
      mockDetectMediaChange(...args),
  };
});

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: vi.fn((raw: unknown) => raw),
  pickStreamDetailFields: vi.fn().mockReturnValue({}),
}));

import { servers, serverUsers, sessions as sessionsTable } from '../../../db/schema.js';
import type * as StateTrackerModule from '../stateTracker.js';
import {
  gracePeriodSessionIds,
  initializePoller,
  stopPoller,
  triggerPoll,
  triggerServerPoll,
} from '../processor.js';
import { fakePlexClient } from '../../../test/mediaServerFakes.js';

function createMockProcessedSession(overrides: Partial<ProcessedSession> = {}): ProcessedSession {
  return {
    sessionKey: 'sk-1',
    ratingKey: 'rk-1',
    externalUserId: 'ext-user-1',
    username: 'testuser',
    userThumb: '',
    mediaTitle: 'Test Movie',
    mediaType: 'movie',
    grandparentTitle: '',
    seasonNumber: 0,
    episodeNumber: 0,
    year: 2024,
    thumbPath: '',
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    liveUuid: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    ipAddress: '192.168.1.100',
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
    state: 'playing',
    buffering: false,
    totalDurationMs: 7200000,
    progressMs: 600000,
    sourceVideoCodec: 'hevc',
    sourceAudioCodec: 'ac3',
    sourceAudioChannels: 6,
    sourceVideoWidth: 3840,
    sourceVideoHeight: 2160,
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

const serverRow = {
  id: 'server-1',
  name: 'Test Server',
  type: 'plex' as const,
  url: 'http://localhost:32400',
  token: 'token-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const serverUserRow = {
  id: 'su-a',
  userId: 'identity-a',
  serverId: 'server-1',
  externalId: 'ext-user-1',
  username: 'testuser',
  email: null,
  thumbUrl: null,
  isServerAdmin: false,
  trustScore: 100,
  lastActivityAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  identityName: 'Test User',
};

const qualityChangeResult = {
  stoppedSession: {
    id: 'twin-session-id',
    serverUserId: 'su-a',
    sessionKey: 'twin-session-key',
    deviceId: 'device-1',
    ratingKey: 'rk-1',
  },
  referenceId: 'twin-session-id',
};

function createCacheService() {
  return {
    getAllActiveSessions: vi.fn().mockResolvedValue([]),
    setServerHealth: vi.fn().mockResolvedValue(null),
    resetServerFailCount: vi.fn().mockResolvedValue(undefined),
    incrServerFailCount: vi.fn().mockResolvedValue(1),
    getPendingSession: vi.fn().mockResolvedValue(null),
    setPendingSession: vi.fn().mockResolvedValue(undefined),
    deletePendingSession: vi.fn().mockResolvedValue(undefined),
    withSessionCreateLock: vi
      .fn()
      .mockImplementation(async (_s: unknown, _k: unknown, op: () => unknown) => op()),
    addActiveSession: vi.fn().mockResolvedValue(undefined),
    removeActiveSession: vi.fn().mockResolvedValue(undefined),
    removeUserSession: vi.fn().mockResolvedValue(undefined),
    hasTerminationCooldown: vi.fn().mockResolvedValue(false),
    getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
    clearTerminationCooldownsComposite: vi.fn(),
    addSessionWriteRetry: vi.fn().mockResolvedValue(undefined),
    invalidateDashboardStatsCache: vi.fn().mockResolvedValue(undefined),
  };
}

function createPubSubService() {
  return { publish: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn() };
}

let cacheService: ReturnType<typeof createCacheService>;
let pubSubService: ReturnType<typeof createPubSubService>;

beforeEach(() => {
  vi.clearAllMocks();
  stopPoller();

  mockDbSelect.mockImplementation((_cols?: unknown) => ({
    from: (table: unknown) => {
      if (table === servers) {
        // pollServers awaits `.from(servers)` directly; triggerServerPoll
        // chains `.where(...)` on it - support both call shapes.
        const result = Promise.resolve([serverRow]) as Promise<(typeof serverRow)[]> & {
          where: () => Promise<(typeof serverRow)[]>;
        };
        result.where = () => Promise.resolve([serverRow]);
        return result;
      }
      if (table === serverUsers) {
        return { innerJoin: () => ({ where: () => Promise.resolve([serverUserRow]) }) };
      }
      if (table === sessionsTable) {
        // Plex duplicate-content check: no existing session for this content.
        const obj: Record<string, unknown> = {
          where: () => obj,
          orderBy: () => obj,
          limit: () => obj,
        };
        obj.then = (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve);
        return obj;
      }
      return Promise.resolve([]);
    },
  }));

  cacheService = createCacheService();
  pubSubService = createPubSubService();
  initializePoller(
    cacheService as unknown as CacheService,
    pubSubService as unknown as PubSubService
  );
});

afterEach(() => {
  stopPoller();
});

describe('quality-change fallout: brand-new session defers instead of running fallout immediately', () => {
  it('creates a pending entry with no DB row and no quality-change check on first sight', async () => {
    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({
        getSessions: vi.fn().mockResolvedValue([createMockProcessedSession()]),
      })
    );

    await triggerServerPoll('server-1');

    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
    expect(mockHandleQualityChangeFallout).not.toHaveBeenCalled();
    expect(cacheService.setPendingSession).toHaveBeenCalledTimes(1);
  });
});

describe('quality-change fallout: stale-recovery path', () => {
  it('runs full fallout for the stopped twin when recreating a stale cache entry', async () => {
    // Session is already in the cache (isNew=false) but has no matching
    // active row in the DB (mockFindActiveSession / batch lookups default to
    // empty), so processServerSessions takes the stale-recovery branch.
    cacheService.getAllActiveSessions.mockResolvedValue([
      {
        id: 'stale-cache-id',
        serverId: 'server-1',
        serverUserId: 'su-a',
        sessionKey: 'sk-1',
        deviceId: 'device-1',
        ratingKey: 'rk-1',
        pending: false,
      },
    ]);

    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({
        getSessions: vi.fn().mockResolvedValue([createMockProcessedSession()]),
      })
    );
    mockCreateSessionWithRulesAtomic.mockResolvedValue({
      insertedSession: { id: 'recovered-session-id', sessionKey: 'sk-1' },
      violationResults: [],
      qualityChange: qualityChangeResult,
      referenceId: 'twin-session-id',
      wasTerminatedByRule: false,
    });
    mockBuildActiveSession.mockReturnValue({ id: 'recovered-session-id', serverId: 'server-1' });

    await triggerServerPoll('server-1');

    expect(mockHandleQualityChangeFallout).toHaveBeenCalledWith(
      qualityChangeResult,
      cacheService,
      pubSubService
    );
  });
});

describe('quality-change fallout: media-change path', () => {
  it('runs full fallout for the stopped twin and removes its cachedSessionKeys entry so it does not ride into the next grace-period sweep', async () => {
    // Both the session that's mid media-change (sk-1) and its unrelated
    // quality-change twin (twin-session-key) are already tracked in cache.
    cacheService.getAllActiveSessions.mockResolvedValue([
      {
        id: 'existing-session-id',
        serverId: 'server-1',
        serverUserId: 'su-a',
        sessionKey: 'sk-1',
        deviceId: 'device-1',
        ratingKey: 'rk-1',
        pending: false,
      },
      {
        id: 'twin-session-id',
        serverId: 'server-1',
        serverUserId: 'su-a',
        sessionKey: 'twin-session-key',
        deviceId: 'device-1',
        ratingKey: 'rk-1',
        pending: false,
      },
    ]);

    // The row matched here doesn't need a genuinely different ratingKey -
    // detectMediaChange is mocked below, same as the SSE-side equivalent test.
    mockBatchFindActiveSessionsByKey.mockResolvedValue(
      new Map([
        [
          'sk-1',
          [
            {
              id: 'existing-session-id',
              serverId: 'server-1',
              serverUserId: 'su-a',
              sessionKey: 'sk-1',
              deviceId: 'device-1',
              ratingKey: 'rk-1',
            },
          ],
        ],
      ])
    );
    mockDetectMediaChange.mockReturnValue(true);

    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({
        getSessions: vi.fn().mockResolvedValue([createMockProcessedSession()]),
      })
    );
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: { id: 'existing-session-id', serverUserId: 'su-a', sessionKey: 'sk-1' },
      insertedSession: { id: 'new-session-id', sessionKey: 'sk-1' },
      violationResults: [],
      wasTerminatedByRule: false,
      qualityChange: qualityChangeResult,
    });
    mockBuildActiveSession.mockReturnValue({ id: 'new-session-id', serverId: 'server-1' });

    await triggerServerPoll('server-1');

    expect(mockHandleQualityChangeFallout).toHaveBeenCalledWith(
      qualityChangeResult,
      cacheService,
      pubSubService
    );

    // The twin never reappears in a poll response (it was already stopped),
    // so if its cache key survives it rides handleFirstMisses straight into
    // missedPollTracking on this very tick - a redundant stop cycle.
    expect(gracePeriodSessionIds().has('twin-session-id')).toBe(false);
  });
});

describe('grace-period sweep stamps the honest stop time', () => {
  const activeSessionA = {
    id: 'active-a-id',
    serverId: 'server-1',
    serverUserId: 'su-a',
    sessionKey: 'session-A',
    deviceId: 'device-a',
    ratingKey: 'rk-a',
    pending: false,
  } as unknown as ActiveSession;

  it('stamps stoppedAt from the DB row lastSeenAt, not the sweep tick', async () => {
    cacheService.getAllActiveSessions.mockResolvedValue([activeSessionA]);
    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({
        getSessions: vi.fn().mockResolvedValue([]),
      })
    );

    // Tick 1: session A absent -> enters grace period (first miss), not swept yet.
    await triggerPoll();
    expect(gracePeriodSessionIds().has('active-a-id')).toBe(true);
    expect(mockStopSessionAtomic).not.toHaveBeenCalled();

    // The session was last confirmed alive well before this sweep tick.
    const honestLastSeenAt = new Date(Date.now() - 5 * 60 * 1000);
    mockFindActiveSession.mockResolvedValue({ id: 'db-session-a', lastSeenAt: honestLastSeenAt });
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: 60000,
      watched: false,
      shortSession: false,
      wasUpdated: true,
    });

    // Tick 2: still absent -> confirms the stop.
    await triggerPoll();

    expect(mockStopSessionAtomic).toHaveBeenCalledTimes(1);
    const call = mockStopSessionAtomic.mock.calls[0]?.[0] as { stoppedAt: Date };
    expect(call.stoppedAt).toBe(honestLastSeenAt);
    expect(call.stoppedAt.getTime()).toBeLessThan(Date.now() - 60 * 1000);
  });
});
