/**
 * Redis cache service for Tracearr
 * Handles caching of active sessions, dashboard stats, and other frequently accessed data
 */

import type { Redis } from 'ioredis';
import { REDIS_KEYS, CACHE_TTL } from '@tracearr/shared';
import type { ActiveSession, DashboardStats } from '@tracearr/shared';

export interface CacheService {
  // Active sessions (legacy - JSON array, deprecated)
  getActiveSessions(): Promise<ActiveSession[] | null>;
  setActiveSessions(sessions: ActiveSession[]): Promise<void>;

  // Active sessions (atomic SET-based operations)
  addActiveSession(session: ActiveSession): Promise<void>;
  removeActiveSession(sessionId: string): Promise<void>;
  getActiveSessionIds(): Promise<string[]>;
  getAllActiveSessions(): Promise<ActiveSession[]>;
  updateActiveSession(session: ActiveSession): Promise<void>;
  syncActiveSessions(sessions: ActiveSession[]): Promise<void>;
  incrementalSyncActiveSessions(
    newSessions: ActiveSession[],
    stoppedSessionIds: string[],
    updatedSessions: ActiveSession[]
  ): Promise<void>;

  // Dashboard stats
  getDashboardStats(): Promise<DashboardStats | null>;
  setDashboardStats(stats: DashboardStats): Promise<void>;
  invalidateDashboardStatsCache(): Promise<void>;

  // Session by ID
  getSessionById(id: string): Promise<ActiveSession | null>;
  setSessionById(id: string, session: ActiveSession): Promise<void>;
  deleteSessionById(id: string): Promise<void>;

  // User sessions
  getUserSessions(userId: string): Promise<string[] | null>;
  addUserSession(userId: string, sessionId: string): Promise<void>;
  removeUserSession(userId: string, sessionId: string): Promise<void>;

  // Server health tracking
  getServerHealth(serverId: string): Promise<boolean | null>;
  setServerHealth(serverId: string, isHealthy: boolean): Promise<void>;

  // Generic cache operations
  invalidateCache(key: string): Promise<void>;
  invalidatePattern(pattern: string): Promise<void>;

  // Health check
  ping(): Promise<boolean>;
}

