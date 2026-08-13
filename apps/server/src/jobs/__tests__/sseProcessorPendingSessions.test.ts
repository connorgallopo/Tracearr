/**
 * SSE Processor Tests - Pending Session Flow (Delayed Rule Evaluation)
 *
 * Tests the Redis-first architecture for session creation:
 * - New sessions are stored in Redis as "pending" (not in DB)
 * - Sessions remain pending until 30s confirmation threshold met
 * - Once confirmed, session is persisted to DB and rules are evaluated
 * - If stopped before confirmation, session is discarded (phantom session)
 *
 * This prevents Plex prefetch events (phantom sessions) from triggering rule violations.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';
import type { PendingSessionData } from '../poller/types.js';

// Create mocks using vi.hoisted
const {
  mockSseManager,
  mockEnqueueNotification,
  mockFindActiveSession,
  mockFindActiveSessionsAll,
  mockConfirmAndPersistSession,
  mockStopSessionAtomic,
  mockBuildActiveSession,
  mockBuildPendingActiveSession,
  mockIsPlaybackConfirmed,
  mockCreateInitialConfirmationState,
  mockUpdateConfirmationState,
  mockDetectMediaChange,
  mockGetActiveRulesV2,
  mockBatchGetRecentUserSessions,
  mockBatchGetLibraryItemIdentity,
  mockBroadcastViolations,
  mockMapMediaSession,
  mockCreateMediaServerClient,
  mockGetIdentityServerUserIds,
  mockDb,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events');
  return {
    mockSseManager: new EE() as EventEmitter,
    mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
    mockFindActiveSession: vi.fn().mockResolvedValue(null),
    mockFindActiveSessionsAll: vi.fn().mockResolvedValue([]),
    mockConfirmAndPersistSession: vi.fn(),
    mockStopSessionAtomic: vi.fn().mockResolvedValue({ wasUpdated: true }),
    mockBuildActiveSession: vi.fn(),
    mockBuildPendingActiveSession: vi.fn().mockImplementation((data) => ({
      id: data.id,
      serverId: data.server.id,
      serverName: data.server.name,
      sessionKey: data.processed.sessionKey,
      mediaTitle: data.processed.mediaTitle,
      pending: true,
    })),
    mockIsPlaybackConfirmed: vi.fn().mockReturnValue(false),
    mockCreateInitialConfirmationState: vi.fn().mockReturnValue({
      confirmedPlayback: false,
      firstSeenAt: Date.now(),
      maxViewOffset: 0,
      initialViewOffset: null,
    }),
    mockUpdateConfirmationState: vi.fn().mockImplementation((state) => state),
    mockDetectMediaChange: vi.fn().mockReturnValue(false),
    mockGetActiveRulesV2: vi.fn().mockResolvedValue([]),
    mockBatchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
    mockBatchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
    mockBroadcastViolations: vi.fn(),
    mockMapMediaSession: vi.fn(),
    mockCreateMediaServerClient: vi.fn().mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([]),
    }),
    mockGetIdentityServerUserIds: vi.fn().mockResolvedValue([]),
    mockDb: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      update: vi.fn(),
    },
  };
});

// Mock the sseManager
vi.mock('../../services/sseManager.js', () => ({
  sseManager: mockSseManager,
}));

// Mock enqueueNotification
vi.mock('../notificationQueue.js', () => ({
  enqueueNotification: mockEnqueueNotification,
}));

// Mock database
vi.mock('../../db/client.js', () => ({
  db: mockDb,
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: mockCreateMediaServerClient,
}));

vi.mock('../../services/plexGeoip.js', () => ({
  lookupGeoIP: vi.fn().mockResolvedValue({
    country: 'US',
    region: 'CA',
    city: 'Los Angeles',
    latitude: 34.0522,
    longitude: -118.2437,
    timezone: 'America/Los_Angeles',
  }),
}));

vi.mock('../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));

vi.mock('../../services/userService.js', () => ({
  getIdentityServerUserIds: mockGetIdentityServerUserIds,
  canonicalPlexExternalUserId: vi.fn(async (id: string) => id),
}));

vi.mock('../poller/index.js', () => ({
  triggerReconciliationPoll: vi.fn(),
}));

vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: mockMapMediaSession,
}));

vi.mock('../poller/stateTracker.js', () => ({
  calculatePauseAccumulation: vi.fn(),
  checkWatchCompletion: vi.fn(),
  detectMediaChange: mockDetectMediaChange,
  isPlaybackConfirmed: mockIsPlaybackConfirmed,
  createInitialConfirmationState: mockCreateInitialConfirmationState,
  updateConfirmationState: mockUpdateConfirmationState,
}));

vi.mock('../poller/database.js', () => ({
  getServerUserIdByExternalId: vi.fn(() => {
    throw new Error('getServerUserIdByExternalId not configured in this test');
  }),
  getActiveRulesV2: mockGetActiveRulesV2,
  batchGetRecentUserSessions: mockBatchGetRecentUserSessions,
  batchGetLibraryItemIdentity: mockBatchGetLibraryItemIdentity,
  mergeRecentSessionsForIdentity: (map: Map<string, unknown[]>, ids: string[]) =>
    ids.flatMap((id) => map.get(id) ?? []),
}));

vi.mock('../poller/violations.js', () => ({
  broadcastViolations: mockBroadcastViolations,
}));

vi.mock('../poller/sessionLifecycle.js', () => ({
  stopSessionAtomic: mockStopSessionAtomic,
  findActiveSession: mockFindActiveSession,
  findActiveSessionsAll: mockFindActiveSessionsAll,
  buildActiveSession: mockBuildActiveSession,
  buildPendingActiveSession: mockBuildPendingActiveSession,
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  confirmAndPersistSession: mockConfirmAndPersistSession,
}));

vi.mock('../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

// Import after mocking
import {
  initializeSSEProcessor,
  startSSEProcessor,
  stopSSEProcessor,
  cleanupOrphanedPendingSessions,
} from '../sseProcessor.js';

// Mock cache service with pending session methods
const mockCacheService = {
  getAllActiveSessions: vi.fn().mockResolvedValue([]),
  getSessionById: vi.fn(),
  addActiveSession: vi.fn(),
  updateActiveSession: vi.fn(),
  removeActiveSession: vi.fn(),
  invalidateDashboardStatsCache: vi.fn(),
  addUserSession: vi.fn(),
  removeUserSession: vi.fn(),
  withSessionCreateLock: vi.fn().mockImplementation(async (_s, _k, op) => op()),
  hasTerminationCooldown: vi.fn().mockResolvedValue(false),
  setTerminationCooldown: vi.fn(),
  hasTerminationCooldownComposite: vi.fn().mockResolvedValue(false),
  setTerminationCooldownComposite: vi.fn(),
  // Pending session methods
  getPendingSession: vi.fn().mockResolvedValue(null),
  setPendingSession: vi.fn(),
  deletePendingSession: vi.fn(),
  getAllPendingSessionKeys: vi.fn().mockResolvedValue([]),
};

const mockPubSubService = {
  publish: vi.fn(),
  subscribe: vi.fn(),
};

// Helper to create a mock pending session
function createMockPendingSession(overrides: Partial<PendingSessionData> = {}): PendingSessionData {
  const now = Date.now();
  const baseSession = {
    id: randomUUID(),
    confirmation: {
      confirmedPlayback: false,
      firstSeenAt: now,
      maxViewOffset: 0,
      initialViewOffset: null,
    },
    processed: {
      sessionKey: 'test-session-key',
      ratingKey: '12345',
      externalUserId: 'user-123',
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
      playerName: 'Test Player',
      deviceId: 'device-123',
      product: 'Plex for iOS',
      device: 'iPhone',
      platform: 'iOS',
      quality: '1080p',
      isTranscode: false,
      videoDecision: 'directplay',
      audioDecision: 'directplay',
      bitrate: 10000,
      state: 'playing',
      totalDurationMs: 7200000,
      progressMs: 0,
      plexSessionId: 'plex-session-123',
      // StreamDetailFields (all nullable for compatibility)
      sourceVideoCodec: 'h264',
      sourceAudioCodec: 'aac',
      sourceAudioChannels: 2,
      sourceVideoWidth: 1920,
      sourceVideoHeight: 1080,
      sourceVideoDetails: null,
      sourceAudioDetails: null,
      streamVideoCodec: 'h264',
      streamAudioCodec: 'aac',
      streamVideoDetails: null,
      streamAudioDetails: null,
      transcodeInfo: null,
      subtitleInfo: null,
    },
    server: { id: 'server-123', name: 'Test Server', type: 'plex' },
    serverUser: {
      id: 'server-user-123',
      userId: 'identity-123',
      username: 'testuser',
      thumbUrl: null,
      identityName: 'Test User',
      trustScore: 100,
      lastActivityAt: new Date(),
      createdAt: new Date(),
      identityServerUserIds: ['server-user-123'],
    },
    geo: {
      city: 'Los Angeles',
      region: 'CA',
      country: 'US',
      countryCode: 'US',
      continent: 'NA',
      postal: '90001',
      lat: 34.0522,
      lon: -118.2437,
      asnNumber: null,
      asnOrganization: null,
    },
    startedAt: now,
    lastSeenAt: now,
    currentState: 'playing',
    pausedDurationMs: 0,
    lastPausedAt: null,
  };
  return { ...baseSession, ...overrides } as PendingSessionData;
}

describe('SSE Processor - Pending Session Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    initializeSSEProcessor(
      mockCacheService as unknown as Parameters<typeof initializeSSEProcessor>[0],
      mockPubSubService as unknown as Parameters<typeof initializeSSEProcessor>[1]
    );
    startSSEProcessor();
  });

  afterEach(() => {
    stopSSEProcessor();
    vi.useRealTimers();
  });

  describe('createNewSession - Pending Cache Entry', () => {
    it('marks the cached ActiveSession as pending before confirmation', async () => {
      const mockServerRow = {
        id: 'server-123',
        name: 'Test Server',
        type: 'plex',
        url: 'http://localhost:32400',
        token: 'test-token',
      };
      const mockServerUserRow = {
        id: 'server-user-123',
        userId: 'identity-123',
        username: 'testuser',
        thumbUrl: null,
        identityName: 'Test User',
        trustScore: 100,
        lastActivityAt: new Date(),
        createdAt: new Date(),
      };

      // fetchFullSession: db.select().from(servers).where().limit()
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockServerRow]),
          }),
        }),
      });
      // createNewSession: db.select({...}).from(serverUsers).innerJoin(users).where().limit()
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockServerUserRow]),
            }),
          }),
        }),
      });

      mockCreateMediaServerClient.mockReturnValueOnce({
        getSessions: vi
          .fn()
          .mockResolvedValue([{ sessionKey: 'test-session-key', ratingKey: '12345' }]),
      });
      mockMapMediaSession.mockReturnValueOnce({
        sessionKey: 'test-session-key',
        ratingKey: '12345',
        externalUserId: 'user-123',
        ipAddress: '192.168.1.100',
        mediaTitle: 'Test Movie',
        state: 'playing',
      });

      mockSseManager.emit('plex:session:playing', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 0 },
      });

      await vi.waitFor(() => {
        expect(mockCacheService.addActiveSession).toHaveBeenCalled();
      });

      const cachedSession = mockCacheService.addActiveSession.mock.calls[0]?.[0];
      expect(cachedSession?.pending).toBe(true);
    });

    it('stamps media identity on the pending session like the poller does', async () => {
      const mockServerRow = {
        id: 'server-123',
        name: 'Test Server',
        type: 'plex',
        url: 'http://localhost:32400',
        token: 'test-token',
      };
      const mockServerUserRow = {
        id: 'server-user-123',
        userId: 'identity-123',
        username: 'testuser',
        thumbUrl: null,
        identityName: 'Test User',
        trustScore: 100,
        lastActivityAt: new Date(),
        createdAt: new Date(),
      };

      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockServerRow]),
          }),
        }),
      });
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockServerUserRow]),
            }),
          }),
        }),
      });

      mockCreateMediaServerClient.mockReturnValueOnce({
        getSessions: vi
          .fn()
          .mockResolvedValue([{ sessionKey: 'test-session-key', ratingKey: '12345' }]),
      });
      mockMapMediaSession.mockReturnValueOnce({
        sessionKey: 'test-session-key',
        ratingKey: '12345',
        externalUserId: 'user-123',
        ipAddress: '192.168.1.100',
        mediaTitle: 'Test Movie',
        state: 'playing',
      });

      const identity = {
        mediaId: 'media-uuid-1',
        showMediaId: null,
        imdbId: 'tt1375666',
        tmdbId: 27205,
        tvdbId: null,
        parentRatingKey: null,
        grandparentRatingKey: null,
      };
      mockBatchGetLibraryItemIdentity.mockResolvedValueOnce(new Map([['12345', identity]]));

      mockSseManager.emit('plex:session:playing', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 0 },
      });

      await vi.waitFor(() => {
        expect(mockCacheService.setPendingSession).toHaveBeenCalled();
      });

      expect(mockBatchGetLibraryItemIdentity).toHaveBeenCalledWith('server-123', ['12345']);
      const pendingData = mockCacheService.setPendingSession.mock.calls[0]?.[2] as {
        processed: { identity?: unknown };
      };
      expect(pendingData.processed.identity).toEqual(identity);
    });
  });

  describe('handleStopped - Phantom Session Detection', () => {
    it('discards pending session when stopped before confirmation (phantom session)', async () => {
      const pendingSession = createMockPendingSession();
      // First call is handleStopped's own pending check; second is the in-lock
      // recheck inside discardPendingSession. Both see the entry present so the
      // discard removes it as a phantom.
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(pendingSession);

      // Emit stopped event
      mockSseManager.emit('plex:session:stopped', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 5000 },
      });

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockCacheService.deletePendingSession).toHaveBeenCalledWith(
          'server-123',
          'test-session-key'
        );
      });

      // Should NOT have tried to stop a DB session
      expect(mockFindActiveSessionsAll).not.toHaveBeenCalled();
      expect(mockStopSessionAtomic).not.toHaveBeenCalled();
    });

    it('persists a pending session with >= 15s of observed progress instead of discarding it', async () => {
      const pendingSession = createMockPendingSession({
        confirmation: {
          confirmedPlayback: false,
          firstSeenAt: Date.now(),
          maxViewOffset: 20000,
          initialViewOffset: 2000,
        },
      });
      // First call is handleStopped's own pending check, second is the
      // in-lock recheck inside confirmPendingSessionAndPersist; both must
      // see the entry still present for the persist to proceed.
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(pendingSession);

      mockConfirmAndPersistSession.mockResolvedValueOnce({
        insertedSession: {
          id: pendingSession.id,
          serverId: 'server-123',
          serverUserId: 'server-user-123',
          sessionKey: 'test-session-key',
          startedAt: new Date(),
          state: 'playing',
        },
        violationResults: [],
        qualityChange: null,
        referenceId: null,
        wasTerminatedByRule: false,
      });

      mockBuildActiveSession.mockReturnValueOnce({
        id: pendingSession.id,
        serverId: 'server-123',
        serverUserId: 'server-user-123',
        sessionKey: 'test-session-key',
      });

      const activeRow = {
        id: pendingSession.id,
        serverId: 'server-123',
        sessionKey: 'test-session-key',
        serverUserId: 'server-user-123',
      };
      // First call is confirmPendingSessionAndPersist's own race check (no
      // active session yet), second is handleStopped's post-persist lookup.
      mockFindActiveSession.mockResolvedValueOnce(null).mockResolvedValueOnce(activeRow);

      // Emit stopped event
      mockSseManager.emit('plex:session:stopped', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 20000 },
      });

      await vi.waitFor(() => {
        expect(mockConfirmAndPersistSession).toHaveBeenCalled();
      });

      // Should have finalized the just-persisted session, not discarded it as a phantom
      await vi.waitFor(() => {
        expect(mockStopSessionAtomic).toHaveBeenCalledWith({
          session: activeRow,
          stoppedAt: expect.any(Date),
        });
      });
    });

    it('stops the concurrently-persisted row when confirmPendingSessionAndPersist loses the create-lock race', async () => {
      const pendingSession = createMockPendingSession({
        confirmation: {
          confirmedPlayback: false,
          firstSeenAt: Date.now(),
          maxViewOffset: 20000,
          initialViewOffset: 2000,
        },
      });
      // First call is handleStopped's own pending check, second is the
      // in-lock recheck inside confirmPendingSessionAndPersist; both see the
      // entry present so the lock body reaches the existingActive check below.
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(pendingSession);

      const concurrentRow = {
        id: 'concurrent-session-id',
        serverId: 'server-123',
        sessionKey: 'test-session-key',
        serverUserId: 'server-user-123',
      };

      // The existingActive check inside confirmPendingSessionAndPersist finds
      // a row a concurrent caller already created, so the lock body returns
      // null and confirmPendingSessionAndPersist resolves false without persisting.
      mockFindActiveSession.mockResolvedValueOnce(concurrentRow);

      // handleStopped must then fall through to the same lookup-and-stop
      // path used for already-confirmed sessions, closing the row the
      // concurrent caller created.
      mockFindActiveSessionsAll.mockResolvedValueOnce([concurrentRow]);

      mockSseManager.emit('plex:session:stopped', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 20000 },
      });

      await vi.waitFor(() => {
        expect(mockFindActiveSessionsAll).toHaveBeenCalledWith({
          serverId: 'server-123',
          sessionKey: 'test-session-key',
        });
      });

      await vi.waitFor(() => {
        expect(mockStopSessionAtomic).toHaveBeenCalledWith({
          session: concurrentRow,
          stoppedAt: expect.any(Date),
        });
      });

      // The lock body bailed before ever reaching persistence.
      expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
    });

    it('aborts the confirm when a concurrent discard wins the race before the lock recheck', async () => {
      const pendingSession = createMockPendingSession({
        confirmation: {
          confirmedPlayback: false,
          firstSeenAt: Date.now(),
          maxViewOffset: 20000,
          initialViewOffset: 2000,
        },
      });
      // First call is handleStopped's own pending check (entry still there).
      // Second call is the in-lock recheck inside confirmPendingSessionAndPersist,
      // by which point a concurrent phantom-discard has already deleted the entry.
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(null);

      mockSseManager.emit('plex:session:stopped', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 20000 },
      });

      await vi.waitFor(() => {
        expect(mockCacheService.withSessionCreateLock).toHaveBeenCalled();
      });

      await vi.waitFor(() => {
        expect(mockCacheService.getPendingSession).toHaveBeenCalledTimes(2);
      });

      // The lock body must bail on the recheck, before persisting or touching the cache.
      expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
      expect(mockCacheService.deletePendingSession).not.toHaveBeenCalled();
      expect(mockCacheService.updateActiveSession).not.toHaveBeenCalled();
      expect(mockCacheService.addActiveSession).not.toHaveBeenCalled();

      // confirmPendingSessionAndPersist resolved false, so handleStopped falls
      // through to the lookup-and-stop path just like the create-lock-race case.
      expect(mockFindActiveSessionsAll).toHaveBeenCalledWith({
        serverId: 'server-123',
        sessionKey: 'test-session-key',
      });
    });

    it('closes the persisted row through the stop path when a discard loses the race to a concurrent confirm', async () => {
      // Age > 30s but observed progress < 15s: a progress event can confirm+
      // persist this session while a concurrent stopped event tries to discard
      // it as a phantom. The discard must not evict the just-confirmed session.
      const pendingSession = createMockPendingSession({
        confirmation: {
          confirmedPlayback: false,
          firstSeenAt: Date.now(),
          maxViewOffset: 10000,
          initialViewOffset: 2000,
        },
      });

      // handleStopped's own pending check still sees the entry (progress < 15s
      // routes it to discardPendingSession). By the time the discard takes the
      // lock and rechecks, a concurrent confirm has already persisted the row
      // and deleted the pending entry.
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(null);

      const persistedRow = {
        id: pendingSession.id,
        serverId: 'server-123',
        sessionKey: 'test-session-key',
        serverUserId: 'server-user-123',
      };
      mockFindActiveSessionsAll.mockResolvedValueOnce([persistedRow]);

      mockSseManager.emit('plex:session:stopped', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 10000 },
      });

      // The discard found no pending entry, so it must fall through to the
      // normal stop path and close the concurrently-persisted row instead of
      // bare-evicting the freshly confirmed session.
      await vi.waitFor(() => {
        expect(mockFindActiveSessionsAll).toHaveBeenCalledWith({
          serverId: 'server-123',
          sessionKey: 'test-session-key',
        });
      });

      await vi.waitFor(() => {
        expect(mockStopSessionAtomic).toHaveBeenCalledWith({
          session: persistedRow,
          stoppedAt: expect.any(Date),
        });
      });
    });

    it('discards a pending session with < 15s of observed progress when stopped', async () => {
      const pendingSession = createMockPendingSession({
        confirmation: {
          confirmedPlayback: false,
          firstSeenAt: Date.now(),
          maxViewOffset: 10000,
          initialViewOffset: 2000,
        },
      });
      // First call is handleStopped's own pending check; second is the in-lock
      // recheck inside discardPendingSession. Both see the entry present so the
      // discard removes it as a phantom.
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(pendingSession);

      // Emit stopped event
      mockSseManager.emit('plex:session:stopped', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 10000 },
      });

      await vi.waitFor(() => {
        expect(mockCacheService.deletePendingSession).toHaveBeenCalledWith(
          'server-123',
          'test-session-key'
        );
      });

      expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
      expect(mockFindActiveSessionsAll).not.toHaveBeenCalled();
      expect(mockStopSessionAtomic).not.toHaveBeenCalled();
    });

    it('stops confirmed session normally when stopped', async () => {
      const confirmedSession = {
        id: 'session-id-123',
        serverId: 'server-123',
        sessionKey: 'test-session-key',
        serverUserId: 'server-user-123',
      };

      // No pending session
      mockCacheService.getPendingSession.mockResolvedValueOnce(null);
      // Has confirmed session in DB
      mockFindActiveSessionsAll.mockResolvedValueOnce([confirmedSession]);

      // Emit stopped event
      mockSseManager.emit('plex:session:stopped', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 60000 },
      });

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockFindActiveSessionsAll).toHaveBeenCalledWith({
          serverId: 'server-123',
          sessionKey: 'test-session-key',
        });
      });

      // Should have tried to stop the DB session
      expect(mockStopSessionAtomic).toHaveBeenCalledWith({
        session: confirmedSession,
        stoppedAt: expect.any(Date),
      });
    });
  });

  describe('handlePlaying - Pending Session Updates', () => {
    it('updates pending session state on resume from pause', async () => {
      const pendingSession = createMockPendingSession({
        currentState: 'paused',
        lastPausedAt: Date.now() - 5000,
      });
      mockCacheService.getPendingSession.mockResolvedValueOnce(pendingSession);
      mockIsPlaybackConfirmed.mockReturnValueOnce(false);

      // Emit playing event (resume)
      mockSseManager.emit('plex:session:playing', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 10000 },
      });

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockCacheService.setPendingSession).toHaveBeenCalled();
      });

      // Should have updated the pending session
      const callArgs = mockCacheService.setPendingSession.mock.calls[0];
      expect(callArgs?.[0]).toBe('server-123');
      expect(callArgs?.[1]).toBe('test-session-key');
      // State should be updated to playing
      const updatedData = callArgs?.[2] as PendingSessionData;
      expect(updatedData.currentState).toBe('playing');
    });
  });

  describe('handlePaused - Pending Session Updates', () => {
    it('updates pending session state to paused', async () => {
      const pendingSession = createMockPendingSession({
        currentState: 'playing',
      });
      mockCacheService.getPendingSession.mockResolvedValueOnce(pendingSession);
      mockIsPlaybackConfirmed.mockReturnValueOnce(false);

      // Emit paused event
      mockSseManager.emit('plex:session:paused', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 10000 },
      });

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockCacheService.setPendingSession).toHaveBeenCalled();
      });

      // Should have updated the pending session
      const callArgs = mockCacheService.setPendingSession.mock.calls[0];
      const updatedData = callArgs?.[2] as PendingSessionData;
      expect(updatedData.currentState).toBe('paused');
      expect(updatedData.lastPausedAt).not.toBeNull();
    });
  });

  describe('handleProgress - Confirmation Threshold', () => {
    it('confirms pending session when viewOffset exceeds 30s threshold', async () => {
      const pendingSession = createMockPendingSession();
      // First call is handleProgress's own pending check, second is the
      // in-lock recheck inside confirmPendingSessionAndPersist.
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(pendingSession);

      // First call returns true (threshold exceeded)
      mockIsPlaybackConfirmed.mockReturnValueOnce(true);

      // Mock confirmation result
      mockConfirmAndPersistSession.mockResolvedValueOnce({
        insertedSession: {
          id: 'inserted-session-123',
          serverId: 'server-123',
          serverUserId: 'server-user-123',
          sessionKey: 'test-session-key',
          startedAt: new Date(),
          state: 'playing',
        },
        violationResults: [],
        qualityChange: null,
        referenceId: null,
        wasTerminatedByRule: false,
      });

      mockBuildActiveSession.mockReturnValueOnce({
        id: 'inserted-session-123',
        serverId: 'server-123',
        serverUserId: 'server-user-123',
        sessionKey: 'test-session-key',
      });

      // Emit progress event with viewOffset > 30s
      mockSseManager.emit('plex:session:progress', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 35000 },
      });

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockCacheService.deletePendingSession).toHaveBeenCalledWith(
          'server-123',
          'test-session-key'
        );
      });

      // Should have called confirmAndPersistSession
      await vi.waitFor(() => {
        expect(mockConfirmAndPersistSession).toHaveBeenCalled();
      });

      // Should have updated the session in cache (same ID, just confirming status)
      expect(mockCacheService.updateActiveSession).toHaveBeenCalled();

      // Confirmed sessions carry no pending flag, so rule evaluation counts them
      const confirmedSession = mockCacheService.updateActiveSession.mock.calls[0]?.[0];
      expect(confirmedSession?.pending).toBeUndefined();
    });

    it('publishes session:stopped exactly once when a kill_stream rule terminates the session being confirmed', async () => {
      const pendingSession = createMockPendingSession();
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(pendingSession);

      mockIsPlaybackConfirmed.mockReturnValueOnce(true);

      // In production, confirmAndPersistSession runs the kill_stream action
      // (via createSessionWithRulesAtomic's post-commit side effects) before
      // returning, so termination.ts's own session:stopped publish has
      // already fired by the time this resolves.
      mockConfirmAndPersistSession.mockImplementationOnce(async () => {
        await mockPubSubService.publish('session:stopped', pendingSession.id);
        return {
          insertedSession: {
            id: pendingSession.id,
            serverId: 'server-123',
            serverUserId: 'server-user-123',
            sessionKey: 'test-session-key',
            startedAt: new Date(),
            state: 'playing',
          },
          violationResults: [],
          qualityChange: null,
          referenceId: null,
          wasTerminatedByRule: true,
        };
      });

      mockSseManager.emit('plex:session:progress', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 35000 },
      });

      await vi.waitFor(() => {
        expect(mockCacheService.deletePendingSession).toHaveBeenCalledWith(
          'server-123',
          'test-session-key'
        );
      });

      await vi.waitFor(() => {
        expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith(pendingSession.id);
      });

      const stoppedCalls = mockPubSubService.publish.mock.calls.filter(
        ([event]) => event === 'session:stopped'
      );
      expect(stoppedCalls).toHaveLength(1);
    });

    it('leaves the pending entry in Redis when the create lock is contended', async () => {
      const pendingSession = createMockPendingSession();
      mockCacheService.getPendingSession.mockResolvedValueOnce(pendingSession);

      mockIsPlaybackConfirmed.mockReturnValueOnce(true);

      // Lock contended: another caller holds it, so the lock body never runs.
      mockCacheService.withSessionCreateLock.mockResolvedValueOnce(null);

      mockSseManager.emit('plex:session:progress', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 35000 },
      });

      await vi.waitFor(() => {
        expect(mockCacheService.withSessionCreateLock).toHaveBeenCalled();
      });

      // Lock body never ran, so nothing was persisted and the pending entry
      // must still exist in Redis for a later caller to confirm.
      expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
      expect(mockCacheService.deletePendingSession).not.toHaveBeenCalled();
    });

    it('keeps session pending when viewOffset below threshold', async () => {
      const pendingSession = createMockPendingSession();
      mockCacheService.getPendingSession.mockResolvedValueOnce(pendingSession);

      // Below threshold
      mockIsPlaybackConfirmed.mockReturnValueOnce(false);

      // Emit progress event with viewOffset < 30s
      mockSseManager.emit('plex:session:progress', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 15000 },
      });

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockCacheService.setPendingSession).toHaveBeenCalled();
      });

      // Should NOT have called confirmAndPersistSession
      expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
      // Should NOT have deleted the pending session
      expect(mockCacheService.deletePendingSession).not.toHaveBeenCalled();
    });
  });

  describe('handlePlaying - Media Change on Pending Session', () => {
    // Helper to setup db mock to return server data
    const setupDbForFetchSession = () => {
      const mockServer = {
        id: 'server-123',
        name: 'Test Server',
        type: 'plex',
        url: 'http://localhost:32400',
        token: 'test-token',
      };
      const mockServerUserRow = {
        id: 'server-user-123',
        userId: 'identity-123',
        username: 'testuser',
        thumbUrl: null,
        identityName: 'Test User',
        trustScore: 100,
        lastActivityAt: new Date(),
        createdAt: new Date(),
      };
      // fetchFullSession: db.select().from(servers).where().limit()
      // createNewSession: db.select({...}).from(serverUsers).innerJoin(users).where().limit()
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockServer]),
          }),
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockServerUserRow]),
            }),
          }),
        }),
      });
      return mockServer;
    };

    it('discards old pending session and creates new one when media changes', async () => {
      const pendingSession = createMockPendingSession({
        processed: {
          ...createMockPendingSession().processed,
          ratingKey: 'old-rating-key',
          mediaTitle: 'Episode 1',
        },
      });
      // First call is handlePlaying's own pending check; second is the in-lock
      // recheck inside discardPendingSession when the media-change discard runs.
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(pendingSession);

      // Setup db to return server
      setupDbForFetchSession();

      // Setup media server client mock to return new media
      const mockGetSessions = vi
        .fn()
        .mockResolvedValue([{ sessionKey: 'test-session-key', ratingKey: 'new-rating-key' }]);
      mockCreateMediaServerClient.mockReturnValueOnce({ getSessions: mockGetSessions });

      // Map the new session data
      mockMapMediaSession.mockReturnValueOnce({
        sessionKey: 'test-session-key',
        ratingKey: 'new-rating-key',
        mediaTitle: 'Episode 2',
        externalUserId: 'user-123',
        state: 'playing',
      });

      // detectMediaChange returns true for different ratingKeys
      mockDetectMediaChange.mockReturnValueOnce(true);

      // Emit playing event
      mockSseManager.emit('plex:session:playing', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 5000 },
      });

      // Wait for async handler to discard old session
      await vi.waitFor(() => {
        expect(mockCacheService.deletePendingSession).toHaveBeenCalledWith(
          'server-123',
          'test-session-key'
        );
      });

      // Should have removed old session from active cache
      expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith(pendingSession.id);

      // Should have called detectMediaChange with ratingKeys and liveUuids
      // Note: liveUuid is null for both since test fixtures don't have Live TV sessions
      expect(mockDetectMediaChange).toHaveBeenCalledWith(
        'old-rating-key',
        'new-rating-key',
        null,
        undefined
      );

      // Should have created a fresh pending session for the new media, not
      // silently dropped it after discarding the old one.
      await vi.waitFor(() => {
        expect(mockCacheService.setPendingSession).toHaveBeenCalledWith(
          'server-123',
          'test-session-key',
          expect.objectContaining({
            processed: expect.objectContaining({ ratingKey: 'new-rating-key' }),
          })
        );
      });

      await vi.waitFor(() => {
        expect(mockCacheService.addActiveSession).toHaveBeenCalledWith(
          expect.objectContaining({ mediaTitle: 'Episode 2', pending: true })
        );
      });
    });

    it('updates pending session normally when media has not changed', async () => {
      const pendingSession = createMockPendingSession();
      mockCacheService.getPendingSession.mockResolvedValueOnce(pendingSession);

      // Setup db to return server
      setupDbForFetchSession();

      // Setup media server client mock to return same media
      const mockGetSessions = vi
        .fn()
        .mockResolvedValue([{ sessionKey: 'test-session-key', ratingKey: '12345' }]);
      mockCreateMediaServerClient.mockReturnValueOnce({ getSessions: mockGetSessions });
      mockMapMediaSession.mockReturnValueOnce({
        sessionKey: 'test-session-key',
        ratingKey: '12345', // Same as pending session
        mediaTitle: 'Test Movie',
        state: 'playing',
      });

      // detectMediaChange returns false for same ratingKey
      mockDetectMediaChange.mockReturnValueOnce(false);
      mockIsPlaybackConfirmed.mockReturnValueOnce(false);

      // Emit playing event
      mockSseManager.emit('plex:session:playing', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 10000 },
      });

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockCacheService.setPendingSession).toHaveBeenCalled();
      });

      // Should NOT have discarded the session
      expect(mockCacheService.removeActiveSession).not.toHaveBeenCalled();
    });
  });

  describe('cross-user sessionKey reuse guard', () => {
    const setupDbForCreate = () => {
      const mockServer = {
        id: 'server-123',
        name: 'Test Server',
        type: 'plex',
        url: 'http://localhost:32400',
        token: 'test-token',
      };
      const mockServerUserRow = {
        id: 'server-user-123',
        userId: 'identity-123',
        username: 'testuser',
        thumbUrl: null,
        identityName: 'Test User',
        trustScore: 100,
        lastActivityAt: new Date(),
        createdAt: new Date(),
      };
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockServer]),
          }),
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([mockServerUserRow]),
            }),
          }),
        }),
      });
    };

    it('createNewSession creates fresh when the in-lock row belongs to another user', async () => {
      setupDbForCreate();
      mockCreateMediaServerClient.mockReturnValueOnce({
        getSessions: vi
          .fn()
          .mockResolvedValue([{ sessionKey: 'test-session-key', ratingKey: '12345' }]),
      });
      mockMapMediaSession.mockReturnValueOnce({
        sessionKey: 'test-session-key',
        ratingKey: '12345',
        externalUserId: 'user-123',
        ipAddress: '192.168.1.100',
        mediaTitle: 'Test Movie',
        state: 'playing',
      });

      // handlePlaying's own lookup finds nothing; the in-lock recheck inside
      // createNewSession finds a stale open row that Plex reassigned this
      // sessionKey to - but it belongs to a different server user.
      mockFindActiveSession
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'stale-id', serverUserId: 'other-user' });

      mockSseManager.emit('plex:session:playing', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 0 },
      });

      // The foreign row must not block creation - this user gets a fresh pending
      // session instead of being silently dropped.
      await vi.waitFor(() => {
        expect(mockCacheService.setPendingSession).toHaveBeenCalled();
      });
      expect(mockCacheService.addActiveSession).toHaveBeenCalled();
    });

    it('createNewSession skips when the in-lock row belongs to the same user', async () => {
      setupDbForCreate();
      mockCreateMediaServerClient.mockReturnValueOnce({
        getSessions: vi
          .fn()
          .mockResolvedValue([{ sessionKey: 'test-session-key', ratingKey: '12345' }]),
      });
      mockMapMediaSession.mockReturnValueOnce({
        sessionKey: 'test-session-key',
        ratingKey: '12345',
        externalUserId: 'user-123',
        ipAddress: '192.168.1.100',
        mediaTitle: 'Test Movie',
        state: 'playing',
      });

      mockFindActiveSession
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'same-id', serverUserId: 'server-user-123' });

      mockSseManager.emit('plex:session:playing', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 0 },
      });

      await vi.waitFor(() => {
        expect(mockFindActiveSession).toHaveBeenCalledTimes(2);
      });
      // Same-user row is a genuine duplicate: no second create.
      expect(mockCacheService.setPendingSession).not.toHaveBeenCalled();
      expect(mockCacheService.addActiveSession).not.toHaveBeenCalled();
    });

    it('confirmPendingSessionAndPersist persists when the in-lock row belongs to another user', async () => {
      const pendingSession = createMockPendingSession();
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(pendingSession);
      mockIsPlaybackConfirmed.mockReturnValueOnce(true);

      // The in-lock recheck finds a stale open row under a different user.
      mockFindActiveSession.mockResolvedValueOnce({
        id: 'stale-id',
        serverUserId: 'other-user',
      });

      mockConfirmAndPersistSession.mockResolvedValueOnce({
        insertedSession: {
          id: pendingSession.id,
          serverId: 'server-123',
          serverUserId: 'server-user-123',
          sessionKey: 'test-session-key',
          startedAt: new Date(),
          state: 'playing',
        },
        violationResults: [],
        qualityChange: null,
        referenceId: null,
        wasTerminatedByRule: false,
      });
      mockBuildActiveSession.mockReturnValueOnce({
        id: pendingSession.id,
        serverId: 'server-123',
        serverUserId: 'server-user-123',
        sessionKey: 'test-session-key',
      });

      mockSseManager.emit('plex:session:progress', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 35000 },
      });

      // The foreign row must not abort the confirm - this play still persists.
      await vi.waitFor(() => {
        expect(mockConfirmAndPersistSession).toHaveBeenCalled();
      });
    });

    it('confirmPendingSessionAndPersist bails when the in-lock row belongs to the same user', async () => {
      const pendingSession = createMockPendingSession();
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(pendingSession)
        .mockResolvedValueOnce(pendingSession);
      mockIsPlaybackConfirmed.mockReturnValueOnce(true);

      mockFindActiveSession.mockResolvedValueOnce({
        id: 'same-id',
        serverUserId: 'server-user-123',
      });

      mockSseManager.emit('plex:session:progress', {
        serverId: 'server-123',
        notification: { sessionKey: 'test-session-key', viewOffset: 35000 },
      });

      // Same-user row means a concurrent caller already persisted: bail and drop
      // the pending entry instead of double-persisting.
      await vi.waitFor(() => {
        expect(mockCacheService.deletePendingSession).toHaveBeenCalledWith(
          'server-123',
          'test-session-key'
        );
      });
      expect(mockConfirmAndPersistSession).not.toHaveBeenCalled();
    });
  });

  describe('cleanupOrphanedPendingSessions', () => {
    it('cleans up all orphaned pending sessions on startup', async () => {
      const orphanedSession1 = createMockPendingSession({ id: 'orphan-1' });
      const orphanedSession2 = createMockPendingSession({ id: 'orphan-2' });

      mockCacheService.getAllPendingSessionKeys.mockResolvedValueOnce([
        { serverId: 'server-123', sessionKey: 'session-1' },
        { serverId: 'server-123', sessionKey: 'session-2' },
      ]);
      mockCacheService.getPendingSession
        .mockResolvedValueOnce(orphanedSession1)
        .mockResolvedValueOnce(orphanedSession2);

      await cleanupOrphanedPendingSessions();

      // Should have cleaned up both sessions
      expect(mockCacheService.deletePendingSession).toHaveBeenCalledTimes(2);
      expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith('orphan-1', {
        skipDashboardInvalidation: true,
      });
      expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith('orphan-2', {
        skipDashboardInvalidation: true,
      });
      // One flush after the loop instead of one SCAN per removed session
      expect(mockCacheService.invalidateDashboardStatsCache).toHaveBeenCalledOnce();
    });

    it('handles no orphaned sessions gracefully', async () => {
      mockCacheService.getAllPendingSessionKeys.mockResolvedValueOnce([]);

      await cleanupOrphanedPendingSessions();

      // Should not have tried to delete anything
      expect(mockCacheService.deletePendingSession).not.toHaveBeenCalled();
      expect(mockCacheService.invalidateDashboardStatsCache).not.toHaveBeenCalled();
    });

    it('swallows a dashboard invalidation failure so startup keeps wiring up SSE', async () => {
      const orphan = createMockPendingSession({ id: 'orphan-1' });
      mockCacheService.getAllPendingSessionKeys.mockResolvedValueOnce([
        { serverId: 'server-123', sessionKey: 'session-1' },
      ]);
      mockCacheService.getPendingSession.mockResolvedValueOnce(orphan);
      mockCacheService.invalidateDashboardStatsCache.mockRejectedValueOnce(new Error('redis down'));

      // This runs before startSSEProcessor and sseManager.start in index.ts. A
      // rejected promise here would skip both and leave SSE dead until restart,
      // so the failure must degrade to a logged error, not propagate.
      await expect(cleanupOrphanedPendingSessions()).resolves.toBeUndefined();
    });
  });
});
