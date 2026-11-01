/**
 * Image Precache Queue - warms the poster cache for a server after its
 * library sync completes, so the first browse of a freshly synced library
 * doesn't pay the cold-fetch cost for every poster.
 *
 * A pass is one job that walks library_items in cursor-ordered batches of 50
 * and checkpoints its cursor in job.data after every batch. It yields (moves
 * itself to delayed) while a sync for the same server is active, since the
 * sync may still be writing thumb_path/dominant_color for these rows, while
 * backing off a failing server, and on shutdown; it resumes from the
 * checkpoint each time.
 *
 * A pass can optionally be scoped to `sinceUpdatedAt`: only rows whose
 * library_items.updated_at moved on/after that timestamp are candidates.
 * The caller (librarySyncQueue.ts) decides when to use a watermark versus a
 * full walk; the value lives in job.data, so a resumed pass keeps its scope.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { and, asc, eq, gt, gte, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { REDIS_KEYS, posterSizeFor } from '@tracearr/shared';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { isMaintenance } from '../serverState.js';
import { db } from '../db/client.js';
import { libraryItems } from '../db/schema.js';
import { IMAGE_CACHE_DIR, proxyImage, posterCacheEntryExists } from '../services/imageProxy.js';
import {
  takeRefusedWrites,
  writeDiskLimited,
  clearDiskLimited,
  readDiskLimited,
  isOnMountedVolume,
} from '../services/imageCacheGuard.js';
import { isLiveServer } from '../services/liveServers.js';
import { getRedis } from '../lib/redisShared.js';
import { getSetting } from '../services/settings.js';
import { getLibrarySyncStatus } from './librarySyncQueue.js';
import { isLibrarySyncEnabled } from './librarySyncEnabled.js';
import {
  WORKER_DEFAULTS,
  addSingleton,
  checkpoint,
  registerQueue,
  registerWorker,
  yieldJob,
} from './jobSafety.js';
import { commitFullPass } from './precachePassPolicy.js';
import {
  streamPressure,
  warmConcurrencyFor,
  backoffDelayMs,
  WARM_CONCURRENCY_HEAVY,
  FAILURE_BACKOFF_BATCHES,
} from './warmConcurrency.js';
import { getCacheService } from '../services/cache.js';

export interface ImagePrecacheJobData {
  serverId: string;
  cursor: string | null;
  /** Only warm rows whose library_items.updated_at is on/after this ISO
   *  timestamp. Omitted (or null) means a full pass over every active item
   *  with a thumb_path - the periodic backstop that heals disk cache
   *  eviction or anything a watermark pass could miss. */
  sinceUpdatedAt?: string | null;
  /** Pass-level progress for the running-tasks UI, checkpointed after every
   *  batch. Seeded by the first batch (which counts eligible rows) and absent
   *  until then. */
  totalItems?: number;
  processedItems?: number;
  /** ISO start of the pass. */
  passStartedAt?: string;
  /** Writes the disk guard refused during this pass so far; the final batch turns it into the flag. */
  refusedWrites?: number;
}

const QUEUE_NAME = 'image-precache';
const BATCH_SIZE = 50;
const SYNC_ACTIVE_RETRY_DELAY_MS = 60 * 1000;

// Jellyfin/Emby paths carry ?tag= only when the item had a Primary image at sync
// time. Untagged ones 404 (Emby often 500s), and as the only uncached rows on a
// later pass they look like a dead server and stall it in backoff. Browsing
// still requests them, so an image that lands after the sync gets cached there.
const HAS_KNOWN_IMAGE = sql`(${libraryItems.thumbPath} NOT LIKE '/Items/%' OR ${libraryItems.thumbPath} LIKE '%?tag=%')`;
// Tracks carry their album's cover path, and no surface shows a track at the 2:3 size.
const NOT_TRACK = ne(libraryItems.mediaType, 'track');

// Per-server, in-process on purpose: a restart means the operator changed
// something, so probe at full rate again rather than inherit a stale pause.
// Two counters, because the delay has to keep growing across a pause that
// resets the failure count so the next attempt can actually warm.
const failingBatches = new Map<string, number>();
const backoffRounds = new Map<string, number>();

