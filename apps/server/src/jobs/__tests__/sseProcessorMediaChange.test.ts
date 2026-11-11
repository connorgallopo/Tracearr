/**
 * SSE Processor Tests - Media Change Detection
 *
 * A real Plex "play next episode" reuses the sessionKey with a new ratingKey.
 * handlePlaying must derive the existing row by sessionKey alone and let the
 * real detectMediaChange route it through handleMediaChangeAtomic. These use
 * the real detectMediaChange and a faithful DB-shaped findActiveSession stub
 * (null when a non-null incoming ratingKey does not match the row), so they
 * fail against a build that still filters the lookup by the incoming ratingKey.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';
import {
  clearDbWriteTracking,
  recordDbWrite,
  shouldFlushDbWrite,
} from '../poller/dbWriteThrottle.js';

// ============================================================================
// Hoisted mocks
// ============================================================================

const {
  mockSseManager,
  mockEnqueueNotification,
  mockFindActiveSession,
  mockHandleMediaChangeAtomic,
  mockBuildActiveSession,
  mockGetActiveAutomations,
  mockBatchGetRecentUserSessions,
  mockGetServerUserIdByExternalId,
  mockBroadcastViolations,
  mockCreateMediaServerClient,
  mockDb,
  mockLookupGeoIP,
  mockGetGeoIPSettings,
  mockDispatch,
  mockLoadEvaluationServerUser,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events');
  return {
    mockSseManager: new EE() as EventEmitter,
    mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
    mockFindActiveSession: vi.fn(),
    mockHandleMediaChangeAtomic: vi.fn(),
    mockBuildActiveSession: vi.fn(),
    mockGetActiveAutomations: vi.fn().mockResolvedValue([]),
    mockBatchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
    mockGetServerUserIdByExternalId: vi.fn().mockResolvedValue('server-user-1'),
    mockBroadcastViolations: vi.fn(),
    mockCreateMediaServerClient: vi.fn(),
    mockDb: {
      select: vi.fn(),
      update: vi.fn(),
    },
    mockLookupGeoIP: vi
      .fn()
      .mockResolvedValue({ city: null, country: null, latitude: null, longitude: null }),
    mockGetGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
    mockDispatch: vi.fn().mockResolvedValue({ violations: [], outcomes: [] }),
    mockLoadEvaluationServerUser: vi.fn().mockResolvedValue(null),
  };
});

// ============================================================================
// Module mocks
// ============================================================================

vi.mock('../../services/sseManager.js', () => ({
  sseManager: mockSseManager,
}));

vi.mock('../notificationQueue.js', () => ({
  enqueueNotification: mockEnqueueNotification,
}));

vi.mock('../../db/client.js', () => ({
  db: mockDb,
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: mockCreateMediaServerClient,
}));

vi.mock('../../services/plexGeoip.js', () => ({
  lookupGeoIP: mockLookupGeoIP,
}));

vi.mock('../../services/serverLocations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSessionGeo: vi.fn().mockResolvedValue({ city: null, country: null, isLocal: true }),
}));

vi.mock('../../routes/settings.js', () => ({
  getGeoIPSettings: mockGetGeoIPSettings,
}));

vi.mock('../../services/geoip.js', () => ({
  geoipService: { lookup: vi.fn() },
}));

vi.mock('../poller/index.js', () => ({
  triggerReconciliationPoll: vi.fn(),
  isPollerRunning: () => true,
}));

vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: vi.fn((session: unknown) => session),
}));

// detectMediaChange is left real so the media-change decision is exercised, not
// pre-forced. Only the pure-state helpers are stubbed.
vi.mock('../poller/stateTracker.js', async () => {
  const actual = await vi.importActual<typeof StateTrackerModule>('../poller/stateTracker.js');
  return {
    ...actual,
    calculatePauseAccumulation: vi.fn(),
    checkWatchCompletion: vi.fn(),
    isPlaybackConfirmed: vi.fn().mockReturnValue(false),
    createInitialConfirmationState: vi.fn().mockReturnValue({
      confirmedPlayback: false,
      firstSeenAt: Date.now(),
      maxViewOffset: 0,
    }),
    updateConfirmationState: vi.fn().mockImplementation((state) => state),
  };
});

vi.mock('../poller/database.js', () => ({
  getActiveAutomations: mockGetActiveAutomations,
  batchGetRecentUserSessions: mockBatchGetRecentUserSessions,
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  getServerUserIdByExternalId: mockGetServerUserIdByExternalId,
  mergeRecentSessionsForIdentity: (map: Map<string, unknown[]>, ids: string[]) =>
    ids.flatMap((id) => map.get(id) ?? []),
}));

vi.mock('../poller/violations.js', () => ({
  broadcastViolations: mockBroadcastViolations,
}));

vi.mock('../poller/sessionLifecycle.js', async () => {
  // handleQualityChangeFallout is left as the real implementation so the
  // media-change-onto-tracked-content test can observe its actual throttle/
  // cache/publish effects on the twin, not just that it was called.
  const actual = await vi.importActual<typeof SessionLifecycleModule>(
    '../poller/sessionLifecycle.js'
  );
  return {
    ...actual,
    stopSessionAtomic: vi.fn(),
    findActiveSession: mockFindActiveSession,
    findActiveSessionsAll: vi.fn().mockResolvedValue([]),
    buildActiveSession: mockBuildActiveSession,
    handleMediaChangeAtomic: mockHandleMediaChangeAtomic,
    confirmAndPersistSession: vi.fn(),
  };
});

vi.mock('../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));
vi.mock('../../services/automations/events/contextAssembly.js', () => ({
  loadEvaluationContext: vi.fn().mockResolvedValue(null),
  loadEvaluationServerUser: (...args: unknown[]) => mockLoadEvaluationServerUser(...args),
  assembleEvaluationInputs: vi.fn().mockResolvedValue({
    activeAutomations: [],
    activeSessions: [],
    recentSessions: [],
    identityServerUserIds: [],
  }),
  setContextAssemblyDeps: vi.fn(),
}));

// ============================================================================
// Import after mocking
// ============================================================================

import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../sseProcessor.js';
import { fakePlexClient } from '../../test/mediaServerFakes.js';
import type * as SessionLifecycleModule from '../poller/sessionLifecycle.js';
import type * as StateTrackerModule from '../poller/stateTracker.js';

// ============================================================================
// Test fixtures
// ============================================================================

const SERVER_ID = 'server-1';

const mockServer = {
  id: SERVER_ID,
  name: 'Test Plex',
  type: 'plex',
  url: 'http://localhost:32400',
  token: 'test-token',
};

const mockExistingSession = {
  id: 'session-old',
  serverId: SERVER_ID,
  serverUserId: 'server-user-1',
  sessionKey: '42',
  ratingKey: '1001', // Episode 1
  state: 'playing' as const,
  mediaType: 'episode' as const,
  startedAt: new Date('2026-01-01'),
  lastPausedAt: null,
  pausedDurationMs: 0,
  watched: false,
  totalDurationMs: 3600000,
  videoDecision: 'directplay',
  audioDecision: 'directplay',
};

const mockProcessedSession = {
  sessionKey: '42', // Same sessionKey (Plex reuses it)
  ratingKey: '1002', // Different ratingKey — Episode 2
  state: 'playing' as const,
  mediaType: 'episode' as const,
  mediaTitle: 'Episode 2',
  grandparentTitle: 'Test Show',
  seasonNumber: 1,
  episodeNumber: 2,
  year: 2026,
  thumbPath: '/thumb',
  totalDurationMs: 3600000,
  progressMs: 0,
  ipAddress: '192.168.1.100',
  playerName: 'Plex Web',
  deviceId: 'device-1',
  product: 'Plex Web',
  device: 'Chrome',
  platform: 'Windows',
  quality: '1080p',
  isTranscode: false,
  videoDecision: 'directplay',
  audioDecision: 'directplay',
  bitrate: 10000,
  externalUserId: 'plex-user-1',
  channelTitle: null,
  channelIdentifier: null,
  channelThumb: null,
  artistName: null,
  albumName: null,
  trackNumber: null,
  discNumber: null,
};

const mockServerUser = {
  id: 'server-user-1',
  userId: 'identity-1',
  username: 'testuser',
  thumbUrl: null,
  identityName: 'Test User',
  trustScore: 100,
  lastActivityAt: new Date('2026-01-01'),
};

const mockNewSession = {
  id: 'session-new',
  serverId: SERVER_ID,
  serverUserId: 'server-user-1',
  sessionKey: '42',
  ratingKey: '1002',
  startedAt: new Date(),
  lastPausedAt: null,
  pausedDurationMs: null,
  referenceId: null,
  watched: false,
};

const mockActiveSession = {
  id: 'session-new',
  serverId: SERVER_ID,
  serverUserId: 'server-user-1',
  sessionKey: '42',
  ratingKey: '1002',
  state: 'playing',
  mediaTitle: 'Episode 2',
};

// ============================================================================
// Mock cache and pubsub services
// ============================================================================

const mockCacheService = {
  getAllActiveSessions: vi.fn().mockResolvedValue([]),
  getSessionById: vi.fn(),
  addActiveSession: vi.fn(),
  updateActiveSession: vi.fn(),
  removeActiveSession: vi.fn(),
  withSessionCreateLock: vi.fn(),
  hasTerminationCooldown: vi.fn().mockResolvedValue(false),
  setTerminationCooldown: vi.fn(),
  getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
  clearTerminationCooldownsComposite: vi.fn(),
  setTerminationCooldownComposite: vi.fn(),
  // Pending session methods for delayed rule evaluation
  getPendingSession: vi.fn().mockResolvedValue(null),
  setPendingSession: vi.fn(),
  deletePendingSession: vi.fn(),
  getAllPendingSessionKeys: vi.fn().mockResolvedValue([]),
};

const mockPubSubService = {
  publish: vi.fn(),
  subscribe: vi.fn(),
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Faithful DB-shaped stub for findActiveSession: a same-sessionKey lookup
 * returns the row; adding a non-null incoming ratingKey that differs from the
 * row returns null (exactly what the real query does). handlePlaying passing
 * the incoming ratingKey here is the bug under test.
 */
