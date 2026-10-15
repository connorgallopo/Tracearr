/**
 * Image Precache Queue - warms the poster cache for a server after its
 * library sync completes, so the first browse of a freshly synced library
 * doesn't pay the cold-fetch cost for every poster.
 *
 * Walks library_items in cursor-ordered batches of 50, re-enqueueing itself
 * with the next cursor until the server is fully warmed. Pauses (delayed
 * re-enqueue) while a sync for the same server is active, since the sync
 * itself may still be writing thumb_path/dominant_color for these rows.
 *
 * A pass can optionally be scoped to `sinceUpdatedAt`: only rows whose
 * library_items.updated_at moved on/after that timestamp are candidates.
 * The caller (librarySyncQueue.ts) decides when to use a watermark versus a
 * full walk, and propagates the same value through every cursor-continuation
 * and delayed re-enqueue so a single pass stays consistently scoped.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { and, asc, eq, gt, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import { POSTER_IMAGE_SIZE, REDIS_KEYS } from '@tracearr/shared';
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
import { sweepImageCache } from '../services/imageCacheSweep.js';
import { isLiveServer, liveServers } from '../services/liveServers.js';
import { getRedis } from '../lib/redisShared.js';
import { getSetting } from '../services/settings.js';
import { getLibrarySyncStatus } from './librarySyncQueue.js';
import { reconcileImagePrecacheOnBoot } from './imagePrecacheBoot.js';
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
  /** Pass-level progress for the running-tasks UI, threaded through the
   *  cursor chain. Seeded by the first batch (which counts eligible rows)
   *  and absent on externally-enqueued pass starts. */
  totalItems?: number;
  processedItems?: number;
  /** ISO start of the whole pass, not of the current chained job. */
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
    await Promise.all(sample.map((item) => posterCacheEntryExists(serverId, item.thumbPath)))
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

  console.log('[ImagePrecache] Queue initialized');
}

/**
 * Start the image precache worker to process queued jobs.
 */
export async function startImagePrecacheWorker(): Promise<void> {
  if (!connectionOptions) {
    throw new Error('Image precache queue not initialized. Call initImagePrecacheQueue first.');
  }

  if (imagePrecacheWorker) {
    console.log('[ImagePrecache] Worker already running');
    return;
  }

  // One-time reconciliation for the 2.2 poster cache change: empties any
  // backlog of interleaved passes, queues one fresh pass per server, and
  // sweeps the old copies. A failure here must not cost the process its worker.
  await reconcileImagePrecacheOnBoot({
    queue: imagePrecacheQueue!,
    redis: getRedis(),
    listServerIds: async () => (await liveServers()).map((r) => r.id),
    enqueuePass: (serverId) => enqueueImagePrecache(serverId),
    sweep: () => sweepImageCache(),
  }).catch((err: unknown) => {
    console.error('[ImagePrecache] boot reconciliation failed:', err);
  });

  // Older builds queued a pass per sync, so an install can boot with a backlog.
  // A sweep that can't reach Redis must not cost the process its worker.
  await dropDuplicatePasses().catch((err: unknown) => {
    console.error('[ImagePrecache] Backlog sweep failed:', err);
  });

  const bullPrefix = getBullPrefix();

  imagePrecacheWorker = new Worker<ImagePrecacheJobData>(
    QUEUE_NAME,
    async (job: Job<ImagePrecacheJobData>) => processImagePrecacheJob(job),
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
    }
  );

  imagePrecacheWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[ImagePrecache] Worker error:', error);
  });

  console.log('[ImagePrecache] Worker started');
}

/** Everything the queue holds for one server (or for every server), split by
 *  whether the worker has already picked it up. */
async function queuedPassJobs(serverId?: string): Promise<{
  active: Array<Job<ImagePrecacheJobData>>;
  pending: Array<Job<ImagePrecacheJobData>>;
}> {
  if (!imagePrecacheQueue) return { active: [], pending: [] };

  const [active, pending] = await Promise.all([
    imagePrecacheQueue.getJobs(['active']),
    imagePrecacheQueue.getJobs(['waiting', 'delayed']),
  ]);
  const forServer = (jobs: Array<Job<ImagePrecacheJobData>>) =>
    serverId === undefined ? jobs : jobs.filter((job) => job.data.serverId === serverId);

  return { active: forServer(active), pending: forServer(pending) };
}

/** A pass start is what enqueueImagePrecache adds: no cursor and no
 *  passStartedAt. Both conjuncts matter - passStartedAt only ships from 2.1.0,
 *  so a 2.0.x backlog's continuations are told apart by their cursor. */
function isPassStart(job: Job<ImagePrecacheJobData>): boolean {
  return job.data.passStartedAt === undefined && job.data.cursor === null;
}