// An image the server answered for but couldn't serve (Emby 500s for an item id it no longer
// has) is skipped until this passes, keyed `${serverId} ${thumbPath}`. Without it the dead
// items are the only uncached rows on the next pass, and they read as a dead server.
const DEAD_ITEM_RETRY_MS = 24 * 60 * 60 * 1000;
const deadItems = new Map<string, number>();

const PERSISTENCE_SAMPLE = 20;
/** Below this share of a sample present on disk, a full pass this process
 *  completed cannot explain what is there, so the directory is not surviving. */
const PERSISTENCE_MIN_PRESENT = 0.2;

/**
 * A completed full pass means these posters were on disk. If they have since
 * vanished, the cache directory is not on a volume. Only a stamp taken against
 * the directory this process uses counts: a stamp from another path (the
 * default moved in an upgrade, or the operator changed IMAGE_CACHE_DIR) sits
 * beside a legitimately empty cache, and so does one from before the path was
 * recorded at all. A directory that is a mount is skipped: empty there means
 * the volume was attached after the pass or the writes are failing.
 */
async function checkPersistence(
  serverId: string,
  batch: ReadonlyArray<PrecacheBatchRow>
): Promise<void> {
  const redis = getRedis();
  const [lastFull, stampedDir] = await Promise.all([
    redis.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(serverId)),
    redis.get(REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL_DIR(serverId)),
  ]);
  if (!lastFull || stampedDir !== IMAGE_CACHE_DIR) return;
  if (await isOnMountedVolume(IMAGE_CACHE_DIR)) return;

  const sample = batch.slice(0, PERSISTENCE_SAMPLE);
  if (sample.length === 0) return;
  const present = (
    await Promise.all(
      sample.map((item) => posterCacheEntryExists(serverId, item.thumbPath, item.size))
    )
  ).filter(Boolean).length;

  if (present / sample.length < PERSISTENCE_MIN_PRESENT) {
    await redis.set(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING, new Date().toISOString());
    console.warn(
      `[ImagePrecache] poster cache is not persisting: ${present}/${sample.length} of a sample survived a completed full pass`
    );
  } else {
    await redis.del(REDIS_KEYS.IMAGE_CACHE_NOT_PERSISTING);
  }
}

/** Module state outlives a single job, so tests must be able to clear it. */
export function _resetWarmBackoffForTests(): void {
  failingBatches.clear();
  backoffRounds.clear();
  deadItems.clear();
}

/** Fails toward the floor: without a session view we slow down, never speed up. */
async function warmConcurrencyForServer(serverId: string): Promise<number> {
  const cache = getCacheService();
  if (!cache) return WARM_CONCURRENCY_HEAVY;
  try {
    const sessions = await cache.getAllActiveSessions();
    return warmConcurrencyFor(streamPressure(sessions.filter((s) => s.serverId === serverId)));
  } catch {
    return WARM_CONCURRENCY_HEAVY;
  }
}

let connectionOptions: ConnectionOptions | null = null;
let imagePrecacheQueue: Queue<ImagePrecacheJobData> | null = null;
let imagePrecacheWorker: Worker<ImagePrecacheJobData> | null = null;

/**
 * Initialize the image precache queue with a Redis connection.
 */
export function initImagePrecacheQueue(redisUrl: string): void {
  if (imagePrecacheQueue) {
    console.log('[ImagePrecache] Queue already initialized');
    return;
  }

  connectionOptions = queueConnectionOptions(redisUrl);
  const bullPrefix = getBullPrefix();

  imagePrecacheQueue = new Queue<ImagePrecacheJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000,
      },
      removeOnComplete: {
        count: 100,
        age: 24 * 60 * 60, // 24h
      },
      removeOnFail: {
        count: 50,
      },
    },
  });
  imagePrecacheQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[ImagePrecache] Queue error:', err);
  });
  registerQueue(imagePrecacheQueue);

  console.log('[ImagePrecache] Queue initialized');
}

/**
 * Start the image precache worker to process queued jobs.
 */
