/**
 * Image cache sweep tests. fs, the db, and redis are all mocked; imageProxy.js
 * itself loads un-mocked here since its own fs/promises calls go through the
 * same node:fs/promises mock, so posterCacheFileName's derivation stays real.
 */

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  statfs: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    selectDistinct: vi.fn(() => ({ from: () => ({ where: async () => [] }) })),
  },
}));

vi.mock('../../lib/redisShared.js', () => ({
  getRedis: vi.fn(),
}));

vi.mock('../../serverState.js', () => ({
  isMaintenance: vi.fn(() => false),
}));

import { readdir, stat, statfs, unlink } from 'node:fs/promises';
import { REDIS_KEYS } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { getRedis } from '../../lib/redisShared.js';
import { isMaintenance } from '../../serverState.js';
import {
  ESTIMATED_POSTER_BYTES,
  cacheWriteAllowed,
  _resetDiskSpaceMemoForTests,
  _resetGuardStateForTests,
} from '../imageCacheGuard.js';
import { posterCacheFileName, posterVersionFor } from '../imageProxy.js';
import {
  buildExpectedFileNames,
  getImageCacheStatus,
  scheduleImageCacheSweep,
  startImageCacheSweepTimer,
  stopImageCacheSweep,
  sweepImageCache,
} from '../imageCacheSweep.js';

const CACHE_DIR = '/test/image-cache';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface LibraryItemRow {
  id: string;
  serverId: string;
  thumbPath: string | null;
  mediaType?: string;
}

function makeRedisStub() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

/** Lays out a fake sharded cache dir from {shard, fileName} entries. */
function mockCacheDirFiles(entries: Array<{ shard: string; fileName: string }>): void {
  const byShard = new Map<string, string[]>();
  for (const { shard, fileName } of entries) {
    const list = byShard.get(shard) ?? [];
    list.push(fileName);
    byShard.set(shard, list);
  }
  vi.mocked(readdir).mockImplementation(async (path: unknown) => {
    if (path === CACHE_DIR) {
      return Array.from(byShard.keys()).map((shard) => ({
        name: shard,
        isDirectory: () => true,
        isFile: () => false,
      })) as never;
    }
    for (const [shard, names] of byShard) {
      if (path === join(CACHE_DIR, shard)) return names as never;
    }
    return [] as never;
  });
}

/** Pages of library_items rows behind buildExpectedFileNames' select().from().where().orderBy().limit(). */
function mockLibraryItemsPages(...pages: LibraryItemRow[][]) {
  const limit = vi.fn();
  for (const page of pages) limit.mockResolvedValueOnce(page);
  const where = vi.fn().mockReturnThis();
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnThis(),
    where,
    orderBy: vi.fn().mockReturnThis(),
    limit,
  } as never);
  return { where, limit };
}

/** The count query behind getImageCacheStatus: select({n}).from().where() resolves directly. */
function mockLibraryItemsCount(n: number): void {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ n }]),
  } as never);
}

/** JSON.stringify but tolerant of drizzle's column-to-table circular refs. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  });
}

/** The old (pre-Task-3) fingerprint shape: same derivation, a different bucket size. */
function legacyFileName(
  serverId: string,
  thumbPath: string,
  width: number,
  height: number
): string {
  const version = posterVersionFor(thumbPath);
  const baseHash = createHash('sha256')
    .update(`${serverId}:${thumbPath}:${width}:${height}`)
    .digest('hex')
    .slice(0, 16);
  return `${baseHash}:v${version}.webp`;
}

beforeEach(() => {
  delete process.env.IMAGE_CACHE_MAX_MB;
  delete process.env.IMAGE_CACHE_MIN_FREE_PERCENT;
  _resetGuardStateForTests();
  vi.mocked(stat).mockResolvedValue({ size: 1000, mtimeMs: Date.now() } as never);
  vi.mocked(unlink).mockResolvedValue(undefined);
  vi.mocked(getRedis).mockReturnValue(makeRedisStub() as never);
  vi.mocked(isMaintenance).mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  stopImageCacheSweep();
});

