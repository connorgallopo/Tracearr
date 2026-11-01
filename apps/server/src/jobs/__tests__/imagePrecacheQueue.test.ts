/**
 * Image Precache Queue tests.
 *
 * Covers the enabled-setting gate, the one-pass-per-server dedup, the batch
 * walk and its cursor checkpoints, the yields (sync active, backoff, abort),
 * the concurrent warm bound, and the disk-limited flag the guard threads
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
import { DelayedError, Worker } from 'bullmq';
import type { Job } from 'bullmq';

const mockGetSetting = vi.fn();
const mockGetLibrarySyncStatus = vi.fn();
const mockIsLibrarySyncEnabled = vi.fn();
const mockProxyImage = vi.fn();
const mockPosterCacheEntryExists = vi.fn();
const mockDbSelect = vi.fn();
const mockTakeRefusedWrites = vi.fn();
const mockWriteDiskLimited = vi.fn();
const mockClearDiskLimited = vi.fn();
const mockReadDiskLimited = vi.fn();
const mockIsOnMountedVolume = vi.fn();
const mockIsLiveServer = vi.fn().mockResolvedValue(true);
vi.mock('../../services/liveServers.js', () => ({
  isLiveServer: (...args: unknown[]) => mockIsLiveServer(...args),
}));

vi.mock('../../services/settings.js', () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

vi.mock('../librarySyncQueue.js', () => ({
  getLibrarySyncStatus: (...args: unknown[]) => mockGetLibrarySyncStatus(...args),
}));

vi.mock('../librarySyncEnabled.js', () => ({
  isLibrarySyncEnabled: (...args: unknown[]) => mockIsLibrarySyncEnabled(...args),
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

vi.mock('../../db/client.js', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));

vi.mock('../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn();
const mockWorkerClose = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return {
      name: 'image-precache',
      add: mockQueueAdd,
      close: mockQueueClose,
      on: vi.fn(),
    };
  }),
  Worker: vi.fn().mockImplementation(function MockWorker() {
    return {
      on: vi.fn(),
      once: vi.fn(),
      close: mockWorkerClose,
    };
  }),
  DelayedError: class DelayedError extends Error {},
}));

import { WORKER_DEFAULTS } from '../jobSafety.js';
import {
  initImagePrecacheQueue,
  enqueueImagePrecache,
  processImagePrecacheJob,
  _resetWarmBackoffForTests,
  shutdownImagePrecacheQueue,
  startImagePrecacheWorker,
  type ImagePrecacheJobData,
} from '../imagePrecacheQueue.js';

function makeJob(
  data: ImagePrecacheJobData,
  extra: Record<string, unknown> = {}
): Job<ImagePrecacheJobData> {
  const job = {
    data,
    token: 'tok',
    updateData: vi.fn(async (next: ImagePrecacheJobData) => {
      job.data = next;
    }),
    extendLock: vi.fn().mockResolvedValue(1),
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
    ...extra,
  };
  return job as unknown as Job<ImagePrecacheJobData>;
}

/** Runs a job to its end, reporting a yield (DelayedError) as 'yielded'. */
function runJob(job: Job<ImagePrecacheJobData>, signal?: AbortSignal) {
  return processImagePrecacheJob(job, signal).catch((err: unknown) => {
    if (err instanceof DelayedError) return 'yielded' as const;
    throw err;
  });
}

const mockBatchFetch = vi.fn();

/**
 * Mock both drizzle query shapes the processor uses: the batch fetch
 * (select().from().where().orderBy().limit() -> rows) and the pass-progress
 * count (select().from().where() awaited directly -> [{ n }]). Each batch fetch
 * takes the next of `batches`; the last one repeats, so a short single batch
 * replays across calls and a pass that should end lists a trailing [].
 */
function mockBatchQuery(...batches: unknown[][]) {
  const eligibleCount = batches.reduce((n, rows) => n + rows.length, 0);
  let next = 0;
  mockBatchFetch.mockImplementation(() =>
    Promise.resolve(batches[Math.min(next++, batches.length - 1)])
  );
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve([{ n: eligibleCount }]), {
          orderBy: () => ({ limit: mockBatchFetch }),
        }),
    }),
  });
}

function makeItemRow(id: string, thumbPath: string | null = '/thumb', mediaType = 'movie') {
  return { id, thumbPath, mediaType };
}

