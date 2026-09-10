/**
 * Notification Queue - one job per destination, delivered through the type registry.
 */

import { Queue, UnrecoverableError, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { GroupEvidence } from '@tracearr/shared';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import {
  eventTypeOf,
  type NotificationEvent,
  type NotificationSource,
} from '../services/notifications/events.js';
import { DELIVER_TIMEOUT_MS } from '../services/notifications/destinations/fetch.js';
import { getDestinationType } from '../services/notifications/destinations/registry.js';
import {
  findDestinationsForEvent,
  getDestination,
  markReencrypt,
  readConfig,
  rewrapConfig,
  type DestinationRow,
} from '../services/notifications/destinationStore.js';
import { isMaintenance } from '../serverState.js';

export interface NotificationJob {
  destinationId: string;
  source: NotificationSource;
  event: NotificationEvent;
}

const QUEUE_NAME = 'notifications-v2';
const DLQ_NAME = 'notifications-v2-dlq';

// Connection options (will be set during initialization)
let connectionOptions: ConnectionOptions | null = null;

// Queue and worker instances
let notificationQueue: Queue<NotificationJob> | null = null;
let notificationWorker: Worker<NotificationJob> | null = null;
let dlqQueue: Queue<NotificationJob> | null = null;

/**
 * Initialize the notification queue with Redis connection
 */
export function initNotificationQueue(redisUrl: string): void {
  if (notificationQueue) {
    console.log('Notification queue already initialized');
    return;
  }

  connectionOptions = queueConnectionOptions(redisUrl);

  const bullPrefix = getBullPrefix();

  notificationQueue = new Queue<NotificationJob>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000, // 1s, 2s, 4s
      },
      removeOnComplete: {
        count: 10_000,
        age: 24 * 60 * 60, // Remove completed jobs older than 24h
      },
      removeOnFail: {
        count: 5000, // Keep more failed jobs for analysis
        age: 7 * 24 * 60 * 60, // Keep failed jobs for 7 days
      },
    },
  });
  notificationQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('Notification queue error:', err);
  });

  // Create dead letter queue for jobs that fail all retries
  dlqQueue = new Queue<NotificationJob>(DLQ_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      removeOnComplete: {
        count: 25,
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 50,
        age: 14 * 24 * 60 * 60, // 14 days
      },
    },
  });
  dlqQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('Notification DLQ error:', err);
  });

  console.log('Notification queue initialized');
}

/**
 * Start the notification worker to process queued jobs
 */
export function startNotificationWorker(): void {
  if (!connectionOptions) {
    throw new Error('Notification queue not initialized. Call initNotificationQueue first.');
  }

  if (notificationWorker) {
    console.log('Notification worker already running');
    return;
  }

  const bullPrefix = getBullPrefix();

  notificationWorker = new Worker<NotificationJob>(
    QUEUE_NAME,
    async (job: Job<NotificationJob>) => {
      const startTime = Date.now();

      try {
        await processJob(job);

        const duration = Date.now() - startTime;
        console.log(
          `Notification job ${job.id} (${job.data.event.type}) processed in ${duration}ms`
        );
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(
          `Notification job ${job.id} (${job.data.event.type}) failed after ${duration}ms:`,
          error
        );
        throw error; // Re-throw to trigger retry
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 5, // Process up to 5 notifications in parallel
      limiter: {
        max: 30, // Max 30 jobs per duration
        duration: 1000, // Per second (rate limit for external services)
      },
    }
  );

  notificationWorker.on('failed', (job, error) => {
    if (!job) return;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 3);
    if (!exhausted && !(error instanceof UnrecoverableError)) return;

    console.error(`Notification job ${job.id} (${job.data.event.type}) moving to DLQ:`, error);

    if (dlqQueue) {
      void dlqQueue.add(`dlq-${job.data.event.type}`, job.data, {
        jobId: `dlq-${job.id}`,
      });
    }
  });

  notificationWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('Notification worker error:', error);
  });

  console.log('Notification worker started');
}

/** Deduplication window in milliseconds (5 minutes) */
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

function getTimeBucket(): number {
  return Math.floor(Date.now() / DEDUP_WINDOW_MS);
}

/** Generate dedup key (5-min window). BullMQ rejects duplicate jobIds. */
function dedupeKey(
  destinationId: string,
  event: NotificationEvent,
  source: NotificationSource
): string | undefined {
  const bucket = getTimeBucket();
  // Two automations sending the same event are separate sends; without the id they
  // share a jobId and BullMQ drops the second.
  const automation = source.kind === 'automation' ? `${source.automationId}-` : '';
  let tail: string;

  switch (event.type) {
    case 'violation': {
      // Key on rule id, not rule type: every v2 rule has type null, so a
      // type-based key would dedupe unrelated rules against each other.
      const ruleKey = event.payload.rule.id || event.payload.rule.type;
      if (!ruleKey) return undefined;
      // A send and the routed violation are separate sends; without the kind
      // they share a jobId and BullMQ drops the second.
      const kind =
        source.kind === 'automation'
          ? source.automationId
          : source.kind === 'rule'
            ? 'notify'
            : 'auto';
      tail = `violation-${event.payload.serverUserId}-${ruleKey}-${kind}-${bucket}`;
      break;
    }
    case 'session_started':
    case 'session_stopped': {
      // Use internal id, not sessionKey (Emby reuses sessionKeys)
      const sessionId = event.payload.id;
      if (!sessionId) {
        console.warn(`Session ${event.type} missing id, skipping deduplication`);
        return undefined;
      }
      tail = `${event.type}-${sessionId}-${automation}${bucket}`;
      break;
    }
    case 'media_added':
    case 'media_upgraded': {
      // The default arm keys on the server, which would collapse a whole batch into one job.
      tail = `${event.type}-${event.payload.libraryItemId}-${automation}${bucket}`;
      break;
    }
    case 'new_device': {
      // The default arm keys on the server, which would collapse two accounts into one job.
      tail = `${event.type}-${event.payload.sessionId}-${automation}${bucket}`;
      break;
    }
    case 'trust_score_changed': {
      // Per account: two moves on one account inside a bucket are meant to collapse.
      tail = `${event.type}-${event.payload.serverUserId}-${automation}${bucket}`;
      break;
    }
    case 'newsletter_send': {
      // The default arm keys on the install, which would collapse two newsletters into one job.
      tail = `${event.type}-${event.payload.sendId}-${automation}${bucket}`;
      break;
    }
    default: {
      // The tracearr release is about the install, not a server.
      const serverId = 'serverId' in event.payload ? event.payload.serverId : 'install';
      tail = `${event.type}-${serverId}-${automation}${bucket}`;
    }
  }

  // BullMQ rejects custom ids containing ':' unless they have exactly three segments
  return `${destinationId}|${tail}`;
}