export function createCacheService(redis: Redis): CacheService {
  // Helper to invalidate all dashboard stats cache keys (timezone-specific)
  // Dashboard route uses keys like tracearr:stats:dashboard:UTC or tracearr:stats:dashboard:{serverId}:{tz}
  const invalidateDashboardStats = async (): Promise<void> => {
    const pattern = `${REDIS_KEYS.DASHBOARD_STATS}:*`;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  };

  const service: CacheService = {
    // Active sessions
    async getActiveSessions(): Promise<ActiveSession[] | null> {
      const data = await redis.get(REDIS_KEYS.ACTIVE_SESSIONS);
      if (!data) return null;
      try {
        return JSON.parse(data) as ActiveSession[];
      } catch {
        return null;
      }
    },

    async setActiveSessions(sessions: ActiveSession[]): Promise<void> {
      await redis.setex(
        REDIS_KEYS.ACTIVE_SESSIONS,
        CACHE_TTL.ACTIVE_SESSIONS,
        JSON.stringify(sessions)
      );
      // Invalidate dashboard stats so they reflect the new session count
      await invalidateDashboardStats();
    },

    // Atomic SET-based operations for active sessions
    async addActiveSession(session: ActiveSession): Promise<void> {
      const pipeline = redis.multi();
      // Add session ID to the active sessions SET
      pipeline.sadd(REDIS_KEYS.ACTIVE_SESSION_IDS, session.id);
      // Set TTL on the SET (refreshed on each add)
      pipeline.expire(REDIS_KEYS.ACTIVE_SESSION_IDS, CACHE_TTL.ACTIVE_SESSIONS);
      // Store session data
      pipeline.setex(
        REDIS_KEYS.SESSION_BY_ID(session.id),
        CACHE_TTL.ACTIVE_SESSIONS,
        JSON.stringify(session)
      );
      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err !== null)) {
        console.error('[Cache] addActiveSession pipeline failed:', results);
      }
      // Invalidate dashboard stats (uses pattern matching for timezone-specific keys)
      await invalidateDashboardStats();
    },

    async removeActiveSession(sessionId: string): Promise<void> {
      const pipeline = redis.multi();
      // Remove from active sessions SET (atomic)
      pipeline.srem(REDIS_KEYS.ACTIVE_SESSION_IDS, sessionId);
      // Remove session data
      pipeline.del(REDIS_KEYS.SESSION_BY_ID(sessionId));
      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err !== null)) {
        console.error('[Cache] removeActiveSession pipeline failed:', results);
      }
      // Invalidate dashboard stats (uses pattern matching for timezone-specific keys)
      await invalidateDashboardStats();
    },

    async getActiveSessionIds(): Promise<string[]> {
      return await redis.smembers(REDIS_KEYS.ACTIVE_SESSION_IDS);
    },

    async getAllActiveSessions(): Promise<ActiveSession[]> {
      const ids = await redis.smembers(REDIS_KEYS.ACTIVE_SESSION_IDS);
      if (ids.length === 0) return [];

      // Chunk MGET calls to prevent Redis blocking with large sets
      const CHUNK_SIZE = 100;
      const sessions: ActiveSession[] = [];
      const staleIds: string[] = [];

      for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
        const chunkIds = ids.slice(i, i + CHUNK_SIZE);
        const keys = chunkIds.map((id) => REDIS_KEYS.SESSION_BY_ID(id));
        const data = await redis.mget(...keys);

        for (let j = 0; j < data.length; j++) {
          const sessionData = data[j];
          const sessionId = chunkIds[j]!;
          if (sessionData) {
            try {
              sessions.push(JSON.parse(sessionData) as ActiveSession);
            } catch {
              staleIds.push(sessionId);
            }
          } else {
            // Double-check data doesn't exist now (prevents race with concurrent adds)
            const exists = await redis.exists(REDIS_KEYS.SESSION_BY_ID(sessionId));
            if (!exists) {
              staleIds.push(sessionId);
            }
          }
        }
      }

      // Batch cleanup stale IDs
      if (staleIds.length > 0) {
        await redis.srem(REDIS_KEYS.ACTIVE_SESSION_IDS, ...staleIds);
      }

      return sessions;
    },

    async updateActiveSession(session: ActiveSession): Promise<void> {
      // Update session data and refresh SET TTL to prevent stale ID accumulation
      const pipeline = redis.multi();
      pipeline.setex(
        REDIS_KEYS.SESSION_BY_ID(session.id),
        CACHE_TTL.ACTIVE_SESSIONS,
        JSON.stringify(session)
      );
      // Refresh SET TTL to match session data TTL
      pipeline.expire(REDIS_KEYS.ACTIVE_SESSION_IDS, CACHE_TTL.ACTIVE_SESSIONS);
      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err !== null)) {
        console.error('[Cache] updateActiveSession pipeline failed:', results);
      }
    },

    async syncActiveSessions(sessions: ActiveSession[]): Promise<void> {
      // Full sync: replace all active sessions atomically
      const pipeline = redis.multi();

      // Delete old SET
      pipeline.del(REDIS_KEYS.ACTIVE_SESSION_IDS);

      if (sessions.length > 0) {
        // Add all session IDs to SET
        pipeline.sadd(REDIS_KEYS.ACTIVE_SESSION_IDS, ...sessions.map((s) => s.id));
        pipeline.expire(REDIS_KEYS.ACTIVE_SESSION_IDS, CACHE_TTL.ACTIVE_SESSIONS);

        // Store each session's data
        for (const session of sessions) {
          pipeline.setex(
            REDIS_KEYS.SESSION_BY_ID(session.id),
            CACHE_TTL.ACTIVE_SESSIONS,
            JSON.stringify(session)
          );
        }
      }

      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err !== null)) {
        console.error('[Cache] syncActiveSessions pipeline failed:', results);
      }
      // Invalidate dashboard stats (uses pattern matching for timezone-specific keys)
      await invalidateDashboardStats();
    },

    async incrementalSyncActiveSessions(
      newSessions: ActiveSession[],
      stoppedSessionIds: string[],
      updatedSessions: ActiveSession[]
    ): Promise<void> {
      const hasChanges =
        newSessions.length > 0 || stoppedSessionIds.length > 0 || updatedSessions.length > 0;
      if (!hasChanges) return;

      const pipeline = redis.multi();

      // Add new sessions to SET and store their data
      for (const session of newSessions) {
        pipeline.sadd(REDIS_KEYS.ACTIVE_SESSION_IDS, session.id);
        pipeline.setex(
          REDIS_KEYS.SESSION_BY_ID(session.id),
          CACHE_TTL.ACTIVE_SESSIONS,
          JSON.stringify(session)
        );
      }

      // Remove stopped sessions from SET and delete their data
      for (const sessionId of stoppedSessionIds) {
        pipeline.srem(REDIS_KEYS.ACTIVE_SESSION_IDS, sessionId);
        pipeline.del(REDIS_KEYS.SESSION_BY_ID(sessionId));
      }

      // Update existing session data (already in SET)
      for (const session of updatedSessions) {
        pipeline.setex(
          REDIS_KEYS.SESSION_BY_ID(session.id),
          CACHE_TTL.ACTIVE_SESSIONS,
          JSON.stringify(session)
        );
      }

      // Refresh SET TTL if we have active sessions
      if (newSessions.length > 0 || updatedSessions.length > 0) {
        pipeline.expire(REDIS_KEYS.ACTIVE_SESSION_IDS, CACHE_TTL.ACTIVE_SESSIONS);
      }

      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err !== null)) {
        console.error('[Cache] incrementalSyncActiveSessions pipeline failed:', results);
      }
      // Invalidate dashboard stats (uses pattern matching for timezone-specific keys)
      await invalidateDashboardStats();
    },

    // Dashboard stats
    async getDashboardStats(): Promise<DashboardStats | null> {
      const data = await redis.get(REDIS_KEYS.DASHBOARD_STATS);
      if (!data) return null;
      try {
        return JSON.parse(data) as DashboardStats;
      } catch {
        return null;
      }
    },

    async setDashboardStats(stats: DashboardStats): Promise<void> {
      await redis.setex(
        REDIS_KEYS.DASHBOARD_STATS,
        CACHE_TTL.DASHBOARD_STATS,
        JSON.stringify(stats)
      );
    },

    async invalidateDashboardStatsCache(): Promise<void> {
      await invalidateDashboardStats();
    },

    // Session by ID
    async getSessionById(id: string): Promise<ActiveSession | null> {
      const data = await redis.get(REDIS_KEYS.SESSION_BY_ID(id));
      if (!data) return null;
      try {
        return JSON.parse(data) as ActiveSession;
      } catch {
        return null;
      }
    },

    async setSessionById(id: string, session: ActiveSession): Promise<void> {
      await redis.setex(
        REDIS_KEYS.SESSION_BY_ID(id),
        CACHE_TTL.ACTIVE_SESSIONS,
        JSON.stringify(session)
      );
    },

    async deleteSessionById(id: string): Promise<void> {
      await redis.del(REDIS_KEYS.SESSION_BY_ID(id));
    },

    // User sessions (set of session IDs for a user)
    async getUserSessions(userId: string): Promise<string[] | null> {
      const data = await redis.smembers(REDIS_KEYS.USER_SESSIONS(userId));
      if (!data || data.length === 0) return null;
      return data;
    },

    async addUserSession(userId: string, sessionId: string): Promise<void> {
      const key = REDIS_KEYS.USER_SESSIONS(userId);
      await redis.sadd(key, sessionId);
      await redis.expire(key, CACHE_TTL.USER_SESSIONS);
    },

    async removeUserSession(userId: string, sessionId: string): Promise<void> {
      await redis.srem(REDIS_KEYS.USER_SESSIONS(userId), sessionId);
    },

    // Server health tracking
    async getServerHealth(serverId: string): Promise<boolean | null> {
      const data = await redis.get(REDIS_KEYS.SERVER_HEALTH(serverId));
      if (data === null) return null;
      return data === 'true';
    },

    async setServerHealth(serverId: string, isHealthy: boolean): Promise<void> {
      await redis.setex(
        REDIS_KEYS.SERVER_HEALTH(serverId),
        CACHE_TTL.SERVER_HEALTH,
        isHealthy ? 'true' : 'false'
      );
    },

    // Generic cache operations
    async invalidateCache(key: string): Promise<void> {
      await redis.del(key);
    },

    async invalidatePattern(pattern: string): Promise<void> {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    },

    // Health check
    async ping(): Promise<boolean> {
      try {
        const result = await redis.ping();
        return result === 'PONG';
      } catch {
        return false;
      }
    },
  };

  // Store instance for global access
  cacheServiceInstance = service;

  return service;
}

