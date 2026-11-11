/**
 * Regression test: a pending session confirmed on the tick AFTER it was
 * created (its key is already in cachedSessionKeys from addActiveSession the
 * previous tick, so it reads as "not new" this tick) must still carry the
 * confirming user's prior session history into rule evaluation. Without the
 * lazy backfill, recentSessionsMap has no entry for that user this tick and
 * confirmAndPersistSession silently receives an empty array, blinding
 * unique_ips_in_window / unique_devices_in_window / travel_speed_kmh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActiveSession, Session } from '@tracearr/shared';
import type { PendingSessionData } from '../types.js';

const {
  mockCreateMediaServerClient,
  mockMapMediaSession,
  mockUpdatePendingSession,
  mockConfirmAndPersistSession,
  mockBatchFindActiveSessionsByKey,
  mockBatchGetRecentUserSessions,
  mockRequestSyncForUnknownKeys,
  mockDb,
} = vi.hoisted(() => {
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
    id: 'su-B',
    userId: 'identity-B',
    serverId: 'server-1',
    externalId: 'ext-1',
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
    mockRequestSyncForUnknownKeys: vi.fn(),
    mockCreateMediaServerClient: vi.fn(),
    mockMapMediaSession: vi.fn(),
    mockUpdatePendingSession: vi.fn(),
    mockConfirmAndPersistSession: vi.fn(),
    mockBatchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
    mockBatchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
    mockDb: {
      // Server lookup calls select() with no column argument. The server-user
      // join query and the "already persisted" existingById check both pass
      // columns, told apart by whether innerJoin() is used (only the former does).
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
vi.mock('../../../services/sseManager.js', () => ({
  sseManager: { isInFallback: vi.fn().mockReturnValue(false), nudgeReconnect: vi.fn() },
}));
vi.mock('../../notificationQueue.js', () => ({ enqueueNotification: vi.fn() }));
vi.mock('../../../services/libraryEventSync.js', () => ({
  requestSyncForUnknownKeys: mockRequestSyncForUnknownKeys,
}));
vi.mock('../database.js', () => ({
  onActiveAutomationsRefill: vi.fn(),
  getActiveAutomations: vi.fn().mockResolvedValue([]),
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: mockBatchGetRecentUserSessions,
  mergeRecentSessionsForIdentity: vi.fn(),
  widenRecentSessionsForMergedIdentities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../pendingConfirmation.js', () => ({ updatePendingSession: mockUpdatePendingSession }));
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: mockBatchFindActiveSessionsByKey,
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: vi.fn(),
  confirmAndPersistSession: mockConfirmAndPersistSession,
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: vi.fn().mockResolvedValue(null),
  findActiveSessionByComposite: vi.fn().mockResolvedValue(null),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  processPollResults: vi.fn().mockResolvedValue(undefined),
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
import { fakePlexClient } from '../../../test/mediaServerFakes.js';

mockCreateMediaServerClient.mockReturnValue(
  fakePlexClient({ getSessions: vi.fn().mockResolvedValue([{}]) })
);

function createPendingSessionData(): PendingSessionData {
  const now = Date.now();
  return {
    id: 'pending-uuid-1',
    confirmation: {
      confirmedPlayback: false,
      firstSeenAt: now - 31000,
      maxViewOffset: 31000,
      initialViewOffset: 1000,
    },
    processed: {
      sessionKey: 'sk-42',
      ratingKey: 'rk-1',
      externalUserId: 'ext-1',
      username: 'alice',
      state: 'playing',
    } as PendingSessionData['processed'],
    server: { id: 'server-1', name: 'Test Server', type: 'plex' },
    serverUser: {
      id: 'su-B',
      userId: 'identity-B',
      username: 'alice',
      thumbUrl: null,
      identityName: 'Alice',
      trustScore: 100,
      lastActivityAt: new Date(),
      createdAt: new Date(),
      identityServerUserIds: ['su-B'],
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

// This user's history from an earlier, already-stopped session on a different
// device/IP - exactly what unique_ips_in_window / unique_devices_in_window
// need to fire on the session now confirming.
const priorSession = {
  id: 'prior-session-id',
  serverId: 'server-1',
  serverUserId: 'su-B',
  sessionKey: 'sk-earlier',
  deviceId: 'device-other',
  ipAddress: '9.9.9.9',
  state: 'stopped',
  startedAt: new Date(Date.now() - 10 * 60 * 1000),
  stoppedAt: new Date(Date.now() - 5 * 60 * 1000),
} as unknown as Session;

// The pending session's key is already in the active cache from the previous
// tick's addActiveSession call - this is what makes it read as "not new" now.
const cachedPendingActiveSession = {
  id: 'pending-uuid-1',
  serverId: 'server-1',
  serverUserId: 'su-B',
  sessionKey: 'sk-42',
  deviceId: 'device-1',
  ratingKey: 'rk-1',
  pending: true,
} as unknown as ActiveSession;

describe('poller confirms a pending session with the confirming user recent-session history', () => {
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
      sessionKey: 'sk-42',
      ratingKey: 'rk-1',
      externalUserId: 'ext-1',
      username: 'alice',
      userThumb: '',
      mediaTitle: 'Test Movie',
      mediaType: 'movie',
      state: 'playing',
      ipAddress: '1.2.3.4',
      deviceId: 'device-1',
    });

    // Only resolves history for the user actually asked for - proves the
    // fetch really carries the confirming user's id, not a coincidental hit.
    mockBatchGetRecentUserSessions.mockImplementation(async (ids: string[]) => {
      if (ids.includes('su-B')) return new Map([['su-B', [priorSession]]]);
      return new Map();
    });

    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: true,
    });

    mockConfirmAndPersistSession.mockResolvedValue({
      insertedSession: { id: 'pending-uuid-1', sessionKey: 'sk-42' },
      violationResults: [],
      qualityChange: null,
      referenceId: null,
      wasTerminatedByRule: false,
    });

    cacheService = {
      // The active-session snapshot from the previous tick's addActiveSession -
      // this is what makes cachedSessionKeys already contain sk-42.
      getAllActiveSessions: vi.fn().mockResolvedValue([cachedPendingActiveSession]),
      getPendingSession: vi
        .fn()
        .mockImplementation(async (_serverId: string, key: string) =>
          key === 'sk-42' ? createPendingSessionData() : null
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

  it('passes the confirming user prior sessions into confirmAndPersistSession, not an empty array', async () => {
    await triggerServerPoll('server-1');

    expect(mockConfirmAndPersistSession).toHaveBeenCalledTimes(1);
    const call = mockConfirmAndPersistSession.mock.calls[0]?.[0] as {
      recentSessions: Session[];
    };

    // The bug: recentSessionsMap only covers users with a brand-new session
    // key this tick, so a confirming pending session (already "known" this
    // tick) got recentSessions: [] here and windowed rules saw zero history.
    expect(call.recentSessions).toHaveLength(1);
    expect(call.recentSessions[0]?.id).toBe('prior-session-id');
    expect(call.recentSessions[0]?.ipAddress).toBe('9.9.9.9');
    expect(call.recentSessions[0]?.deviceId).toBe('device-other');

    // Confirms it came from an explicit backfill for this specific user, not
    // from the upfront new-sessions batch (which this tick calls with []).
    const calledArgs = mockBatchGetRecentUserSessions.mock.calls.map((c) => c[0]);
    expect(calledArgs).toContainEqual(['su-B']);
  });

  it('offers a playing rating key the library does not hold to a targeted sync', async () => {
    await triggerServerPoll('server-1');

    expect(mockRequestSyncForUnknownKeys).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server-1' }),
      ['rk-1']
    );
  });

  it('does not offer a live TV channel key to a targeted sync', async () => {
    mockMapMediaSession.mockReturnValue({
      sessionKey: 'sk-42',
      ratingKey: 'channel-7',
      externalUserId: 'ext-1',
      username: 'alice',
      userThumb: '',
      mediaTitle: 'Evening News',
      mediaType: 'live',
      state: 'playing',
      ipAddress: '1.2.3.4',
      deviceId: 'device-1',
    });

    await triggerServerPoll('server-1');

    expect(mockRequestSyncForUnknownKeys).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'server-1' }),
      []
    );
  });

  it('memoizes the backfill: a second session for the same user in one tick does not refetch', async () => {
    // Two pending sessions for su-B on different devices, both confirming
    // this tick. Both were already active in cache from the previous tick.
    let mapCallCount = 0;
    mockMapMediaSession.mockImplementation(() => {
      mapCallCount += 1;
      return {
        sessionKey: `sk-4${mapCallCount}`,
        ratingKey: `rk-${mapCallCount}`,
        externalUserId: 'ext-1',
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

    cacheService.getAllActiveSessions.mockResolvedValue([
      { ...cachedPendingActiveSession, id: 'pending-uuid-1', sessionKey: 'sk-41' },
      { ...cachedPendingActiveSession, id: 'pending-uuid-2', sessionKey: 'sk-42' },
    ]);
    cacheService.getPendingSession = vi
      .fn()
      .mockImplementation(async (_serverId: string, key: string) => {
        if (key !== 'sk-41' && key !== 'sk-42') return null;
        return { ...createPendingSessionData(), id: `pending-uuid-${key.slice(-1)}` };
      });
    mockUpdatePendingSession.mockImplementation((pendingData: PendingSessionData) => ({
      updatedData: pendingData,
      isConfirmed: true,
    }));
    mockConfirmAndPersistSession.mockImplementation(
      async (input: { pendingData: { id: string; processed: { sessionKey: string } } }) => ({
        insertedSession: {
          id: input.pendingData.id,
          sessionKey: input.pendingData.processed.sessionKey,
        },
        violationResults: [],
        qualityChange: null,
        referenceId: null,
        wasTerminatedByRule: false,
      })
    );

    await triggerServerPoll('server-1');

    expect(mockConfirmAndPersistSession).toHaveBeenCalledTimes(2);
    const backfillCalls = mockBatchGetRecentUserSessions.mock.calls.filter((c) =>
      (c[0] as string[]).includes('su-B')
    );
    expect(backfillCalls).toHaveLength(1);
  });
});