function fullBatch(from = 0) {
  return Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${from + i}`, `/t/${from + i}`));
}

describe('imagePrecacheQueue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    redisStore.clear();
    _resetWarmBackoffForTests();
    await shutdownImagePrecacheQueue();
    initImagePrecacheQueue('redis://localhost:6379');
    mockGetSetting.mockResolvedValue(true);
    mockIsLibrarySyncEnabled.mockResolvedValue(true);
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
  });

  describe('enqueueImagePrecache', () => {
    function echoRequestedId() {
      mockQueueAdd.mockImplementation(
        async (_name: string, _data: unknown, opts: { jobId: string }) => ({
          id: opts.jobId,
        })
      );
    }

    it('returns the job id when the add was accepted', async () => {
      echoRequestedId();

      const result = await enqueueImagePrecache('server-1', '2026-08-22T10:00:00.000Z');

      expect(mockGetSetting).toHaveBeenCalledWith('imagePrecacheEnabled');
      const [, jobData, opts] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: null,
        sinceUpdatedAt: '2026-08-22T10:00:00.000Z',
      });
      expect(result).toBe(opts.jobId);
    });

    it('does not enqueue when imagePrecacheEnabled is false', async () => {
      mockGetSetting.mockResolvedValue(false);

      const result = await enqueueImagePrecache('server-1');

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('does not enqueue when library sync is disabled for the server', async () => {
      mockIsLibrarySyncEnabled.mockResolvedValue(false);

      const result = await enqueueImagePrecache('server-1');

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('returns nothing when a pass for the server already holds the key', async () => {
      mockQueueAdd.mockResolvedValue({ id: 'precache-server-1-running' });

      const result = await enqueueImagePrecache('server-1');

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(result).toBeUndefined();
    });

    it('deduplicates on one key per server', async () => {
      echoRequestedId();

      await enqueueImagePrecache('server-1');

      const [, jobData, opts] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({ serverId: 'server-1', cursor: null });
      expect(opts.deduplication).toEqual({ id: 'precache-server-1' });
      expect(opts.jobId).toMatch(/^precache-server-1-/);
    });
  });

  describe('startImagePrecacheWorker', () => {
    it('runs the worker on the shared lock defaults with a processor that takes the abort signal', () => {
      startImagePrecacheWorker();

      const [, processor, opts] = vi.mocked(Worker).mock.calls[0]!;
      expect(opts).toMatchObject({ concurrency: 1, ...WORKER_DEFAULTS });
      expect((processor as (...args: unknown[]) => unknown).length).toBe(3);
    });
  });

  describe('full pass stamping', () => {
    it('stamps once the pass runs out of rows, not after an earlier batch', async () => {
      mockBatchQuery(fullBatch(), [makeItemRow('item-50', '/t/50')]);
      let stampedAfterFirstBatch: string | undefined;
      const job = makeJob({ serverId: 'server-1', cursor: null });
      vi.mocked(job.updateData).mockImplementationOnce(async (next) => {
        stampedAfterFirstBatch = redisStore.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL('server-1'));
        job.data = next;
      });

      await processImagePrecacheJob(job);

      expect(stampedAfterFirstBatch).toBeUndefined();
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

    it('checkpoints and yields for 60s without touching the database while a sync is active', async () => {
      mockGetLibrarySyncStatus.mockResolvedValue({ isActive: true });
      const job = makeJob({ serverId: 'server-1', cursor: 'cursor-1' });
      const before = Date.now();

      await expect(processImagePrecacheJob(job)).rejects.toBeInstanceOf(DelayedError);

      expect(job.updateData).toHaveBeenCalledTimes(1);
      expect(job.data).toEqual({
        serverId: 'server-1',
        cursor: 'cursor-1',
        passStartedAt: expect.any(String),
      });
      const [until, token] = vi.mocked(job.moveToDelayed).mock.calls[0]!;
      expect(until).toBeGreaterThanOrEqual(before + 60_000 - 50);
      expect(token).toBe('tok');
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockProxyImage).not.toHaveBeenCalled();
    });

    it('warms only the items missing their poster cache entry, at 360x540, and checkpoints the next cursor', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${i}`, `/thumb-${i}`));
      mockBatchQuery(rows, []);
      // The last 10 rows are missing their cache entry; the other 40 already have one.
      const missingPaths = new Set(rows.slice(40).map((row) => row.thumbPath));
      mockPosterCacheEntryExists.mockImplementation(
        async (_serverId: string, thumbPath: string) => !missingPaths.has(thumbPath)
      );

      const job = makeJob({ serverId: 'server-1', cursor: null });
      const result = await processImagePrecacheJob(job);

      expect(result).toEqual({ processed: 50 });
      expect(mockProxyImage).toHaveBeenCalledTimes(10);
      expect(mockProxyImage).toHaveBeenCalledWith(
        expect.objectContaining({ width: 360, height: 540, fallback: 'poster' })
      );
      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(vi.mocked(job.updateData).mock.calls[0]![0]).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 50,
        processedItems: 50,
        passStartedAt: expect.any(String),
        refusedWrites: 0,
      });
    });

    it('warms artist and album art at 360x360 and every other row at 360x540', async () => {
      mockBatchQuery([
        makeItemRow('item-artist', '/library/metadata/101/thumb/1', 'artist'),
        makeItemRow('item-album', '/library/metadata/102/thumb/1', 'album'),
        makeItemRow('item-episode', '/library/metadata/103/thumb/1', 'episode'),
      ]);

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      const warmed = Object.fromEntries(
        mockProxyImage.mock.calls.map(([options]) => [
          options.imagePath,
          `${options.width}x${options.height}`,
        ])
      );
      expect(warmed).toEqual({
        '/library/metadata/101/thumb/1': '360x360',
        '/library/metadata/102/thumb/1': '360x360',
        '/library/metadata/103/thumb/1': '360x540',
      });
      expect(mockPosterCacheEntryExists).toHaveBeenCalledWith(
        'server-1',
        '/library/metadata/102/thumb/1',
        { width: 360, height: 360 }
      );
    });

    it('advances from the raw row count even when one row in the raw 50 has a null thumbPath', async () => {
      const rows = Array.from({ length: 50 }, (_, i) =>
        i === 25 ? makeItemRow(`item-${i}`, null) : makeItemRow(`item-${i}`)
      );
      mockBatchQuery(rows, []);

      const job = makeJob({ serverId: 'server-1', cursor: null });
      const result = await processImagePrecacheJob(job);

      expect(result).toEqual({ processed: 50 });
      expect(mockBatchFetch).toHaveBeenCalledTimes(2);
      expect(vi.mocked(job.updateData).mock.calls[0]![0]).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 50,
        processedItems: 50,
        passStartedAt: expect.any(String),
        refusedWrites: 0,
      });
    });

    it('carries resumed pass progress forward without recounting', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${i}`));
      mockBatchQuery(rows, []);

      const job = makeJob({
        serverId: 'server-1',
        cursor: 'item-99',
        totalItems: 500,
        processedItems: 100,
        passStartedAt: '2026-08-09T00:00:00.000Z',
      });
      const result = await processImagePrecacheJob(job);

      expect(result).toEqual({ processed: 50 });
      // totalItems present in the job data means the seed count is skipped:
      // one db.select per batch fetch, none for the count.
      expect(mockDbSelect).toHaveBeenCalledTimes(2);
      expect(vi.mocked(job.updateData).mock.calls[0]![0]).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 500,
        processedItems: 150,
        passStartedAt: '2026-08-09T00:00:00.000Z',
        refusedWrites: 0,
      });
    });

    it('checkpoints refused writes after each batch', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${i}`));
      mockBatchQuery(rows, []);
      mockTakeRefusedWrites.mockReturnValueOnce(3);

      const job = makeJob({ serverId: 'server-1', cursor: null });
      await processImagePrecacheJob(job);

      expect(vi.mocked(job.updateData).mock.calls[0]![0]).toEqual({
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

    it('walks every batch in one job, checkpointing the cursor after each', async () => {
      mockBatchQuery(fullBatch(), fullBatch(50).slice(0, 10));

      const job = makeJob({ serverId: 'server-1', cursor: null });
      const result = await processImagePrecacheJob(job);

      expect(result).toEqual({ processed: 60 });
      expect(mockBatchFetch).toHaveBeenCalledTimes(2);
      expect(vi.mocked(job.updateData).mock.calls[0]![0]).toMatchObject({ cursor: 'item-49' });
      expect(job.data).toMatchObject({ cursor: 'item-59', processedItems: 60, totalItems: 60 });
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('checkpoints and yields at the next batch boundary once aborted', async () => {
      mockBatchQuery(fullBatch(), []);
      const job = makeJob({ serverId: 'server-1', cursor: null });

      await expect(processImagePrecacheJob(job, AbortSignal.abort())).rejects.toBeInstanceOf(
        DelayedError
      );

      expect(job.updateData).toHaveBeenCalledTimes(1);
      expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
      expect(mockProxyImage).not.toHaveBeenCalled();
    });

    it('finishes the batch it is warming when aborted, then yields past it', async () => {
      mockBatchQuery(fullBatch(), fullBatch(50));
      const controller = new AbortController();
      mockProxyImage.mockImplementationOnce(async () => {
        controller.abort();
        return { data: Buffer.from(''), contentType: 'image/webp', cached: false };
      });
      const job = makeJob({ serverId: 'server-1', cursor: null });

      await expect(processImagePrecacheJob(job, controller.signal)).rejects.toBeInstanceOf(
        DelayedError
      );

      expect(mockProxyImage).toHaveBeenCalledTimes(50);
      expect(mockBatchFetch).toHaveBeenCalledTimes(1);
      expect(job.data.cursor).toBe('item-49');
    });

    it('stops a running pass at the next batch once precache is turned off', async () => {
      mockGetSetting.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockBatchQuery(fullBatch(), fullBatch(50).slice(0, 10));

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ skipped: true, reason: 'disabled' });
      expect(mockBatchFetch).toHaveBeenCalledTimes(1);
      expect(redisStore.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL('server-1'))).toBeUndefined();
    });

    it('stops a running pass at the next batch once library sync is disabled', async () => {
      mockIsLibrarySyncEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      mockBatchQuery(fullBatch(), fullBatch(50).slice(0, 10));

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ skipped: true, reason: 'library-sync-disabled' });
      expect(mockBatchFetch).toHaveBeenCalledTimes(1);
      expect(redisStore.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL('server-1'))).toBeUndefined();
    });

    it('ends the pass on a batch smaller than 50 without fetching again', async () => {
      const rows = [makeItemRow('item-0'), makeItemRow('item-1')];
      mockBatchQuery(rows);

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 2 });
      expect(mockBatchFetch).toHaveBeenCalledTimes(1);
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

    it('yields for the backoff once enough consecutive batches fail outright', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockProxyImage.mockRejectedValue(new Error('upstream 503'));

      for (let i = 0; i < FAILURE_BACKOFF_BATCHES; i++) {
        await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));
      }
      const job = makeJob({ serverId: 'server-1', cursor: null });
      const before = Date.now();
      const result = await runJob(job);

      expect(result).toBe('yielded');
      const [until] = vi.mocked(job.moveToDelayed).mock.calls[0]!;
      expect(until).toBeGreaterThanOrEqual(before + FAILURE_BACKOFF_BASE_MS);
      expect(until).toBeLessThanOrEqual(Date.now() + FAILURE_BACKOFF_BASE_MS);
      expect(job.updateData).toHaveBeenCalledTimes(1);
    });

    it('warms again after the pause rather than yielding forever', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockProxyImage.mockRejectedValue(new Error('upstream 503'));
      for (let i = 0; i <= FAILURE_BACKOFF_BATCHES; i++) {
        await runJob(makeJob({ serverId: 'server-1', cursor: null }));
      }

      mockProxyImage.mockClear();
      await runJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(mockProxyImage).toHaveBeenCalled();
    });

    it('clears the pause once a warm succeeds', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockProxyImage.mockRejectedValue(new Error('upstream 503'));
      for (let i = 0; i <= FAILURE_BACKOFF_BATCHES; i++) {
        await runJob(makeJob({ serverId: 'server-1', cursor: null }));
      }

      mockProxyImage.mockResolvedValue({
        data: Buffer.from(''),
        contentType: 'image/webp',
        cached: false,
      });
      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      mockProxyImage.mockRejectedValue(new Error('upstream 503'));
      const result = await runJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).not.toBe('yielded');
    });

    it('treats a degraded placeholder as a failure, since proxyImage does not reject', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockProxyImage.mockResolvedValue({
        data: Buffer.from('<svg/>'),
        contentType: 'image/svg+xml',
        cached: false,
        degraded: true,
      });

      for (let i = 0; i < FAILURE_BACKOFF_BATCHES; i++) {
        await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));
      }
      const result = await runJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toBe('yielded');
    });

    it('skips an image the server answered for instead of backing the server off', async () => {
      mockBatchQuery([makeItemRow('item-0')]);
      mockProxyImage.mockResolvedValue({
        data: Buffer.from('<svg/>'),
        contentType: 'image/svg+xml',
        cached: false,
        degraded: true,
        failure: { reason: 'HTTP 500 (text/plain)', itemFault: true },
      });

      let result;
      for (let i = 0; i <= FAILURE_BACKOFF_BATCHES; i++) {
        result = await runJob(makeJob({ serverId: 'server-1', cursor: null }));
      }

      expect(result).not.toBe('yielded');
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
