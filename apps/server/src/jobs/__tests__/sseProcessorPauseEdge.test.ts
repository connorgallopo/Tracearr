/**
 * The SSE processor dispatches session.paused on the playing→paused edge only;
 * the scheduled wakes carry the re-evaluation while the session stays paused.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';

const {
  mockSseManager,
  mockFindActiveSession,
  mockMapMediaSession,
  mockCreateMediaServerClient,
  mockCalculatePauseAccumulation,
  mockLoadEvaluationContext,
  mockGetActiveAutomations,
  mockDb,
  mockUpdateReturning,
  mockDispatch,
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
    mockLoadEvaluationContext: vi.fn(),
    mockGetActiveAutomations: vi.fn(),
    mockUpdateReturning: updateReturning,
    mockDispatch: vi.fn().mockResolvedValue({ violations: [], outcomes: [] }),
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
}));
vi.mock('../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));
vi.mock('../poller/index.js', () => ({
  triggerReconciliationPoll: vi.fn(),
  isPollerRunning: () => true,
}));
vi.mock('../poller/processor.js', () => ({
  gracePeriodSessionIds: vi.fn().mockReturnValue(new Set()),
}));
vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: mockMapMediaSession,
  pickLiveSessionFields: vi.fn().mockImplementation((s) => s),
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
  getActiveAutomations: mockGetActiveAutomations,
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
  confirmAndPersistSession: vi.fn(),
}));
vi.mock('../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));
vi.mock('../../services/automations/events/contextAssembly.js', () => ({
  loadEvaluationContext: mockLoadEvaluationContext,
  loadEvaluationServerUser: vi.fn().mockResolvedValue(null),
  toRuleSession: vi.fn().mockImplementation((session, overrides) => ({ ...session, ...overrides })),
  assembleEvaluationInputs: vi.fn().mockResolvedValue({
    activeAutomations: [],
    activeSessions: [],
    recentSessions: [],
    identityServerUserIds: [],
  }),
  setContextAssemblyDeps: vi.fn(),
}));
vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));
vi.mock('../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

import { shouldFlushDbWrite } from '../poller/dbWriteThrottle.js';
import { checkWatchCompletion } from '../poller/stateTracker.js';
import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../sseProcessor.js';

const EXISTING_SESSION_ID = 'session-paused-1';

function existingSession(state: 'playing' | 'paused') {
  return {
    id: EXISTING_SESSION_ID,
    serverId: 'server-1',
    serverUserId: 'server-user-1',
    sessionKey: 'sess-key-1',
    ratingKey: '1001',
    deviceId: 'device-1',
    mediaType: 'movie',
    state,
    startedAt: new Date(Date.now() - 60_000),
    lastPausedAt: state === 'paused' ? new Date(Date.now() - 30_000) : null,
    pausedDurationMs: 0,
    watched: true, // already watched: skips the watch-completion recompute branch
    totalDurationMs: 3_600_000,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
  };
}

const evaluationContext = {
  server: { id: 'server-1', name: 'S', type: 'plex' },
  serverUser: {
    id: 'server-user-1',
    userId: 'u1',
    username: 'x',
    thumbUrl: null,
    identityName: null,
    trustScore: 100,
    lastActivityAt: null,
    createdAt: new Date(),
    identityServerUserIds: [],
  },
  inputs: {
    activeAutomations: [{ id: 'rule-1' }],
    activeSessions: [],
    recentSessions: [],
    identityServerUserIds: [],
  },
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

describe('SSE processor pause edge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSseManager.removeAllListeners();
    mockUpdateReturning.mockResolvedValue([{ id: EXISTING_SESSION_ID }]);

    mockGetActiveAutomations.mockResolvedValue([{ id: 'rule-1' }]);
    mockLoadEvaluationContext.mockResolvedValue(evaluationContext);
    mockCalculatePauseAccumulation.mockReturnValue({ lastPausedAt: null, pausedDurationMs: 0 });
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([{ sessionKey: 'sess-key-1' }]),
    });
    mockMapMediaSession.mockReturnValue({
      sessionKey: 'sess-key-1',
      ratingKey: '1001',
      mediaType: 'movie',
      externalUserId: 'user-123',
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

  async function emit(
    event: 'plex:session:paused' | 'plex:session:playing' | 'plex:session:progress',
    overrides: { state?: string } = {}
  ): Promise<void> {
    mockSseManager.emit(event, {
      serverId: 'server-1',
      notification: {
        sessionKey: 'sess-key-1',
        ratingKey: '1001',
        clientIdentifier: 'device-1',
        viewOffset: 20_000,
        ...overrides,
      },
    });
    await vi.waitFor(() => {
      expect(mockDb.update).toHaveBeenCalled();
    });
    // Let the microtask queue drain past the update's .then chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('dispatches session.paused once on the playing→paused edge', async () => {
    mockFindActiveSession.mockResolvedValue(existingSession('playing'));

    await emit('plex:session:paused');

    const types = mockDispatch.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types.filter((t) => t === 'session.paused')).toHaveLength(1);
    expect(types).not.toContain('session.resumed');
  });

  it('dispatches nothing for a paused→paused update', async () => {
    vi.mocked(shouldFlushDbWrite).mockReturnValueOnce(true);
    mockFindActiveSession.mockResolvedValue(existingSession('paused'));

    await emit('plex:session:paused');

    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('dispatches session.resumed on the paused→playing edge', async () => {
    mockFindActiveSession.mockResolvedValue(existingSession('paused'));

    await emit('plex:session:playing');

    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.resumed', sessionId: EXISTING_SESSION_ID })
    );
    const types = mockDispatch.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).not.toContain('session.paused');
  });

  describe('session.watched', () => {
    const watchedRule = {
      id: 'rule-w',
      triggers: [{ id: 'node-w', type: 'session.watched', enabled: true }],
    };

    function watchedDispatches() {
      return mockDispatch.mock.calls
        .map((c) => c[0] as { type: string; session?: { watched: boolean } })
        .filter((e) => e.type === 'session.watched');
    }

    beforeEach(() => {
      mockGetActiveAutomations.mockResolvedValue([watchedRule]);
      vi.mocked(checkWatchCompletion).mockReturnValueOnce(true);
    });

    it('dispatches once when a progress tick crosses the threshold', async () => {
      mockFindActiveSession.mockResolvedValue({ ...existingSession('playing'), watched: false });

      await emit('plex:session:progress', { state: 'playing' });

      expect(watchedDispatches()).toHaveLength(1);
      expect(watchedDispatches()[0]?.session?.watched).toBe(true);
    });

    it('dispatches once when a state change crosses the threshold', async () => {
      mockFindActiveSession.mockResolvedValue({ ...existingSession('playing'), watched: false });

      await emit('plex:session:paused');

      expect(watchedDispatches()).toHaveLength(1);
    });
  });

  it('dispatches nothing when a paused row receives a buffering progress tick', async () => {
    vi.mocked(shouldFlushDbWrite).mockReturnValueOnce(true);
    mockFindActiveSession.mockResolvedValue(existingSession('paused'));

    await emit('plex:session:progress', { state: 'buffering' });

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockCalculatePauseAccumulation).not.toHaveBeenCalled();
  });
});
