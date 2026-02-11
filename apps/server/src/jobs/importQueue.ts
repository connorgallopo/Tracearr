/**
 * Import Queue - BullMQ-based async import processing
 *
 * Provides reliable, resumable import processing with:
 * - Restart resilience (job state persisted in Redis)
 * - Cancellation support
 * - Progress tracking via WebSocket
 * - Checkpoint/resume on failure
 *
 * Supports both Tautulli (for Plex) and Jellystat (for Jellyfin/Emby) imports.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisPrefix } from '@tracearr/shared';
import type {
  TautulliImportProgress,
  TautulliImportResult,
  JellystatImportResult,
} from '@tracearr/shared';
import { TautulliService } from '../services/tautulli.js';
import { importJellystatBackup } from '../services/jellystat.js';
import { getPubSubService } from '../services/cache.js';
import { extendJobLock } from './lockUtils.js';
import {
  acquireHeavyOpsLock,
  releaseHeavyOpsLock,
  extendHeavyOpsLock,
  type HeavyOpsLockHolder,
} from './heavyOpsLock.js';

// Job data types
export interface TautulliImportJobData {
  type: 'tautulli';
  serverId: string;
  userId: string; // Audit trail - who initiated the import
  checkpoint?: number; // Resume from this page (for future use)
  overwriteFriendlyNames?: boolean; // Whether to overwrite existing friendly names
  includeStreamDetails?: boolean; // (BETA) Fetch detailed codec/bitrate info via additional API calls
}

export interface JellystatImportJobData {
  type: 'jellystat';
  serverId: string;
  userId: string; // Audit trail - who initiated the import
  backupJson: string; // Jellystat backup file contents
  enrichMedia: boolean; // Whether to enrich with metadata from Jellyfin/Emby
  updateStreamDetails?: boolean; // Whether to update existing records with stream/transcode data
}

export type ImportJobData = TautulliImportJobData | JellystatImportJobData;

export type ImportJobResult = TautulliImportResult | JellystatImportResult;

// Queue configuration
const QUEUE_NAME = 'imports';
const DLQ_NAME = 'imports-dlq';

// Connection and instances
let connectionOptions: ConnectionOptions | null = null;
let importQueue: Queue<ImportJobData> | null = null;
let importWorker: Worker<ImportJobData> | null = null;
let dlqQueue: Queue<ImportJobData> | null = null;

// Cached import progress for polling access (in addition to websocket broadcasts)
interface CachedImportProgress {
  jobId: string;
  type: 'tautulli' | 'jellystat';
  serverId: string;
  status: 'waiting' | 'fetching' | 'processing' | 'complete' | 'error';
  progress: TautulliImportProgress | null;
  waitingFor?: HeavyOpsLockHolder;
  startedAt: string;
}
let activeImportProgress: CachedImportProgress | null = null;

/**
 * Initialize the import queue with Redis connection
 */
export function initImportQueue(redisUrl: string): void {
  if (importQueue) {
    console.log('Import queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  const bullPrefix = `${getRedisPrefix()}bull`;

  importQueue = new Queue<ImportJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60000, // 1min, 2min, 4min between retries
      },
      // Note: Job timeout is set per-worker, not in defaultJobOptions
      removeOnComplete: {
        count: 100, // Keep last 100 completed imports
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 50, // Keep last 50 failed jobs for investigation
        age: 7 * 24 * 60 * 60, // 7 days max - prevents unbounded accumulation
      },
    },
  });

  dlqQueue = new Queue<ImportJobData>(DLQ_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      removeOnComplete: {
        count: 25, // Retried jobs from DLQ
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 50,
        age: 14 * 24 * 60 * 60,
      },
    },
  });

  console.log('Import queue initialized');
}

/**
 * Start the import worker to process queued jobs
 */
