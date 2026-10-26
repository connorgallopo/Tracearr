import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

const { mockDbServers, mockIsLiveServer } = vi.hoisted(() => ({
  mockDbServers: vi.fn(async (): Promise<Array<{ id: string; name: string }>> => []),
  mockIsLiveServer: vi.fn(async (_id: string) => true),
}));

vi.mock('../../services/liveServers.js', () => ({
  liveServers: (...args: unknown[]) => mockDbServers(...(args as [])),
  isLiveServer: (...args: [string]) => mockIsLiveServer(...args),
}));

vi.mock('../../db/client.js', () => ({
  db: { select: () => ({ from: mockDbServers }) },
}));

vi.mock('../../services/librarySync.js', () => ({
  librarySyncService: { syncServer: vi.fn() },
  initLibrarySyncRedis: vi.fn(),
  maybeEnqueueImportedHistoryLink: vi.fn(),
  SyncInterruptedError: class SyncInterruptedError extends Error {},
  LibrariesFailedError: class LibrariesFailedError extends Error {
    constructor(readonly results: unknown[]) {
      super('Library sync failed for Movies');
    }
  },
}));

vi.mock('../../services/sync.js', () => ({
  syncServer: vi.fn(),
}));

const mockRedisScan = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisQuit = vi.fn();

vi.mock('../../services/cache.js', () => ({
  getPubSubService: vi.fn().mockReturnValue(null),
}));

vi.mock('../maintenanceQueue.js', () => ({
  enqueueMaintenanceJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../imagePrecacheQueue.js', () => ({
  enqueueImagePrecache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../precachePassPolicy.js', () => ({
  resolvePrecachePass: vi.fn().mockResolvedValue(null),
}));

const echoAdd = async (_name: string, _data: unknown, opts?: { jobId?: string }) => ({
  id: opts?.jobId,
});
const mockQueueAdd = vi.fn(echoAdd);
const mockQueueGetJobs = vi.fn().mockResolvedValue([]);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockGetJobSchedulers = vi.fn().mockResolvedValue([]);
const mockRemoveJobScheduler = vi.fn().mockResolvedValue(undefined);
const mockUpsertJobScheduler = vi.fn().mockResolvedValue({ id: 'job-1' });

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return {
      add: mockQueueAdd,
      getJobs: mockQueueGetJobs,
      close: mockQueueClose,
      getJobSchedulers: mockGetJobSchedulers,
      removeJobScheduler: mockRemoveJobScheduler,
      upsertJobScheduler: mockUpsertJobScheduler,
      on: vi.fn(),
    };
  }),
  Worker: vi.fn().mockImplementation(function MockWorker() {
    return { on: vi.fn(), once: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
  DelayedError: class DelayedError extends Error {},
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function MockRedis() {
    return { quit: mockRedisQuit, scan: mockRedisScan, del: mockRedisDel };
  }),
}));

import { DelayedError, Worker } from 'bullmq';
import {
  LibrariesFailedError,
  librarySyncService,
  maybeEnqueueImportedHistoryLink,
  SyncInterruptedError,
  type SyncResume,
} from '../../services/librarySync.js';
import { syncServer } from '../../services/sync.js';
import { enqueueImagePrecache } from '../imagePrecacheQueue.js';
import { resolvePrecachePass } from '../precachePassPolicy.js';
import {
  initLibrarySyncQueue,
  enqueueLibrarySync,
  enqueueLibrarySyncFromEvent,
  getAllActiveLibrarySyncs,
  getLibrarySyncStatus,
  hasPendingLibrarySync,
  scheduleAutoSync,
  rebuildAutoSyncSchedules,
  shutdownLibrarySyncQueue,
  startLibrarySyncWorker,
  invalidateLibraryCaches,
} from '../librarySyncQueue.js';
import type { SyncResult } from '../../services/librarySync.js';

/**
 * A job as BullMQ hands it back from getJobs for a job scheduler: id shaped
 * `repeat:<schedulerId>:<nextMillis>` and repeatJobKey hydrated from the `rjk`
 * hash field. Verified against bullmq 5.80.2 with a live Redis - a registered
 * scheduler parks exactly one such job in `delayed`, up to a full cron period
 * out, and repeatJobKey survives promotion to waiting/active.
 */
