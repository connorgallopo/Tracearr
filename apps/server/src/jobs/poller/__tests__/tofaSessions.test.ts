/**
 * tofa sessions through the poller: the session list read on a socket event, on a missed
 * frame, after a reconnect, and while the socket is down.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SESSION_LIMITS } from '@tracearr/shared';
import tofa from '../../../test/mediaServerResponses/tofa.json' with { type: 'json' };

const {
  mockIsInFallback,
  serverRow,
  mockCreateMediaServerClient,
  mockBatchFindActiveSessionsByKey,
  mockSetPayloads,
  mockResolveSessionGeo,
  mockDb,
} = vi.hoisted(() => {
  /** Thenable query-chain stub: chained calls return itself, awaiting resolves to `result`. */
  function chainResolving(result: unknown[]) {
    const obj: Record<string, unknown> = {};
    obj.where = () => obj;
    obj.innerJoin = () => obj;
    obj.limit = () => obj;
    obj.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    return obj;
  }

  const serverRow = {
    id: 'server-1',
    name: 'tofa',
    type: 'tofa',
    url: 'http://tofa.local:33333',
    token: 'tofa-key',
    watchedRulePercent: 90,
  };

  const serverUserRow = {
    id: 'server-user-1',
    userId: 'identity-1',
    serverId: 'server-1',
    externalId: 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14',
    username: 'morgan',
    email: 'morgan@example.com',
    thumbUrl: null,
    isServerAdmin: true,
    trustScore: 100,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    identityName: 'Morgan',
  };

  const setPayloads: unknown[] = [];

  return {
    mockIsInFallback: vi.fn().mockReturnValue(false),
    mockCreateMediaServerClient: vi.fn(),
    mockBatchFindActiveSessionsByKey: vi.fn(),
    mockSetPayloads: setPayloads,
    mockResolveSessionGeo: vi.fn(),
    serverRow,
    mockDb: {
      select: vi.fn((columns?: unknown) => ({
        from: vi.fn(() => {
          if (columns === undefined) return chainResolving([serverRow]);
          const obj: Record<string, unknown> = { where: () => obj, limit: () => obj };
          obj.innerJoin = () => chainResolving([serverUserRow]);
          obj.then = (resolve: (v: unknown[]) => void) => Promise.resolve([]).then(resolve);
          return obj;
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((payload: unknown) => {
          setPayloads.push(payload);
          return { where: vi.fn(() => ({ returning: async () => [{ id: 'session-1' }] })) };
        }),
      })),
    },
  };
});

vi.mock('../../../services/leaderLease.js', () => ({ isLeader: () => true }));
vi.mock('../../../db/client.js', () => ({ db: mockDb }));
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
vi.mock('../../../services/serverLocations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSessionGeo: mockResolveSessionGeo,
}));
vi.mock('../../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));
vi.mock('../../../services/sseManager.js', () => ({
  sseManager: { isInFallback: mockIsInFallback, nudgeReconnect: vi.fn() },
}));
vi.mock('../../notificationQueue.js', () => ({ enqueueNotification: vi.fn() }));
vi.mock('../database.js', () => ({
  getCachedServers: vi.fn(async () => [serverRow]),
  onActiveAutomationsRefill: vi.fn(),
  getActiveAutomations: vi.fn().mockResolvedValue([]),
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: mockBatchFindActiveSessionsByKey,
  buildActiveSession: vi.fn(({ session }: { session: { id: string } }) => ({ id: session.id })),
  buildPendingActiveSession: vi.fn((data: { id: string }) => ({ id: data.id, pending: true })),
  findActiveSession: vi.fn().mockResolvedValue(null),
  handleMediaChangeAtomic: vi.fn(),
  processPollResults: vi.fn().mockResolvedValue(undefined),
  stopSessionAtomic: vi.fn(),
}));
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: vi.fn().mockResolvedValue({ violations: [], outcomes: [] }),
  subscribe: vi.fn(),
}));
vi.mock('../violations.js', () => ({ broadcastViolations: vi.fn() }));

import {
  initializePoller,
  triggerPoll,
  triggerReconciliationPoll,
  triggerServerPoll,
} from '../processor.js';
import {
  findActiveSession,
  handleMediaChangeAtomic,
  processPollResults,
  stopSessionAtomic,
} from '../sessionLifecycle.js';
import { getActiveAutomations } from '../database.js';
import { dispatch } from '../../../services/automations/events/dispatcher.js';
import { fakeTofaClient } from '../../../test/mediaServerFakes.js';
import { parseTofaMedia, parseTofaSession } from '../../../services/mediaServer/tofa/parser.js';
import { calculateStopDuration } from '../stateTracker.js';
import { resetDbWriteThrottle } from '../dbWriteThrottle.js';
import type { MediaSession } from '../../../services/mediaServer/types.js';