export function startImagePrecacheWorker(): void {
  if (!connectionOptions) {
    throw new Error('Image precache queue not initialized. Call initImagePrecacheQueue first.');
  }

  if (imagePrecacheWorker) {
    console.log('[ImagePrecache] Worker already running');
    return;
  }

  const bullPrefix = getBullPrefix();

  imagePrecacheWorker = new Worker<ImagePrecacheJobData>(
    QUEUE_NAME,
    async (job: Job<ImagePrecacheJobData>, _token, signal) => processImagePrecacheJob(job, signal),
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
      ...WORKER_DEFAULTS,
    }
  );
  registerWorker(imagePrecacheWorker);

  imagePrecacheWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[ImagePrecache] Worker error:', error);
  });

  console.log('[ImagePrecache] Worker started');
}

/**
 * Enqueue an image precache pass for a server. No-ops when the setting is
 * disabled, library sync is off for the server, the queue isn't initialized,
 * or a pass for the server is already queued or running, so callers don't
 * need to check any of that themselves. A returned job id is the caller's
 * proof that a pass really queued.
 */
export async function enqueueImagePrecache(
  serverId: string,
  sinceUpdatedAt?: string | null
): Promise<string | undefined> {
  if (!imagePrecacheQueue) return undefined;
  if (!(await getSetting('imagePrecacheEnabled'))) return undefined;
  if (!(await isLibrarySyncEnabled(serverId))) {
    console.log(`[ImagePrecache] Skipping enqueue for server ${serverId} (library sync disabled)`);
    return undefined;
  }
  const { jobId, accepted } = await addSingleton(
    imagePrecacheQueue,
    'precache',
    sinceUpdatedAt ? { serverId, cursor: null, sinceUpdatedAt } : { serverId, cursor: null },
    `precache-${serverId}`
  );
  return accepted ? jobId : undefined;
}

/** Count the rows a pass will walk - same predicate as fetchBatch, minus the
 *  cursor. Runs once per pass (first batch) to seed the progress total. */
async function countEligibleItems(
  serverId: string,
  sinceUpdatedAt?: string | null
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, serverId),
        isNull(libraryItems.removedAt),
        isNotNull(libraryItems.thumbPath),
        HAS_KNOWN_IMAGE,
        NOT_TRACK,
        sinceUpdatedAt ? gte(libraryItems.updatedAt, new Date(sinceUpdatedAt)) : undefined
      )
    );
  return row?.n ?? 0;
}

interface PrecacheBatchRow {
  id: string;
  thumbPath: string;
  size: ReturnType<typeof posterSizeFor>;
}

/**
 * Raw candidate rows for a server, active and with a known image, cursor-paged
 * by id. Does NOT filter by dominant_color or grid-cache existence - a row
 * with dominant_color already set can still be missing its 240/360 grid
 * entries (dominant_color is written by the first proxyImage call at ANY
 * width, including live browsing traffic at other sizes). Termination in
 * processImagePrecacheJob depends on this returning the raw SQL row count
 * unfiltered, so no JS-side filtering happens here.
 */
async function fetchBatch(
  serverId: string,
  cursor: string | null,
  sinceUpdatedAt?: string | null
): Promise<PrecacheBatchRow[]> {
  const rows = await db
    .select({
      id: libraryItems.id,
      thumbPath: libraryItems.thumbPath,
      mediaType: libraryItems.mediaType,
    })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, serverId),
        isNull(libraryItems.removedAt),
        isNotNull(libraryItems.thumbPath),
        HAS_KNOWN_IMAGE,
        NOT_TRACK,
        cursor ? gt(libraryItems.id, cursor) : undefined,
        sinceUpdatedAt ? gte(libraryItems.updatedAt, new Date(sinceUpdatedAt)) : undefined
      )
    )
    .orderBy(asc(libraryItems.id))
    .limit(BATCH_SIZE);

  return rows.map((row) => ({
    id: row.id,
    thumbPath: row.thumbPath!,
    size: posterSizeFor(row.mediaType),
  }));
}

/** One proxyImage call for one item, at the poster's cache size for its type. Each
 *  task is a single fetch-semaphore acquisition at most, so bounding
 *  concurrent tasks to MAX_CONCURRENT_WARMS bounds concurrent semaphore
 *  slots the same way. Returns why the warm failed, or null. */
