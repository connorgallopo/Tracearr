/**
 * After Tracearr kills a Jellyfin or Emby playback, the server keeps listing it until the client
 * reports the stop, and a client that never does keeps advancing there. The poller holds that
 * leftover off but must show the same device starting the item again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession } from '@tracearr/shared';
import type { CacheService, PubSubService, TerminationCooldown } from '../../../services/cache.js';
import type { ProcessedSession } from '../types.js';

const mockDbSelect = vi.fn();
const { mockCreateMediaServerClient, mockDispatchSessionFirstSeen } = vi.hoisted(() => ({
  mockCreateMediaServerClient: vi.fn(),
  mockDispatchSessionFirstSeen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
  },
}));
vi.mock('../../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));
vi.mock('../../../services/settings.js', () => ({
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));
vi.mock('../../../serverState.js', () => ({ isMaintenance: vi.fn().mockReturnValue(false) }));
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
  sseManager: { isInFallback: vi.fn().mockReturnValue(true), nudgeReconnect: vi.fn() },
}));
vi.mock('../../notificationQueue.js', () => ({ enqueueNotification: vi.fn() }));
vi.mock('../database.js', () => ({
  onActiveAutomationsRefill: vi.fn(),
  getCachedServers: () => mockDbSelect().from(servers),
  getActiveAutomations: vi.fn().mockResolvedValue([]),
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn(),
}));
vi.mock('../pendingConfirmation.js', () => ({ updatePendingSession: vi.fn() }));
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: vi.fn().mockReturnValue({ id: 'new-id' }),
  buildPendingActiveSession: vi.fn().mockReturnValue({ id: 'pending-id', serverId: 'server-1' }),
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: vi.fn().mockResolvedValue(null),
  findActiveSessionByComposite: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  processPollResults: vi.fn().mockResolvedValue(undefined),
  stopSessionAtomic: vi.fn(),
}));
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: vi.fn().mockResolvedValue({ violations: [], outcomes: [] }),
  subscribe: vi.fn(),
}));
vi.mock('../../../services/automations/events/producers.js', () => ({
  dispatchServerHealth: vi.fn(),
  dispatchSessionFirstSeen: mockDispatchSessionFirstSeen,
}));
vi.mock('../violations.js', () => ({ broadcastViolations: vi.fn() }));
vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: vi.fn((raw: unknown) => raw),
  pickStreamDetailFields: vi.fn().mockReturnValue({}),
}));

import { servers, serverUsers, sessions as sessionsTable } from '../../../db/schema.js';
import { initializePoller, stopPoller, triggerPoll } from '../processor.js';
import { fakeJellyfinClient } from '../../../test/mediaServerFakes.js';

const KILLED_KEY = 'server-1:su-1:firestick-1:item-777';

function jellyfinPlay(overrides: Partial<ProcessedSession> = {}): ProcessedSession {
  return {
    sessionKey: 'jf-session-abc',
    ratingKey: 'item-777',
    externalUserId: 'jf-user-1',
    username: 'alice',
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
    ipAddress: '192.168.1.50',
    playerName: 'Fire TV',
    deviceId: 'firestick-1',
    product: 'Wholphin',
    device: 'Fire TV',
    platform: 'Android',
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 8000,
    state: 'playing',
    buffering: false,
    totalDurationMs: 7_200_000,
    progressMs: 0,
    sourceVideoCodec: 'h264',
    sourceAudioCodec: 'aac',
    sourceAudioChannels: 2,
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

const serverRow = {
  id: 'server-1',
  name: 'JF',
  type: 'jellyfin' as const,
  url: 'http://jf:8096',
  token: 't',
  createdAt: new Date(),
  updatedAt: new Date(),
};
const serverUserRow = {
  id: 'su-1',
  userId: 'identity-1',
  serverId: 'server-1',
  externalId: 'jf-user-1',
  username: 'alice',
  email: null,
  thumbUrl: null,
  isServerAdmin: false,
  trustScore: 100,
  lastActivityAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  identityName: 'Alice',
};

mockDbSelect.mockImplementation(() => ({
  from: (table: unknown) => {
    if (table === servers) return Promise.resolve([serverRow]);
    if (table === serverUsers) {
      return { innerJoin: () => ({ where: () => Promise.resolve([serverUserRow]) }) };
    }
    if (table === sessionsTable) return { where: () => ({ limit: () => Promise.resolve([]) }) };
    return Promise.resolve([]);
  },
}));

function createCache(kill: TerminationCooldown) {
  return {
    getAllActiveSessions: vi.fn().mockResolvedValue([] as ActiveSession[]),
    setServerHealth: vi.fn().mockResolvedValue(true),
    resetServerFailCount: vi.fn().mockResolvedValue(undefined),
    incrServerFailCount: vi.fn().mockResolvedValue(1),
    getPendingSession: vi.fn().mockResolvedValue(null),
    setPendingSession: vi.fn().mockResolvedValue(undefined),
    deletePendingSession: vi.fn().mockResolvedValue(undefined),
    withSessionCreateLock: vi
      .fn()
      .mockImplementation(async (_s: string, _k: string, op: () => Promise<unknown>) => op()),
    addActiveSession: vi.fn().mockResolvedValue(undefined),
    removeActiveSession: vi.fn().mockResolvedValue(undefined),
    removeUserSession: vi.fn().mockResolvedValue(undefined),
    hasTerminationCooldown: vi.fn().mockResolvedValue(false),
    getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map([[KILLED_KEY, kill]])),
    clearTerminationCooldownsComposite: vi.fn().mockResolvedValue(undefined),
    addSessionWriteRetry: vi.fn().mockResolvedValue(undefined),
    invalidateDashboardStatsCache: vi.fn().mockResolvedValue(undefined),
  };
}

async function pollWith(kill: TerminationCooldown, plays: ProcessedSession[]) {
  mockCreateMediaServerClient.mockReturnValue(
    fakeJellyfinClient({ getSessions: vi.fn().mockResolvedValue(plays) })
  );
  const cache = createCache(kill);
  initializePoller(
    cache as unknown as CacheService,
    {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as PubSubService
  );
  await triggerPoll();
  return cache;
}

const KILLED_AT_POSITION = 600_000;
const killedAgo = (ms: number, paused = false): TerminationCooldown => ({
  killedAt: Date.now() - ms,
  positionMs: KILLED_AT_POSITION,
  paused,
});

describe('a Jellyfin or Emby playback Tracearr killed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopPoller();
  });

  it.each([
    ['still advancing where it was killed', killedAgo(20_000), KILLED_AT_POSITION + 20_000],
    ['still paused where it was killed', killedAgo(20_000, true), KILLED_AT_POSITION],
  ])('stays hidden while the server reports it %s', async (_label, kill, progressMs) => {
    const cache = await pollWith(kill, [jellyfinPlay({ progressMs })]);

    expect(cache.setPendingSession).not.toHaveBeenCalled();
    expect(mockDispatchSessionFirstSeen).not.toHaveBeenCalled();
    expect(cache.clearTerminationCooldownsComposite).not.toHaveBeenCalledWith('server-1', [
      KILLED_KEY,
    ]);
  });

  it('shows the same device resuming it, even inside one poll gap', async () => {
    const cache = await pollWith(killedAgo(20_000), [
      jellyfinPlay({ progressMs: KILLED_AT_POSITION + 2_000 }),
    ]);

    expect(cache.clearTerminationCooldownsComposite).toHaveBeenCalledWith('server-1', [KILLED_KEY]);
    expect(cache.setPendingSession).toHaveBeenCalledTimes(1);
    expect(mockDispatchSessionFirstSeen).toHaveBeenCalledTimes(1);
  });

  it('is forgotten once a poll no longer lists it, so the next play shows', async () => {
    const cache = await pollWith(killedAgo(5_000), []);

    expect(cache.clearTerminationCooldownsComposite).toHaveBeenCalledWith('server-1', [KILLED_KEY]);
  });
});
