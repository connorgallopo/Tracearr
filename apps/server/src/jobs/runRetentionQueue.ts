/**
 * Run Retention Queue - BullMQ-based daily purge of aged automation runs
 *
 * Completed runs age out on their kind's window (notification 30 days, policy
 * 365) unless the automation overrides it with retention_days. Account-keyed
 * completed runs are the one exemption, for both kinds: inactivity dedup blocks
 * on any row for user + automation, and account.inactive_for notifications carry
 * a constant edgeKey, so deleting the row re-fires the automation every cycle.
 * Session, server and install rows all carry a moving edge, so they purge.
 *
 * Non-completed runs are diagnostics, written per candidate automation per
 * event: they go at 30 days flat whatever the kind, the override or the session
 * binding says. Nothing gates on them, so purging one can re-arm nothing, and
 * the hourly account sweep writes them by the million.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { eq, sql, type SQL } from 'drizzle-orm';
import {
  AUTOMATION_KINDS,
  NEWSLETTER_SEND_RETENTION_DAYS,
  NEWSLETTER_SNAPSHOT_RETENTION_DAYS,
  RETENTION_DEFAULTS,
  TIME_MS,
  type AutomationKind,
} from '@tracearr/shared';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { isMaintenance } from '../serverState.js';
import { db } from '../db/client.js';
import { automations } from '../db/schema.js';
import { recomputeIdentityAggregatesForServerUser } from '../services/userService.js';

const QUEUE_NAME = 'run-retention';
// Pre-rename queue; its repeatable survives the upgrade with nothing to consume it.
const LEGACY_QUEUE_NAME = 'violation-retention';

const PURGE_INTERVAL_MS = TIME_MS.DAY;
// Server policy, not a user-facing default: non-completed runs age out on this window whatever the kind.
const DIAGNOSTIC_RETENTION_DAYS = 30;
// Delete in batches so the first run after upgrade cannot hold a long lock
const DELETE_BATCH_SIZE = 5000;

interface RunRetentionJobData {
  type: 'purge';
}

let connectionOptions: ConnectionOptions | null = null;
let retentionQueue: Queue<RunRetentionJobData> | null = null;
let retentionWorker: Worker<RunRetentionJobData> | null = null;

/**
 * Initialize the run retention queue with Redis connection
 */
export function initRunRetentionQueue(redisUrl: string): void {
  if (retentionQueue) {
    console.log('[RunRetention] Queue already initialized');
    return;
  }

  connectionOptions = queueConnectionOptions(redisUrl);
  const bullPrefix = getBullPrefix();

  retentionQueue = new Queue<RunRetentionJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000,
      },
      removeOnComplete: {
        count: 20,
        age: 7 * 24 * 60 * 60,
      },
      removeOnFail: {
        count: 50,
        age: 30 * 24 * 60 * 60,
      },
    },
  });
  retentionQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[RunRetention] Queue error:', err);
  });

  console.log('[RunRetention] Queue initialized');
}

/**
 * Start the run retention worker
 */
export function startRunRetentionWorker(): void {
  if (!connectionOptions) {
    throw new Error('Run retention queue not initialized. Call initRunRetentionQueue first.');
  }

  if (retentionWorker) {
    console.log('[RunRetention] Worker already running');
    return;
  }

  const bullPrefix = getBullPrefix();

  retentionWorker = new Worker<RunRetentionJobData>(
    QUEUE_NAME,
    async (job: Job<RunRetentionJobData>) => {
      const startTime = Date.now();
      try {
        const result = await processRunRetention();
        console.log(
          `[RunRetention] Job ${job.id} completed in ${Date.now() - startTime}ms ` +
            `(notification=${result.notificationPurged} policy=${result.policyPurged} ` +
            `diagnostic=${result.diagnosticPurged} ` +
            `newsletters=${result.newsletterSendsPurged}/${result.newsletterSnapshotsPruned})`
        );
      } catch (error) {
        console.error(
          `[RunRetention] Job ${job.id} failed after ${Date.now() - startTime}ms:`,
          error
        );
        throw error;
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
    }
  );

  retentionWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[RunRetention] Worker error:', error);
  });

  console.log('[RunRetention] Worker started');
}

/**
 * Schedule the daily run retention purge
 */
export async function scheduleRunRetention(): Promise<void> {
  if (!retentionQueue || !connectionOptions) {
    console.error('[RunRetention] Queue not initialized');
    return;
  }

  // Droppable once no install can predate 2.2.0-beta, the release that renamed the queue.
  const legacyQueue = new Queue(LEGACY_QUEUE_NAME, {
    connection: connectionOptions,
    prefix: getBullPrefix(),
  });
  try {
    await legacyQueue.obliterate({ force: true });
  } catch (error) {
    console.warn('[RunRetention] Could not sweep the legacy queue:', error);
  } finally {
    await legacyQueue.close();
  }

  // getJobSchedulers returns {key, name, next, every} - there is no id to remove by.
  const schedulers = await retentionQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await retentionQueue.removeJobScheduler(scheduler.key);
  }

  await retentionQueue.add(
    'scheduled-purge',
    { type: 'purge' },
    {
      repeat: {
        every: PURGE_INTERVAL_MS,
      },
      jobId: 'run-retention-repeatable',
    }
  );

  console.log('[RunRetention] Scheduled daily run purge');
}

