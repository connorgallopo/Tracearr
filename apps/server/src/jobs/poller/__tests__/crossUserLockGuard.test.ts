/**
 * Cross-user sessionKey reuse guards on the poller's in-lock create paths.
 *
 * Plex resets sessionKey counters on PMS restart, so within the reconciliation
 * window a stale open row from one user can carry the same sessionKey a
 * different user's new play now uses. The poller's in-lock rechecks look up by
 * sessionKey alone; without a server-user match they would reattach the stale
 * row to the new user (rediscovery path) or skip creation entirely (stale-cache
 * path), leaving the real play untracked. These drive triggerPoll with the
 * create lock actually executing its callback and a foreign-user row returned
 * from the in-lock findActiveSession.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession } from '@tracearr/shared';
import type { CacheService, PubSubService } from '../../../services/cache.js';
import type { ProcessedSession } from '../types.js';

const mockDbSelect = vi.fn();
const mockTouchReturning = vi.fn().mockResolvedValue([{ id: 'foreign-id' }]);
const { mockCreateMediaServerClient, mockGetActiveAutomations } = vi.hoisted(() => ({
  mockCreateMediaServerClient: vi.fn(),
  mockGetActiveAutomations: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: () => ({
      set: () => ({ where: () => ({ returning: () => mockTouchReturning() }) }),
    }),
  },
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

vi.mock('../../notificationQueue.js', () => ({
  enqueueNotification: vi.fn(),
}));

vi.mock('../database.js', () => ({
  onActiveAutomationsRefill: vi.fn(),
  getCachedServers: () => mockDbSelect().from(servers),
  getActiveAutomations: mockGetActiveAutomations,
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn(),
}));

vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: vi.fn(),
}));

const mockBatchFindActiveSessionsByKey = vi.fn();
const mockFindActiveSession = vi.fn();
const mockCreateSessionWithRulesAtomic = vi.fn();
const mockBuildActiveSession = vi.fn();
const mockHandleMediaChangeAtomic = vi.fn();
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: (...args: unknown[]) => mockBatchFindActiveSessionsByKey(...args),
  buildActiveSession: (...args: unknown[]) => mockBuildActiveSession(...args),
  buildPendingActiveSession: vi.fn(),
  createSessionWithRulesAtomic: (...args: unknown[]) => mockCreateSessionWithRulesAtomic(...args),
  findActiveSession: (...args: unknown[]) => mockFindActiveSession(...args),
  findActiveSessionByComposite: vi.fn(),
  handleMediaChangeAtomic: (...args: unknown[]) => mockHandleMediaChangeAtomic(...args),
  handleQualityChangeFallout: vi.fn(),
  processPollResults: vi.fn().mockResolvedValue(undefined),
  stopSessionAtomic: vi.fn(),
}));

const mockDispatch = vi.fn().mockResolvedValue({ violations: [], outcomes: [] });
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));

const mockDispatchSessionFirstSeen = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../../services/automations/events/producers.js', () => ({
  dispatchServerHealth: vi.fn(),
  dispatchSessionFirstSeen: mockDispatchSessionFirstSeen,
}));

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: vi.fn((raw: unknown) => raw),
  pickStreamDetailFields: vi.fn().mockReturnValue({}),
}));

import { servers, serverUsers, sessions as sessionsTable } from '../../../db/schema.js';
import { initializePoller, stopPoller, triggerPoll } from '../processor.js';
import { buildPendingActiveSession } from '../sessionLifecycle.js';

function createMockProcessedSession(overrides: Partial<ProcessedSession> = {}): ProcessedSession {
  return {
    sessionKey: 'sk-42',
    ratingKey: 'rk-1',
    externalUserId: 'ext-1',
    username: 'userB',
    userThumb: '',
    mediaTitle: 'Movie',
    mediaType: 'movie',
    grandparentTitle: '',
    seasonNumber: null,
    episodeNumber: null,
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
    dispatcharrPlaybackKind: null,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 20000,
    state: 'playing',
    totalDurationMs: 7200000,
    progressMs: 0,
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

// The incoming play resolves to server user su-B.
const serverUserRow = {
  id: 'su-B',
  userId: 'identity-B',
  serverId: 'server-1',
  externalId: 'ext-1',
  username: 'userB',
  email: null,
  thumbUrl: null,
  isServerAdmin: false,
  trustScore: 100,
  lastActivityAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  identityName: 'User B',
};

// A stale open DB row from a different user (su-A) that Plex reassigned this
// sessionKey to after a PMS restart.
const foreignRow = {
  id: 'foreign-id',
  serverId: 'server-1',
  serverUserId: 'su-A',
  sessionKey: 'sk-42',
  ratingKey: 'rk-1',
  deviceId: 'device-1',
  state: 'playing' as const,
  startedAt: new Date(Date.now() - 5 * 60 * 1000),
  lastSeenAt: new Date(),
  lastPausedAt: null,
  pausedDurationMs: 0,
  watched: false,
  totalDurationMs: 7200000,
  progressMs: 3600000,
  ipAddress: '192.168.1.100',
  mediaType: 'movie' as const,
  videoDecision: 'directplay',
  audioDecision: 'directplay',
  referenceId: null,
  geoCity: null,
  geoRegion: null,
  geoCountry: null,
  geoContinent: null,
  geoPostal: null,
  geoLat: null,
  geoLon: null,
  geoAsnNumber: null,
  geoAsnOrganization: null,
};

const foreignActiveSession = {
  id: 'foreign-id',
  serverId: 'server-1',
  serverUserId: 'su-A',
  sessionKey: 'sk-42',
  deviceId: 'device-1',
  ratingKey: 'rk-1',
  pending: false,
} as unknown as ActiveSession;

mockDbSelect.mockImplementation(() => ({
  from: (table: unknown) => {
    if (table === servers) return Promise.resolve([serverRow]);
    if (table === serverUsers) {
      return { innerJoin: () => ({ where: () => Promise.resolve([serverUserRow]) }) };
    }
    if (table === sessionsTable) {
      // Plex-only duplicate check (serverUserId + ratingKey): no row for su-B.
      return { where: () => ({ limit: () => Promise.resolve([]) }) };
    }
    return Promise.resolve([]);
  },
}));

const createResultOk = {
  insertedSession: {
    id: 'new-id',
    serverId: 'server-1',
    serverUserId: 'su-B',
    sessionKey: 'sk-42',
    ratingKey: 'rk-1',
  },
  violationResults: [],
  wasTerminatedByRule: false,
  qualityChange: undefined,
};

function createCacheService(cachedActive: ActiveSession[]) {
  return {
    getAllActiveSessions: vi.fn().mockResolvedValue(cachedActive),
    getServerHealth: vi.fn().mockResolvedValue(true),
    setServerHealth: vi.fn().mockResolvedValue(undefined),
    resetServerFailCount: vi.fn().mockResolvedValue(undefined),
    incrServerFailCount: vi.fn().mockResolvedValue(1),
    getPendingSession: vi.fn().mockResolvedValue(null),
    setPendingSession: vi.fn().mockResolvedValue(undefined),
    deletePendingSession: vi.fn().mockResolvedValue(undefined),
    // Execute the create-lock callback so the in-lock rechecks actually run.
    withSessionCreateLock: vi.fn().mockImplementation(async (_s, _k, op) => op()),
    addActiveSession: vi.fn().mockResolvedValue(undefined),
    removeActiveSession: vi.fn().mockResolvedValue(undefined),
    removeUserSession: vi.fn().mockResolvedValue(undefined),
    hasTerminationCooldown: vi.fn().mockResolvedValue(false),
    hasTerminationCooldownComposite: vi.fn().mockResolvedValue(false),
    addSessionWriteRetry: vi.fn().mockResolvedValue(undefined),
    invalidateDashboardStatsCache: vi.fn().mockResolvedValue(undefined),
  };
}

describe('poller in-lock cross-user sessionKey guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopPoller();
    mockGetActiveAutomations.mockResolvedValue([]);
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([createMockProcessedSession()]),
    });
    mockCreateSessionWithRulesAtomic.mockResolvedValue(createResultOk);
    mockBuildActiveSession.mockReturnValue({ id: 'new-id' });
    // In-lock recheck returns the stale row belonging to another user.
    mockFindActiveSession.mockResolvedValue(foreignRow);
  });

  it('rediscovery path (isNew): defers a fresh pending entry under the real user instead of reattaching the foreign row', async () => {
    // Empty cache -> the incoming key reads as new, routing through the isNew
    // create lock whose recheck finds the foreign row. Creation itself is now
    // deferred to a pending Redis entry rather than an immediate DB row.
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map());
    const cacheService = createCacheService([]);
    initializePoller(
      cacheService as unknown as CacheService,
      { publish: vi.fn().mockResolvedValue(undefined) } as unknown as PubSubService
    );

    await triggerPoll();

    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
    expect(cacheService.setPendingSession).toHaveBeenCalledTimes(1);
    const [, , pendingData] = cacheService.setPendingSession.mock.calls[0] as [
      string,
      string,
      { serverUser: { id: string } },
    ];
    expect(pendingData.serverUser.id).toBe('su-B');
  });

  it('a fresh pending entry announces session.first_seen with the pending session', async () => {
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map());
    const pendingActive = { id: 'pending-id', serverId: 'server-1' } as unknown as ActiveSession;
    vi.mocked(buildPendingActiveSession).mockReturnValue(pendingActive);
    const cacheService = createCacheService([]);
    initializePoller(
      cacheService as unknown as CacheService,
      { publish: vi.fn().mockResolvedValue(undefined) } as unknown as PubSubService
    );

    await triggerPoll();

    expect(cacheService.setPendingSession).toHaveBeenCalledTimes(1);
    expect(mockDispatchSessionFirstSeen).toHaveBeenCalledTimes(1);
    expect(mockDispatchSessionFirstSeen).toHaveBeenCalledWith(
      expect.objectContaining({
        session: pendingActive,
        server: { id: 'server-1', name: 'Test Server', type: 'plex' },
        serverUser: expect.objectContaining({ id: 'su-B' }),
        at: expect.any(Date),
      })
    );
  });

  it('stale-cache path: creates fresh under the real user instead of skipping on the foreign row', async () => {
    // Foreign row is in the active cache under this sessionKey, so the key is
    // "known" -> the else branch sees a cross-user batch row, nulls it, and
    // drops into the stale-cache create lock whose recheck finds the foreign row.
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map([['sk-42', [foreignRow]]]));
    const cacheService = createCacheService([foreignActiveSession]);
    initializePoller(
      cacheService as unknown as CacheService,
      { publish: vi.fn().mockResolvedValue(undefined) } as unknown as PubSubService
    );

    await triggerPoll();

    expect(mockCreateSessionWithRulesAtomic).toHaveBeenCalledTimes(1);
    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
  });

  it('same-user in-lock row still short-circuits (isNew rediscovery)', async () => {
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map());
    mockFindActiveSession.mockResolvedValue({ ...foreignRow, serverUserId: 'su-B' });
    const cacheService = createCacheService([]);
    initializePoller(
      cacheService as unknown as CacheService,
      { publish: vi.fn().mockResolvedValue(undefined) } as unknown as PubSubService
    );

    await triggerPoll();

    // Genuine same-user recovery: no fresh create.
    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
    expect(mockBuildActiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ id: 'foreign-id' }) })
    );
  });
});
