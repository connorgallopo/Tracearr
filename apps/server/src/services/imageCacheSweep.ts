/**
 * The only thing that deletes a versioned poster: a sweep against library_items.
 * Expected names come from every row with a thumb path, removed rows included, so
 * a removed item keeps its last poster and only a gone row orphans one. Every row
 * expects its 2:3 poster; artists and albums also expect their square one. A
 * request for a title in no library expects the 2:3 poster from its service.
 */

import { readdir, stat as fsStat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, gt, isNotNull, sql } from 'drizzle-orm';
import { REDIS_KEYS, TIME_MS, posterSizeFor, type ImageCacheStatus } from '@tracearr/shared';
import { db } from '../db/client.js';
import { libraryItems, mediaRequests } from '../db/schema.js';
import { getRedis } from '../lib/redisShared.js';
import { isMaintenance } from '../serverState.js';
import {
  ESTIMATED_POSTER_BYTES,
  getGuardConfig,
  isOnMountedVolume,
  readDiskLimited,
  readDiskSpace,
  setCacheTallyBytes,
} from './imageCacheGuard.js';
import { IMAGE_CACHE_DIR, isVersionedFileName, posterCacheFileName } from './imageProxy.js';
import { registerService, unregisterService } from './serviceTracker.js';
import type { Redis } from 'ioredis';

const PAGE = 5000;
const UNVERSIONED_TTL_MS = TIME_MS.DAY;
const TMP_TTL_MS = TIME_MS.HOUR;
const DEBOUNCE_MS = 15 * 60 * 1000;
const STAT_BATCH = 32;

export interface SweepResult {
  scanned: number;
  deletedOrphans: number;
  deletedExpired: number;
  deletedTmp: number;
  freedBytes: number;
  bytes: number;
  files: number;
  versionedFiles: number;
  durationMs: number;
}

export async function buildExpectedFileNames(): Promise<Set<string>> {
  const expected = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const rows: Array<{
      id: string;
      serverId: string;
      thumbPath: string | null;
      mediaType: string;
    }> = await db
      .select({
        id: libraryItems.id,
        serverId: libraryItems.serverId,
        thumbPath: libraryItems.thumbPath,
        mediaType: libraryItems.mediaType,
      })
      .from(libraryItems)
      .where(
        and(isNotNull(libraryItems.thumbPath), cursor ? gt(libraryItems.id, cursor) : undefined)
      )
      .orderBy(asc(libraryItems.id))
      .limit(PAGE);
    for (const row of rows) {
      if (!row.thumbPath) continue;
      expected.add(posterCacheFileName(row.serverId, row.thumbPath).fileName);
      const size = posterSizeFor(row.mediaType);
      expected.add(posterCacheFileName(row.serverId, row.thumbPath, size).fileName);
    }
    const last = rows.at(-1);
    if (rows.length < PAGE || !last) break;
    cursor = last.id;
  }
  const requestPosters = await db
    .selectDistinct({ serviceId: mediaRequests.serviceId, posterPath: mediaRequests.posterPath })
    .from(mediaRequests)
    .where(isNotNull(mediaRequests.posterPath));
  for (const row of requestPosters) {
    if (row.posterPath) expected.add(posterCacheFileName(row.serviceId, row.posterPath).fileName);
  }
  return expected;
}

/**
 * File names grouped by shard. Names only: paths are derived per file while
 * sweeping, so a large cache never holds a path string per file.
 */
async function listShards(cacheDir: string): Promise<Array<{ shard: string; names: string[] }>> {
  const out: Array<{ shard: string; names: string[] }> = [];
  const loose: string[] = [];
  let entries;
  try {
    entries = await readdir(cacheDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      try {
        out.push({ shard: entry.name, names: await readdir(join(cacheDir, entry.name)) });
      } catch {
        continue;
      }
    } else if (entry.isFile()) {
      loose.push(entry.name);
    }
  }
  if (loose.length > 0) out.push({ shard: '', names: loose });
  return out;
}

function emptyResult(): SweepResult {
  return {
    scanned: 0,
    deletedOrphans: 0,
    deletedExpired: 0,
    deletedTmp: 0,
    freedBytes: 0,
    bytes: 0,
    files: 0,
    versionedFiles: 0,
    durationMs: 0,
  };
}

export async function sweepImageCache(
  options: { cacheDir?: string; now?: number; redis?: Redis | null } = {}
): Promise<SweepResult> {
  const started = Date.now();
  const now = options.now ?? started;
  const cacheDir = options.cacheDir ?? IMAGE_CACHE_DIR;
  // Listed before the db read: a poster written after this point is not in the
  // listing at all, so a file the sweep sees always had its row read.
  const shards = await listShards(cacheDir);
  const expected = await buildExpectedFileNames();
  // An empty expected set means the db read found nothing. Deleting on that
  // would wipe a populated cache, so orphan removal sits this sweep out.
  const noneExpected = expected.size === 0;
  const result = emptyResult();
  for (const { names } of shards) result.scanned += names.length;

  for (const { shard, names } of shards) {
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      await Promise.all(
        names.slice(i, i + STAT_BATCH).map(async (name) => {
          const path = join(cacheDir, shard, name);
          const isTmp = name.includes('.tmp.');
          const versioned = isVersionedFileName(name);
          let size: number;
          let mtime: number;
          try {
            const s = await fsStat(path);
            size = s.size;
            mtime = s.mtimeMs;
          } catch {
            return;
          }
          const remove = async (bucket: 'deletedOrphans' | 'deletedExpired' | 'deletedTmp') => {
            try {
              await unlink(path);
              result[bucket]++;
              result.freedBytes += size;
            } catch {
              // a file that vanished under us is already gone
            }
          };
          if (isTmp) {
            if (now - mtime > TMP_TTL_MS) await remove('deletedTmp');
            return;
          }
          if (versioned) {
            if (!noneExpected && !expected.has(name)) return remove('deletedOrphans');
            result.versionedFiles++;
          } else if (now - mtime > UNVERSIONED_TTL_MS) {
            return remove('deletedExpired');
          }
          result.files++;
          result.bytes += size;
        })
      );
    }
  }

  if (noneExpected && result.versionedFiles > 0) {
    console.warn(
      `[ImageCache] sweep deleted no orphans: library_items returned no thumb path while ${result.versionedFiles} versioned files are cached`
    );
  }

  result.durationMs = Date.now() - started;
  setCacheTallyBytes(result.bytes);
  const redis = options.redis === undefined ? getRedis() : options.redis;
  if (redis) {
    await redis.set(
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
  }
  console.log(
    `[ImageCache] sweep: ${result.files} files kept, ${result.deletedOrphans} orphans, ${result.deletedExpired} expired and ${result.deletedTmp} tmp removed, ${result.freedBytes} bytes freed in ${result.durationMs}ms`
  );
  return result;
}