function recorded<T>(items: T[]): T {
  const [first] = items;
  if (!first) throw new Error('the recording is missing a play');
  return first;
}

const movieRow = recorded(tofa.playbackSessions);
const movieNowPlaying = recorded(tofa.nowPlaying.sessions);
const movieDetail = recorded(tofa.mediaBatch);
const movieMedia = parseTofaMedia(movieDetail);
const channelRow = recorded(tofa.livePlaybackSessions);
const channelNowPlaying = recorded(tofa.liveNowPlaying.sessions);
const channelViewer = recorded(tofa.liveAdminNow.sessions);

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'server-user-1',
    sessionKey: movieRow.session_id,
    ratingKey: movieRow.media_id,
    mediaType: 'movie',
    deviceId: movieRow.device_id,
    state: 'playing',
    startedAt: new Date(Date.now() - 60_000),
    lastPausedAt: null,
    pausedDurationMs: 0,
    watched: false,
    totalDurationMs: movieRow.duration_ms,
    progressMs: 150_000,
    videoDecision: 'transcode',
    audioDecision: 'transcode',
    isTranscode: true,
    stoppedAt: null,
    ...overrides,
  };
}

describe('tofa sessions in the poller', () => {
  let cacheService: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSetPayloads.length = 0;
    resetDbWriteThrottle();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    cacheService = {
      getAllActiveSessions: vi.fn().mockResolvedValue([]),
      getPendingSession: vi.fn().mockResolvedValue(null),
      setPendingSession: vi.fn(),
      addActiveSession: vi.fn(),
      withSessionCreateLock: vi.fn().mockImplementation(async (_s, _k, op) => op()),
      hasTerminationCooldown: vi.fn().mockResolvedValue(false),
      getTerminationCooldownsComposite: vi.fn().mockResolvedValue(new Map()),
      clearTerminationCooldownsComposite: vi.fn(),
      setServerHealth: vi.fn().mockResolvedValue(true),
      resetServerFailCount: vi.fn(),
    };
    initializePoller(
      cacheService as unknown as Parameters<typeof initializePoller>[0],
      { publish: vi.fn(), subscribe: vi.fn() } as unknown as Parameters<typeof initializePoller>[1]
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Polls with the recorded movie playing, its media as given */
  function pollMovie(media: typeof movieMedia | undefined, connectionMode: string | null = null) {
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [
          parseTofaSession(
            { ...movieRow, connection_mode: connectionMode },
            movieNowPlaying,
            media
          ),
        ]),
      })
    );
    return triggerServerPoll('server-1');
  }

  function tracked(row: ReturnType<typeof existingRow>) {
    cacheService.getAllActiveSessions?.mockResolvedValue([
      {
        id: row.id,
        serverId: 'server-1',
        serverUserId: row.serverUserId,
        sessionKey: row.sessionKey,
      },
    ]);
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map([[row.sessionKey, [row]]]));
  }

  it('updates one row on every read while the session id stays listed', async () => {
    tracked(existingRow());

    await pollMovie(movieMedia);
    await pollMovie(movieMedia);

    expect(cacheService.setPendingSession).not.toHaveBeenCalled();
    const updated = vi
      .mocked(processPollResults)
      .mock.calls.map(([results]) => results.updatedSessions.map((s) => s.id));
    expect(updated).toEqual([['session-1'], ['session-1']]);
  });

  it('keeps a running play as one session through a socket drop and the reconnect', async () => {
    tracked(existingRow());
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [parseTofaSession(movieRow, movieNowPlaying, movieMedia)]),
      })
    );

    // Socket down: the server is in fallback and the main poll covers it
    mockIsInFallback.mockReturnValue(true);
    await triggerPoll();
    // Socket back: out of fallback, and the reconnect runs the reconciliation poll
    mockIsInFallback.mockReturnValue(false);
    await triggerReconciliationPoll();

    expect(cacheService.setPendingSession).not.toHaveBeenCalled();
    expect(stopSessionAtomic).not.toHaveBeenCalled();
    const updated = vi
      .mocked(processPollResults)
      .mock.calls.map(([results]) => results.updatedSessions.map((s) => s.id));
    expect(updated).toEqual([['session-1'], ['session-1']]);
  });

  it('fills in a session recorded while its media lookup failed', async () => {
    tracked(existingRow({ ratingKey: null, mediaType: 'unknown', totalDurationMs: null }));

    await pollMovie(movieMedia);

    expect(mockSetPayloads[0]).toMatchObject({
      ratingKey: movieRow.media_id,
      mediaType: 'movie',
      mediaTitle: 'The Paper Kite',
      year: 2019,
      totalDurationMs: movieRow.duration_ms,
    });
  });

  it('labels a relayed session instead of placing an address it does not have', async () => {
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map());

    await pollMovie(movieMedia, 'relay');

    expect(mockResolveSessionGeo).not.toHaveBeenCalled();
    expect(cacheService.setPendingSession).toHaveBeenCalledWith(
      'server-1',
      movieRow.session_id,
      expect.objectContaining({
        processed: expect.objectContaining({ ipAddress: '', relayed: true }),
        geo: expect.objectContaining({ country: 'Tofa Relay', isLocal: false }),
      })
    );
  });

  it("marks a play watched by tofa's own rule", async () => {
    // 87% through: past the 85% setting, short of tofa's 90%
    const total = movieRow.duration_ms;
    tracked(existingRow({ startedAt: new Date(Date.now() - total * 0.87) }));
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [
          parseTofaSession({ ...movieRow, position_ms: total * 0.87 }, movieNowPlaying, movieMedia),
        ]),
      })
    );

    await triggerServerPoll('server-1');

    expect(mockSetPayloads[0]).not.toHaveProperty('watched', true);
  });

  it('keeps a channel play open and playing while its position stands still, and times it by the clock', async () => {
    // Longer than the movie on air, so a play judged by its position or runtime would be watched
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    tracked(
      existingRow({
        sessionKey: channelRow.session_id,
        ratingKey: channelNowPlaying.live_channel_id,
        mediaType: 'live',
        startedAt,
        totalDurationMs: null,
        progressMs: null,
      })
    );
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [
          parseTofaSession(channelRow, channelNowPlaying, movieMedia, channelViewer),
        ]),
      })
    );

    await triggerServerPoll('server-1');
    await triggerServerPoll('server-1');

    expect(stopSessionAtomic).not.toHaveBeenCalled();
    expect(mockSetPayloads).toHaveLength(2);
    for (const payload of mockSetPayloads) {
      expect(payload).toMatchObject({
        state: 'playing',
        progressMs: null,
        lastPausedAt: null,
        pausedDurationMs: 0,
      });
      expect(payload).not.toHaveProperty('watched');
    }
    const stoppedAt = new Date();
    expect(
      calculateStopDuration(
        {
          startedAt,
          lastPausedAt: null,
          pausedDurationMs: 0,
          progressMs: null,
          totalDurationMs: 0,
        },
        stoppedAt
      ).durationMs
    ).toBe(stoppedAt.getTime() - startedAt.getTime());
  });

  /** Polls twice, the first read with no now-playing entry for the row and the second with it */
  async function pollUndescribedThenDescribed(
    first: MediaSession,
    second: MediaSession
  ): Promise<{ firstTick: unknown[]; updated: string[][] }> {
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([second]),
      })
    );
    await triggerServerPoll('server-1');
    const firstTick = [...mockSetPayloads];
    await triggerServerPoll('server-1');
    const updated = vi
      .mocked(processPollResults)
      .mock.calls.map(([results]) => results.updatedSessions.map((s) => s.id));
    return { firstTick, updated };
  }

  it('leaves a channel play untouched through a read that now-playing does not describe', async () => {
    tracked(
      existingRow({
        sessionKey: channelRow.session_id,
        ratingKey: channelNowPlaying.live_channel_id,
        mediaType: 'live',
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        totalDurationMs: null,
        progressMs: null,
      })
    );

    const { firstTick, updated } = await pollUndescribedThenDescribed(
      parseTofaSession(channelRow, undefined, movieMedia),
      parseTofaSession(channelRow, channelNowPlaying, movieMedia, channelViewer)
    );

    expect(firstTick).toEqual([{ lastSeenAt: expect.any(Date) }]);
    expect(updated).toEqual([['session-1'], ['session-1']]);
    expect(handleMediaChangeAtomic).not.toHaveBeenCalled();
    expect(stopSessionAtomic).not.toHaveBeenCalled();
    expect(cacheService.setPendingSession).not.toHaveBeenCalled();
    expect(mockSetPayloads).toHaveLength(2);
  });

  it('leaves a movie play untouched through a read that now-playing does not describe', async () => {
    tracked(existingRow());

    const { firstTick, updated } = await pollUndescribedThenDescribed(
      parseTofaSession(movieRow, undefined, movieMedia),
      parseTofaSession(movieRow, movieNowPlaying, movieMedia)
    );

    expect(firstTick).toEqual([{ lastSeenAt: expect.any(Date) }]);
    expect(updated).toEqual([['session-1'], ['session-1']]);
    expect(handleMediaChangeAtomic).not.toHaveBeenCalled();
    expect(stopSessionAtomic).not.toHaveBeenCalled();
    expect(mockSetPayloads).toEqual([
      { lastSeenAt: expect.any(Date) },
      expect.objectContaining({ progressMs: movieRow.position_ms }),
    ]);
  });

  it('keeps a play in the session cache through reads that now-playing does not describe', async () => {
    tracked(existingRow());
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [parseTofaSession(movieRow, undefined, movieMedia)]),
      })
    );

    await triggerServerPoll('server-1');
    await triggerServerPoll('server-1');

    const updated = vi
      .mocked(processPollResults)
      .mock.calls.map(([results]) => results.updatedSessions);
    const cachedEntry = {
      id: 'session-1',
      serverId: 'server-1',
      serverUserId: 'server-user-1',
      sessionKey: movieRow.session_id,
      state: 'playing',
    };
    expect(updated).toEqual([[cachedEntry], [cachedEntry]]);
    expect(mockSetPayloads).toEqual([{ lastSeenAt: expect.any(Date) }]);
  });

  it('sends the state the read gives when the cache holds another for a play read without its media', async () => {
    const row = existingRow();
    tracked(row);
    cacheService.getAllActiveSessions?.mockResolvedValue([
      {
        id: row.id,
        serverId: 'server-1',
        serverUserId: row.serverUserId,
        sessionKey: row.sessionKey,
        state: 'paused',
      },
    ]);
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [parseTofaSession(movieRow, undefined, movieMedia)]),
      })
    );

    await triggerServerPoll('server-1');

    const [results] = vi.mocked(processPollResults).mock.calls[0] ?? [];
    expect(results?.updatedSessions).toEqual([
      expect.objectContaining({ id: 'session-1', state: 'playing' }),
    ]);
  });

  it('recovers a tracked play the cache lost from a read that now-playing does not describe, keeping its media', async () => {
    const row = existingRow({ mediaTitle: 'The Paper Kite' });
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map([[row.sessionKey, [row]]]));
    vi.mocked(findActiveSession).mockResolvedValueOnce(
      row as unknown as Awaited<ReturnType<typeof findActiveSession>>
    );
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [parseTofaSession(movieRow, undefined, movieMedia)]),
      })
    );

    await triggerServerPoll('server-1');

    expect(cacheService.setPendingSession).not.toHaveBeenCalled();
    const [results] = vi.mocked(processPollResults).mock.calls[0] ?? [];
    expect(results?.newSessions).toEqual([]);
    expect(results?.updatedSessions).toEqual([
      expect.objectContaining({
        id: 'session-1',
        ratingKey: movieRow.media_id,
        mediaType: 'movie',
        mediaTitle: 'The Paper Kite',
        totalDurationMs: movieRow.duration_ms,
        progressMs: 150_000,
        state: 'playing',
      }),
    ]);
  });

  it('records a pause from a read that now-playing does not describe, leaving the media as it is', async () => {
    tracked(existingRow());
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [
          parseTofaSession({ ...movieRow, is_paused: true }, undefined, movieMedia),
        ]),
      })
    );

    await triggerServerPoll('server-1');

    expect(mockSetPayloads).toEqual([
      {
        state: 'paused',
        lastPausedAt: expect.any(Date),
        pausedDurationMs: 0,
        lastSeenAt: expect.any(Date),
      },
    ]);
    const [results] = vi.mocked(processPollResults).mock.calls[0] ?? [];
    expect(results?.updatedSessions).toEqual([
      {
        id: 'session-1',
        serverId: 'server-1',
        serverUserId: 'server-user-1',
        sessionKey: movieRow.session_id,
        state: 'paused',
        lastPausedAt: expect.any(Date),
        pausedDurationMs: 0,
      },
    ]);
  });

  it('builds the paused session from the row when the cache holds another entry for its key', async () => {
    const row = existingRow({ mediaTitle: 'The Paper Kite' });
    tracked(row);
    cacheService.getAllActiveSessions?.mockResolvedValue([
      {
        id: 'session-0',
        serverId: 'server-1',
        serverUserId: row.serverUserId,
        sessionKey: row.sessionKey,
      },
    ]);
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [
          parseTofaSession({ ...movieRow, is_paused: true }, undefined, movieMedia),
        ]),
      })
    );

    await triggerServerPoll('server-1');

    const [results] = vi.mocked(processPollResults).mock.calls[0] ?? [];
    expect(results?.updatedSessions).toEqual([
      expect.objectContaining({
        id: 'session-1',
        ratingKey: movieRow.media_id,
        mediaType: 'movie',
        mediaTitle: 'The Paper Kite',
        progressMs: 150_000,
        state: 'paused',
        lastPausedAt: expect.any(Date),
      }),
    ]);
  });

  it('records a resume from a read that now-playing does not describe, adding the paused time', async () => {
    tracked(existingRow({ state: 'paused', lastPausedAt: new Date(Date.now() - 30_000) }));
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [parseTofaSession(movieRow, undefined, movieMedia)]),
      })
    );

    await triggerServerPoll('server-1');

    expect(mockSetPayloads).toEqual([
      {
        state: 'playing',
        lastPausedAt: null,
        pausedDurationMs: expect.any(Number),
        lastSeenAt: expect.any(Date),
      },
    ]);
    const [payload] = mockSetPayloads as { pausedDurationMs: number }[];
    expect(payload?.pausedDurationMs).toBeGreaterThanOrEqual(30_000);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.resumed', sessionId: 'session-1' })
    );
  });

  it('runs pause automations once for a pause read that now-playing does not describe', async () => {
    vi.mocked(getActiveAutomations).mockResolvedValueOnce([{ id: 'rule-1' }] as unknown as Awaited<
      ReturnType<typeof getActiveAutomations>
    >);
    tracked(existingRow());
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [
          parseTofaSession({ ...movieRow, is_paused: true }, undefined, movieMedia),
        ]),
      })
    );

    await triggerServerPoll('server-1');

    const paused = vi
      .mocked(dispatch)
      .mock.calls.map(([event]) => event)
      .filter((event) => event.type === 'session.paused');
    expect(paused).toHaveLength(1);
  });

  it('keeps a play seen through reads that leave it undescribed past the stale timeout', async () => {
    tracked(existingRow());
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [parseTofaSession(movieRow, undefined, movieMedia)]),
      })
    );
    const staleMs = SESSION_LIMITS.STALE_SESSION_TIMEOUT_SECONDS * 1000;
    vi.useFakeTimers({ toFake: ['Date'] });

    for (let elapsed = 0; elapsed <= staleMs + 60_000; elapsed += 60_000) {
      vi.setSystemTime(Date.now() + 60_000);
      await triggerServerPoll('server-1');
    }

    const seen = mockSetPayloads.map((payload) => (payload as { lastSeenAt: Date }).lastSeenAt);
    expect(seen).toHaveLength(7);
    expect(seen.at(-1)?.getTime()).toBe(Date.now());
    expect(stopSessionAtomic).not.toHaveBeenCalled();
  });

  it('keeps the stored username when a session carries none', async () => {
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map());
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [
          parseTofaSession({ ...movieRow, username: null }, movieNowPlaying, movieMedia),
        ]),
      })
    );

    await triggerServerPoll('server-1');

    expect(cacheService.setPendingSession).toHaveBeenCalled();
    expect(mockSetPayloads).not.toContainEqual(
      expect.objectContaining({ username: expect.any(String) })
    );
  });

  it('does not open a killed play again when a read still lists it without its media', async () => {
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map());
    cacheService.getAllActiveSessions?.mockResolvedValue([
      {
        id: 'session-1',
        serverId: 'server-1',
        serverUserId: 'server-user-1',
        sessionKey: movieRow.session_id,
        ratingKey: movieRow.media_id,
      },
    ]);
    cacheService.hasTerminationCooldown?.mockResolvedValue(true);
    mockCreateMediaServerClient.mockReturnValue(
      fakeTofaClient({
        getSessions: vi.fn(async () => [parseTofaSession(movieRow, undefined, movieMedia)]),
      })
    );

    await triggerServerPoll('server-1');

    expect(cacheService.hasTerminationCooldown).toHaveBeenCalledWith(
      'server-1',
      movieRow.session_id,
      movieRow.media_id
    );
    const created = vi
      .mocked(processPollResults)
      .mock.calls.flatMap(([results]) => results.newSessions);
    expect(created).toEqual([]);
    expect(cacheService.setPendingSession).not.toHaveBeenCalled();
  });

  it('does not open a stopped play again when a list read still carries it', async () => {
    mockBatchFindActiveSessionsByKey.mockResolvedValue(new Map());
    cacheService.hasTerminationCooldown?.mockResolvedValue(true);

    await pollMovie(movieMedia);

    expect(cacheService.setPendingSession).not.toHaveBeenCalled();
  });
});
