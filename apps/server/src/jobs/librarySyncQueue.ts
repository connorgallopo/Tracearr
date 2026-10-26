/**
 * Library Sync Queue - BullMQ-based library synchronization job processing
 *
 * Provides scheduled and manual library sync jobs with:
 * - Daily 3 AM UTC auto-sync for all servers
 * - Manual sync trigger via API
 * - Progress tracking via WebSocket
 * - Concurrent sync prevention per server
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { isMaintenance } from '../serverState.js';
import { getRedisPrefix, LEGACY_VERSION_SENTINEL } from '@tracearr/shared';
import { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import { WS_EVENTS, REDIS_KEYS } from '@tracearr/shared';
import type { LibrarySyncProgress } from '@tracearr/shared';
import { db } from '../db/client.js';
import { getSetting, setSetting } from '../services/settings.js';
import { servers } from '../db/schema.js';
import {
  librarySyncService,
  initLibrarySyncRedis,
  LibrariesFailedError,
  maybeEnqueueImportedHistoryLink,
  SyncInterruptedError,
  type SyncResult,
} from '../services/librarySync.js';
import { syncServer } from '../services/sync.js';
import { getPubSubService } from '../services/cache.js';
import { isLiveServer, liveServers, type ServerRow } from '../services/liveServers.js';
import { enqueueMaintenanceJob, maybeEnqueueMaintenanceJob } from './maintenanceQueue.js';
import {
  WORKER_DEFAULTS,
  addSingleton,
  checkpoint,
  registerQueue,
  registerWorker,
  yieldJob,
} from './jobSafety.js';
import { enqueueImagePrecache } from './imagePrecacheQueue.js';
import { resolvePrecachePass } from './precachePassPolicy.js';
import { VALID_LIBRARY_ITEM_CONDITION } from '../utils/snapshotValidation.js';
import { scheduleImageCacheSweep } from '../services/imageCacheSweep.js';

// Job data interface
export interface LibrarySyncJobData {
  serverId: string;
  triggeredBy: 'manual' | 'scheduled';
  userId?: string; // For audit trail on manual syncs
  kind?: 'tick'; // Scheduler slot: queues the real sync through the dedup key and returns
  completedLibraryIds?: string[]; // Checkpoint: libraries this job already finished
}

// Queue configuration
const QUEUE_NAME = 'library-sync';

// Module-level state
let connectionOptions: ConnectionOptions | null = null;
let librarySyncQueue: Queue<LibrarySyncJobData> | null = null;
let librarySyncWorker: Worker<LibrarySyncJobData> | null = null;
let redisClient: Redis | null = null;

// Backfill check cooldown - only check once per hour to avoid constant queries
let lastBackfillCheck: number = 0;
const BACKFILL_CHECK_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// MIN(created_at) over library_items is a plain-table scan and only moves
// earlier when an import adds older history - cache it for a day. Worst case
// a backfill triggered by freshly imported old items starts one day late.
const EARLIEST_ITEM_CACHE_MS = 24 * 60 * 60 * 1000;
let earliestItemCache: { value: string | null; fetchedAt: number } | null = null;

/**
 * True when the job was produced by a BullMQ job scheduler (our per-server
 * auto-sync cron), as opposed to a manual, boot, or event sync.
 *
 * A registered scheduler always keeps exactly one job parked in `delayed` for
 * the next cron slot - up to a full 12h period out - so anything that treats
 * "a delayed job exists" as "work is already pending" is permanently true and
 * suppresses every other code path. `repeatJobKey` is how we tell them apart:
 * BullMQ writes the scheduler id to the job hash's `rjk` field and `getJobs`
 * hydrates it back onto the Job (Job.fromId -> Job.fromJSON). It's also the
 * field BullMQ's own removal guard reads (isJobSchedulerJob.lua), which makes
 * it more reliable than sniffing the `repeat:<id>:<ms>` job id prefix.
 * Verified against bullmq 5.80.2 on a live Redis.
 *
 * Every scheduler job is a tick (`kind: 'tick'`) that only queues the real
 * sync, so callers also skip ticks by kind in every state; a parked tick
 * matches both checks.
 */