/**
 * Remove queued pass starts beyond the one that should remain for a server:
 * the OLDEST survives (its sinceUpdatedAt is the earliest, so it covers the
 * most), and a server whose pass is already in flight keeps none. Other
 * servers and the continuations of a running pass are never touched.
 */
async function dropDuplicatePasses(serverId?: string): Promise<string[]> {
  const { active, pending } = await queuedPassJobs(serverId);

  const inFlight = new Set(
    [...active, ...pending.filter((job) => !isPassStart(job))].map((job) => job.data.serverId)
  );
  const startsByServer = new Map<string, Array<Job<ImagePrecacheJobData>>>();
  for (const job of pending) {
    if (!isPassStart(job)) continue;
    const starts = startsByServer.get(job.data.serverId) ?? [];
    starts.push(job);
    startsByServer.set(job.data.serverId, starts);
  }

  const dropped: string[] = [];
  for (const [id, starts] of startsByServer) {
    starts.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const doomed = inFlight.has(id) ? starts : starts.slice(1);
    let removedHere = 0;
    for (const job of doomed) {
      // A start that raced to active refuses removal - it is the pass now, not a duplicate.
      const gone = await job
        .remove()
        .then(() => true)
        .catch(() => false);
      if (!gone) continue;
      removedHere++;
      if (job.id !== undefined) dropped.push(job.id);
    }
    if (removedHere > 0) {
      console.log(`[ImagePrecache] dropped ${removedHere} duplicate passes for ${id}`);
    }
  }

  return dropped;
}

/**
 * Enqueue an image precache pass for a server. No-ops when the setting is
 * disabled, the queue isn't initialized, or a pass for the server is already
 * queued or running, so callers don't need to check any of that themselves.
 * A returned job id is the caller's proof that a pass really queued.
 */
export async function enqueueImagePrecache(
  serverId: string,
  sinceUpdatedAt?: string | null
): Promise<string | undefined> {
  if (!imagePrecacheQueue) return undefined;

  const enabled = await getSetting('imagePrecacheEnabled');
  if (!enabled) return undefined;

  const { active, pending } = await queuedPassJobs(serverId);
  if (active.length > 0 || pending.length > 0) return undefined;

  const job = await imagePrecacheQueue.add(
    'precache',
    sinceUpdatedAt ? { serverId, cursor: null, sinceUpdatedAt } : { serverId, cursor: null },
    { jobId: `precache-${serverId}-start-${Date.now()}` }
  );

  // Two syncs can clear the check above in the same tick. The sweep leaves one
  // start either way; which of them reports it depends on who sweeps first, and
  // both resolved the same watermark, so the survivor covers either one's window.
  const dropped = await dropDuplicatePasses(serverId);
  if (job.id !== undefined && dropped.includes(job.id)) return undefined;

  return job.id;
}

/** Chain continuation: carries the full job data (including pass progress)
 *  forward, with an optional delay. Fresh jobId every call - Date.now()
 *  advances, so a same-tick re-add of the active job's own id can't collide. */
async function enqueueChained(data: ImagePrecacheJobData, delayMs?: number) {
  if (!imagePrecacheQueue) return;

  const job = await imagePrecacheQueue.add('precache', data, {
    jobId: `precache-${data.serverId}-${data.cursor ?? 'start'}-${Date.now()}`,
    ...(delayMs !== undefined ? { delay: delayMs } : {}),
  });
  return job.id;
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
        sinceUpdatedAt ? gte(libraryItems.updatedAt, new Date(sinceUpdatedAt)) : undefined
      )
    );
  return row?.n ?? 0;
}

interface PrecacheBatchRow {
  id: string;
  thumbPath: string;
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
    .select({ id: libraryItems.id, thumbPath: libraryItems.thumbPath })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, serverId),
        isNull(libraryItems.removedAt),
        isNotNull(libraryItems.thumbPath),
        HAS_KNOWN_IMAGE,
        cursor ? gt(libraryItems.id, cursor) : undefined,
        sinceUpdatedAt ? gte(libraryItems.updatedAt, new Date(sinceUpdatedAt)) : undefined
      )
    )
    .orderBy(asc(libraryItems.id))
    .limit(BATCH_SIZE);

  return rows.map((row) => ({ id: row.id, thumbPath: row.thumbPath! }));
}

/** One proxyImage call for one item, at the poster's one cache size. Each
 *  task is a single fetch-semaphore acquisition at most, so bounding
 *  concurrent tasks to MAX_CONCURRENT_WARMS bounds concurrent semaphore
 *  slots the same way. Returns why the warm failed, or null. */
