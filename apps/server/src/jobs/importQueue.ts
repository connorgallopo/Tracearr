/**
 * Import Queue - BullMQ-based async import processing
 *
 * Provides reliable, resumable import processing with:
 * - Restart resilience (job state persisted in Redis)
 * - Cancellation support
 * - Progress tracking via WebSocket
 * - Checkpoint/resume on failure
 *
 * Supports Tautulli (for Plex), Jellystat and Playback Reporting (for Jellyfin/Emby), and tofa's
 * own watch history.
 */

import { randomUUID } from 'node:crypto';
import {
  DelayedError,
  Queue,
  UnrecoverableError,
  Worker,
  type Job,
  type ConnectionOptions,
} from 'bullmq';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { isMaintenance } from '../serverState.js';
import {
  REDIS_KEYS,
  assertNever,
  type TautulliImportProgress,
  type TautulliImportResult,
  type JellystatImportProgress,
  type JellystatImportResult,
  type PlaybackReportingImportProgress,
  type PlaybackReportingImportResult,
  type TofaImportProgress,
  type TofaImportResult,
} from '@tracearr/shared';
import {
  ImportInterruptedError,
  TautulliService,
  isFatalImportError,
  type ImportResumeState,
} from '../services/tautulli.js';
import { importJellystatBackup } from '../services/jellystat.js';
import {
  JellystatUploadMissingError,
  clearJellystatUploads,
  readJellystatUpload,
  removeJellystatUpload,
  sweepJellystatUploads,
} from '../services/import/jellystatUpload.js';
import { importPlaybackReporting } from '../services/playbackReporting.js';
import { importTofaHistory } from '../services/import/tofaHistory.js';
import { getCacheService, getPubSubService } from '../services/cache.js';
import { ServerHistoricalError } from '../services/liveServers.js';
import { isHttpStatus } from '../utils/http.js';
import { extendJobLock } from './lockUtils.js';
import {
  WORKER_DEFAULTS,
  addSingleton,
  checkpoint,
  registerQueue,
  registerWorker,
  yieldJob,
} from './jobSafety.js';
import { withSessionsCompressionPaused } from '../db/timescale.js';
import {
  acquireHeavyOpsLock,
  releaseHeavyOpsLock,
  extendHeavyOpsLock,
  startHeavyOpsLockHeartbeat,
  HEAVY_OPS_WAIT_INTERVAL_MS,
  type HeavyOpsLockHolder,
} from './heavyOpsLock.js';
import { hasPendingFirstSync } from './librarySyncQueue.js';

// Job data types
export interface TautulliImportJobData {
  type: 'tautulli';
  serverId: string;
  userId: string; // Audit trail - who initiated the import
  checkpoint?: number; // next page to fetch; written after every finished page
  resumeState?: ImportResumeState; // written with checkpoint; the finished pages' date range and failed pages
  overwriteFriendlyNames?: boolean; // Whether to overwrite existing friendly names
  includeStreamDetails?: boolean; // (BETA) Fetch detailed codec/bitrate info via additional API calls
  heldForFirstSync?: true; // See addImportAfterFirstSync
}

export interface JellystatImportJobData {
  type: 'jellystat';
  serverId: string;
  userId: string; // Audit trail - who initiated the import
  backupPath?: string; // Uploaded backup on disk, see services/import/jellystatUpload.ts
  backupJson?: string; // Jobs queued before 2.4.0 carry the file contents instead of a path
  enrichMedia: boolean; // Whether to enrich with metadata from Jellyfin/Emby
  updateStreamDetails?: boolean; // Whether to update existing records with stream/transcode data
  heldForFirstSync?: true; // See addImportAfterFirstSync
}

export interface PlaybackReportingImportJobData {
  type: 'playback-reporting';
  serverId: string;
  userId: string; // Audit trail - who initiated the import
  timezone: string;
  enrichMedia: boolean;
  importFullRange: boolean;
  heldForFirstSync?: true; // See addImportAfterFirstSync
}

export interface TofaImportJobData {
  type: 'tofa';
  serverId: string;
  userId: string; // Audit trail - who initiated the import
}

export type ImportJobData =
  | TautulliImportJobData
  | JellystatImportJobData
  | PlaybackReportingImportJobData
  | TofaImportJobData;