// Pub/Sub helper functions for real-time events
export interface PubSubService {
  publish(event: string, data: unknown): Promise<void>;
  subscribe(channel: string, callback: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}

// Module-level storage for service instances
let pubSubServiceInstance: PubSubService | null = null;
let cacheServiceInstance: CacheService | null = null;

/**
 * Get the global PubSub service instance
 * Must be called after createPubSubService has been called
 */
export function getPubSubService(): PubSubService | null {
  return pubSubServiceInstance;
}

/**
 * Get the global Cache service instance
 * Must be called after createCacheService has been called
 */
export function getCacheService(): CacheService | null {
  return cacheServiceInstance;
}

export function createPubSubService(publisher: Redis, subscriber: Redis): PubSubService {
  const callbacks = new Map<string, (message: string) => void>();

  subscriber.on('message', (channel: string, message: string) => {
    const callback = callbacks.get(channel);
    if (callback) {
      callback(message);
    }
  });

  const service: PubSubService = {
    async publish(event: string, data: unknown): Promise<void> {
      await publisher.publish(
        REDIS_KEYS.PUBSUB_EVENTS,
        JSON.stringify({ event, data, timestamp: Date.now() })
      );
    },

    async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
      callbacks.set(channel, callback);
      await subscriber.subscribe(channel);
    },

    async unsubscribe(channel: string): Promise<void> {
      callbacks.delete(channel);
      await subscriber.unsubscribe(channel);
    },
  };

