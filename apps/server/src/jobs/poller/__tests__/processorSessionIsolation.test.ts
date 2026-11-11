/**
 * Per-Session Error Isolation Tests
 *
 * A thrown error while processing one session inside processServerSessions
 * must not discard sessions already handled that tick, skip the grace
 * sweep, or make the server's tick report success:false - only a failure
 * to fetch sessions from the media server (or the setup around it) should
 * do that. These run through pollServers/triggerPoll, since that's what
 * feeds the DOWN_THRESHOLD health tracking the bug corrupts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession, EngineAutomation } from '@tracearr/shared';
import type { CacheService, PubSubService } from '../../../services/cache.js';
import type * as ProducersModule from '../../../services/automations/events/producers.js';
import type * as MediaServerModule from '../../../services/mediaServer/index.js';
import type { ProcessedSession } from '../types.js';

const mockDbSelect = vi.fn();
const { mockCreateMediaServerClient, mockGetActiveAutomations, mockSseManager } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  return {
    mockCreateMediaServerClient: vi.fn(),
    mockGetActiveAutomations: vi.fn().mockResolvedValue([]),
    mockSseManager: Object.assign(new EventEmitter(), {
      isInFallback: vi.fn().mockReturnValue(true),
      nudgeReconnect: vi.fn(),
    }),
  };
});

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

vi.mock('../../../services/liveServers.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLiveServer: async () => true,
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

vi.mock('../../../services/sseManager.js', () => ({ sseManager: mockSseManager }));

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

const mockUpdatePendingSession = vi.fn();
vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: (...args: unknown[]) => mockUpdatePendingSession(...args),
}));

const mockStopSessionAtomic = vi.fn();
const mockProcessPollResults = vi.fn().mockResolvedValue(undefined);
const mockBuildPendingActiveSession = vi.fn();
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: (...args: unknown[]) => mockBuildPendingActiveSession(...args),
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: vi.fn(),
  findActiveSessionByComposite: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  processPollResults: (...args: unknown[]) => mockProcessPollResults(...args),
  stopSessionAtomic: (...args: unknown[]) => mockStopSessionAtomic(...args),
}));

const mockDispatch = vi.fn().mockResolvedValue({ violations: [], outcomes: [] });
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));

vi.mock('../../../services/automations/events/producers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProducersModule>();
  return {
    ...actual,
    dispatchServerHealth: vi.fn(actual.dispatchServerHealth),
    dispatchServerHealthById: vi.fn(),
  };
});

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: vi.fn((raw: unknown) => raw),
  pickStreamDetailFields: vi.fn().mockReturnValue({}),
}));

import { servers, serverUsers, sessions as sessionsTable } from '../../../db/schema.js';
import {
  gracePeriodSessionIds,
  initializePoller,
  startPoller,
  stopPoller,
  triggerPoll,
} from '../processor.js';
import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../../sseProcessor.js';
import {
  dispatchServerHealth,
  dispatchServerHealthById,
} from '../../../services/automations/events/producers.js';
import { HttpClientError } from '../../../utils/http.js';

const mockDispatchServerHealth = vi.mocked(dispatchServerHealth);
const mockDispatchServerHealthById = vi.mocked(dispatchServerHealthById);

function createMockProcessedSession(overrides: Partial<ProcessedSession> = {}): ProcessedSession {
  return {
    sessionKey: 'sk-1',
    ratingKey: 'rk-1',
    externalUserId: 'ext-user-1',
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
    progressMs: 600000,
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
let serverRows: unknown[] = [serverRow];

const serverUsersRows = [
  {
    id: 'su-a',
    userId: 'identity-a',
    serverId: 'server-1',
    externalId: 'ext-a',
    username: 'userA',
    email: null,
    thumbUrl: null,
    isServerAdmin: false,
    trustScore: 100,
    lastActivityAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    identityName: 'User A',
  },
  {
    id: 'su-b',
    userId: 'identity-b',
    serverId: 'server-1',
    externalId: 'ext-b',
    username: 'userB',
    email: null,
    thumbUrl: null,
    isServerAdmin: false,
    trustScore: 100,
    lastActivityAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    identityName: 'User B',
  },
];

const processedA = createMockProcessedSession({
  sessionKey: 'session-A',
  externalUserId: 'ext-a',
  username: 'userA',
  ratingKey: 'rk-a',
  deviceId: 'device-a',
});
const processedB = createMockProcessedSession({
  sessionKey: 'session-B',
  externalUserId: 'ext-b',
  username: 'userB',
  ratingKey: 'rk-b',
  deviceId: 'device-b',
});

const activeSessionA = {
  id: 'active-a-id',
  serverId: 'server-1',
  serverUserId: 'su-a',
  sessionKey: 'session-A',
  deviceId: 'device-a',
  ratingKey: 'rk-a',
  pending: false,
} as unknown as ActiveSession;
const activeSessionB = {
  id: 'active-b-id',
  serverId: 'server-1',
  serverUserId: 'su-b',
  sessionKey: 'session-B',
  deviceId: 'device-b',
  ratingKey: 'rk-b',
  pending: false,
} as unknown as ActiveSession;

mockDbSelect.mockImplementation((_cols?: unknown) => ({
  from: (table: unknown) => {
    if (table === servers) return Promise.resolve(serverRows);
    if (table === serverUsers) {
      return { innerJoin: () => ({ where: () => Promise.resolve(serverUsersRows) }) };
    }
    if (table === sessionsTable) {
      return { where: () => Promise.resolve([]) };
    }
    return Promise.resolve([]);
  },
}));

function createCacheService() {
  let health: boolean | null = null;
  let failCount = 0;
  return {
    getAllActiveSessions: vi.fn().mockResolvedValue([activeSessionA, activeSessionB]),
    getServerHealth: vi.fn(async (_id: string) => health),
    setServerHealth: vi.fn(async (_id: string, value: boolean) => {
      const previous = health;
      health = value;
      return previous;
    }),
    resetServerFailCount: vi.fn(async () => {
      failCount = 0;
    }),
    incrServerFailCount: vi.fn(async () => {
      failCount += 1;
      return failCount;
    }),
    getPendingSession: vi.fn((_serverId: string, pendingKey: string) => {
      if (pendingKey === 'session-A') return Promise.reject(new Error('transient redis error'));
      return Promise.resolve({ id: 'pending-b' });
    }),
    setPendingSession: vi.fn().mockResolvedValue(undefined),
    deletePendingSession: vi.fn().mockResolvedValue(undefined),
    withSessionCreateLock: vi.fn(),
    removeActiveSession: vi.fn().mockResolvedValue(undefined),
    removeUserSession: vi.fn().mockResolvedValue(undefined),
    hasTerminationCooldown: vi.fn().mockResolvedValue(false),
    getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
    clearTerminationCooldownsComposite: vi.fn(),
    addSessionWriteRetry: vi.fn().mockResolvedValue(undefined),
    invalidateDashboardStatsCache: vi.fn().mockResolvedValue(undefined),
  };
}

const serverDownAutomation = {
  id: 'down-1',
  name: 'down',
  description: null,
  serverId: null,
  serverUserId: null,
  userId: null,
  enforceAcrossServers: false,
  isActive: true,
  severity: 'warning',
  kind: 'notification',
  cooldownMinutes: null,
  currentVersionId: null,
  conditions: { groups: [] },
  actions: { actions: [] },
  createdAt: new Date(),
  updatedAt: new Date(),
  triggers: [{ id: 'down-node', type: 'server.down', enabled: true }],
} as unknown as EngineAutomation;

/** The seam fans out several event types per tick; health assertions read only their own. */
function dispatchedOfType(type: string): unknown[] {
  return mockDispatch.mock.calls
    .map(([event]) => event as { type: string })
    .filter((event) => event.type === type);
}

