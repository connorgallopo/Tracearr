/**
 * Inactivity Check Queue - hourly dispatch of account.inactive_for.
 * Rules carrying an account.inactive_for trigger are evaluated, recorded and acted
 * on by the shared rule pipeline; this file only finds the candidate accounts.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { eq, and, isNull, lte, or, type SQL } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { TIME_MS, type EngineAutomation, type ServerType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { serverUsers, users, servers } from '../db/schema.js';
import { dispatch } from '../services/automations/events/dispatcher.js';
import { matchesTrigger, triggerNodeFor } from '../services/automations/events/evaluate.js';
import { liveServerCondition } from '../services/liveServers.js';
import { isMaintenance } from '../serverState.js';
import { batchGetIdentityServerUserIds, getActiveAutomations } from './poller/database.js';
import { broadcastViolations } from './poller/violations.js';
import { everyAligned, getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { WORKER_DEFAULTS, addSingleton, registerQueue, registerWorker } from './jobSafety.js';

// Queue name
const QUEUE_NAME = 'inactivity-check';

// Fixed check interval (1 hour)
const CHECK_INTERVAL_MS = TIME_MS.HOUR;

// Startup delay before first check (5 minutes) - allows server to fully initialize
const STARTUP_DELAY_MS = 5 * TIME_MS.MINUTE;

// Job types
interface InactivityCheckJobData {
  type: 'check';
  ruleId?: string; // If set, only check this specific rule
}

// Connection options (set during initialization)
let connectionOptions: ConnectionOptions | null = null;

// Queue and worker instances
let inactivityQueue: Queue<InactivityCheckJobData> | null = null;
let inactivityWorker: Worker<InactivityCheckJobData> | null = null;

// Redis client reference (kept for potential future use with caching)
let _redisClient: Redis | null = null;

// Pub/sub service for broadcasting violations
let pubSubPublish: ((event: string, data: unknown) => Promise<void>) | null = null;

/**
 * Initialize the inactivity check queue with Redis connection
 */
export function initInactivityCheckQueue(
  redisUrl: string,
  redis: Redis,
  publishFn: (event: string, data: unknown) => Promise<void>
): void {
  if (inactivityQueue) {
    console.log('[Inactivity] Queue already initialized');
    return;
  }

  connectionOptions = queueConnectionOptions(redisUrl);
  _redisClient = redis;
  pubSubPublish = publishFn;
  const bullPrefix = getBullPrefix();

  // Create the inactivity check queue
  inactivityQueue = new Queue<InactivityCheckJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000, // 10s, 20s, 40s
      },
      removeOnComplete: {
        count: 50, // Keep last 50 for debugging
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 100,
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
  });
  inactivityQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[Inactivity] Queue error:', err);
  });
  registerQueue(inactivityQueue);

  console.log('[Inactivity] Queue initialized');
}

/**
 * Start the inactivity check worker
 */
