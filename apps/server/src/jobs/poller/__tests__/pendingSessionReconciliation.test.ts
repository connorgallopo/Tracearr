/**
 * Poller Pending-Session Reconciliation Tests
 *
 * Tests for the isNew branch's pending-session check:
 * - Confirms a pending session with its preGeneratedId instead of duplicating it
 * - Leaves the session pending when still below the confirmation threshold
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PendingSessionData } from '../types.js';
import type {
  EngineAutomation,
  Session,
  ServerUser,
  Server as MediaServer,
} from '@tracearr/shared';

const {
  mockSseManager,
  mockEnqueueNotification,
  mockCreateMediaServerClient,
  mockMapMediaSession,
  mockUpdatePendingSession,
  mockConfirmAndPersistSession,
  mockBuildActiveSession,
  mockBuildPendingActiveSession,
  mockFindActiveSession,
  mockProcessPollResults,
  mockHandleQualityChangeFallout,
  mockDb,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');

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
    type: 'plex',
    url: 'http://localhost:32400',
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

  return {
    mockSseManager: Object.assign(new EventEmitter(), {
      isInFallback: vi.fn().mockReturnValue(false),
      nudgeReconnect: vi.fn(),
    }),
    mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
    mockCreateMediaServerClient: vi.fn(),
    mockMapMediaSession: vi.fn(),
    mockUpdatePendingSession: vi.fn(),
    mockConfirmAndPersistSession: vi.fn(),
    mockBuildActiveSession: vi.fn(),
    mockBuildPendingActiveSession: vi.fn(),
    mockFindActiveSession: vi.fn().mockResolvedValue(null),
    mockProcessPollResults: vi.fn().mockResolvedValue(undefined),
    mockHandleQualityChangeFallout: vi.fn().mockResolvedValue(undefined),
    mockDb: {
      // Server lookup calls select() with no column argument. The server-user
      // join query and the plex duplicate-content check both pass columns, so
      // they're told apart by whether innerJoin() is used (only the former does).
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
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    },
  };
});

vi.mock('../../../services/leaderLease.js', () => ({
  isLeader: () => true,
}));

vi.mock('../../../db/client.js', () => ({ db: mockDb }));
// Real rule engine used directly (not through the mocked sessionLifecycle.js) to prove the
// concurrent_streams consequence of the fix below, not just that an array got longer.
vi.mock('../../../services/geoip.js', () => ({
  geoipService: { isPrivateIP: () => false },
}));
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
vi.mock('../../../services/sseManager.js', () => ({ sseManager: mockSseManager }));
vi.mock('../../notificationQueue.js', () => ({ enqueueNotification: mockEnqueueNotification }));
vi.mock('../database.js', () => ({
  onActiveAutomationsRefill: vi.fn(),
  getActiveAutomations: vi.fn().mockResolvedValue([]),
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../pendingConfirmation.js', () => ({ updatePendingSession: mockUpdatePendingSession }));
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: mockBuildActiveSession,
  buildPendingActiveSession: mockBuildPendingActiveSession,
  confirmAndPersistSession: mockConfirmAndPersistSession,
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: mockFindActiveSession,
  findActiveSessionByComposite: vi.fn().mockResolvedValue(null),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: mockHandleQualityChangeFallout,
  processPollResults: mockProcessPollResults,
  stopSessionAtomic: vi.fn(),
}));
const mockDispatch = vi.fn().mockResolvedValue({ violations: [], outcomes: [] });
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));
vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: mockMapMediaSession,
  pickStreamDetailFields: vi.fn().mockImplementation((s: unknown) => s),
}));
vi.mock('../violations.js', () => ({ broadcastViolations: vi.fn() }));

import { initializePoller, triggerServerPoll } from '../processor.js';
import { evaluateRulesAsync } from '../../../services/automations/engine.js';
import { fakePlexClient } from '../../../test/mediaServerFakes.js';

mockCreateMediaServerClient.mockReturnValue(
  fakePlexClient({ getSessions: vi.fn().mockResolvedValue([{}]) })
);

function createPendingSessionData(): PendingSessionData {
  const now = Date.now();
  return {
    id: 'pending-uuid-123',
    confirmation: {
      confirmedPlayback: false,
      firstSeenAt: now - 31000,
      maxViewOffset: 31000,
      initialViewOffset: 1000,
    },
    processed: {
      sessionKey: 'test-session-key',
      ratingKey: '12345',
      externalUserId: 'user-123',
      username: 'alice',
      state: 'playing',
    } as PendingSessionData['processed'],
    server: { id: 'server-1', name: 'Test Server', type: 'plex' },
    serverUser: {
      id: 'server-user-1',
      userId: 'identity-1',
      username: 'alice',
      thumbUrl: null,
      identityName: 'Alice',
      trustScore: 100,
      lastActivityAt: new Date(),
      createdAt: new Date(),
      identityServerUserIds: ['server-user-1'],
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
    startedAt: now - 31000,
    lastSeenAt: now,
    currentState: 'playing',
    pausedDurationMs: 0,
    lastPausedAt: null,
  };
}

describe('poller isNew branch defers to a pending session', () => {
  let cacheService: {
    getAllActiveSessions: ReturnType<typeof vi.fn>;
    getPendingSession: ReturnType<typeof vi.fn>;
    deletePendingSession: ReturnType<typeof vi.fn>;
    setPendingSession: ReturnType<typeof vi.fn>;
    withSessionCreateLock: ReturnType<typeof vi.fn>;
    hasTerminationCooldown: ReturnType<typeof vi.fn>;
    getTerminationCooldownsComposite: ReturnType<typeof vi.fn>;
    clearTerminationCooldownsComposite: ReturnType<typeof vi.fn>;
    addActiveSession: ReturnType<typeof vi.fn>;
    addUserSession: ReturnType<typeof vi.fn>;
    removeActiveSession: ReturnType<typeof vi.fn>;
    removeUserSession: ReturnType<typeof vi.fn>;
  };
  let pubSubService: { publish: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockMapMediaSession.mockReturnValue({
      sessionKey: 'test-session-key',
      ratingKey: '12345',
      externalUserId: 'user-123',
      username: 'alice',
      userThumb: '',
      mediaTitle: 'Test Movie',
      mediaType: 'movie',
      state: 'playing',
      ipAddress: '1.2.3.4',
      deviceId: 'device-1',
    });

    cacheService = {
      getAllActiveSessions: vi.fn().mockResolvedValue([]),
      getPendingSession: vi
        .fn()
        .mockImplementation(async (_serverId: string, key: string) =>
          key === 'test-session-key' ? createPendingSessionData() : null
        ),
      deletePendingSession: vi.fn(),
      setPendingSession: vi.fn(),
      withSessionCreateLock: vi.fn().mockImplementation(async (_s, _k, op) => op()),
      hasTerminationCooldown: vi.fn().mockResolvedValue(false),
      getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
      clearTerminationCooldownsComposite: vi.fn(),
      addActiveSession: vi.fn(),
      addUserSession: vi.fn(),
      removeActiveSession: vi.fn(),
      removeUserSession: vi.fn(),
    };

    pubSubService = { publish: vi.fn(), subscribe: vi.fn() };
    initializePoller(
      cacheService as unknown as Parameters<typeof initializePoller>[0],
      pubSubService as unknown as Parameters<typeof initializePoller>[1]
    );
  });

  it('confirms the pending session through confirmAndPersistSession with corrected startedAt', async () => {
    const pendingSessionData = createPendingSessionData();
    mockUpdatePendingSession.mockReturnValue({
      updatedData: pendingSessionData,
      isConfirmed: true,
    });

    const insertedGeo = { city: 'Chicago', country: 'US', isLocal: true };
    mockConfirmAndPersistSession.mockResolvedValue({
      insertedSession: { id: 'pending-uuid-123', sessionKey: 'test-session-key' },
      violationResults: [],
      qualityChange: null,
      referenceId: null,
      wasTerminatedByRule: false,
      geo: insertedGeo,
    });

    mockBuildActiveSession.mockReturnValue({
      id: 'pending-uuid-123',
      serverId: 'server-1',
      sessionKey: 'test-session-key',
    });

    await triggerServerPoll('server-1');

    expect(mockConfirmAndPersistSession).toHaveBeenCalledTimes(1);
    const call = mockConfirmAndPersistSession.mock.calls[0]?.[0] as {
      pendingData: PendingSessionData;
    };
    expect(call.pendingData.id).toBe('pending-uuid-123');
    // startedAt is the pending session's own creation time (31s ago), never the
    // confirm tick's Date.now() - that's the bug this routing closes.
    expect(call.pendingData.startedAt).toBe(pendingSessionData.startedAt);
    expect(call.pendingData.confirmation.maxViewOffset).toBe(
      pendingSessionData.confirmation.maxViewOffset
    );

    expect(cacheService.deletePendingSession).toHaveBeenCalledWith('server-1', 'test-session-key');
    expect(mockBuildActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ geo: insertedGeo })
    );

    expect(mockProcessPollResults).toHaveBeenCalledTimes(1);
    const pollCall = mockProcessPollResults.mock.calls[0]?.[0];
    expect(pollCall.newSessions).toHaveLength(1);
    expect(pollCall.newSessions[0].id).toBe('pending-uuid-123');
  });

  it('runs quality-change fallout for the stopped twin when confirming a pending session', async () => {
    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: true,
    });

    const qualityChange = {
      stoppedSession: {
        id: 'twin-session-id',
        serverUserId: 'server-user-1',
        sessionKey: 'twin-session-key',
        deviceId: 'device-1',
        ratingKey: '12345',
      },
      referenceId: 'twin-session-id',
    };

    mockConfirmAndPersistSession.mockResolvedValue({
      insertedSession: { id: 'pending-uuid-123', sessionKey: 'test-session-key' },
      violationResults: [],
      qualityChange,
      referenceId: 'twin-session-id',
      wasTerminatedByRule: false,
    });

    mockBuildActiveSession.mockReturnValue({
      id: 'pending-uuid-123',
      serverId: 'server-1',
      sessionKey: 'test-session-key',
    });

    await triggerServerPoll('server-1');

    expect(mockHandleQualityChangeFallout).toHaveBeenCalledWith(
      qualityChange,
      cacheService,
      expect.objectContaining({ publish: expect.any(Function) })
    );
  });

  it('keeps the session pending and does not create anything when still below threshold', async () => {
    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: false,
    });

    await triggerServerPoll('server-1');

    expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
    expect(cacheService.setPendingSession).toHaveBeenCalledTimes(1);
    expect(cacheService.deletePendingSession).not.toHaveBeenCalled();
  });

  it('bails out of the fallback create path when a pending session appears inside the lock', async () => {
    // Pre-check (outside the lock) sees nothing; the check re-run as the first
    // statement inside the lock finds a pending session SSE created in the gap.
    let getPendingSessionCalls = 0;
    cacheService.getPendingSession = vi.fn(async (_serverId: string, key: string) => {
      if (key !== 'test-session-key') return null;
      getPendingSessionCalls++;
      return getPendingSessionCalls === 1 ? null : createPendingSessionData();
    });

    await triggerServerPoll('server-1');

    expect(getPendingSessionCalls).toBeGreaterThanOrEqual(2);
    expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
    expect(mockProcessPollResults).not.toHaveBeenCalled();
  });

  it("bails out cleanly when the pending session is confirmed by another process inside resolvePendingSession's own lock", async () => {
    // First read (before the lock) sees the pending session and confirms it.
    // SSE fully confirms and creates the same session in the gap before the
    // lock is acquired, so the re-check inside the lock finds it gone.
    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: true,
    });

    let getPendingSessionCalls = 0;
    cacheService.getPendingSession = vi.fn(async (_serverId: string, key: string) => {
      if (key !== 'test-session-key') return null;
      getPendingSessionCalls++;
      return getPendingSessionCalls === 1 ? createPendingSessionData() : null;
    });

    await expect(triggerServerPoll('server-1')).resolves.not.toThrow();

    expect(getPendingSessionCalls).toBeGreaterThanOrEqual(2);
    expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
    expect(cacheService.deletePendingSession).not.toHaveBeenCalled();
    // Nothing new/updated/stopped for this session this tick, so processPollResults
    // is skipped entirely (same as the sibling "confirmed by other" path above).
    expect(mockProcessPollResults).not.toHaveBeenCalled();
  });

  it('deletes the stale pending entry when the in-lock existingById check finds the row already persisted', async () => {
    // Pending stays present through both reads, but a concurrent caller already
    // wrote the row for this pre-generated id. The in-lock existingById check
    // finds it and bails without creating a duplicate. The pending entry must
    // still be dropped here, or the orphan sweep later phantom-stops the live
    // row this pending id points at.
    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: true,
    });

    const mockServerRow = {
      id: 'server-1',
      name: 'Test Server',
      type: 'plex',
      url: 'http://localhost:32400',
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

    // Override the DB so the in-lock existingById lookup (a columns query with
    // no innerJoin) resolves a row for the pre-generated id.
    mockDb.select.mockImplementation((columns?: unknown) => ({
      from: vi.fn(() => {
        if (columns === undefined) {
          const s: Record<string, unknown> = {};
          s.where = () => s;
          s.limit = () => s;
          s.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
            Promise.resolve([mockServerRow]).then(res, rej);
          return s;
        }
        const o: Record<string, unknown> = {};
        o.where = () => o;
        o.limit = () => o;
        o.innerJoin = () => {
          const j: Record<string, unknown> = {};
          j.where = () => j;
          j.limit = () => j;
          j.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
            Promise.resolve([mockServerUserRow]).then(res, rej);
          return j;
        };
        o.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
          Promise.resolve([{ id: 'pending-uuid-123' }]).then(res, rej);
        return o;
      }),
    }));

    await triggerServerPoll('server-1');

    expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
    expect(cacheService.deletePendingSession).toHaveBeenCalledWith('server-1', 'test-session-key');
  });

  it('counts a pending confirm earlier in the same pass toward a later confirm in that pass', async () => {
    // Same user, two devices, both pending and both about to cross the
    // confirmation threshold on this single poll tick.
    let mapCallCount = 0;
    mockMapMediaSession.mockImplementation(() => {
      mapCallCount += 1;
      return {
        sessionKey: `test-session-key-${mapCallCount}`,
        ratingKey: `rating-${mapCallCount}`,
        externalUserId: 'user-123',
        username: 'alice',
        userThumb: '',
        mediaTitle: 'Test Movie',
        mediaType: 'movie',
        state: 'playing',
        ipAddress: '1.2.3.4',
        deviceId: `device-${mapCallCount}`,
      };
    });

    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({
        getSessions: vi.fn().mockResolvedValue([{}, {}]),
      })
    );

    // Restore the plain default (server lookup + single server user, no
    // existingById match) - mockImplementation from an earlier test in this
    // file survives vi.clearAllMocks(), which only resets calls, not impls.
    const mockServerRow = {
      id: 'server-1',
      name: 'Test Server',
      type: 'plex',
      url: 'http://localhost:32400',
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
    mockDb.select.mockImplementation((columns?: unknown) => ({
      from: vi.fn(() => {
        if (columns === undefined) {
          const s: Record<string, unknown> = {};
          s.where = () => s;
          s.limit = () => s;
          s.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
            Promise.resolve([mockServerRow]).then(res, rej);
          return s;
        }
        const o: Record<string, unknown> = {};
        o.where = () => o;
        o.limit = () => o;
        o.innerJoin = () => {
          const j: Record<string, unknown> = {};
          j.where = () => j;
          j.limit = () => j;
          j.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
            Promise.resolve([mockServerUserRow]).then(res, rej);
          return j;
        };
        o.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
          Promise.resolve([]).then(res, rej);
        return o;
      }),
    }));

    cacheService.getPendingSession = vi
      .fn()
      .mockImplementation(async (_serverId: string, key: string) => {
        if (key !== 'test-session-key-1' && key !== 'test-session-key-2') return null;
        return { ...createPendingSessionData(), id: `pending-uuid-${key.slice(-1)}` };
      });

    mockUpdatePendingSession.mockImplementation((pendingData: PendingSessionData) => ({
      updatedData: pendingData,
      isConfirmed: true,
    }));

    // mock.calls stores the live activeSessions array reference, which this fix mutates
    // in place after each confirm - snapshot it at call-time or both entries would read
    // back identically (the final, post-loop state) once the test inspects mock.calls.
    const activeSessionsSnapshots: unknown[][] = [];
    mockConfirmAndPersistSession.mockImplementation(
      async (input: {
        pendingData: { id: string; processed: { sessionKey: string } };
        activeSessions: unknown[];
      }) => {
        activeSessionsSnapshots.push([...input.activeSessions]);
        return {
          insertedSession: {
            id: input.pendingData.id,
            sessionKey: input.pendingData.processed.sessionKey,
          },
          violationResults: [],
          qualityChange: null,
          referenceId: null,
          wasTerminatedByRule: false,
        };
      }
    );

    mockBuildActiveSession.mockImplementation(
      (input: {
        session: { id: string; sessionKey: string };
        processed: { deviceId: string };
      }) => ({
        id: input.session.id,
        serverId: 'server-1',
        serverUserId: 'server-user-1',
        sessionKey: input.session.sessionKey,
        deviceId: input.processed.deviceId,
        ipAddress: '1.2.3.4',
      })
    );

    await triggerServerPoll('server-1');

    expect(mockConfirmAndPersistSession).toHaveBeenCalledTimes(2);
    const [firstActiveSessions, secondActiveSessions] = activeSessionsSnapshots;

    // The bug: the second confirm's snapshot never saw the first confirm from
    // the same pass. The fix appends each confirm to the snapshot as it happens.
    expect(firstActiveSessions).toHaveLength(0);
    expect(secondActiveSessions).toHaveLength(1);
    expect((secondActiveSessions![0] as { id: string }).id).toBe('pending-uuid-1');

    // Prove that difference is not cosmetic: it flips a concurrent_streams>=2 kill rule.
    const rule = {
      id: 'rule-1',
      name: 'Too many streams',
      description: null,
      serverId: null,
      serverUserId: null,
      userId: null,
      enforceAcrossServers: false,
      isActive: true,
      severity: 'high',
      conditions: {
        groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gte', value: 2 }] }],
      },
      actions: { actions: [{ type: 'kill_stream' }] },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as EngineAutomation;

    const serverUser = { id: 'server-user-1', serverId: 'server-1' } as unknown as ServerUser;
    const server = { id: 'server-1', type: 'plex' } as unknown as MediaServer;
    const secondSession = {
      id: 'pending-uuid-2',
      serverUserId: 'server-user-1',
      deviceId: 'device-2',
      ipAddress: '1.2.3.4',
    } as unknown as Session;

    const withoutFirstConfirm = await evaluateRulesAsync(
      {
        session: secondSession,
        serverUser,
        server,
        media: null,
        subjectKey: secondSession.id,
        activeSessions: [secondSession],
        recentSessions: [],
      },
      [rule]
    );
    // evaluateRulesAsync only returns matched rules, so no entry means no match.
    expect(withoutFirstConfirm).toHaveLength(0);

    const withFirstConfirm = await evaluateRulesAsync(
      {
        session: secondSession,
        serverUser,
        server,
        media: null,
        subjectKey: secondSession.id,
        activeSessions: [...secondActiveSessions!, secondSession] as unknown as Session[],
        recentSessions: [],
      },
      [rule]
    );
    expect(withFirstConfirm).toHaveLength(1);
    expect(withFirstConfirm[0]?.matched).toBe(true);
  });

  it('creates independent pending entries for two brand-new sessions in the same tick', async () => {
    // Same user, two devices, neither pending - both hit the isNew branch's
    // pending-create path. Confirmation (and rule evaluation) is deferred to
    // a later tick, so no same-pass accumulation applies to fresh creates
    // anymore - that only happens once each entry confirms individually.
    let mapCallCount = 0;
    mockMapMediaSession.mockImplementation(() => {
      mapCallCount += 1;
      return {
        sessionKey: `test-session-key-${mapCallCount}`,
        ratingKey: `rating-${mapCallCount}`,
        externalUserId: 'user-123',
        username: 'alice',
        userThumb: '',
        mediaTitle: 'Test Movie',
        mediaType: 'movie',
        state: 'playing',
        ipAddress: '1.2.3.4',
        deviceId: `device-${mapCallCount}`,
      };
    });

    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({
        getSessions: vi.fn().mockResolvedValue([{}, {}]),
      })
    );

    const mockServerRow = {
      id: 'server-1',
      name: 'Test Server',
      type: 'plex',
      url: 'http://localhost:32400',
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
    mockDb.select.mockImplementation((columns?: unknown) => ({
      from: vi.fn(() => {
        if (columns === undefined) {
          const s: Record<string, unknown> = {};
          s.where = () => s;
          s.limit = () => s;
          s.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
            Promise.resolve([mockServerRow]).then(res, rej);
          return s;
        }
        const o: Record<string, unknown> = {};
        o.where = () => o;
        o.limit = () => o;
        o.innerJoin = () => {
          const j: Record<string, unknown> = {};
          j.where = () => j;
          j.limit = () => j;
          j.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
            Promise.resolve([mockServerUserRow]).then(res, rej);
          return j;
        };
        // Plex duplicate-content check (no pending, no existing row for this content).
        o.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
          Promise.resolve([]).then(res, rej);
        return o;
      }),
    }));

    // Neither session is pending yet - both hit the isNew branch fresh.
    cacheService.getPendingSession = vi.fn().mockResolvedValue(null);
    mockBuildPendingActiveSession.mockImplementation((data: { id: string }) => ({
      id: data.id,
      pending: true,
    }));

    await triggerServerPoll('server-1');

    // No DB row, no rule evaluation for either session on first sight.
    expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
    expect(cacheService.setPendingSession).toHaveBeenCalledTimes(2);
    expect(cacheService.addActiveSession).toHaveBeenCalledTimes(2);

    // Each pending entry is keyed and persisted independently.
    const setPendingKeys = cacheService.setPendingSession.mock.calls.map((call) => call[1]);
    expect(setPendingKeys).toEqual(['test-session-key-1', 'test-session-key-2']);
    const pendingIds = cacheService.setPendingSession.mock.calls.map(
      (call) => (call[2] as { id: string }).id
    );
    expect(new Set(pendingIds).size).toBe(2);

    // Both display immediately - session:started fires for each, with no DB write.
    expect(pubSubService.publish).toHaveBeenCalledTimes(2);
    expect(pubSubService.publish).toHaveBeenCalledWith('session:started', expect.anything());
    // A pending entry is not a session yet; the automations fire at confirmation.
    expect(mockEnqueueNotification).not.toHaveBeenCalled();

    // Nothing goes through the batched new/updated/stopped pipeline this tick.
    expect(mockProcessPollResults).not.toHaveBeenCalled();
  });
});