/** Threshold arrays hold uuids; cond.actual is a display name, not an id. */
async function resolveUserNames(event: NotificationEvent): Promise<void> {
  if (event.type !== 'violation') return;
  const payload = event.payload;
  const rawEvidence = Array.isArray(payload.data?.evidence)
    ? (payload.data.evidence as GroupEvidence[])
    : [];
  if (rawEvidence.length === 0) return;

  const userIdSet = new Set<string>();
  for (const group of rawEvidence) {
    for (const cond of group.conditions) {
      if (cond.field === 'user_id' && Array.isArray(cond.threshold)) {
        for (const id of cond.threshold) {
          if (typeof id === 'string') userIdSet.add(id);
        }
      }
    }
  }
  if (userIdSet.size === 0) return;

  try {
    const { getServerUserDisplayNames } = await import('../services/userService.js');
    payload.userNames = await getServerUserDisplayNames([...userIdSet]);
  } catch (err) {
    console.error(
      'failed to resolve user display names for violation notification',
      payload.id,
      err
    );
  }
}

/** Returns how many destinations the event fanned out to (0 when nothing is subscribed or every target is disabled/reencrypt). */
export async function enqueueNotification(
  event: NotificationEvent,
  opts: { to?: string[]; source?: NotificationSource } = {}
): Promise<number> {
  if (!notificationQueue) {
    console.error('Notification queue not initialized, dropping notification:', event.type);
    return 0;
  }

  const source = opts.source ?? { kind: 'system' };
  const targets = opts.to
    ? (await Promise.all(opts.to.map((id) => getDestination(id)))).filter(
        (d): d is DestinationRow => d !== null && d.enabled && d.configStatus === 'ok'
      )
    : await findDestinationsForEvent(eventTypeOf(event));
  if (targets.length === 0) return 0;

  await resolveUserNames(event);

  await notificationQueue.addBulk(
    targets.map((d) => ({
      name: event.type,
      data: { destinationId: d.id, source, event } satisfies NotificationJob,
      opts: { jobId: dedupeKey(d.id, event, source) },
    }))
  );

  return targets.length;
}

async function processJob(job: Job<NotificationJob>): Promise<void> {
  const { destinationId, source, event } = job.data;
  const destination = await getDestination(destinationId);
  if (!destination || !destination.enabled || destination.configStatus !== 'ok') {
    console.log(
      `[Notifications] job ${job.id}: destination ${destinationId} missing, disabled or awaiting re-entry; skipped`
    );
    return;
  }

  const opened = readConfig(destination);
  if (!opened.ok) {
    console.warn(`[Notifications] ${destination.name}: config ${opened.reason}`);
    if (opened.reason === 'bad_key') await markReencrypt(destination.id);
    return;
  }
  if (opened.rewrap) await rewrapConfig(destination.id, opened.config);

  const type = getDestinationType(destination.type);
  const ref = { id: destination.id, name: destination.name };
  const rendered = await type.render(event, opened.config, { destination: ref, source });
  await type.deliver(rendered, opened.config, {
    destination: ref,
    signal: AbortSignal.timeout(type.deliverTimeoutMs ?? DELIVER_TIMEOUT_MS),
  });
}

/**
 * Get queue statistics for monitoring
 */
export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  dlqSize: number;
} | null> {
  if (!notificationQueue || !dlqQueue) {
    return null;
  }

  const [waiting, active, completed, failed, delayed, dlqWaiting] = await Promise.all([
    notificationQueue.getWaitingCount(),
    notificationQueue.getActiveCount(),
    notificationQueue.getCompletedCount(),
    notificationQueue.getFailedCount(),
    notificationQueue.getDelayedCount(),
    dlqQueue.getWaitingCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    dlqSize: dlqWaiting,
  };
}

/**
 * Gracefully shutdown the notification queue and worker
 */
export async function shutdownNotificationQueue(): Promise<void> {
  console.log('Shutting down notification queue...');

  if (notificationWorker) {
    await notificationWorker.close();
    notificationWorker = null;
  }

  if (notificationQueue) {
    await notificationQueue.close();
    notificationQueue = null;
  }

  if (dlqQueue) {
    await dlqQueue.close();
    dlqQueue = null;
  }

  console.log('Notification queue shutdown complete');
}
