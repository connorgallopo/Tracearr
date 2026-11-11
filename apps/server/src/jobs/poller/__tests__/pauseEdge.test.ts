/**
 * The poller dispatches session.paused on the playing→paused edge only; the
 * scheduled wakes carry the re-evaluation while the session stays paused.
 * session.watched rides the same per-tick path, once, on the tick that sets the flag.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCreateMediaServerClient,
  mockMapMediaSession,
  mockBuildActiveSession,
  mockBatchFindActiveSessionsByComposite,
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
  findActiveSession: vi.fn().mockResolvedValue(null),
  findActiveSessionByComposite: vi.fn().mockResolvedValue(null),
  handleMediaChangeAtomic: vi.fn(),
  processPollResults: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));

import { initializePoller, triggerServerPoll } from '../processor.js';
import { getActiveAutomations } from '../database.js';
import { updatePendingSession } from '../pendingConfirmation.js';
import { buildPendingActiveSession } from '../sessionLifecycle.js';
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

describe('poller pause edge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateWhere.mockResolvedValue([{ id: EXISTING_SESSION_ID }]);
    vi.mocked(getActiveAutomations).mockResolvedValue([{ id: 'rule-1' }] as unknown as Awaited<
      ReturnType<typeof getActiveAutomations>
    >);

    mockCreateMediaServerClient.mockReturnValue(
      fakeJellyfinClient({
        getSessions: vi.fn().mockResolvedValue([{}]),
      })
    );
    mockMapMediaSession.mockReturnValue(processedSession());
    mockBuildActiveSession.mockReturnValue({ id: EXISTING_SESSION_ID, sessionKey: 'sess-key-1' });

    const cacheService = {
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

  it('dispatches session.paused once on the playing→paused edge', async () => {
    mockBatchFindActiveSessionsByComposite.mockResolvedValue(
      new Map([['server-user-1::1001', [existingSessionRow({ state: 'playing' })]]])
    );
    mockMapMediaSession.mockReturnValue(processedSession({ state: 'paused' }));

    await triggerServerPoll('server-1');

    const types = mockDispatch.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types.filter((t) => t === 'session.paused')).toHaveLength(1);
    expect(types).not.toContain('session.resumed');
  });

  it('dispatches session.watched once on the tick that crosses the watched threshold', async () => {
    mockBatchFindActiveSessionsByComposite.mockResolvedValue(
      new Map([['server-user-1::1001', [existingSessionRow({ watched: false })]]])
    );
    mockMapMediaSession.mockReturnValue(
      processedSession({ state: 'playing', progressMs: 3_300_000 })
    );

    await triggerServerPoll('server-1');

    const watched = mockDispatch.mock.calls
      .map((c) => c[0] as { type: string; session?: { watched: boolean } })
      .filter((e) => e.type === 'session.watched');
    expect(watched).toHaveLength(1);
    expect(watched[0]?.session?.watched).toBe(true);
  });

  it('dispatches nothing for a paused→paused update', async () => {
    mockBatchFindActiveSessionsByComposite.mockResolvedValue(
      new Map([['server-user-1::1001', [existingSessionRow({ state: 'paused' })]]])
    );
    mockMapMediaSession.mockReturnValue(processedSession({ state: 'paused' }));

    await triggerServerPoll('server-1');

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('dispatches session.resumed on the paused→playing edge', async () => {
    mockBatchFindActiveSessionsByComposite.mockResolvedValue(
      new Map([['server-user-1::1001', [existingSessionRow({ state: 'paused' })]]])
    );
    mockMapMediaSession.mockReturnValue(processedSession({ state: 'playing' }));

    await triggerServerPoll('server-1');

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.resumed', sessionId: EXISTING_SESSION_ID })
    );
    const types = mockDispatch.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('session.paused');
  });

  it('keeps a paused row paused while Plex reports buffering', async () => {
    mockBatchFindActiveSessionsByComposite.mockResolvedValue(
      new Map([['server-user-1::1001', [existingSessionRow({ state: 'paused' })]]])
    );
    mockMapMediaSession.mockReturnValue(processedSession({ state: 'playing', buffering: true }));

    await triggerServerPoll('server-1');

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('keeps a paused pending session paused while Plex reports buffering', async () => {
    const pending = {
      id: 'pending-1',
      currentState: 'paused',
      processed: processedSession({ state: 'paused', buffering: false }),
    };
    vi.mocked(updatePendingSession).mockReturnValue({
      updatedData: pending,
      isConfirmed: false,
    } as unknown as ReturnType<typeof updatePendingSession>);
    mockMapMediaSession.mockReturnValue(processedSession({ state: 'playing', buffering: true }));
    initializePoller(
      {
        getAllActiveSessions: vi.fn().mockResolvedValue([]),
        getPendingSession: vi.fn().mockResolvedValue(pending),
        setPendingSession: vi.fn(),
        getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
      } as unknown as Parameters<typeof initializePoller>[0],
      { publish: vi.fn(), subscribe: vi.fn() } as unknown as Parameters<typeof initializePoller>[1]
    );

    await triggerServerPoll('server-1');

    expect(updatePendingSession).toHaveBeenCalledWith(
      pending,
      'paused',
      20_000,
      expect.any(Number)
    );
    expect(buildPendingActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ processed: expect.objectContaining({ buffering: true }) })
    );
  });
});
