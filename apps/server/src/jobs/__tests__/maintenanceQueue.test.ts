/**
 * runSessionMaintenanceWalk tests
 *
 * The shared tail of the session walks refreshes the continuous aggregates
 * from the earliest committed started_at, including when the walk throws
 * after committing batches, unless the job lost its lock. Job history marks
 * system and auto-triggered jobs as automatic. The automatic location sync is
 * queued with a single attempt, and only when a server is behind.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnrecoverableError, type Job } from 'bullmq';

const { mockGetJobs, mockAdd } = vi.hoisted(() => ({ mockGetJobs: vi.fn(), mockAdd: vi.fn() }));

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: vi.fn(function () {
    return { on: vi.fn(), getJobs: mockGetJobs, add: mockAdd };
  }),
}));

vi.mock('../../db/client.js', () => ({
  db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../db/timescale.js', () => ({
  withSessionsCompressionPaused: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getTimescaleStatus: vi.fn(),
  safeFullRefreshAggregate: vi.fn(),
}));

vi.mock('../../services/cache.js', () => ({
  getCacheService: vi.fn().mockReturnValue(null),
  getPubSubService: vi.fn().mockReturnValue(null),
}));

vi.mock('../lockUtils.js', () => ({
  extendJobLock: vi.fn(),
  DEFAULT_LOCK_DURATION_MS: 60_000,
}));

import { db } from '../../db/client.js';
import { getTimescaleStatus, safeFullRefreshAggregate } from '../../db/timescale.js';
import { queryChain } from '../../test/helpers.js';
import { extendJobLock } from '../lockUtils.js';
import {
  enqueueMaintenanceJob,
  enqueueServerLocationSyncIfBehind,
  getMaintenanceJobHistory,
  initMaintenanceQueue,
  runSessionMaintenanceWalk,
  getMaintenanceProgress,
  type MaintenanceJobData,
} from '../maintenanceQueue.js';

const COMMITTED = new Date('2026-01-10T08:00:00Z');

function job(): Job<MaintenanceJobData> {
  return {
    id: 'walk-job',
    token: 'token',
    data: { type: 'link_imported_history', userId: 'owner' },
    updateProgress: vi.fn(),
  } as unknown as Job<MaintenanceJobData>;
}

function run(
  walk: Parameters<typeof runSessionMaintenanceWalk>[1]['walk'],
  totalCountsUpdates = true
) {
  return runSessionMaintenanceWalk(job(), {
    type: 'link_imported_history',
    startMessage: 'start',
    progressMessage: (total) => `progress ${total}`,
    completeMessage: (_total, details) => details,
    resultMessage: (_total, details) => details,
    failurePrefix: 'skipped',
    totalCountsUpdates,
    walk,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.mocked(getTimescaleStatus).mockResolvedValue({
    extensionInstalled: true,
    continuousAggregates: ['user_media_plays_daily'],
  } as never);
  vi.mocked(safeFullRefreshAggregate).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runSessionMaintenanceWalk', () => {
  it('refreshes from the committed batch when the walk throws afterwards, and still fails', async () => {
    const result = run(async (onBatch, onCommit) => {
      onCommit(COMMITTED);
      await onBatch(1);
      throw new Error('Redis readiness check failed');
    });

    await expect(result).rejects.toThrow('Redis readiness check failed');
    expect(safeFullRefreshAggregate).toHaveBeenCalledWith(
      'user_media_plays_daily',
      COMMITTED,
      expect.any(Date),
      expect.any(Object)
    );
  });

  it('skips the refresh when the walk loses its job lock', async () => {
    vi.mocked(extendJobLock).mockRejectedValue(new Error('Lost lock for job walk-job'));

    const result = run(async (onBatch, onCommit) => {
      onCommit(COMMITTED);
      vi.setSystemTime(Date.now() + 10 * 60_000);
      await onBatch(1);
      return { total: 1, failedRanges: [], details: '' };
    });

    await expect(result).rejects.toThrow('Lost lock for job walk-job');
    expect(safeFullRefreshAggregate).not.toHaveBeenCalled();
  });

  it('reports the running total as updated only for a walk that says it counts updates', async () => {
    const seen: (number | undefined)[] = [];
    const walk: Parameters<typeof run>[0] = async (onBatch) => {
      await onBatch(88);
      seen.push(getMaintenanceProgress()?.updatedRecords);
      return { total: 88, failedRanges: [], details: '' };
    };

    await run(walk, false);
    await run(walk, true);

    expect(seen).toEqual([0, 88]);
  });

  it('shows the updated and skipped counts a walk reports with a batch', async () => {
    const seen: (number | undefined)[] = [];
    await run(async (onBatch) => {
      await onBatch(10, { updated: 4, skipped: 6 });
      seen.push(getMaintenanceProgress()?.updatedRecords, getMaintenanceProgress()?.skippedRecords);
      return { total: 4, failedRanges: [], details: '' };
    }, false);

    expect(seen).toEqual([4, 6]);
  });

  it('reports the processed and skipped counts a walk returns instead of its total', async () => {
    const result = await run(async () => ({
      total: 2,
      failedRanges: [],
      details: '',
      processed: 5,
      skipped: 3,
    }));

    expect(result).toMatchObject({ processed: 5, updated: 2, skipped: 3 });
  });

  it('fails a walk with skipped ranges without letting BullMQ retry it', async () => {
    const result = run(async () => ({
      total: 0,
      failedRanges: ['2026-01-01T00:00:00.000Z → 2026-01-02T00:00:00.000Z'],
      details: '',
    }));

    await expect(result).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('getMaintenanceJobHistory', () => {
  it('marks system and auto-triggered jobs as automatic and the rest as manual', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    initMaintenanceQueue('redis://localhost:6379');
    const finished = (id: string, data: Partial<MaintenanceJobData>) => ({
      id,
      data: { type: 'link_imported_history', userId: 'owner', ...data },
      timestamp: 1,
      finishedOn: 2,
    });
    mockGetJobs.mockResolvedValue([
      finished('system', { userId: 'system' }),
      finished('auto', { options: { trigger: 'auto' } }),
      finished('manual', { options: { trigger: 'manual' } }),
      finished('plain', {}),
    ]);

    const history = await getMaintenanceJobHistory();

    expect(history.map((h) => [h.jobId, h.trigger])).toEqual([
      ['system', 'auto'],
      ['auto', 'auto'],
      ['manual', 'manual'],
      ['plain', 'manual'],
    ]);
  });
});

describe('enqueueServerLocationSyncIfBehind', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    initMaintenanceQueue('redis://localhost:6379');
    mockGetJobs.mockResolvedValue([]);
    mockAdd.mockImplementation(async (_name: string, _data: unknown, opts: { jobId: string }) => ({
      id: opts.jobId,
    }));
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ id: 'server-1' }]));
  });

  it('queues a single-attempt automatic run when a server is behind', async () => {
    await expect(enqueueServerLocationSyncIfBehind()).resolves.toBe(true);

    expect(mockAdd).toHaveBeenCalledWith(
      'maintenance-sync_server_locations',
      { type: 'sync_server_locations', userId: 'system', options: { trigger: 'auto' } },
      {
        jobId: expect.stringMatching(/^maintenance-/),
        attempts: 1,
        deduplication: { id: 'maintenance' },
      }
    );
    expect(mockGetJobs).not.toHaveBeenCalled();
  });

  it('queues nothing when every server is synced', async () => {
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, []));

    await expect(enqueueServerLocationSyncIfBehind()).resolves.toBe(false);

    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('returns false when another maintenance job holds the queue', async () => {
    mockAdd.mockResolvedValueOnce({ id: 'maintenance-busy' });

    await expect(enqueueServerLocationSyncIfBehind()).resolves.toBe(false);

    expect(mockGetJobs).not.toHaveBeenCalled();
  });

  it('leaves a manual run on the queue default attempts', async () => {
    await enqueueMaintenanceJob('sync_server_locations', 'owner');

    expect(mockAdd).toHaveBeenCalledWith('maintenance-sync_server_locations', expect.anything(), {
      jobId: expect.stringMatching(/^maintenance-/),
      deduplication: { id: 'maintenance' },
    });
  });
});