async function runWarmTask(
  serverId: string,
  thumbPath: string
): Promise<{ reason: string; itemFault: boolean } | null> {
  const result = await proxyImage({
    serverId,
    imagePath: thumbPath,
    ...POSTER_IMAGE_SIZE,
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
 * Process one batch: warm at most MAX_CONCURRENT_WARMS items at a time, one
 * proxyImage call each (posters have exactly one cache size now), so bounding
 * concurrent items bounds concurrent fetch-semaphore acquisitions the same
 * way. Re-enqueues for the next cursor when the raw batch came back full
 * (more items may remain beyond it).
 *
 * Fail-open: precache is a best-effort background warm, so one item's warm
 * failing is logged and skipped rather than failing the batch or the job.
 */
export async function processImagePrecacheJob(
  job: Job<ImagePrecacheJobData>
): Promise<{ skipped: true; reason: string } | { done: true } | { processed: number }> {
  const { serverId, cursor, sinceUpdatedAt } = job.data;

  const enabled = await getSetting('imagePrecacheEnabled');
  if (!enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  if (!(await isLiveServer(serverId))) {
    return { skipped: true, reason: 'server historical' };
  }

  const passStartedAt =
    job.data.passStartedAt ?? new Date(job.timestamp ?? Date.now()).toISOString();

  const syncStatus = await getLibrarySyncStatus(serverId);
  if (syncStatus?.isActive) {
    // Raw passthrough - the sync-active backoff must stay DB-free, so the
    // progress seed (which counts rows) waits for an actual processing run.
    await enqueueChained(
      {
        serverId,
        cursor,
        sinceUpdatedAt,
        totalItems: job.data.totalItems,
        processedItems: job.data.processedItems,
        passStartedAt,
        refusedWrites: job.data.refusedWrites,
      },
      SYNC_ACTIVE_RETRY_DELAY_MS
    );
    return { skipped: true, reason: 'sync active' };
  }

  // Seed pass progress on the first processing batch; continuations carry it.
  const processedItems = job.data.processedItems ?? 0;
  const totalItems = job.data.totalItems ?? (await countEligibleItems(serverId, sinceUpdatedAt));

  const batch = await fetchBatch(serverId, cursor, sinceUpdatedAt);
  if (batch.length === 0) {
    await recordPassOutcome(serverId, sinceUpdatedAt, job.data.refusedWrites ?? 0);
    return { done: true };
  }

  if (cursor === null && sinceUpdatedAt == null) {
    await checkPersistence(serverId, batch);
  }

  const now = Date.now();
  const missing = (
    await Promise.all(
      batch.map(async (item) =>
        (deadItems.get(`${serverId} ${item.thumbPath}`) ?? 0) > now ||
        (await posterCacheEntryExists(serverId, item.thumbPath))
          ? null
          : item
      )
    )
  ).filter((item): item is PrecacheBatchRow => item !== null);

  if ((failingBatches.get(serverId) ?? 0) >= FAILURE_BACKOFF_BATCHES) {
    const round = backoffRounds.get(serverId) ?? 0;
    const delay = backoffDelayMs(round);
    backoffRounds.set(serverId, round + 1);
    // Back below the threshold so the delayed retry actually warms. Returning
    // here without this leaves the chain re-enqueueing forever, never running
    // the warm that would record the success and clear the pause.
    failingBatches.set(serverId, FAILURE_BACKOFF_BATCHES - 1);
    await enqueueChained({ ...job.data, passStartedAt }, delay);
    console.warn(`[ImagePrecache] backing off ${serverId} for ${delay}ms after failing batches`);
    return { skipped: true, reason: 'backing off' };
  }

  const concurrency = await warmConcurrencyForServer(serverId);
  let warmSuccesses = 0;
  let warmFailures = 0;
  let nextIndex = 0;
  async function warmPoolWorker(): Promise<void> {
    while (nextIndex < missing.length) {
      const item = missing[nextIndex++]!;
      // Fail-open: a single warm failing must not fail the batch or the job.
      try {
        const failure = await runWarmTask(serverId, item.thumbPath);
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

  const refusedWrites = (job.data.refusedWrites ?? 0) + takeRefusedWrites();
  if (batch.length === BATCH_SIZE) {
    const nextCursor = batch[batch.length - 1]!.id;
    await enqueueChained({
      serverId,
      cursor: nextCursor,
      sinceUpdatedAt,
      totalItems,
      processedItems: processedItems + batch.length,
      passStartedAt,
      refusedWrites,
    });
    return { processed: batch.length };
  }
  await recordPassOutcome(serverId, sinceUpdatedAt, refusedWrites);
  return { processed: batch.length };
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
 * Active precache passes for the running-tasks UI. A pass is a chain of
 * batch jobs; at any moment the chain has at most one live job per server
 * carrying cumulative pass progress in its data. Delayed jobs are the
 * sync-active backoff and count as pending, not running.
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
