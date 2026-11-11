/**
 * Media-change reachability in the poller.
 *
 * A real Plex "play next episode" reuses the sessionKey with a new ratingKey.
 * processServerSessions must derive the existing row by sessionKey alone and
 * let the real detectMediaChange route it through handleMediaChangeAtomic.
 * These drive triggerPoll with the real detectMediaChange/buildCompositeKey
 * (stateTracker is not mocked) and a faithful DB-shaped batch lookup, so they
 * fail against a build that still filters the lookup by the incoming ratingKey.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession } from '@tracearr/shared';
import type { CacheService, PubSubService } from '../../../services/cache.js';
import type { ProcessedSession } from '../types.js';

const mockDbSelect = vi.fn();
const { mockCreateMediaServerClient, mockGetActiveAutomations } = vi.hoisted(() => ({
  mockCreateMediaServerClient: vi.fn(),
  mockGetActiveAutomations: vi.fn().mockResolvedValue([]),
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

const mockEnqueueNotification = vi.fn();
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
  widenRecentSessionsForMergedIdentities: vi.fn(),
}));

vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: vi.fn(),
}));

const mockBatchFindActiveSessionsByKey = vi.fn();
const mockHandleMediaChangeAtomic = vi.fn();
const mockCreateSessionWithRulesAtomic = vi.fn();
const mockBuildActiveSession = vi.fn();
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: (...args: unknown[]) => mockBatchFindActiveSessionsByKey(...args),
  buildActiveSession: (...args: unknown[]) => mockBuildActiveSession(...args),
  buildPendingActiveSession: vi.fn(),
  createSessionWithRulesAtomic: (...args: unknown[]) => mockCreateSessionWithRulesAtomic(...args),
  findActiveSession: vi.fn().mockResolvedValue(null),
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

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: vi.fn((raw: unknown) => raw),
  pickStreamDetailFields: vi.fn().mockReturnValue({}),
}));

import { servers, serverUsers, sessions as sessionsTable } from '../../../db/schema.js';
import { initializePoller, stopPoller, triggerPoll } from '../processor.js';
import { fakePlexClient } from '../../../test/mediaServerFakes.js';

function createMockProcessedSession(overrides: Partial<ProcessedSession> = {}): ProcessedSession {
  return {
    sessionKey: 'sk-42',
    ratingKey: 'rk-new',
    externalUserId: 'ext-1',
    username: 'userA',
    userThumb: '',
    mediaTitle: 'Episode 2',
    mediaType: 'episode',
    grandparentTitle: 'Test Show',
    seasonNumber: 1,
    episodeNumber: 2,
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

const serverUserRow = {
  id: 'su-1',
  userId: 'identity-1',
  serverId: 'server-1',
  externalId: 'ext-1',
  username: 'userA',
  email: null,
  thumbUrl: null,
  isServerAdmin: false,
  trustScore: 100,
  lastActivityAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  identityName: 'User A',
};

// The existing DB row: same sessionKey, the OLD ratingKey. A same-sessionKey
// query returns it regardless of the incoming ratingKey - that is what
// batchFindActiveSessionsByKey does in production (grouped by sessionKey, no
// ratingKey predicate).
const oldSessionRow = {
  id: 'old-id',
  serverId: 'server-1',
  serverUserId: 'su-1',
  sessionKey: 'sk-42',
  ratingKey: 'rk-old',
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
  mediaType: 'episode' as const,
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

const oldActiveSession = {
  id: 'old-id',
  serverId: 'server-1',
  serverUserId: 'su-1',
  sessionKey: 'sk-42',
  deviceId: 'device-1',
  ratingKey: 'rk-old',
  pending: false,
} as unknown as ActiveSession;

mockDbSelect.mockImplementation(() => ({
  from: (table: unknown) => {
    if (table === servers) return Promise.resolve([serverRow]);
    if (table === serverUsers) {
      return { innerJoin: () => ({ where: () => Promise.resolve([serverUserRow]) }) };
    }
    if (table === sessionsTable) {
      return { where: () => Promise.resolve([]) };
    }
    return Promise.resolve([]);
  },
}));

function createCacheService() {
  return {
    getAllActiveSessions: vi.fn().mockResolvedValue([oldActiveSession]),
    setServerHealth: vi.fn().mockResolvedValue(true),
    resetServerFailCount: vi.fn().mockResolvedValue(undefined),
    incrServerFailCount: vi.fn().mockResolvedValue(1),
    getPendingSession: vi.fn().mockResolvedValue(null),
    setPendingSession: vi.fn().mockResolvedValue(undefined),
    deletePendingSession: vi.fn().mockResolvedValue(undefined),
    withSessionCreateLock: vi.fn().mockResolvedValue(undefined),
    removeActiveSession: vi.fn().mockResolvedValue(undefined),
    removeUserSession: vi.fn().mockResolvedValue(undefined),
    hasTerminationCooldown: vi.fn().mockResolvedValue(false),
    getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
    clearTerminationCooldownsComposite: vi.fn(),
    addSessionWriteRetry: vi.fn().mockResolvedValue(undefined),
    invalidateDashboardStatsCache: vi.fn().mockResolvedValue(undefined),
  };
}

let cacheService: ReturnType<typeof createCacheService>;

describe('poller routes a real next-episode transition through the media-change path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopPoller();
    mockGetActiveAutomations.mockResolvedValue([]);
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map([['sk-42', [oldSessionRow]]]));
    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({
        getSessions: vi.fn().mockResolvedValue([createMockProcessedSession()]),
      })
    );
    mockBuildActiveSession.mockReturnValue({ id: 'new-id' });

    cacheService = createCacheService();
    initializePoller(
      cacheService as unknown as CacheService,
      { publish: vi.fn().mockResolvedValue(undefined) } as unknown as PubSubService
    );
  });

  it('stops the old row and creates the next episode via handleMediaChangeAtomic', async () => {
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: { id: 'old-id', serverUserId: 'su-1', sessionKey: 'sk-42' },
      insertedSession: { id: 'new-id', ratingKey: 'rk-new' },
      violationResults: [],
      wasTerminatedByRule: false,
      qualityChange: undefined,
    });

    await triggerPoll();

    expect(mockHandleMediaChangeAtomic).toHaveBeenCalledTimes(1);
    const input = mockHandleMediaChangeAtomic.mock.calls[0]![0] as {
      existingSession: { id: string; ratingKey: string };
      processed: { ratingKey: string };
    };
    expect(input.existingSession.id).toBe('old-id');
    expect(input.existingSession.ratingKey).toBe('rk-old');
    expect(input.processed.ratingKey).toBe('rk-new');

    expect(cacheService.removeActiveSession).toHaveBeenCalledWith('old-id');
  });

  it('does not fall into the stale-cache create branch for the transition', async () => {
    mockHandleMediaChangeAtomic.mockResolvedValue({
      stoppedSession: { id: 'old-id', serverUserId: 'su-1', sessionKey: 'sk-42' },
      insertedSession: { id: 'new-id', ratingKey: 'rk-new' },
      violationResults: [],
      wasTerminatedByRule: false,
      qualityChange: undefined,
    });

    await triggerPoll();

    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
  });

  it('does not route a different user through media change when a stale row reuses the sessionKey', async () => {
    // Plex resets sessionKey counters on PMS restart, so the batched lookup can
    // return an open row that belongs to a different user than the current
    // play. Matching by sessionKey alone would stop that user's row and
    // reattribute the new play.
    const staleUserRow = { ...oldSessionRow, serverUserId: 'su-STALE' };
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map([['sk-42', [staleUserRow]]]));

    await triggerPoll();

    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
    expect(cacheService.removeActiveSession).not.toHaveBeenCalledWith('old-id');
  });

  it('takes the normal update path (no media change) when the ratingKey is unchanged', async () => {
    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({
        getSessions: vi
          .fn()
          .mockResolvedValue([createMockProcessedSession({ ratingKey: 'rk-old' })]),
      })
    );

    await triggerPoll();

    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
  });

  it('does not treat a stored empty-string ratingKey as a media change when the real key arrives', async () => {
    // A row persisted during a metadata blip carries ratingKey ''. When the
    // real key arrives detectMediaChange must see '' as absent (null), not as a
    // distinct key, so it does not stop+recreate the session spuriously.
    const blipRow = { ...oldSessionRow, ratingKey: '' };
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map([['sk-42', [blipRow]]]));

    await triggerPoll();

    expect(mockHandleMediaChangeAtomic).not.toHaveBeenCalled();
    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
  });
});
