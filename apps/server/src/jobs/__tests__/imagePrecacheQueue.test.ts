/**
 * Image Precache Queue tests.
 *
 * Covers the enabled-setting gate, the one-pass-per-server guard and its
 * backlog sweep, batch/cursor re-enqueue, the pause-while-sync branch, the
 * <=2 concurrent warm bound, and the disk-limited flag the guard threads
 * through a pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REDIS_KEYS } from '@tracearr/shared';
import {
  WARM_CONCURRENCY_IDLE,
  WARM_CONCURRENCY_LIGHT,
  WARM_CONCURRENCY_HEAVY,
  FAILURE_BACKOFF_BATCHES,
  FAILURE_BACKOFF_BASE_MS,
} from '../warmConcurrency.js';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';

const mockGetSetting = vi.fn();
const mockGetLibrarySyncStatus = vi.fn();
const mockProxyImage = vi.fn();
const mockPosterCacheEntryExists = vi.fn();
const mockDbSelect = vi.fn();
const mockTakeRefusedWrites = vi.fn();
const mockWriteDiskLimited = vi.fn();
const mockClearDiskLimited = vi.fn();
const mockReadDiskLimited = vi.fn();
const mockIsOnMountedVolume = vi.fn();
const mockReconcileImagePrecacheOnBoot = vi.fn();
const mockSweepImageCache = vi.fn();
const mockIsLiveServer = vi.fn().mockResolvedValue(true);
const mockLiveServers = vi.fn().mockResolvedValue([]);
vi.mock('../../services/liveServers.js', () => ({
  isLiveServer: (...args: unknown[]) => mockIsLiveServer(...args),
  liveServers: (...args: unknown[]) => mockLiveServers(...args),
}));

vi.mock('../../services/settings.js', () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

vi.mock('../librarySyncQueue.js', () => ({
  getLibrarySyncStatus: (...args: unknown[]) => mockGetLibrarySyncStatus(...args),
}));

vi.mock('../../services/imageProxy.js', () => ({
  IMAGE_CACHE_DIR: '/cache',
  proxyImage: (...args: unknown[]) => mockProxyImage(...args),
  posterCacheEntryExists: (...args: unknown[]) => mockPosterCacheEntryExists(...args),
}));

vi.mock('../../services/imageCacheGuard.js', () => ({
  takeRefusedWrites: (...args: unknown[]) => mockTakeRefusedWrites(...args),
  writeDiskLimited: (...args: unknown[]) => mockWriteDiskLimited(...args),
  clearDiskLimited: (...args: unknown[]) => mockClearDiskLimited(...args),
  readDiskLimited: (...args: unknown[]) => mockReadDiskLimited(...args),
  isOnMountedVolume: (...args: unknown[]) => mockIsOnMountedVolume(...args),
}));

const mockGetAllActiveSessions = vi.fn<() => Promise<Array<Record<string, unknown>>>>();
vi.mock('../../services/cache.js', () => ({
  getCacheService: () => ({ getAllActiveSessions: mockGetAllActiveSessions }),
}));

const redisStore = new Map<string, string>();
vi.mock('../../lib/redisShared.js', () => ({
  getRedis: () =>
    ({
      get: (k: string) => Promise.resolve(redisStore.get(k) ?? null),
      set: (k: string, v: string) => {
        redisStore.set(k, v);
        return Promise.resolve('OK');
      },
      del: (k: string) => {
        redisStore.delete(k);
        return Promise.resolve(1);
      },
    }) as never,
}));

vi.mock('../../services/imageCacheSweep.js', () => ({
  sweepImageCache: (...args: unknown[]) => mockSweepImageCache(...args),
}));

vi.mock('../imagePrecacheBoot.js', () => ({
  reconcileImagePrecacheOnBoot: (...args: unknown[]) => mockReconcileImagePrecacheOnBoot(...args),
}));

vi.mock('../../db/client.js', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));

vi.mock('../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

const mockQueueAdd = vi.fn();
const mockQueueGetJobs = vi.fn();
const mockQueueClose = vi.fn();
const mockWorkerClose = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return {
      add: mockQueueAdd,
      getJobs: mockQueueGetJobs,
      close: mockQueueClose,
      on: vi.fn(),
    };
  }),
  Worker: vi.fn().mockImplementation(function MockWorker() {
    return {
      on: vi.fn(),
      close: mockWorkerClose,
    };
  }),
}));

import {
  initImagePrecacheQueue,
  enqueueImagePrecache,
  processImagePrecacheJob,
  _resetWarmBackoffForTests,
  shutdownImagePrecacheQueue,
  startImagePrecacheWorker,
  type ImagePrecacheJobData,
} from '../imagePrecacheQueue.js';

function makeJob(data: ImagePrecacheJobData): Job<ImagePrecacheJobData> {
  return { data } as unknown as Job<ImagePrecacheJobData>;
}

/**
 * Mock both drizzle query shapes the processor uses: the batch fetch
 * (select().from().where().orderBy().limit() -> rows) and the pass-progress
 * count (select().from().where() awaited directly -> [{ n }]).
 */