let debounce: NodeJS.Timeout | null = null;
let daily: NodeJS.Timeout | null = null;
let running: Promise<SweepResult> | null = null;

function runOnce(): Promise<SweepResult> {
  // library_items is empty or half-loaded during a restore; a sweep then would
  // read no expected names and take the whole cache with it.
  if (isMaintenance()) return Promise.resolve(emptyResult());
  running ??= sweepImageCache()
    .catch((err: unknown) => {
      console.error('[ImageCache] sweep failed:', err);
      return emptyResult();
    })
    .finally(() => {
      running = null;
    });
  return running;
}

/** Back-to-back syncs of several servers produce one sweep, 15 minutes after the first. */
export function scheduleImageCacheSweep(_reason: 'sync' | 'manual' | 'boot'): void {
  if (debounce) return;
  debounce = setTimeout(() => {
    debounce = null;
    void runOnce();
  }, DEBOUNCE_MS);
}

/** The tally is the guard's ceiling counter; a restart would otherwise start it at zero. */
async function seedCacheTallyFromRedis(): Promise<void> {
  const raw = await getRedis().get(REDIS_KEYS.IMAGE_CACHE_TALLY);
  if (!raw) return;
  const parsed = JSON.parse(raw) as { bytes?: unknown };
  if (typeof parsed.bytes === 'number' && Number.isFinite(parsed.bytes)) {
    setCacheTallyBytes(parsed.bytes);
  }
}

export function startImageCacheSweepTimer(): void {
  if (daily) return;
  void seedCacheTallyFromRedis().catch((err: unknown) => {
    console.warn('[ImageCache] could not seed the cache tally:', err);
  });
  scheduleImageCacheSweep('boot');
  daily = setInterval(() => void runOnce(), TIME_MS.DAY);
  registerService('image-cache-sweep', {
    name: 'Image Cache Sweep',
    description: 'Removes orphaned poster files after a sync and once a day',
    intervalMs: TIME_MS.DAY,
  });
}

export function stopImageCacheSweep(): void {
  if (debounce) clearTimeout(debounce);
  if (daily) clearInterval(daily);
  debounce = null;
  daily = null;
  unregisterService('image-cache-sweep');
}

export async function getImageCacheStatus(): Promise<ImageCacheStatus> {
  const redis = getRedis();
  const [tallyRaw, notPersisting, onVolume, limited, space, countRow] = await Promise.all([
    redis.get(REDIS_KEYS.IMAGE_CACHE_TALLY),
    redis.get(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING).catch(() => null),
    isOnMountedVolume(IMAGE_CACHE_DIR),
    readDiskLimited(redis),
    readDiskSpace(IMAGE_CACHE_DIR).catch(() => ({ freeBytes: 0, totalBytes: 0 })),
    // One file per (server, path), not per row: a track row carries its album's
    // cover, so a music library counts the same poster hundreds of times.
    // Removed rows stay in, matching the sweep's rule that they keep their poster.
    db
      .select({
        n: sql<number>`count(distinct (${libraryItems.serverId}, ${libraryItems.thumbPath}))::int`,
      })
      .from(libraryItems)
      .where(isNotNull(libraryItems.thumbPath)),
  ]);
  interface Tally {
    bytes: number;
    files: number;
    versionedFiles: number;
    sweptAt: string;
    freedBytes: number;
    deletedFiles: number;
  }
  let tally: Tally | null = null;
  if (tallyRaw) {
    try {
      tally = JSON.parse(tallyRaw) as Tally;
    } catch {
      // a corrupt tally is treated like a missing one; the ?? fallbacks below apply
    }
  }
  const postersWithThumb = countRow[0]?.n ?? 0;
  const config = getGuardConfig();
  return {
    bytes: tally?.bytes ?? 0,
    files: tally?.files ?? 0,
    versionedFiles: tally?.versionedFiles ?? 0,
    sweptAt: tally?.sweptAt ?? null,
    freedBytesLastSweep: tally?.freedBytes ?? 0,
    deletedFilesLastSweep: tally?.deletedFiles ?? 0,
    // The flag is only re-sampled every few days; a volume added since clears it now.
    notPersisting: notPersisting !== null && !onVolume,
    postersWithThumb,
    estimatedNeedBytes: postersWithThumb * ESTIMATED_POSTER_BYTES,
    freeBytes: space.freeBytes,
    totalBytes: space.totalBytes,
    minFreePercent: config.minFreePercent,
    maxBytes: config.maxBytes,
    diskLimitedSince: limited?.since ?? null,
    shortfallBytes: limited?.shortfallBytes ?? 0,
  };
}