function schedulerJob(serverId: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'repeat:abc:123',
    repeatJobKey: 'abc',
    data: { serverId, triggeredBy: 'scheduled' },
    ...extra,
  };
}

/** A job nobody's scheduler owns: an event sync, its retry backoff, or a boot sync. */
function plainJob(
  serverId: string,
  triggeredBy: 'manual' | 'scheduled' = 'scheduled',
  extra: Record<string, unknown> = {}
) {
  return { id: `event-sync-${serverId}-1`, data: { serverId, triggeredBy }, ...extra };
}

/** What a scheduler slot produces since 2.9.0: a tick that only queues the real sync. */
function tickJob(serverId: string, extra: Record<string, unknown> = {}) {
  return schedulerJob(serverId, {
    data: { serverId, triggeredBy: 'scheduled', kind: 'tick' },
    ...extra,
  });
}

describe('enqueueLibrarySync', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueueGetJobs.mockResolvedValue([]);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  it('manual: removes a waiting automatic job for the server and adds with the dedup key', async () => {
    const scheduledRemove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJobs.mockResolvedValue([
      plainJob('srv-1', 'scheduled', { remove: scheduledRemove }),
    ]);

    await enqueueLibrarySync('srv-1', 'manual', 'user-1');

    expect(mockQueueGetJobs).toHaveBeenCalledWith(['waiting', 'delayed']);
    expect(scheduledRemove).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'manual-sync-srv-1',
      { serverId: 'srv-1', triggeredBy: 'manual', userId: 'user-1' },
      expect.objectContaining({
        deduplication: { id: 'sync-srv-1' },
        jobId: expect.stringMatching(/^sync-srv-1-/),
      })
    );
    expect(scheduledRemove.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueueAdd.mock.invocationCallOrder[0]!
    );
  });

  it('manual: leaves a waiting manual job, scheduler ticks and other servers alone', async () => {
    const manualRemove = vi.fn().mockResolvedValue(undefined);
    const parkedTickRemove = vi.fn().mockResolvedValue(undefined);
    const promotedTickRemove = vi.fn().mockResolvedValue(undefined);
    const otherServerRemove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJobs.mockResolvedValue([
      plainJob('srv-1', 'manual', { remove: manualRemove }),
      tickJob('srv-1', { remove: parkedTickRemove }),
      plainJob('srv-1', 'scheduled', {
        data: { serverId: 'srv-1', triggeredBy: 'scheduled', kind: 'tick' },
        remove: promotedTickRemove,
      }),
      plainJob('srv-other', 'scheduled', { remove: otherServerRemove }),
    ]);

    await enqueueLibrarySync('srv-1', 'manual');

    expect(manualRemove).not.toHaveBeenCalled();
    expect(parkedTickRemove).not.toHaveBeenCalled();
    expect(promotedTickRemove).not.toHaveBeenCalled();
    expect(otherServerRemove).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('manual: throws the in-progress message when the add is dropped', async () => {
    mockQueueAdd.mockResolvedValueOnce({ id: 'someone-else' });

    await expect(enqueueLibrarySync('srv-1', 'manual')).rejects.toThrow(
      'A sync is already in progress for this server'
    );
  });

  it('event and boot: dropped adds resolve without throwing', async () => {
    mockQueueAdd
      .mockResolvedValueOnce({ id: 'someone-else' })
      .mockResolvedValueOnce({ id: 'someone-else' });

    await expect(enqueueLibrarySyncFromEvent('srv-1')).resolves.toBeUndefined();
    await expect(enqueueLibrarySync('srv-1', 'boot')).resolves.toBe('someone-else');

    expect(mockQueueAdd).toHaveBeenNthCalledWith(
      1,
      'event-sync-srv-1',
      { serverId: 'srv-1', triggeredBy: 'scheduled' },
      expect.objectContaining({ deduplication: { id: 'sync-srv-1' } })
    );
    expect(mockQueueAdd).toHaveBeenNthCalledWith(
      2,
      'boot-sync-srv-1',
      { serverId: 'srv-1', triggeredBy: 'scheduled' },
      expect.objectContaining({ deduplication: { id: 'sync-srv-1' } })
    );
    expect(mockQueueGetJobs).not.toHaveBeenCalled();
  });

  it('boot passes the stagger delay through', async () => {
    await enqueueLibrarySync('srv-1', 'boot', undefined, 20_000);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'boot-sync-srv-1',
      { serverId: 'srv-1', triggeredBy: 'scheduled' },
      expect.objectContaining({ delay: 20_000, deduplication: { id: 'sync-srv-1' } })
    );
  });
});

