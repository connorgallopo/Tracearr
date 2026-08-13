/**
 * SSE Processor Tests - Update Guard Against Stop Races
 *
 * An SSE stop landing between findActiveSession's read and updateExistingSession's
 * write must not resurrect the session: the write needs a liveness condition, and
 * a zero-row result must skip the cache update (otherwise the cache shows a
 * stopped session as active, and the next poll tick mints a duplicate DB row).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';

const {
  mockSseManager,
  mockFindActiveSession,
  mockMapMediaSession,
  mockCreateMediaServerClient,
  mockCalculatePauseAccumulation,
  mockDb,
  mockUpdateReturning,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events');

  const updateReturning = vi.fn().mockResolvedValue([]);

  return {
    mockSseManager: new EE() as EventEmitter,
    mockFindActiveSession: vi.fn(),
    mockMapMediaSession: vi.fn(),
    mockCreateMediaServerClient: vi.fn(),
    mockCalculatePauseAccumulation: vi.fn(),
    mockUpdateReturning: updateReturning,
    mockDb: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: 'server-1',
                name: 'Test Server',
                type: 'plex',
                url: 'http://localhost:32400',
                token: 'test-token',
              },
            ]),
          }),
        }),
      }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: updateReturning })),
        })),
      })),
    },
  };
});

vi.mock('../../services/sseManager.js', () => ({ sseManager: mockSseManager }));
vi.mock('../notificationQueue.js', () => ({
  enqueueNotification: vi.fn().mockResolvedValue('id'),
}));
vi.mock('../../db/client.js', () => ({ db: mockDb }));
vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: mockCreateMediaServerClient,
}));
vi.mock('../../services/plexGeoip.js', () => ({ lookupGeoIP: vi.fn() }));
vi.mock('../../services/userService.js', () => ({
  getIdentityServerUserIds: vi.fn().mockResolvedValue(['server-user-1']),
  canonicalPlexExternalUserId: vi.fn(async (id: string) => id),
}));
vi.mock('../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));
vi.mock('../poller/index.js', () => ({ triggerReconciliationPoll: vi.fn() }));
vi.mock('../poller/processor.js', () => ({
  gracePeriodSessionIds: vi.fn().mockReturnValue(new Set()),
}));
vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: mockMapMediaSession,
  pickStreamDetailFields: vi.fn().mockImplementation((s) => s),
}));
vi.mock('../poller/stateTracker.js', () => ({
  calculatePauseAccumulation: mockCalculatePauseAccumulation,
  checkWatchCompletion: vi.fn().mockReturnValue(false),
  detectMediaChange: vi.fn().mockReturnValue(false),
  isPlaybackConfirmed: vi.fn().mockReturnValue(false),
  createInitialConfirmationState: vi.fn().mockReturnValue({
    confirmedPlayback: false,
    firstSeenAt: Date.now(),
    maxViewOffset: 0,
  }),
  updateConfirmationState: vi.fn().mockImplementation((state) => state),
}));
vi.mock('../poller/database.js', () => ({
  getActiveRulesV2: vi.fn().mockResolvedValue([]),
  // Matches the existing row's serverUserId so the paused-event cross-user
  // guard lets these updates through.
  getServerUserIdByExternalId: vi.fn().mockResolvedValue('server-user-1'),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  mergeRecentSessionsForIdentity: vi.fn().mockReturnValue([]),
}));
vi.mock('../poller/dbWriteThrottle.js', () => ({
  clearDbWriteTracking: vi.fn(),
  recordDbWrite: vi.fn(),
  shouldFlushDbWrite: vi.fn().mockReturnValue(false),
}));
vi.mock('../poller/violations.js', () => ({ broadcastViolations: vi.fn() }));
vi.mock('../poller/sessionLifecycle.js', () => ({
  stopSessionAtomic: vi.fn(),
  findActiveSession: mockFindActiveSession,
  findActiveSessionsAll: vi.fn().mockResolvedValue([]),
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  reEvaluateRulesOnPauseState: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  confirmAndPersistSession: vi.fn(),
}));
vi.mock('../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../sseProcessor.js';

const EXISTING_SESSION_ID = 'session-paused-1';

const existingSession = {
  id: EXISTING_SESSION_ID,
  serverId: 'server-1',
  serverUserId: 'server-user-1',
  sessionKey: 'sess-key-1',
  ratingKey: '1001',
  mediaType: 'movie',
  state: 'playing' as const,
  startedAt: new Date(Date.now() - 60_000),
  lastPausedAt: null,
  pausedDurationMs: 0,
  watched: true, // already watched: skips the watch-completion recompute branch
  totalDurationMs: 3_600_000,
  videoDecision: 'directplay',
  audioDecision: 'directplay',
};

const mockCacheService = {
  getSessionById: vi.fn(),
  getAllActiveSessions: vi.fn().mockResolvedValue([]),
  updateActiveSession: vi.fn(),
  hasTerminationCooldown: vi.fn().mockResolvedValue(false),
  getPendingSession: vi.fn().mockResolvedValue(null),
};

const mockPubSubService = {
  publish: vi.fn(),
  subscribe: vi.fn(),
};

describe('SSE Processor - updateExistingSession guard against stop races', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSseManager.removeAllListeners();
    mockUpdateReturning.mockResolvedValue([]);

    mockFindActiveSession.mockResolvedValue(existingSession);
    mockCalculatePauseAccumulation.mockReturnValue({ lastPausedAt: null, pausedDurationMs: 0 });
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([{ sessionKey: 'sess-key-1' }]),
    });
    mockMapMediaSession.mockReturnValue({
      sessionKey: 'sess-key-1',
      ratingKey: '1001',
      quality: '1080p',
      bitrate: 5000,
      progressMs: 20_000,
      isTranscode: false,
      videoDecision: 'directplay',
      audioDecision: 'directplay',
      totalDurationMs: 3_600_000,
      sourceVideoCodec: null,
      sourceAudioCodec: null,
    });

    mockCacheService.getSessionById.mockResolvedValue({
      id: EXISTING_SESSION_ID,
      state: 'playing',
    });

    initializeSSEProcessor(mockCacheService as never, mockPubSubService as never);
    startSSEProcessor();
  });

  afterEach(() => {
    stopSSEProcessor();
  });

  async function emitPaused(): Promise<void> {
    mockSseManager.emit('plex:session:paused', {
      serverId: 'server-1',
      notification: { sessionKey: 'sess-key-1', viewOffset: 20_000 },
    });
    await vi.waitFor(() => {
      expect(mockDb.update).toHaveBeenCalled();
    });
    // Let the microtask queue drain past the update's .then chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('does not touch the cache when the update affects zero rows (already stopped)', async () => {
    mockUpdateReturning.mockResolvedValue([]);

    await emitPaused();

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockCacheService.updateActiveSession).not.toHaveBeenCalled();
    expect(mockPubSubService.publish).not.toHaveBeenCalledWith(
      'session:updated',
      expect.anything()
    );
  });

  it('updates the cache normally when the update affects a row', async () => {
    mockUpdateReturning.mockResolvedValue([{ id: EXISTING_SESSION_ID }]);

    await emitPaused();

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockCacheService.updateActiveSession).toHaveBeenCalledTimes(1);
  });
});
