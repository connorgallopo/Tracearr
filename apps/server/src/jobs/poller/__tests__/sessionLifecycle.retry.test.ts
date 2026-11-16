/**
 * Session Lifecycle Retry Tests (TDD - Red Phase)
 *
 * Tests for bounded retry logic when DB writes fail during session stop.
 * These tests are designed to FAIL initially (TDD red phase) because:
 * - stopSessionAtomic does not currently implement retry logic
 * - SessionStopResult does not include needsRetry property
 *
 * Expected behavior to implement:
 * 1. Retry on DB failure up to IMMEDIATE_RETRIES (3) times
 * 2. Return { needsRetry: true } when all immediate retries fail
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EngineAutomation } from '@tracearr/shared';
import {
  createSessionWithRulesAtomic,
  handleMediaChangeAtomic,
  stopSessionAtomic,
} from '../sessionLifecycle.js';
import type { ProcessedSession, SessionCreationInput } from '../types.js';
import { getWatchedThreshold } from '../../../services/settings.js';

// Mock the db module
vi.mock('../../../db/client.js', () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

const { mockGetCachedServers } = vi.hoisted(() => ({ mockGetCachedServers: vi.fn() }));
vi.mock('../database.js', () => ({ getCachedServers: mockGetCachedServers }));

/** The server a stop reads its watched rule from, as the poller's server cache holds it */
function serverRow(row: { type: string; watchedRulePercent: number | null }) {
  mockGetCachedServers.mockResolvedValue([{ id: 'server-1', ...row }]);
}

vi.mock('../../../services/settings.js', () => ({
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));

vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: vi.fn().mockResolvedValue({ violations: [], outcomes: [] }),
}));

vi.mock('../../../services/automations/events/producers.js', () => ({
  dispatchSessionStopped: vi.fn().mockResolvedValue(undefined),
}));

describe('stopSessionAtomic retry logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverRow({ type: 'plex', watchedRulePercent: null });
  });

  it('should retry on DB failure up to IMMEDIATE_RETRIES times', async () => {
    const { db } = await import('../../../db/client.js');
    const mockUpdate = db.update as ReturnType<typeof vi.fn>;

    // Fail twice, succeed on third
    let callCount = 0;
    mockUpdate.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            callCount++;
            if (callCount < 3) {
              throw new Error('Connection refused');
            }
            return [{ id: 'session-1' }];
          },
        }),
      }),
    }));

    const result = await stopSessionAtomic({
      session: {
        id: 'session-1',
        startedAt: new Date(),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: null,
        totalDurationMs: 3600000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(result.wasUpdated).toBe(true);
    expect(callCount).toBe(3);
  });

  it('should return retry data when all immediate retries fail', async () => {
    const { db } = await import('../../../db/client.js');
    const mockUpdate = db.update as ReturnType<typeof vi.fn>;

    mockUpdate.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            throw new Error('Connection refused');
          },
        }),
      }),
    }));

    const result = await stopSessionAtomic({
      session: {
        id: 'session-1',
        startedAt: new Date(),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: null,
        totalDurationMs: 3600000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(result.wasUpdated).toBe(false);
    expect(result.needsRetry).toBe(true);
  });

  it('still returns retry data when the server read for the watched rule fails too', async () => {
    const { db } = await import('../../../db/client.js');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetCachedServers.mockRejectedValueOnce(new Error('Connection refused'));
    vi.mocked(db.update).mockImplementation((() => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            throw new Error('Connection refused');
          },
        }),
      }),
    })) as never);

    const result = await stopSessionAtomic({
      session: {
        id: 'session-1',
        serverId: 'server-1',
        mediaType: 'movie',
        startedAt: new Date(),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: null,
        totalDurationMs: 3600000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(result.needsRetry).toBe(true);
    expect(getWatchedThreshold).toHaveBeenCalledWith('movie');
  });

  it('issues one query for a Plex stop, its update, while the server list is cached', async () => {
    const { db } = await import('../../../db/client.js');
    vi.mocked(db.update).mockImplementation((() => ({
      set: () => ({ where: () => ({ returning: async () => [{ id: 'session-1' }] }) }),
    })) as never);

    await stopSessionAtomic({
      session: {
        id: 'session-1',
        serverId: 'server-1',
        mediaType: 'movie',
        startedAt: new Date(),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: null,
        totalDurationMs: 3600000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('stopSessionAtomic watched threshold wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverRow({ type: 'plex', watchedRulePercent: null });
  });

  it('resolves the watched threshold from the session media type', async () => {
    const { db } = await import('../../../db/client.js');
    const mockUpdate = db.update as ReturnType<typeof vi.fn>;
    mockUpdate.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ id: 'session-1' }],
        }),
      }),
    }));

    await stopSessionAtomic({
      session: {
        id: 'session-1',
        mediaType: 'episode',
        startedAt: new Date(Date.now() - 87000),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: 87000,
        totalDurationMs: 100000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(getWatchedThreshold).toHaveBeenCalledWith('episode');
  });

  it('marks watched using the resolved per-media-type threshold, not the shared default', async () => {
    const { db } = await import('../../../db/client.js');
    const mockUpdate = db.update as ReturnType<typeof vi.fn>;
    mockUpdate.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ id: 'session-1' }],
        }),
      }),
    }));
    (getWatchedThreshold as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0.9);

    // 87% progress: passes the 85% default but not a 90% threshold.
    const result = await stopSessionAtomic({
      session: {
        id: 'session-1',
        mediaType: 'episode',
        startedAt: new Date(Date.now() - 87000),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: 87000,
        totalDurationMs: 100000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(result.watched).toBe(false);
  });

  it("marks a tofa play watched by tofa's own rule", async () => {
    const { db } = await import('../../../db/client.js');
    serverRow({ type: 'tofa', watchedRulePercent: 90 });
    vi.mocked(db.update).mockImplementation((() => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ id: 'session-1' }],
        }),
      }),
    })) as never);

    // 87% progress after 87s elapsed: watched by the 85% setting, not by tofa's 90%.
    const result = await stopSessionAtomic({
      session: {
        id: 'session-1',
        serverId: 'server-1',
        mediaType: 'movie',
        startedAt: new Date(Date.now() - 87000),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: 87000,
        totalDurationMs: 100000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(result.watched).toBe(false);
    expect(getWatchedThreshold).not.toHaveBeenCalled();
  });
});