describe('scheduleAutoSync', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueueGetJobs.mockResolvedValue([]);
    mockGetJobSchedulers.mockResolvedValue([]);
    mockDbServers.mockResolvedValue([
      { id: 'srv-1', name: 'Server One' },
      { id: 'srv-2', name: 'Server Two' },
    ]);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  it('upserts one tick scheduler per live server with kind tick and no legacy conversion', async () => {
    const legacyKey = '1f51c6da23a36cd0d3cb411d01b79122';
    mockGetJobSchedulers.mockResolvedValue([
      { key: legacyKey, name: 'auto-sync-srv-1', pattern: '10 */12 * * *', tz: 'UTC' },
    ]);

    await scheduleAutoSync();

    expect(mockRemoveJobScheduler).toHaveBeenCalledWith(legacyKey);
    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'scheduled-srv-1',
      { pattern: '10 */12 * * *', tz: 'UTC' },
      {
        name: 'auto-sync-srv-1',
        data: { serverId: 'srv-1', triggeredBy: 'scheduled', kind: 'tick' },
      }
    );
    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'scheduled-srv-2',
      { pattern: '14 */12 * * *', tz: 'UTC' },
      {
        name: 'auto-sync-srv-2',
        data: { serverId: 'srv-2', triggeredBy: 'scheduled', kind: 'tick' },
      }
    );
  });

  it('queues one boot sync per server through the dedup key, no getJobs sweep', async () => {
    await scheduleAutoSync();

    expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'boot-sync-srv-1',
      { serverId: 'srv-1', triggeredBy: 'scheduled' },
      expect.objectContaining({ delay: 10_000, deduplication: { id: 'sync-srv-1' } })
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'boot-sync-srv-2',
      { serverId: 'srv-2', triggeredBy: 'scheduled' },
      expect.objectContaining({ delay: 20_000, deduplication: { id: 'sync-srv-2' } })
    );
    expect(mockQueueGetJobs).not.toHaveBeenCalled();
  });

  it('rebuilds only the schedulers and never queues a boot sync', async () => {
    mockDbServers.mockResolvedValue([{ id: 'srv-1', name: 'Server One' }]);
    mockGetJobSchedulers.mockResolvedValue([{ key: 'old' }]);

    await rebuildAutoSyncSchedules();

    expect(mockRemoveJobScheduler).toHaveBeenCalledWith('old');
    expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'scheduled-srv-1',
      expect.anything(),
      expect.anything()
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockQueueGetJobs).not.toHaveBeenCalled();
  });

  it('leaves no schedulers when no live server remains', async () => {
    mockGetJobSchedulers.mockResolvedValue([{ key: 'old' }]);
    mockDbServers.mockResolvedValue([]);

    await rebuildAutoSyncSchedules();
    await scheduleAutoSync();

    expect(mockRemoveJobScheduler).toHaveBeenCalledTimes(2);
    expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe('worker processor', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedisScan.mockResolvedValue(['0', []]);
    mockRedisDel.mockResolvedValue(0);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  type Processor = (job: unknown, token?: string, signal?: AbortSignal) => Promise<unknown>;

  function startProcessor(): Processor {
    startLibrarySyncWorker();
    return vi.mocked(Worker).mock.calls[0]![1] as Processor;
  }

  function fakeJob(data: Record<string, unknown>, name = 'event-sync-srv-1') {
    const job = {
      id: 'job-1',
      name,
      token: 'tok',
      data,
      updateProgress: vi.fn(),
      extendLock: vi.fn().mockResolvedValue(1),
      updateData: vi.fn(async (next: Record<string, unknown>) => {
        job.data = next;
      }),
      moveToDelayed: vi.fn().mockResolvedValue(undefined),
    };
    return job;
  }

  it('a tick job enqueues a scheduled sync and returns without syncing', async () => {
    const processor = startProcessor();
    const job = fakeJob(
      { serverId: 'srv-1', triggeredBy: 'scheduled', kind: 'tick' },
      'auto-sync-srv-1'
    );

    await expect(processor(job)).resolves.toEqual({ skipped: true, reason: 'tick' });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'auto-sync-srv-1',
      { serverId: 'srv-1', triggeredBy: 'scheduled' },
      expect.objectContaining({ deduplication: { id: 'sync-srv-1' } })
    );
    expect(librarySyncService.syncServer).not.toHaveBeenCalled();
    expect(syncServer).not.toHaveBeenCalled();
  });

  it('resumes from completedLibraryIds and forces cache invalidation', async () => {
    let resume: SyncResume | undefined;
    vi.mocked(librarySyncService.syncServer).mockImplementation(async (_id, _p, _t, r) => {
      resume = r;
      return [fakeSyncResult()];
    });
    const processor = startProcessor();

    await processor(
      fakeJob({ serverId: 'srv-1', triggeredBy: 'scheduled', completedLibraryIds: ['lib-a'] })
    );

    expect(resume?.completedLibraryIds.has('lib-a')).toBe(true);
    expect(mockRedisScan).toHaveBeenCalled();
  });

  it('checkpoints after every library through onLibraryComplete', async () => {
    vi.mocked(librarySyncService.syncServer).mockImplementation(async (_id, _p, _t, r) => {
      await r!.onLibraryComplete('lib-a');
      await r!.onLibraryComplete('lib-b');
      return [];
    });
    const processor = startProcessor();
    const job = fakeJob({ serverId: 'srv-1', triggeredBy: 'scheduled' });

    await processor(job);

    expect(job.extendLock).toHaveBeenCalledTimes(2);
    expect(job.extendLock).toHaveBeenCalledWith('tok', 60_000);
    expect(job.updateData).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ completedLibraryIds: ['lib-a'] })
    );
    expect(job.updateData).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ completedLibraryIds: ['lib-a', 'lib-b'] })
    );
  });

  it('yields on SyncInterruptedError', async () => {
    vi.mocked(librarySyncService.syncServer).mockRejectedValue(new SyncInterruptedError());
    const processor = startProcessor();
    const job = fakeJob({ serverId: 'srv-1', triggeredBy: 'scheduled' });
    const controller = new AbortController();

    await expect(processor(job, 'tok', controller.signal)).rejects.toBeInstanceOf(DelayedError);

    expect(vi.mocked(librarySyncService.syncServer).mock.calls[0]![3]?.signal).toBe(
      controller.signal
    );
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
  });

  it('wraps up the libraries that synced before failing the job for the ones that did not', async () => {
    const failed = new LibrariesFailedError(
      [fakeSyncResult({ libraryName: 'TV Shows', itemsProcessed: 3 })],
      []
    );
    vi.mocked(librarySyncService.syncServer).mockRejectedValue(failed);
    const processor = startProcessor();

    await expect(processor(fakeJob({ serverId: 'srv-1', triggeredBy: 'scheduled' }))).rejects.toBe(
      failed
    );

    expect(mockRedisScan).toHaveBeenCalled();
  });
});

