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
import { getRedisPrefix, LEGACY_VERSION_SENTINEL, supportsMediaLibrary } from '@tracearr/shared';
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
  maybeEnqueueImportedHistoryLink,
  type SyncResult,
} from '../services/librarySync.js';
import { syncServer } from '../services/sync.js';
import { getPubSubService } from '../services/cache.js';
import { enqueueMaintenanceJob, maybeEnqueueMaintenanceJob } from './maintenanceQueue.js';
import { enqueueImagePrecache } from './imagePrecacheQueue.js';
import { resolvePrecachePass } from './precachePassPolicy.js';
import { VALID_LIBRARY_ITEM_CONDITION } from '../utils/snapshotValidation.js';
import { scheduleImageCacheSweep } from '../services/imageCacheSweep.js';

// Job data interface
export interface LibrarySyncJobData {
  serverId: string;
  triggeredBy: 'manual' | 'scheduled';
  userId?: string; // For audit trail on manual syncs
}

// Queue configuration
const QUEUE_NAME = 'library-sync';

// Matches libraryEventSync.ts's debounce window - see enqueueLibrarySyncFromEvent
const EVENT_SYNC_JOB_BUCKET_MS = 30_000;

// Module-level state
let connectionOptions: ConnectionOptions | null = null;
let librarySyncQueue: Queue<LibrarySyncJobData> | null = null;
let librarySyncWorker: Worker<LibrarySyncJobData> | null = null;
let redisClient: Redis | null = null;
const activeSyncs = new Map<string, boolean>();

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
 * The flag survives promotion - a scheduler job that reached waiting or active
 * still carries repeatJobKey - so only apply this to jobs read from `delayed`.
 * A promoted one is genuinely imminent work and must count as pending.
 *
 * One case this knowingly discounts: a scheduler job sitting in retry-backoff
 * also lives in `delayed` with repeatJobKey set, so it reads as a placeholder
 * too even though it's a real pending retry. Accepted trade-off - the cost is
 * one redundant enqueue, which fails toward extra work rather than a missed
 * sync.
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
    REDIS_KEYS.LIBRARY_COMPLETION,
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
    async (job: Job<LibrarySyncJobData>) => {
      const { serverId, triggeredBy } = job.data;
      const startTime = Date.now();
      console.log(`[LibrarySync] Starting job ${job.id} for server ${serverId} (${triggeredBy})`);

      // Check if already syncing this server
      if (activeSyncs.get(serverId)) {
        console.log(
          `[LibrarySync] Skipping job ${job.id} - sync already in progress for server ${serverId}`
        );
        return { skipped: true, reason: 'sync already in progress' };
      }

      // Mark as active
      activeSyncs.set(serverId, true);

      try {
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

        // Execute sync
        const results = await librarySyncService.syncServer(serverId, onProgress, triggeredBy);

        // Event-driven syncs re-run every 30s during a long scan; invalidating
        // on every no-op pass would keep the whole cache layer cold, so this
        // only fires when the sync actually touched an item.
        // itemsRemoved also catches a full-tombstone scan and orphan-cleanup deletes (itemsProcessed stays 0 for both).
        const hadChanges = results.some((r) => r.itemsProcessed > 0 || r.itemsRemoved > 0);
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

        const duration = Math.round((Date.now() - startTime) / 1000);
        console.log(`[LibrarySync] Job ${job.id} completed in ${duration}s:`, {
          libraries: results.length,
          totalItems: results.reduce((sum, r) => sum + r.itemsProcessed, 0),
          added: results.reduce((sum, r) => sum + r.itemsAdded, 0),
          removed: results.reduce((sum, r) => sum + r.itemsRemoved, 0),
          skipped: results.reduce((sum, r) => sum + r.itemsSkipped, 0),
        });

        return { success: true, results };
      } finally {
        // Always clear active sync flag
        activeSyncs.delete(serverId);
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 2, // Allow 2 concurrent syncs (different servers)
      lockDuration: 60 * 60 * 1000, // 1 hour - large libraries take time
      stalledInterval: 30 * 1000, // Check for stalled jobs every 30 seconds
      maxStalledCount: 2, // Retry stalled jobs up to 2 times before failing
    }
  );

  // Handle stalled jobs
  librarySyncWorker.on('stalled', (jobId) => {
    console.warn(`[LibrarySync] Job ${jobId} stalled - will be retried`);
  });

  // Handle job failures
  librarySyncWorker.on('failed', (job, error) => {
    if (!job) return;
    const { serverId } = job.data;

    // Clear active sync flag
    activeSyncs.delete(serverId);

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

/**
 * Schedule auto-sync for all servers every 12 hours at :10 past the hour (UTC)
 * Offset from :00 to avoid collision with aggregate auto-refresh
 */
export async function scheduleAutoSync(): Promise<void> {
  if (!librarySyncQueue) {
    throw new Error('Library sync queue not initialized');
  }

  // Query all servers from database
  const allServers = (await db.select({ id: servers.id, name: servers.name, type: servers.type }).from(servers)).filter((s) => supportsMediaLibrary(s.type));

  if (allServers.length === 0) {
    console.log('[LibrarySync] No servers found - skipping auto-sync scheduling');
    return;
  }

  // Remove existing job schedulers first (in case servers changed)
  const schedulers = await librarySyncQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await librarySyncQueue.removeJobScheduler(scheduler.key);
  }

  // Add repeatable job for each server with staggered cron times
  // Spreads DB, Redis, and API load across servers instead of firing all at once
  for (let i = 0; i < allServers.length; i++) {
    const server = allServers[i];
    if (!server) continue;
    const minuteOffset = (10 + i * 4) % 60; // Server 0 at :10, server 1 at :14, wraps at 60

    await librarySyncQueue.add(
      `auto-sync-${server.id}`,
      {
        serverId: server.id,
        triggeredBy: 'scheduled',
      },
      {
        repeat: {
          pattern: `${minuteOffset} */12 * * *`,
          tz: 'UTC',
        },
        jobId: `scheduled-${server.id}`,
      }
    );
  }

  console.log(
    `[LibrarySync] Scheduled auto-sync for ${allServers.length} server(s) every 12 hours (staggered)`
  );

  // Queue an immediate sync on boot (non-blocking, staggered to avoid overwhelming startup)
  // Check for any pending/delayed jobs first to avoid duplicates after rapid restarts.
  // The schedulers re-added just above each park a delayed job for their next
  // cron slot, matching every server - counting those would skip boot sync
  // every time, which is exactly what shipped. Only non-scheduler jobs count.
  const pendingJobs = await librarySyncQueue.getJobs(['delayed', 'waiting']);
  const queuedSyncJobs = pendingJobs.filter((j) => !isSchedulerJob(j));

  // Backlogs survive restarts in Redis (older releases banked one event-sync
  // job per 30s bucket during long scans). A sync reads current server state
  // when it runs, so the newest queued job per server covers all of them.
  const newestPerServer = new Map<string, Job<LibrarySyncJobData>>();
  for (const job of queuedSyncJobs) {
    const current = newestPerServer.get(job.data.serverId);
    if (!current || (job.timestamp ?? 0) > (current.timestamp ?? 0)) {
      newestPerServer.set(job.data.serverId, job);
    }
  }
  let sweptCount = 0;
  for (const job of queuedSyncJobs) {
    if (newestPerServer.get(job.data.serverId) === job) continue;
    await job.remove().catch(() => undefined);
    sweptCount++;
  }
  if (sweptCount > 0) {
    console.log(`[LibrarySync] Swept ${sweptCount} stale queued sync job(s) from a previous run`);
  }

  const pendingServerIds = new Set(newestPerServer.keys());

  for (let i = 0; i < allServers.length; i++) {
    const server = allServers[i];
    if (!server) continue;

    // Skip if there's already a pending job for this server
    if (pendingServerIds.has(server.id)) {
      console.log(`[LibrarySync] Skipping boot sync for ${server.name} - job already pending`);
      continue;
    }

    await librarySyncQueue.add(
      `boot-sync-${server.id}`,
      {
        serverId: server.id,
        triggeredBy: 'scheduled',
      },
      {
        delay: (i + 1) * 10000, // Stagger by 10 seconds per server
        jobId: `boot-sync-${server.id}-${Date.now()}`,
      }
    );
  }

  console.log(`[LibrarySync] Queued boot sync for ${allServers.length} server(s)`);
}

/**
 * Manually trigger a library sync for a server
 */
export async function enqueueLibrarySync(serverId: string, userId?: string): Promise<string> {
  if (!librarySyncQueue) {
    throw new Error('Library sync queue not initialized');
  }
  const server = await db.select({ type: servers.type }).from(servers).where(sql`${servers.id} = ${serverId}`).limit(1);
  if (server[0] && !supportsMediaLibrary(server[0].type)) throw new Error('Library sync is not supported for this server');

  // Only block if there's an active sync running - scheduled jobs shouldn't block manual syncs
  const activeJobs = await librarySyncQueue.getJobs(['active']);
  const existingJob = activeJobs.find((job) => job.data.serverId === serverId);

  if (existingJob) {
    throw new Error('A sync is already in progress for this server');
  }

  // A manual sync supersedes queued scheduled/event syncs for the same server -
  // they'd redo strictly less work than the manual full pass that's about to run.
  // Scheduler-owned jobs are left alone: BullMQ refuses to remove the parked
  // cron placeholder outright, and a promoted one costs at most one redundant
  // pass that the worker's activeSyncs guard already collapses.
  const queuedJobs = await librarySyncQueue.getJobs(['waiting', 'delayed']);
  for (const queued of queuedJobs) {
    if (
      queued.data.serverId === serverId &&
      queued.data.triggeredBy === 'scheduled' &&
      !isSchedulerJob(queued)
    ) {
      await queued.remove().catch(() => {
        /* raced to active or already gone - the active check above stands */
      });
    }
  }

  // Add job with unique ID
  const job = await librarySyncQueue.add(
    `manual-sync-${serverId}`,
    {
      serverId,
      triggeredBy: 'manual',
      userId,
    },
    {
      jobId: `manual-${serverId}-${Date.now()}`,
    }
  );

  console.log(`[LibrarySync] Enqueued manual sync for server ${serverId} (job ${job.id})`);
  return job.id ?? `manual-${serverId}-${Date.now()}`;
}

/**
 * True when a library sync for the server is active, waiting or delayed, and
 * when the queue is not initialized, since nothing then says there is none. A
 * job SCHEDULER's parked delayed job (id "repeat:...") is a placeholder for
 * the next cron slot - possibly hours out - not pending work, so it does not
 * count. Scheduler jobs that reached waiting/active ARE real work and do.
 */
export async function hasPendingLibrarySync(serverId: string): Promise<boolean> {
  if (!librarySyncQueue) return true;
  const [runningJobs, delayedJobs] = await Promise.all([
    librarySyncQueue.getJobs(['active', 'waiting']),
    librarySyncQueue.getJobs(['delayed']),
  ]);
  return (
    runningJobs.some((job) => job.data.serverId === serverId) ||
    delayedJobs.some((job) => job.data.serverId === serverId && !isSchedulerJob(job))
  );
}

/**
 * Enqueue a targeted sync triggered by a real-time library event (Plex SSE or
 * the Jellyfin/Emby plugin SSE). Uses triggeredBy 'scheduled' so the incremental
 * path stays eligible - unlike a manual sync, an event doesn't warrant forcing
 * a full scan every time.
 *
 * jobId is bucketed to a window matching the event debouncer's collection
 * window (see libraryEventSync.ts), so if multiple app instances each observed
 * the same event, their enqueue calls collapse into a single BullMQ job instead
 * of stacking up duplicate syncs.
 */
export async function enqueueLibrarySyncFromEvent(serverId: string): Promise<void> {
  if (!librarySyncQueue) return;

  // One pending sync per server is all that's ever needed: a sync job reads
  // the server's current state when it runs.
  if (await hasPendingLibrarySync(serverId)) return;

  const bucket = Math.floor(Date.now() / EVENT_SYNC_JOB_BUCKET_MS);
  await librarySyncQueue.add(
    `event-sync-${serverId}`,
    { serverId, triggeredBy: 'scheduled' },
    { jobId: `event-sync-${serverId}-${bucket}` }
  );
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

  // Find job for this server in active/waiting jobs
  const jobs = await librarySyncQueue.getJobs(['active', 'waiting', 'delayed']);
  const job = jobs.find((j) => j.data.serverId === serverId);

  if (!job) {
    return { isActive: false };
  }

  const state = await job.getState();
  const progress = job.progress;

  return {
    isActive: state === 'active',
    progress: typeof progress === 'number' ? progress : undefined,
    jobId: job.id ?? undefined,
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
  // server shows a permanently queued sync" in the tasks UI. Scheduler jobs
  // that reached waiting/active are real runs and stay in the list.
  const [runningJobs, delayedJobs] = await Promise.all([
    librarySyncQueue.getJobs(['active', 'waiting']),
    librarySyncQueue.getJobs(['delayed']),
  ]);
  const jobs = [...runningJobs, ...delayedJobs.filter((job) => !isSchedulerJob(job))];

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
