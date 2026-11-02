/**
 * Sizes the pg pool from postgres's real max_connections and the live
 * instance count (registered via shared Redis), so multiple instances split
 * the cap instead of each taking the full default of 50. An explicit
 * DATABASE_POOL_MAX disables the auto budget.
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { getRedisPrefix } from '@tracearr/shared';
import { db, setPoolMax, getPoolMax } from '../db/client.js';

const HEARTBEAT_MS = 30_000;
const INSTANCE_TTL_MS = 3 * HEARTBEAT_MS;
/** Superuser/maintenance slots plus this app's transient raw pg clients */
const RESERVED_CONNECTIONS = 8;
const MIN_POOL = 5;
const MAX_POOL = 50;

const instanceId = randomUUID();
let heartbeatTimer: NodeJS.Timeout | null = null;

function registryKey(): string {
  return `${getRedisPrefix()}tracearr:instances`;
}

/** Fair per-instance pool size for a given cap and instance count. Exported for tests. */
export function computePoolShare(maxConnections: number, instanceCount: number): number {
  const usable = maxConnections - RESERVED_CONNECTIONS;
  const share = Math.floor(usable / Math.max(1, instanceCount));
  return Math.min(MAX_POOL, Math.max(MIN_POOL, share));
}

async function readMaxConnections(): Promise<number | null> {
  try {
    const result = await db.execute(sql`SHOW max_connections`);
    const raw = (result.rows[0] as { max_connections?: string } | undefined)?.max_connections;
    const value = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch (err) {
    console.warn('[ConnectionBudget] Could not read max_connections:', err);
    return null;
  }
}

/** Heartbeat this instance into the shared registry and count the live ones */
async function refreshRegistry(redis: Redis): Promise<number> {
  const key = registryKey();
  const now = Date.now();
  await redis.zadd(key, now, instanceId);
  await redis.zremrangebyscore(key, '-inf', now - INSTANCE_TTL_MS);
  const count = await redis.zcard(key);
  await redis.pexpire(key, INSTANCE_TTL_MS * 2);
  return Math.max(1, count);
}

async function tick(redis: Redis): Promise<void> {
  // Re-read the cap each tick: a retuned postgres propagates without an app restart
  const maxConnections = await readMaxConnections();
  if (maxConnections === null) return;

  const instances = await refreshRegistry(redis);
  const share = computePoolShare(maxConnections, instances);
  if (share !== getPoolMax()) {
    console.log(
      `[ConnectionBudget] Pool sized to ${share} ` +
        `(max_connections=${maxConnections}, instances=${instances}, reserved=${RESERVED_CONNECTIONS})`
    );
    const unclamped = Math.floor((maxConnections - RESERVED_CONNECTIONS) / Math.max(1, instances));
    if (unclamped < MIN_POOL) {
      console.warn(
        `[ConnectionBudget] max_connections=${maxConnections} is very low for ${instances} instance(s) - the fair share is ${unclamped} but the pool floors at ${MIN_POOL}, which oversubscribes the cap; raise max_connections`
      );
    }
    setPoolMax(share);
  }
}

export async function startConnectionBudget(redis: Redis): Promise<void> {
  if (process.env.DATABASE_POOL_MAX) {
    const configured = Number(process.env.DATABASE_POOL_MAX);
    const maxConnections = await readMaxConnections();
    if (maxConnections !== null && configured > maxConnections - RESERVED_CONNECTIONS) {
      console.warn(
        `[ConnectionBudget] DATABASE_POOL_MAX=${configured} exceeds postgres max_connections=${maxConnections} ` +
          `minus ${RESERVED_CONNECTIONS} reserved - expect "sorry, too many clients already" under load`
      );
    }
    console.log(
      `[ConnectionBudget] Using explicit DATABASE_POOL_MAX=${configured}, auto budget off`
    );
    return;
  }

  await tick(redis);
  heartbeatTimer = setInterval(() => {
    tick(redis).catch((err: unknown) => console.warn('[ConnectionBudget] Heartbeat failed:', err));
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
}

export async function stopConnectionBudget(redis?: Redis): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (redis) {
    await redis.zrem(registryKey(), instanceId).catch(() => undefined);
  }
}
