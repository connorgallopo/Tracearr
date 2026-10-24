/**
 * Redis cache service for Tracearr
 * Handles caching of active sessions, dashboard stats, and other frequently accessed data
 */

import type { ActiveSession, ServerConnectionStatus, ServerDownReason } from '@tracearr/shared';
import { CACHE_TTL, REDIS_KEYS } from '@tracearr/shared';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { createLogger } from '../utils/logger.js';
import type { PendingSessionData } from '../jobs/poller/types.js';
import { PUBLIC_CHANNEL_EVENTS, publishPublicEvent } from './publicEvents/channel.js';

const cacheLogger = createLogger('Cache');

export interface CacheService {
  // Active sessions (atomic SET-based operations)
  addActiveSession(session: ActiveSession): Promise<void>;
  // skipDashboardInvalidation: for callers removing many sessions in one wave
  // (grace/stale sweeps) - they invalidate once after the loop instead of
  // paying a SCAN per removal.
  removeActiveSession(
    sessionId: string,
    opts?: { skipDashboardInvalidation?: boolean }
  ): Promise<void>;
  getActiveSessionIds(): Promise<string[]>;
  getAllActiveSessions(): Promise<ActiveSession[]>;
  updateActiveSession(session: ActiveSession): Promise<void>;
  incrementalSyncActiveSessions(
    newSessions: ActiveSession[],
    stoppedSessionIds: string[],
    updatedSessions: ActiveSession[],
    watchedTransitionOccurred?: boolean
  ): Promise<void>;

  // Dashboard stats
  invalidateDashboardStatsCache(): Promise<void>;

  // Public API v2 per-media stats/watchers (TTL-based, no active invalidation)
  getMediaStats<T>(cacheKey: string): Promise<T | null>;
  setMediaStats(cacheKey: string, value: unknown): Promise<void>;

  // Session by ID
  getSessionById(id: string): Promise<ActiveSession | null>;

  // Server health tracking
  getServerHealth(serverId: string): Promise<boolean | null>;
  /** Swaps in one step and returns the health it replaced, so concurrent writers see one transition. */
  setServerHealth(
    serverId: string,
    isHealthy: boolean,
    reason?: ServerDownReason
  ): Promise<boolean | null>;
  getServerDownReason(serverId: string): Promise<ServerDownReason | null>;
  incrServerFailCount(serverId: string): Promise<number>;
  resetServerFailCount(serverId: string): Promise<void>;

  // Server connection status (live runtime state, not persisted to DB)
  getServerConnectionStatus(serverId: string): Promise<ServerConnectionStatus | null>;
  setServerConnectionStatus(serverId: string, status: ServerConnectionStatus): Promise<void>;

  // Generic cache operations
  invalidateCache(key: string): Promise<void>;
  invalidatePattern(pattern: string): Promise<void>;

  // Session creation lock (prevents SSE/Poller race condition)
  withSessionCreateLock<T>(
    serverId: string,
    sessionKey: string,
    operation: () => Promise<T>
  ): Promise<T | null>;

  // Termination cooldown (prevents re-creating recently terminated sessions)
  setTerminationCooldown(serverId: string, sessionKey: string, ratingKey: string): Promise<void>;
  hasTerminationCooldown(serverId: string, sessionKey: string, ratingKey: string): Promise<boolean>;
  setTerminationCooldownComposite(
    serverId: string,
    serverUserId: string,
    deviceId: string,
    ratingKey: string
  ): Promise<void>;
  hasTerminationCooldownComposite(
    serverId: string,
    serverUserId: string,
    deviceId: string,
    ratingKey: string
  ): Promise<boolean>;

  // Pending sessions (Redis-first, not yet in DB)
  // Sessions stay here until 30s confirmation threshold, then persist to DB
  getPendingSession(serverId: string, sessionKey: string): Promise<PendingSessionData | null>;
  setPendingSession(serverId: string, sessionKey: string, data: PendingSessionData): Promise<void>;
  deletePendingSession(serverId: string, sessionKey: string): Promise<void>;
  getAllPendingSessionKeys(): Promise<Array<{ serverId: string; sessionKey: string }>>;