export type ImportJobResult =
  TautulliImportResult | JellystatImportResult | PlaybackReportingImportResult | TofaImportResult;

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
  type: ImportJobData['type'];
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

  connectionOptions = queueConnectionOptions(redisUrl);
  const bullPrefix = getBullPrefix();

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
  importQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[Import] Queue error:', err);
  });
  registerQueue(importQueue);

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
  dlqQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[Import] DLQ error:', err);
  });
  registerQueue(dlqQueue);

  console.log('Import queue initialized');
}

export type ImportProgressPayload =
  | TautulliImportProgress
  | JellystatImportProgress
  | PlaybackReportingImportProgress
  | TofaImportProgress;

function importProgressChannel(
  type: ImportJobData['type']
):
  | 'import:progress'
  | 'import:jellystat:progress'
  | 'import:playbackreporting:progress'
  | 'import:tofa:progress' {
  if (type === 'jellystat') return 'import:jellystat:progress';
  if (type === 'playback-reporting') return 'import:playbackreporting:progress';
  if (type === 'tofa') return 'import:tofa:progress';
  return 'import:progress';
}

/** An import's progress outside its run, every count at zero, in its own channel's shape */
function blankProgress(
  type: ImportJobData['type'],
  serverId: string,
  status: 'waiting' | 'retrying' | 'complete' | 'error',
  message: string
): ImportProgressPayload {
  const base = {
    serverId,
    status,
    processedRecords: 0,
    importedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message,
  };
  switch (type) {
    case 'jellystat':
      return {
        ...base,
        totalRecords: 0,
        filteredRecords: 0,
        enrichedRecords: 0,
      } satisfies JellystatImportProgress;
    case 'tofa':
      return {
        ...base,
        fetchedRecords: 0,
        duplicateRecords: 0,
        unknownUserRecords: 0,
        activeRecords: 0,
      } satisfies TofaImportProgress;
    case 'playback-reporting':
      return {
        ...base,
        totalRecords: 0,
        fetchedRecords: 0,
        duplicateRecords: 0,
        unknownUserRecords: 0,
        overlapRecords: 0,
        filteredRecords: 0,
        overlongRecords: 0,
        enrichedRecords: 0,
      } satisfies PlaybackReportingImportProgress;
    case 'tautulli':
      return {
        ...base,
        totalRecords: 0,
        fetchedRecords: 0,
        updatedRecords: 0,
        duplicateRecords: 0,
        unknownUserRecords: 0,
        activeSessionRecords: 0,
        currentPage: 0,
        totalPages: 0,
      } satisfies TautulliImportProgress;
    default:
      return assertNever(type);
  }
}

// Payload shape must match the importing job's channel, or its UI card never updates.
function buildWaitingProgress(
  type: ImportJobData['type'],
  serverId: string,
  waitingFor: HeavyOpsLockHolder
): ImportProgressPayload {
  return {
    ...blankProgress(
      type,
      serverId,
      'waiting',
      `Waiting for ${waitingFor.description} to complete...`
    ),
    waitingFor: {
      jobType: waitingFor.jobType,
      description: waitingFor.description,
      startedAt: waitingFor.startedAt,
    },
  };
}

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Unknown error';

/** Tells the owner's import panel that an import of this type failed */
export function publishImportFailed(
  type: ImportJobData['type'],
  serverId: string,
  error: unknown,
  jobId?: string
): void {
  void getPubSubService()?.publish(importProgressChannel(type), {
    ...blankProgress(type, serverId, 'error', `Import failed: ${errorMessage(error)}`),
    jobId,
  });
}

const importAttempts = (job: Job<ImportJobData>) => job.opts.attempts || 3;

/** Tells the owner's import panel that an attempt failed and the import runs again later */
function publishImportRetrying(job: Job<ImportJobData>, error: unknown): void {
  const retry = {
    attempt: job.attemptsMade,
    attempts: importAttempts(job),
    reason: errorMessage(error),
  };
  void getPubSubService()?.publish(importProgressChannel(job.data.type), {
    ...blankProgress(
      job.data.type,
      job.data.serverId,
      'retrying',
      `Attempt ${retry.attempt} of ${retry.attempts} failed, retrying: ${retry.reason}`
    ),
    retry,
    jobId: job.id,
  });
}

