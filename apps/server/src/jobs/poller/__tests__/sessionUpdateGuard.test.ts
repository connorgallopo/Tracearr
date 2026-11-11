/**
 * Session Resurrection Guard Tests (poller)
 *
 * An SSE stop landing between the tick's batch read and the poller's update
 * write must not resurrect the session: the update has to carry a liveness
 * condition, and a zero-row result must not be pushed into updatedSessions
 * (the cache would otherwise show a stopped session as active, and the next
 * tick mints a duplicate DB row for it).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCreateMediaServerClient,
  mockMapMediaSession,
  mockBuildActiveSession,
  mockBatchFindActiveSessionsByComposite,
  mockFindActiveSession,
  mockProcessPollResults,
  mockDb,
  mockUpdateWhere,
} = vi.hoisted(() => {
  /** Thenable query-chain stub: chained calls return itself, awaiting resolves to `result`. */
  function chainResolving(result: unknown[]) {
    const obj: Record<string, unknown> = {};
    obj.where = () => obj;
    obj.innerJoin = () => obj;
    obj.limit = () => obj;
    obj.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    obj.catch = (reject: (e: unknown) => void) => Promise.resolve(result).catch(reject);
    return obj;
  }

  const mockServerRow = {
    id: 'server-1',
    name: 'Test Server',
    type: 'jellyfin',
    url: 'http://localhost:8096',
    token: 'test-token',
  };

  const mockServerUserRow = {
    id: 'server-user-1',
    userId: 'identity-1',
    serverId: 'server-1',
    externalId: 'user-123',
    username: 'alice',
    email: null,
    thumbUrl: null,
    isServerAdmin: false,
    trustScore: 100,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    identityName: 'Alice',
  };

  const updateWhere = vi.fn().mockResolvedValue([]);

  return {
    mockCreateMediaServerClient: vi.fn(),
    mockMapMediaSession: vi.fn(),
    mockBuildActiveSession: vi.fn(),
    mockBatchFindActiveSessionsByComposite: vi.fn(),
    mockFindActiveSession: vi.fn().mockResolvedValue(null),
    mockProcessPollResults: vi.fn().mockResolvedValue(undefined),
    mockUpdateWhere: updateWhere,
    mockDb: {
      select: vi.fn((columns?: unknown) => ({
        from: vi.fn(() => {
          if (columns === undefined) return chainResolving([mockServerRow]);
          const obj: Record<string, unknown> = {
            where: () => obj,
            orderBy: () => obj,
            limit: () => obj,
          };
          obj.innerJoin = () => chainResolving([mockServerUserRow]);
          obj.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
            Promise.resolve([]).then(resolve, reject);
          return obj;
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: updateWhere })),
        })),
      })),
    },
  };
});

const { mockDispatch } = vi.hoisted(() => ({
  mockDispatch: vi.fn().mockResolvedValue({ violations: [], outcomes: [] }),
}));

vi.mock('../../../services/leaderLease.js', () => ({
  isLeader: () => true,
}));

vi.mock('../../../db/client.js', () => ({ db: mockDb }));
vi.mock('../../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));
vi.mock('../../../serverState.js', () => ({ isMaintenance: vi.fn().mockReturnValue(false) }));
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
  sseManager: { isInFallback: vi.fn().mockReturnValue(false), nudgeReconnect: vi.fn() },
}));
vi.mock('../../notificationQueue.js', () => ({ enqueueNotification: vi.fn() }));
vi.mock('../database.js', () => ({
  onActiveAutomationsRefill: vi.fn(),
  getActiveAutomations: vi.fn().mockResolvedValue([]),
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../pendingConfirmation.js', () => ({ updatePendingSession: vi.fn() }));
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: mockBatchFindActiveSessionsByComposite,
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: mockBuildActiveSession,
  buildPendingActiveSession: vi.fn(),
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: mockFindActiveSession,
  findActiveSessionByComposite: vi.fn().mockResolvedValue(null),
  handleMediaChangeAtomic: vi.fn(),
  processPollResults: mockProcessPollResults,
  stopSessionAtomic: vi.fn(),
}));
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: mockDispatch,
  subscribe: vi.fn(),
}));
vi.mock('../sessionMapper.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mapMediaSession: mockMapMediaSession,
}));
vi.mock('../violations.js', () => ({ broadcastViolations: vi.fn() }));