function isSchedulerJob(job: Pick<Job<LibrarySyncJobData>, 'repeatJobKey'>): boolean {
  return Boolean(job.repeatJobKey);
}

/**
 * Invalidate library-related caches after sync completes.
 * Uses pattern matching to clear all variants (per-server, per-library, with timezone, etc.)
 */
// Shared namespace for every cache family below - keep in sync with the prefix list in invalidateLibraryCaches.
const LIBRARY_CACHE_SCAN_PREFIX = `${getRedisPrefix()}tracearr:library:`;

export async function invalidateLibraryCaches(serverId: string): Promise<void> {
  if (!redisClient) return;

  // Narrower than LIBRARY_CACHE_SCAN_PREFIX - sync state and precache watermarks also live there and must survive this sweep.
  const prefixes = [
    REDIS_KEYS.LIBRARY_STATS,
    REDIS_KEYS.LIBRARY_GROWTH,
    REDIS_KEYS.LIBRARY_QUALITY,
    REDIS_KEYS.LIBRARY_STORAGE,
    REDIS_KEYS.LIBRARY_DUPLICATES,
    REDIS_KEYS.LIBRARY_STALE,
    REDIS_KEYS.LIBRARY_WATCH,
    REDIS_KEYS.LIBRARY_PATTERNS,
    REDIS_KEYS.LIBRARY_ROI,
    REDIS_KEYS.LIBRARY_TOP_MOVIES,
    REDIS_KEYS.LIBRARY_TOP_SHOWS,
    REDIS_KEYS.LIBRARY_CODECS,
    REDIS_KEYS.LIBRARY_RESOLUTION,
    REDIS_KEYS.LIBRARY_SHELVES,
    REDIS_KEYS.LIBRARY_GENRES,
    REDIS_KEYS.LIBRARY_CATALOG_LETTERS,
    REDIS_KEYS.LIBRARY_CATALOG_WATCHED,
    REDIS_KEYS.LIBRARY_CATALOG_TOTALS,
    REDIS_KEYS.LIBRARY_MEDIA_DETAIL(''),
    REDIS_KEYS.LIBRARY_LIBRARIES,
  ];

  // SCAN, not KEYS (blocks Redis) - one cursor walk over the shared namespace instead of one per cache family.
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redisClient.scan(
      cursor,
      'MATCH',
      `${LIBRARY_CACHE_SCAN_PREFIX}*`,
      'COUNT',
      500
    );
    cursor = next;
    for (const key of batch) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
  } while (cursor !== '0');

  // The public API stats namespace lives outside the library scan prefix but
  // serves the same library-derived numbers; sweep it too so v2 consumers
  // never read pre-sync values for a full TTL.
  let publicCursor = '0';
  do {
    const [next, batch] = await redisClient.scan(
      publicCursor,
      'MATCH',
      `${REDIS_KEYS.PUBLIC_MEDIA_STATS('')}*`,
      'COUNT',
      500
    );
    publicCursor = next;
    keys.push(...batch);
  } while (publicCursor !== '0');

  if (keys.length > 0) {
    await redisClient.del(...keys);
    console.log(`[LibrarySync] Invalidated ${keys.length} cache keys for server ${serverId}`);
  }
}

/**
 * Initialize the library sync queue with Redis connection
 */
export function initLibrarySyncQueue(redisUrl: string): void {
  if (librarySyncQueue) {
    console.log('Library sync queue already initialized');
    return;
  }

  connectionOptions = queueConnectionOptions(redisUrl);
  redisClient = new Redis(redisUrl);
  initLibrarySyncRedis(redisClient);
  const bullPrefix = getBullPrefix();

  librarySyncQueue = new Queue<LibrarySyncJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60000, // 1 minute initial delay
      },
      removeOnComplete: {
        count: 100, // Keep last 100 completed jobs
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 50, // Keep last 50 failed jobs
      },
    },
  });
  librarySyncQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[LibrarySync] Queue error:', err);
  });
  registerQueue(librarySyncQueue);

  console.log('Library sync queue initialized');
}

