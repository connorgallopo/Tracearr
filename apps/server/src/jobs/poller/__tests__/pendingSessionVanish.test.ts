/**
 * Poller pending-session vanish tests.
 *
 * A pending entry that never reaches the 30s confirmation threshold has no
 * DB row, so the normal grace-period stop (findActiveSession + stopSessionAtomic)
 * has nothing to close. resolveVanishedPendingSession is the poller's mirror
 * of sseProcessor's stop-before-confirm handling: negligible progress
 * discards the phantom, real progress routes it through confirmAndPersistSession
 * (which corrects startedAt/pausedDurationMs/progressMs from the pending data
 * instead of stamping sweep time) and then stops it immediately.
 *
 * Both tests drive the same two-tick grace-period model used elsewhere in
 * this suite (qualityChangeFallout.test.ts's "grace-period sweep" case):
 * tick 1 with an empty poll response records the first miss, tick 2 (still
 * empty) confirms it and resolves the pending entry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession } from '@tracearr/shared';
import { servers as serversTable, sessions as sessionsTable } from '../../../db/schema.js';
import type { CacheService, PubSubService } from '../../../services/cache.js';
import type { PendingSessionData } from '../types.js';

const mockDbSelect = vi.fn();
const {
  mockCreateMediaServerClient,
  mockGetActiveAutomations,
  mockConfirmAndPersistSession,
  mockCreateSessionWithRulesAtomic,
  mockStopSessionAtomic,
  mockBroadcastViolations,
} = vi.hoisted(() => ({
  mockCreateMediaServerClient: vi.fn(),
  mockGetActiveAutomations: vi.fn().mockResolvedValue([]),
  mockConfirmAndPersistSession: vi.fn(),
  mockCreateSessionWithRulesAtomic: vi.fn(),
  mockStopSessionAtomic: vi.fn(),
  mockBroadcastViolations: vi.fn(),
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
  getCachedServers: () => mockDbSelect().from(serversTable),
  getActiveAutomations: mockGetActiveAutomations,
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  mergeRecentSessionsForIdentity: (map: Map<string, unknown[]>, ids: string[]) =>
    ids.flatMap((id) => map.get(id) ?? []),
  widenRecentSessionsForMergedIdentities: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: vi.fn(),
}));

vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: vi.fn(),
  confirmAndPersistSession: (...args: unknown[]) => mockConfirmAndPersistSession(...args),
  createSessionWithRulesAtomic: (...args: unknown[]) => mockCreateSessionWithRulesAtomic(...args),
  findActiveSession: vi.fn().mockResolvedValue(null),
  findActiveSessionByComposite: vi.fn().mockResolvedValue(null),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn().mockResolvedValue(undefined),
  processPollResults: vi.fn().mockResolvedValue(undefined),
  stopSessionAtomic: (...args: unknown[]) => mockStopSessionAtomic(...args),
}));

const mockDispatch = vi.fn().mockResolvedValue({ violations: [], outcomes: [] });
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));

vi.mock('../violations.js', () => ({
  broadcastViolations: (...args: unknown[]) => mockBroadcastViolations(...args),
}));

vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: vi.fn((raw: unknown) => raw),
  pickStreamDetailFields: vi.fn().mockReturnValue({}),
}));

import { initializePoller, stopPoller, triggerPoll } from '../processor.js';
import { fakeJellyfinClient, fakePlexClient } from '../../../test/mediaServerFakes.js';

const serverRow = {
  id: 'server-1',
  name: 'Test Server',
  type: 'plex' as const,
  url: 'http://localhost:32400',
  token: 'token-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const jellyfinServerRow = {
  id: 'server-jf',
  name: 'Test Jellyfin Server',
  type: 'jellyfin' as const,
  url: 'http://localhost:8096',
  token: 'token-jf',
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Thenable select().from() stub covering the three query shapes this suite's poll
 * tick reaches: pollServers' bare `select().from(servers)` (server list, awaited
 * directly), sweepStaleSessions' bare `select().from(sessions).where(...)` (always
 * empty here - stale-sweep behavior is out of scope for these tests), and the in-lock
 * `select({id}).from(sessions).where(...).limit(1)` existingById check.
 */