/** No retry can fix these: a rejected key, an unreadable answer, a server that takes no import */
function failsAtOnce(error: unknown): error is Error {
  return (
    error instanceof ServerHistoricalError ||
    error instanceof JellystatUploadMissingError ||
    isHttpStatus(error, 401, 403) ||
    (error instanceof Error && isFatalImportError(error))
  );
}

// Longer than the default lock: the synchronous JSON.parse of a large Jellystat upload blocks the lock renewer.
export const IMPORT_LOCK_DURATION_MS = 5 * 60_000;

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

  const bullPrefix = getBullPrefix();

  if (importQueue) {
    importQueue
      .getJobs(['active', 'waiting', 'delayed', 'prioritized'])
      .then((jobs) =>
        sweepJellystatUploads(
          new Set(
            jobs.flatMap((j) => (j.data.type === 'jellystat' ? [j.data.backupPath ?? ''] : []))
          )
        )
      )
      .then((removed) => {
        if (removed > 0) console.log(`[Import] Removed ${removed} orphaned Jellystat upload(s)`);
      })
      .catch((err: unknown) => {
        console.warn('[Import] Failed to sweep Jellystat uploads:', err);
      });
  }

  importWorker = new Worker<ImportJobData>(
    QUEUE_NAME,
    async (job: Job<ImportJobData>, _token?: string, signal?: AbortSignal) => {
      const startTime = Date.now();
      const jobDescription =
        job.data.type === 'tautulli'
          ? 'Tautulli import'
          : job.data.type === 'jellystat'
            ? 'Jellystat import'
            : job.data.type === 'tofa'
              ? 'tofa history import'
              : 'Playback Reporting import';
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
      // One token for this whole processor invocation - see heavyOpsLock.ts
      // for why job.id alone can't prove ownership across concurrent runs.
      const runToken = randomUUID();
      let lockHolder: HeavyOpsLockHolder | null;
      const pubSubService = getPubSubService();
      const MAX_WAIT_MS = 4 * 60 * 60 * 1000; // Max 4 hours wait
      let waitedMs = 0;

      while (
        (lockHolder = await acquireHeavyOpsLock('import', job.id!, jobDescription, runToken)) !==
        null
      ) {
        if (signal?.aborted) await yieldJob(job, job.token, 0);

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
          void pubSubService.publish(importProgressChannel(job.data.type), {
            ...buildWaitingProgress(job.data.type, job.data.serverId, lockHolder),
            jobId: job.id,
          });
        }

        console.log(
          `[Import] Job ${job.id} waiting for ${lockHolder.jobType} job: ${lockHolder.description}`
        );

        // Extend BullMQ job lock while waiting
        await extendJobLock(job, IMPORT_LOCK_DURATION_MS);

        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, HEAVY_OPS_WAIT_INTERVAL_MS));
        waitedMs += HEAVY_OPS_WAIT_INTERVAL_MS;

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

      // Backstop renewal independent of how often processImportJob itself calls extendHeavyOpsLock.
      const stopHeartbeat = startHeavyOpsLockHeartbeat(job.id!, runToken);
      try {
        const result = await withSessionsCompressionPaused(() => processImportJob(job, signal));
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.log(`[Import] Job ${job.id} completed in ${duration}s:`, result);
        return result;
      } catch (error) {
        const duration = Math.round((Date.now() - startTime) / 1000);
        if (error instanceof DelayedError) {
          console.log(
            `[Import] Job ${job.id} interrupted after ${duration}s; it resumes from its checkpoint`
          );
        } else {
          console.error(`[Import] Job ${job.id} failed after ${duration}s:`, error);
        }
        if (failsAtOnce(error)) throw new UnrecoverableError(error.message);
        throw error;
      } finally {
        stopHeartbeat();
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
      ...WORKER_DEFAULTS,
      lockDuration: IMPORT_LOCK_DURATION_MS,
      limiter: {
        max: 1,
        duration: 60000, // Max 1 new import per minute (prevents spam)
      },
    }
  );

  registerWorker(importWorker);

  // Handle stalled jobs
  importWorker.on('stalled', (jobId) => {
    console.warn(`[Import] Job ${jobId} stalled - will be retried`);
    activeImportProgress = null;
  });

  importWorker.on('completed', (job) => {
    if (job.data.type === 'jellystat') void removeJellystatUpload(job.data.backupPath);
    void getCacheService()
      ?.invalidatePattern(REDIS_KEYS.HISTORY_AGGREGATES('*'))
      .catch((err: unknown) => console.warn('[Import] Could not clear the history totals:', err));
  });

  // Handle job failures - notify frontend and move to DLQ if retries exhausted
  importWorker.on('failed', (job, error) => {
    if (!job) return;
    activeImportProgress = null;

    const exhausted = job.attemptsMade >= importAttempts(job);
    // BullMQ tells an unrecoverable error by its name too
    const unrecoverable =
      error instanceof UnrecoverableError || error.name === 'UnrecoverableError';
    if (!exhausted && !unrecoverable) {
      publishImportRetrying(job, error);
      return;
    }

    if (job.data.type === 'jellystat') void removeJellystatUpload(job.data.backupPath);
    publishImportFailed(job.data.type, job.data.serverId, error, job.id);

    if (exhausted) {
      console.error(`[Import] Job ${job.id} exhausted retries, moving to DLQ:`, error);
      if (dlqQueue) {
        void dlqQueue.add(`dlq-${job.data.type}`, job.data, {
          jobId: `dlq-${job.id}`,
        });
      }
    }
  });

  importWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[Import] Worker error:', error);
  });

  console.log('Import worker started');
}