/**
 * Start the library sync worker to process queued jobs
 */
export function startLibrarySyncWorker(): void {
  if (!connectionOptions) {
    throw new Error('Library sync queue not initialized. Call initLibrarySyncQueue first.');
  }

  if (librarySyncWorker) {
    console.log('Library sync worker already running');
    return;
  }

  const bullPrefix = getBullPrefix();

  librarySyncWorker = new Worker<LibrarySyncJobData>(
    QUEUE_NAME,
    async (job: Job<LibrarySyncJobData>, _token?: string, signal?: AbortSignal) => {
      const { serverId, triggeredBy } = job.data;
      if (job.data.kind === 'tick') {
        await enqueueLibrarySync(serverId, 'scheduled');
        return { skipped: true, reason: 'tick' };
      }

      const startTime = Date.now();
      console.log(`[LibrarySync] Starting job ${job.id} for server ${serverId} (${triggeredBy})`);

      if (!(await isLiveServer(serverId))) {
        console.log(`[LibrarySync] Skipping job ${job.id} - server ${serverId} is historical`);
        return { skipped: true, reason: 'server historical' };
      }

      // Nothing else re-reads a server's user list, so the cron and boot runs
      // refresh it. Event runs fire every 30s during a scan and are left out.
      if (job.name.startsWith('auto-sync-') || job.name.startsWith('boot-sync-')) {
        try {
          const userSync = await syncServer(serverId, { syncUsers: true, syncLibraries: false });
          if (userSync.errors.length > 0) {
            console.warn(`[LibrarySync] User sync for server ${serverId}:`, userSync.errors);
          }
        } catch (err) {
          console.error(`[LibrarySync] User sync failed for server ${serverId}:`, err);
        }
      }

      // Progress callback for WebSocket updates
      const onProgress = (progress: LibrarySyncProgress) => {
        // Update job progress percentage
        if (progress.totalItems > 0) {
          const percent = Math.round((progress.processedItems / progress.totalItems) * 100);
          void job.updateProgress(percent);
        }

        // Publish to WebSocket via pubsub
        const pubSubService = getPubSubService();
        if (pubSubService) {
          void pubSubService.publish(WS_EVENTS.LIBRARY_SYNC_PROGRESS, progress);
        }
      };

      const completed = new Set(job.data.completedLibraryIds ?? []);
      const resumed = completed.size > 0;
      let results: SyncResult[];
      // Held until the libraries that did sync are wrapped up, then rethrown to retry the rest.
      let partial: LibrariesFailedError | null = null;
      try {
        results = await librarySyncService.syncServer(serverId, onProgress, triggeredBy, {
          completedLibraryIds: completed,
          onLibraryComplete: async (libraryId) => {
            completed.add(libraryId);
            await checkpoint(job, { completedLibraryIds: [...completed] });
          },
          signal,
        });
      } catch (error) {
        if (error instanceof SyncInterruptedError) await yieldJob(job, job.token, 0);
        if (!(error instanceof LibrariesFailedError)) throw error;
        partial = error;
        results = error.results;
      }

      // Event-driven syncs re-run every 30s during a long scan; invalidating
      // on every no-op pass would keep the whole cache layer cold, so this
      // only fires when the sync actually touched an item.
      // itemsRemoved also catches a full-tombstone scan and orphan-cleanup deletes (itemsProcessed stays 0 for both).
      // A resumed run carries no results for the libraries its earlier attempt changed.
      const hadChanges = resumed || results.some((r) => r.itemsProcessed > 0 || r.itemsRemoved > 0);
      if (hadChanges) {
        await invalidateLibraryCaches(serverId);
      }

      // Warm the poster cache for this server's newly synced items (no-op if
      // disabled, or if nothing changed and the periodic full pass isn't due)
      const precachePass = await resolvePrecachePass(
        redisClient,
        serverId,
        triggeredBy,
        hadChanges
      );
      if (precachePass) {
        const passJobId = await enqueueImagePrecache(serverId, precachePass.sinceUpdatedAt);
        // Stamps move only for a pass that really queued: a waiting pass carries an
        // older window that covers this sync's items too, and for an active one the
        // unmoved watermark hands them to the next pass.
        if (passJobId) await precachePass.commit();
      }

      // Versions that moved in this sync leave their old files behind; the sweep picks them up.
      scheduleImageCacheSweep('sync');

      if (partial) throw partial;

      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`[LibrarySync] Job ${job.id} completed in ${duration}s:`, {
        libraries: results.length,
        totalItems: results.reduce((sum, r) => sum + r.itemsProcessed, 0),
        added: results.reduce((sum, r) => sum + r.itemsAdded, 0),
        removed: results.reduce((sum, r) => sum + r.itemsRemoved, 0),
        skipped: results.reduce((sum, r) => sum + r.itemsSkipped, 0),
      });

      return { success: true, results };
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      // One sync at a time across servers, so a host never carries two full scans at once.
      concurrency: 1,
      ...WORKER_DEFAULTS,
    }
  );
  registerWorker(librarySyncWorker);

  // Handle stalled jobs
  librarySyncWorker.on('stalled', (jobId) => {
    console.warn(`[LibrarySync] Job ${jobId} stalled - will be retried`);
  });

  // Handle job failures
  librarySyncWorker.on('failed', (job, error) => {
    if (!job) return;
    const { serverId } = job.data;

    // Publish error to WebSocket
    const pubSubService = getPubSubService();
    if (pubSubService) {
      void pubSubService.publish(WS_EVENTS.LIBRARY_SYNC_PROGRESS, {
        serverId,
        serverName: 'Unknown',
        status: 'error',
        totalLibraries: 0,
        processedLibraries: 0,
        totalItems: 0,
        processedItems: 0,
        message: `Sync failed: ${error?.message || 'Unknown error'}`,
        startedAt: new Date().toISOString(),
      } satisfies LibrarySyncProgress);
    }

    console.error(`[LibrarySync] Job ${job.id} failed:`, error);
  });

  librarySyncWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[LibrarySync] Worker error:', error);
  });

  // After sync completes, check if snapshot backfill is needed (with cooldown)
  // Only runs once per hour to avoid constant queries after every server sync
  librarySyncWorker.on('completed', (job) => {
    // Skipped duplicates did no work; a backlog drain completes hundreds in
    // seconds and the sentinel probe scans library_item_versions per call
    if ((job.returnvalue as { skipped?: boolean } | undefined)?.skipped) return;
    const now = Date.now();
    if (now - lastBackfillCheck > BACKFILL_CHECK_COOLDOWN_MS) {
      lastBackfillCheck = now;
      void checkAndTriggerSnapshotBackfill();
    }
    void stampVersionsBackfillComplete();
    void handOffImportedHistoryLink(job);
  });

  console.log('Library sync worker started');
}

