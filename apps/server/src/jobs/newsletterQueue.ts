import { randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import {
  newsletterCron,
  type NewsletterSchedule,
  type NewsletterSendTrigger,
} from '@tracearr/shared';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { isMaintenance } from '../serverState.js';
import { getDestination } from '../services/notifications/destinationStore.js';
import {
  deliverRecipient,
  markRecipientFailed,
  type DeliveryJob,
} from '../services/newsletters/deliver.js';
import { runNewsletter } from '../services/newsletters/send.js';
import { newslettersUsingDestination } from '../services/newsletters/store.js';

export interface RunJob {
  newsletterId: string;
  trigger: NewsletterSendTrigger;
  testAddress?: string;
  variantKey?: string;
}
export type { DeliveryJob };

const RUN_QUEUE = 'newsletters';
const DELIVERY_QUEUE = 'newsletter-deliveries';
const DELIVERY_DLQ = 'newsletter-deliveries-dlq';
const DELIVERY_ATTEMPTS = 3;

export class InvalidScheduleError extends Error {}

let connection: ConnectionOptions | null = null;
let runQueue: Queue<RunJob> | null = null;
let deliveryQueue: Queue<DeliveryJob> | null = null;
let dlqQueue: Queue<DeliveryJob> | null = null;
let runWorker: Worker<RunJob> | null = null;
let deliveryWorker: Worker<DeliveryJob> | null = null;

const schedulerId = (newsletterId: string): string => `newsletter-${newsletterId}`;

export function initNewsletterQueues(redisUrl: string): void {
  if (runQueue) return;
  connection = queueConnectionOptions(redisUrl);
  const prefix = getBullPrefix();
  const retention = {
    removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
    removeOnFail: { count: 1000, age: 7 * 24 * 60 * 60 },
  };
  runQueue = new Queue<RunJob>(RUN_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      ...retention,
    },
  });
  deliveryQueue = new Queue<DeliveryJob>(DELIVERY_QUEUE, {
    connection,
    prefix,
    // A failed delivery job's own record is redundant once markRecipientFailed and the
    // DLQ entry have run; keeping it around only leaves a duplicate to clean up.
    defaultJobOptions: { removeOnComplete: retention.removeOnComplete, removeOnFail: true },
  });
  dlqQueue = new Queue<DeliveryJob>(DELIVERY_DLQ, {
    connection,
    prefix,
    defaultJobOptions: {
      removeOnComplete: { count: 100, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 14 * 24 * 60 * 60 },
    },
  });
  for (const q of [runQueue, deliveryQueue, dlqQueue]) {
    q.on('error', (err) => {
      if (!isMaintenance()) console.error(`[Newsletters] queue ${q.name} error:`, err);
    });
  }
}

function requireQueues(): { run: Queue<RunJob>; delivery: Queue<DeliveryJob> } {
  if (!runQueue || !deliveryQueue) throw new Error('Newsletter queues not initialized');
  return { run: runQueue, delivery: deliveryQueue };
}

export function startNewsletterWorkers(): void {
  if (!connection) throw new Error('Newsletter queues not initialized');
  if (runWorker) return;
  const prefix = getBullPrefix();
  runWorker = new Worker<RunJob>(
    RUN_QUEUE,
    async (job: Job<RunJob>) => {
      const result = await runNewsletter(
        job.data.newsletterId,
        job.data.trigger,
        job.data.testAddress,
        job.data.variantKey
      );
      if (result.sendId && result.queuedRecipientIds.length > 0) {
        await enqueueDeliveries(result.sendId, result.queuedRecipientIds);
      }
      console.log(`[Newsletters] run ${job.id} for ${job.data.newsletterId}: ${result.outcome}`);
    },
    { connection, prefix, concurrency: 1 }
  );
  runWorker.on('error', (err) => {
    if (!isMaintenance()) console.error('[Newsletters] run worker error:', err);
  });

  deliveryWorker = new Worker<DeliveryJob>(
    DELIVERY_QUEUE,
    async (job: Job<DeliveryJob>) => {
      try {
        await deliverRecipient(job.data);
      } catch (error) {
        const last = job.attemptsMade + 1 >= (job.opts.attempts ?? DELIVERY_ATTEMPTS);
        if (last || error instanceof UnrecoverableError) {
          await markRecipientFailed(job.data.recipientId, error);
        }
        throw error;
      }
    },
    { connection, prefix, concurrency: 2 }
  );
  deliveryWorker.on('failed', (job, error) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? DELIVERY_ATTEMPTS);
    if (!exhausted && !(error instanceof UnrecoverableError)) return;
    if (dlqQueue) {
      void dlqQueue
        // A recipient retried after retry-failed reuses its job id, so the timestamp keeps the second trip from being dropped as a duplicate.
        .add('dlq-delivery', job.data, { jobId: `dlq-${job.id}-${Date.now()}` })
        .catch((err: unknown) =>
          console.error('[Newsletters] could not move delivery to the DLQ:', err)
        );
    }
  });
  deliveryWorker.on('error', (err) => {
    if (!isMaintenance()) console.error('[Newsletters] delivery worker error:', err);
  });
}