function createPubSubService() {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

let cacheService: ReturnType<typeof createCacheService>;

describe('per-session error isolation in processServerSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopPoller();
    mockGetActiveAutomations.mockResolvedValue([]);
    mockUpdatePendingSession.mockImplementation(() => ({
      updatedData: { id: 'pending-b-data' },
      isConfirmed: false,
    }));
    mockBuildPendingActiveSession.mockImplementation((data: unknown) => ({
      id: 'active-b-updated',
      pending: true,
      source: data,
    }));

    cacheService = createCacheService();
    initializePoller(
      cacheService as unknown as CacheService,
      createPubSubService() as unknown as PubSubService
    );
  });

  it('lands the other session and keeps the server healthy when one session throws mid-poll', async () => {
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([processedA, processedB]),
    });

    await triggerPoll();

    expect(cacheService.setServerHealth).toHaveBeenCalledWith('server-1', true);
    expect(cacheService.incrServerFailCount).not.toHaveBeenCalled();

    const lastCall = mockProcessPollResults.mock.calls.at(-1)?.[0] as {
      updatedSessions: Array<{ id: string }>;
    };
    expect(lastCall.updatedSessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'active-b-updated' })])
    );
  });

  it('never trips the DOWN_THRESHOLD notification across repeated ticks where the same session keeps throwing', async () => {
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([processedA, processedB]),
    });

    await triggerPoll();
    await triggerPoll();
    await triggerPoll();

    expect(cacheService.setServerHealth).not.toHaveBeenCalledWith('server-1', false, undefined);
    expect(dispatchedOfType('server.down')).toEqual([]);
  });

  it('still reports the server unhealthy when client.getSessions() itself fails', async () => {
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    await triggerPoll();
    await triggerPoll();
    await triggerPoll();

    expect(cacheService.setServerHealth).toHaveBeenCalledWith('server-1', false, undefined);
  });

  it('marks the server down as unauthorized when the poll gets a 401', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockRejectedValue(
        new HttpClientError({
          service: 'plex',
          statusCode: 401,
          statusText: 'Unauthorized',
          url: 'http://plex.local:32400/status/sessions',
        })
      ),
    });

    await triggerPoll();
    await triggerPoll();
    await triggerPoll();

    expect(cacheService.setServerHealth).toHaveBeenCalledWith('server-1', false, 'unauthorized');
    expect(mockDispatchServerHealth).toHaveBeenCalledWith(
      'server.down',
      expect.objectContaining({ id: 'server-1' }),
      expect.any(Date),
      'unauthorized'
    );
    errorSpy.mockRestore();
  });

  it('dispatches server.down once the threshold trips, and enqueues nothing', async () => {
    mockGetActiveAutomations.mockResolvedValue([serverDownAutomation]);
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    await triggerPoll();
    await triggerPoll();
    await triggerPoll();

    expect(dispatchedOfType('server.down')).toEqual([
      {
        type: 'server.down',
        at: expect.any(Date),
        server: { id: 'server-1', name: 'Test Server', type: 'plex' },
      },
    ]);
    expect(mockEnqueueNotification).not.toHaveBeenCalled();
  });

  it('dispatches server.up when the server comes back', async () => {
    mockGetActiveAutomations.mockResolvedValue([
      { ...serverDownAutomation, triggers: [{ id: 'up-node', type: 'server.up', enabled: true }] },
    ]);
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    await triggerPoll();
    await triggerPoll();
    await triggerPoll();

    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([]),
    });
    await triggerPoll();

    expect(dispatchedOfType('server.up')).toHaveLength(1);
  });

  it('dispatches no health event when no automation listens', async () => {
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    await triggerPoll();
    await triggerPoll();
    await triggerPoll();

    expect(dispatchedOfType('server.down')).toEqual([]);
  });

  it('does not treat a session that throws mid-processing as missing for grace-period purposes', async () => {
    // Tick 1: session A is genuinely absent from the response - it enters grace.
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([processedB]),
    });
    await triggerPoll();

    expect(gracePeriodSessionIds().has('active-a-id')).toBe(true);

    // Tick 2: session A is back in the response but throws while being processed.
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([processedA, processedB]),
    });
    await triggerPoll();

    expect(gracePeriodSessionIds().has('active-a-id')).toBe(false);
    expect(mockStopSessionAtomic).not.toHaveBeenCalled();
  });

  describe('servers and cached sessions the poller has no type for', () => {
    afterEach(() => {
      serverRows = [serverRow];
    });

    it('fails only the poll of a server row whose type it does not know', async () => {
      const actual = await vi.importActual<typeof MediaServerModule>(
        '../../../services/mediaServer/index.js'
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      serverRows = [
        serverRow,
        { ...serverRow, id: 'server-2', name: 'Unknown Server', type: 'not-a-server' },
      ];
      cacheService.getAllActiveSessions.mockResolvedValue([
        activeSessionB,
        { ...activeSessionB, id: 'unknown-active-id', serverId: 'server-2' },
      ]);
      mockCreateMediaServerClient.mockImplementation(
        (options: Parameters<typeof actual.createMediaServerClient>[0]) =>
          options.type === 'plex'
            ? { getSessions: vi.fn().mockResolvedValue([processedB]) }
            : actual.createMediaServerClient(options)
      );

      await triggerPoll();

      expect(errorSpy).toHaveBeenCalledWith(
        'Error polling server Unknown Server:',
        expect.objectContaining({ message: 'Unhandled value: not-a-server' })
      );
      expect(cacheService.incrServerFailCount).toHaveBeenCalledWith('server-2');
      expect(cacheService.setServerHealth).toHaveBeenCalledWith('server-1', true);
      const lastCall = mockProcessPollResults.mock.calls.at(-1)?.[0] as {
        updatedSessions: Array<{ id: string }>;
      };
      expect(lastCall.updatedSessions).toEqual([
        expect.objectContaining({ id: 'active-b-updated' }),
      ]);
    });

    it('keeps polling when a cached session belongs to a server that is gone', async () => {
      cacheService.getAllActiveSessions.mockResolvedValue([
        { ...activeSessionA, id: 'orphan-id', serverId: 'server-gone' },
        activeSessionA,
        activeSessionB,
      ]);
      mockCreateMediaServerClient.mockReturnValue({
        getSessions: vi.fn().mockResolvedValue([processedB]),
      });

      await triggerPoll();

      expect(cacheService.setServerHealth).toHaveBeenCalledWith('server-1', true);
      expect(gracePeriodSessionIds().has('active-a-id')).toBe(true);
    });
  });
});