  // Session write retry queue (for failed DB writes during session stop)
  addSessionWriteRetry(
    sessionId: string,
    startedAt: number,
    stopData: { stoppedAt: number; forceStopped: boolean }
  ): Promise<void>;
  getSessionWriteRetries(): Promise<
    Array<{
      sessionId: string;
      attempts: number;
      startedAt?: number;
      stopData: { stoppedAt: number; forceStopped: boolean };
    }>
  >;
  incrementSessionWriteRetry(sessionId: string): Promise<number>;
  removeSessionWriteRetry(sessionId: string): Promise<void>;

  // Filter options caching (TTL-based, no active invalidation needed)
  getFilterOptions(userId: string, scopeHash: string): Promise<string | null>;
  setFilterOptions(userId: string, scopeHash: string, data: string): Promise<void>;

  getPlexGeoipCache(ip: string): Promise<string | null>;
  setPlexGeoipCache(ip: string, data: string, ttlSeconds: number): Promise<void>;

  // Health check
  ping(): Promise<boolean>;
}

// Compare-and-delete: releasing a token-guarded lock after it expired must
// not free a lock some other holder has since acquired.
async function releaseLockIfHeld(redis: Redis, lockKey: string, token: string): Promise<void> {
  await redis.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
    1,
    lockKey,
    token
  );
}

/** A down key holds its reason ('unauthorized') or 'false'; anything but 'true' is down. */
function parseServerHealth(data: string | null): boolean | null {
  return data === null ? null : data === 'true';
}