/**
 * Process a single import job (routes to appropriate handler based on type)
 */
async function processImportJob(
  job: Job<ImportJobData>,
  signal: AbortSignal | undefined
): Promise<ImportJobResult> {
  if (job.data.type === 'jellystat') {
    return processJellystatImportJob(job as Job<JellystatImportJobData>);
  }
  if (job.data.type === 'playback-reporting') {
    return processPlaybackReportingImportJob(job as Job<PlaybackReportingImportJobData>);
  }
  if (job.data.type === 'tofa') {
    return processTofaImportJob(job as Job<TofaImportJobData>);
  }
  return processTautulliImportJob(job as Job<TautulliImportJobData>, signal);
}

/**
 * Process a Tautulli import job
 */
async function processTautulliImportJob(
  job: Job<TautulliImportJobData>,
  signal: AbortSignal | undefined
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
  let result: TautulliImportResult;
  try {
    result = await TautulliService.importHistory(serverId, pubSubService ?? undefined, onProgress, {
      overwriteFriendlyNames,
      startPage: job.data.checkpoint ?? 0,
      resumeState: job.data.resumeState,
      signal,
      onPageDone: (nextPage, resumeState) =>
        checkpoint(job, { checkpoint: nextPage, resumeState }, IMPORT_LOCK_DURATION_MS),
    });
  } catch (error) {
    if (error instanceof ImportInterruptedError) await yieldJob(job, job.token, 0);
    throw error;
  }

  // (BETA) Enrich sessions with detailed stream data
  if (includeStreamDetails) {
    console.log(`[Import] Starting stream details enrichment for server ${serverId}`);
    if (pubSubService) {
      await pubSubService.publish('import:progress', {
        serverId,
        status: 'enriching',
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
        message: '(BETA) Fetching detailed stream data...',
        jobId: job.id,
      } satisfies TautulliImportProgress & { jobId?: string });
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
      serverId,
      status: 'complete',
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
    } satisfies TautulliImportProgress & { jobId?: string });
  }

  return result;
}

/**
 * Process a Jellystat import job
 */
async function processJellystatImportJob(
  job: Job<JellystatImportJobData>
): Promise<JellystatImportResult> {
  const { serverId, enrichMedia, updateStreamDetails } = job.data;
  const pubSubService = getPubSubService();

  const backupJson = job.data.backupJson ?? (await readJellystatUpload(job.data.backupPath ?? ''));

  // Run the actual import
  const result = await importJellystatBackup(
    serverId,
    backupJson,
    enrichMedia,
    pubSubService ?? undefined,
    { updateStreamDetails, onProgress: (progress) => job.updateProgress(progress) }
  );

  // Publish final result
  if (pubSubService) {
    await pubSubService.publish('import:jellystat:progress', {
      serverId,
      status: 'complete',
      totalRecords: result.imported + result.updated + result.skipped + result.errors,
      processedRecords: result.imported + result.updated + result.skipped + result.errors,
      importedRecords: result.imported,
      skippedRecords: result.skipped,
      filteredRecords: result.filtered,
      errorRecords: result.errors,
      enrichedRecords: result.enriched,
      uncheckedRecords: result.unchecked,
      unlinkedEpisodeRecords: result.unlinkedEpisodes,
      vetoedRecords: result.vetoed,
      pluginUncheckedRecords: result.pluginUnchecked,
      overlongRecords: result.overlong,
      message: result.message,
      jobId: job.id,
    } satisfies JellystatImportProgress & { jobId?: string });
  }

  return result;
}