describe('hasPendingLibrarySync and getAllActiveLibrarySyncs', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  it('ignore tick jobs in every state', async () => {
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('delayed')
        ? [tickJob('srv-1', { getState: vi.fn().mockResolvedValue('delayed') })]
        : [
            tickJob('srv-1', { getState: vi.fn().mockResolvedValue('active') }),
            tickJob('srv-1', { getState: vi.fn().mockResolvedValue('waiting') }),
          ]
    );

    expect(await hasPendingLibrarySync('srv-1')).toBe(false);
    expect(await getAllActiveLibrarySyncs()).toEqual([]);
    expect(await getLibrarySyncStatus('srv-1')).toEqual({ isActive: false });
  });

  it('getLibrarySyncStatus reads the active job first and never asks a job for its state', async () => {
    const waiting = { ...plainJob('srv-1', 'scheduled', { id: 'waiting-1' }), getState: vi.fn() };
    const active = {
      ...plainJob('srv-1', 'manual', { id: 'active-1', progress: 40 }),
      getState: vi.fn(),
    };
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('active') ? [active] : [waiting]
    );

    expect(await getLibrarySyncStatus('srv-1')).toEqual({
      isActive: true,
      progress: 40,
      jobId: 'active-1',
    });
    expect(mockQueueGetJobs).toHaveBeenCalledTimes(1);
    expect(active.getState).not.toHaveBeenCalled();

    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('active') ? [] : [waiting]
    );
    expect(await getLibrarySyncStatus('srv-1')).toEqual({
      isActive: false,
      progress: undefined,
      jobId: 'waiting-1',
    });
    expect(waiting.getState).not.toHaveBeenCalled();
  });

  it('counts an active or waiting job for the server, never a delayed scheduler placeholder or another server', async () => {
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('delayed') ? [schedulerJob('srv-1')] : [plainJob('srv-2')]
    );
    expect(await hasPendingLibrarySync('srv-1')).toBe(false);
    expect(await hasPendingLibrarySync('srv-2')).toBe(true);

    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('delayed') ? [plainJob('srv-1')] : []
    );
    expect(await hasPendingLibrarySync('srv-1')).toBe(true);
  });

  it('counts as pending when the queue is not initialized', async () => {
    await shutdownLibrarySyncQueue();
    expect(await hasPendingLibrarySync('srv-1')).toBe(true);
  });

  it('excludes a delayed scheduler placeholder, includes a plain waiting job and an active scheduler-produced job', async () => {
    const waitingJob = plainJob('srv-1', 'scheduled', {
      getState: vi.fn().mockResolvedValue('waiting'),
      progress: 0,
      timestamp: 1000,
    });
    const activeSchedulerJob = schedulerJob('srv-2', {
      getState: vi.fn().mockResolvedValue('active'),
      progress: 42,
      timestamp: 2000,
    });
    const delayedPlaceholder = schedulerJob('srv-3', {
      getState: vi.fn().mockResolvedValue('delayed'),
      progress: 0,
      timestamp: 3000,
    });

    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('delayed') ? [delayedPlaceholder] : [waitingJob, activeSchedulerJob]
    );

    const result = await getAllActiveLibrarySyncs();

    expect(result.map((r) => r.serverId)).toEqual(['srv-1', 'srv-2']);
  });
});

function fakeSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    serverId: 'srv-1',
    libraryId: 'lib-1',
    libraryName: 'Movies',
    itemsProcessed: 0,
    itemsAdded: 0,
    itemsRemoved: 0,
    itemsSkipped: 0,
    snapshotId: null,
    ...overrides,
  };
}

describe('library sync worker - cache invalidation gating', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedisScan.mockResolvedValue(['0', []]);
    mockRedisDel.mockResolvedValue(0);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  /** Starts the worker, captures the processor bullmq's Worker mock was
   * constructed with, and runs it once against a fake job. */
  async function runSyncJob(results: SyncResult[]): Promise<void> {
    vi.mocked(librarySyncService.syncServer).mockResolvedValue(results);
    startLibrarySyncWorker();
    const processor = vi.mocked(Worker).mock.calls[0]![1] as (job: unknown) => Promise<unknown>;
    await processor({
      id: 'job-1',
      name: 'event-sync-srv-1',
      data: { serverId: 'srv-1', triggeredBy: 'scheduled' },
      updateProgress: vi.fn(),
    });
  }

  it('skips the job without syncing when the server is historical', async () => {
    mockIsLiveServer.mockResolvedValueOnce(false);
    vi.mocked(librarySyncService.syncServer).mockResolvedValue([]);
    startLibrarySyncWorker();
    const processor = vi.mocked(Worker).mock.calls[0]![1] as (job: unknown) => Promise<unknown>;

    const result = await processor({
      id: 'job-h',
      name: 'auto-sync-srv-1',
      data: { serverId: 'srv-1', triggeredBy: 'scheduled' },
      updateProgress: vi.fn(),
    });

    expect(result).toEqual({ skipped: true, reason: 'server historical' });
    expect(librarySyncService.syncServer).not.toHaveBeenCalled();
    expect(syncServer).not.toHaveBeenCalled();
  });

  it('skips cache invalidation when the sync processed nothing', async () => {
    await runSyncJob([fakeSyncResult({ itemsProcessed: 0 })]);
    expect(mockRedisScan).not.toHaveBeenCalled();
  });

  it('invalidates the cache when the sync processed items', async () => {
    await runSyncJob([fakeSyncResult({ itemsProcessed: 5, itemsAdded: 5 })]);
    expect(mockRedisScan).toHaveBeenCalled();
  });

  it('invalidates the cache when a full scan tombstoned everything (itemsProcessed 0, itemsRemoved > 0)', async () => {
    await runSyncJob([fakeSyncResult({ itemsProcessed: 0, itemsRemoved: 5 })]);
    expect(mockRedisScan).toHaveBeenCalled();
  });

  it('invalidates the cache when orphan cleanup removed items (surfaced as a synthetic result)', async () => {
    await runSyncJob([
      fakeSyncResult({ itemsProcessed: 0, itemsRemoved: 0 }),
      fakeSyncResult({
        libraryId: 'orphan-cleanup',
        libraryName: 'Orphaned libraries cleanup',
        itemsRemoved: 3,
      }),
    ]);
    expect(mockRedisScan).toHaveBeenCalled();
  });
});

