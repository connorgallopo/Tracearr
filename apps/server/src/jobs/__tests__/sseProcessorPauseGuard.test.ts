/**
 * SSE Processor Tests - Cross-User SessionKey Guards on Pause/Stop
 *
 * Plex resets sessionKey counters on PMS restart, so a stale open row from one
 * user can carry the sessionKey another user's new play now uses. handlePlaying
 * guards against reusing the foreign row; these tests pin the same protection
 * onto handlePaused (user match via getServerUserIdByExternalId) and
 * handleStopped (ratingKey filter, since the session is no longer fetchable).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';

const {
  mockSseManager,
  mockEnqueueNotification,
  mockFindActiveSession,
  mockFindActiveSessionsAll,
  mockStopSessionAtomic,
  mockGetServerUserIdByExternalId,
  mockCreateMediaServerClient,
  mockDb,
  mockDispatch,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events');
  return {
    mockSseManager: new EE() as EventEmitter,
    mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
    mockFindActiveSession: vi.fn(),
    mockFindActiveSessionsAll: vi.fn().mockResolvedValue([]),
    mockStopSessionAtomic: vi.fn(),
    mockGetServerUserIdByExternalId: vi.fn(),
    mockCreateMediaServerClient: vi.fn(),
    mockDispatch: vi.fn().mockResolvedValue({ violations: [], outcomes: [] }),
    mockDb: {
      select: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock('../../services/sseManager.js', () => ({
  sseManager: mockSseManager,
}));

vi.mock('../notificationQueue.js', () => ({
  enqueueNotification: mockEnqueueNotification,
}));

vi.mock('../../db/client.js', () => ({
  db: mockDb,
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: mockCreateMediaServerClient,
}));

vi.mock('../../services/plexGeoip.js', () => ({
  lookupGeoIP: vi.fn().mockResolvedValue({ city: null, country: null }),
}));

vi.mock('../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));

vi.mock('../../services/settings.js', () => ({
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));

vi.mock('../../services/geoip.js', () => ({
  geoipService: { lookup: vi.fn() },
}));

vi.mock('../poller/index.js', () => ({
  triggerReconciliationPoll: vi.fn(),
  isPollerRunning: () => true,
}));

vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: vi.fn((session: unknown) => session),
}));

vi.mock('../poller/stateTracker.js', () => ({
  calculatePauseAccumulation: vi.fn().mockReturnValue({
    lastPausedAt: null,
    pausedDurationMs: 0,
  }),
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
  getActiveAutomations: vi.fn().mockResolvedValue([]),
  getServerUserIdByExternalId: mockGetServerUserIdByExternalId,
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  mergeRecentSessionsForIdentity: (map: Map<string, unknown[]>, ids: string[]) =>
    ids.flatMap((id) => map.get(id) ?? []),
}));

vi.mock('../poller/violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../poller/sessionLifecycle.js', () => ({
  stopSessionAtomic: mockStopSessionAtomic,
  findActiveSession: mockFindActiveSession,
  findActiveSessionsAll: mockFindActiveSessionsAll,
  buildActiveSession: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  confirmAndPersistSession: vi.fn(),
}));

vi.mock('../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));
vi.mock('../../services/automations/events/contextAssembly.js', () => ({
  loadEvaluationContext: vi.fn().mockResolvedValue(null),
  assembleEvaluationInputs: vi.fn().mockResolvedValue({
    activeAutomations: [],
    activeSessions: [],
    recentSessions: [],
    identityServerUserIds: [],
  }),
  setContextAssemblyDeps: vi.fn(),
}));

vi.mock('../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../sseProcessor.js';
import { fakePlexClient } from '../../test/mediaServerFakes.js';

const SERVER_ID = 'server-1';
const SESSION_KEY = 'sess-key-1';

const staleRow = {
  id: 'session-stale-1',
  serverId: SERVER_ID,
  serverUserId: 'server-user-A',
  sessionKey: SESSION_KEY,
  ratingKey: '1001',
  state: 'playing' as const,
  startedAt: new Date(Date.now() - 60_000),
  lastPausedAt: null,
  pausedDurationMs: 0,
  watched: false,
  totalDurationMs: 3_600_000,
  videoDecision: null,
  audioDecision: null,
};

const incomingPlexSession = {
  sessionKey: SESSION_KEY,
  externalUserId: 'plex-ext-B',
  ratingKey: '2002',
  mediaTitle: 'Other Movie',
  mediaType: 'movie',
  quality: '1080p',
  bitrate: 8000,
  progressMs: 90_000,
  totalDurationMs: 3_600_000,
  isTranscode: false,
  videoDecision: null,
  audioDecision: null,
};

const mockCacheService = {
  getAllActiveSessions: vi.fn().mockResolvedValue([]),
  getSessionById: vi.fn(),
  addActiveSession: vi.fn(),
  updateActiveSession: vi.fn(),
  removeActiveSession: vi.fn(),
  addUserSession: vi.fn(),
  removeUserSession: vi.fn(),
  withSessionCreateLock: vi.fn(),
  hasTerminationCooldown: vi.fn().mockResolvedValue(false),
  setTerminationCooldown: vi.fn(),
  getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
  clearTerminationCooldownsComposite: vi.fn(),
  setTerminationCooldownComposite: vi.fn(),
  getPendingSession: vi.fn().mockResolvedValue(null),
  setPendingSession: vi.fn(),
  deletePendingSession: vi.fn(),
  getAllPendingSessionKeys: vi.fn().mockResolvedValue([]),
  addSessionWriteRetry: vi.fn(),
};

const mockPubSubService = {
  publish: vi.fn(),
  subscribe: vi.fn(),
};

function setupDbSelectMock() {
  const limitFn = vi
    .fn()
    .mockResolvedValue([
      { id: SERVER_ID, name: 'Plex', type: 'plex', url: 'http://p', token: 't' },
    ]);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.select.mockReturnValue({ from: fromFn });
}

function setupDbUpdateMock(returning: unknown[] = [{ id: staleRow.id }]) {
  const returningFn = vi.fn().mockResolvedValue(returning);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.update.mockReturnValue({ set: setFn });
  return setFn;
}

async function flushHandlers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SSE Processor - cross-user guards on pause and stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSseManager.removeAllListeners();

    mockFindActiveSession.mockResolvedValue(staleRow);
    mockCacheService.getPendingSession.mockResolvedValue(null);
    mockCacheService.getSessionById.mockResolvedValue({ id: staleRow.id, progressMs: 0 });
    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({
        getSessions: vi.fn().mockResolvedValue([incomingPlexSession]),
      })
    );
    mockStopSessionAtomic.mockResolvedValue({
      wasUpdated: true,
      durationMs: 1000,
      needsRetry: false,
      retryData: undefined,
    });
    setupDbSelectMock();
    setupDbUpdateMock();

    initializeSSEProcessor(mockCacheService as never, mockPubSubService as never);
    startSSEProcessor();
  });

  afterEach(() => {
    stopSSEProcessor();
  });

  it('leaves a foreign user row untouched when a pause event hits its sessionKey', async () => {
    mockGetServerUserIdByExternalId.mockResolvedValue('server-user-B');

    mockSseManager.emit('plex:session:paused', {
      serverId: SERVER_ID,
      notification: { sessionKey: SESSION_KEY, ratingKey: '2002', state: 'paused' },
    });

    await vi.waitFor(() => {
      expect(mockGetServerUserIdByExternalId).toHaveBeenCalledWith(SERVER_ID, 'plex-ext-B');
    });
    await flushHandlers();

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockCacheService.updateActiveSession).not.toHaveBeenCalled();
  });

  it('still applies the pause when the row belongs to the pausing user', async () => {
    mockGetServerUserIdByExternalId.mockResolvedValue('server-user-A');
    const setFn = setupDbUpdateMock();

    mockSseManager.emit('plex:session:paused', {
      serverId: SERVER_ID,
      notification: { sessionKey: SESSION_KEY, ratingKey: '2002', state: 'paused' },
    });

    await vi.waitFor(() => {
      expect(mockDb.update).toHaveBeenCalled();
    });

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ state: 'paused' }));
  });

  it('stops only rows matching the stopped ratingKey', async () => {
    const foreignRow = { ...staleRow, id: 'session-foreign-1', ratingKey: '9999' };
    mockFindActiveSessionsAll.mockResolvedValue([staleRow, foreignRow]);

    mockSseManager.emit('plex:session:stopped', {
      serverId: SERVER_ID,
      notification: { sessionKey: SESSION_KEY, ratingKey: '1001', state: 'stopped' },
    });

    await vi.waitFor(() => {
      expect(mockStopSessionAtomic).toHaveBeenCalled();
    });
    await flushHandlers();

    expect(mockFindActiveSessionsAll).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      sessionKey: SESSION_KEY,
    });
    expect(mockStopSessionAtomic).toHaveBeenCalledTimes(1);
    expect(mockStopSessionAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ session: staleRow })
    );
  });

  it('does not stop anything when no row matches the stopped ratingKey', async () => {
    mockFindActiveSessionsAll.mockResolvedValue([
      { ...staleRow, id: 'session-foreign-1', ratingKey: '9999' },
    ]);

    mockSseManager.emit('plex:session:stopped', {
      serverId: SERVER_ID,
      notification: { sessionKey: SESSION_KEY, ratingKey: '2002', state: 'stopped' },
    });

    await vi.waitFor(() => {
      expect(mockFindActiveSessionsAll).toHaveBeenCalled();
    });
    await flushHandlers();

    expect(mockStopSessionAtomic).not.toHaveBeenCalled();
  });

  it('stops a live row on sessionKey alone even when the ratingKey drifted', async () => {
    const liveRow = { ...staleRow, id: 'session-live-1', ratingKey: '5005', mediaType: 'live' };
    mockFindActiveSessionsAll.mockResolvedValue([liveRow]);

    mockSseManager.emit('plex:session:stopped', {
      serverId: SERVER_ID,
      notification: { sessionKey: SESSION_KEY, ratingKey: '2002', state: 'stopped' },
    });

    await vi.waitFor(() => {
      expect(mockStopSessionAtomic).toHaveBeenCalled();
    });

    expect(mockStopSessionAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ session: liveRow })
    );
  });
});
