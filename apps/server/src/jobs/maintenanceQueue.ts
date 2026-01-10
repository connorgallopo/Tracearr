/**
 * Maintenance Queue - BullMQ-based maintenance job processing
 *
 * Provides reliable, resumable maintenance job processing with:
 * - Restart resilience (job state persisted in Redis)
 * - Progress tracking via WebSocket
 * - Single job at a time (prevents resource contention)
 *
 * Available maintenance jobs:
 * - normalize_players: Normalize player/device/platform names in historical sessions
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type {
  MaintenanceJobProgress,
  MaintenanceJobResult,
  MaintenanceJobType,
} from '@tracearr/shared';
import { WS_EVENTS } from '@tracearr/shared';
import { sql, isNotNull, or, and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { normalizeClient, normalizePlatformName } from '../utils/platformNormalizer.js';
import { getPubSubService } from '../services/cache.js';
import { rebuildTimescaleViews } from '../db/timescale.js';
import countries from 'i18n-iso-countries';
import countriesEn from 'i18n-iso-countries/langs/en.json' with { type: 'json' };

// Register English locale for country name lookups
countries.registerLocale(countriesEn);

// Convert country name to ISO 3166-1 alpha-2 code
// Handles common variations like "United States", "USA", "United Kingdom", etc.
function getCountryCode(name: string): string | undefined {
  return countries.getAlpha2Code(name, 'en') ?? undefined;
}

// Job data types
export interface MaintenanceJobData {
  type: MaintenanceJobType;
  userId: string; // Audit trail - who initiated the job
}

// Queue configuration
const QUEUE_NAME = 'maintenance';

// Connection and instances
let connectionOptions: ConnectionOptions | null = null;
let maintenanceQueue: Queue<MaintenanceJobData> | null = null;
let maintenanceWorker: Worker<MaintenanceJobData> | null = null;

// Track active job state
let activeJobProgress: MaintenanceJobProgress | null = null;

/**
 * Initialize the maintenance queue with Redis connection
 */
