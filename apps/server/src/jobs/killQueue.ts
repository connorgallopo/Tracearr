/**
 * Kill Queue - BullMQ-based delayed stream termination with re-verification
 *
 * kill_stream actions enqueue here instead of terminating inline. delay_seconds
 * (0 if unset) becomes the sustain window: the worker waits that long, then
 * calls reverifyKillCondition to check the match still holds against current
 * state before actually terminating. This closes the gap where a rule match
 * and the kill itself used to happen in the same instant with no chance for
 * the underlying condition to have already cleared.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { type Action } from '@tracearr/shared';
import {
  getActionExecutorDeps,
  cooldownTargetId,
  type ActionResult,
} from '../services/automations/executors/index.js';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { WORKER_DEFAULTS, registerQueue, registerWorker } from './jobSafety.js';
import { isMaintenance } from '../serverState.js';
import {
  reverifyKillCondition,
  type ReverifyKillConditionResult,
} from '../services/automations/reverify.js';
import { storeActionResults } from '../services/automations/v2Integration.js';

const QUEUE_NAME = 'kill-stream';

export interface KillJobData {
  /** Session actually terminated by this job. Each resolved target of a
   *  multi-target match gets its own job keyed by this id. */
  targetSessionId: string;
  /** Session whose match produced this kill. reverify rebuilds the evaluation
   *  context from THIS session (not the target) so the re-check reproduces the
   *  match live evaluation made, even when the target is a sibling
   *  session/server. Equals targetSessionId for target: 'triggering'. */
  triggeringSessionId: string;
  serverId: string;
  ruleId: string;
  /** Violation the kill_stream match created; null when the match created no violation. */
  violationId: string | null;
  message?: string;
  /**
   * Identity's server_user ids as captured at match time (enforceAcrossServers
   * rules only). Informational/audit only - reverifyKillCondition re-derives
   * current membership rather than trusting this snapshot, since it can go
   * stale during the delay window before the job fires.
   */
  identityServerUserIds?: string[];
  /** Rule's cooldown_minutes at match time; arms only when the outcome is 'killed'. */
  cooldownMinutes?: number;
  /** Triggering session's owner - cooldown keys off the account that matched
   *  the rule, not necessarily the target session's owner (enforceAcrossServers
   *  can target sibling-account sessions). */
  triggeringServerUserId?: string;
  /** Both sessions' starts as ISO strings, so reverify reads each from its own chunks. */
  targetStartedAt?: string;
  triggeringStartedAt?: string;
}

let connectionOptions: ConnectionOptions | null = null;
let killQueue: Queue<KillJobData> | null = null;
let killWorker: Worker<KillJobData> | null = null;

/**
 * Initialize the kill queue with a Redis connection.
 */
export function initKillQueue(redisUrl: string): void {
  if (killQueue) {
    console.log('[KillQueue] Queue already initialized');
    return;
  }

  connectionOptions = queueConnectionOptions(redisUrl);
  const bullPrefix = getBullPrefix();

  killQueue = new Queue<KillJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000, // 2s, 4s, 8s
      },
      removeOnComplete: {
        count: 500,
        age: 24 * 60 * 60, // 24h
      },
      removeOnFail: {
        count: 500,
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
  });
  killQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[KillQueue] Queue error:', err);
  });
  registerQueue(killQueue);

  console.log('[KillQueue] Queue initialized');
}

/**
 * Start the kill worker to process queued jobs.
 */
export function startKillWorker(): void {
  if (!connectionOptions) {
    throw new Error('Kill queue not initialized. Call initKillQueue first.');
  }

  if (killWorker) {
    console.log('[KillQueue] Worker already running');
    return;
  }

  const bullPrefix = getBullPrefix();

  killWorker = new Worker<KillJobData>(
    QUEUE_NAME,
    async (job: Job<KillJobData>) => {
      const startTime = Date.now();
      try {
        await processKillJob(job);
        console.log(`[KillQueue] Job ${job.id} processed in ${Date.now() - startTime}ms`);
      } catch (error) {
        console.error(`[KillQueue] Job ${job.id} failed after ${Date.now() - startTime}ms:`, error);
        throw error; // Re-throw to trigger BullMQ retry
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 5,
      ...WORKER_DEFAULTS,
    }
  );
  registerWorker(killWorker);

  killWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[KillQueue] Worker error:', error);
  });

  console.log('[KillQueue] Worker started');
}