/** A schedule with nowhere usable to deliver to is not a schedule; the destination must exist, be an email destination, be enabled, and have a decryptable config. */
async function destinationIsUsable(destinationId: string): Promise<boolean> {
  const destination = await getDestination(destinationId);
  return (
    destination !== null &&
    destination.type === 'email' &&
    destination.enabled === true &&
    destination.configStatus === 'ok'
  );
}

export async function upsertNewsletterSchedule(row: {
  id: string;
  enabled: boolean;
  destinationId: string | null;
  schedule: NewsletterSchedule;
  timezone: string;
}): Promise<void> {
  const { run } = requireQueues();
  const id = schedulerId(row.id);
  if (!row.enabled || !row.destinationId || !(await destinationIsUsable(row.destinationId))) {
    await run.removeJobScheduler(id);
    return;
  }
  try {
    await run.upsertJobScheduler(
      id,
      { pattern: newsletterCron(row.schedule), tz: row.timezone },
      { name: 'scheduled-run', data: { newsletterId: row.id, trigger: 'schedule' } }
    );
  } catch (error) {
    throw new InvalidScheduleError(error instanceof Error ? error.message : 'invalid schedule');
  }
}

export async function removeNewsletterSchedule(newsletterId: string): Promise<void> {
  await requireQueues().run.removeJobScheduler(schedulerId(newsletterId));
}

/** Boot: every enabled newsletter gets its scheduler back and orphans are dropped, so a Redis flush cannot silence schedules. */
export async function resyncNewsletterSchedules(
  rows: Parameters<typeof upsertNewsletterSchedule>[0][]
): Promise<void> {
  const { run } = requireQueues();
  const wanted = new Set(rows.map((r) => schedulerId(r.id)));
  for (const row of rows) {
    try {
      await upsertNewsletterSchedule(row);
    } catch (error) {
      console.error(`[Newsletters] schedule for ${row.id} skipped:`, error);
    }
  }
  for (const scheduler of await run.getJobSchedulers()) {
    const key = scheduler.key ?? scheduler.id ?? '';
    if (key.startsWith('newsletter-') && !wanted.has(key)) await run.removeJobScheduler(key);
  }
}

export async function nextRunAt(newsletterId: string): Promise<Date | null> {
  const { run } = requireQueues();
  const scheduler = await run.getJobScheduler(schedulerId(newsletterId));
  return scheduler?.next ? new Date(scheduler.next) : null;
}

export async function enqueueNewsletterRun(job: RunJob): Promise<string> {
  const id = `run-${randomUUID()}`;
  await requireQueues().run.add('run', job, { jobId: id });
  return id;
}

export async function enqueueDeliveries(sendId: string, recipientIds: string[]): Promise<number> {
  if (recipientIds.length === 0) return 0;
  await requireQueues().delivery.addBulk(
    recipientIds.map((recipientId) => ({
      name: 'deliver',
      data: { sendId, recipientId },
      opts: {
        jobId: recipientId,
        attempts: DELIVERY_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5000 },
      },
    }))
  );
  return recipientIds.length;
}

export async function onDestinationUnavailable(destinationId: string): Promise<void> {
  for (const row of await newslettersUsingDestination(destinationId)) {
    await removeNewsletterSchedule(row.id);
  }
}

/** A destination edit (re-enabled, disabled, re-keyed, kind changed) can make or break every newsletter that points at it, so each gets its schedule reconsidered. */
export async function onDestinationChanged(destinationId: string): Promise<void> {
  for (const row of await newslettersUsingDestination(destinationId)) {
    try {
      await upsertNewsletterSchedule(row);
    } catch (error) {
      console.error(`[Newsletters] schedule for ${row.id} skipped:`, error);
    }
  }
}

export async function getNewsletterQueueStats(): Promise<{
  runs: { waiting: number; active: number; failed: number };
  deliveries: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    dlqSize: number;
  };
} | null> {
  if (!runQueue || !deliveryQueue || !dlqQueue) return null;
  const [rw, ra, rf, dw, da, dc, df, dd, dlq] = await Promise.all([
    runQueue.getWaitingCount(),
    runQueue.getActiveCount(),
    runQueue.getFailedCount(),
    deliveryQueue.getWaitingCount(),
    deliveryQueue.getActiveCount(),
    deliveryQueue.getCompletedCount(),
    deliveryQueue.getFailedCount(),
    deliveryQueue.getDelayedCount(),
    dlqQueue.getWaitingCount(),
  ]);
  return {
    runs: { waiting: rw, active: ra, failed: rf },
    deliveries: { waiting: dw, active: da, completed: dc, failed: df, delayed: dd, dlqSize: dlq },
  };
}

export async function shutdownNewsletterQueues(): Promise<void> {
  await runWorker?.close();
  await deliveryWorker?.close();
  await runQueue?.close();
  await deliveryQueue?.close();
  await dlqQueue?.close();
  runWorker = null;
  deliveryWorker = null;
  runQueue = null;
  deliveryQueue = null;
  dlqQueue = null;
  connection = null;
}