/**
 * Process a Playback Reporting import job
 */
async function processPlaybackReportingImportJob(
  job: Job<PlaybackReportingImportJobData>
): Promise<PlaybackReportingImportResult> {
  const { serverId, timezone, enrichMedia, importFullRange } = job.data;
  const pubSubService = getPubSubService();

  const result = await importPlaybackReporting(
    serverId,
    { timezone, enrichMedia, importFullRange },
    pubSubService ?? undefined,
    (progress) => job.updateProgress(progress)
  );

  if (pubSubService) {
    const total = result.imported + result.skipped + result.errors;
    const unknownUserRecords = result.skippedUsers?.reduce((sum, u) => sum + u.recordCount, 0) ?? 0;
    await pubSubService.publish('import:playbackreporting:progress', {
      serverId,
      status: 'complete',
      totalRecords: total,
      fetchedRecords: total,
      processedRecords: total,
      importedRecords: result.imported,
      skippedRecords: result.skipped,
      duplicateRecords: result.duplicates,
      unknownUserRecords,
      overlapRecords: result.overlap,
      filteredRecords: result.filtered,
      overlongRecords: result.overlong,
      errorRecords: result.errors,
      enrichedRecords: result.enriched,
      message: result.message,
      jobId: job.id,
    } satisfies PlaybackReportingImportProgress & { jobId?: string });
  }

  return result;
}

async function processTofaImportJob(job: Job<TofaImportJobData>): Promise<TofaImportResult> {
  const pubSubService = getPubSubService();
  const result = await importTofaHistory(
    job.data.serverId,
    pubSubService ?? undefined,
    (progress) => job.updateProgress(progress)
  );
  await pubSubService?.publish('import:tofa:progress', {
    ...blankProgress('tofa', job.data.serverId, 'complete', result.message),
    importedRecords: result.imported,
    skippedRecords: result.skipped,
    duplicateRecords: result.duplicates,
    errorRecords: result.errors,
    jobId: job.id,
  });
  return result;
}

function importInProgress(serverId: string, jobId: string): Error {
  return new Error(`Import already in progress for server ${serverId} (job ${jobId})`);
}

/**
 * Adds an import unless one of its type is already queued or running for the server. The read
 * checks before it cannot see a start made in the same moment; this refusal is atomic in Redis.
 */
async function addImport(
  queue: Queue<ImportJobData>,
  name: string,
  data: ImportJobData,
  opts?: { delay: number }
): Promise<string> {
  const { jobId, accepted } = await addSingleton(
    queue,
    name,
    data,
    `${data.type}-import-${data.serverId}`,
    opts
  );
  if (!accepted) throw importInProgress(data.serverId, jobId);
  return jobId;
}

// A sync still running after this long is not waited for: the import then reads the library as it stands
const HELD_IMPORT_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * Adds an import whose plays take their media, season and show keys from the library as they are
 * written, held like the tofa import while the server's first library sync is queued or running.
 * Plays written before it keep those keys empty.
 */
async function addImportAfterFirstSync(
  queue: Queue<ImportJobData>,
  name: string,
  data: TautulliImportJobData | JellystatImportJobData | PlaybackReportingImportJobData
): Promise<string> {
  if (!(await hasPendingFirstSync(data.serverId))) return addImport(queue, name, data);
  const jobId = await addImport(
    queue,
    name,
    { ...data, heldForFirstSync: true },
    { delay: HELD_IMPORT_MAX_WAIT_MS }
  );
  // A sync that completed before the add had nothing to release
  if (!(await hasPendingFirstSync(data.serverId))) {
    await promoteIfDelayed(await queue.getJob(jobId)).catch((err: unknown) => {
      console.warn(`[Import] Could not release held import ${jobId}:`, err);
    });
  }
  return jobId;
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
  if (existingJobId) throw importInProgress(serverId, existingJobId);

  const jobId = await addImportAfterFirstSync(importQueue, 'tautulli-import', {
    type: 'tautulli',
    serverId,
    userId,
    overwriteFriendlyNames,
    includeStreamDetails,
  });
  console.log(`[Import] Enqueued job ${jobId} for server ${serverId}`);
  return jobId;
}

