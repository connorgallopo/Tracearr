/**
 * Watch Sync Queue - BullMQ-based watch status synchronization
 *
 * Provides reliable, resumable watch sync job processing with:
 * - Restart resilience (job state persisted in Redis)
 * - Progress tracking via WebSocket
 * - Scheduled recurring syncs
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { WatchSyncProgress, WatchSyncResult } from '@tracearr/shared';
import { WS_EVENTS } from '@tracearr/shared';
import { watchSyncService } from '../services/watchSync/index.js';
import { getPubSubService } from '../services/cache.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { watchSyncConfigs } from '../db/schema.js';

// Job data types
export interface WatchSyncJobData {
  configId: string;
  userId: string; // Who triggered it
  manual?: boolean;
}

// Queue configuration
const QUEUE_NAME = 'watch-sync';

// Connection and instances
let connectionOptions: ConnectionOptions | null = null;
let watchSyncQueue: Queue<WatchSyncJobData> | null = null;
let watchSyncWorker: Worker<WatchSyncJobData> | null = null;

// Track active job state
let activeJobProgress: WatchSyncProgress | null = null;

/**
 * Initialize the watch sync queue with Redis connection
 */
export function initWatchSyncQueue(redisUrl: string): void {
  if (watchSyncQueue) {
    console.log('Watch sync queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };

  watchSyncQueue = new Queue<WatchSyncJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    defaultJobOptions: {
      attempts: 1, // Watch sync jobs should not retry automatically
      removeOnComplete: {
        count: 100, // Keep last 100 completed jobs
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: false, // Keep failed jobs for investigation
    },
  });

  console.log('Watch sync queue initialized');
}

/**
 * Start the watch sync worker to process queued jobs
 */
export function startWatchSyncWorker(): void {
  if (!connectionOptions) {
    throw new Error('Watch sync queue not initialized. Call initWatchSyncQueue first.');
  }

  if (watchSyncWorker) {
    console.log('Watch sync worker already running');
    return;
  }

  watchSyncWorker = new Worker<WatchSyncJobData>(
    QUEUE_NAME,
    async (job: Job<WatchSyncJobData>) => {
      const startTime = Date.now();
      console.log(`[WatchSync] Starting job ${job.id} (config: ${job.data.configId})`);

      try {
        const result = await processWatchSyncJob(job);
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.log(`[WatchSync] Job ${job.id} completed in ${duration}s:`, result);
        return result;
      } catch (error) {
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.error(`[WatchSync] Job ${job.id} failed after ${duration}s:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      concurrency: 1, // Only 1 watch sync job at a time
      lockDuration: 30 * 60 * 1000, // 30 minutes (syncs can take a while with large libraries)
      stalledInterval: 30 * 60 * 1000, // Check for stalled jobs every 30 minutes
    }
  );

  // Handle job failures
  watchSyncWorker.on('failed', (job, error) => {
    if (!job) return;
    activeJobProgress = null;

    const pubSubService = getPubSubService();
    if (pubSubService) {
      void pubSubService.publish(WS_EVENTS.WATCH_SYNC_PROGRESS, {
        status: 'error',
        configId: job.data.configId,
        dryRun: false,
        sourceServer: '',
        targetServer: '',
        totalItems: 0,
        processedItems: 0,
        syncedItems: 0,
        skippedItems: 0,
        errorCount: 1,
        message: `Job failed: ${error?.message || 'Unknown error'}`,
      });
    }
  });

  watchSyncWorker.on('error', (error) => {
    console.error('[WatchSync] Worker error:', error);
  });

  console.log('Watch sync worker started');
}

/**
 * Process a watch sync job
 */
async function processWatchSyncJob(job: Job<WatchSyncJobData>): Promise<WatchSyncResult> {
  const pubSubService = getPubSubService();

  // Get the sync config
  const config = await watchSyncService.getConfig(job.data.configId);
  if (!config) {
    throw new Error(`Watch sync config ${job.data.configId} not found`);
  }

  // Run the sync with progress callback
  const result = await watchSyncService.syncConfig(config, (progress) => {
    activeJobProgress = progress;

    // Broadcast progress via WebSocket
    if (pubSubService) {
      void pubSubService.publish(WS_EVENTS.WATCH_SYNC_PROGRESS, progress);
    }

    // Update job progress percentage
    if (progress.totalItems > 0) {
      const percent = Math.round((progress.processedItems / progress.totalItems) * 100);
      void job.updateProgress(percent);
    }
  });

  activeJobProgress = null;
  return result;
}

/**
 * Get current watch sync progress (if any)
 * Also checks queue for waiting/active jobs even if progress callback hasn't fired yet
 */
export async function getWatchSyncProgress(): Promise<WatchSyncProgress | null> {
  // If we have active progress from the sync callback, return it
  if (activeJobProgress) {
    return activeJobProgress;
  }

  // Otherwise check if there are any active or waiting jobs in the queue
  if (!watchSyncQueue) {
    return null;
  }

  const activeJobs = await watchSyncQueue.getJobs(['active', 'waiting']);
  if (activeJobs.length === 0) {
    return null;
  }

  // Get the first active/waiting job
  const job = activeJobs[0];
  if (!job) {
    return null;
  }

  const state = await job.getState();

  // Return a "pending" progress object so UI knows something is queued/starting
  return {
    status: state === 'active' ? 'fetching_source' : 'idle',
    configId: job.data.configId,
    dryRun: false, // Will be updated when actual progress starts
    sourceServer: 'Loading...',
    targetServer: 'Loading...',
    totalItems: 0,
    processedItems: 0,
    syncedItems: 0,
    skippedItems: 0,
    errorCount: 0,
    message:
      state === 'active'
        ? 'Starting sync...'
        : `Sync queued (position ${activeJobs.indexOf(job) + 1})`,
  };
}

/**
 * Enqueue a watch sync job (manual trigger)
 * Uses a fixed jobId per config for atomic deduplication at the Redis level
 */
export async function enqueueWatchSync(configId: string, userId: string): Promise<string> {
  if (!watchSyncQueue) {
    throw new Error('Watch sync queue not initialized');
  }

  // Use a deterministic jobId - BullMQ will reject if a job with this ID already exists
  const jobId = `watch-sync-manual-${configId}`;

  try {
    const job = await watchSyncQueue.add(
      `watch-sync-${configId}`,
      {
        configId,
        userId,
        manual: true,
      },
      {
        jobId,
      }
    );

    console.log(`[WatchSync] Enqueued manual job ${job.id} (config: ${configId})`);
    return job.id ?? jobId;
  } catch (error) {
    // BullMQ throws when job with same ID already exists
    if (error instanceof Error && error.message.includes('Job with id')) {
      throw new Error('A sync job for this config is already in progress');
    }
    throw error;
  }
}

/**
 * Schedule recurring watch sync for a config
 */
export async function scheduleRecurringWatchSync(
  configId: string,
  intervalMinutes: number
): Promise<void> {
  if (!watchSyncQueue) {
    throw new Error('Watch sync queue not initialized');
  }

  // Remove any existing repeatable job for this config
  await cancelScheduledSync(configId);

  // Add a new repeatable job
  const repeatJobKey = `watch-sync-repeat-${configId}`;
  await watchSyncQueue.add(
    repeatJobKey,
    {
      configId,
      userId: 'system',
      manual: false,
    },
    {
      repeat: {
        every: intervalMinutes * 60 * 1000, // Convert to milliseconds
      },
      jobId: repeatJobKey,
    }
  );

  console.log(
    `[WatchSync] Scheduled recurring sync for config ${configId} every ${intervalMinutes} minutes`
  );
}

/**
 * Cancel scheduled sync for a config
 */
export async function cancelScheduledSync(configId: string): Promise<void> {
  if (!watchSyncQueue) {
    return;
  }

  const repeatJobKey = `watch-sync-repeat-${configId}`;

  // Remove the repeatable job
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const repeatableJobs = await watchSyncQueue.getRepeatableJobs();
  const existingJob = repeatableJobs.find((j) => j.key.includes(repeatJobKey));
  if (existingJob) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    await watchSyncQueue.removeRepeatableByKey(existingJob.key);
    console.log(`[WatchSync] Cancelled scheduled sync for config ${configId}`);
  }
}

/**
 * Initialize scheduled syncs for all enabled configs
 */
export async function initScheduledSyncs(): Promise<void> {
  if (!watchSyncQueue) {
    throw new Error('Watch sync queue not initialized');
  }

  // Get all enabled configs
  const configs = await db.query.watchSyncConfigs.findMany({
    where: eq(watchSyncConfigs.enabled, true),
  });

  for (const config of configs) {
    await scheduleRecurringWatchSync(config.id, config.intervalMinutes);
  }

  console.log(`[WatchSync] Initialized scheduled syncs for ${configs.length} configs`);
}

/**
 * Get watch sync job status
 */
export async function getWatchSyncJobStatus(jobId: string): Promise<{
  jobId: string;
  state: string;
  progress: number | object | null;
  result?: WatchSyncResult;
  failedReason?: string;
  createdAt?: number;
  finishedAt?: number;
} | null> {
  if (!watchSyncQueue) {
    return null;
  }

  const job = await watchSyncQueue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  const progress = job.progress;

  return {
    jobId: job.id ?? jobId,
    state,
    progress: typeof progress === 'number' || typeof progress === 'object' ? progress : null,
    result: job.returnvalue as WatchSyncResult | undefined,
    failedReason: job.failedReason,
    createdAt: job.timestamp,
    finishedAt: job.finishedOn,
  };
}

/**
 * Get queue statistics
 */
export async function getWatchSyncQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
} | null> {
  if (!watchSyncQueue) {
    return null;
  }

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    watchSyncQueue.getWaitingCount(),
    watchSyncQueue.getActiveCount(),
    watchSyncQueue.getCompletedCount(),
    watchSyncQueue.getFailedCount(),
    watchSyncQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Get recent job history
 */
export async function getWatchSyncJobHistory(limit: number = 10): Promise<
  Array<{
    jobId: string;
    configId: string;
    state: string;
    manual: boolean;
    createdAt: number;
    finishedAt?: number;
    result?: WatchSyncResult;
  }>
> {
  if (!watchSyncQueue) {
    return [];
  }

  const jobs = await watchSyncQueue.getJobs(['completed', 'failed'], 0, Math.max(limit - 1, 0));

  // Sort by finishedOn (most recent first)
  const sortedJobs = jobs.sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0));

  return sortedJobs.map((job) => ({
    jobId: job.id ?? 'unknown',
    configId: job.data.configId,
    state: job.finishedOn ? (job.failedReason ? 'failed' : 'completed') : 'unknown',
    manual: job.data.manual ?? false,
    createdAt: job.timestamp ?? 0,
    finishedAt: job.finishedOn,
    result: job.returnvalue as WatchSyncResult | undefined,
  }));
}

/**
 * Gracefully shutdown
 */
export async function shutdownWatchSyncQueue(): Promise<void> {
  console.log('Shutting down watch sync queue...');

  if (watchSyncWorker) {
    await watchSyncWorker.close();
    watchSyncWorker = null;
  }

  if (watchSyncQueue) {
    await watchSyncQueue.close();
    watchSyncQueue = null;
  }

  console.log('Watch sync queue shutdown complete');
}