/**
 * Check if library snapshots need backfilling and trigger if so.
 * Compares earliest library_items.created_at (with valid size) with earliest aggregate date.
 *
 * IMPORTANT: We check the library_stats_daily continuous aggregate, NOT raw library_snapshots.
 * This prevents a race condition where:
 * 1. Backfill creates raw snapshots and refreshes aggregate
 * 2. Retention policy deletes old raw snapshots
 * 3. This check sees gap in raw table and triggers backfill again (infinite loop)
 *
 * The aggregate persists independently of raw data, so checking it avoids the loop.
 * Charts also query the aggregate, so this check matches actual data availability.
 *
 * Runs non-blocking - errors are logged but don't affect other operations.
 */
/**
 * Stamp mediaVersionsBackfilledAt the first time the last 'legacy:1' version
 * sentinel clears. The stamp marks where storage numbers change meaning
 * (multi-version rollups); the storage regression clamp and the release-note
 * plot line both read it. Write-once: never cleared or moved. Once stamped,
 * chase the snapshot normalization until its marker lands.
 */
let normalizationConfirmed = false;

/**
 * BullMQ emits `completed` only after moving the job out of `active`, so the
 * link job's readiness check never finds the sync that handed it off.
 */
async function handOffImportedHistoryLink(job: Job<LibrarySyncJobData>): Promise<void> {
  try {
    const [server] = await db
      .select({ type: servers.type })
      .from(servers)
      .where(eq(servers.id, job.data.serverId));
    if (server?.type !== 'plex') return;
    const results = (job.returnvalue as { results?: SyncResult[] } | undefined)?.results ?? [];
    await maybeEnqueueImportedHistoryLink(
      results.some((r) => r.itemsAdded > 0),
      hasPendingLibrarySync
    );
  } catch (error) {
    console.error('[LibrarySync] Imported history link hand-off failed:', error);
  }
}

