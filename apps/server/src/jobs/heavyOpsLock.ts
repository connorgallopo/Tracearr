/**
 * Heavy Operations Lock - Redis-based coordination for heavy DB operations
 *
 * Prevents Import and Maintenance jobs from running concurrently by using
 * a Redis-based lock. When a job tries to start while another is running,
 * it can see what it's waiting for (for UI display).
 *
 * This prevents lock exhaustion and resource contention when multiple
 * heavy TimescaleDB operations try to run simultaneously.
 */

import type { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';

/** How often a live holder's heartbeat renews the lock - see startHeavyOpsLockHeartbeat. */
export const HEAVY_OPS_HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Small multiple of the heartbeat interval, so a crashed holder expires in minutes, not the old 4-hour safety net.
const LOCK_TTL_SECONDS = (HEAVY_OPS_HEARTBEAT_INTERVAL_MS / 1000) * 4;

export interface HeavyOpsLockHolder {
  jobType: 'import' | 'maintenance';
  jobId: string;
  description: string;
  startedAt: string;
  /**
   * Generated once per processor invocation (not per job.id). job.id alone
   * can't prove ownership - a second concurrent run of the same job.id would
   * match it too. Only a matching runToken proves this exact call is the one
   * that took the lock.
   */
  runToken: string;
}

let redisClient: Redis | null = null;

/** Compare-and-delete on jobId (see releaseLockIfHeld in cache.ts for the same pattern). Corrupt data is wiped unconditionally like the old non-atomic path did. Returns 2 = already gone, 1 = released, 0 = held by a different jobId (second array element carries that jobId). */
const RELEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {2, ''}
end
local ok, holder = pcall(cjson.decode, raw)
if not ok or type(holder) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return {1, ''}
end
if holder.jobId ~= ARGV[1] then
  return {0, holder.jobId}
end
redis.call('DEL', KEYS[1])
return {1, ''}
`;

/** Compare-and-expire on jobId and, when ARGV[2] is non-empty, runToken too. Returns 1 = extended, 0 = not held (or held by someone else). */
const EXTEND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local ok, holder = pcall(cjson.decode, raw)
if not ok or type(holder) ~= 'table' then
  return 0
end
if holder.jobId ~= ARGV[1] then
  return 0
end
if ARGV[2] ~= '' and holder.runToken ~= ARGV[2] then
  return 0
end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

/** Compare-and-set on jobId+runToken (own run reacquiring after a failed NX). Returns {2, ''} = key gone, {3, ''} = corrupt data cleared, {1, ''} = reacquired, {0, raw holder json} = held by someone else. */
const REACQUIRE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {2, ''}
end
local ok, holder = pcall(cjson.decode, raw)
if not ok or type(holder) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return {3, ''}
end
if holder.jobId == ARGV[1] and holder.runToken == ARGV[2] then
  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
  return {1, ''}
end
return {0, raw}
`;

/**
 * Initialize the heavy ops lock with a Redis client.
 * Also cleans up any stale locks from previous server instances.
 */
export async function initHeavyOpsLock(redis: Redis): Promise<void> {
  redisClient = redis;

  // Clean up stale lock from previous server instance
  const existingLock = await redis.get(REDIS_KEYS.HEAVY_OPS_LOCK);
  if (existingLock) {
    try {
      const holder = JSON.parse(existingLock) as HeavyOpsLockHolder;
      console.log(
        `[HeavyOpsLock] Found existing lock from ${holder.jobType} job ${holder.jobId}: ${holder.description}`
      );
      console.log(
        `[HeavyOpsLock] This process's own run token won't match it, so it can't reacquire this ` +
          `lock - it will free itself within ${LOCK_TTL_SECONDS}s if the previous holder is gone`
      );
    } catch {
      // Corrupt lock - clear it
      console.warn('[HeavyOpsLock] Found corrupt lock on startup, clearing');
      await redis.del(REDIS_KEYS.HEAVY_OPS_LOCK);
    }
  }
}

/**
 * Try to acquire the heavy operations lock.
 *
 * `runToken` must be generated once per processor invocation (not reused
 * across retries or loop iterations of a different run) and passed in on
 * every call this run makes. It's what lets the reacquire-by-jobId path
 * below tell "this exact run already holds it" apart from "a different run
 * of the same job.id holds it" - job.id alone is ambiguous, since a second
 * concurrent run of the same job.id (a stalled-detection race, for example)
 * has the identical job.id and would otherwise pass the old check too,
 * letting both runs proceed and write concurrently.
 *
 * Fail-CLOSED: without a matching runToken, an existing lock for the same
 * job.id is treated as held by someone else (the caller waits/skips per the
 * existing contract) rather than optimistically reacquired.
 *
 * Retries the SET NX up to twice: if the holder we saw at SET time turns out
 * to be gone or corrupt by the time we GET it, a null return must still mean
 * this call's own SET actually wrote the key, not that the gap was read as
 * "nobody holds it."
 *
 * An import that loses the try is marked as waiting, for the library growth backfill to see.
 *
 * @returns null if lock acquired, or HeavyOpsLockHolder if blocked
 */
export async function acquireHeavyOpsLock(
  jobType: 'import' | 'maintenance',
  jobId: string,
  description: string,
  runToken: string
): Promise<HeavyOpsLockHolder | null> {
  const holder = await takeHeavyOpsLock(jobType, jobId, description, runToken);
  if (jobType === 'import') {
    await (holder ? markImportWaiting(jobId) : clearImportWaiting(jobId));
  }
  return holder;
}

async function takeHeavyOpsLock(
  jobType: 'import' | 'maintenance',
  jobId: string,
  description: string,
  runToken: string
): Promise<HeavyOpsLockHolder | null> {
  if (!redisClient) {
    console.warn('[HeavyOpsLock] Redis not initialized, allowing operation');
    return null;
  }

  const lockData: HeavyOpsLockHolder = {
    jobType,
    jobId,
    description,
    startedAt: new Date().toISOString(),
    runToken,
  };

  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await redisClient.set(
      REDIS_KEYS.HEAVY_OPS_LOCK,
      JSON.stringify(lockData),
      'EX',
      LOCK_TTL_SECONDS,
      'NX'
    );

    if (result === 'OK') {
      console.log(`[HeavyOpsLock] Acquired lock for ${jobType} job ${jobId}: ${description}`);
      return null;
    }

    // Lock is held - atomically check if it's this exact run reacquiring, or someone else.
    const [status, payload] = (await redisClient.eval(
      REACQUIRE_SCRIPT,
      1,
      REDIS_KEYS.HEAVY_OPS_LOCK,
      jobId,
      runToken,
      JSON.stringify(lockData),
      LOCK_TTL_SECONDS
    )) as [number, string];

    if (status === 2) {
      continue;
    }

    if (status === 3) {
      console.warn('[HeavyOpsLock] Corrupt lock data, attempting cleanup');
      continue;
    }

    if (status === 1) {
      console.log(`[HeavyOpsLock] Reacquiring lock for ${jobType} job ${jobId} (own run)`);
      return null;
    }

    let holder: HeavyOpsLockHolder;
    try {
      holder = JSON.parse(payload) as HeavyOpsLockHolder;
    } catch {
      console.warn('[HeavyOpsLock] Corrupt lock data, attempting cleanup');
      await redisClient.del(REDIS_KEYS.HEAVY_OPS_LOCK);
      continue;
    }

    console.log(
      `[HeavyOpsLock] Lock held by ${holder.jobType} job ${holder.jobId}: ${holder.description}`
    );
    return holder;
  }

  console.warn(
    `[HeavyOpsLock] Lock state kept changing under us for job ${jobId}; blocking this attempt`
  );
  return {
    jobType,
    jobId: 'unknown',
    description: 'Lock state temporarily indeterminate, retry shortly',
    startedAt: new Date().toISOString(),
    runToken: '',
  };
}

