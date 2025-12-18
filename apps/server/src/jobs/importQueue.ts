/**
 * Import Queue - BullMQ-based async import processing
 *
 * Provides reliable, resumable Tautulli import with:
 * - Restart resilience (job state persisted in Redis)
 * - Cancellation support
 * - Progress tracking via WebSocket
 * - Checkpoint/resume on failure
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { TautulliImportProgress, TautulliImportResult } from '@tracearr/shared';
import { TautulliService } from '../services/tautulli.js';
import { getPubSubService } from '../services/cache.js';

// Job data types
export interface ImportJobData {
  type: 'tautulli';
  serverId: string;
  userId: string; // Audit trail - who initiated the import
  checkpoint?: number; // Resume from this page (for future use)
}

export type ImportJobResult = TautulliImportResult;

// Queue configuration
const QUEUE_NAME = 'imports';
const DLQ_NAME = 'imports-dlq';

// Connection and instances
let connectionOptions: ConnectionOptions | null = null;
let importQueue: Queue<ImportJobData> | null = null;
let importWorker: Worker<ImportJobData> | null = null;
let dlqQueue: Queue<ImportJobData> | null = null;

/**
 * Initialize the import queue with Redis connection
 */
export function initImportQueue(redisUrl: string): void {
  if (importQueue) {
    console.log('Import queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };

  importQueue = new Queue<ImportJobData>(QUEUE_NAME, {
    connection: connectionOptions,
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
      removeOnFail: false, // Keep failed jobs for investigation
    },
  });

  dlqQueue = new Queue<ImportJobData>(DLQ_NAME, {
    connection: connectionOptions,
    defaultJobOptions: {
      removeOnComplete: false,
      removeOnFail: false,
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

  importWorker = new Worker<ImportJobData>(
    QUEUE_NAME,
    async (job: Job<ImportJobData>) => {
      const startTime = Date.now();
      console.log(`[Import] Starting job ${job.id} for server ${job.data.serverId}`);

      try {
        const result = await processImportJob(job);
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.log(`[Import] Job ${job.id} completed in ${duration}s:`, result);
        return result;
      } catch (error) {
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.error(`[Import] Job ${job.id} failed after ${duration}s:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      concurrency: 1, // Only 1 import at a time per worker
      // Large imports (300k+ records) can take hours - extend lock to prevent stalled job detection
      lockDuration: 5 * 60 * 1000, // 5 minutes (default is 30s)
      stalledInterval: 5 * 60 * 1000, // Check for stalled jobs every 5 minutes
      limiter: {
        max: 1,
        duration: 60000, // Max 1 new import per minute (prevents spam)
      },
    }
  );

  // Handle job failures - notify frontend and move to DLQ if retries exhausted
  importWorker.on('failed', (job, error) => {
    if (!job) return;

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
 * Process a single import job
 */
async function processImportJob(job: Job<ImportJobData>): Promise<ImportJobResult> {
  const { serverId } = job.data;
  const pubSubService = getPubSubService();

  // Progress callback to update job and publish to WebSocket
  const onProgress = async (progress: TautulliImportProgress) => {
    // Update BullMQ job progress (0-100)
    const percent =
      progress.totalRecords > 0
        ? Math.round((progress.processedRecords / progress.totalRecords) * 100)
        : 0;
    await job.updateProgress(percent);

    // Extend lock to prevent stalled job detection during long imports
    // This is critical for large imports (300k+ records) that can take hours
    try {
      await job.extendLock(job.token ?? '', 5 * 60 * 1000); // Extend by 5 minutes
    } catch {
      // Lock extension can fail if job was already moved to another state
      console.warn(`[Import] Failed to extend lock for job ${job.id}`);
    }

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
    onProgress
  );

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
export async function enqueueImport(serverId: string, userId: string): Promise<string> {
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