describe('stopSessionAtomic session.stopped dispatch', () => {
  const stopInput = {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'su-1',
    startedAt: new Date('2026-08-21T10:00:00Z'),
    lastPausedAt: null,
    pausedDurationMs: 0,
    progressMs: null,
    totalDurationMs: 3600000,
    watched: false,
  } as Parameters<typeof stopSessionAtomic>[0]['session'];

  async function producerMock() {
    const { dispatchSessionStopped } =
      await import('../../../services/automations/events/producers.js');
    return dispatchSessionStopped as ReturnType<typeof vi.fn>;
  }

  let mockedDb: { db: { update: unknown } };

  function mockUpdateReturning(rows: () => Promise<{ id: string }[]>) {
    const { db } = mockedDb;
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: () => ({ where: () => ({ returning: rows }) }),
    }));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedDb = await import('../../../db/client.js');
  });

  it('dispatches the stopped session with its duration once the row was stopped', async () => {
    mockUpdateReturning(async () => [{ id: 'session-1' }]);
    const dispatchSessionStopped = await producerMock();
    const stoppedAt = new Date('2026-08-21T10:10:00Z');

    await stopSessionAtomic({ session: stopInput, stoppedAt });

    expect(dispatchSessionStopped).toHaveBeenCalledTimes(1);
    const [session, durationMs, at] = dispatchSessionStopped.mock.calls[0] as [
      { id: string; serverId: string; state: string; stoppedAt: Date; durationMs: number },
      number,
      Date,
    ];
    expect(session).toMatchObject({
      id: 'session-1',
      serverId: 'server-1',
      state: 'stopped',
      stoppedAt,
      durationMs: 600000,
    });
    expect(durationMs).toBe(600000);
    expect(at).toBe(stoppedAt);
  });

  it('carries the stop reason, defaulting to a stream that ended', async () => {
    mockUpdateReturning(async () => [{ id: 'session-1' }]);
    const dispatchSessionStopped = await producerMock();

    await stopSessionAtomic({ session: stopInput, stoppedAt: new Date() });
    await stopSessionAtomic({
      session: stopInput,
      stoppedAt: new Date(),
      reason: 'quality_change',
    });

    expect(dispatchSessionStopped.mock.calls.map((call) => call[3])).toEqual([
      'ended',
      'quality_change',
    ]);
  });

  it('dispatches once per stop even when the write retried', async () => {
    let attempts = 0;
    mockUpdateReturning(async () => {
      attempts++;
      if (attempts < 3) throw new Error('Connection refused');
      return [{ id: 'session-1' }];
    });
    const dispatchSessionStopped = await producerMock();

    await stopSessionAtomic({ session: stopInput, stoppedAt: new Date() });

    expect(attempts).toBe(3);
    expect(dispatchSessionStopped).toHaveBeenCalledTimes(1);
  });

  it('dispatches nothing when the conditional update stopped no row', async () => {
    mockUpdateReturning(async () => []);
    const dispatchSessionStopped = await producerMock();

    await stopSessionAtomic({ session: stopInput, stoppedAt: new Date() });

    expect(dispatchSessionStopped).not.toHaveBeenCalled();
  });

  it('dispatches nothing when every write attempt failed', async () => {
    mockUpdateReturning(async () => {
      throw new Error('Connection refused');
    });
    const dispatchSessionStopped = await producerMock();

    const result = await stopSessionAtomic({ session: stopInput, stoppedAt: new Date() });

    expect(result.needsRetry).toBe(true);
    expect(dispatchSessionStopped).not.toHaveBeenCalled();
  });
});