export interface RunRetentionResult {
  notificationPurged: number;
  policyPurged: number;
  diagnosticPurged: number;
  newsletterSendsPurged: number;
  newsletterSnapshotsPruned: number;
}

/** The identities whose rows one batch removed, so the caller can restate their rollups. */
type BatchListener = (serverUserIds: string[]) => Promise<void>;

async function deleteBatched(where: SQL, onBatch?: BatchListener): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM automation_runs
      WHERE id IN (
        SELECT ar.id FROM automation_runs ar
        WHERE ${where}
        LIMIT ${DELETE_BATCH_SIZE}
      )
      RETURNING server_user_id
    `);
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (onBatch) {
      const touched = new Set<string>();
      for (const row of result.rows) {
        const serverUserId = row.server_user_id;
        if (typeof serverUserId === 'string') touched.add(serverUserId);
      }
      if (touched.size > 0) await onBatch([...touched]);
    }
    if (deleted < DELETE_BATCH_SIZE) break;
  }
  return total;
}

/** One window's automations and the instant their runs age out. */
interface RetentionGroup {
  cutoff: Date;
  automationIds: string[];
}

const cutoffOf = (days: number): Date => new Date(Date.now() - days * TIME_MS.DAY);

/**
 * Group a kind's automations by effective window. A per-row COALESCE over the
 * joined automation makes the cutoff join-dependent, which costs the scan its
 * index; one constant cutoff per group keeps it a range read.
 */
async function completedGroups(
  kind: AutomationKind,
  defaultDays: number
): Promise<RetentionGroup[]> {
  const rows = await db
    .select({ id: automations.id, retentionDays: automations.retentionDays })
    .from(automations)
    .where(eq(automations.kind, kind));

  const byWindow = new Map<number, string[]>();
  for (const row of rows) {
    const days = row.retentionDays ?? defaultDays;
    const ids = byWindow.get(days);
    if (ids) ids.push(row.id);
    else byWindow.set(days, [row.id]);
  }

  return [...byWindow].map(([days, automationIds]) => ({ cutoff: cutoffOf(days), automationIds }));
}

function completedOfGroup(kind: AutomationKind, group: RetentionGroup): SQL {
  const ids = sql.join(
    group.automationIds.map((id) => sql`${id}`),
    sql`, `
  );
  return sql`ar.kind = ${kind} AND ar.outcome = 'completed'
    AND (ar.session_id IS NOT NULL OR ar.server_user_id IS NULL)
    AND ar.rule_id IN (${ids}) AND ar.finished_at < ${group.cutoff}`;
}

// Kind-scoped so the (kind, finished_at) index serves the scan; every kind is swept.
function diagnosticsOfKind(kind: AutomationKind): SQL {
  return sql`ar.kind = ${kind} AND ar.outcome <> 'completed'
    AND ar.finished_at < ${cutoffOf(DIAGNOSTIC_RETENTION_DAYS)}`;
}

/** The purge removes rows users.total_violations counts, so its identities are restated. */
async function recomputeIdentities(serverUserIds: string[]): Promise<void> {
  for (const serverUserId of serverUserIds) {
    await recomputeIdentityAggregatesForServerUser(serverUserId);
  }
}

/** Closed sends keep their row for a year and their rendered snapshots for 90 days; an open send is never touched. */
async function pruneNewsletterSends(): Promise<{ purged: number; pruned: number }> {
  const purged = await db.execute(sql`
    DELETE FROM newsletter_sends
    WHERE finished_at IS NOT NULL AND started_at < ${cutoffOf(NEWSLETTER_SEND_RETENTION_DAYS)}
  `);
  const pruned = await db.execute(sql`
    DELETE FROM newsletter_send_snapshots AS ns
    USING newsletter_sends AS s
    WHERE s.id = ns.send_id AND s.finished_at IS NOT NULL
      AND s.started_at < ${cutoffOf(NEWSLETTER_SNAPSHOT_RETENTION_DAYS)}
  `);
  return { purged: purged.rowCount ?? 0, pruned: pruned.rowCount ?? 0 };
}

/**
 * Hard-delete runs past their retention window.
 */
export async function processRunRetention(): Promise<RunRetentionResult> {
  let notificationPurged = 0;
  for (const group of await completedGroups('notification', RETENTION_DEFAULTS.notification)) {
    notificationPurged += await deleteBatched(completedOfGroup('notification', group));
  }

  let policyPurged = 0;
  for (const group of await completedGroups('policy', RETENTION_DEFAULTS.policy)) {
    policyPurged += await deleteBatched(completedOfGroup('policy', group), recomputeIdentities);
  }

  let diagnosticPurged = 0;
  for (const kind of AUTOMATION_KINDS) {
    diagnosticPurged += await deleteBatched(diagnosticsOfKind(kind));
  }

  const newsletter = await pruneNewsletterSends();

  return {
    notificationPurged,
    policyPurged,
    diagnosticPurged,
    newsletterSendsPurged: newsletter.purged,
    newsletterSnapshotsPruned: newsletter.pruned,
  };
}

/**
 * Gracefully shutdown the run retention queue and worker
 */
export async function shutdownRunRetentionQueue(): Promise<void> {
  console.log('[RunRetention] Shutting down queue...');

  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }

  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }

  console.log('[RunRetention] Queue shutdown complete');
}
