import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS, WS_EVENTS } from '@tracearr/shared';
import type { SQL } from 'drizzle-orm';

const { calls, mockSessionRows, mockSessionWhere, mockSet, mockPendingKeys, mockPendingData } =
  vi.hoisted(() => ({
    calls: [] as string[],
    mockSessionRows: vi.fn(() => [] as unknown[]),
    mockSessionWhere: vi.fn(),
    mockSet: vi.fn(),
    mockPendingKeys: vi.fn(async () => [] as { serverId: string; sessionKey: string }[]),
    mockPendingData: vi.fn(
      async (_serverId: string, _key: string) => null as { id: string } | null
    ),
  }));

const row = {
  id: 'srv-1',
  name: 'Attic',
  type: 'jellyfin' as const,
  url: 'http://jf.local',
  token: 'tok',
  historicalAt: null as Date | null,
} as ServerRow;

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          mockSessionWhere(condition);
          return Promise.resolve(mockSessionRows());
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        calls.push('update');
        mockSet(patch);
        return {
          where: () => ({
            returning: () =>
              Promise.resolve([{ ...row, historicalAt: patch.historicalAt ?? null }]),
          }),
        };
      },
    }),
  },
}));
vi.mock('../../jobs/poller/index.js', () => ({
  forceStopSessions: vi.fn(async (rows: unknown[]) => {
    calls.push('forceStop');
    return rows.length;
  }),
}));
vi.mock('../../jobs/librarySyncQueue.js', () => ({
  rebuildAutoSyncSchedules: vi.fn(async () => {
    calls.push('rebuildAutoSyncSchedules');
  }),
}));
vi.mock('../../jobs/importQueue.js', () => ({
  dropHeldImport: vi.fn(async (serverId: string) => {
    calls.push(`dropHeldImport:${serverId}`);
  }),
}));
vi.mock('../../jobs/poller/database.js', () => ({
  publishServersChanged: vi.fn(async () => {
    calls.push('publishServersChanged');
  }),
}));
vi.mock('../../jobs/sseProcessor.js', () => ({
  clearServerDownState: vi.fn(() => {
    calls.push('clearServerDownState');
  }),
}));
vi.mock('../sseManager.js', () => ({
  sseManager: {
    refresh: vi.fn(async () => {
      calls.push('refresh');
    }),
  },
}));
const cache = {
  invalidateCache: vi.fn(async (key: string) => {
    calls.push(`invalidate:${key}`);
  }),
  resetServerFailCount: vi.fn(async () => {
    calls.push('resetServerFailCount');
  }),
  getAllPendingSessionKeys: (...args: []) => mockPendingKeys(...args),
  getPendingSession: (serverId: string, key: string) => mockPendingData(serverId, key),
  deletePendingSession: vi.fn(async () => undefined),
  removeActiveSession: vi.fn(async () => undefined),
  invalidateDashboardStatsCache: vi.fn(async () => undefined),
};
const publish = vi.fn(async (event: string) => {
  calls.push(`publish:${event}`);
});
vi.mock('../cache.js', () => ({
  getCacheService: () => cache,
  getPubSubService: () => ({ publish }),
}));

import { forceStopSessions } from '../../jobs/poller/index.js';
import { rebuildAutoSyncSchedules } from '../../jobs/librarySyncQueue.js';
import { renderSql } from '../../test/helpers.js';
import type { ServerRow } from '../liveServers.js';
import { markServerHistorical, resumeServer } from '../historicalServers.js';