describe('sweepImageCache', () => {
  it('deletes a versioned file whose name is not in the expected set, keeps one that is', async () => {
    const serverId = randomUUID();
    const keptPath = '/library/metadata/1/thumb/1';
    const orphanPath = '/library/metadata/2/thumb/2';
    const kept = posterCacheFileName(serverId, keptPath);
    const orphan = posterCacheFileName(serverId, orphanPath);

    mockLibraryItemsPages([{ id: randomUUID(), serverId, thumbPath: keptPath }]);
    mockCacheDirFiles([
      { shard: kept.shard, fileName: kept.fileName },
      { shard: orphan.shard, fileName: orphan.fileName },
    ]);

    const result = await sweepImageCache({ cacheDir: CACHE_DIR });

    expect(vi.mocked(unlink)).toHaveBeenCalledWith(join(CACHE_DIR, orphan.shard, orphan.fileName));
    expect(vi.mocked(unlink)).not.toHaveBeenCalledWith(join(CACHE_DIR, kept.shard, kept.fileName));
    expect(result.scanned).toBe(2);
    expect(result.deletedOrphans).toBe(1);
    expect(result.deletedExpired).toBe(0);
    expect(result.deletedTmp).toBe(0);
    expect(result.files).toBe(1);
    expect(result.versionedFiles).toBe(1);
  });

  it('keeps both the square and the 2:3 file of an album, and only the 2:3 file of a track', async () => {
    const serverId = randomUUID();
    const albumPath = '/library/metadata/5/thumb/5';
    const trackPath = '/library/metadata/6/thumb/6';
    const square = { width: 360, height: 360 };
    const albumSquare = posterCacheFileName(serverId, albumPath, square);
    const albumPoster = posterCacheFileName(serverId, albumPath);
    const trackSquare = posterCacheFileName(serverId, trackPath, square);

    mockLibraryItemsPages([
      { id: randomUUID(), serverId, thumbPath: albumPath, mediaType: 'album' },
      { id: randomUUID(), serverId, thumbPath: trackPath, mediaType: 'track' },
    ]);
    mockCacheDirFiles([albumSquare, albumPoster, trackSquare]);

    const result = await sweepImageCache({ cacheDir: CACHE_DIR });

    expect(vi.mocked(unlink)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(unlink)).toHaveBeenCalledWith(
      join(CACHE_DIR, trackSquare.shard, trackSquare.fileName)
    );
    expect(result.versionedFiles).toBe(2);
  });

  it('keeps the file of a removed item whose row still has a thumb path', async () => {
    const serverId = randomUUID();
    const removedItemPath = '/library/metadata/3/thumb/3';
    const removed = posterCacheFileName(serverId, removedItemPath);

    // The row stands in for a removed item: the select never filters on
    // removed_at, so its thumb path still lands in the expected set.
    mockLibraryItemsPages([{ id: randomUUID(), serverId, thumbPath: removedItemPath }]);
    mockCacheDirFiles([{ shard: removed.shard, fileName: removed.fileName }]);

    const result = await sweepImageCache({ cacheDir: CACHE_DIR });

    expect(vi.mocked(unlink)).not.toHaveBeenCalled();
    expect(result.deletedOrphans).toBe(0);
    expect(result.files).toBe(1);
  });

  it('deletes old-width names since only the 360x540 fingerprint is ever expected', async () => {
    const serverId = randomUUID();
    const path = '/library/metadata/4/thumb/4';
    const current = posterCacheFileName(serverId, path);
    const oldWidthFileName = legacyFileName(serverId, path, 240, 360);
    const oldWidthShard = oldWidthFileName.slice(0, 2);

    mockLibraryItemsPages([{ id: randomUUID(), serverId, thumbPath: path }]);
    mockCacheDirFiles([
      { shard: current.shard, fileName: current.fileName },
      { shard: oldWidthShard, fileName: oldWidthFileName },
    ]);

    const result = await sweepImageCache({ cacheDir: CACHE_DIR });

    expect(vi.mocked(unlink)).toHaveBeenCalledWith(
      join(CACHE_DIR, oldWidthShard, oldWidthFileName)
    );
    expect(vi.mocked(unlink)).not.toHaveBeenCalledWith(
      join(CACHE_DIR, current.shard, current.fileName)
    );
    expect(result.deletedOrphans).toBe(1);
  });

  it('deletes an unversioned file older than 24h, keeps a younger one', async () => {
    const now = Date.now();
    const staleFile = 'aaaa1111222233334444555566667777.webp';
    const freshFile = 'bbbb1111222233334444555566667777.webp';

    mockLibraryItemsPages([]);
    mockCacheDirFiles([
      { shard: 'aa', fileName: staleFile },
      { shard: 'bb', fileName: freshFile },
    ]);
    vi.mocked(stat).mockImplementation(async (path: unknown) => {
      if (path === join(CACHE_DIR, 'aa', staleFile)) {
        return { size: 1000, mtimeMs: now - DAY_MS - 1000 } as never;
      }
      return { size: 1000, mtimeMs: now } as never;
    });

    const result = await sweepImageCache({ cacheDir: CACHE_DIR, now });

    expect(vi.mocked(unlink)).toHaveBeenCalledWith(join(CACHE_DIR, 'aa', staleFile));
    expect(vi.mocked(unlink)).not.toHaveBeenCalledWith(join(CACHE_DIR, 'bb', freshFile));
    expect(result.deletedExpired).toBe(1);
    expect(result.files).toBe(1);
  });

  it('deletes .tmp. files older than an hour, keeps younger ones', async () => {
    const now = Date.now();
    const staleTmp = 'abcd1234567890ab:v11223344.webp.tmp.111';
    const freshTmp = 'abcd1234567890ab:v11223344.webp.tmp.222';

    mockLibraryItemsPages([]);
    mockCacheDirFiles([
      { shard: 'ab', fileName: staleTmp },
      { shard: 'ab', fileName: freshTmp },
    ]);
    vi.mocked(stat).mockImplementation(async (path: unknown) => {
      if (path === join(CACHE_DIR, 'ab', staleTmp)) {
        return { size: 1000, mtimeMs: now - HOUR_MS - 1000 } as never;
      }
      return { size: 1000, mtimeMs: now - 1000 } as never;
    });

    const result = await sweepImageCache({ cacheDir: CACHE_DIR, now });

    expect(vi.mocked(unlink)).toHaveBeenCalledWith(join(CACHE_DIR, 'ab', staleTmp));
    expect(vi.mocked(unlink)).not.toHaveBeenCalledWith(join(CACHE_DIR, 'ab', freshTmp));
    expect(result.deletedTmp).toBe(1);
  });

  it('never sees a poster written after the listing, since the listing runs before the db read', async () => {
    const serverId = randomUUID();
    const listedPath = '/library/metadata/6/thumb/6';
    const listed = posterCacheFileName(serverId, listedPath);
    const fresh = posterCacheFileName(serverId, '/library/metadata/7/thumb/7');
    const order: string[] = [];
    const byShard = new Map<string, string[]>([[listed.shard, [listed.fileName]]]);

    vi.mocked(readdir).mockImplementation(async (path: unknown) => {
      order.push('readdir');
      if (path === CACHE_DIR) {
        return Array.from(byShard.keys()).map((shard) => ({
          name: shard,
          isDirectory: () => true,
          isFile: () => false,
        })) as never;
      }
      for (const [shard, names] of byShard) {
        if (path === join(CACHE_DIR, shard)) return [...names] as never;
      }
      return [] as never;
    });

    const { limit } = mockLibraryItemsPages();
    limit.mockImplementation(async () => {
      order.push('db');
      // A precache write lands while the db read is in flight.
      byShard.set(fresh.shard, [...(byShard.get(fresh.shard) ?? []), fresh.fileName]);
      return [{ id: randomUUID(), serverId, thumbPath: listedPath }];
    });

    const result = await sweepImageCache({ cacheDir: CACHE_DIR });

    expect(order[0]).toBe('readdir');
    expect(order).toContain('db');
    expect(result.scanned).toBe(1);
    expect(vi.mocked(unlink)).not.toHaveBeenCalled();
  });

  it('deletes no orphan when the db returns nothing while versioned files are cached', async () => {
    const serverId = randomUUID();
    const cached = posterCacheFileName(serverId, '/library/metadata/8/thumb/8');
    const staleTmp = 'abcd1234567890ab:v11223344.webp.tmp.999';
    const now = Date.now();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    mockLibraryItemsPages([]);
    mockCacheDirFiles([
      { shard: cached.shard, fileName: cached.fileName },
      { shard: 'ab', fileName: staleTmp },
    ]);
    vi.mocked(stat).mockImplementation(async (path: unknown) =>
      path === join(CACHE_DIR, 'ab', staleTmp)
        ? ({ size: 1000, mtimeMs: now - HOUR_MS - 1000 } as never)
        : ({ size: 1000, mtimeMs: now } as never)
    );

    const result = await sweepImageCache({ cacheDir: CACHE_DIR, now });

    expect(vi.mocked(unlink)).not.toHaveBeenCalledWith(
      join(CACHE_DIR, cached.shard, cached.fileName)
    );
    expect(result.deletedOrphans).toBe(0);
    expect(result.versionedFiles).toBe(1);
    expect(result.files).toBe(1);
    expect(result.bytes).toBe(1000);
    // The tmp cleanup and the tally still run.
    expect(result.deletedTmp).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 versioned files'));
    warn.mockRestore();
  });

  it('writes the tally to Redis under IMAGE_CACHE_TALLY', async () => {
    const serverId = randomUUID();
    const path = '/library/metadata/5/thumb/5';
    const kept = posterCacheFileName(serverId, path);
    const orphanFile = 'zzzz1111222233334444555566667777:vdeadbeef.webp';
    const redis = makeRedisStub();
    vi.mocked(getRedis).mockReturnValue(redis as never);

    mockLibraryItemsPages([{ id: randomUUID(), serverId, thumbPath: path }]);
    mockCacheDirFiles([
      { shard: kept.shard, fileName: kept.fileName },
      { shard: 'zz', fileName: orphanFile },
    ]);
    vi.mocked(stat).mockResolvedValue({ size: 2000, mtimeMs: Date.now() } as never);

    const now = Date.now();
    const result = await sweepImageCache({ cacheDir: CACHE_DIR, now });

    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.IMAGE_CACHE_TALLY,
      JSON.stringify({
        bytes: result.bytes,
        files: result.files,
        versionedFiles: result.versionedFiles,
        sweptAt: new Date(now).toISOString(),
        freedBytes: result.freedBytes,
        deletedFiles: result.deletedOrphans + result.deletedExpired + result.deletedTmp,
      })
    );
  });
});

