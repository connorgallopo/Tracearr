import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { TIME_MS } from '@tracearr/shared';
import { runRequestSync, type SyncMode } from '../services/requests/sync.js';
import { listRequestServices } from '../services/requests/store.js';
import { isMaintenance } from '../serverState.js';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';

const QUEUE_NAME = 'request-sync';
const INCREMENTAL_EVERY_MS = 15 * TIME_MS.MINUTE;

export interface RequestSyncJobData {
  serviceId: string;
  mode: SyncMode;
}

let connectionOptions: ConnectionOptions | null = null;
let queue: Queue<RequestSyncJobData> | null = null;
let worker: Worker<RequestSyncJobData> | null = null;

export function initRequestSyncQueue(
  redisUrl: string,
  _redis: Redis,
  _publishFn: (event: string, data: unknown) => Promise<void>
): void {
  if (queue) return;
  connectionOptions = queueConnectionOptions(redisUrl);
  queue = new Queue<RequestSyncJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: getBullPrefix(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 50, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 7 * 24 * 60 * 60 },
    },
  });
  queue.on('error', (err) => {
    if (!isMaintenance()) console.error('[RequestSync] Queue error:', err);
  });
  console.log('[RequestSync] Queue initialized');
}

export function startRequestSyncWorker(): void {
  if (!connectionOptions) throw new Error('Request sync queue not initialized');
  if (worker) return;
  worker = new Worker<RequestSyncJobData>(
    QUEUE_NAME,
    async (job: Job<RequestSyncJobData>) => {
      const result = await runRequestSync(job.data.serviceId, job.data.mode);
      console.log(
        `[RequestSync] ${job.data.mode} for ${job.data.serviceId}: ${result.skipped ? 'skipped' : `${result.upserted} upserted, ${result.markedDeleted} marked deleted`}`
      );
    },
    { connection: connectionOptions, prefix: getBullPrefix(), concurrency: 1 }
  );
  worker.on('error', (error) => {
    if (!isMaintenance()) console.error('[RequestSync] Worker error:', error);
  });
  console.log('[RequestSync] Worker started');
}

/** Rebuilds the repeatable pair for every enabled service; called at boot and after any link change. */
export async function scheduleRequestSync(): Promise<void> {
  if (!queue) throw new Error('Request sync queue not initialized');
  for (const scheduler of await queue.getJobSchedulers()) {
    await queue.removeJobScheduler(scheduler.key);
  }
  const services = (await listRequestServices()).filter((s) => s.enabled);
  for (let i = 0; i < services.length; i++) {
    const service = services[i];
    if (!service) continue;
    await queue.add(
      `incremental-${service.id}`,
      { serviceId: service.id, mode: 'incremental' },
      { repeat: { every: INCREMENTAL_EVERY_MS }, jobId: `incremental-${service.id}` }
    );
    const minuteOffset = (20 + i * 3) % 60;
    await queue.add(
      `full-${service.id}`,
      { serviceId: service.id, mode: 'full' },
      { repeat: { pattern: `${minuteOffset} 4 * * *`, tz: 'UTC' }, jobId: `full-${service.id}` }
    );
  }
  console.log(`[RequestSync] Scheduled ${services.length} service(s)`);
}

export async function isRequestSyncActive(serviceId: string): Promise<boolean> {
  if (!queue) return false;
  const active = await queue.getJobs(['active']);
  return active.some((job) => job.data.serviceId === serviceId);
}

export async function enqueueRequestSync(serviceId: string, mode: SyncMode): Promise<string> {
  if (!queue) throw new Error('Request sync queue not initialized');
  if (await isRequestSyncActive(serviceId)) {
    throw new Error('A sync is already in progress for this service');
  }
  const job = await queue.add(`manual-${mode}-${serviceId}`, { serviceId, mode });
  return job.id ?? '';
}

export async function shutdownRequestSyncQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