function stubServerListAndExistingRows(
  rows: (typeof serverRow | typeof jellyfinServerRow)[],
  existingRows: { id: string }[] = []
) {
  mockDbSelect.mockImplementation((columns?: unknown) => ({
    from: (table?: unknown) => {
      if (table === serversTable) {
        const result = Promise.resolve(rows) as Promise<typeof rows> & {
          where: () => Promise<never[]>;
        };
        result.where = () => Promise.resolve([]);
        return result;
      }
      if (table === sessionsTable && columns !== undefined) {
        const whereResult = Promise.resolve(existingRows) as Promise<{ id: string }[]> & {
          limit: () => Promise<{ id: string }[]>;
        };
        whereResult.limit = () => Promise.resolve(existingRows);
        return { where: () => whereResult };
      }
      return { where: () => Promise.resolve([]) };
    },
  }));
}

function createPendingSessionData(
  progressMs: number,
  overrides: Partial<PendingSessionData> = {}
): PendingSessionData {
  const now = Date.now();
  return {
    id: 'pending-vanish-id',
    confirmation: {
      confirmedPlayback: false,
      firstSeenAt: now - 5000,
      maxViewOffset: progressMs,
      initialViewOffset: 0,
    },
    processed: {
      sessionKey: 'sk-vanish',
      ratingKey: 'rk-vanish',
      externalUserId: 'ext-user-1',
      username: 'testuser',
      state: 'playing',
    } as PendingSessionData['processed'],
    server: { id: 'server-1', name: 'Test Server', type: 'plex' },
    serverUser: {
      id: 'su-a',
      userId: 'identity-a',
      username: 'testuser',
      thumbUrl: null,
      identityName: 'Test User',
      trustScore: 100,
      lastActivityAt: null,
      createdAt: new Date(),
      identityServerUserIds: ['su-a'],
    },
    geo: {
      city: null,
      region: null,
      country: null,
      countryCode: null,
      continent: null,
      postal: null,
      lat: null,
      lon: null,
      asnNumber: null,
      asnOrganization: null,
    },
    startedAt: now - 5000,
    lastSeenAt: now - 1000,
    currentState: 'playing',
    pausedDurationMs: 0,
    lastPausedAt: null,
    ...overrides,
  };
}

// The pending session's cached-active-session snapshot: marked `pending: true`
// so sweepGracePeriod routes it to resolveVanishedPendingSession instead of
// the DB-backed findActiveSession/stopSessionAtomic path.
const pendingActiveSession = {
  id: 'pending-vanish-id',
  serverId: 'server-1',
  serverUserId: 'su-a',
  sessionKey: 'sk-vanish',
  deviceId: 'device-1',
  ratingKey: 'rk-vanish',
  pending: true,
} as unknown as ActiveSession;