describe('invalidateLibraryCaches - collapsed single-cursor scan', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  it('walks the shared library cache namespace once and only deletes keys matching a target prefix', async () => {
    mockRedisScan
      .mockResolvedValueOnce([
        '0',
        [
          'tracearr:library:stats:v2:server-1',
          'tracearr:library:sync:last:server-1:lib-1', // sync state - must survive
          'tracearr:library:media-detail:v2:abc',
          'tracearr:library:precache:watermark:server-1', // precache state - must survive
        ],
      ])
      .mockResolvedValueOnce(['0', []]); // public media-stats namespace sweep
    mockRedisDel.mockResolvedValue(0);

    await invalidateLibraryCaches('server-1');

    expect(mockRedisScan).toHaveBeenCalledTimes(2);
    expect(mockRedisScan).toHaveBeenNthCalledWith(
      1,
      '0',
      'MATCH',
      'tracearr:library:*',
      'COUNT',
      500
    );
    expect(mockRedisScan).toHaveBeenNthCalledWith(
      2,
      '0',
      'MATCH',
      'tracearr:public:media-stats:*',
      'COUNT',
      500
    );
    expect(mockRedisDel).toHaveBeenCalledWith(
      'tracearr:library:stats:v2:server-1',
      'tracearr:library:media-detail:v2:abc'
    );
  });

  it('walks multiple cursor pages but issues only one delete for all matched keys', async () => {
    mockRedisScan
      .mockResolvedValueOnce(['17', ['tracearr:library:stats:v2:server-1']])
      .mockResolvedValueOnce(['0', ['tracearr:library:genres:server-1']])
      .mockResolvedValueOnce(['0', ['tracearr:public:media-stats:libraries']]);
    mockRedisDel.mockResolvedValue(0);

    await invalidateLibraryCaches('server-1');

    expect(mockRedisScan).toHaveBeenCalledTimes(3);
    expect(mockRedisDel).toHaveBeenCalledTimes(1);
    expect(mockRedisDel).toHaveBeenCalledWith(
      'tracearr:library:stats:v2:server-1',
      'tracearr:library:genres:server-1',
      'tracearr:public:media-stats:libraries'
    );
  });

  it('does nothing when no matching keys are found', async () => {
    mockRedisScan.mockResolvedValueOnce(['0', []]).mockResolvedValueOnce(['0', []]);

    await invalidateLibraryCaches('server-1');

    expect(mockRedisDel).not.toHaveBeenCalled();
  });
});

