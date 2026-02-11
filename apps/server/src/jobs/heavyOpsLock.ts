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
const LOCK_TTL_SECONDS = 4 * 60 * 60; // 4 hours max (safety net)

export interface HeavyOpsLockHolder {
  jobType: 'import' | 'maintenance';
  jobId: string;
  description: string;
  startedAt: string;
}

let redisClient: Redis | null = null;

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
        `[HeavyOpsLock] Lock will be validated when jobs try to acquire it (reacquisition supported)`
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
 * @returns null if lock acquired, or HeavyOpsLockHolder if blocked
 */
export async function acquireHeavyOpsLock(
  jobType: 'import' | 'maintenance',
  jobId: string,
  description: string
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
  };

  // Try to set the lock with NX (only if not exists)
  const result = await redisClient.set(
    REDIS_KEYS.HEAVY_OPS_LOCK,
    JSON.stringify(lockData),
    'EX',
    LOCK_TTL_SECONDS,
    'NX'
  );

  if (result === 'OK') {
    console.log(`[HeavyOpsLock] Acquired lock for ${jobType} job ${jobId}: ${description}`);
    return null; // Lock acquired
  }

  // Lock is held - check if it's us (reacquiring after restart) or someone else
  const existingLock = await redisClient.get(REDIS_KEYS.HEAVY_OPS_LOCK);
  if (existingLock) {
    try {
      const holder = JSON.parse(existingLock) as HeavyOpsLockHolder;

      // If this job already holds the lock (e.g., after server restart), reacquire it
      if (holder.jobId === jobId) {
        console.log(
          `[HeavyOpsLock] Reacquiring lock for ${jobType} job ${jobId} (was held from previous run)`
        );
        // Update the lock with fresh TTL
        await redisClient.set(
          REDIS_KEYS.HEAVY_OPS_LOCK,
          JSON.stringify(lockData),
          'EX',
          LOCK_TTL_SECONDS
        );
        return null; // Lock reacquired
      }

      console.log(
        `[HeavyOpsLock] Lock held by ${holder.jobType} job ${holder.jobId}: ${holder.description}`
      );
      return holder;
    } catch {
      // Corrupt lock data - try to clean it up
      console.warn('[HeavyOpsLock] Corrupt lock data, attempting cleanup');
      await redisClient.del(REDIS_KEYS.HEAVY_OPS_LOCK);
      return null;
    }
  }

  // Lock disappeared between check and get - race condition, retry would succeed
  return null;
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

  // Get current lock to verify ownership
  const existingLock = await redisClient.get(REDIS_KEYS.HEAVY_OPS_LOCK);
  if (!existingLock) {
    return true; // Already released
  }

  try {
    const holder = JSON.parse(existingLock) as HeavyOpsLockHolder;
    if (holder.jobId !== jobId) {
      console.warn(
        `[HeavyOpsLock] Attempted to release lock held by different job: ${holder.jobId}`
      );
      return false;
    }
  } catch {
    // Corrupt data - clean it up
  }

  await redisClient.del(REDIS_KEYS.HEAVY_OPS_LOCK);
  console.log(`[HeavyOpsLock] Released lock for job ${jobId}`);
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
 */
export async function extendHeavyOpsLock(jobId: string): Promise<boolean> {
  if (!redisClient) {
    return true;
  }

  const existingLock = await redisClient.get(REDIS_KEYS.HEAVY_OPS_LOCK);
  if (!existingLock) {
    return false; // Lock was lost
  }

  try {
    const holder = JSON.parse(existingLock) as HeavyOpsLockHolder;
    if (holder.jobId !== jobId) {
      return false; // Not our lock
    }
  } catch {
    return false;
  }

  await redisClient.expire(REDIS_KEYS.HEAVY_OPS_LOCK, LOCK_TTL_SECONDS);
  return true;
}