async function runWarmTask(
  serverId: string,
  item: PrecacheBatchRow
): Promise<{ reason: string; itemFault: boolean } | null> {
  const result = await proxyImage({
    serverId,
    imagePath: item.thumbPath,
    ...item.size,
    fallback: 'poster',
    resizedOnly: true,
  });
  // proxyImage answers a failed fetch with a placeholder rather than rejecting,
  // because live requests share the same in-flight promise. Without this the
  // pass cannot tell a dead transcoder from a warm cache and never backs off.
  if (!result.degraded) return null;
  return result.failure ?? { reason: 'no image', itemFault: false };
}

/**
 * Warm one batch: at most the server's warm concurrency at a time, one
 * proxyImage call each (one cache size per poster), so bounding concurrent
 * items bounds concurrent fetch-semaphore acquisitions the same way.
 *
 * Fail-open: precache is a best-effort background warm, so one item's warm
 * failing is logged and skipped rather than failing the batch or the job.
 */
async function warmBatch(serverId: string, batch: ReadonlyArray<PrecacheBatchRow>): Promise<void> {
  const now = Date.now();
  const missing = (
    await Promise.all(
      batch.map(async (item) =>
        (deadItems.get(`${serverId} ${item.thumbPath}`) ?? 0) > now ||
        (await posterCacheEntryExists(serverId, item.thumbPath, item.size))
          ? null
          : item
      )
    )
  ).filter((item): item is PrecacheBatchRow => item !== null);

  const concurrency = await warmConcurrencyForServer(serverId);
  let warmSuccesses = 0;
  let warmFailures = 0;
  let nextIndex = 0;
  async function warmPoolWorker(): Promise<void> {
    while (nextIndex < missing.length) {
      const item = missing[nextIndex++]!;
      // Fail-open: a single warm failing must not fail the batch or the job.
      try {
        const failure = await runWarmTask(serverId, item);
        if (!failure) {
          warmSuccesses++;
        } else if (failure.itemFault) {
          deadItems.set(`${serverId} ${item.thumbPath}`, Date.now() + DEAD_ITEM_RETRY_MS);
          console.warn(
            `[ImagePrecache] ${item.thumbPath} failed (${failure.reason}), skipping it for 24h`
          );
        } else {
          warmFailures++;
          console.warn(`[ImagePrecache] ${item.thumbPath} failed (${failure.reason})`);
        }
      } catch (err) {
        warmFailures++;
        console.error(`[ImagePrecache] Failed to warm item ${item.id}:`, err);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, missing.length) }, () => warmPoolWorker())
  );

  if (warmSuccesses > 0) {
    failingBatches.delete(serverId);
    backoffRounds.delete(serverId);
  } else if (warmFailures > 0) {
    failingBatches.set(serverId, (failingBatches.get(serverId) ?? 0) + 1);
  }
}

/**
 * Run one pass: batch after batch from the checkpointed cursor until the rows
 * run out. Every exit before that is a checkpoint and a yield, so the same job
 * resumes where it stopped; the setting is read per batch so turning precache
 * off stops a running pass at the next boundary.
 */