interface ImportJobStatus<Result = ImportJobResult> {
  jobId: string;
  state: string;
  /** Queued held for the server's first library sync; see addImportAfterFirstSync */
  held: boolean;
  progress: number | object | null;
  result?: Result;
  failedReason?: string;
  createdAt?: number;
  finishedAt?: number;
}

/**
 * Get import job status
 */
export async function getImportStatus(jobId: string): Promise<ImportJobStatus | null> {
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
    held: isHeldImport(job),
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
    if (job.data.type === 'jellystat') await removeJellystatUpload(job.data.backupPath);
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
  backupPath: string,
  enrichMedia: boolean = true,
  updateStreamDetails: boolean = false
): Promise<string> {
  if (!importQueue) {
    throw new Error('Import queue not initialized');
  }

  // Check for existing active import for this server
  const existingJobId = await getActiveJellystatImportForServer(serverId);
  if (existingJobId) throw importInProgress(serverId, existingJobId);

  const jobId = await addImportAfterFirstSync(importQueue, 'jellystat-import', {
    type: 'jellystat',
    serverId,
    userId,
    backupPath,
    enrichMedia,
    updateStreamDetails,
  });
  console.log(`[Import] Enqueued Jellystat job ${jobId} for server ${serverId}`);
  return jobId;
}

/**
 * Get Jellystat import job status (alias for getImportStatus with Jellystat-specific typing)
 */
export async function getJellystatImportStatus(
  jobId: string
): Promise<ImportJobStatus<JellystatImportResult> | null> {
  return getImportStatus(jobId) as Promise<ImportJobStatus<JellystatImportResult> | null>;
}

/**
 * Cancel a Jellystat import job (alias for cancelImport)
 */
export async function cancelJellystatImport(jobId: string): Promise<boolean> {
  return cancelImport(jobId);
}

// ==========================================================================
// Playback Reporting-Specific Functions
// ==========================================================================

export async function getActivePlaybackReportingImportForServer(
  serverId: string
): Promise<string | null> {
  if (!importQueue) {
    return null;
  }

  const activeJobs = await importQueue.getJobs(['active', 'waiting', 'delayed']);
  const existingJob = activeJobs.find(
    (j) => j.data.type === 'playback-reporting' && j.data.serverId === serverId
  );

  return existingJob?.id ?? null;
}

export async function enqueuePlaybackReportingImport(
  serverId: string,
  userId: string,
  timezone: string,
  enrichMedia: boolean,
  importFullRange: boolean
): Promise<string> {
  if (!importQueue) {
    throw new Error('Import queue not initialized');
  }

  const existingJobId = await getActivePlaybackReportingImportForServer(serverId);
  if (existingJobId) throw importInProgress(serverId, existingJobId);

  const jobId = await addImportAfterFirstSync(importQueue, 'playback-reporting-import', {
    type: 'playback-reporting',
    serverId,
    userId,
    timezone,
    enrichMedia,
    importFullRange,
  });
  console.log(`[Import] Enqueued Playback Reporting job ${jobId} for server ${serverId}`);
  return jobId;
}

// ==========================================================================
// tofa-Specific Functions
// ==========================================================================

export async function getActiveTofaImportForServer(serverId: string): Promise<string | null> {
  if (!importQueue) return null;
  const activeJobs = await importQueue.getJobs(['active', 'waiting', 'delayed']);
  return activeJobs.find((j) => j.data.type === 'tofa' && j.data.serverId === serverId)?.id ?? null;
}

export async function enqueueTofaImport(serverId: string, userId: string): Promise<string> {
  if (!importQueue) throw new Error('Import queue not initialized');

  const existingJobId = await getActiveTofaImportForServer(serverId);
  if (existingJobId) throw importInProgress(serverId, existingJobId);

  const jobId = await addImport(importQueue, 'tofa-import', { type: 'tofa', serverId, userId });
  console.log(`[Import] Enqueued tofa history job ${jobId} for server ${serverId}`);
  return jobId;
}

const heldImportId = (serverId: string) => `held-import-${serverId}`;

const wasHeldImport = (job: Job<ImportJobData>) =>
  job.id === heldImportId(job.data.serverId) ||
  ('heldForFirstSync' in job.data && job.data.heldForFirstSync === true);