describe('markServerHistorical', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    mockSessionRows.mockReturnValue([]);
    mockPendingKeys.mockResolvedValue([]);
  });

  it('runs the switch in the spec order and returns the flagged row', async () => {
    const updated = await markServerHistorical(row);

    expect(calls).toEqual([
      'update',
      'publishServersChanged',
      'forceStop',
      'refresh',
      'rebuildAutoSyncSchedules',
      'dropHeldImport:srv-1',
      `invalidate:${REDIS_KEYS.SERVER_HEALTH('srv-1')}`,
      'resetServerFailCount',
      `invalidate:${REDIS_KEYS.SERVER_CONNECTION('srv-1')}`,
      'clearServerDownState',
      `publish:${WS_EVENTS.SERVER_UP}`,
    ]);
    expect(mockSet.mock.calls[0]?.[0]).toMatchObject({ historicalAt: expect.any(Date) });
    expect(publish).toHaveBeenCalledWith(WS_EVENTS.SERVER_UP, {
      serverId: 'srv-1',
      serverName: 'Attic',
    });
    expect(updated.historicalAt).toBeInstanceOf(Date);
  });

  it('does nothing for a server that is already historical', async () => {
    const historical = { ...row, historicalAt: new Date('2026-09-01T00:00:00Z') };

    const result = await markServerHistorical(historical);

    expect(result).toBe(historical);
    expect(calls).toEqual([]);
    expect(mockSet).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('force-stops every active session on the server, however recently it was seen', async () => {
    const seenJustNow = {
      id: 'sess-1',
      serverId: 'srv-1',
      lastSeenAt: new Date(),
      stoppedAt: null,
    };
    mockSessionRows.mockReturnValue([seenJustNow]);

    await markServerHistorical(row);

    expect(forceStopSessions).toHaveBeenCalledWith([seenJustNow]);
    const rendered = renderSql(mockSessionWhere.mock.calls[0]?.[0] as SQL);
    expect(rendered.sql).toContain('sessions.server_id = $1');
    expect(rendered.sql).toContain('sessions.stopped_at is null');
    expect(rendered.sql).not.toContain('last_seen_at');
    expect(rendered.params).toEqual(['srv-1']);
  });

  it('clears the redis-only pending sessions of this server and no other', async () => {
    mockPendingKeys.mockResolvedValue([
      { serverId: 'srv-1', sessionKey: 'k1' },
      { serverId: 'srv-2', sessionKey: 'k2' },
    ]);
    mockPendingData.mockResolvedValue({ id: 'pend-1' });

    await markServerHistorical(row);

    expect(cache.deletePendingSession).toHaveBeenCalledTimes(1);
    expect(cache.deletePendingSession).toHaveBeenCalledWith('srv-1', 'k1');
    expect(cache.removeActiveSession).toHaveBeenCalledWith('pend-1', {
      skipDashboardInvalidation: true,
    });
    expect(publish).toHaveBeenCalledWith('session:stopped', 'pend-1');
    expect(cache.invalidateDashboardStatsCache).toHaveBeenCalledTimes(1);
  });

  it('still completes when the sync reschedule fails', async () => {
    vi.mocked(rebuildAutoSyncSchedules).mockRejectedValueOnce(
      new Error('Library sync queue not initialized')
    );

    await expect(markServerHistorical(row)).resolves.toMatchObject({ id: 'srv-1' });
    expect(calls).toContain('clearServerDownState');
  });
});

describe('resumeServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
  });

  it('does nothing for a server that is already live', async () => {
    const result = await resumeServer(row);

    expect(result).toBe(row);
    expect(calls).toEqual([]);
  });

  it('clears the flag and rebuilds without writing health or publishing a banner', async () => {
    const updated = await resumeServer({ ...row, historicalAt: new Date('2026-09-01T00:00:00Z') });

    expect(calls).toEqual([
      'update',
      'clearServerDownState',
      'publishServersChanged',
      'refresh',
      'rebuildAutoSyncSchedules',
    ]);
    expect(mockSet.mock.calls[0]?.[0]).toMatchObject({ historicalAt: null });
    expect(publish).not.toHaveBeenCalled();
    expect(cache.invalidateCache).not.toHaveBeenCalled();
    expect(updated.historicalAt).toBeNull();
  });
});