/**
 * Release the heavy operations lock.
 *
 * Only releases if the lock is held by the specified jobId (prevents
 * accidentally releasing another job's lock).
 */
export async function releaseHeavyOpsLock(jobId: string): Promise<boolean> {
  if (!redisClient) {
    return true;
  }

  const [status, heldBy] = (await redisClient.eval(
    RELEASE_SCRIPT,
    1,
    REDIS_KEYS.HEAVY_OPS_LOCK,
    jobId
  )) as [number, string];

  if (status === 0) {
    console.warn(`[HeavyOpsLock] Attempted to release lock held by different job: ${heldBy}`);
    return false;
  }

  if (status === 1) {
    console.log(`[HeavyOpsLock] Released lock for job ${jobId}`);
  }

  return true;
}

/**
 * Get the current lock holder (if any).
 *
 * Used by UI to show what a waiting job is blocked by.
 */
export async function getHeavyOpsStatus(): Promise<HeavyOpsLockHolder | null> {
  if (!redisClient) {
    return null;
  }

  const existingLock = await redisClient.get(REDIS_KEYS.HEAVY_OPS_LOCK);
  if (!existingLock) {
    return null;
  }

  try {
    return JSON.parse(existingLock) as HeavyOpsLockHolder;
  } catch {
    return null;
  }
}