describe('buildExpectedFileNames', () => {
  it('pages the db by cursor when a page is full', async () => {
    const serverId = randomUUID();
    const page1: LibraryItemRow[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `id-${String(i).padStart(5, '0')}`,
      serverId,
      thumbPath: `/library/metadata/${i}/thumb/${i}`,
    }));
    const page2: LibraryItemRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `id-page2-${i}`,
      serverId,
      thumbPath: `/library/metadata/p2-${i}/thumb/${i}`,
    }));
    const { where, limit } = mockLibraryItemsPages(page1, page2);

    const expected = await buildExpectedFileNames();

    expect(limit).toHaveBeenCalledTimes(2);
    expect(expected.size).toBe(5010);
    // The second page's where clause carries a gt() cursor built from the
    // first page's last row id; drizzle embeds the literal value in the SQL chunks.
    const secondWhereArg = where.mock.calls[1]?.[0];
    expect(safeStringify(secondWhereArg)).toContain('id-04999');
  });

  it('expects the poster a request takes from its service while the title is in no library', async () => {
    const serviceId = randomUUID();
    const posterPath = '/imageproxy/tmdb/t/p/w600_and_h900_bestv2/abc.jpg';
    mockLibraryItemsPages([]);
    vi.mocked(db.selectDistinct).mockReturnValueOnce({
      from: () => ({ where: async () => [{ serviceId, posterPath }] }),
    } as never);

    const expected = await buildExpectedFileNames();

    expect(expected).toEqual(new Set([posterCacheFileName(serviceId, posterPath).fileName]));
  });
});