describe('a continuation stop is not a stream ending', () => {
  const existingRow = {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'su-1',
    sessionKey: 'sk-1',
    ratingKey: 'rk-1',
    deviceId: 'device-1',
    referenceId: null,
    startedAt: new Date('2026-08-21T10:00:00Z'),
    lastPausedAt: null,
    pausedDurationMs: 0,
    progressMs: 60000,
    totalDurationMs: 3600000,
    watched: false,
  } as Parameters<typeof stopSessionAtomic>[0]['session'];

  const processed = { ratingKey: 'rk-2', deviceId: 'device-1', progressMs: 0 } as ProcessedSession;
  const server = { id: 'server-1', name: 'Test Plex', type: 'plex' as const };
  const serverUser = {
    id: 'su-1',
    userId: 'u-1',
    username: 'connor',
    thumbUrl: null,
    identityName: null,
    trustScore: 100,
    lastActivityAt: null,
    createdAt: new Date('2026-01-01'),
    identityServerUserIds: ['su-1'],
  };
  const ruleContext = {
    geo: {} as SessionCreationInput['geo'],
    activeAutomations: [] as EngineAutomation[],
    activeSessions: [],
    recentSessions: [],
  };

  /** The create path is driven only as far as the stop: the step after it throws on purpose. */
  function mockDb(rows: unknown[][]) {
    const { db } = mockedDb;
    (db.update as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      set: () => ({ where: () => ({ returning: async () => [{ id: 'session-1' }] }) }),
    }));
    let call = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              const next = rows[call++];
              if (!next) throw new Error('past the stop');
              return next;
            },
          }),
        }),
      }),
    }));
    (db.transaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('past the stop'));
  }

  let mockedDb: { db: { update: unknown; select: unknown; transaction: unknown } };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedDb = await import('../../../db/client.js');
  });

  it('stops a quality change as a quality change', async () => {
    mockDb([[existingRow]]);
    const { dispatchSessionStopped } =
      await import('../../../services/automations/events/producers.js');

    await expect(
      createSessionWithRulesAtomic({ processed, server, serverUser, ...ruleContext })
    ).rejects.toThrow('past the stop');

    expect(dispatchSessionStopped).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      expect.any(Number),
      expect.any(Date),
      'quality_change'
    );
  });

  it('stops a media change as a media change', async () => {
    mockDb([]);
    const { dispatchSessionStopped } =
      await import('../../../services/automations/events/producers.js');

    await expect(
      handleMediaChangeAtomic({
        existingSession: existingRow,
        processed,
        server,
        serverUser,
        ...ruleContext,
      })
    ).rejects.toThrow('past the stop');

    expect(dispatchSessionStopped).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      expect.any(Number),
      expect.any(Date),
      'media_change'
    );
  });
});
