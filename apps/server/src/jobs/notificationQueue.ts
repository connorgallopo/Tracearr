/**
 * Notification Queue - BullMQ-based async notification dispatch
 *
 * Provides reliable, retryable notification delivery with dead letter support.
 * All notifications are enqueued here and processed asynchronously by workers.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { ViolationWithDetails, ActiveSession, NotificationEventType } from '@tracearr/shared';
import { notificationService } from '../services/notify.js';
import { pushNotificationService } from '../services/pushNotification.js';
import { getNotificationSettings } from '../routes/settings.js';
import { getChannelRouting } from '../routes/channelRouting.js';

/**
 * Map job types to notification event types for routing lookup
 */
const JOB_TYPE_TO_EVENT_TYPE: Record<NotificationJobData['type'], NotificationEventType> = {
  violation: 'violation_detected',
  session_started: 'stream_started',
  session_stopped: 'stream_stopped',
  server_down: 'server_down',
  server_up: 'server_up',
};

// Job type discriminated union for type-safe job handling
export type NotificationJobData =
  | { type: 'violation'; payload: ViolationWithDetails }
  | { type: 'session_started'; payload: ActiveSession }
  | { type: 'session_stopped'; payload: ActiveSession }
  | { type: 'server_down'; payload: { serverName: string; serverId: string } }
  | { type: 'server_up'; payload: { serverName: string; serverId: string } };

// Queue name constant
const QUEUE_NAME = 'notifications';

// Dead letter queue name for failed jobs that exceed retry attempts
const DLQ_NAME = 'notifications-dlq';

// Connection options (will be set during initialization)
let connectionOptions: ConnectionOptions | null = null;

// Queue and worker instances
let notificationQueue: Queue<NotificationJobData> | null = null;
let notificationWorker: Worker<NotificationJobData> | null = null;
let dlqQueue: Queue<NotificationJobData> | null = null;

/**
 * Initialize the notification queue with Redis connection
 */