function createCacheService(pendingData: PendingSessionData | null) {
  return {
    getAllActiveSessions: vi.fn().mockResolvedValue([pendingActiveSession]),
    setServerHealth: vi.fn().mockResolvedValue(true),
    resetServerFailCount: vi.fn().mockResolvedValue(undefined),
    incrServerFailCount: vi.fn().mockResolvedValue(1),
    getPendingSession: vi.fn().mockResolvedValue(pendingData),
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

beforeEach(() => {
  vi.clearAllMocks();
  stopPoller();

  stubServerListAndExistingRows([serverRow]);
  mockCreateMediaServerClient.mockReturnValue(
    fakePlexClient({
      getSessions: vi.fn().mockResolvedValue([]),
    })
  );
});

afterEach(() => {
  stopPoller();
});

describe('poller resolves a pending session that vanishes before confirmation', () => {
  it('discards the phantom with no DB row when it showed negligible progress', async () => {
    const pendingData = createPendingSessionData(0);
    const cacheService = createCacheService(pendingData);
    const pubSubService = createPubSubService();
    initializePoller(
      cacheService as unknown as CacheService,
      pubSubService as unknown as PubSubService
    );

    // Tick 1: absent from the poll -> first miss, tracked but not resolved yet.
    await triggerPoll();
    expect(cacheService.getPendingSession).not.toHaveBeenCalled();

    // Tick 2: still absent -> grace period confirms the miss and resolves it.
    await triggerPoll();

    expect(cacheService.getPendingSession).toHaveBeenCalledWith('server-1', 'sk-vanish');
    expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
    expect(mockStopSessionAtomic).not.toHaveBeenCalled();
    expect(cacheService.deletePendingSession).toHaveBeenCalledWith('server-1', 'sk-vanish');
    expect(cacheService.removeActiveSession).toHaveBeenCalledWith(
      'pending-vanish-id',
      expect.objectContaining({ skipDashboardInvalidation: true })
    );
    expect(pubSubService.publish).toHaveBeenCalledWith('session:stopped', 'pending-vanish-id');
    // Discarded phantoms never reach history, so no user-facing notification.
    expect(mockEnqueueNotification).not.toHaveBeenCalled();
  });

  it('persists through confirmAndPersistSession with corrected timing and immediately stops the session', async () => {
    const pendingData = createPendingSessionData(20000);
    const cacheService = createCacheService(pendingData);
    const pubSubService = createPubSubService();
    initializePoller(
      cacheService as unknown as CacheService,
      pubSubService as unknown as PubSubService
    );

    mockConfirmAndPersistSession.mockResolvedValue({
      insertedSession: {
        id: 'pending-vanish-id',
        sessionKey: 'sk-vanish',
        serverUserId: 'su-a',
        startedAt: new Date(pendingData.startedAt),
      },
      violationResults: [],
      qualityChange: null,
      referenceId: null,
      wasTerminatedByRule: false,
    });
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: 20000,
      watched: false,
      shortSession: false,
      wasUpdated: true,
    });

    await triggerPoll(); // first miss
    await triggerPoll(); // confirmed miss -> resolve

    // Goes through confirmAndPersistSession (which corrects startedAt/pausedDurationMs/
    // progressMs from the pending data), never the raw createSessionWithRulesAtomic path
    // that stamps sweep time as startedAt.
    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
    expect(mockConfirmAndPersistSession).toHaveBeenCalledTimes(1);

    // Guarded by the session-create lock, same as resolvePendingSession and the SSE confirm.
    expect(cacheService.withSessionCreateLock).toHaveBeenCalledWith(
      'server-1',
      'sk-vanish',
      expect.any(Function)
    );

    const call = mockConfirmAndPersistSession.mock.calls[0]?.[0] as {
      pendingData: PendingSessionData;
      activeAutomations: unknown[];
      activeSessions: unknown[];
      recentSessions: unknown[];
    };
    // startedAt carries the original pending-creation time (not sweep/Date.now()).
    expect(call.pendingData.startedAt).toBe(pendingData.startedAt);
    expect(call.pendingData.id).toBe('pending-vanish-id');
    // Progress comes from the pending session's own tracked maxViewOffset.
    expect(call.pendingData.confirmation.maxViewOffset).toBe(20000);
    expect(call.activeAutomations).toEqual([]);

    expect(cacheService.deletePendingSession).toHaveBeenCalledWith('server-1', 'sk-vanish');

    // Immediately stopped - the session never reappeared, so it must close in
    // the same tick it was persisted rather than waiting for a future poll.
    expect(mockStopSessionAtomic).toHaveBeenCalledTimes(1);
    const stopCall = mockStopSessionAtomic.mock.calls[0]?.[0] as {
      session: { id: string };
      stoppedAt: Date;
    };
    expect(stopCall.session.id).toBe('pending-vanish-id');
    // stoppedAt is the last confirmed-alive time, not the sweep's own Date.now().
    expect(stopCall.stoppedAt).toEqual(new Date(pendingData.lastSeenAt));

    // stopSessionAtomic owns the session.stopped dispatch; nothing enqueues here.
    expect(mockEnqueueNotification).not.toHaveBeenCalled();
  });

  it('drops the stale pending entry without persisting when a concurrent caller already wrote the row', async () => {
    const pendingData = createPendingSessionData(20000);
    const cacheService = createCacheService(pendingData);
    const pubSubService = createPubSubService();
    initializePoller(
      cacheService as unknown as CacheService,
      pubSubService as unknown as PubSubService
    );

    // The in-lock existingById lookup finds a row already persisted for this pre-generated id.
    stubServerListAndExistingRows([serverRow], [{ id: 'pending-vanish-id' }]);

    await triggerPoll();
    await triggerPoll();

    expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
    expect(mockStopSessionAtomic).not.toHaveBeenCalled();
    expect(cacheService.deletePendingSession).toHaveBeenCalledWith('server-1', 'sk-vanish');
  });

  it('resolves a composite-key (jellyfin) vanished pending session with corrected timing', async () => {
    const jfPendingKey = 'server-jf:su-a:device-1:rk-vanish-jf';
    const pendingData = createPendingSessionData(20000, {
      processed: {
        sessionKey: 'sk-vanish-jf',
        ratingKey: 'rk-vanish-jf',
        externalUserId: 'ext-user-1',
        username: 'testuser',
        state: 'playing',
        deviceId: 'device-1',
      } as PendingSessionData['processed'],
      server: { id: 'server-jf', name: 'Test Jellyfin Server', type: 'jellyfin' },
    });

    const jfPendingActiveSession = {
      id: 'pending-vanish-id',
      serverId: 'server-jf',
      serverUserId: 'su-a',
      sessionKey: 'sk-vanish-jf',
      deviceId: 'device-1',
      ratingKey: 'rk-vanish-jf',
      pending: true,
    } as unknown as ActiveSession;

    const cacheService = createCacheService(pendingData);
    cacheService.getAllActiveSessions = vi.fn().mockResolvedValue([jfPendingActiveSession]);

    const pubSubService = createPubSubService();
    initializePoller(
      cacheService as unknown as CacheService,
      pubSubService as unknown as PubSubService
    );

    stubServerListAndExistingRows([jellyfinServerRow]);
    mockCreateMediaServerClient.mockReturnValue(
      fakeJellyfinClient({ getSessions: vi.fn().mockResolvedValue([]) })
    );
    mockConfirmAndPersistSession.mockResolvedValue({
      insertedSession: {
        id: 'pending-vanish-id',
        sessionKey: 'sk-vanish-jf',
        serverUserId: 'su-a',
      },
      violationResults: [],
      qualityChange: null,
      referenceId: null,
      wasTerminatedByRule: false,
    });
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: 20000,
      watched: false,
      shortSession: false,
      wasUpdated: true,
    });

    await triggerPoll(); // first miss
    await triggerPoll(); // confirmed miss -> resolve

    // JF/Emby pending keys are the full composite key, never sliced like Plex's.
    expect(cacheService.getPendingSession).toHaveBeenCalledWith('server-jf', jfPendingKey);
    expect(cacheService.withSessionCreateLock).toHaveBeenCalledWith(
      'server-jf',
      'sk-vanish-jf',
      expect.any(Function)
    );

    expect(mockConfirmAndPersistSession).toHaveBeenCalledTimes(1);
    const call = mockConfirmAndPersistSession.mock.calls[0]?.[0] as {
      pendingData: PendingSessionData;
    };
    expect(call.pendingData.startedAt).toBe(pendingData.startedAt);
    expect(call.pendingData.confirmation.maxViewOffset).toBe(20000);

    expect(mockStopSessionAtomic).toHaveBeenCalledTimes(1);
    const stopCall = mockStopSessionAtomic.mock.calls[0]?.[0] as { stoppedAt: Date };
    expect(stopCall.stoppedAt).toEqual(new Date(pendingData.lastSeenAt));

    expect(cacheService.deletePendingSession).toHaveBeenCalledWith('server-jf', jfPendingKey);
  });
});
