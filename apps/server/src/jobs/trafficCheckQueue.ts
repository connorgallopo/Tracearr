/**
 * Traffic Check Queue - BullMQ-based periodic bandwidth usage checking
 *
 * Monitors user bandwidth consumption over configurable time periods (day/week/month/year)
 * and disables users on the media server when they exceed the limit.
 * Automatically re-enables users when their rolling window usage drops below the limit.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisPrefix } from '@tracearr/shared';
import type { Redis } from 'ioredis';
import { isMaintenance } from '../serverState.js';
import { eq, and, isNull, gte, sql } from 'drizzle-orm';
import type { RuleConditions, RuleType, ViolationWithDetails } from '@tracearr/shared';
import { WS_EVENTS, TIME_MS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { rules, serverUsers, sessions, violations, users, servers } from '../db/schema.js';
import { getActionExecutorDeps } from '../services/rules/executors/index.js';
import { enqueueNotification } from './notificationQueue.js';

// Queue name
const QUEUE_NAME = 'traffic-check';

// Fixed check interval (1 hour)
const CHECK_INTERVAL_MS = TIME_MS.HOUR;

// Startup delay before first check (5 minutes) - allows server to fully initialize
const STARTUP_DELAY_MS = 5 * TIME_MS.MINUTE;

// Job types
interface TrafficCheckJobData {
  type: 'check';
  ruleId?: string; // If set, only check this specific rule
}

/**
 * Check if V2 rule conditions contain a bandwidth_usage_gb field.
 */
export function hasTrafficCondition(conditions: RuleConditions | null): boolean {
  if (!conditions?.groups) return false;
  return conditions.groups.some((group) =>
    group.conditions.some((c) => c.field === 'bandwidth_usage_gb')
  );
}

/**
 * Extract the bandwidth limit and window period from V2 conditions.
 * Returns the value and window_period of the first bandwidth_usage_gb condition found, or null.
 */
export function extractTrafficLimitFromConditions(
  conditions: RuleConditions | null
): { limitGb: number; windowPeriod: string } | null {
  if (!conditions?.groups) return null;
  for (const group of conditions.groups) {
    for (const c of group.conditions) {
      if (c.field === 'bandwidth_usage_gb' && typeof c.value === 'number') {
        const windowPeriod =
          (c.params as { window_period?: string } | undefined)?.window_period ?? 'month';
        return { limitGb: c.value, windowPeriod };
      }
    }
  }
  return null;
}

/**
 * Get the rolling window start date for a given period.
 */
function getWindowStart(windowPeriod: string): Date {
  const now = new Date();
  let windowMs: number;
  switch (windowPeriod) {
    case 'day':
      windowMs = 24 * 60 * 60 * 1000;
      break;
    case 'week':
      windowMs = 7 * 24 * 60 * 60 * 1000;
      break;
    case 'month':
      windowMs = 30 * 24 * 60 * 60 * 1000;
      break;
    case 'year':
      windowMs = 365 * 24 * 60 * 60 * 1000;
      break;
    default:
      windowMs = 30 * 24 * 60 * 60 * 1000;
  }
  return new Date(now.getTime() - windowMs);
}

/**
 * Calculate bandwidth usage in GB for a server user within a time window.
 */
async function calculateBandwidthUsageGb(serverUserId: string, windowStart: Date): Promise<number> {
  const result = await db
    .select({
      totalBytes: sql<string>`COALESCE(SUM(COALESCE(${sessions.bitrate}, 0)::bigint * COALESCE(${sessions.durationMs}, 0)::bigint) / 8, 0)`,
    })
    .from(sessions)
    .where(and(eq(sessions.serverUserId, serverUserId), gte(sessions.startedAt, windowStart)));

  const totalBytes = Number(result[0]?.totalBytes ?? 0);
  return Math.round((totalBytes / 1e9) * 100) / 100;
}

// Connection options (set during initialization)
let connectionOptions: ConnectionOptions | null = null;

// Queue and worker instances
let trafficQueue: Queue<TrafficCheckJobData> | null = null;
let trafficWorker: Worker<TrafficCheckJobData> | null = null;

// Redis client reference
let _redisClient: Redis | null = null;

// Pub/sub service for broadcasting violations
let pubSubPublish: ((event: string, data: unknown) => Promise<void>) | null = null;

/**
 * Initialize the traffic check queue with Redis connection
 */
export function initTrafficCheckQueue(
  redisUrl: string,
  redis: Redis,
  publishFn: (event: string, data: unknown) => Promise<void>
): void {
  if (trafficQueue) {
    console.log('[Traffic] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  _redisClient = redis;
  pubSubPublish = publishFn;
  const bullPrefix = `${getRedisPrefix()}bull`;

  trafficQueue = new Queue<TrafficCheckJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000,
      },
      removeOnComplete: {
        count: 50,
        age: 7 * 24 * 60 * 60,
      },
      removeOnFail: {
        count: 100,
        age: 7 * 24 * 60 * 60,
      },
    },
  });
  trafficQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[Traffic] Queue error:', err);
  });

  console.log('[Traffic] Queue initialized');
}