export function initNotificationQueue(redisUrl: string): void {
  if (notificationQueue) {
    console.log('Notification queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };

  // Create the main notification queue
  notificationQueue = new Queue<NotificationJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000, // 1s, 2s, 4s
      },
      removeOnComplete: {
        count: 1000, // Keep last 1000 completed jobs for debugging
        age: 24 * 60 * 60, // Remove completed jobs older than 24h
      },
      removeOnFail: {
        count: 5000, // Keep more failed jobs for analysis
        age: 7 * 24 * 60 * 60, // Keep failed jobs for 7 days
      },
    },
  });

  // Create dead letter queue for jobs that fail all retries
  dlqQueue = new Queue<NotificationJobData>(DLQ_NAME, {
    connection: connectionOptions,
    defaultJobOptions: {
      removeOnComplete: false, // Never auto-remove from DLQ
      removeOnFail: false,
    },
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

  notificationWorker = new Worker<NotificationJobData>(
    QUEUE_NAME,
    async (job: Job<NotificationJobData>) => {
      const startTime = Date.now();

      try {
        await processNotificationJob(job);

        const duration = Date.now() - startTime;
        console.log(`Notification job ${job.id} (${job.data.type}) processed in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(
          `Notification job ${job.id} (${job.data.type}) failed after ${duration}ms:`,
          error
        );
        throw error; // Re-throw to trigger retry
      }
    },
    {
      connection: connectionOptions,
      concurrency: 5, // Process up to 5 notifications in parallel
      limiter: {
        max: 30, // Max 30 jobs per duration
        duration: 1000, // Per second (rate limit for external services)
      },
    }
  );

  // Handle failed jobs that exceed retry attempts - move to DLQ
  notificationWorker.on('failed', (job, error) => {
    if (job && job.attemptsMade >= (job.opts.attempts || 3)) {
      console.error(
        `Notification job ${job.id} (${job.data.type}) exhausted retries, moving to DLQ:`,
        error
      );

      // Move to dead letter queue for manual investigation
      if (dlqQueue) {
        void dlqQueue.add(`dlq-${job.data.type}`, job.data, {
          jobId: `dlq-${job.id}`,
        });
      }
    }
  });

  notificationWorker.on('error', (error) => {
    console.error('Notification worker error:', error);
  });

  console.log('Notification worker started');
}

/**
 * Process a single notification job
 */
async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  const { type, payload } = job.data;

  // Load current settings and channel routing for each job
  // (settings/routing may change between enqueue and process)
  const settings = await getNotificationSettings();
  const eventType = JOB_TYPE_TO_EVENT_TYPE[type];
  const routing = await getChannelRouting(eventType);

  // Build settings object with routing-aware channel enablement
  // The routing config controls which channels receive notifications
  const effectiveSettings = {
    // Only include webhook URLs if routing allows
    discordWebhookUrl: routing.discordEnabled ? settings.discordWebhookUrl : null,
    customWebhookUrl: routing.webhookEnabled ? settings.customWebhookUrl : null,
    webhookFormat: settings.webhookFormat,
    ntfyTopic: settings.ntfyTopic,
    ntfyAuthToken: settings.ntfyAuthToken ?? null,
    // Fill in defaults for other Settings fields
    allowGuestAccess: false,
    unitSystem: settings.unitSystem ?? ('metric' as const), // Display preference for units
    pollerEnabled: true,
    pollerIntervalMs: 15000,
    tautulliUrl: null,
    tautulliApiKey: null,
    externalUrl: null,
    basePath: '',
    trustProxy: false,
    mobileEnabled: settings.mobileEnabled ?? false,
    primaryAuthMethod: 'local' as const, // Not used in notifications, but required by Settings type
  };

  switch (type) {
    case 'violation':
      // Send to Discord/webhooks (if routing allows)
      if (routing.discordEnabled || routing.webhookEnabled) {
        await notificationService.notifyViolation(payload, effectiveSettings);
      }
      // Send push notification to mobile devices (if routing allows)
      if (routing.pushEnabled) {
        await pushNotificationService.notifyViolation(payload);
      }
      break;

    case 'session_started':
      // Send to Discord/webhooks (if routing allows)
      if (routing.discordEnabled || routing.webhookEnabled) {
        await notificationService.notifySessionStarted(payload, effectiveSettings);
      }
      // Send push notification to mobile devices (if routing allows)
      if (routing.pushEnabled) {
        await pushNotificationService.notifySessionStarted(payload);
      }
      break;

    case 'session_stopped':
      // Send to Discord/webhooks (if routing allows)
      if (routing.discordEnabled || routing.webhookEnabled) {
        await notificationService.notifySessionStopped(payload, effectiveSettings);
      }
      // Send push notification to mobile devices (if routing allows)
      if (routing.pushEnabled) {
        await pushNotificationService.notifySessionStopped(payload);
      }
      break;

    case 'server_down':
      // Send to Discord/webhooks (if routing allows)
      if (routing.discordEnabled || routing.webhookEnabled) {
        await notificationService.notifyServerDown(payload.serverName, effectiveSettings);
      }
      // Send push notification to mobile devices (if routing allows)
      if (routing.pushEnabled) {
        await pushNotificationService.notifyServerDown(payload.serverName, payload.serverId);
      }
      break;

    case 'server_up':
      // Send to Discord/webhooks (if routing allows)
      if (routing.discordEnabled || routing.webhookEnabled) {
        await notificationService.notifyServerUp(payload.serverName, effectiveSettings);
      }
      // Send push notification to mobile devices (if routing allows)
      if (routing.pushEnabled) {
        await pushNotificationService.notifyServerUp(payload.serverName, payload.serverId);
      }
      break;

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = type;
      throw new Error(`Unknown notification type: ${_exhaustive}`);
    }
  }
}

/**
 * Enqueue a notification for async processing
 */
export async function enqueueNotification(
  data: NotificationJobData,
  options?: { priority?: number; delay?: number }
): Promise<string | undefined> {
  if (!notificationQueue) {
    console.error('Notification queue not initialized, dropping notification:', data.type);
    return undefined;
  }

  const job = await notificationQueue.add(data.type, data, {
    priority: options?.priority,
    delay: options?.delay,
  });

  return job.id;
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

/**
 * Retry all jobs in the dead letter queue
 */
export async function retryDlqJobs(): Promise<number> {
  if (!dlqQueue || !notificationQueue) {
    return 0;
  }

  const jobs = await dlqQueue.getJobs(['waiting', 'delayed']);
  let retried = 0;

  for (const job of jobs) {
    // Re-enqueue to main queue
    await notificationQueue.add(job.data.type, job.data);
    await job.remove();
    retried++;
  }

  console.log(`Retried ${retried} jobs from DLQ`);
  return retried;
}