/**
 * Force clear the lock (admin operation for stuck locks).
 */
export async function forceReleaseHeavyOpsLock(): Promise<void> {
  if (!redisClient) {
    return;
  }

  const existingLock = await redisClient.get(REDIS_KEYS.HEAVY_OPS_LOCK);
  if (existingLock) {
    console.warn('[HeavyOpsLock] Force releasing lock:', existingLock);
  }
  await redisClient.del(REDIS_KEYS.HEAVY_OPS_LOCK);
}

/**
 * Extend the lock TTL (call periodically during long operations).
 *
 * `runToken` is optional for backward compatibility with in-loop manual
 * extend calls that only know their jobId. When passed, it's checked
 * against the current holder like acquire does, so a stalled run's old
 * runToken can't renew a lock a retried run (same jobId, new runToken)
 * now holds.
 */
export async function extendHeavyOpsLock(jobId: string, runToken?: string): Promise<boolean> {
  if (!redisClient) {
    return true;
  }

  const result = await redisClient.eval(
    EXTEND_SCRIPT,
    1,
    REDIS_KEYS.HEAVY_OPS_LOCK,
    jobId,
    runToken ?? '',
    LOCK_TTL_SECONDS
  );

  return result === 1;
}

/** How often a job waiting for the lock tries it again. */
export const HEAVY_OPS_WAIT_INTERVAL_MS = 5000;

// A few tries long, so a waiting import never looks gone between two of its tries.
const IMPORT_WAITING_TTL_SECONDS = (HEAVY_OPS_WAIT_INTERVAL_MS / 1000) * 3;

async function markImportWaiting(jobId: string): Promise<void> {
  await redisClient?.set(
    REDIS_KEYS.HEAVY_OPS_IMPORT_WAITING,
    jobId,
    'EX',
    IMPORT_WAITING_TTL_SECONDS
  );
}

/** The import took the lock. Another import's mark is left alone. */
async function clearImportWaiting(jobId: string): Promise<void> {
  if ((await redisClient?.get(REDIS_KEYS.HEAVY_OPS_IMPORT_WAITING)) === jobId) {
    await redisClient?.del(REDIS_KEYS.HEAVY_OPS_IMPORT_WAITING);
  }
}

/** True while an import waits for the lock; the library growth backfill gives the lock up to it. */
export async function isImportWaiting(): Promise<boolean> {
  return Boolean(await redisClient?.get(REDIS_KEYS.HEAVY_OPS_IMPORT_WAITING));
}

/** Renews the heavy ops lock on a fixed cadence for a job run's lifetime - stop it once the lock is released. */
export function startHeavyOpsLockHeartbeat(jobId: string, runToken: string): () => void {
  const timer = setInterval(() => {
    void extendHeavyOpsLock(jobId, runToken);
  }, HEAVY_OPS_HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}