function stubFaithfulFindActiveSession(row: { ratingKey: string | null }) {
  mockFindActiveSession.mockImplementation(async (identity: { ratingKey?: string | null }) => {
    if (identity.ratingKey != null && identity.ratingKey !== row.ratingKey) {
      return null;
    }
    return row;
  });
}

/**
 * Set up mocks for fetchFullSession to return a valid session + server
 */
function setupFetchFullSession(processed: Record<string, unknown> = mockProcessedSession) {
  const mockGetSessions = vi.fn().mockResolvedValue([processed]);
  mockCreateMediaServerClient.mockReturnValue(fakePlexClient({ getSessions: mockGetSessions }));

  // Mock db.select().from(servers).where().limit() chain
  const limitFn = vi.fn().mockResolvedValue([mockServer]);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.select.mockReturnValue({ from: fromFn });
}

/**
 * Set up mocks for the server user DB query inside handleMediaChange
 */
function setupServerUserQuery() {
  mockLoadEvaluationServerUser.mockResolvedValue(mockServerUser);

  // getIdentityServerUserIds: db.select({...}).from(serverUsers).where() (no join, no limit)
  const identityWhereFn = vi.fn().mockResolvedValue([mockServerUser]);
  const identityFromFn = vi.fn().mockReturnValue({ where: identityWhereFn });

  // Track call count — first call is fetchFullSession (servers), the rest is
  // getIdentityServerUserIds
  let callCount = 0;
  const mockGetSessions = vi.fn().mockResolvedValue([mockProcessedSession]);
  mockCreateMediaServerClient.mockReturnValue(fakePlexClient({ getSessions: mockGetSessions }));

  mockDb.select.mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // fetchFullSession: db.select().from(servers).where().limit()
      const serverLimitFn = vi.fn().mockResolvedValue([mockServer]);
      const serverWhereFn = vi.fn().mockReturnValue({ limit: serverLimitFn });
      const serverFromFn = vi.fn().mockReturnValue({ where: serverWhereFn });
      return { from: serverFromFn };
    }
    // getIdentityServerUserIds: db.select({...}).from(serverUsers).where()
    return { from: identityFromFn };
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('SSE Processor - Media Change Detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSseManager.removeAllListeners();
    // clearAllMocks wipes call history but not implementations, so restore the
    // matching-user default here; the sessionKey-reuse tests override it.
    mockGetServerUserIdByExternalId.mockResolvedValue('server-user-1');

    initializeSSEProcessor(mockCacheService as never, mockPubSubService as never);
    startSSEProcessor();
  });

  afterEach(() => {
    stopSSEProcessor();
    clearDbWriteTracking('twin-session-1');
  });

  it('routes a real next-episode transition (same sessionKey, new ratingKey) through handleMediaChangeAtomic', async () => {
    setupServerUserQuery();
    stubFaithfulFindActiveSession(mockExistingSession);
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: {
        id: 'session-old',
        serverUserId: 'server-user-1',
        sessionKey: '42',
      },
      insertedSession: mockNewSession,
      violationResults: [],
    });
    mockBuildActiveSession.mockReturnValue(mockActiveSession);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockHandleMediaChangeAtomic).toHaveBeenCalledTimes(1);
    });

    const input = mockHandleMediaChangeAtomic.mock.calls[0]![0] as {
      existingSession: { id: string; ratingKey: string };
      processed: { ratingKey: string };
    };
    expect(input.existingSession.id).toBe('session-old');
    expect(input.existingSession.ratingKey).toBe('1001');
    expect(input.processed.ratingKey).toBe('1002');

    // Should have stopped old session in cache
    expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith('session-old');

    // Should have broadcast stop for old session
    expect(mockPubSubService.publish).toHaveBeenCalledWith('session:stopped', 'session-old');

    // Should have added new session to cache
    expect(mockCacheService.addActiveSession).toHaveBeenCalledWith(mockActiveSession);

    // Should have broadcast start for new session
    expect(mockPubSubService.publish).toHaveBeenCalledWith('session:started', mockActiveSession);

    // The automations own the notification now; the media change enqueues nothing.
    expect(mockEnqueueNotification).not.toHaveBeenCalled();
  });

  it('does not trigger media change for same ratingKey', async () => {
    const sameKeyProcessed = { ...mockProcessedSession, ratingKey: '1001' };
    setupFetchFullSession(sameKeyProcessed);
    stubFaithfulFindActiveSession(mockExistingSession);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 5000 },
    });

    // updateExistingSession is reached and touches the stubbed pause helper;
    // wait on the lookup so the handler has run past the decision point.
    await vi.waitFor(() => {
      expect(mockFindActiveSession).toHaveBeenCalled();
    });

    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
  });

  it('handles null ratingKeys gracefully (no false positive)', async () => {
    const sessionWithNullRating = { ...mockExistingSession, ratingKey: null };
    setupFetchFullSession({ ...mockProcessedSession, ratingKey: null });
    stubFaithfulFindActiveSession(sessionWithNullRating);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockFindActiveSession).toHaveBeenCalled();
    });

    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
  });

  it('updates cache and broadcasts for both old and new sessions', async () => {
    setupServerUserQuery();
    stubFaithfulFindActiveSession(mockExistingSession);
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: {
        id: 'session-old',
        serverUserId: 'server-user-1',
        sessionKey: '42',
      },
      insertedSession: mockNewSession,
      violationResults: [],
    });
    mockBuildActiveSession.mockReturnValue(mockActiveSession);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockCacheService.addActiveSession).toHaveBeenCalledTimes(1);
    });

    // Verify the order: remove old, then add new
    const removeCall = mockCacheService.removeActiveSession.mock.invocationCallOrder[0]!;
    const addCall = mockCacheService.addActiveSession.mock.invocationCallOrder[0]!;
    expect(removeCall).toBeLessThan(addCall);

    // Verify pubsub events in order: stopped before started
    const publishCalls = mockPubSubService.publish.mock.calls as [string, unknown][];
    const stoppedIdx = publishCalls.findIndex(([event]) => event === 'session:stopped');
    const startedIdx = publishCalls.findIndex(([event]) => event === 'session:started');
    expect(stoppedIdx).toBeLessThan(startedIdx);
  });

  it('evaluates rules on the new session and broadcasts violations', async () => {
    const mockViolations = [
      { type: 'concurrent_streams', ruleId: 'rule-1', sessionId: 'session-new' },
    ];

    setupServerUserQuery();
    stubFaithfulFindActiveSession(mockExistingSession);
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: {
        id: 'session-old',
        serverUserId: 'server-user-1',
        sessionKey: '42',
      },
      insertedSession: mockNewSession,
      violationResults: mockViolations,
    });
    mockBuildActiveSession.mockReturnValue(mockActiveSession);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockBroadcastViolations).toHaveBeenCalledTimes(1);
    });

    expect(mockBroadcastViolations).toHaveBeenCalledWith(
      mockViolations,
      expect.objectContaining({ id: 'session-new' }),
      mockPubSubService
    );
  });

  it('handles null result from handleMediaChangeAtomic (race condition)', async () => {
    setupServerUserQuery();
    stubFaithfulFindActiveSession(mockExistingSession);
    mockHandleMediaChangeAtomic.mockResolvedValue(null);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockHandleMediaChangeAtomic).toHaveBeenCalledTimes(1);
    });

    // Should not update cache or broadcast when result is null
    expect(mockCacheService.removeActiveSession).not.toHaveBeenCalled();
    expect(mockCacheService.addActiveSession).not.toHaveBeenCalled();
    expect(mockPubSubService.publish).not.toHaveBeenCalled();
  });

  it('does not route a different user through media change when Plex reuses a stale sessionKey', async () => {
    // Plex resets sessionKey counters on PMS restart, so a stale open row from
    // user A can carry the same sessionKey a new play from user B now uses.
    // Different ratingKey would otherwise route to a cross-user media change
    // that attributes B's play to A.
    const staleRowUserA = {
      ...mockExistingSession,
      serverUserId: 'server-user-A',
      ratingKey: '1001',
    };
    setupFetchFullSession(mockProcessedSession); // ratingKey 1002, externalUserId plex-user-1
    stubFaithfulFindActiveSession(staleRowUserA);
    mockGetServerUserIdByExternalId.mockResolvedValue('server-user-B');

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(
      () => {
        expect(mockGetServerUserIdByExternalId).toHaveBeenCalled();
      },
      { timeout: 2000 }
    );

    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
  });

  it('does not write a different user into a stale same-content row on sessionKey reuse', async () => {
    const staleRowUserA = {
      ...mockExistingSession,
      serverUserId: 'server-user-A',
      ratingKey: '1001',
    };
    // Same ratingKey as the stale row: without the guard this writes B's
    // progress/state into A's row through updateExistingSession.
    setupFetchFullSession({ ...mockProcessedSession, ratingKey: '1001' });
    stubFaithfulFindActiveSession(staleRowUserA);
    mockGetServerUserIdByExternalId.mockResolvedValue('server-user-B');

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 5000 },
    });

    await vi.waitFor(
      () => {
        expect(mockGetServerUserIdByExternalId).toHaveBeenCalled();
      },
      { timeout: 2000 }
    );

    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('cleans up the quality-change twin when the media change lands on already-tracked content', async () => {
    const twinId = 'twin-session-1';
    recordDbWrite(twinId, Date.now());
    expect(shouldFlushDbWrite(twinId, Date.now())).toBe(false);

    setupServerUserQuery();
    stubFaithfulFindActiveSession(mockExistingSession);
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: {
        id: 'session-old',
        serverUserId: 'server-user-1',
        sessionKey: '42',
      },
      insertedSession: mockNewSession,
      violationResults: [],
      wasTerminatedByRule: false,
      qualityChange: {
        stoppedSession: {
          id: twinId,
          serverUserId: 'server-user-1',
          sessionKey: 'twin-key',
          deviceId: 'device-1',
          ratingKey: '1002',
        },
        referenceId: twinId,
      },
    });
    mockBuildActiveSession.mockReturnValue(mockActiveSession);

    mockSseManager.emit('plex:session:playing', {
      serverId: SERVER_ID,
      notification: { sessionKey: '42', viewOffset: 0 },
    });

    await vi.waitFor(() => {
      expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith(twinId);
    });

    expect(mockPubSubService.publish).toHaveBeenCalledWith('session:stopped', twinId);
    expect(shouldFlushDbWrite(twinId, Date.now())).toBe(true);
  });
});