export function initMaintenanceQueue(redisUrl: string): void {
  if (maintenanceQueue) {
    console.log('Maintenance queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };

  maintenanceQueue = new Queue<MaintenanceJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    defaultJobOptions: {
      attempts: 1, // Maintenance jobs should not retry automatically
      removeOnComplete: {
        count: 50, // Keep last 50 completed jobs
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: false, // Keep failed jobs for investigation
    },
  });

  console.log('Maintenance queue initialized');
}

/**
 * Start the maintenance worker to process queued jobs
 */
export function startMaintenanceWorker(): void {
  if (!connectionOptions) {
    throw new Error('Maintenance queue not initialized. Call initMaintenanceQueue first.');
  }

  if (maintenanceWorker) {
    console.log('Maintenance worker already running');
    return;
  }

  maintenanceWorker = new Worker<MaintenanceJobData>(
    QUEUE_NAME,
    async (job: Job<MaintenanceJobData>) => {
      const startTime = Date.now();
      console.log(`[Maintenance] Starting job ${job.id} (${job.data.type})`);

      try {
        const result = await processMaintenanceJob(job);
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.log(`[Maintenance] Job ${job.id} completed in ${duration}s:`, result);
        return result;
      } catch (error) {
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.error(`[Maintenance] Job ${job.id} failed after ${duration}s:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      concurrency: 1, // Only 1 maintenance job at a time
      lockDuration: 10 * 60 * 1000, // 10 minutes
      stalledInterval: 10 * 60 * 1000, // Check for stalled jobs every 10 minutes
    }
  );

  // Handle job failures
  maintenanceWorker.on('failed', (job, error) => {
    if (!job) return;
    activeJobProgress = null;

    const pubSubService = getPubSubService();
    if (pubSubService) {
      void pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, {
        type: job.data.type,
        status: 'error',
        totalRecords: 0,
        processedRecords: 0,
        updatedRecords: 0,
        skippedRecords: 0,
        errorRecords: 0,
        message: `Job failed: ${error?.message || 'Unknown error'}`,
      });
    }
  });

  maintenanceWorker.on('error', (error) => {
    console.error('[Maintenance] Worker error:', error);
  });

  console.log('Maintenance worker started');
}

/**
 * Process a single maintenance job (routes to appropriate handler)
 */
async function processMaintenanceJob(job: Job<MaintenanceJobData>): Promise<MaintenanceJobResult> {
  switch (job.data.type) {
    case 'normalize_players':
      return processNormalizePlayersJob(job);
    case 'normalize_countries':
      return processNormalizeCountriesJob(job);
    case 'fix_imported_progress':
      return processFixImportedProgressJob(job);
    case 'rebuild_timescale_views':
      return processRebuildTimescaleViewsJob(job);
    case 'normalize_codecs':
      return processNormalizeCodecsJob(job);
    default:
      throw new Error(`Unknown maintenance job type: ${job.data.type}`);
  }
}

/**
 * Normalize player names in historical sessions
 *
 * Updates the `device` and `platform` columns based on the existing
 * `product` and `playerName` values using the platformNormalizer utility.
 */
async function processNormalizePlayersJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();
  const BATCH_SIZE = 500;

  // Initialize progress
  activeJobProgress = {
    type: 'normalize_players',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Counting sessions...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    // Count total sessions that have player/product info
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        or(
          isNotNull(sessions.product),
          isNotNull(sessions.playerName),
          isNotNull(sessions.platform)
        )
      );

    const totalRecords = countResult?.count ?? 0;
    activeJobProgress.totalRecords = totalRecords;
    activeJobProgress.message = `Processing ${totalRecords.toLocaleString()} sessions...`;
    await publishProgress();

    if (totalRecords === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'No sessions to normalize';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      return {
        success: true,
        type: 'normalize_players',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'No sessions to normalize',
      };
    }

    let lastId = ''; // Cursor for pagination
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    // Small delay between batches to avoid overwhelming the database
    const BATCH_DELAY_MS = 50;

    while (totalProcessed < totalRecords) {
      // Fetch batch of sessions using cursor-based pagination
      const whereCondition = or(
        isNotNull(sessions.product),
        isNotNull(sessions.playerName),
        isNotNull(sessions.platform)
      );

      const batch = await db
        .select({
          id: sessions.id,
          product: sessions.product,
          playerName: sessions.playerName,
          device: sessions.device,
          platform: sessions.platform,
        })
        .from(sessions)
        .where(lastId ? and(whereCondition, sql`${sessions.id} > ${lastId}`) : whereCondition)
        .orderBy(sessions.id)
        .limit(BATCH_SIZE);

      // No more records to process
      if (batch.length === 0) {
        break;
      }

      // Update cursor to last record in batch
      lastId = batch[batch.length - 1]!.id;

      // Collect updates for batch processing
      const updates: Array<{ id: string; device: string; platform: string }> = [];

      for (const session of batch) {
        try {
          // Get the client string to normalize (prefer product, fallback to playerName)
          // This is the RAW value from the media server API
          const clientString = session.product || session.playerName || '';

          if (!clientString && !session.platform) {
            totalSkipped++;
            continue;
          }

          // Normalize using the platformNormalizer
          // DON'T pass session.device as hint - that's the old/bad value we're trying to fix
          // The normalizer derives device from the client string
          const normalized = normalizeClient(clientString);

          // For platform: if we have an existing platform value, normalize it
          // Otherwise use what the normalizer derived from the client string
          const normalizedPlatform = session.platform
            ? normalizePlatformName(session.platform)
            : normalized.platform;

          // Check if update is needed
          const needsUpdate =
            normalized.device !== session.device || normalizedPlatform !== session.platform;

          if (needsUpdate) {
            updates.push({
              id: session.id,
              device: normalized.device,
              platform: normalizedPlatform,
            });
          } else {
            totalSkipped++;
          }
        } catch (error) {
          console.error(`[Maintenance] Error processing session ${session.id}:`, error);
          totalErrors++;
        }
      }

      // Execute updates sequentially to avoid exhausting the connection pool
      // Maintenance jobs are not time-critical, so sequential is fine
      if (updates.length > 0) {
        for (const update of updates) {
          try {
            await db
              .update(sessions)
              .set({
                device: update.device,
                platform: update.platform,
              })
              .where(eq(sessions.id, update.id));
            totalUpdated++;
          } catch (error) {
            console.error(`[Maintenance] Error updating session ${update.id}:`, error);
            totalErrors++;
          }
        }
      }

      totalProcessed += batch.length;
      activeJobProgress.processedRecords = totalProcessed;
      activeJobProgress.updatedRecords = totalUpdated;
      activeJobProgress.skippedRecords = totalSkipped;
      activeJobProgress.errorRecords = totalErrors;
      activeJobProgress.message = `Processed ${totalProcessed.toLocaleString()} of ${totalRecords.toLocaleString()} sessions...`;

      // Update job progress
      const percent = Math.round((totalProcessed / totalRecords) * 100);
      await job.updateProgress(percent);
      await publishProgress();

      // Extend lock to prevent stalled job detection
      try {
        await job.extendLock(job.token ?? '', 10 * 60 * 1000);
      } catch {
        console.warn(`[Maintenance] Failed to extend lock for job ${job.id}`);
      }

      // Brief pause between batches to let other operations through
      if (totalProcessed < totalRecords) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const durationMs = Date.now() - startTime;
    activeJobProgress.status = 'complete';
    activeJobProgress.message = `Completed! Updated ${totalUpdated.toLocaleString()} sessions in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'normalize_players',
      processed: totalRecords,
      updated: totalUpdated,
      skipped: totalSkipped,
      errors: totalErrors,
      durationMs,
      message: `Normalized ${totalUpdated.toLocaleString()} sessions`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Normalize country names to ISO codes in historical sessions
 *
 * Converts full country names (e.g., "United States") to ISO 3166-1 alpha-2 codes (e.g., "US").
 * This fixes historical data from before the system was updated to store country codes.
 */
async function processNormalizeCountriesJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();
  const BATCH_SIZE = 500;
  const BATCH_DELAY_MS = 50;

  // Initialize progress
  activeJobProgress = {
    type: 'normalize_countries',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Counting sessions with country data...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    // Count sessions that need geo normalization:
    // - geoCountry longer than 2 chars (not already ISO codes)
    // - OR geoCity is "Local" (old format that should be geoCountry="Local Network")
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        or(
          and(isNotNull(sessions.geoCountry), sql`length(${sessions.geoCountry}) > 2`),
          sql`lower(${sessions.geoCity}) = 'local'`
        )
      );

    const totalRecords = countResult?.count ?? 0;
    activeJobProgress.totalRecords = totalRecords;
    activeJobProgress.message = `Processing ${totalRecords.toLocaleString()} sessions...`;
    await publishProgress();

    if (totalRecords === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'No sessions need country normalization';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      return {
        success: true,
        type: 'normalize_countries',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'No sessions need country normalization',
      };
    }

    let lastId = ''; // Cursor for pagination
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    while (totalProcessed < totalRecords) {
      // Fetch batch of sessions that need geo normalization
      // Use cursor-based pagination (id > lastId) to ensure we process each record exactly once
      const whereCondition = or(
        and(isNotNull(sessions.geoCountry), sql`length(${sessions.geoCountry}) > 2`),
        sql`lower(${sessions.geoCity}) = 'local'`
      );

      const batch = await db
        .select({
          id: sessions.id,
          geoCity: sessions.geoCity,
          geoCountry: sessions.geoCountry,
        })
        .from(sessions)
        .where(lastId ? and(whereCondition, sql`${sessions.id} > ${lastId}`) : whereCondition)
        .orderBy(sessions.id)
        .limit(BATCH_SIZE);

      // No more records to process
      if (batch.length === 0) {
        break;
      }

      // Update cursor to last record in batch
      lastId = batch[batch.length - 1]!.id;

      // Collect updates for batch processing
      const updates: Array<{ id: string; geoCity: string | null; geoCountry: string }> = [];

      for (const session of batch) {
        try {
          const currentCity = session.geoCity;
          const currentCountry = session.geoCountry;

          // Fix old format: geoCity="Local" should be geoCity=null, geoCountry="Local Network"
          if (currentCity?.toLowerCase() === 'local') {
            updates.push({
              id: session.id,
              geoCity: null,
              geoCountry: 'Local Network',
            });
            continue;
          }

          if (!currentCountry || currentCountry.length <= 2) {
            // Already looks like a code
            totalSkipped++;
            continue;
          }

          // Standardize "Local" variants to "Local Network"
          if (
            currentCountry.toLowerCase() === 'local' ||
            currentCountry.toLowerCase() === 'local network'
          ) {
            if (currentCountry !== 'Local Network') {
              updates.push({
                id: session.id,
                geoCity: currentCity,
                geoCountry: 'Local Network',
              });
            } else {
              totalSkipped++;
            }
            continue;
          }

          // Try to convert country name to ISO code
          const isoCode = getCountryCode(currentCountry);

          if (isoCode) {
            updates.push({
              id: session.id,
              geoCity: currentCity,
              geoCountry: isoCode,
            });
          } else {
            // Could not find a matching ISO code - skip
            totalSkipped++;
          }
        } catch (error) {
          console.error(`[Maintenance] Error processing session ${session.id}:`, error);
          totalErrors++;
        }
      }

      // Execute updates sequentially to avoid exhausting the connection pool
      if (updates.length > 0) {
        for (const update of updates) {
          try {
            await db
              .update(sessions)
              .set({ geoCity: update.geoCity, geoCountry: update.geoCountry })
              .where(eq(sessions.id, update.id));
            totalUpdated++;
          } catch (error) {
            console.error(`[Maintenance] Error updating session ${update.id}:`, error);
            totalErrors++;
          }
        }
      }

      totalProcessed += batch.length;
      activeJobProgress.processedRecords = totalProcessed;
      activeJobProgress.updatedRecords = totalUpdated;
      activeJobProgress.skippedRecords = totalSkipped;
      activeJobProgress.errorRecords = totalErrors;
      activeJobProgress.message = `Processed ${totalProcessed.toLocaleString()} of ${totalRecords.toLocaleString()} sessions...`;

      const percent = Math.round((totalProcessed / totalRecords) * 100);
      await job.updateProgress(percent);
      await publishProgress();

      try {
        await job.extendLock(job.token ?? '', 10 * 60 * 1000);
      } catch {
        console.warn(`[Maintenance] Failed to extend lock for job ${job.id}`);
      }

      if (totalProcessed < totalRecords) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const durationMs = Date.now() - startTime;
    activeJobProgress.status = 'complete';
    activeJobProgress.message = `Completed! Converted ${totalUpdated.toLocaleString()} country names to ISO codes in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'normalize_countries',
      processed: totalRecords,
      updated: totalUpdated,
      skipped: totalSkipped,
      errors: totalErrors,
      durationMs,
      message: `Converted ${totalUpdated.toLocaleString()} country names to ISO codes`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Fix imported sessions with missing progress data
 *
 * Recalculates progressMs and totalDurationMs for sessions imported from Tautulli
 * that have durationMs but null progress values. Uses the externalSessionId to
 * identify imported sessions.
 */
async function processFixImportedProgressJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();
  const BATCH_SIZE = 500;
  const BATCH_DELAY_MS = 50;

  // Initialize progress
  activeJobProgress = {
    type: 'fix_imported_progress',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Counting imported sessions with missing progress...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    // Count sessions that:
    // - Have an externalSessionId (indicating they came from import)
    // - Have durationMs set
    // - Have null progressMs or null totalDurationMs
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        and(
          isNotNull(sessions.externalSessionId),
          isNotNull(sessions.durationMs),
          or(sql`${sessions.progressMs} IS NULL`, sql`${sessions.totalDurationMs} IS NULL`)
        )
      );

    const totalRecords = countResult?.count ?? 0;
    activeJobProgress.totalRecords = totalRecords;
    activeJobProgress.message = `Processing ${totalRecords.toLocaleString()} imported sessions...`;
    await publishProgress();

    if (totalRecords === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'No imported sessions need progress fixes';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      return {
        success: true,
        type: 'fix_imported_progress',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'No imported sessions need progress fixes',
      };
    }

    let lastId = ''; // Cursor for pagination
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    while (totalProcessed < totalRecords) {
      // Fetch batch of sessions
      // Use cursor-based pagination (id > lastId) to ensure we process each record exactly once
      const whereCondition = and(
        isNotNull(sessions.externalSessionId),
        isNotNull(sessions.durationMs),
        or(sql`${sessions.progressMs} IS NULL`, sql`${sessions.totalDurationMs} IS NULL`)
      );

      const batch = await db
        .select({
          id: sessions.id,
          durationMs: sessions.durationMs,
          progressMs: sessions.progressMs,
          totalDurationMs: sessions.totalDurationMs,
          watched: sessions.watched,
        })
        .from(sessions)
        .where(lastId ? and(whereCondition, sql`${sessions.id} > ${lastId}`) : whereCondition)
        .orderBy(sessions.id)
        .limit(BATCH_SIZE);

      // No more records to process
      if (batch.length === 0) {
        break;
      }

      // Update cursor to last record in batch
      lastId = batch[batch.length - 1]!.id;

      // Collect updates for batch processing
      const updates: Array<{ id: string; progressMs: number; totalDurationMs: number }> = [];

      for (const session of batch) {
        try {
          const durationMs = session.durationMs;
          if (durationMs === null || durationMs <= 0) {
            totalSkipped++;
            continue;
          }

          // Calculate totalDurationMs based on watched status
          // If watched = true, assume they completed it, so total ≈ duration
          // If watched = false, we can't know the total, so use duration as an estimate
          // Note: This is a best-effort fix; Tautulli imports now calculate this properly
          let totalDurationMs: number;
          if (session.watched) {
            // If marked as watched, they completed it
            totalDurationMs = durationMs;
          } else {
            // Without percent_complete from the original import, we can't calculate exactly
            // Use durationMs as the best approximation (their progress position)
            totalDurationMs = durationMs;
          }

          const progressMs = durationMs;

          // Check if update is actually needed
          if (session.progressMs === progressMs && session.totalDurationMs === totalDurationMs) {
            totalSkipped++;
            continue;
          }

          updates.push({
            id: session.id,
            progressMs,
            totalDurationMs,
          });
        } catch (error) {
          console.error(`[Maintenance] Error processing session ${session.id}:`, error);
          totalErrors++;
        }
      }

      // Execute updates sequentially to avoid exhausting the connection pool
      if (updates.length > 0) {
        for (const update of updates) {
          try {
            await db
              .update(sessions)
              .set({
                progressMs: update.progressMs,
                totalDurationMs: update.totalDurationMs,
              })
              .where(eq(sessions.id, update.id));
            totalUpdated++;
          } catch (error) {
            console.error(`[Maintenance] Error updating session ${update.id}:`, error);
            totalErrors++;
          }
        }
      }

      totalProcessed += batch.length;
      activeJobProgress.processedRecords = totalProcessed;
      activeJobProgress.updatedRecords = totalUpdated;
      activeJobProgress.skippedRecords = totalSkipped;
      activeJobProgress.errorRecords = totalErrors;
      activeJobProgress.message = `Processed ${totalProcessed.toLocaleString()} of ${totalRecords.toLocaleString()} sessions...`;

      const percent = Math.round((totalProcessed / totalRecords) * 100);
      await job.updateProgress(percent);
      await publishProgress();

      try {
        await job.extendLock(job.token ?? '', 10 * 60 * 1000);
      } catch {
        console.warn(`[Maintenance] Failed to extend lock for job ${job.id}`);
      }

      if (totalProcessed < totalRecords) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const durationMs = Date.now() - startTime;
    activeJobProgress.status = 'complete';
    activeJobProgress.message = `Completed! Fixed progress data for ${totalUpdated.toLocaleString()} sessions in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'fix_imported_progress',
      processed: totalRecords,
      updated: totalUpdated,
      skipped: totalSkipped,
      errors: totalErrors,
      durationMs,
      message: `Fixed progress data for ${totalUpdated.toLocaleString()} sessions`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Rebuild TimescaleDB views and continuous aggregates
 *
 * Drops and recreates all engagement tracking views to fix broken views
 * or apply updated view definitions after an upgrade.
 */
async function processRebuildTimescaleViewsJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();

  // Initialize progress
  activeJobProgress = {
    type: 'rebuild_timescale_views',
    status: 'running',
    totalRecords: 9, // Total steps in the rebuild process
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Starting TimescaleDB view rebuild...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    await publishProgress();

    // Call the rebuild function with progress callback
    const result = await rebuildTimescaleViews((step, total, message) => {
      if (activeJobProgress) {
        activeJobProgress.processedRecords = step;
        activeJobProgress.totalRecords = total;
        activeJobProgress.message = message;
        void publishProgress();
      }

      // Update job progress percentage
      const percent = Math.round((step / total) * 100);
      void job.updateProgress(percent);
    });

    const durationMs = Date.now() - startTime;

    if (result.success) {
      activeJobProgress.status = 'complete';
      activeJobProgress.processedRecords = 9;
      activeJobProgress.updatedRecords = 6; // Number of views created
      activeJobProgress.message = `${result.message} in ${Math.round(durationMs / 1000)}s`;
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      activeJobProgress = null;

      return {
        success: true,
        type: 'rebuild_timescale_views',
        processed: 9,
        updated: 6,
        skipped: 0,
        errors: 0,
        durationMs,
        message: result.message,
      };
    } else {
      activeJobProgress.status = 'error';
      activeJobProgress.errorRecords = 1;
      activeJobProgress.message = result.message;
      await publishProgress();
      activeJobProgress = null;

      return {
        success: false,
        type: 'rebuild_timescale_views',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 1,
        durationMs,
        message: result.message,
      };
    }
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Normalize codec names to uppercase in historical sessions
 *
 * Converts codec values (source_video_codec, source_audio_codec, stream_video_codec,
 * stream_audio_codec) to uppercase for consistency. This fixes data imported before
 * the Tautulli enrichment was updated to uppercase codecs.
 */
async function processNormalizeCodecsJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();
  const BATCH_SIZE = 1000; // Bulk update batch size

  // Initialize progress
  activeJobProgress = {
    type: 'normalize_codecs',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Counting sessions with lowercase codecs...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    // Count sessions that have codec values not already uppercase
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        or(
          sql`${sessions.sourceVideoCodec} IS DISTINCT FROM UPPER(${sessions.sourceVideoCodec})`,
          sql`${sessions.sourceAudioCodec} IS DISTINCT FROM UPPER(${sessions.sourceAudioCodec})`,
          sql`${sessions.streamVideoCodec} IS DISTINCT FROM UPPER(${sessions.streamVideoCodec})`,
          sql`${sessions.streamAudioCodec} IS DISTINCT FROM UPPER(${sessions.streamAudioCodec})`
        )
      );

    const totalRecords = countResult?.count ?? 0;
    activeJobProgress.totalRecords = totalRecords;
    activeJobProgress.message = `Processing ${totalRecords.toLocaleString()} sessions...`;
    await publishProgress();

    if (totalRecords === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'All codec names are already normalized';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      return {
        success: true,
        type: 'normalize_codecs',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'All codec names are already normalized',
      };
    }

    let totalUpdated = 0;
    let totalErrors = 0;

    // Use bulk UPDATE with LIMIT subquery - much more efficient than individual updates
    // This avoids exhausting PostgreSQL's lock pool
    while (totalUpdated < totalRecords) {
      try {
        // Single bulk UPDATE that updates up to BATCH_SIZE rows at once
        const result = await db.execute(sql`
          UPDATE ${sessions}
          SET
            source_video_codec = UPPER(source_video_codec),
            source_audio_codec = UPPER(source_audio_codec),
            stream_video_codec = UPPER(stream_video_codec),
            stream_audio_codec = UPPER(stream_audio_codec)
          WHERE id IN (
            SELECT id FROM ${sessions}
            WHERE source_video_codec IS DISTINCT FROM UPPER(source_video_codec)
               OR source_audio_codec IS DISTINCT FROM UPPER(source_audio_codec)
               OR stream_video_codec IS DISTINCT FROM UPPER(stream_video_codec)
               OR stream_audio_codec IS DISTINCT FROM UPPER(stream_audio_codec)
            LIMIT ${BATCH_SIZE}
          )
        `);

        const updatedCount = Number(result.rowCount ?? 0);

        // No more rows to update
        if (updatedCount === 0) {
          break;
        }

        totalUpdated += updatedCount;
      } catch (error) {
        console.error(`[Maintenance] Error in bulk update:`, error);
        totalErrors++;
        break;
      }

      activeJobProgress.processedRecords = totalUpdated;
      activeJobProgress.updatedRecords = totalUpdated;
      activeJobProgress.errorRecords = totalErrors;
      activeJobProgress.message = `Updated ${totalUpdated.toLocaleString()} of ${totalRecords.toLocaleString()} sessions...`;

      const percent = Math.min(100, Math.round((totalUpdated / totalRecords) * 100));
      await job.updateProgress(percent);
      await publishProgress();

      try {
        await job.extendLock(job.token ?? '', 10 * 60 * 1000);
      } catch {
        console.warn(`[Maintenance] Failed to extend lock for job ${job.id}`);
      }
    }

    const durationMs = Date.now() - startTime;
    activeJobProgress.status = 'complete';
    activeJobProgress.processedRecords = totalUpdated;
    activeJobProgress.message = `Completed! Normalized ${totalUpdated.toLocaleString()} codec values in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'normalize_codecs',
      processed: totalUpdated,
      updated: totalUpdated,
      skipped: 0,
      errors: totalErrors,
      durationMs,
      message: `Normalized ${totalUpdated.toLocaleString()} codec values to uppercase`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Get current job progress (if any)
 */
export function getMaintenanceProgress(): MaintenanceJobProgress | null {
  return activeJobProgress;
}

/**
 * Enqueue a new maintenance job
 */
export async function enqueueMaintenanceJob(
  type: MaintenanceJobType,
  userId: string
): Promise<string> {
  if (!maintenanceQueue) {
    throw new Error('Maintenance queue not initialized');
  }

  // Check for existing active job
  const activeJobs = await maintenanceQueue.getJobs(['active', 'waiting', 'delayed']);
  if (activeJobs.length > 0) {
    throw new Error('A maintenance job is already in progress');
  }

  // Use a deterministic job ID to prevent race conditions
  // BullMQ will reject if a job with this ID already exists
  const newJobId = `maintenance-${type}-${Date.now()}`;
  const job = await maintenanceQueue.add(
    `maintenance-${type}`,
    {
      type,
      userId,
    },
    {
      jobId: newJobId,
    }
  );

  const jobId = job.id ?? newJobId;
  console.log(`[Maintenance] Enqueued job ${jobId} (${type})`);
  return jobId;
}

/**
 * Get maintenance job status
 */
export async function getMaintenanceJobStatus(jobId: string): Promise<{
  jobId: string;
  state: string;
  progress: number | object | null;
  result?: MaintenanceJobResult;
  failedReason?: string;
  createdAt?: number;
  finishedAt?: number;
} | null> {
  if (!maintenanceQueue) {
    return null;
  }

  const job = await maintenanceQueue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  const progress = job.progress;

  return {
    jobId: job.id ?? jobId,
    state,
    progress: typeof progress === 'number' || typeof progress === 'object' ? progress : null,
    result: job.returnvalue as MaintenanceJobResult | undefined,
    failedReason: job.failedReason,
    createdAt: job.timestamp,
    finishedAt: job.finishedOn,
  };
}

/**
 * Get queue statistics
 */
export async function getMaintenanceQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
} | null> {
  if (!maintenanceQueue) {
    return null;
  }

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    maintenanceQueue.getWaitingCount(),
    maintenanceQueue.getActiveCount(),
    maintenanceQueue.getCompletedCount(),
    maintenanceQueue.getFailedCount(),
    maintenanceQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Get recent job history
 */
export async function getMaintenanceJobHistory(limit: number = 10): Promise<
  Array<{
    jobId: string;
    type: MaintenanceJobType;
    state: string;
    createdAt: number;
    finishedAt?: number;
    result?: MaintenanceJobResult;
  }>
> {
  if (!maintenanceQueue) {
    return [];
  }

  const jobs = await maintenanceQueue.getJobs(['completed', 'failed'], 0, limit);

  return jobs.map((job) => ({
    jobId: job.id ?? 'unknown',
    type: job.data.type,
    state: job.finishedOn ? (job.failedReason ? 'failed' : 'completed') : 'unknown',
    createdAt: job.timestamp ?? 0,
    finishedAt: job.finishedOn,
    result: job.returnvalue as MaintenanceJobResult | undefined,
  }));
}

/**
 * Gracefully shutdown
 */
export async function shutdownMaintenanceQueue(): Promise<void> {
  console.log('Shutting down maintenance queue...');

  if (maintenanceWorker) {
    await maintenanceWorker.close();
    maintenanceWorker = null;
  }

  if (maintenanceQueue) {
    await maintenanceQueue.close();
    maintenanceQueue = null;
  }

  console.log('Maintenance queue shutdown complete');
}
