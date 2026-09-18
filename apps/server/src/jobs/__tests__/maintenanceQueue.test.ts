/**
 * runSessionMaintenanceWalk tests
 *
 * The shared tail of the session walks refreshes the continuous aggregates
 * from the earliest committed started_at, including when the walk throws
 * after committing batches, unless the job lost its lock. Job history marks
 * system and auto-triggered jobs as automatic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';

const { mockGetJobs } = vi.hoisted(() => ({ mockGetJobs: vi.fn() }));

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: vi.fn(function () {
    return { on: vi.fn(), getJobs: mockGetJobs };
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
  MAINTENANCE_LOCK_DURATION_MS: 300_000,
}));

import { getTimescaleStatus, safeFullRefreshAggregate } from '../../db/timescale.js';
import { extendJobLock } from '../lockUtils.js';
import {
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