import { initializePoller, triggerServerPoll } from '../processor.js';
import { getActiveAutomations } from '../database.js';
import { fakeJellyfinClient } from '../../../test/mediaServerFakes.js';

const EXISTING_SESSION_ID = 'session-1';

function existingSessionRow(overrides: Record<string, unknown> = {}) {
  const startedAt = new Date(Date.now() - 60_000);
  return {
    id: EXISTING_SESSION_ID,
    serverId: 'server-1',
    serverUserId: 'server-user-1',
    sessionKey: 'sess-key-1',
    ratingKey: '1001',
    deviceId: 'device-1',
    ipAddress: '1.2.3.4',
    state: 'playing',
    startedAt,
    lastPausedAt: null,
    pausedDurationMs: 0,
    watched: true, // already watched: skips the watch-completion recompute branch
    totalDurationMs: 3_600_000,
    progressMs: 10_000,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    isTranscode: false,
    sourceVideoCodec: null,
    sourceAudioCodec: null,
    geoCity: null,
    geoRegion: null,
    geoCountry: null,
    geoContinent: null,
    geoPostal: null,
    geoLat: null,
    geoLon: null,
    geoAsnNumber: null,
    geoAsnOrganization: null,
    stoppedAt: null,
    ...overrides,
  };
}

function processedSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: 'sess-key-1',
    ratingKey: '1001',
    externalUserId: 'user-123',
    username: 'alice',
    userThumb: '',
    mediaTitle: 'Test Movie',
    mediaType: 'movie',
    state: 'paused',
    ipAddress: '1.2.3.4',
    deviceId: 'device-1',
    quality: '1080p',
    bitrate: 5000,
    progressMs: 20_000,
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    plexSessionId: undefined,
    totalDurationMs: 3_600_000,
    sourceVideoCodec: null,
    sourceAudioCodec: null,
    ...overrides,
  };
}

const cachedActiveSession = {
  id: EXISTING_SESSION_ID,
  serverId: 'server-1',
  serverUserId: 'server-user-1',
  sessionKey: 'sess-key-1',
  ratingKey: '1001',
  deviceId: 'device-1',
};

