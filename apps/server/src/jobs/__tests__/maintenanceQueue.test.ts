/**
 * runSessionMaintenanceWalk tests
 *
 * The shared tail of the session walks refreshes the continuous aggregates
 * from the earliest committed started_at, including when the walk throws
 * after committing batches, unless the job lost its lock. Job history marks
 * system and auto-triggered jobs as automatic. The automatic location sync is
 * queued with a single attempt, and only when a server is behind.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';

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
  aggregatesReadingSessionColumns: vi.fn(),
}));

vi.mock('../sessionNormalize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessionNormalize.js')>()),
  walkFixImportedProgress: vi.fn(),
}));

vi.mock('../../services/cache.js', () => ({
  getCacheService: vi.fn().mockReturnValue(null),
  getPubSubService: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/settings.js')>()),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('../heavyOpsLock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../heavyOpsLock.js')>()),
  isImportWaiting: vi.fn(),
}));

vi.mock('../lockUtils.js', () => ({
  extendJobLock: vi.fn(),
  DEFAULT_LOCK_DURATION_MS: 60_000,
}));

import { db } from '../../db/client.js';
import {
  aggregatesReadingSessionColumns,
  getTimescaleStatus,
  safeFullRefreshAggregate,
} from '../../db/timescale.js';
import { PROGRESS_COLUMNS, walkFixImportedProgress } from '../sessionNormalize.js';
import { queryChain } from '../../test/helpers.js';
import { extendJobLock } from '../lockUtils.js';
import { isImportWaiting } from '../heavyOpsLock.js';
import { getSetting, setSetting } from '../../services/settings.js';
import {
  enqueueMaintenanceJob,
  enqueueServerLocationSyncIfBehind,
  getMaintenanceJobHistory,
  initMaintenanceQueue,
  processBackfillLibrarySnapshotsJob,
  processNormalizeLibrarySnapshotsJob,
  processFixImportedProgressJob,
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
      await onBatch(10, { updated: 4, skipped: 6, errors: 0 });
      seen.push(getMaintenanceProgress()?.updatedRecords, getMaintenanceProgress()?.skippedRecords);
      return { total: 4, failedRanges: [], details: '' };
    }, false);

    expect(seen).toEqual([4, 6]);
  });

  it('reports the errors a walk returns and shows them while it runs', async () => {
    const seen: (number | undefined)[] = [];
    const result = await run(async (onBatch) => {
      await onBatch(10, { updated: 4, skipped: 5, errors: 1 });
      seen.push(getMaintenanceProgress()?.errorRecords);
      return { total: 4, failedRanges: [], details: '', errors: 1 };
    }, false);

    expect(seen).toEqual([1]);
    expect(result.errors).toBe(1);
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

describe('aggregate refresh after a walk', () => {
  const ALL = ['daily_content_engagement', 'user_media_plays_daily', 'daily_bandwidth_by_user'];
  const refreshed = () => vi.mocked(safeFullRefreshAggregate).mock.calls.map((call) => call[0]);

  beforeEach(() => {
    vi.mocked(getTimescaleStatus).mockResolvedValue({
      extensionInstalled: true,
      continuousAggregates: ALL,
    } as never);
  });

  it('refreshes nothing when no aggregate reads the columns the walk changed', async () => {
    vi.mocked(aggregatesReadingSessionColumns).mockResolvedValue([]);

    await runSessionMaintenanceWalk(job(), {
      type: 'normalize_resolutions',
      startMessage: 'start',
      progressMessage: () => '',
      completeMessage: () => '',
      resultMessage: () => '',
      failurePrefix: 'skipped',
      totalCountsUpdates: false,
      writes: ['quality'],
      walk: async (_onBatch, onCommit) => {
        onCommit(COMMITTED);
        return { total: 1, failedRanges: [], details: '' };
      },
    });

    expect(aggregatesReadingSessionColumns).toHaveBeenCalledWith(['quality']);
    expect(refreshed()).toEqual([]);
  });

  it('refreshes every aggregate when the lookup of the readers fails', async () => {
    vi.mocked(aggregatesReadingSessionColumns).mockRejectedValue(new Error('catalog unavailable'));

    await runSessionMaintenanceWalk(job(), {
      type: 'normalize_resolutions',
      startMessage: 'start',
      progressMessage: () => '',
      completeMessage: () => '',
      resultMessage: () => '',
      failurePrefix: 'skipped',
      totalCountsUpdates: false,
      writes: ['quality'],
      walk: async (_onBatch, onCommit) => {
        onCommit(COMMITTED);
        return { total: 1, failedRanges: [], details: '' };
      },
    });

    expect(refreshed()).toEqual(ALL);
  });

  it('refreshes only the aggregates that read the progress columns for fix_imported_progress', async () => {
    vi.mocked(aggregatesReadingSessionColumns).mockImplementation(async (columns) =>
      columns.includes('progress_ms') ? ['daily_content_engagement', 'user_media_plays_daily'] : []
    );
    vi.mocked(walkFixImportedProgress).mockImplementation(async ({ onCommit }) => {
      onCommit?.(COMMITTED);
      return { total: 1, failedRanges: [], details: '', processed: 1, skipped: 0, errors: 0 };
    });

    await processFixImportedProgressJob(job());

    expect(aggregatesReadingSessionColumns).toHaveBeenCalledWith(PROGRESS_COLUMNS);
    expect(refreshed()).toEqual(['daily_content_engagement', 'user_media_plays_daily']);
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

describe('library snapshot backfill', () => {
  const resume = {
    processed: 2,
    created: 40,
    cleanedUp: 0,
    errors: 0,
    earliest: '2020-01-01',
    refreshFrom: '2024-01-01T00:00:00.000Z',
    startedAt: Date.parse('2026-11-15T10:00:00Z'),
  };

  function backfillJob(
    data: MaintenanceJobData = {
      type: 'backfill_library_snapshots',
      userId: 'system',
      backfillResume: resume,
    }
  ) {
    return {
      id: 'backfill-job',
      token: 'token',
      data,
      updateData: vi.fn(),
      updateProgress: vi.fn(),
      moveToDelayed: vi.fn(),
    } as unknown as Job<MaintenanceJobData> & { updateData: Mock; moveToDelayed: Mock };
  }

  beforeEach(() => {
    vi.mocked(extendJobLock).mockResolvedValue(undefined);
    vi.mocked(db.execute).mockResolvedValue({ rows: [{ count: 3 }] } as never);
    vi.mocked(safeFullRefreshAggregate).mockImplementation(async (_name, _start, _end, options) => {
      options?.onProgress?.({ currentBatchEnd: '2024-01-31T00:00:00.000Z' } as never);
      await options?.pauseWhen?.();
      return [];
    });
  });

  it('hands the lock to a waiting import after a refresh batch and keeps where it stopped', async () => {
    vi.mocked(isImportWaiting).mockResolvedValue(true);
    const job = backfillJob();

    await expect(processBackfillLibrarySnapshotsJob(job)).rejects.toBeInstanceOf(DelayedError);

    expect(safeFullRefreshAggregate).toHaveBeenCalledWith(
      'library_stats_daily',
      new Date(resume.refreshFrom),
      expect.any(Date),
      expect.any(Object)
    );
    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        backfillResume: { ...resume, refreshFrom: '2024-01-31T00:00:00.000Z' },
      })
    );
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
  });

  it('finishes a resumed run with the counts and start time of the run it continues', async () => {
    vi.mocked(isImportWaiting).mockResolvedValue(false);
    vi.setSystemTime(resume.startedAt + 90_000);
    const job = backfillJob();

    const result = await processBackfillLibrarySnapshotsJob(job);

    expect(result).toMatchObject({
      success: true,
      processed: 2,
      updated: 40,
      skipped: 0,
      durationMs: 90_000,
    });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('refreshes a snapshot normalization through to its stamp while an import waits', async () => {
    vi.mocked(isImportWaiting).mockResolvedValue(true);
    vi.mocked(getSetting).mockImplementation((async (key: string) =>
      key === 'mediaVersionsBackfilledAt' ? '2026-11-01T00:00:00Z' : null) as never);
    vi.mocked(db.execute).mockImplementation((async (query: unknown) => {
      const text = JSON.stringify(query);
      if (text.includes('GROUP BY server_id, library_id')) {
        return {
          rows: [
            {
              server_id: 'srv-1',
              library_id: 'lib-1',
              start_date: '2026-11-10',
              end_date: '2026-11-15',
              item_count: '5',
            },
          ],
        };
      }
      if (text.includes('MIN(snapshot_time)')) return { rows: [{ earliest: '2020-01-01' }] };
      return { rows: [{ count: 3 }], rowCount: 0 };
    }) as never);
    vi.mocked(db.transaction).mockImplementation((async (run: (tx: unknown) => unknown) =>
      run({ execute: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })) as never);
    const job = backfillJob({ type: 'normalize_library_snapshots', userId: 'system' });

    const result = await processNormalizeLibrarySnapshotsJob(job);

    expect(result).toMatchObject({ success: true, type: 'normalize_library_snapshots' });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(setSetting).toHaveBeenCalledWith('snapshotsNormalizedAt', expect.any(String));
  });
});