export function startImportWorker(): void {
  if (!connectionOptions) {
    throw new Error('Import queue not initialized. Call initImportQueue first.');
  }

  if (importWorker) {
    console.log('Import worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  // Recover any stuck jobs from a previous crash before starting the worker
  if (importQueue) {
    importQueue
      .getJobs(['active'])
      .then(async (stuckJobs) => {
        if (stuckJobs.length > 0) {
          console.log(
            `[Import] Found ${stuckJobs.length} stuck job(s) from previous run, recovering...`
          );
          for (const job of stuckJobs) {
            try {
              // Move back to waiting so the new worker can pick it up
              await job.retry('failed');
              console.log(`[Import] Recovered stuck job ${job.id} - moved to waiting`);
            } catch (err) {
              console.warn(`[Import] Failed to recover job ${job.id}, removing:`, err);
              try {
                await job.remove();
              } catch {
                // Job might have already been handled
              }
            }
          }
        }
      })
      .catch((err) => {
        console.warn('[Import] Failed to check for stuck jobs:', err);
      });
  }

  importWorker = new Worker<ImportJobData>(
    QUEUE_NAME,
    async (job: Job<ImportJobData>) => {
      const startTime = Date.now();
      const jobDescription = job.data.type === 'tautulli' ? 'Tautulli import' : 'Jellystat import';
      console.log(`[Import] Starting job ${job.id} for server ${job.data.serverId}`);

      // Initialize cached progress
      activeImportProgress = {
        jobId: job.id!,
        type: job.data.type,
        serverId: job.data.serverId,
        status: 'waiting',
        progress: null,
        startedAt: new Date().toISOString(),
      };

      // Acquire heavy operations lock (waits if another heavy op is running)
      let lockHolder: HeavyOpsLockHolder | null;
      const pubSubService = getPubSubService();
      const WAIT_INTERVAL_MS = 5000; // Check every 5 seconds
      const MAX_WAIT_MS = 4 * 60 * 60 * 1000; // Max 4 hours wait
      let waitedMs = 0;

      while ((lockHolder = await acquireHeavyOpsLock('import', job.id!, jobDescription)) !== null) {
        // Update cached progress with waiting status
        activeImportProgress = {
          jobId: job.id!,
          type: job.data.type,
          serverId: job.data.serverId,
          status: 'waiting',
          progress: null,
          waitingFor: lockHolder,
          startedAt: activeImportProgress.startedAt,
        };

        // Broadcast waiting status to frontend
        if (pubSubService) {
          void pubSubService.publish('import:progress', {
            status: 'waiting',
            totalRecords: 0,
            fetchedRecords: 0,
            processedRecords: 0,
            importedRecords: 0,
            updatedRecords: 0,
            skippedRecords: 0,
            duplicateRecords: 0,
            unknownUserRecords: 0,
            activeSessionRecords: 0,
            errorRecords: 0,
            currentPage: 0,
            totalPages: 0,
            message: `Waiting for ${lockHolder.description} to complete...`,
            jobId: job.id,
            waitingFor: {
              jobType: lockHolder.jobType,
              description: lockHolder.description,
              startedAt: lockHolder.startedAt,
            },
          });
        }

        console.log(
          `[Import] Job ${job.id} waiting for ${lockHolder.jobType} job: ${lockHolder.description}`
        );

        // Extend BullMQ job lock while waiting
        await extendJobLock(job);

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
        waitedMs += WAIT_INTERVAL_MS;

        if (waitedMs >= MAX_WAIT_MS) {
          activeImportProgress = null;
          throw new Error(
            `Timed out waiting for ${lockHolder.description} after ${MAX_WAIT_MS / 1000 / 60} minutes`
          );
        }
      }

      // Update status to fetching now that we have the lock
      activeImportProgress.status = 'fetching';
      activeImportProgress.waitingFor = undefined;

      console.log(`[Import] Job ${job.id} acquired heavy ops lock`);

      try {
        const result = await processImportJob(job);
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.log(`[Import] Job ${job.id} completed in ${duration}s:`, result);
        return result;
      } catch (error) {
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.error(`[Import] Job ${job.id} failed after ${duration}s:`, error);
        throw error;
      } finally {
        // Always release the heavy ops lock and clear cached progress
        await releaseHeavyOpsLock(job.id!);
        activeImportProgress = null;
        console.log(`[Import] Job ${job.id} released heavy ops lock`);
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1, // Only 1 import at a time per worker
      // Large imports (300k+ records) can take hours - extend lock to prevent stalled job detection
      lockDuration: 2 * 60 * 60 * 1000, // 2 hours - large imports can take a long time
      stalledInterval: 30 * 1000, // Check for stalled jobs every 30 seconds
      maxStalledCount: 2, // Retry stalled jobs up to 2 times before failing
      limiter: {
        max: 1,
        duration: 60000, // Max 1 new import per minute (prevents spam)
      },
    }
  );

  // Handle stalled jobs
  importWorker.on('stalled', (jobId) => {
    console.warn(`[Import] Job ${jobId} stalled - will be retried`);
    activeImportProgress = null;
  });

  // Handle job failures - notify frontend and move to DLQ if retries exhausted
  importWorker.on('failed', (job, error) => {
    if (!job) return;
    activeImportProgress = null;

    // Always notify frontend of failure
    const pubSubService = getPubSubService();
    if (pubSubService) {
      void pubSubService.publish('import:progress', {
        status: 'error',
        totalRecords: 0,
        fetchedRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        updatedRecords: 0,
        skippedRecords: 0,
        duplicateRecords: 0,
        unknownUserRecords: 0,
        activeSessionRecords: 0,
        errorRecords: 0,
        currentPage: 0,
        totalPages: 0,
        message: `Import failed: ${error?.message || 'Unknown error'}`,
        jobId: job.id,
      });
    }

    if (job.attemptsMade >= (job.opts.attempts || 3)) {
      console.error(`[Import] Job ${job.id} exhausted retries, moving to DLQ:`, error);
      if (dlqQueue) {
        void dlqQueue.add(`dlq-${job.data.type}`, job.data, {
          jobId: `dlq-${job.id}`,
        });
      }
    }
  });

  importWorker.on('error', (error) => {
    console.error('[Import] Worker error:', error);
  });

  console.log('Import worker started');
}

/**
 * Process a single import job (routes to appropriate handler based on type)
 */
async function processImportJob(job: Job<ImportJobData>): Promise<ImportJobResult> {
  if (job.data.type === 'jellystat') {
    return processJellystatImportJob(job as Job<JellystatImportJobData>);
  }
  return processTautulliImportJob(job as Job<TautulliImportJobData>);
}

/**
 * Process a Tautulli import job
 */
async function processTautulliImportJob(
  job: Job<TautulliImportJobData>
): Promise<TautulliImportResult> {
  const { serverId, overwriteFriendlyNames = false, includeStreamDetails = false } = job.data;
  const pubSubService = getPubSubService();

  // Progress callback to update job and publish to WebSocket
  const onProgress = async (progress: TautulliImportProgress) => {
    // Update BullMQ job progress (0-100)
    const percent =
      progress.totalRecords > 0
        ? Math.round((progress.processedRecords / progress.totalRecords) * 100)
        : 0;
    await job.updateProgress(percent);

    // Update cached progress for polling access
    if (activeImportProgress && activeImportProgress.jobId === job.id) {
      activeImportProgress.status = progress.status === 'fetching' ? 'fetching' : 'processing';
      activeImportProgress.progress = progress;
    }

    // Extend locks - fails fast if lock is lost to avoid wasted work on large imports
    await extendJobLock(job, 5 * 60 * 1000);
    await extendHeavyOpsLock(job.id!);

    // Publish to WebSocket for UI
    if (pubSubService) {
      await pubSubService.publish('import:progress', {
        ...progress,
        jobId: job.id,
      });
    }
  };

  // Run the actual import with progress callback
  const result = await TautulliService.importHistory(
    serverId,
    pubSubService ?? undefined,
    onProgress,
    { overwriteFriendlyNames, skipRefresh: includeStreamDetails }
  );

  // (BETA) Enrich sessions with detailed stream data
  if (includeStreamDetails && result.success) {
    console.log(`[Import] Starting stream details enrichment for server ${serverId}`);
    if (pubSubService) {
      await pubSubService.publish('import:progress', {
        status: 'enriching',
        message: '(BETA) Fetching detailed stream data...',
        jobId: job.id,
      });
    }

    try {
      const enrichResult = await TautulliService.enrichStreamDetails(
        serverId,
        pubSubService ?? undefined,
        onProgress
      );
      console.log(
        `[Import] Stream enrichment complete: ${enrichResult.enriched} enriched, ${enrichResult.failed} failed, ${enrichResult.skipped} skipped`
      );
    } catch (error) {
      // Don't fail the import if enrichment fails - it's a best-effort enhancement
      console.error(`[Import] Stream enrichment failed:`, error);
    }
  }

  // Publish final result (note: TautulliService already publishes final progress,
  // but this is a fallback to ensure frontend receives completion notification)
  if (pubSubService) {
    const total = result.imported + result.updated + result.skipped + result.errors;
    await pubSubService.publish('import:progress', {
      status: result.success ? 'complete' : 'error',
      totalRecords: total,
      fetchedRecords: total,
      processedRecords: total,
      importedRecords: result.imported,
      updatedRecords: result.updated,
      skippedRecords: result.skipped,
      duplicateRecords: 0, // Not available in result
      unknownUserRecords: 0, // Not available in result
      activeSessionRecords: 0, // Not available in result
      errorRecords: result.errors,
      currentPage: 0,
      totalPages: 0,
      message: result.message,
      jobId: job.id,
    });
  }

  return result;
}

/**
 * Process a Jellystat import job
 */
async function processJellystatImportJob(
  job: Job<JellystatImportJobData>
): Promise<JellystatImportResult> {
  const { serverId, backupJson, enrichMedia, updateStreamDetails } = job.data;
  const pubSubService = getPubSubService();

  // Run the actual import
  const result = await importJellystatBackup(
    serverId,
    backupJson,
    enrichMedia,
    pubSubService ?? undefined,
    { updateStreamDetails }
  );

  // Publish final result
  if (pubSubService) {
    await pubSubService.publish('import:jellystat:progress', {
      status: result.success ? 'complete' : 'error',
      totalRecords: result.imported + result.updated + result.skipped + result.errors,
      processedRecords: result.imported + result.updated + result.skipped + result.errors,
      importedRecords: result.imported,
      updatedRecords: result.updated,
      skippedRecords: result.skipped,
      errorRecords: result.errors,
      enrichedRecords: result.enriched,
      message: result.message,
      jobId: job.id,
    });
  }

  return result;
}

/**
 * Get active import job for a server (if any)
 */
export async function getActiveImportForServer(serverId: string): Promise<string | null> {
  if (!importQueue) {
    return null;
  }

  const activeJobs = await importQueue.getJobs(['active', 'waiting', 'delayed']);
  const existingJob = activeJobs.find((j) => j.data.serverId === serverId);

  return existingJob?.id ?? null;
}

/**
 * Enqueue a new import job
 */
export async function enqueueImport(
  serverId: string,
  userId: string,
  overwriteFriendlyNames: boolean,
  includeStreamDetails: boolean = false
): Promise<string> {
  if (!importQueue) {
    throw new Error('Import queue not initialized');
  }

  // Check for existing active import for this server
  const existingJobId = await getActiveImportForServer(serverId);

  if (existingJobId) {
    throw new Error(`Import already in progress for server ${serverId} (job ${existingJobId})`);
  }

  const job = await importQueue.add('tautulli-import', {
    type: 'tautulli',
    serverId,
    userId,
    overwriteFriendlyNames,
    includeStreamDetails,
  });

  const jobId = job.id ?? `unknown-${Date.now()}`;
  console.log(`[Import] Enqueued job ${jobId} for server ${serverId}`);
  return jobId;
}

/**
 * Get import job status
 */
export async function getImportStatus(jobId: string): Promise<{
  jobId: string;
  state: string;
  progress: number | object | null;
  result?: ImportJobResult;
  failedReason?: string;
  createdAt?: number;
  finishedAt?: number;
} | null> {
  if (!importQueue) {
    return null;
  }

  const job = await importQueue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();

  // job.progress can be number, object, or undefined
  const progress = job.progress;

  return {
    jobId: job.id ?? jobId, // Fallback to input jobId if somehow null
    state,
    progress: typeof progress === 'number' || typeof progress === 'object' ? progress : null,
    result: job.returnvalue as ImportJobResult | undefined,
    failedReason: job.failedReason,
    createdAt: job.timestamp,
    finishedAt: job.finishedOn,
  };
}

/**
 * Cancel an import job
 */
export async function cancelImport(jobId: string): Promise<boolean> {
  if (!importQueue) {
    return false;
  }

  const job = await importQueue.getJob(jobId);
  if (!job) {
    return false;
  }

  const state = await job.getState();

  // Can only cancel waiting/delayed jobs
  // Active jobs need worker-level cancellation (not implemented in Phase 1)
  if (state === 'waiting' || state === 'delayed') {
    await job.remove();
    console.log(`[Import] Cancelled job ${jobId}`);
    return true;
  }

  console.log(`[Import] Cannot cancel job ${jobId} in state ${state}`);
  return false;
}

/**
 * Get queue statistics
 */
export async function getImportQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  dlqSize: number;
} | null> {
  if (!importQueue || !dlqQueue) {
    return null;
  }

  const [waiting, active, completed, failed, delayed, dlqWaiting] = await Promise.all([
    importQueue.getWaitingCount(),
    importQueue.getActiveCount(),
    importQueue.getCompletedCount(),
    importQueue.getFailedCount(),
    importQueue.getDelayedCount(),
    dlqQueue.getWaitingCount(),
  ]);

  return { waiting, active, completed, failed, delayed, dlqSize: dlqWaiting };
}

// ==========================================================================
// Jellystat-Specific Functions
// ==========================================================================

/**
 * Get active Jellystat import job for a server (if any)
 */
export async function getActiveJellystatImportForServer(serverId: string): Promise<string | null> {
  if (!importQueue) {
    return null;
  }

  const activeJobs = await importQueue.getJobs(['active', 'waiting', 'delayed']);
  const existingJob = activeJobs.find(
    (j) => j.data.type === 'jellystat' && j.data.serverId === serverId
  );

  return existingJob?.id ?? null;
}

/**
 * Enqueue a new Jellystat import job
 */
export async function enqueueJellystatImport(
  serverId: string,
  userId: string,
  backupJson: string,
  enrichMedia: boolean = true,
  updateStreamDetails: boolean = false
): Promise<string> {
  if (!importQueue) {
    throw new Error('Import queue not initialized');
  }

  // Check for existing active import for this server
  const existingJobId = await getActiveJellystatImportForServer(serverId);

  if (existingJobId) {
    throw new Error(`Import already in progress for server ${serverId} (job ${existingJobId})`);
  }

  const job = await importQueue.add('jellystat-import', {
    type: 'jellystat',
    serverId,
    userId,
    backupJson,
    enrichMedia,
    updateStreamDetails,
  });

  const jobId = job.id ?? `unknown-${Date.now()}`;
  console.log(`[Import] Enqueued Jellystat job ${jobId} for server ${serverId}`);
  return jobId;
}

/**
 * Get Jellystat import job status (alias for getImportStatus with Jellystat-specific typing)
 */
export async function getJellystatImportStatus(jobId: string): Promise<{
  jobId: string;
  state: string;
  progress: number | object | null;
  result?: JellystatImportResult;
  failedReason?: string;
  createdAt?: number;
  finishedAt?: number;
} | null> {
  return getImportStatus(jobId) as Promise<{
    jobId: string;
    state: string;
    progress: number | object | null;
    result?: JellystatImportResult;
    failedReason?: string;
    createdAt?: number;
    finishedAt?: number;
  } | null>;
}

/**
 * Cancel a Jellystat import job (alias for cancelImport)
 */
export async function cancelJellystatImport(jobId: string): Promise<boolean> {
  return cancelImport(jobId);
}

/**
 * Get cached import progress (for polling access in addition to websockets)
 */
export function getActiveImportProgress(): CachedImportProgress | null {
  return activeImportProgress;
}

/**
 * Get all active/pending import jobs
 */
export async function getAllActiveImports(): Promise<
  Array<{
    jobId: string;
    type: 'tautulli' | 'jellystat';
    serverId: string;
    state: string;
    progress: number | object | null;
    createdAt: number;
  }>
> {
  if (!importQueue) {
    return [];
  }

  const jobs = await importQueue.getJobs(['active', 'waiting', 'delayed']);

  return Promise.all(
    jobs.map(async (job) => {
      const state = await job.getState();
      const progress = job.progress;
      return {
        jobId: job.id ?? 'unknown',
        type: job.data.type,
        serverId: job.data.serverId,
        state,
        progress: typeof progress === 'number' || typeof progress === 'object' ? progress : null,
        createdAt: job.timestamp ?? Date.now(),
      };
    })
  );
}

/**
 * Obliterate the import queue - removes ALL jobs (nuclear option)
 *
 * This completely wipes the queue, including completed and failed jobs.
 * Use when the queue is in an unrecoverable state.
 */
export async function obliterateImportQueue(): Promise<{ success: boolean }> {
  if (!importQueue) {
    return { success: false };
  }

  try {
    await importQueue.obliterate({ force: true });
    if (dlqQueue) {
      await dlqQueue.obliterate({ force: true });
    }
    activeImportProgress = null;
    console.log('[Import] Queue obliterated');
    return { success: true };
  } catch (error) {
    console.error('[Import] Failed to obliterate queue:', error);
    return { success: false };
  }
}

/**
 * Gracefully shutdown
 */
export async function shutdownImportQueue(): Promise<void> {
  console.log('Shutting down import queue...');

  if (importWorker) {
    await importWorker.close();
    importWorker = null;
  }

  if (importQueue) {
    await importQueue.close();
    importQueue = null;
  }

  if (dlqQueue) {
    await dlqQueue.close();
    dlqQueue = null;
  }

  console.log('Import queue shutdown complete');
}