  // Store instance for global access
  pubSubServiceInstance = service;

  return service;
}

// ============================================================================
// Atomic Cache Helpers
// ============================================================================

/**
 * Execute DB operation with cache invalidation.
 * Pattern: Invalidate → Execute → Invalidate again
 * Prevents stale reads during and after operation.
 *
 * @param redis - Redis client
 * @param keysToInvalidate - Cache keys to invalidate
 * @param operation - Async operation to execute
 * @returns Result of the operation
 *
 * @example
 * await withCacheInvalidation(redis, [REDIS_KEYS.ACTIVE_SESSIONS], async () => {
 *   return await db.insert(sessions).values(data);
 * });
 */
export async function withCacheInvalidation<T>(
  redis: Redis,
  keysToInvalidate: string[],
  operation: () => Promise<T>
): Promise<T> {
  // Invalidate before (prevents stale reads during operation)
  if (keysToInvalidate.length > 0) {
    await redis.del(...keysToInvalidate);
  }

  // Execute the operation
  const result = await operation();

  // Invalidate after (catches concurrent writes)
  if (keysToInvalidate.length > 0) {
    await redis.del(...keysToInvalidate);
  }

  return result;
}

/**
 * Atomic cache update with distributed lock.
 * Prevents race conditions when multiple processes update same key.
 *
 * @param redis - Redis client
 * @param key - Cache key to update
 * @param ttl - TTL in seconds
 * @param getData - Async function to get fresh data
 * @returns Cached or fresh data
 *
 * @example
 * const stats = await atomicCacheUpdate(redis, 'dashboard:stats', 60, async () => {
 *   return await computeDashboardStats();
 * });
 */
export async function atomicCacheUpdate<T>(
  redis: Redis,
  key: string,
  ttl: number,
  getData: () => Promise<T>
): Promise<T> {
  const lockKey = `${key}:lock`;

  // Try to acquire lock (5 second expiry)
  const lockAcquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');

  if (!lockAcquired) {
    // Another process is updating, wait and read cached value
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
    // Cache miss, try again (recursive call)
    return atomicCacheUpdate(redis, key, ttl, getData);
  }

  try {
    const data = await getData();
    await redis.setex(key, ttl, JSON.stringify(data));
    return data;
  } finally {
    await redis.del(lockKey);
  }
}

/**
 * Atomic multi-key update using Redis MULTI/EXEC.
 * All updates succeed or fail together.
 *
 * @param redis - Redis client
 * @param updates - Array of key/value/ttl updates
 *
 * @example
 * await atomicMultiUpdate(redis, [
 *   { key: REDIS_KEYS.ACTIVE_SESSIONS, value: sessions, ttl: 300 },
 *   { key: REDIS_KEYS.DASHBOARD_STATS, value: stats, ttl: 60 },
 * ]);
 */
export async function atomicMultiUpdate(
  redis: Redis,
  updates: Array<{ key: string; value: unknown; ttl: number }>
): Promise<void> {
  const pipeline = redis.multi();

  for (const { key, value, ttl } of updates) {
    pipeline.setex(key, ttl, JSON.stringify(value));
  }

  await pipeline.exec();
}
