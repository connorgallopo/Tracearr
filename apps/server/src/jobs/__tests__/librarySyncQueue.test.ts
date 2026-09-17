import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

const { mockDbServers } = vi.hoisted(() => ({
  mockDbServers: vi.fn(
    async (): Promise<
      Array<{ id: string; name: string; type: 'plex' | 'jellyfin' | 'emby' | 'dispatcharr' }>
    > => []
  ),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => {
        const result = mockDbServers();
        return {
          then: result.then.bind(result),
          where: () => ({ then: result.then.bind(result), limit: () => result }),
        };
      },
    }),
  },
}));

vi.mock('../../services/librarySync.js', () => ({
  librarySyncService: { syncServer: vi.fn() },
  initLibrarySyncRedis: vi.fn(),
  maybeEnqueueImportedHistoryLink: vi.fn(),
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

const mockQueueAdd = vi.fn().mockResolvedValue({ id: 'job-1' });
const mockQueueGetJobs = vi.fn().mockResolvedValue([]);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockGetJobSchedulers = vi.fn().mockResolvedValue([]);
const mockRemoveJobScheduler = vi.fn().mockResolvedValue(undefined);

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return {
      add: mockQueueAdd,
      getJobs: mockQueueGetJobs,
      close: mockQueueClose,
      getJobSchedulers: mockGetJobSchedulers,
      removeJobScheduler: mockRemoveJobScheduler,
      on: vi.fn(),
    };
  }),
  Worker: vi.fn().mockImplementation(function MockWorker() {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function MockRedis() {
    return { quit: mockRedisQuit, scan: mockRedisScan, del: mockRedisDel };
  }),
}));