describe('library sync worker - precache pass stamps', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedisScan.mockResolvedValue(['0', []]);
    mockRedisDel.mockResolvedValue(0);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  /** Runs one sync whose precache pass is due, with the enqueue reporting
   *  either the job it added or nothing (a pass was already queued). */
  async function runSyncWithPass(enqueuedJobId: string | undefined) {
    const commit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(resolvePrecachePass).mockResolvedValue({
      sinceUpdatedAt: '2026-08-01T00:00:00.000Z',
      commit,
    });
    vi.mocked(enqueueImagePrecache).mockResolvedValue(enqueuedJobId);
    vi.mocked(librarySyncService.syncServer).mockResolvedValue([
      fakeSyncResult({ itemsProcessed: 5, itemsAdded: 5 }),
    ]);

    startLibrarySyncWorker();
    const processor = vi.mocked(Worker).mock.calls[0]![1] as (job: unknown) => Promise<unknown>;
    await processor({
      id: 'job-1',
      name: 'event-sync-srv-1',
      data: { serverId: 'srv-1', triggeredBy: 'scheduled' },
      updateProgress: vi.fn(),
    });
    return commit;
  }

  it('stamps the window once the pass is queued', async () => {
    const commit = await runSyncWithPass('precache-srv-1-start-1');
    expect(enqueueImagePrecache).toHaveBeenCalledWith('srv-1', '2026-08-01T00:00:00.000Z');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('leaves the watermark where it is when a pass was already queued for the server', async () => {
    const commit = await runSyncWithPass(undefined);
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('library sync worker - user sync', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockRedisScan.mockResolvedValue(['0', []]);
    mockRedisDel.mockResolvedValue(0);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
    vi.mocked(librarySyncService.syncServer).mockResolvedValue([]);
    vi.mocked(syncServer).mockResolvedValue({
      usersAdded: 0,
      usersUpdated: 1,
      usersSkipped: 0,
      usersRemoved: 0,
      usersRestored: 0,
      librariesSynced: 0,
      errors: [],
    });
  });

  async function runJob(name: string): Promise<unknown> {
    startLibrarySyncWorker();
    const processor = vi.mocked(Worker).mock.calls[0]![1] as (job: unknown) => Promise<unknown>;
    return processor({
      id: 'job-1',
      name,
      data: { serverId: 'srv-1', triggeredBy: 'scheduled' },
      updateProgress: vi.fn(),
    });
  }

  it.each(['auto-sync-srv-1', 'boot-sync-srv-1'])(
    'syncs the server users, and only them, before the libraries on %s',
    async (name) => {
      await runJob(name);
      expect(syncServer).toHaveBeenCalledWith('srv-1', { syncUsers: true, syncLibraries: false });
      expect(vi.mocked(syncServer).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(librarySyncService.syncServer).mock.invocationCallOrder[0]!
      );
    }
  );

  it.each(['event-sync-srv-1', 'manual-sync-srv-1'])('leaves users alone on %s', async (name) => {
    await runJob(name);
    expect(syncServer).not.toHaveBeenCalled();
    expect(librarySyncService.syncServer).toHaveBeenCalled();
  });

  it('still syncs the libraries when the user sync throws', async () => {
    vi.mocked(syncServer).mockRejectedValue(new Error('plex.tv unreachable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(runJob('auto-sync-srv-1')).resolves.toMatchObject({ success: true });
    expect(librarySyncService.syncServer).toHaveBeenCalled();
  });
});

describe('library sync worker - imported history link hand-off', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  /** Fires the worker's completed handler for a finished sync of a server of `type`. */
  async function complete(type: string, returnvalue: unknown) {
    mockDbServers.mockImplementation((() => ({
      where: () => Object.assign(Promise.resolve([{ type }]), { limit: async () => [] }),
    })) as never);
    startLibrarySyncWorker();
    const worker = vi.mocked(Worker).mock.results[0]!.value as { on: ReturnType<typeof vi.fn> };
    const onCompleted = worker.on.mock.calls.find((c) => c[0] === 'completed')![1] as (
      job: unknown
    ) => void;
    onCompleted({
      id: 'job-1',
      data: { serverId: 'srv-1', triggeredBy: 'scheduled' },
      returnvalue,
    });
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('hands a completed Plex sync off, saying whether it added items', async () => {
    await complete('plex', { success: true, results: [fakeSyncResult({ itemsAdded: 2 })] });
    expect(maybeEnqueueImportedHistoryLink).toHaveBeenCalledWith(true, hasPendingLibrarySync);
  });

  it('hands off nothing for a non-Plex server or a skipped job', async () => {
    await complete('jellyfin', { success: true, results: [fakeSyncResult({ itemsAdded: 2 })] });
    await shutdownLibrarySyncQueue();
    vi.mocked(Worker).mockClear();
    initLibrarySyncQueue('redis://localhost:6379');
    await complete('plex', { skipped: true, reason: 'sync already in progress' });
    expect(maybeEnqueueImportedHistoryLink).not.toHaveBeenCalled();
  });
});