describe('scheduleImageCacheSweep', () => {
  it('does not sweep while the server is in maintenance', async () => {
    vi.mocked(isMaintenance).mockReturnValue(true);
    vi.useFakeTimers();
    try {
      mockLibraryItemsPages([]);
      mockCacheDirFiles([]);

      scheduleImageCacheSweep('manual');
      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);

      expect(vi.mocked(readdir)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses three calls inside 15 minutes into one sweep', async () => {
    vi.useFakeTimers();
    try {
      mockLibraryItemsPages([]);
      mockCacheDirFiles([]);

      scheduleImageCacheSweep('sync');
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      scheduleImageCacheSweep('sync');
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      scheduleImageCacheSweep('sync');

      // Not yet 15 minutes past the first call that started the debounce.
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 58_000);
      expect(vi.mocked(readdir)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(vi.mocked(readdir)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startImageCacheSweepTimer', () => {
  const GB = 1024 ** 3;

  function mockPlentyOfDisk(): void {
    vi.mocked(statfs).mockResolvedValue({
      bsize: 4096,
      bavail: Math.floor((50 * GB) / 4096),
      blocks: Math.floor((100 * GB) / 4096),
    } as never);
  }

  it('seeds the guard tally from the stored sweep, so the ceiling survives a restart', async () => {
    process.env.IMAGE_CACHE_MAX_MB = '1';
    _resetGuardStateForTests();
    _resetDiskSpaceMemoForTests();
    mockPlentyOfDisk();
    const redis = makeRedisStub();
    redis.store.set(REDIS_KEYS.IMAGE_CACHE_TALLY, JSON.stringify({ bytes: 1024 * 1024 }));
    vi.mocked(getRedis).mockReturnValue(redis as never);

    startImageCacheSweepTimer();

    // The seeded megabyte is already the whole ceiling, so the next write is refused.
    await vi.waitFor(async () => {
      await expect(cacheWriteAllowed(1, CACHE_DIR)).resolves.toBe(false);
    });
  });

  it('leaves the tally at zero when the stored value is corrupt or missing', async () => {
    process.env.IMAGE_CACHE_MAX_MB = '1';
    _resetGuardStateForTests();
    _resetDiskSpaceMemoForTests();
    mockPlentyOfDisk();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const redis = makeRedisStub();
    redis.store.set(REDIS_KEYS.IMAGE_CACHE_TALLY, 'not json{');
    vi.mocked(getRedis).mockReturnValue(redis as never);

    startImageCacheSweepTimer();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });

    await expect(cacheWriteAllowed(1024, CACHE_DIR)).resolves.toBe(true);
    warn.mockRestore();

    stopImageCacheSweep();
    _resetGuardStateForTests();
    const empty = makeRedisStub();
    vi.mocked(getRedis).mockReturnValue(empty as never);

    startImageCacheSweepTimer();
    await vi.waitFor(() => {
      expect(empty.get).toHaveBeenCalledWith(REDIS_KEYS.IMAGE_CACHE_TALLY);
    });

    await expect(cacheWriteAllowed(1024, CACHE_DIR)).resolves.toBe(true);
  });

  it('schedules one debounced sweep at boot', async () => {
    vi.useFakeTimers();
    try {
      mockLibraryItemsPages([]);
      mockCacheDirFiles([]);

      startImageCacheSweepTimer();
      expect(vi.mocked(readdir)).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(vi.mocked(readdir)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getImageCacheStatus', () => {
  it('combines tally, count, statfs and guard config into an ImageCacheStatus', async () => {
    const redis = makeRedisStub();
    vi.mocked(getRedis).mockReturnValue(redis as never);
    redis.store.set(
      REDIS_KEYS.IMAGE_CACHE_TALLY,
      JSON.stringify({
        bytes: 12345,
        files: 10,
        versionedFiles: 8,
        sweptAt: '2026-08-23T00:00:00.000Z',
        freedBytes: 500,
        deletedFiles: 2,
      })
    );

    const GB = 1024 ** 3;
    vi.mocked(statfs).mockResolvedValue({
      bsize: 4096,
      bavail: Math.floor((50 * GB) / 4096),
      blocks: Math.floor((100 * GB) / 4096),
    } as never);

    mockLibraryItemsCount(42);

    const status = await getImageCacheStatus();

    expect(status.bytes).toBe(12345);
    expect(status.files).toBe(10);
    expect(status.versionedFiles).toBe(8);
    expect(status.sweptAt).toBe('2026-08-23T00:00:00.000Z');
    expect(status.freedBytesLastSweep).toBe(500);
    expect(status.deletedFilesLastSweep).toBe(2);
    expect(status.postersWithThumb).toBe(42);
    expect(status.estimatedNeedBytes).toBe(42 * ESTIMATED_POSTER_BYTES);
    expect(status.freeBytes).toBeGreaterThan(0);
    expect(status.totalBytes).toBeGreaterThan(0);
    expect(status.minFreePercent).toBe(10);
    expect(status.maxBytes).toBeNull();
    expect(status.diskLimitedSince).toBeNull();
    expect(status.shortfallBytes).toBe(0);
  });

  it('treats a corrupt tally value like a missing one', async () => {
    const redis = makeRedisStub();
    vi.mocked(getRedis).mockReturnValue(redis as never);
    redis.store.set(REDIS_KEYS.IMAGE_CACHE_TALLY, 'not json{');

    const GB = 1024 ** 3;
    vi.mocked(statfs).mockResolvedValue({
      bsize: 4096,
      bavail: Math.floor((50 * GB) / 4096),
      blocks: Math.floor((100 * GB) / 4096),
    } as never);

    mockLibraryItemsCount(0);

    const status = await getImageCacheStatus();

    expect(status.bytes).toBe(0);
    expect(status.files).toBe(0);
    expect(status.versionedFiles).toBe(0);
    expect(status.sweptAt).toBeNull();
    expect(status.freedBytesLastSweep).toBe(0);
    expect(status.deletedFilesLastSweep).toBe(0);
  });

  it('drops a not-persisting flag as soon as the cache directory is a mounted volume', async () => {
    const redis = makeRedisStub();
    vi.mocked(getRedis).mockReturnValue(redis as never);
    redis.store.set(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING, '2026-10-01T00:00:00.000Z');
    vi.mocked(statfs).mockRejectedValue(new Error('ENOSYS'));
    mockLibraryItemsCount(0);

    vi.mocked(stat).mockResolvedValue({ dev: 1 } as never);
    expect((await getImageCacheStatus()).notPersisting).toBe(true);

    mockLibraryItemsCount(0);
    vi.mocked(stat).mockImplementation(async (path) => ({ dev: path === '/' ? 1 : 2 }) as never);
    expect((await getImageCacheStatus()).notPersisting).toBe(false);
  });
});