import { Worker } from 'bullmq';
import { librarySyncService, maybeEnqueueImportedHistoryLink } from '../../services/librarySync.js';
import { syncServer } from '../../services/sync.js';
import { enqueueImagePrecache } from '../imagePrecacheQueue.js';
import { resolvePrecachePass } from '../precachePassPolicy.js';
import {
  initLibrarySyncQueue,
  enqueueLibrarySync,
  enqueueLibrarySyncFromEvent,
  getAllActiveLibrarySyncs,
  hasPendingLibrarySync,
  scheduleAutoSync,
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

describe('enqueueLibrarySyncFromEvent', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueueAdd.mockResolvedValue({ id: 'job-1' });
    mockQueueGetJobs.mockResolvedValue([]);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  it('does nothing when the queue has not been initialized', async () => {
    await shutdownLibrarySyncQueue();
    await enqueueLibrarySyncFromEvent('srv-1');
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('enqueues a scheduled-triggered sync (not manual, to keep the incremental path eligible)', async () => {
    await enqueueLibrarySyncFromEvent('srv-1');

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'event-sync-srv-1',
      { serverId: 'srv-1', triggeredBy: 'scheduled' },
      expect.objectContaining({ jobId: expect.stringMatching(/^event-sync-srv-1-\d+$/) })
    );
  });

  it('skips enqueueing when a sync is already active for the server', async () => {
    mockQueueGetJobs.mockResolvedValue([plainJob('srv-1')]);

    await enqueueLibrarySyncFromEvent('srv-1');

    expect(mockQueueAdd).not.toHaveBeenCalled();
    // Running states and delayed are read separately so the scheduler-owned
    // placeholder can be filtered out of delayed alone.
    expect(mockQueueGetJobs).toHaveBeenCalledWith(['active', 'waiting']);
    expect(mockQueueGetJobs).toHaveBeenCalledWith(['delayed']);
  });

  it('skips enqueueing when a WAITING job already exists for the server', async () => {
    // Mock returns the pending job only if 'waiting' is among the requested
    // states - pins that the states array was actually widened, not just that
    // any getJobs response happens to contain a matching job.
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('waiting') ? [plainJob('srv-1')] : []
    );

    await enqueueLibrarySyncFromEvent('srv-1');

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('skips enqueueing when a DELAYED job already exists for the server', async () => {
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('delayed') ? [plainJob('srv-1')] : []
    );

    await enqueueLibrarySyncFromEvent('srv-1');

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('enqueues despite a scheduler-owned DELAYED job - that is a parked cron placeholder, not pending work', async () => {
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('delayed') ? [schedulerJob('srv-1')] : []
    );

    await enqueueLibrarySyncFromEvent('srv-1');

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'event-sync-srv-1',
      { serverId: 'srv-1', triggeredBy: 'scheduled' },
      expect.objectContaining({ jobId: expect.stringMatching(/^event-sync-srv-1-\d+$/) })
    );
  });

  it('skips enqueueing when a scheduler-produced job has reached ACTIVE - promoted jobs keep repeatJobKey but are real work', async () => {
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('active') ? [schedulerJob('srv-1')] : []
    );

    await enqueueLibrarySyncFromEvent('srv-1');

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('skips enqueueing when a scheduler-produced job has reached WAITING', async () => {
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('waiting') ? [schedulerJob('srv-1')] : []
    );

    await enqueueLibrarySyncFromEvent('srv-1');

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('does not skip other servers active jobs', async () => {
    mockQueueGetJobs.mockResolvedValue([plainJob('srv-other')]);

    await enqueueLibrarySyncFromEvent('srv-1');

    expect(mockQueueAdd).toHaveBeenCalled();
  });
});

describe('enqueueLibrarySync', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueueAdd.mockResolvedValue({ id: 'job-1' });
    mockQueueGetJobs.mockResolvedValue([]);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  it('throws "already in progress" when an ACTIVE job exists for the server', async () => {
    const activeRemove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('active') ? [plainJob('srv-1', 'manual', { remove: activeRemove })] : []
    );

    await expect(enqueueLibrarySync('srv-1')).rejects.toThrow(
      'A sync is already in progress for this server'
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
    // The throw happens before any removal pass runs over queued jobs.
    expect(activeRemove).not.toHaveBeenCalled();
  });

  it('removes queued triggeredBy: scheduled jobs for the server, then adds the manual job', async () => {
    const scheduledRemove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJobs.mockImplementation(async (states: string[]) => {
      if (states.includes('active')) return [];
      return [plainJob('srv-1', 'scheduled', { remove: scheduledRemove })];
    });

    await enqueueLibrarySync('srv-1');

    expect(scheduledRemove).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'manual-sync-srv-1',
      expect.objectContaining({ serverId: 'srv-1', triggeredBy: 'manual' }),
      expect.objectContaining({ jobId: expect.stringMatching(/^manual-srv-1-\d+$/) })
    );
  });

  it('does not remove a waiting job with triggeredBy: manual (another queued manual sync survives)', async () => {
    const manualRemove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJobs.mockImplementation(async (states: string[]) => {
      if (states.includes('active')) return [];
      return [plainJob('srv-1', 'manual', { remove: manualRemove })];
    });

    await enqueueLibrarySync('srv-1');

    expect(manualRemove).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('does not remove queued scheduled jobs belonging to other servers', async () => {
    const otherServerRemove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJobs.mockImplementation(async (states: string[]) => {
      if (states.includes('active')) return [];
      return [plainJob('srv-other', 'scheduled', { remove: otherServerRemove })];
    });

    await enqueueLibrarySync('srv-1');

    expect(otherServerRemove).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalled();
  });

  it('never calls remove() on a scheduler-owned job - BullMQ refuses and it is only a parked placeholder', async () => {
    const schedulerRemove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJobs.mockImplementation(async (states: string[]) => {
      if (states.includes('active')) return [];
      return [schedulerJob('srv-1', { remove: schedulerRemove })];
    });

    await enqueueLibrarySync('srv-1');

    expect(schedulerRemove).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalled();
  });
});

describe('scheduleAutoSync - boot sync pending-job check', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueueAdd.mockResolvedValue({ id: 'job-1' });
    mockQueueGetJobs.mockResolvedValue([]);
    mockGetJobSchedulers.mockResolvedValue([]);
    mockDbServers.mockResolvedValue([{ id: 'srv-1', name: 'Server One', type: 'plex' }]);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
  });

  it('still queues boot sync when the only delayed job is the scheduler placeholder it just planted', async () => {
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('delayed') ? [schedulerJob('srv-1')] : []
    );

    await scheduleAutoSync();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'boot-sync-srv-1',
      { serverId: 'srv-1', triggeredBy: 'scheduled' },
      expect.objectContaining({ jobId: expect.stringMatching(/^boot-sync-srv-1-\d+$/) })
    );
  });

  it('skips boot sync when a genuine non-scheduler job is already pending for the server', async () => {
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('waiting') ? [plainJob('srv-1')] : []
    );

    await scheduleAutoSync();

    expect(mockQueueAdd).not.toHaveBeenCalledWith(
      'boot-sync-srv-1',
      expect.anything(),
      expect.anything()
    );
  });

  it('sweeps banked duplicate queued jobs, keeping only the newest per server', async () => {
    // Older releases banked one event-sync job per 30s bucket during a long
    // scan, and the backlog survives restarts
    const oldRemove = vi.fn().mockResolvedValue(undefined);
    const olderRemove = vi.fn().mockResolvedValue(undefined);
    const newestRemove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('waiting')
        ? [
            plainJob('srv-1', 'scheduled', { id: 'e1', timestamp: 100, remove: oldRemove }),
            plainJob('srv-1', 'scheduled', { id: 'e2', timestamp: 200, remove: olderRemove }),
            plainJob('srv-1', 'scheduled', { id: 'e3', timestamp: 300, remove: newestRemove }),
            schedulerJob('srv-1'),
          ]
        : []
    );

    await scheduleAutoSync();

    expect(oldRemove).toHaveBeenCalledTimes(1);
    expect(olderRemove).toHaveBeenCalledTimes(1);
    expect(newestRemove).not.toHaveBeenCalled();
    // The survivor counts as pending, so no boot sync stacks on top
    expect(mockQueueAdd).not.toHaveBeenCalledWith(
      'boot-sync-srv-1',
      expect.anything(),
      expect.anything()
    );
  });

  it('keeps sweeping and boot-syncing when a stale job raced to active and cannot be removed', async () => {
    const racedRemove = vi.fn().mockRejectedValue(new Error('job is active'));
    const newestRemove = vi.fn().mockResolvedValue(undefined);
    mockQueueGetJobs.mockImplementation(async (states: string[]) =>
      states.includes('waiting')
        ? [
            plainJob('srv-1', 'scheduled', { id: 'e1', timestamp: 100, remove: racedRemove }),
            plainJob('srv-1', 'scheduled', { id: 'e2', timestamp: 200, remove: newestRemove }),
          ]
        : []
    );

    await expect(scheduleAutoSync()).resolves.toBeUndefined();
    expect(racedRemove).toHaveBeenCalledTimes(1);
    expect(newestRemove).not.toHaveBeenCalled();
  });
});

describe('getAllActiveLibrarySyncs', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockQueueGetJobs.mockResolvedValue([]);
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
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

describe('hasPendingLibrarySync', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await shutdownLibrarySyncQueue();
    initLibrarySyncQueue('redis://localhost:6379');
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
  async function complete(
    type: 'plex' | 'jellyfin' | 'emby' | 'dispatcharr',
    returnvalue: unknown
  ) {
    mockDbServers.mockResolvedValue([{ id: 'srv-1', name: 'Test Server', type }]);
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
