/**
 * Backup Queue - BullMQ-based scheduled backup job processing
 *
 * Provides scheduled automatic backups with configurable frequency,
 * retention management, and cron-based repeatable jobs.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { BackupScheduleType } from '@tracearr/shared';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { WORKER_DEFAULTS, registerQueue, registerWorker } from './jobSafety.js';
import { isMaintenance } from '../serverState.js';
import { getSetting } from '../services/settings.js';
import { BACKUP_DIR, createBackup, cleanupOldBackups } from '../services/backup.js';

const QUEUE_NAME = 'backup';

let connectionOptions: ConnectionOptions | null = null;
let backupQueue: Queue | null = null;
let backupWorker: Worker | null = null;

export function initBackupQueue(redisUrl: string): void {
  if (backupQueue) {
    console.log('[Backup] Queue already initialized');
    return;
  }

  connectionOptions = queueConnectionOptions(redisUrl);
  const bullPrefix = getBullPrefix();

  backupQueue = new Queue(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 60_000 },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 10 },
    },
  });

  backupQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[Backup] Queue error:', err);
  });
  registerQueue(backupQueue);

  console.log('[Backup] Queue initialized');
}

export function startBackupWorker(): void {
  if (!connectionOptions) {
    throw new Error('Backup queue not initialized. Call initBackupQueue first.');
  }
  if (backupWorker) {
    console.log('[Backup] Worker already running');
    return;
  }

  const bullPrefix = getBullPrefix();

  backupWorker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      console.log(`[Backup] Starting scheduled backup job ${job.id}`);

      const { filePath, metadata } = await createBackup(BACKUP_DIR, 'scheduled').catch(
        (err: unknown) => {
          console.error(`[Backup] Backup failed: ${err instanceof Error ? err.message : err}`);
          throw err;
        }
      );
      console.log(`[Backup] Backup created: ${filePath} (v${metadata.app.version})`);

      // Read retention count from settings
      const retentionCount = await getSetting('backupRetentionCount');
      const deleted = await cleanupOldBackups(retentionCount);

      if (deleted > 0) {
        console.log(`[Backup] Cleaned up ${deleted} old scheduled backup(s)`);
      }

      return { filePath, deleted };
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
      ...WORKER_DEFAULTS,
    }
  );
  registerWorker(backupWorker);

  backupWorker.on('failed', (job, err) => {
    console.error(`[Backup] Job ${job?.id} failed:`, err.message);
  });

  console.log('[Backup] Worker started');
}

/**
 * Schedule (or reschedule) the backup repeatable job based on current settings.
 * Call on startup and whenever backup schedule settings change.
 */
export async function scheduleBackupJob(schedule: {
  type: BackupScheduleType;
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
}): Promise<void> {
  if (!backupQueue) {
    console.warn('[Backup] Queue not initialized — cannot schedule');
    return;
  }

  // Remove existing schedulers
  const schedulers = await backupQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await backupQueue.removeJobScheduler(scheduler.key);
  }

  if (schedule.type === 'disabled') {
    console.log('[Backup] Scheduled backups disabled');
    return;
  }

  // Parse HH:MM
  const [hours, minutes] = schedule.time.split(':').map(Number);
  const hh = hours ?? 2;
  const mm = minutes ?? 0;

  let cron: string;
  switch (schedule.type) {
    case 'daily':
      cron = `${mm} ${hh} * * *`;
      break;
    case 'weekly':
      cron = `${mm} ${hh} * * ${schedule.dayOfWeek}`;
      break;
    case 'monthly':
      cron = `${mm} ${hh} ${schedule.dayOfMonth} * *`;
      break;
    default:
      return;
  }

  const tz = process.env.TZ || 'UTC';
  await backupQueue.upsertJobScheduler(
    'scheduled-backup',
    { pattern: cron, tz },
    { name: 'scheduled-backup', data: {} }
  );

  console.log(`[Backup] Scheduled ${schedule.type} backup at cron: ${cron} (${tz})`);
}

export async function getBackupQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  schedule: string | null;
} | null> {
  if (!backupQueue) return null;

  const [waiting, active, completed, failed, delayed, schedulers] = await Promise.all([
    backupQueue.getWaitingCount(),
    backupQueue.getActiveCount(),
    backupQueue.getCompletedCount(),
    backupQueue.getFailedCount(),
    backupQueue.getDelayedCount(),
    backupQueue.getJobSchedulers(),
  ]);

  const schedule = schedulers[0]?.pattern ?? null;

  return { waiting, active, completed, failed, delayed, schedule };
}

export async function shutdownBackupQueue(): Promise<void> {
  console.log('[Backup] Shutting down...');

  if (backupWorker) {
    await backupWorker.close();
    backupWorker = null;
  }

  if (backupQueue) {
    await backupQueue.close();
    backupQueue = null;
  }

  connectionOptions = null;
  console.log('[Backup] Shutdown complete');
}