/** Map a reverify outcome to the ActionResult shape storeActionResults persists. */
function outcomeToActionResult(result: ReverifyKillConditionResult): ActionResult {
  const action: Action = { type: 'kill_stream' };

  if (result.outcome === 'killed') {
    return { action, success: true, skipped: false, message: 'killed' };
  }
  if (result.outcome === 'failed') {
    return { action, success: false, message: result.error ?? 'failed' };
  }
  return { action, success: true, skipped: true, skipReason: result.skipReason ?? result.outcome };
}

/**
 * Process a single kill job: re-verify against current state, terminate if
 * still warranted, and persist the outcome against the originating violation.
 */
export async function processKillJob(job: Job<KillJobData>): Promise<void> {
  const {
    triggeringSessionId,
    targetSessionId,
    serverId,
    ruleId,
    violationId,
    message,
    cooldownMinutes,
    triggeringServerUserId,
    targetStartedAt,
    triggeringStartedAt,
  } = job.data;

  // attemptsMade counts completed failed attempts (0 on a job's first run), so
  // > 0 means a prior run of this exact job already got past reverify - only
  // relevant for the idempotency check inside reverifyKillCondition.
  const isRetry = job.attemptsMade > 0;

  const result = await reverifyKillCondition({
    triggeringSessionId,
    targetSessionId,
    serverId,
    ruleId,
    violationId,
    message,
    isRetry,
    targetStartedAt,
    triggeringStartedAt,
  });

  // A transient termination failure must consume the configured retries instead
  // of completing the job. On any attempt but the last, re-throw WITHOUT storing
  // so BullMQ retries and no failed row is written yet; on the final attempt,
  // fall through and store exactly one 'failed' row so a permanently failing
  // kill ends with a single record rather than one per attempt.
  if (result.outcome === 'failed') {
    const maxAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade >= maxAttempts - 1;
    if (!isFinalAttempt) {
      throw new Error(result.error ?? 'Kill termination failed');
    }
  }

  // Arm before storeActionResults so a cooldown write failure doesn't leave a
  // 'killed' row on record without the cooldown actually active.
  if (
    result.outcome === 'killed' &&
    cooldownMinutes &&
    cooldownMinutes > 0 &&
    triggeringServerUserId
  ) {
    await getActionExecutorDeps().setCooldown(
      ruleId,
      cooldownTargetId(ruleId, triggeringServerUserId, 'kill_stream'),
      cooldownMinutes
    );
  }

  await storeActionResults(violationId, ruleId, [outcomeToActionResult(result)]);
}

// Wall-clock bucket (ms) for the null-violation fallback jobId. Two enqueues in
// the same bucket dedupe (the intended collapse of a match re-enqueued across
// poll ticks within the sustain window); a later independent match on the same
// rule+session lands in a new bucket and gets a distinct id, so it is not
// swallowed by dedup against a still-retained completed job (removeOnComplete
// keeps completed jobs up to 24h).
const JOBID_BUCKET_MS = 10 * 60 * 1000;

function buildJobId(
  violationId: string | null,
  targetSessionId: string,
  ruleId: string,
  nowMs: number
): string {
  // BullMQ rejects a custom jobId containing ':' unless it splits into exactly
  // three segments, so every branch keeps exactly two colons and packs any
  // extra keys with underscores. Ids (UUIDs) never contain ':'.
  if (violationId) return `kill:${violationId}:${targetSessionId}`;
  const bucket = Math.floor(nowMs / JOBID_BUCKET_MS);
  return `kill:${targetSessionId}:rule_${ruleId}_${bucket}`;
}

/**
 * Enqueue a kill for delayed, re-verified termination.
 * Returns the job id when a job was created or already exists (BullMQ dedupes a
 * repeat jobId server-side and returns the existing job), or undefined when the
 * queue is not initialized and the kill was dropped.
 */
export async function enqueueKill(
  data: KillJobData,
  delaySeconds: number
): Promise<string | undefined> {
  if (!killQueue) {
    console.error('[KillQueue] Queue not initialized, dropping kill job');
    return undefined;
  }

  const jobId = buildJobId(data.violationId, data.targetSessionId, data.ruleId, Date.now());

  const job = await killQueue.add('kill', data, {
    jobId,
    delay: Math.max(0, delaySeconds) * 1000,
  });

  return job.id;
}

/**
 * Gracefully shut down the kill queue and worker.
 */
export async function shutdownKillQueue(): Promise<void> {
  console.log('[KillQueue] Shutting down...');

  if (killWorker) {
    await killWorker.close();
    killWorker = null;
  }

  if (killQueue) {
    await killQueue.close();
    killQueue = null;
  }

  connectionOptions = null;

  console.log('[KillQueue] Shutdown complete');
}