describe('server health across the poller and the live connection', () => {
  const healthEvents = (type: 'server.down' | 'server.up') =>
    [...mockDispatchServerHealth.mock.calls, ...mockDispatchServerHealthById.mock.calls].filter(
      ([eventType]) => eventType === type
    ).length;
  const pollsAnswer = (getSessions: () => Promise<unknown[]>) =>
    mockCreateMediaServerClient.mockReturnValue({ getSessions: vi.fn(getSessions) });
  const pollsFail = () => pollsAnswer(() => Promise.reject(new Error('ECONNREFUSED')));
  const pollsSucceed = () => pollsAnswer(() => Promise.resolve([]));
  /** The real manager flips its fallback flag before it emits, so the poller sees the new state. */
  const liveConnection = (open: boolean) => {
    mockSseManager.isInFallback.mockReturnValue(!open);
    mockSseManager.emit(open ? 'fallback:deactivated' : 'fallback:activated', {
      serverId: 'server-1',
      serverName: 'Test Server',
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    stopPoller();
    mockSseManager.removeAllListeners();
    mockSseManager.isInFallback.mockReturnValue(false);
    mockGetActiveAutomations.mockResolvedValue([]);

    cacheService = createCacheService();
    const pubSub = createPubSubService() as unknown as PubSubService;
    initializePoller(cacheService as unknown as CacheService, pubSub);
    initializeSSEProcessor(cacheService as unknown as CacheService, pubSub);
    startSSEProcessor();
    startPoller({ enabled: true });
  });

  afterEach(() => {
    stopSSEProcessor();
    stopPoller();
    mockSseManager.isInFallback.mockReturnValue(true);
    vi.useRealTimers();
  });

  it('sends no server.down while polls keep succeeding after the live connection drops', async () => {
    pollsSucceed();
    liveConnection(false);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(healthEvents('server.down')).toBe(0);
  });

  it('sends one server.up when the live connection returns after polling marked the server down', async () => {
    pollsFail();
    liveConnection(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(healthEvents('server.down')).toBe(1);

    liveConnection(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(healthEvents('server.up')).toBe(1);
    expect(await cacheService.getServerHealth('server-1')).toBe(true);
    expect(cacheService.resetServerFailCount).toHaveBeenCalledWith('server-1');
  });

  it('sends one down through a long outage and one up when a poll and the reconnect both see the recovery', async () => {
    pollsFail();
    liveConnection(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(healthEvents('server.down')).toBe(1);

    pollsSucceed();
    await vi.advanceTimersByTimeAsync(10_000);
    liveConnection(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(healthEvents('server.up')).toBe(1);
  });

  it('sends one up when the reconnect lands while a successful poll is in flight', async () => {
    pollsFail();
    liveConnection(false);
    await vi.advanceTimersByTimeAsync(30_000);

    let answer!: (sessions: unknown[]) => void;
    const inFlight = new Promise<unknown[]>((resolve) => {
      answer = resolve;
    });
    pollsAnswer(() => inFlight);
    await vi.advanceTimersByTimeAsync(10_000);
    liveConnection(true);
    await vi.advanceTimersByTimeAsync(0);
    answer([]);
    await vi.advanceTimersByTimeAsync(0);

    expect(healthEvents('server.up')).toBe(1);
  });

  it('sends no second down from a failed poll that was in flight when the live connection returned', async () => {
    pollsFail();
    liveConnection(false);
    await vi.advanceTimersByTimeAsync(30_000);

    cacheService.incrServerFailCount.mockImplementationOnce(async () => {
      liveConnection(true);
      return 4;
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(healthEvents('server.down')).toBe(1);
    expect(await cacheService.getServerHealth('server-1')).toBe(true);
  });
});