export function startInactivityCheckWorker(): void {
  if (!connectionOptions) {
    throw new Error('Inactivity check queue not initialized. Call initInactivityCheckQueue first.');
  }

  if (inactivityWorker) {
    console.log('[Inactivity] Worker already running');
    return;
  }

  const bullPrefix = getBullPrefix();

  inactivityWorker = new Worker<InactivityCheckJobData>(
    QUEUE_NAME,
    async (job: Job<InactivityCheckJobData>) => {
      const startTime = Date.now();
      try {
        await processInactivityCheck(job);
        const duration = Date.now() - startTime;
        console.log(`[Inactivity] Job ${job.id} completed in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[Inactivity] Job ${job.id} failed after ${duration}ms:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1, // Only one check at a time to avoid DB contention
      ...WORKER_DEFAULTS,
    }
  );
  registerWorker(inactivityWorker);

  inactivityWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[Inactivity] Worker error:', error);
  });

  console.log('[Inactivity] Worker started');
}

/**
 * Schedule inactivity checks based on active rules
 * Called on startup and when rules are created/updated/deleted
 */
export async function scheduleInactivityChecks(): Promise<void> {
  if (!inactivityQueue) {
    console.error('[Inactivity] Queue not initialized');
    return;
  }

  // Remove any existing job schedulers
  const schedulers = await inactivityQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await inactivityQueue.removeJobScheduler(scheduler.key);
  }

  const activeRules = (await getActiveAutomations()).filter((r) =>
    matchesTrigger(r, 'account.inactive_for')
  );

  if (activeRules.length === 0) {
    console.log('[Inactivity] No active inactivity rules found');
    return;
  }

  // Schedule a single recurring job that checks all rules hourly
  await inactivityQueue.upsertJobScheduler(
    'inactivity-check-repeatable',
    everyAligned(CHECK_INTERVAL_MS),
    { name: 'scheduled-check', data: { type: 'check' } }
  );

  // Schedule a delayed startup check to allow server to fully initialize
  // This prevents false positives during server startup
  await addSingleton(
    inactivityQueue,
    'startup-check',
    { type: 'check' },
    'inactivity-check-startup',
    {
      delay: STARTUP_DELAY_MS,
    }
  );

  console.log(`[Inactivity] Scheduled hourly checks for ${activeRules.length} rule(s)`);
}

interface CandidateRow {
  id: string;
  userId: string;
  username: string;
  thumbUrl: string | null;
  identityName: string | null;
  lastActivityAt: Date | null;
  trustScore: number;
  createdAt: Date;
  serverId: string;
  serverName: string;
  serverType: ServerType;
}

/** The trigger's own threshold, so an automation only ever sees accounts idle long enough for it. */
function inactiveSince(rule: EngineAutomation, now: number): Date | null {
  const node = triggerNodeFor(rule, 'account.inactive_for');
  if (node?.type !== 'account.inactive_for') return null;
  return new Date(now - node.params.days * TIME_MS.DAY);
}

/**
 * Process an inactivity check job
 */
async function processInactivityCheck(job: Job<InactivityCheckJobData>): Promise<void> {
  console.log(`[Inactivity] Processing check (job ${job.id})`);

  const activeRules = (await getActiveAutomations()).filter(
    (r) =>
      matchesTrigger(r, 'account.inactive_for') && (!job.data.ruleId || r.id === job.data.ruleId)
  );
  if (activeRules.length === 0) {
    console.log('[Inactivity] No active inactivity rules to check');
    return;
  }

  // One dispatch per distinct account across every rule's scope; the engine's own
  // per-rule scope filters decide which rules apply to which account.
  const candidates = new Map<string, CandidateRow>();
  const now = Date.now();
  for (const rule of activeRules) {
    const since = inactiveSince(rule, now);
    const scopeFilters: (SQL | undefined)[] = [isNull(serverUsers.removedAt), liveServerCondition];
    if (rule.serverUserId) scopeFilters.push(eq(serverUsers.id, rule.serverUserId));
    if (rule.serverId) scopeFilters.push(eq(serverUsers.serverId, rule.serverId));
    if (rule.userId) scopeFilters.push(eq(serverUsers.userId, rule.userId));
    if (since) {
      scopeFilters.push(
        or(isNull(serverUsers.lastActivityAt), lte(serverUsers.lastActivityAt, since))
      );
    }

    const rows = await db
      .select({
        id: serverUsers.id,
        userId: serverUsers.userId,
        username: serverUsers.username,
        thumbUrl: serverUsers.thumbUrl,
        identityName: users.name,
        lastActivityAt: serverUsers.lastActivityAt,
        trustScore: serverUsers.trustScore,
        createdAt: serverUsers.createdAt,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        serverType: servers.type,
      })
      .from(serverUsers)
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .innerJoin(servers, eq(servers.id, serverUsers.serverId))
      .where(and(...scopeFilters));
    for (const row of rows) candidates.set(row.id, row);
  }

  const identityIdsByUser = await batchGetIdentityServerUserIds([
    ...new Set([...candidates.values()].map((c) => c.userId)),
  ]);

  let totalViolations = 0;
  for (const c of candidates.values()) {
    const identityServerUserIds = identityIdsByUser.get(c.userId) ?? [];
    try {
      const { violations } = await dispatch(
        {
          type: 'account.inactive_for',
          at: new Date(),
          server: { id: c.serverId, name: c.serverName, type: c.serverType },
          serverUser: {
            id: c.id,
            userId: c.userId,
            username: c.username,
            thumbUrl: c.thumbUrl,
            identityName: c.identityName,
            trustScore: c.trustScore,
            lastActivityAt: c.lastActivityAt,
            createdAt: c.createdAt,
            identityServerUserIds,
          },
          session: null,
        },
        {
          activeAutomations: activeRules,
          activeSessions: [],
          recentSessions: [],
          identityServerUserIds,
        }
      );
      if (violations.length > 0) {
        totalViolations += violations.length;
        if (pubSubPublish) {
          await broadcastViolations(violations, { serverUserId: c.id }, { publish: pubSubPublish });
        }
      }
    } catch (error) {
      console.error(`[Inactivity] Failed to evaluate ${c.username}:`, error);
    }
  }

  console.log(`[Inactivity] Check complete. Created ${totalViolations} violations.`);
}

export { processInactivityCheck as processInactivityCheckForTests };

/**
 * Gracefully shutdown the inactivity check queue and worker
 */
export async function shutdownInactivityCheckQueue(): Promise<void> {
  console.log('[Inactivity] Shutting down queue...');

  if (inactivityWorker) {
    await inactivityWorker.close();
    inactivityWorker = null;
  }

  if (inactivityQueue) {
    await inactivityQueue.close();
    inactivityQueue = null;
  }

  _redisClient = null;
  pubSubPublish = null;

  console.log('[Inactivity] Queue shutdown complete');
}

/**
 * Get queue statistics for the inactivity check queue
 */
export async function getInactivityCheckQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  schedule: string | null;
} | null> {
  if (!inactivityQueue) return null;

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    inactivityQueue.getWaitingCount(),
    inactivityQueue.getActiveCount(),
    inactivityQueue.getCompletedCount(),
    inactivityQueue.getFailedCount(),
    inactivityQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed, schedule: `every ${CHECK_INTERVAL_MS}ms` };
}