export async function processImagePrecacheJob(
  job: Job<ImagePrecacheJobData>,
  signal?: AbortSignal
): Promise<{ skipped: true; reason: string } | { done: true } | { processed: number }> {
  const { serverId, sinceUpdatedAt } = job.data;
  if (!(await isLiveServer(serverId))) return { skipped: true, reason: 'server historical' };

  const passStartedAt =
    job.data.passStartedAt ?? new Date(job.timestamp ?? Date.now()).toISOString();
  let processed = 0;

  while (true) {
    if (!(await getSetting('imagePrecacheEnabled'))) return { skipped: true, reason: 'disabled' };
    if (!(await isLibrarySyncEnabled(serverId))) {
      return { skipped: true, reason: 'library-sync-disabled' };
    }
    if (signal?.aborted) {
      await checkpoint(job, { passStartedAt });
      await yieldJob(job, job.token, 0);
    }
    if ((await getLibrarySyncStatus(serverId))?.isActive) {
      await checkpoint(job, { passStartedAt });
      await yieldJob(job, job.token, SYNC_ACTIVE_RETRY_DELAY_MS);
    }
    if ((failingBatches.get(serverId) ?? 0) >= FAILURE_BACKOFF_BATCHES) {
      const round = backoffRounds.get(serverId) ?? 0;
      const delay = backoffDelayMs(round);
      backoffRounds.set(serverId, round + 1);
      // Back below the threshold so the resumed pass actually warms. Yielding
      // without this leaves the pass backing off forever, never running the
      // warm that would record the success and clear the pause.
      failingBatches.set(serverId, FAILURE_BACKOFF_BATCHES - 1);
      console.warn(`[ImagePrecache] backing off ${serverId} for ${delay}ms after failing batches`);
      await checkpoint(job, { passStartedAt });
      await yieldJob(job, job.token, delay);
    }

    const cursor = job.data.cursor;
    const totalItems = job.data.totalItems ?? (await countEligibleItems(serverId, sinceUpdatedAt));
    const batch = await fetchBatch(serverId, cursor, sinceUpdatedAt);
    if (batch.length === 0) {
      await recordPassOutcome(serverId, sinceUpdatedAt, job.data.refusedWrites ?? 0);
      return processed === 0 ? { done: true } : { processed };
    }
    if (cursor === null && sinceUpdatedAt == null) await checkPersistence(serverId, batch);

    await warmBatch(serverId, batch);

    processed += batch.length;
    const refusedWrites = (job.data.refusedWrites ?? 0) + takeRefusedWrites();
    await checkpoint(job, {
      cursor: batch.at(-1)?.id ?? cursor,
      totalItems,
      processedItems: (job.data.processedItems ?? 0) + batch.length,
      passStartedAt,
      refusedWrites,
    });
    if (batch.length < BATCH_SIZE) {
      await recordPassOutcome(serverId, sinceUpdatedAt, refusedWrites);
      return { processed };
    }
  }
}

/**
 * The flag is volume-global: refusals from live misses drain into whichever pass ends
 * next, and a clean pass clears what a still-refusing pass re-sets on its own end.
 * Accepted, since one pass heals it either way.
 */
async function recordPassOutcome(
  serverId: string,
  sinceUpdatedAt: string | null | undefined,
  refusedWrites: number
): Promise<void> {
  const redis = getRedis();
  // A null/absent watermark is exactly what resolvePrecachePass returns for a
  // full walk, and fetchBatch drops the predicate for both, so this is the
  // pass that really covered every row.
  if (sinceUpdatedAt == null) {
    await commitFullPass(redis, serverId, IMAGE_CACHE_DIR);
  }
  if (refusedWrites > 0) {
    await writeDiskLimited(redis, refusedWrites);
    console.warn(`[ImagePrecache] pass ended disk-limited: ${refusedWrites} writes refused`);
  } else {
    await clearDiskLimited(redis);
  }
}

/**
 * Active precache passes for the running-tasks UI. A pass is one job per
 * server carrying cumulative pass progress in its data. Delayed jobs are a
 * yielded pass (sync active, backoff, shutdown) and count as pending, not
 * running.
 */
export async function getAllActiveImagePrecacheJobs(): Promise<
  Array<{
    jobId: string;
    serverId: string;
    state: string;
    createdAt: number;
    passStartedAt: string | null;
    totalItems: number | null;
    processedItems: number;
    diskLimited: boolean;
  }>
> {
  if (!imagePrecacheQueue) {
    return [];
  }

  const jobs = await imagePrecacheQueue.getJobs(['active', 'waiting', 'delayed']);
  const limited = await readDiskLimited(getRedis()).catch(() => null);

  return Promise.all(
    jobs.map(async (job) => {
      const state = await job.getState();
      return {
        jobId: job.id ?? 'unknown',
        serverId: job.data.serverId,
        state,
        createdAt: job.timestamp ?? Date.now(),
        passStartedAt: job.data.passStartedAt ?? null,
        totalItems: job.data.totalItems ?? null,
        processedItems: job.data.processedItems ?? 0,
        diskLimited: limited !== null,
      };
    })
  );
}

/**
 * Gracefully shut down the image precache queue and worker.
 */
export async function shutdownImagePrecacheQueue(): Promise<void> {
  console.log('[ImagePrecache] Shutting down...');

  if (imagePrecacheWorker) {
    await imagePrecacheWorker.close();
    imagePrecacheWorker = null;
  }

  if (imagePrecacheQueue) {
    await imagePrecacheQueue.close();
    imagePrecacheQueue = null;
  }

  connectionOptions = null;

  console.log('[ImagePrecache] Shutdown complete');
}