export function createCacheService(redis: Redis): CacheService {
  const deleteKeysByPattern = async (pattern: string): Promise<number> => {
    let cursor = '0';
    let deletedCount = 0;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        await redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== '0');

    return deletedCount;
  };

  // Helper to invalidate all dashboard stats cache keys (timezone-specific)
  // Dashboard route uses keys like tracearr:stats:dashboard:UTC or tracearr:stats:dashboard:{serverId}:{tz}
  const invalidateDashboardStats = async (): Promise<void> => {
    const pattern = `${REDIS_KEYS.DASHBOARD_STATS}:*`;
    await deleteKeysByPattern(pattern);
  };

  const service: CacheService = {
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
        cacheLogger.error('addActiveSession pipeline failed', { results });
      }
      // Invalidate dashboard stats (uses pattern matching for timezone-specific keys)
      await invalidateDashboardStats();
    },

    async removeActiveSession(
      sessionId: string,
      opts?: { skipDashboardInvalidation?: boolean }
    ): Promise<void> {
      const pipeline = redis.multi();
      // Remove from active sessions SET (atomic)
      pipeline.srem(REDIS_KEYS.ACTIVE_SESSION_IDS, sessionId);
      // Remove session data
      pipeline.del(REDIS_KEYS.SESSION_BY_ID(sessionId));
      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err !== null)) {
        cacheLogger.error('removeActiveSession pipeline failed', { results });
      }
      if (!opts?.skipDashboardInvalidation) {
        // Invalidate dashboard stats (uses pattern matching for timezone-specific keys)
        await invalidateDashboardStats();
      }
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
      const pipeline = redis.multi();
      // Ensure session ID is in SET
      pipeline.sadd(REDIS_KEYS.ACTIVE_SESSION_IDS, session.id);
      pipeline.setex(
        REDIS_KEYS.SESSION_BY_ID(session.id),
        CACHE_TTL.ACTIVE_SESSIONS,
        JSON.stringify(session)
      );
      // Refresh SET TTL to match session data TTL
      pipeline.expire(REDIS_KEYS.ACTIVE_SESSION_IDS, CACHE_TTL.ACTIVE_SESSIONS);
      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err !== null)) {
        cacheLogger.error('updateActiveSession pipeline failed', { results });
      }
    },

    async incrementalSyncActiveSessions(
      newSessions: ActiveSession[],
      stoppedSessionIds: string[],
      updatedSessions: ActiveSession[],
      watchedTransitionOccurred = false
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

      // Update existing session data and ensure ID is in SET (recreates SET if TTL expired)
      for (const session of updatedSessions) {
        pipeline.sadd(REDIS_KEYS.ACTIVE_SESSION_IDS, session.id);
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
        cacheLogger.error('incrementalSyncActiveSessions pipeline failed', { results });
      }

      // Progress-only ticks don't change dashboard stats, so skip the SCAN-based invalidation.
      if (newSessions.length > 0 || stoppedSessionIds.length > 0 || watchedTransitionOccurred) {
        await invalidateDashboardStats();
      }
    },

    // Dashboard stats
    async invalidateDashboardStatsCache(): Promise<void> {
      await invalidateDashboardStats();
    },

    async getMediaStats<T>(cacheKey: string): Promise<T | null> {
      const data = await redis.get(REDIS_KEYS.PUBLIC_MEDIA_STATS(cacheKey));
      if (!data) return null;
      try {
        return JSON.parse(data) as T;
      } catch {
        return null;
      }
    },

    async setMediaStats(cacheKey: string, value: unknown): Promise<void> {
      await redis.setex(
        REDIS_KEYS.PUBLIC_MEDIA_STATS(cacheKey),
        CACHE_TTL.PUBLIC_MEDIA_STATS,
        JSON.stringify(value)
      );
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

    // Server health tracking
    async getServerHealth(serverId: string): Promise<boolean | null> {
      return parseServerHealth(await redis.get(REDIS_KEYS.SERVER_HEALTH(serverId)));
    },

    async setServerHealth(
      serverId: string,
      isHealthy: boolean,
      reason?: ServerDownReason
    ): Promise<boolean | null> {
      const key = REDIS_KEYS.SERVER_HEALTH(serverId);
      const results = await redis
        .multi()
        .get(key)
        .setex(key, CACHE_TTL.SERVER_HEALTH, isHealthy ? 'true' : (reason ?? 'false'))
        .exec();
      if (!results || results.some(([err]) => err !== null)) {
        throw new Error(`setServerHealth failed for ${serverId}`);
      }
      return parseServerHealth(results[0]?.[1] as string | null);
    },

    async getServerDownReason(serverId: string): Promise<ServerDownReason | null> {
      const data = await redis.get(REDIS_KEYS.SERVER_HEALTH(serverId));
      return data === 'unauthorized' ? data : null;
    },

    async incrServerFailCount(serverId: string): Promise<number> {
      const key = REDIS_KEYS.SERVER_HEALTH_FAIL_COUNT(serverId);
      const count = await redis.incr(key);
      await redis.expire(key, CACHE_TTL.SERVER_HEALTH);
      return count;
    },

    async resetServerFailCount(serverId: string): Promise<void> {
      await redis.del(REDIS_KEYS.SERVER_HEALTH_FAIL_COUNT(serverId));
    },

    // Runtime connection status — written going forward only, TTL-bound, not in DB
    async getServerConnectionStatus(serverId: string): Promise<ServerConnectionStatus | null> {
      const data = await redis.get(REDIS_KEYS.SERVER_CONNECTION(serverId));
      if (!data) return null;
      return JSON.parse(data) as ServerConnectionStatus;
    },

    async setServerConnectionStatus(
      serverId: string,
      status: ServerConnectionStatus
    ): Promise<void> {
      await redis.setex(
        REDIS_KEYS.SERVER_CONNECTION(serverId),
        CACHE_TTL.SERVER_CONNECTION,
        JSON.stringify(status)
      );
    },

    // Generic cache operations
    async invalidateCache(key: string): Promise<void> {
      await redis.del(key);
    },

    async invalidatePattern(pattern: string): Promise<void> {
      await deleteKeysByPattern(pattern);
    },

    async withSessionCreateLock<T>(
      serverId: string,
      sessionKey: string,
      operation: () => Promise<T>
    ): Promise<T | null> {
      const lockKey = REDIS_KEYS.SESSION_LOCK(serverId, sessionKey);
      const token = randomUUID();

      const lockAcquired = await redis.set(lockKey, token, 'EX', 60, 'NX');
      if (!lockAcquired) {
        return null;
      }

      try {
        return await operation();
      } finally {
        await releaseLockIfHeld(redis, lockKey, token);
      }
    },

    // Termination cooldown methods
    async setTerminationCooldown(
      serverId: string,
      sessionKey: string,
      ratingKey: string
    ): Promise<void> {
      const cooldownKey = REDIS_KEYS.TERMINATION_COOLDOWN(serverId, sessionKey, ratingKey);
      // 5 minute cooldown to prevent re-creating recently terminated sessions
      // Plex can continue reporting terminated sessions as active for several minutes
      await redis.setex(cooldownKey, 300, '1');
    },

    async hasTerminationCooldown(
      serverId: string,
      sessionKey: string,
      ratingKey: string
    ): Promise<boolean> {
      const cooldownKey = REDIS_KEYS.TERMINATION_COOLDOWN(serverId, sessionKey, ratingKey);
      const exists = await redis.exists(cooldownKey);
      return exists === 1;
    },

    async setTerminationCooldownComposite(
      serverId: string,
      serverUserId: string,
      deviceId: string,
      ratingKey: string
    ): Promise<void> {
      const cooldownKey = REDIS_KEYS.TERMINATION_COOLDOWN_COMPOSITE(
        serverId,
        serverUserId,
        deviceId,
        ratingKey
      );
      await redis.setex(cooldownKey, 300, '1');
    },

    async hasTerminationCooldownComposite(
      serverId: string,
      serverUserId: string,
      deviceId: string,
      ratingKey: string
    ): Promise<boolean> {
      const cooldownKey = REDIS_KEYS.TERMINATION_COOLDOWN_COMPOSITE(
        serverId,
        serverUserId,
        deviceId,
        ratingKey
      );
      return (await redis.exists(cooldownKey)) === 1;
    },

    // Pending sessions (Redis-first architecture)
    // Sessions stay in Redis until 30s confirmation, then persist to DB
    async getPendingSession(
      serverId: string,
      sessionKey: string
    ): Promise<PendingSessionData | null> {
      const key = REDIS_KEYS.PENDING_SESSION(serverId, sessionKey);
      const data = await redis.get(key);
      if (!data) return null;
      try {
        return JSON.parse(data) as PendingSessionData;
      } catch {
        return null;
      }
    },

    async setPendingSession(
      serverId: string,
      sessionKey: string,
      data: PendingSessionData
    ): Promise<void> {
      const key = REDIS_KEYS.PENDING_SESSION(serverId, sessionKey);
      const memberKey = `${serverId}:${sessionKey}`;
      const pipeline = redis.multi();
      // Store session data with longer TTL to survive pause scenarios
      pipeline.setex(key, CACHE_TTL.PENDING_SESSIONS, JSON.stringify(data));
      // Track in pending session IDs set for enumeration
      pipeline.sadd(REDIS_KEYS.PENDING_SESSION_IDS, memberKey);
      pipeline.expire(REDIS_KEYS.PENDING_SESSION_IDS, CACHE_TTL.PENDING_SESSIONS);
      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err !== null)) {
        cacheLogger.error('setPendingSession pipeline failed', { results });
      }
    },

    async deletePendingSession(serverId: string, sessionKey: string): Promise<void> {
      const key = REDIS_KEYS.PENDING_SESSION(serverId, sessionKey);
      const memberKey = `${serverId}:${sessionKey}`;
      const pipeline = redis.multi();
      pipeline.del(key);
      pipeline.srem(REDIS_KEYS.PENDING_SESSION_IDS, memberKey);
      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err !== null)) {
        cacheLogger.error('deletePendingSession pipeline failed', { results });
      }
    },

    async getAllPendingSessionKeys(): Promise<Array<{ serverId: string; sessionKey: string }>> {
      const members = await redis.smembers(REDIS_KEYS.PENDING_SESSION_IDS);
      return members.map((m) => {
        const [serverId, ...rest] = m.split(':');
        return { serverId: serverId!, sessionKey: rest.join(':') };
      });
    },

    // Session write retry queue methods
    async addSessionWriteRetry(
      sessionId: string,
      startedAt: number,
      stopData: { stoppedAt: number; forceStopped: boolean }
    ): Promise<void> {
      const key = REDIS_KEYS.SESSION_WRITE_RETRY(sessionId);
      // hsetnx: a re-add for a session already queued must not reset its
      // attempt count back to 1, or MAX_TOTAL_ATTEMPTS never triggers.
      await redis.hsetnx(key, 'attempts', '1');
      await redis.hset(key, 'startedAt', String(startedAt));
      await redis.hset(key, 'stopData', JSON.stringify(stopData));
      await redis.sadd(REDIS_KEYS.SESSION_WRITE_RETRY_SET, sessionId);
      // Auto-expire after 1 hour (safety net)
      await redis.expire(key, 3600);
      await redis.expire(REDIS_KEYS.SESSION_WRITE_RETRY_SET, 3600);
    },

    async getSessionWriteRetries(): Promise<
      Array<{
        sessionId: string;
        attempts: number;
        startedAt?: number;
        stopData: { stoppedAt: number; forceStopped: boolean };
      }>
    > {
      const sessionIds = await redis.smembers(REDIS_KEYS.SESSION_WRITE_RETRY_SET);
      const results: Array<{
        sessionId: string;
        attempts: number;
        startedAt?: number;
        stopData: { stoppedAt: number; forceStopped: boolean };
      }> = [];
      // Members whose hash already expired are zombies: srem them here so the
      // set doesn't grow unbounded and cost one hgetall per zombie on every
      // reconciliation pass forever.
      const zombies: string[] = [];

      for (const sessionId of sessionIds) {
        const key = REDIS_KEYS.SESSION_WRITE_RETRY(sessionId);
        const data = await redis.hgetall(key);
        if (data.attempts && data.stopData) {
          results.push({
            sessionId,
            attempts: parseInt(data.attempts, 10),
            ...(data.startedAt && { startedAt: Number(data.startedAt) }),
            stopData: JSON.parse(data.stopData) as { stoppedAt: number; forceStopped: boolean },
          });
        } else {
          zombies.push(sessionId);
        }
      }

      if (zombies.length > 0) {
        await redis.srem(REDIS_KEYS.SESSION_WRITE_RETRY_SET, ...zombies);
      }

      return results;
    },

    async incrementSessionWriteRetry(sessionId: string): Promise<number> {
      const key = REDIS_KEYS.SESSION_WRITE_RETRY(sessionId);
      return redis.hincrby(key, 'attempts', 1);
    },

    async removeSessionWriteRetry(sessionId: string): Promise<void> {
      const key = REDIS_KEYS.SESSION_WRITE_RETRY(sessionId);
      await redis.del(key);
      await redis.srem(REDIS_KEYS.SESSION_WRITE_RETRY_SET, sessionId);
    },

    // Filter options caching (TTL-based expiry, no active invalidation)
    async getFilterOptions(userId: string, scopeHash: string): Promise<string | null> {
      return redis.get(REDIS_KEYS.FILTER_OPTIONS(userId, scopeHash));
    },
    async setFilterOptions(userId: string, scopeHash: string, data: string): Promise<void> {
      await redis.setex(
        REDIS_KEYS.FILTER_OPTIONS(userId, scopeHash),
        CACHE_TTL.FILTER_OPTIONS,
        data
      );
    },

    async getPlexGeoipCache(ip: string): Promise<string | null> {
      return redis.get(REDIS_KEYS.PLEX_GEOIP(ip));
    },
    async setPlexGeoipCache(ip: string, data: string, ttlSeconds: number): Promise<void> {
      await redis.setex(REDIS_KEYS.PLEX_GEOIP(ip), ttlSeconds, data);
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
      if (PUBLIC_CHANNEL_EVENTS.has(event)) {
        await publishPublicEvent(publisher, event, data).catch((err: unknown) => {
          cacheLogger.error('Public channel publish failed', { err });
        });
      }
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