/**
 * Start the traffic check worker
 */
export function startTrafficCheckWorker(): void {
  if (!connectionOptions) {
    throw new Error('Traffic check queue not initialized. Call initTrafficCheckQueue first.');
  }

  if (trafficWorker) {
    console.log('[Traffic] Worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  trafficWorker = new Worker<TrafficCheckJobData>(
    QUEUE_NAME,
    async (job: Job<TrafficCheckJobData>) => {
      const startTime = Date.now();
      try {
        await processTrafficCheck(job);
        const duration = Date.now() - startTime;
        console.log(`[Traffic] Job ${job.id} completed in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[Traffic] Job ${job.id} failed after ${duration}ms:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
    }
  );

  trafficWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[Traffic] Worker error:', error);
  });

  console.log('[Traffic] Worker started');
}

/**
 * Schedule traffic checks based on active rules.
 * Called on startup and when rules are created/updated/deleted.
 */
export async function scheduleTrafficChecks(): Promise<void> {
  if (!trafficQueue) {
    console.error('[Traffic] Queue not initialized');
    return;
  }

  // Remove any existing job schedulers
  const schedulers = await trafficQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    if (scheduler.id) {
      await trafficQueue.removeJobScheduler(scheduler.id);
    }
  }

  // Get all active rules and filter for traffic conditions
  const candidateRules = await db
    .select({
      id: rules.id,
      conditions: rules.conditions,
    })
    .from(rules)
    .where(eq(rules.isActive, true));

  const activeRules = candidateRules.filter((r) => hasTrafficCondition(r.conditions));

  if (activeRules.length === 0) {
    console.log('[Traffic] No active traffic rules found');
    return;
  }

  // Schedule a single recurring job that checks all rules hourly
  await trafficQueue.add(
    'scheduled-check',
    { type: 'check' },
    {
      repeat: {
        every: CHECK_INTERVAL_MS,
      },
      jobId: 'traffic-check-repeatable',
    }
  );

  // Schedule a delayed startup check
  await trafficQueue.add(
    'startup-check',
    { type: 'check' },
    {
      delay: STARTUP_DELAY_MS,
      jobId: `startup-${Date.now()}`,
    }
  );

  console.log(`[Traffic] Scheduled hourly checks for ${activeRules.length} rule(s)`);
}

/**
 * Process a traffic check job
 */
async function processTrafficCheck(job: Job<TrafficCheckJobData>): Promise<void> {
  console.log(`[Traffic] Processing check (job ${job.id})`);

  // Get all active rules and filter for traffic conditions
  const candidateRules = await db
    .select()
    .from(rules)
    .where(job.data.ruleId ? eq(rules.id, job.data.ruleId) : eq(rules.isActive, true));

  const activeRules = candidateRules.filter((r) => hasTrafficCondition(r.conditions));

  if (activeRules.length === 0) {
    console.log('[Traffic] No active traffic rules to check');
    return;
  }

  let totalViolations = 0;
  let totalReenabled = 0;

  for (const rule of activeRules) {
    const trafficLimit = extractTrafficLimitFromConditions(rule.conditions);
    if (!trafficLimit) {
      console.warn(
        `[Traffic] Could not extract traffic limit from rule ${rule.name} (${rule.id}), skipping`
      );
      continue;
    }

    const { limitGb, windowPeriod } = trafficLimit;
    const windowStart = getWindowStart(windowPeriod);

    console.log(
      `[Traffic] Checking rule: ${rule.name} (${rule.id}) - limit ${limitGb}GB per ${windowPeriod}`
    );

    // Get users to check based on rule scope
    let usersToCheck;
    if (rule.serverUserId) {
      usersToCheck = await db
        .select({
          id: serverUsers.id,
          username: serverUsers.username,
          serverId: serverUsers.serverId,
        })
        .from(serverUsers)
        .where(eq(serverUsers.id, rule.serverUserId));
    } else {
      usersToCheck = await db
        .select({
          id: serverUsers.id,
          username: serverUsers.username,
          serverId: serverUsers.serverId,
        })
        .from(serverUsers);
    }

    console.log(`[Traffic] Checking ${usersToCheck.length} users for rule ${rule.name}`);

    for (const user of usersToCheck) {
      const usageGb = await calculateBandwidthUsageGb(user.id, windowStart);

      // Check for existing unacknowledged traffic violation for this rule+user
      const existingViolation = await db
        .select({ id: violations.id })
        .from(violations)
        .where(
          and(
            eq(violations.serverUserId, user.id),
            eq(violations.ruleId, rule.id),
            isNull(violations.acknowledgedAt)
          )
        )
        .limit(1);

      const hasExistingViolation = existingViolation.length > 0;

      if (usageGb >= limitGb) {
        // Over limit - create violation + disable user if not already done
        if (!hasExistingViolation) {
          await createTrafficViolation(rule, user, {
            usageGb,
            limitGb,
            windowPeriod,
            windowStart: windowStart.toISOString(),
          });
          totalViolations++;

          // Disable user on media server
          try {
            const deps = getActionExecutorDeps();
            await deps.disableUser(user.id, user.serverId);
            console.log(
              `[Traffic] Disabled user ${user.username} on server ${user.serverId} (${usageGb}GB / ${limitGb}GB)`
            );
          } catch (error) {
            console.error(`[Traffic] Failed to disable user ${user.username}:`, error);
          }
        }
      } else if (hasExistingViolation) {
        // Under limit but had a violation - re-enable user and acknowledge violation
        try {
          const deps = getActionExecutorDeps();
          await deps.enableUser(user.id, user.serverId);
          console.log(
            `[Traffic] Re-enabled user ${user.username} on server ${user.serverId} (${usageGb}GB / ${limitGb}GB)`
          );
          totalReenabled++;
        } catch (error) {
          console.error(`[Traffic] Failed to re-enable user ${user.username}:`, error);
        }

        // Auto-acknowledge the old violation
        await db
          .update(violations)
          .set({ acknowledgedAt: new Date() })
          .where(eq(violations.id, existingViolation[0]!.id));

        console.log(
          `[Traffic] Auto-acknowledged violation for user ${user.username} (usage dropped to ${usageGb}GB)`
        );
      }
    }
  }

  console.log(
    `[Traffic] Check complete. Created ${totalViolations} violations, re-enabled ${totalReenabled} users.`
  );
}

/**
 * Create a traffic violation (no associated session)
 */
async function createTrafficViolation(
  rule: { id: string; name: string; type: RuleType | null },
  user: { id: string; username: string; serverId: string },
  data: { usageGb: number; limitGb: number; windowPeriod: string; windowStart: string }
): Promise<void> {
  const created = await db.transaction(async (tx) => {
    const insertedRows = await tx
      .insert(violations)
      .values({
        ruleId: rule.id,
        serverUserId: user.id,
        sessionId: null,
        severity: 'high',
        ruleType: 'maximum_traffic',
        data: {
          usageGb: data.usageGb,
          limitGb: data.limitGb,
          windowPeriod: data.windowPeriod,
          windowStart: data.windowStart,
          message: `User exceeded traffic limit: ${data.usageGb}GB / ${data.limitGb}GB (${data.windowPeriod})`,
        },
      })
      .onConflictDoNothing()
      .returning();

    return insertedRows[0];
  });

  if (!created) {
    console.log(`[Traffic] Duplicate violation prevented for user ${user.username}`);
    return;
  }

  // Get user and server details for broadcasting
  const [details] = await db
    .select({
      userId: serverUsers.id,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      serverId: servers.id,
      serverName: servers.name,
      serverType: servers.type,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(servers, eq(servers.id, serverUsers.serverId))
    .where(eq(serverUsers.id, user.id))
    .limit(1);

  if (!details) {
    console.warn(`[Traffic] Could not find details for user ${user.id}`);
    return;
  }

  // Broadcast violation event
  if (pubSubPublish) {
    const violationWithDetails: ViolationWithDetails = {
      id: created.id,
      ruleId: created.ruleId,
      serverUserId: created.serverUserId,
      sessionId: created.sessionId,
      severity: created.severity,
      data: created.data,
      acknowledgedAt: created.acknowledgedAt,
      createdAt: created.createdAt,
      user: {
        id: details.userId,
        username: details.username,
        thumbUrl: details.thumbUrl,
        serverId: details.serverId,
        identityName: details.identityName,
      },
      rule: {
        id: rule.id,
        name: rule.name,
        type: rule.type,
      },
      server: {
        id: details.serverId,
        name: details.serverName,
        type: details.serverType,
      },
    };

    await pubSubPublish(WS_EVENTS.VIOLATION_NEW, violationWithDetails);
    console.log(`[Traffic] Violation created: ${rule.name} for user ${details.username}`);

    // Enqueue notification for async dispatch
    await enqueueNotification({ type: 'violation', payload: violationWithDetails });
  }
}

/**
 * Gracefully shutdown the traffic check queue and worker
 */
export async function shutdownTrafficCheckQueue(): Promise<void> {
  console.log('[Traffic] Shutting down queue...');

  if (trafficWorker) {
    await trafficWorker.close();
    trafficWorker = null;
  }

  if (trafficQueue) {
    await trafficQueue.close();
    trafficQueue = null;
  }

  _redisClient = null;
  pubSubPublish = null;

  console.log('[Traffic] Queue shutdown complete');
}