describe('poller session update guard against stop races', () => {
  let cacheService: {
    getAllActiveSessions: ReturnType<typeof vi.fn>;
    getPendingSession: ReturnType<typeof vi.fn>;
    withSessionCreateLock: ReturnType<typeof vi.fn>;
    hasTerminationCooldown: ReturnType<typeof vi.fn>;
    getTerminationCooldownsComposite: ReturnType<typeof vi.fn>;
    clearTerminationCooldownsComposite: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateWhere.mockResolvedValue([]);

    mockCreateMediaServerClient.mockReturnValue(
      fakeJellyfinClient({
        getSessions: vi.fn().mockResolvedValue([{}]),
      })
    );
    mockMapMediaSession.mockReturnValue(processedSession());
    mockBuildActiveSession.mockReturnValue({ id: EXISTING_SESSION_ID, sessionKey: 'sess-key-1' });
    mockBatchFindActiveSessionsByComposite.mockResolvedValue(
      new Map([[`server-user-1::1001`, [existingSessionRow()]]])
    );

    cacheService = {
      getAllActiveSessions: vi.fn().mockResolvedValue([cachedActiveSession]),
      getPendingSession: vi.fn().mockResolvedValue(null),
      withSessionCreateLock: vi.fn().mockImplementation(async (_s, _k, op) => op()),
      hasTerminationCooldown: vi.fn().mockResolvedValue(false),
      getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
      clearTerminationCooldownsComposite: vi.fn(),
    };

    initializePoller(
      cacheService as unknown as Parameters<typeof initializePoller>[0],
      { publish: vi.fn(), subscribe: vi.fn() } as unknown as Parameters<typeof initializePoller>[1]
    );
  });

  it('does not push a resurrected session when the update affects zero rows', async () => {
    mockUpdateWhere.mockResolvedValue([]); // update raced a concurrent stop

    await triggerServerPoll('server-1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockProcessPollResults).not.toHaveBeenCalled();
  });

  it('pushes the updated session normally when the update affects a row', async () => {
    mockUpdateWhere.mockResolvedValue([{ id: EXISTING_SESSION_ID }]);

    await triggerServerPoll('server-1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockProcessPollResults).toHaveBeenCalledTimes(1);
    const call = mockProcessPollResults.mock.calls[0]?.[0];
    expect(call.updatedSessions).toHaveLength(1);
    expect(call.updatedSessions[0].id).toBe(EXISTING_SESSION_ID);
  });

  it('does not re-evaluate transcode rules when the update raced a concurrent stop', async () => {
    mockUpdateWhere.mockResolvedValue([]); // update raced a concurrent stop
    vi.mocked(getActiveAutomations).mockResolvedValue([{ id: 'rule-1' }] as unknown as Awaited<
      ReturnType<typeof getActiveAutomations>
    >);
    mockMapMediaSession.mockReturnValue(
      processedSession({ state: 'playing', videoDecision: 'transcode', isTranscode: true })
    );

    await triggerServerPoll('server-1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('re-evaluates transcode rules when the update affects a row', async () => {
    mockUpdateWhere.mockResolvedValue([{ id: EXISTING_SESSION_ID }]);
    vi.mocked(getActiveAutomations).mockResolvedValue([{ id: 'rule-1' }] as unknown as Awaited<
      ReturnType<typeof getActiveAutomations>
    >);
    mockMapMediaSession.mockReturnValue(
      processedSession({ state: 'playing', videoDecision: 'transcode', isTranscode: true })
    );

    await triggerServerPoll('server-1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0]?.[0]).toMatchObject({ type: 'session.transcode_changed' });
  });
});

describe('poller rediscovered-session guard against stop races', () => {
  let cacheService: {
    getAllActiveSessions: ReturnType<typeof vi.fn>;
    getPendingSession: ReturnType<typeof vi.fn>;
    withSessionCreateLock: ReturnType<typeof vi.fn>;
    hasTerminationCooldown: ReturnType<typeof vi.fn>;
    getTerminationCooldownsComposite: ReturnType<typeof vi.fn>;
    clearTerminationCooldownsComposite: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateWhere.mockResolvedValue([]);

    mockCreateMediaServerClient.mockReturnValue(
      fakeJellyfinClient({
        getSessions: vi.fn().mockResolvedValue([{}]),
      })
    );
    mockMapMediaSession.mockReturnValue(processedSession());
    mockBuildActiveSession.mockReturnValue({ id: EXISTING_SESSION_ID, sessionKey: 'sess-key-1' });
    mockFindActiveSession.mockResolvedValue(existingSessionRow());

    cacheService = {
      // Empty so the composite key isn't cached: forces the isNew branch,
      // which rediscovers the session via findActiveSession.
      getAllActiveSessions: vi.fn().mockResolvedValue([]),
      getPendingSession: vi.fn().mockResolvedValue(null),
      withSessionCreateLock: vi.fn().mockImplementation(async (_s, _k, op) => op()),
      hasTerminationCooldown: vi.fn().mockResolvedValue(false),
      getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
      clearTerminationCooldownsComposite: vi.fn(),
    };

    initializePoller(
      cacheService as unknown as Parameters<typeof initializePoller>[0],
      { publish: vi.fn(), subscribe: vi.fn() } as unknown as Parameters<typeof initializePoller>[1]
    );
  });

  it('does not push the rediscovered session when its lastSeenAt touch affects zero rows', async () => {
    mockUpdateWhere.mockResolvedValue([]); // update raced a concurrent stop

    await triggerServerPoll('server-1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockProcessPollResults).not.toHaveBeenCalled();
  });

  it('pushes the rediscovered session normally when the touch affects a row', async () => {
    mockUpdateWhere.mockResolvedValue([{ id: EXISTING_SESSION_ID }]);

    await triggerServerPoll('server-1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockProcessPollResults).toHaveBeenCalledTimes(1);
    const call = mockProcessPollResults.mock.calls[0]?.[0];
    expect(call.updatedSessions).toHaveLength(1);
    expect(call.updatedSessions[0].id).toBe(EXISTING_SESSION_ID);
  });

  it('keeps a rediscovered paused row paused while Plex reports buffering', async () => {
    mockUpdateWhere.mockResolvedValue([{ id: EXISTING_SESSION_ID }]);
    mockFindActiveSession.mockResolvedValue(existingSessionRow({ state: 'paused' }));
    mockMapMediaSession.mockReturnValue(processedSession({ state: 'playing', buffering: true }));

    await triggerServerPoll('server-1');

    expect(mockBuildActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: expect.objectContaining({ state: 'paused' }) })
    );
  });
});