async function stampVersionsBackfillComplete(): Promise<void> {
  try {
    if ((await getSetting('mediaVersionsBackfilledAt')) !== null) {
      await maybeTriggerSnapshotNormalization();
      return;
    }
    const result = await db.execute(sql`
      SELECT 1 FROM library_item_versions
      WHERE server_version_key = ${LEGACY_VERSION_SENTINEL} AND removed_at IS NULL
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      await setSetting('mediaVersionsBackfilledAt', new Date().toISOString());
      console.log('[LibrarySync] Version backfill complete; stamped mediaVersionsBackfilledAt');
      await maybeTriggerSnapshotNormalization();
    }
  } catch (error) {
    console.warn('[LibrarySync] Version backfill stamp check failed:', error);
  }
}

async function maybeTriggerSnapshotNormalization(): Promise<void> {
  if (normalizationConfirmed) return;
  if ((await getSetting('snapshotsNormalizedAt')) !== null) {
    normalizationConfirmed = true;
    return;
  }
  const enqueued = await maybeEnqueueMaintenanceJob('normalize_library_snapshots', 'system');
  if (enqueued) {
    console.log('[LibrarySync] Snapshot normalization job queued');
  }
}

async function checkAndTriggerSnapshotBackfill(): Promise<void> {
  try {
    // Aggregate-side facts every run (library_stats_daily is tiny), but the
    // library_items side is a plain-table scan: the count is only an
    // existence question, and MIN(created_at) only moves when an import adds
    // older history, so it's cached below. The staleness gap detection stays
    // live on every run - it exists to catch the incremental-sync snapshot
    // bug and must not be cached away.
    // We check library_stats_daily (aggregate) instead of raw library_snapshots
    // because the aggregate persists after raw chunks are cleaned up
    const result = await db.execute(sql`
      SELECT
        (SELECT MIN(day)::date FROM library_stats_daily) AS earliest_aggregate,
        (SELECT MAX(day)::date FROM library_stats_daily) AS latest_aggregate,
        (SELECT COUNT(DISTINCT day) FROM library_stats_daily) AS aggregate_days,
        EXISTS (
          SELECT 1 FROM library_items
          WHERE ${VALID_LIBRARY_ITEM_CONDITION} AND removed_at IS NULL
        ) AS has_items
    `);

    const row = result.rows[0] as {
      earliest_aggregate: string | null;
      latest_aggregate: string | null;
      aggregate_days: string;
      has_items: boolean;
    };

    const aggregateDays = parseInt(row.aggregate_days, 10);

    // No items = nothing to backfill
    if (!row.has_items) {
      return;
    }

    const now = Date.now();
    if (!earliestItemCache || now - earliestItemCache.fetchedAt >= EARLIEST_ITEM_CACHE_MS) {
      const earliestResult = await db.execute(sql`
        SELECT MIN(created_at)::date AS earliest_item
        FROM library_items
        WHERE ${VALID_LIBRARY_ITEM_CONDITION} AND removed_at IS NULL
      `);
      earliestItemCache = {
        value: (earliestResult.rows[0] as { earliest_item: string | null }).earliest_item,
        fetchedAt: now,
      };
    }
    const earliestItem = earliestItemCache.value;

    // Detect mid-timeline gaps: aggregate exists but hasn't been updated in 2+ days.
    // This catches the incremental sync snapshot bug where syncs ran but no snapshots
    // were created, leaving a hole in the growth timeline.
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const isStale =
      aggregateDays > 0 &&
      row.latest_aggregate &&
      new Date(row.latest_aggregate).getTime() < Date.now() - TWO_DAYS_MS;

    // No aggregate data yet, aggregate starts after items, or mid-timeline gap
    const needsBackfill =
      aggregateDays === 0 ||
      (earliestItem &&
        row.earliest_aggregate &&
        new Date(earliestItem) < new Date(row.earliest_aggregate)) ||
      isStale;

    if (needsBackfill) {
      // A pending normalization includes a full backfill; running the plain
      // backfill first would fill the gap with rows normalization is about
      // to drop and regenerate anyway
      if (
        (await getSetting('mediaVersionsBackfilledAt')) !== null &&
        (await getSetting('snapshotsNormalizedAt')) === null
      ) {
        console.log(
          '[LibrarySync] Snapshot backfill needed but normalization is pending; deferring to it'
        );
        await maybeTriggerSnapshotNormalization();
        return;
      }

      const reason = isStale
        ? `stale aggregate (last: ${row.latest_aggregate})`
        : `items from ${earliestItem}, aggregate from ${row.earliest_aggregate || 'none'}`;
      console.log(`[LibrarySync] Snapshot backfill needed: ${reason}`);

      // Trigger backfill job (non-blocking, will be queued)
      // Use a system user ID since this is automated
      await enqueueMaintenanceJob('backfill_library_snapshots', 'system');
      console.log('[LibrarySync] Snapshot backfill job queued');
    }
  } catch (error) {
    // Log but don't throw - this is a non-critical background task
    if (error instanceof Error && error.message.includes('already in progress')) {
      // Backfill already running, that's fine
      console.log('[LibrarySync] Snapshot backfill already in progress');
    } else {
      console.error('[LibrarySync] Failed to check/trigger snapshot backfill:', error);
    }
  }
}

async function applyAutoSyncSchedules(allServers: ServerRow[]): Promise<void> {
  if (!librarySyncQueue) {
    throw new Error('Library sync queue not initialized');
  }

  // Remove existing job schedulers first (in case servers changed)
  const schedulers = await librarySyncQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await librarySyncQueue.removeJobScheduler(scheduler.key);
  }

  if (allServers.length === 0) {
    console.log('[LibrarySync] No live servers found - no auto-sync scheduled');
    return;
  }

  // Add repeatable job for each server with staggered cron times
  // Spreads DB, Redis, and API load across servers instead of firing all at once
  for (let i = 0; i < allServers.length; i++) {
    const server = allServers[i]!;
    const minuteOffset = (10 + i * 4) % 60; // Server 0 at :10, server 1 at :14, wraps at 60

    await librarySyncQueue.upsertJobScheduler(
      `scheduled-${server.id}`,
      { pattern: `${minuteOffset} */12 * * *`, tz: 'UTC' },
      {
        name: `auto-sync-${server.id}`,
        data: { serverId: server.id, triggeredBy: 'scheduled', kind: 'tick' },
      }
    );
  }

  console.log(
    `[LibrarySync] Scheduled auto-sync for ${allServers.length} server(s) every 12 hours (staggered)`
  );
}

/**
 * Rebuild the 12-hourly schedulers from the live servers, queuing nothing else.
 * Used when the set of live servers changes at runtime.
 */
export async function rebuildAutoSyncSchedules(): Promise<void> {
  if (!librarySyncQueue) {
    throw new Error('Library sync queue not initialized');
  }
  await applyAutoSyncSchedules(await liveServers());
}

/**
 * Boot: rebuild the schedulers (every 12 hours at :10 past the hour UTC, offset from
 * :00 to avoid collision with aggregate auto-refresh) and queue a staggered sync
 * for each live server. A server with a sync already queued or running keeps it.
 */
export async function scheduleAutoSync(): Promise<void> {
  if (!librarySyncQueue) {
    throw new Error('Library sync queue not initialized');
  }

  const allServers = await liveServers();
  await applyAutoSyncSchedules(allServers);
  if (allServers.length === 0) return;

  for (const [i, server] of allServers.entries()) {
    await enqueueLibrarySync(server.id, 'boot', undefined, (i + 1) * 10_000);
  }

  console.log(`[LibrarySync] Queued boot sync for ${allServers.length} server(s)`);
}

/**
 * Queue a sync for the server; the add is dropped while one is already queued or
 * running for it. A dropped manual request throws so the route can answer 409.
 */
export async function enqueueLibrarySync(
  serverId: string,
  triggeredBy: 'manual' | 'scheduled' | 'boot' | 'event',
  userId?: string,
  delay?: number
): Promise<string> {
  if (!librarySyncQueue) throw new Error('Library sync queue not initialized');

  if (triggeredBy === 'manual') {
    // A manual sync supersedes a queued automatic one; a job that already reached active refuses removal and the add below is then dropped.
    const queued = await librarySyncQueue.getJobs(['waiting', 'delayed']);
    for (const job of queued) {
      if (
        job.data.serverId === serverId &&
        job.data.kind !== 'tick' &&
        !isSchedulerJob(job) &&
        job.data.triggeredBy !== 'manual'
      ) {
        await job.remove().catch(() => undefined);
      }
    }
  }

  const name = `${triggeredBy === 'scheduled' ? 'auto' : triggeredBy}-sync-${serverId}`;
  const data: LibrarySyncJobData = {
    serverId,
    triggeredBy: triggeredBy === 'manual' ? 'manual' : 'scheduled',
    ...(userId ? { userId } : {}),
  };
  const { jobId, accepted } = await addSingleton(
    librarySyncQueue,
    name,
    data,
    `sync-${serverId}`,
    delay ? { delay } : undefined
  );
  if (!accepted) {
    if (triggeredBy === 'manual') throw new Error('A sync is already in progress for this server');
    return jobId;
  }
  console.log(`[LibrarySync] Enqueued ${triggeredBy} sync for server ${serverId} (job ${jobId})`);
  return jobId;
}

/**
 * True when a library sync for the server is active, waiting or delayed, and
 * when the queue is not initialized, since nothing then says there is none.
 * Scheduler ticks are not syncs and never count.
 */
export async function hasPendingLibrarySync(serverId: string): Promise<boolean> {
  if (!librarySyncQueue) return true;
  const [runningJobs, delayedJobs] = await Promise.all([
    librarySyncQueue.getJobs(['active', 'waiting']),
    librarySyncQueue.getJobs(['delayed']),
  ]);
  return (
    runningJobs.some((job) => job.data.serverId === serverId && job.data.kind !== 'tick') ||
    delayedJobs.some(
      (job) => job.data.serverId === serverId && job.data.kind !== 'tick' && !isSchedulerJob(job)
    )
  );
}

/**
 * Enqueue a targeted sync triggered by a real-time library event (Plex SSE or
 * the Jellyfin/Emby plugin SSE). Uses triggeredBy 'scheduled' so the incremental
 * path stays eligible - unlike a manual sync, an event doesn't warrant forcing
 * a full scan every time.
 */
export async function enqueueLibrarySyncFromEvent(serverId: string): Promise<void> {
  if (!librarySyncQueue) return;
  await enqueueLibrarySync(serverId, 'event');
}

/**
 * Get sync status for a server
 */
export async function getLibrarySyncStatus(
  serverId: string
): Promise<{ isActive: boolean; progress?: number; jobId?: string } | null> {
  if (!librarySyncQueue) {
    return null;
  }

  const forServer = (j: Job<LibrarySyncJobData>) =>
    j.data.serverId === serverId && j.data.kind !== 'tick';
  const active = (await librarySyncQueue.getJobs(['active'])).find(forServer);
  const match = active ?? (await librarySyncQueue.getJobs(['waiting', 'delayed'])).find(forServer);

  if (!match) {
    return { isActive: false };
  }

  const progress = match.progress;

  return {
    isActive: active !== undefined,
    progress: typeof progress === 'number' ? progress : undefined,
    jobId: match.id ?? undefined,
  };
}

/**
 * Get all active/pending library sync jobs
 */
export async function getAllActiveLibrarySyncs(): Promise<
  Array<{
    jobId: string;
    serverId: string;
    triggeredBy: 'manual' | 'scheduled';
    state: string;
    progress: number | null;
    createdAt: number;
  }>
> {
  if (!librarySyncQueue) {
    return [];
  }

  // A delayed scheduler placeholder (see isSchedulerJob) is a parked cron
  // slot, not a pending sync - counting it here is what surfaced as "every
  // server shows a permanently queued sync" in the tasks UI. A tick in any
  // state only queues a sync, which is listed on its own.
  const [runningJobs, delayedJobs] = await Promise.all([
    librarySyncQueue.getJobs(['active', 'waiting']),
    librarySyncQueue.getJobs(['delayed']),
  ]);
  const jobs = [...runningJobs, ...delayedJobs.filter((job) => !isSchedulerJob(job))].filter(
    (job) => job.data.kind !== 'tick'
  );

  return Promise.all(
    jobs.map(async (job) => {
      const state = await job.getState();
      const progress = job.progress;
      return {
        jobId: job.id ?? 'unknown',
        serverId: job.data.serverId,
        triggeredBy: job.data.triggeredBy,
        state,
        progress: typeof progress === 'number' ? progress : null,
        createdAt: job.timestamp ?? Date.now(),
      };
    })
  );
}

/**
 * Obliterate the library sync queue - removes ALL jobs (nuclear option)
 *
 * This completely wipes the queue, including completed and failed jobs.
 * Use when the queue is in an unrecoverable state.
 */
export async function obliterateLibrarySyncQueue(): Promise<{ success: boolean }> {
  if (!librarySyncQueue) {
    return { success: false };
  }

  try {
    await librarySyncQueue.obliterate({ force: true });
    console.log('[LibrarySync] Queue obliterated');
    return { success: true };
  } catch (error) {
    console.error('[LibrarySync] Failed to obliterate queue:', error);
    return { success: false };
  }
}

/**
 * Gracefully shutdown the library sync queue
 */
export async function shutdownLibrarySyncQueue(): Promise<void> {
  console.log('Shutting down library sync queue...');

  if (librarySyncWorker) {
    await librarySyncWorker.close();
    librarySyncWorker = null;
  }

  if (librarySyncQueue) {
    await librarySyncQueue.close();
    librarySyncQueue = null;
  }

  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }

  console.log('Library sync queue shutdown complete');
}

/**
 * Get queue statistics for the library sync queue
 */
export async function getLibrarySyncQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  schedule: string | null;
} | null> {
  if (!librarySyncQueue) return null;

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    librarySyncQueue.getWaitingCount(),
    librarySyncQueue.getActiveCount(),
    librarySyncQueue.getCompletedCount(),
    librarySyncQueue.getFailedCount(),
    librarySyncQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed, schedule: '10 */12 * * *' };
}