// Once a held import has run, a delayed state is a retry backoff, not the hold
const isHeldImport = (job: Job<ImportJobData>) => !job.processedOn && wasHeldImport(job);

async function promoteIfDelayed(job: Job<ImportJobData> | undefined): Promise<void> {
  if (job && (await job.isDelayed())) await job.promote();
}

async function heldImportsOf(serverId: string, held = isHeldImport): Promise<Job<ImportJobData>[]> {
  const delayed = (await importQueue?.getJobs(['delayed'])) ?? [];
  return delayed.filter((job) => job.data.serverId === serverId && held(job));
}

/**
 * Queues the history import of a server just added, held until a library sync of the server
 * ends, so its plays resolve against the library. Queued at once, an import asked for meanwhile
 * finds it and is refused.
 */
export async function holdTofaImport(serverId: string): Promise<void> {
  if (!importQueue) throw new Error('Import queue not initialized');
  await importQueue.add(
    'tofa-import',
    { type: 'tofa', serverId, userId: 'system' },
    { jobId: heldImportId(serverId), delay: HELD_IMPORT_MAX_WAIT_MS }
  );
  console.log(`[Import] Held tofa history import for server ${serverId}`);
}

/** Runs the server's held imports now: a library sync of it completed. */
export async function releaseHeldImport(serverId: string): Promise<void> {
  await Promise.all((await heldImportsOf(serverId)).map(promoteIfDelayed));
}

function isImportProgress(value: unknown): value is ImportProgressPayload {
  return (
    typeof value === 'object' && value !== null && 'status' in value && 'importedRecords' in value
  );
}

function isImportResult(value: unknown): value is ImportJobResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    value.success === true &&
    'imported' in value
  );
}

/** Jobs kept from older versions record a failed import as a completed job with success: false */
function storedFailure(value: unknown): string | null {
  return typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    value.success === false &&
    'message' in value &&
    typeof value.message === 'string'
    ? value.message
    : null;
}

/**
 * The server's latest import of this type, held or started by the owner, or null when it has
 * none still kept. A finished one is told by its result, which the job stores as it completes.
 */
export async function getLatestImport(
  type: ImportJobData['type'],
  serverId: string
): Promise<{
  held: boolean;
  state: string;
  progress: ImportProgressPayload | null;
  result: ImportJobResult | null;
  failedReason: string | null;
  finishedAt: number | null;
  attemptsMade: number;
  attempts: number;
} | null> {
  if (!importQueue) return null;
  const jobs = await importQueue.getJobs([
    'active',
    'waiting',
    'delayed',
    'prioritized',
    'completed',
    'failed',
  ]);
  const latest = jobs
    .filter((job) => job.data.type === type && job.data.serverId === serverId)
    .reduce<Job<ImportJobData> | undefined>(
      (newest, job) => (newest && newest.timestamp >= job.timestamp ? newest : job),
      undefined
    );
  if (!latest) return null;
  // Tautulli keeps a percentage on the job; its counts live in this process while it runs
  const running = activeImportProgress;
  const cached = running && running.jobId === latest.id ? running.progress : null;
  return {
    held: isHeldImport(latest),
    state: await latest.getState(),
    progress: isImportProgress(latest.progress) ? latest.progress : cached,
    result: isImportResult(latest.returnvalue) ? latest.returnvalue : null,
    failedReason: latest.failedReason ?? storedFailure(latest.returnvalue),
    finishedAt: latest.finishedOn ?? null,
    attemptsMade: latest.attemptsMade,
    attempts: importAttempts(latest),
  };
}

/** Removes the server's held imports: the server is gone or no longer live. */
export async function dropHeldImport(serverId: string): Promise<void> {
  for (const job of await heldImportsOf(serverId, wasHeldImport)) {
    await job.remove();
    if (job.data.type === 'jellystat') await removeJellystatUpload(job.data.backupPath);
    console.log(`[Import] Dropped the held ${job.data.type} import for server ${serverId}`);
  }
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
    type: ImportJobData['type'];
    serverId: string;
    state: string;
    progress: number | object | null;
    createdAt: number;
    held: boolean;
    attemptsMade: number;
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
        held: isHeldImport(job),
        attemptsMade: job.attemptsMade,
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
    await clearJellystatUploads();
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