function mockBatchQuery(rows: unknown[], eligibleCount = rows.length) {
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => {
        const countResult = Promise.resolve([{ n: eligibleCount }]);
        return Object.assign(countResult, {
          orderBy: () => ({
            limit: () => Promise.resolve(rows),
          }),
        });
      },
    }),
  });
}

function makeItemRow(id: string, thumbPath: string | null = '/thumb') {
  return { id, thumbPath };
}

/** A pass start as the queue hands it back: no passStartedAt, which is what
 *  separates an externally enqueued start from the chain's own jobs. */
function startJob(
  id: string,
  serverId: string,
  timestamp: number,
  sinceUpdatedAt = '2026-08-22T00:00:00.000Z'
) {
  return {
    id,
    timestamp,
    data: { serverId, cursor: null, sinceUpdatedAt },
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

/** A job of a pass already under way: cursor-advanced and carrying passStartedAt. */
function chainedJob(id: string, serverId: string, timestamp: number) {
  return {
    id,
    timestamp,
    data: { serverId, cursor: 'item-49', passStartedAt: '2026-08-22T00:00:00.000Z' },
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

/** A 2.0.x continuation: cursor-advanced, but no passStartedAt - that field
 *  only ships from 2.1.0, so a backlog banked by 2.0.x has jobs shaped this way. */
function legacyChainedJob(id: string, serverId: string, timestamp: number) {
  return {
    id,
    timestamp,
    data: { serverId, cursor: 'item-49' },
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

/** getJobs(['active']) and getJobs(['waiting','delayed']) answer separately. */
function queueHolds(held: { active?: unknown[]; pending?: unknown[] }) {
  mockQueueGetJobs.mockImplementation((states: string[]) =>
    Promise.resolve(states.includes('active') ? (held.active ?? []) : (held.pending ?? []))
  );
}

/** An empty queue for the pre-add guard, then the given jobs for the sweep -
 *  what a second sync adding in the same tick looks like from in here. */
function queueFillsAfterAdd(pending: unknown[]) {
  let pendingReads = 0;
  mockQueueGetJobs.mockImplementation((states: string[]) => {
    if (states.includes('active')) return Promise.resolve([]);
    pendingReads++;
    return Promise.resolve(pendingReads === 1 ? [] : pending);
  });
}

describe('imagePrecacheQueue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    _resetWarmBackoffForTests();
    await shutdownImagePrecacheQueue();
    initImagePrecacheQueue('redis://localhost:6379');
    mockGetSetting.mockResolvedValue(true);
    mockGetAllActiveSessions.mockResolvedValue([]);
    mockGetLibrarySyncStatus.mockResolvedValue({ isActive: false });
    mockProxyImage.mockResolvedValue({
      data: Buffer.from(''),
      contentType: 'image/webp',
      cached: false,
    });
    // Missing by default, so pre-existing tests that assume every candidate
    // item gets warmed keep passing unchanged.
    mockPosterCacheEntryExists.mockResolvedValue(false);
    mockTakeRefusedWrites.mockReturnValue(0);
    mockReadDiskLimited.mockResolvedValue(null);
    mockReconcileImagePrecacheOnBoot.mockResolvedValue({ ran: false, passes: 0 });
    queueHolds({});
  });

  describe('enqueueImagePrecache', () => {
    it('enqueues when imagePrecacheEnabled is true', async () => {
      mockGetSetting.mockResolvedValue(true);
      mockQueueAdd.mockResolvedValue({ id: 'job-1' });

      const result = await enqueueImagePrecache('server-1');

      expect(mockGetSetting).toHaveBeenCalledWith('imagePrecacheEnabled');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({ serverId: 'server-1', cursor: null });
      expect(result).toBe('job-1');
    });

    it('does not enqueue when imagePrecacheEnabled is false', async () => {
      mockGetSetting.mockResolvedValue(false);

      const result = await enqueueImagePrecache('server-1');

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('adds nothing while a pass for the server is waiting', async () => {
      queueHolds({ pending: [startJob('precache-server-1-start-1', 'server-1', 1000)] });

      const result = await enqueueImagePrecache('server-1', '2026-08-22T10:00:00.000Z');

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('adds nothing while a pass for the server is active', async () => {
      queueHolds({ active: [chainedJob('precache-server-1-item-49-1', 'server-1', 1000)] });

      const result = await enqueueImagePrecache('server-1', '2026-08-22T10:00:00.000Z');

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('adds nothing while the running pass sits in its sync-active backoff', async () => {
      queueHolds({ pending: [chainedJob('precache-server-1-item-49-1', 'server-1', 1000)] });

      const result = await enqueueImagePrecache('server-1');

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('adds when only another server has a pass queued', async () => {
      queueHolds({ pending: [startJob('precache-server-2-start-1', 'server-2', 1000)] });
      mockQueueAdd.mockResolvedValue({ id: 'job-1' });

      const result = await enqueueImagePrecache('server-1', '2026-08-22T10:00:00.000Z');

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: null,
        sinceUpdatedAt: '2026-08-22T10:00:00.000Z',
      });
      expect(result).toBe('job-1');
    });

    it('reports nothing when a same-tick add for the server won the sweep', async () => {
      const racer = startJob('precache-server-1-start-1', 'server-1', 1000);
      const ours = startJob('precache-server-1-start-2', 'server-1', 2000);
      queueFillsAfterAdd([racer, ours]);
      mockQueueAdd.mockResolvedValue({ id: ours.id });

      const result = await enqueueImagePrecache('server-1');

      // One start survives whoever sweeps first; the caller whose own start went
      // has no queued pass to stamp for.
      expect(racer.remove).not.toHaveBeenCalled();
      expect(ours.remove).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined();
    });
  });

  describe('startImagePrecacheWorker backlog sweep', () => {
    it('leaves only the oldest of 16 queued passes for a server, and other servers alone', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const oldest = startJob(
        'precache-server-1-start-0',
        'server-1',
        1000,
        '2026-08-01T00:00:00.000Z'
      );
      const newer = Array.from({ length: 15 }, (_, i) =>
        startJob(
          `precache-server-1-start-${i + 1}`,
          'server-1',
          2000 + i,
          `2026-08-0${(i % 8) + 2}T00:00:00.000Z`
        )
      );
      const otherServer = startJob('precache-server-2-start-0', 'server-2', 500);
      queueHolds({ pending: [...newer, oldest, otherServer] });

      await startImagePrecacheWorker();

      expect(oldest.remove).not.toHaveBeenCalled();
      for (const job of newer) {
        expect(job.remove).toHaveBeenCalledTimes(1);
        // Why the oldest is the keeper: every dropped pass starts later, so the
        // survivor's window is the only one that covers all of theirs.
        expect(job.data.sinceUpdatedAt > oldest.data.sinceUpdatedAt).toBe(true);
      }
      expect(otherServer.remove).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        '[ImagePrecache] dropped 15 duplicate passes for server-1'
      );
      logSpy.mockRestore();
    });

    it('leaves a pre-2.1 backlog continuation alone and drops the start beside it', async () => {
      // Queued later than the start it continues past, which is what a running
      // pass looks like: on age alone the sweep would take it, not the start.
      const legacy = legacyChainedJob('precache-server-1-item-49-1', 'server-1', 3000);
      const queued = startJob('precache-server-1-start-1', 'server-1', 1000);
      queueHolds({ pending: [legacy, queued] });

      await startImagePrecacheWorker();

      expect(legacy.remove).not.toHaveBeenCalled();
      // It is a pass in flight, so no start keeps its place beside it either.
      expect(queued.remove).toHaveBeenCalledTimes(1);
    });

    it('starts the worker anyway when the sweep cannot reach the queue', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockQueueGetJobs.mockRejectedValue(new Error('redis unavailable'));

      await startImagePrecacheWorker();

      expect(vi.mocked(Worker)).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it('leaves no queued pass for a server whose pass is already active', async () => {
      const queued = startJob('precache-server-1-start-1', 'server-1', 2000);
      queueHolds({
        active: [chainedJob('precache-server-1-item-49-1', 'server-1', 1000)],
        pending: [queued],
      });

      await startImagePrecacheWorker();

      expect(queued.remove).toHaveBeenCalledTimes(1);
    });

    it('constructs the worker only after boot reconciliation resolves', async () => {
      let resolveReconcile: (() => void) | undefined;
      mockReconcileImagePrecacheOnBoot.mockReturnValue(
        new Promise((resolve) => {
          resolveReconcile = () => resolve({ ran: true, passes: 1 });
        })
      );

      const startPromise = startImagePrecacheWorker();

      expect(vi.mocked(Worker)).not.toHaveBeenCalled();

      resolveReconcile?.();
      await startPromise;

      expect(vi.mocked(Worker)).toHaveBeenCalledTimes(1);
    });
  });

  describe('full pass stamping', () => {
    it('does not stamp while the chain continues, and stamps when it runs out of rows', async () => {
      const full = Array.from({ length: 50 }, (_, i) => ({
        id: `item-${i}`,
        thumbPath: `/t/${i}`,
      }));
      mockBatchQuery(full);
      mockQueueAdd.mockResolvedValue({ id: 'job-next' });

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));
      expect(redisStore.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL('server-1'))).toBeUndefined();

      mockBatchQuery([{ id: 'item-50', thumbPath: '/t/50' }]);
      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: 'item-49' }));
      expect(redisStore.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL('server-1'))).toBeDefined();
      expect(redisStore.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL_DIR('server-1'))).toBe('/cache');
    });

    it('does not stamp a watermark-scoped pass, which walked only recent rows', async () => {
      mockBatchQuery([{ id: 'item-1', thumbPath: '/t/1' }]);

      await processImagePrecacheJob(
        makeJob({
          serverId: 'server-1',
          cursor: null,
          sinceUpdatedAt: new Date().toISOString(),
        })
      );

      expect(redisStore.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL('server-1'))).toBeUndefined();
    });
  });

  describe('persistence detection', () => {
    function fullPassStamp(dir = '/cache') {
      redisStore.set(
        REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL('server-1'),
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      );
      redisStore.set(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL_DIR('server-1'), dir);
    }

    it('flags a cache that lost everything since a full pass against this directory, even one a previous process completed', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockPosterCacheEntryExists.mockResolvedValue(false);
      fullPassStamp();

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(redisStore.get(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING)).toBeDefined();
    });

    it('clears the flag when the sample is still on disk', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockPosterCacheEntryExists.mockResolvedValue(true);
      redisStore.set(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING, 'stale');
      fullPassStamp();

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(redisStore.get(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING)).toBeUndefined();
    });

    it('does not flag when no full pass has ever completed', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockPosterCacheEntryExists.mockResolvedValue(false);

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(redisStore.get(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING)).toBeUndefined();
    });

    it('does not flag on a stamp with no recorded directory, which every upgrade carries', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockPosterCacheEntryExists.mockResolvedValue(false);
      redisStore.set(
        REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL('server-1'),
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      );

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(redisStore.get(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING)).toBeUndefined();
    });

    it('does not flag on a stamp taken against another directory', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockPosterCacheEntryExists.mockResolvedValue(false);
      fullPassStamp('/app/data/image-cache');

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(redisStore.get(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING)).toBeUndefined();
    });

    it('does not flag a mounted volume, where an empty sample is a new mount or failed writes', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockPosterCacheEntryExists.mockResolvedValue(false);
      mockIsOnMountedVolume.mockResolvedValueOnce(true);
      fullPassStamp();

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(redisStore.get(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING)).toBeUndefined();
    });

    it('does not sample a watermark-scoped pass, which only walks recent rows', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockPosterCacheEntryExists.mockResolvedValue(false);
      fullPassStamp();

      await processImagePrecacheJob(
        makeJob({ serverId: 'server-1', cursor: null, sinceUpdatedAt: new Date().toISOString() })
      );

      expect(redisStore.get(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING)).toBeUndefined();
    });
  });

  describe('processImagePrecacheJob', () => {
    it('skips a batch for a server that turned historical after it was queued', async () => {
      mockIsLiveServer.mockResolvedValueOnce(false);

      const result = await processImagePrecacheJob(makeJob({ serverId: 'srv-h', cursor: null }));

      expect(result).toEqual({ skipped: true, reason: 'server historical' });
      expect(mockGetLibrarySyncStatus).not.toHaveBeenCalled();
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockProxyImage).not.toHaveBeenCalled();
    });

    it('no-ops without touching the database when disabled', async () => {
      mockGetSetting.mockResolvedValue(false);

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ skipped: true, reason: 'disabled' });
      expect(mockGetLibrarySyncStatus).not.toHaveBeenCalled();
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('re-enqueues with a 60s delay and does not process when a sync is active for the server', async () => {
      mockGetLibrarySyncStatus.mockResolvedValue({ isActive: true });
      mockQueueAdd.mockResolvedValue({ id: 'job-delayed' });

      const result = await processImagePrecacheJob(
        makeJob({ serverId: 'server-1', cursor: 'cursor-1' })
      );

      expect(result).toEqual({ skipped: true, reason: 'sync active' });
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockProxyImage).not.toHaveBeenCalled();
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData, opts] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: 'cursor-1',
        passStartedAt: expect.any(String),
      });
      expect(opts.delay).toBe(60000);
    });

    it('warms only the items missing their poster cache entry, at 360x540, and re-enqueues with the next cursor', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${i}`, `/thumb-${i}`));
      mockBatchQuery(rows);
      mockQueueAdd.mockResolvedValue({ id: 'job-next' });
      // The last 10 rows are missing their cache entry; the other 40 already have one.
      const missingPaths = new Set(rows.slice(40).map((row) => row.thumbPath));
      mockPosterCacheEntryExists.mockImplementation(
        async (_serverId: string, thumbPath: string) => !missingPaths.has(thumbPath)
      );

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 50 });
      expect(mockProxyImage).toHaveBeenCalledTimes(10);
      expect(mockProxyImage).toHaveBeenCalledWith(
        expect.objectContaining({ width: 360, height: 540, fallback: 'poster' })
      );
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 50,
        processedItems: 50,
        passStartedAt: expect.any(String),
        refusedWrites: 0,
      });
    });

    it('re-enqueues from the raw row count even when one row in the raw 50 has a null thumbPath', async () => {
      const rows = Array.from({ length: 50 }, (_, i) =>
        i === 25 ? makeItemRow(`item-${i}`, null) : makeItemRow(`item-${i}`)
      );
      mockBatchQuery(rows);
      mockQueueAdd.mockResolvedValue({ id: 'job-next' });

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 50 });
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 50,
        processedItems: 50,
        passStartedAt: expect.any(String),
        refusedWrites: 0,
      });
    });

    it('carries pass progress through the cursor chain without recounting', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${i}`));
      mockBatchQuery(rows);
      mockQueueAdd.mockResolvedValue({ id: 'job-next' });

      const result = await processImagePrecacheJob(
        makeJob({
          serverId: 'server-1',
          cursor: 'item-99',
          totalItems: 500,
          processedItems: 100,
          passStartedAt: '2026-08-09T00:00:00.000Z',
        })
      );

      expect(result).toEqual({ processed: 50 });
      // totalItems present in the job data means the seed count is skipped:
      // one db.select for the batch, none for the count.
      expect(mockDbSelect).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 500,
        processedItems: 150,
        passStartedAt: '2026-08-09T00:00:00.000Z',
        refusedWrites: 0,
      });
    });

    it('threads refused writes through the chain', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${i}`));
      mockBatchQuery(rows);
      mockQueueAdd.mockResolvedValue({ id: 'job-next' });
      mockTakeRefusedWrites.mockReturnValue(3);

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 50,
        processedItems: 50,
        passStartedAt: expect.any(String),
        refusedWrites: 3,
      });
    });

    it('sets disk-limited when the final batch ends a pass with refusals', async () => {
      const rows = [makeItemRow('item-0'), makeItemRow('item-1')];
      mockBatchQuery(rows);
      mockTakeRefusedWrites.mockReturnValue(1);

      const result = await processImagePrecacheJob(
        makeJob({ serverId: 'server-1', cursor: null, refusedWrites: 3 })
      );

      expect(result).toEqual({ processed: 2 });
      expect(mockWriteDiskLimited).toHaveBeenCalledTimes(1);
      expect(mockWriteDiskLimited).toHaveBeenCalledWith(expect.anything(), 4);
      expect(mockClearDiskLimited).not.toHaveBeenCalled();
    });

    it('clears disk-limited when a pass ends clean', async () => {
      const rows = [makeItemRow('item-0'), makeItemRow('item-1')];
      mockBatchQuery(rows);
      mockTakeRefusedWrites.mockReturnValue(0);

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 2 });
      expect(mockClearDiskLimited).toHaveBeenCalledTimes(1);
      expect(mockWriteDiskLimited).not.toHaveBeenCalled();
    });

    it('chains the next batch with its own unique id even though the pass is active', async () => {
      queueHolds({ active: [chainedJob('precache-server-1-item-0-1', 'server-1', 1000)] });
      const rows = Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${i}`));
      mockBatchQuery(rows);
      mockQueueAdd.mockResolvedValue({ id: 'job-next' });

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, , opts] = mockQueueAdd.mock.calls[0]!;
      expect(opts.jobId).toMatch(/^precache-server-1-item-49-\d+$/);
    });

    it('does not re-enqueue when the batch is smaller than 50 (cursor exhausted)', async () => {
      const rows = [makeItemRow('item-0'), makeItemRow('item-1')];
      mockBatchQuery(rows);

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 2 });
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('reports done and skips warming when no items match', async () => {
      mockBatchQuery([]);

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ done: true });
      expect(mockProxyImage).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    function trackPeakConcurrency() {
      const observed = { peak: 0 };
      let active = 0;
      mockProxyImage.mockImplementation(async () => {
        active++;
        observed.peak = Math.max(observed.peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { data: Buffer.from(''), contentType: 'image/webp', cached: false };
      });
      return observed;
    }

    it('warms at the idle concurrency when nothing is streaming', async () => {
      // Peak is min(concurrency, missing), so the fixture must hold at least
      // the idle width or this asserts the fixture size, not the tiering.
      mockBatchQuery(Array.from({ length: 8 }, (_, i) => makeItemRow(`item-${i}`)));
      mockGetAllActiveSessions.mockResolvedValue([]);
      const observed = trackPeakConcurrency();

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(observed.peak).toBe(WARM_CONCURRENCY_IDLE);
    });

    it('drops to the floor while a transcode is running on that server', async () => {
      mockBatchQuery(Array.from({ length: 8 }, (_, i) => makeItemRow(`item-${i}`)));
      mockGetAllActiveSessions.mockResolvedValue([
        { serverId: 'server-1', isTranscode: true },
        { serverId: 'server-1', isTranscode: true },
      ]);
      const observed = trackPeakConcurrency();

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(observed.peak).toBe(WARM_CONCURRENCY_HEAVY);
    });

    it('eases off but keeps parallelism for a couple of direct plays', async () => {
      mockBatchQuery(Array.from({ length: 8 }, (_, i) => makeItemRow(`item-${i}`)));
      mockGetAllActiveSessions.mockResolvedValue([
        { serverId: 'server-1', isTranscode: false },
        { serverId: 'server-1', isTranscode: false },
      ]);
      const observed = trackPeakConcurrency();

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(observed.peak).toBe(WARM_CONCURRENCY_LIGHT);
    });

    it('counts only the streams on the server being warmed', async () => {
      mockBatchQuery(Array.from({ length: 8 }, (_, i) => makeItemRow(`item-${i}`)));
      mockGetAllActiveSessions.mockResolvedValue([
        { serverId: 'other-server', isTranscode: true },
        { serverId: 'other-server', isTranscode: true },
      ]);
      const observed = trackPeakConcurrency();

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(observed.peak).toBe(WARM_CONCURRENCY_IDLE);
    });

    it('pauses the chain once enough consecutive batches fail outright', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockProxyImage.mockRejectedValue(new Error('upstream 503'));
      mockQueueAdd.mockResolvedValue({ id: 'job-delayed' });

      for (let i = 0; i < FAILURE_BACKOFF_BATCHES; i++) {
        await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));
      }
      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ skipped: true, reason: 'backing off' });
      const [, , opts] = mockQueueAdd.mock.calls.at(-1)!;
      expect((opts as { delay?: number }).delay).toBeGreaterThanOrEqual(FAILURE_BACKOFF_BASE_MS);
    });

    it('warms again after the pause rather than re-enqueueing forever', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockProxyImage.mockRejectedValue(new Error('upstream 503'));
      mockQueueAdd.mockResolvedValue({ id: 'job-delayed' });
      for (let i = 0; i <= FAILURE_BACKOFF_BATCHES; i++) {
        await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));
      }

      mockProxyImage.mockClear();
      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(mockProxyImage).toHaveBeenCalled();
    });

    it('clears the pause once a warm succeeds', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockQueueAdd.mockResolvedValue({ id: 'job-delayed' });
      mockProxyImage.mockRejectedValue(new Error('upstream 503'));
      for (let i = 0; i <= FAILURE_BACKOFF_BATCHES; i++) {
        await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));
      }

      mockProxyImage.mockResolvedValue({
        data: Buffer.from(''),
        contentType: 'image/webp',
        cached: false,
      });
      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      mockProxyImage.mockRejectedValue(new Error('upstream 503'));
      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).not.toEqual({ skipped: true, reason: 'backing off' });
    });

    it('treats a degraded placeholder as a failure, since proxyImage does not reject', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockQueueAdd.mockResolvedValue({ id: 'job-delayed' });
      mockProxyImage.mockResolvedValue({
        data: Buffer.from('<svg/>'),
        contentType: 'image/svg+xml',
        cached: false,
        degraded: true,
      });

      for (let i = 0; i < FAILURE_BACKOFF_BATCHES; i++) {
        await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));
      }
      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ skipped: true, reason: 'backing off' });
    });

    it('skips an image the server answered for instead of backing the server off', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockQueueAdd.mockResolvedValue({ id: 'job-delayed' });
      mockProxyImage.mockResolvedValue({
        data: Buffer.from('<svg/>'),
        contentType: 'image/svg+xml',
        cached: false,
        degraded: true,
        failure: { reason: 'HTTP 500 (text/plain)', itemFault: true },
      });

      let result;
      for (let i = 0; i <= FAILURE_BACKOFF_BATCHES; i++) {
        result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));
      }

      expect(result).not.toEqual({ skipped: true, reason: 'backing off' });
      expect(mockProxyImage).toHaveBeenCalledTimes(1);
    });

    it('continues the batch and does not fail the job when one warm call throws', async () => {
      const rows = [makeItemRow('item-0'), makeItemRow('item-1')];
      mockBatchQuery(rows);
      mockProxyImage
        .mockRejectedValueOnce(new Error('upstream fetch failed'))
        .mockResolvedValue({ data: Buffer.from(''), contentType: 'image/webp', cached: false });

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 2 });
      expect(mockProxyImage).toHaveBeenCalledTimes(2); // 2 items, one warm each, despite the first rejecting
    });
  });
});
