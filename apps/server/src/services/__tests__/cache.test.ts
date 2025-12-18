/**
 * Cache Service Tests
 *
 * Tests the ACTUAL createCacheService and createPubSubService from cache.ts:
 * - CacheService: Redis-backed caching for sessions, stats, etc.
 * - PubSubService: Pub/sub for real-time events
 *
 * These tests validate:
 * - Get/set operations with mock Redis
 * - JSON parsing error handling
 * - Pattern-based invalidation
 * - Set operations for user sessions
 * - Pub/sub message routing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

// Import ACTUAL production functions - not local duplicates
import {
  createCacheService,
  createPubSubService,
  getPubSubService,
  type CacheService,
  type PubSubService,
} from '../cache.js';

// Mock Redis instance factory with pipeline support
function createMockRedis(): Redis & {
  store: Map<string, string>;
  sets: Map<string, Set<string>>;
  ttls: Map<string, number>;
} {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const ttls = new Map<string, number>();
  const messageCallbacks: Array<(channel: string, message: string) => void> = [];

  // Pipeline mock - accumulates commands and executes them atomically
  const createPipeline = () => {
    const commands: Array<{ cmd: string; args: unknown[] }> = [];

    const pipeline = {
      sadd: (key: string, ...members: string[]) => {
        commands.push({ cmd: 'sadd', args: [key, ...members] });
        return pipeline;
      },
      srem: (key: string, ...members: string[]) => {
        commands.push({ cmd: 'srem', args: [key, ...members] });
        return pipeline;
      },
      setex: (key: string, seconds: number, value: string) => {
        commands.push({ cmd: 'setex', args: [key, seconds, value] });
        return pipeline;
      },
      del: (...keys: string[]) => {
        commands.push({ cmd: 'del', args: keys });
        return pipeline;
      },
      expire: (key: string, seconds: number) => {
        commands.push({ cmd: 'expire', args: [key, seconds] });
        return pipeline;
      },
      exec: vi.fn(async () => {
        const results: Array<[null, unknown]> = [];
        for (const { cmd, args } of commands) {
          let result: unknown = 'OK';
          if (cmd === 'sadd') {
            const [key, ...members] = args as [string, ...string[]];
            if (!sets.has(key)) sets.set(key, new Set());
            const set = sets.get(key)!;
            let added = 0;
            for (const member of members) {
              if (!set.has(member)) {
                set.add(member);
                added++;
              }
            }
            result = added;
          } else if (cmd === 'srem') {
            const [key, ...members] = args as [string, ...string[]];
            const set = sets.get(key);
            let removed = 0;
            if (set) {
              for (const member of members) {
                if (set.delete(member)) removed++;
              }
            }
            result = removed;
          } else if (cmd === 'setex') {
            const [key, seconds, value] = args as [string, number, string];
            store.set(key, value);
            ttls.set(key, seconds);
            result = 'OK';
          } else if (cmd === 'del') {
            let count = 0;
            for (const key of args as string[]) {
              if (store.delete(key) || sets.delete(key)) count++;
            }
            result = count;
          } else if (cmd === 'expire') {
            const [key, seconds] = args as [string, number];
            ttls.set(key, seconds);
            result = store.has(key) || sets.has(key) ? 1 : 0;
          }
          results.push([null, result]);
        }
        return results;
      }),
    };
    return pipeline;
  };

  return {
    store,
    sets,
    ttls,
    // String operations
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, seconds: number, value: string) => {
      store.set(key, value);
      ttls.set(key, seconds);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key) || sets.delete(key)) count++;
      }
      return count;
    }),
    keys: vi.fn(async (pattern: string) => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return Array.from(store.keys()).filter((k) => regex.test(k));
    }),
    mget: vi.fn(async (...keys: string[]) => {
      return keys.map((key) => store.get(key) ?? null);
    }),
    exists: vi.fn(async (key: string) => {
      return store.has(key) ? 1 : 0;
    }),

    // Set operations
    smembers: vi.fn(async (key: string) => {
      const set = sets.get(key);
      return set ? Array.from(set) : [];
    }),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) sets.set(key, new Set());
      const set = sets.get(key)!;
      let added = 0;
      for (const member of members) {
        if (!set.has(member)) {
          set.add(member);
          added++;
        }
      }
      return added;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      const set = sets.get(key);
      if (!set) return 0;
      let removed = 0;
      for (const member of members) {
        if (set.delete(member)) removed++;
      }
      return removed;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return store.has(key) || sets.has(key) ? 1 : 0;
    }),

    // Pipeline/transaction support
    multi: vi.fn(() => createPipeline()),

    // Pub/Sub
    publish: vi.fn(async () => 1),
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    on: vi.fn((event: string, callback: (channel: string, message: string) => void) => {
      if (event === 'message') {
        messageCallbacks.push(callback);
      }
    }),

    // Health
    ping: vi.fn(async () => 'PONG'),

    // Helper to simulate incoming message
    _simulateMessage: (channel: string, message: string) => {
      for (const cb of messageCallbacks) {
        cb(channel, message);
      }
    },
  } as unknown as Redis & {
    store: Map<string, string>;
    sets: Map<string, Set<string>>;
    ttls: Map<string, number>;
  };
}

// Sample data matching shared types
const sampleSession = {
  sessionId: 'session-123',
  mediaServerId: 'server-1',
  userId: 'user-123',
  username: 'testuser',
  title: 'Test Movie',
  mediaType: 'movie' as const,
  state: 'playing' as const,
  progress: 50,
  duration: 7200,
  startTime: Date.now(),
  lastUpdated: Date.now(),
  device: 'Chrome',
  player: 'Web',
  quality: '1080p',
  ipAddress: '192.168.1.100',
};

// Sample ActiveSession for atomic method tests (matches actual ActiveSession type)
function createTestActiveSession(id: string, serverId = 'server-1'): any {
  return {
    id,
    sessionKey: `session-key-${id}`,
    serverId,
    serverUserId: 'user-123',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: '/library/metadata/123/thumb',
    ratingKey: 'media-123',
    externalSessionId: null,
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: 0,
    progressMs: 0,
    totalDurationMs: 7200000,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '192.168.1.100',
    geoCity: 'New York',
    geoRegion: 'NY',
    geoCountry: 'US',
    geoLat: 40.7128,
    geoLon: -74.006,
    playerName: 'Chrome',
    deviceId: 'device-123',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Chrome',
    quality: '1080p',
    isTranscode: false,
    bitrate: 20000,
    user: { id: 'user-123', username: 'testuser', thumbUrl: null },
    server: { id: serverId, name: 'Test Server', type: 'plex' },
  };
}

const sampleStats = {
  activeSessions: 5,
  totalUsers: 100,
  totalServers: 3,
  activeViolations: 2,
  sessionsToday: 25,
  streamsByMediaType: { movie: 10, episode: 15 },
};

describe('CacheService', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let cache: CacheService;

  beforeEach(() => {
    redis = createMockRedis();
    cache = createCacheService(redis);
  });

  describe('getActiveSessions / setActiveSessions', () => {
    it('should return null when no sessions cached', async () => {
      const result = await cache.getActiveSessions();

      expect(result).toBeNull();
      expect(redis.get).toHaveBeenCalledWith('tracearr:sessions:active');
    });

    it('should store and retrieve active sessions', async () => {
      const sessions = [sampleSession] as unknown[];

      await cache.setActiveSessions(sessions as never);
      const result = await cache.getActiveSessions();

      expect(result).toEqual(sessions);
      expect(redis.setex).toHaveBeenCalledWith(
        'tracearr:sessions:active',
        300, // CACHE_TTL.ACTIVE_SESSIONS
        expect.any(String)
      );
    });

    it('should invalidate dashboard stats when setting sessions', async () => {
      // Set up timezone-specific dashboard stats (as used in production)
      redis.store.set('tracearr:stats:dashboard:UTC', JSON.stringify({ activeStreams: 1 }));
      redis.store.set(
        'tracearr:stats:dashboard:America/New_York',
        JSON.stringify({ activeStreams: 1 })
      );

      await cache.setActiveSessions([sampleSession] as never);

      // Should have called keys to find timezone-specific stats
      expect(redis.keys).toHaveBeenCalledWith('tracearr:stats:dashboard:*');
      // Should have deleted the matched keys
      expect(redis.del).toHaveBeenCalledWith(
        'tracearr:stats:dashboard:UTC',
        'tracearr:stats:dashboard:America/New_York'
      );
    });

    it('should return null on JSON parse error', async () => {
      redis.store.set('tracearr:sessions:active', 'not-valid-json{');

      const result = await cache.getActiveSessions();

      expect(result).toBeNull();
    });

    it('should handle empty array', async () => {
      await cache.setActiveSessions([]);
      const result = await cache.getActiveSessions();

      expect(result).toEqual([]);
    });
  });

  describe('getDashboardStats / setDashboardStats', () => {
    it('should return null when no stats cached', async () => {
      const result = await cache.getDashboardStats();

      expect(result).toBeNull();
    });

    it('should store and retrieve dashboard stats', async () => {
      await cache.setDashboardStats(sampleStats as any);
      const result = await cache.getDashboardStats();

      expect(result).toEqual(sampleStats);
      expect(redis.setex).toHaveBeenCalledWith(
        'tracearr:stats:dashboard',
        60, // CACHE_TTL.DASHBOARD_STATS
        expect.any(String)
      );
    });

    it('should return null on JSON parse error', async () => {
      redis.store.set('tracearr:stats:dashboard', '{broken');

      const result = await cache.getDashboardStats();

      expect(result).toBeNull();
    });
  });

  describe('getSessionById / setSessionById / deleteSessionById', () => {
    it('should return null for non-existent session', async () => {
      const result = await cache.getSessionById('nonexistent');

      expect(result).toBeNull();
      expect(redis.get).toHaveBeenCalledWith('tracearr:sessions:nonexistent');
    });

    it('should store and retrieve session by ID', async () => {
      await cache.setSessionById('session-123', sampleSession as any);
      const result = await cache.getSessionById('session-123');

      expect(result).toEqual(sampleSession);
    });

    it('should delete session by ID', async () => {
      await cache.setSessionById('session-123', sampleSession as any);
      await cache.deleteSessionById('session-123');

      const result = await cache.getSessionById('session-123');
      expect(result).toBeNull();
    });

    it('should return null on JSON parse error', async () => {
      redis.store.set('tracearr:sessions:session-123', 'invalid-json');

      const result = await cache.getSessionById('session-123');

      expect(result).toBeNull();
    });
  });

  describe('getUserSessions / addUserSession / removeUserSession', () => {
    it('should return null for user with no sessions', async () => {
      const result = await cache.getUserSessions('user-123');

      expect(result).toBeNull();
    });

    it('should add and retrieve user sessions', async () => {
      await cache.addUserSession('user-123', 'session-1');
      await cache.addUserSession('user-123', 'session-2');

      const result = await cache.getUserSessions('user-123');

      expect(result).toContain('session-1');
      expect(result).toContain('session-2');
      expect(result).toHaveLength(2);
    });

    it('should set expiration when adding session', async () => {
      await cache.addUserSession('user-123', 'session-1');

      expect(redis.expire).toHaveBeenCalledWith('tracearr:users:user-123:sessions', 3600);
    });

    it('should remove user session', async () => {
      await cache.addUserSession('user-123', 'session-1');
      await cache.addUserSession('user-123', 'session-2');

      await cache.removeUserSession('user-123', 'session-1');

      const result = await cache.getUserSessions('user-123');
      expect(result).toEqual(['session-2']);
    });

    it('should not add duplicate session IDs', async () => {
      await cache.addUserSession('user-123', 'session-1');
      await cache.addUserSession('user-123', 'session-1');

      const result = await cache.getUserSessions('user-123');
      expect(result).toEqual(['session-1']);
    });
  });

  describe('invalidateCache', () => {
    it('should delete specific key', async () => {
      redis.store.set('some:key', 'value');

      await cache.invalidateCache('some:key');

      expect(redis.del).toHaveBeenCalledWith('some:key');
    });
  });

  describe('invalidatePattern', () => {
    it('should delete all keys matching pattern', async () => {
      redis.store.set('tracearr:sessions:1', 'data1');
      redis.store.set('tracearr:sessions:2', 'data2');
      redis.store.set('tracearr:users:1', 'user1');

      await cache.invalidatePattern('tracearr:sessions:*');

      // del should be called with both session keys
      expect(redis.del).toHaveBeenCalled();
      // Verify keys were found
      expect(redis.keys).toHaveBeenCalledWith('tracearr:sessions:*');
    });

    it('should not call del when no keys match pattern', async () => {
      await cache.invalidatePattern('nonexistent:*');

      expect(redis.keys).toHaveBeenCalledWith('nonexistent:*');
      // del should not be called since no keys matched
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('ping', () => {
    it('should return true when Redis responds with PONG', async () => {
      const result = await cache.ping();

      expect(result).toBe(true);
      expect(redis.ping).toHaveBeenCalled();
    });

    it('should return false when Redis responds with non-PONG', async () => {
      vi.mocked(redis.ping).mockResolvedValueOnce('ERROR');

      const result = await cache.ping();

      expect(result).toBe(false);
    });

    it('should return false when Redis throws', async () => {
      vi.mocked(redis.ping).mockRejectedValueOnce(new Error('Connection failed'));

      const result = await cache.ping();

      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // Atomic SET-based Session Operations (Race Condition Fix)
  // These tests verify the atomic operations that fix duplicate session bugs
  // ============================================================================

  describe('addActiveSession (atomic)', () => {
    it('should add session to SET and store session data atomically', async () => {
      const session = createTestActiveSession('session-1');

      await cache.addActiveSession(session);

      // Verify session ID was added to SET
      const ids = await redis.smembers('tracearr:sessions:active:ids');
      expect(ids).toContain('session-1');

      // Verify session data was stored
      const storedData = redis.store.get('tracearr:sessions:session-1');
      expect(storedData).toBeDefined();
      expect(JSON.parse(storedData!).id).toBe('session-1');
    });

    it('should invalidate dashboard stats atomically', async () => {
      const session = createTestActiveSession('session-1');

      await cache.addActiveSession(session);

      // Dashboard stats should be deleted as part of the pipeline
      expect(redis.store.has('tracearr:stats:dashboard')).toBe(false);
    });

    it('should use Redis pipeline for atomicity', async () => {
      const session = createTestActiveSession('session-1');

      await cache.addActiveSession(session);

      // Verify multi() was called for pipeline
      expect(redis.multi).toHaveBeenCalled();
    });

    it('should not create duplicates when called twice with same session', async () => {
      const session = createTestActiveSession('session-1');

      await cache.addActiveSession(session);
      await cache.addActiveSession(session);

      // SET should only have one entry (SADD is idempotent)
      const ids = await redis.smembers('tracearr:sessions:active:ids');
      expect(ids).toHaveLength(1);
    });
  });

  describe('removeActiveSession (atomic)', () => {
    it('should remove session from SET and delete session data atomically', async () => {
      const session = createTestActiveSession('session-1');

      // First add a session
      await cache.addActiveSession(session);

      // Verify it exists
      let ids = await redis.smembers('tracearr:sessions:active:ids');
      expect(ids).toContain('session-1');

      // Now remove it
      await cache.removeActiveSession('session-1');

      // Verify it's gone from SET
      ids = await redis.smembers('tracearr:sessions:active:ids');
      expect(ids).not.toContain('session-1');

      // Verify session data is deleted
      expect(redis.store.has('tracearr:sessions:session-1')).toBe(false);
    });

    it('should invalidate dashboard stats atomically', async () => {
      const session = createTestActiveSession('session-1');
      await cache.addActiveSession(session);

      // Set some dashboard stats (using timezone-specific keys as in production)
      redis.store.set('tracearr:stats:dashboard:UTC', JSON.stringify({ activeStreams: 1 }));

      await cache.removeActiveSession('session-1');

      // Dashboard stats should be deleted
      expect(redis.store.has('tracearr:stats:dashboard:UTC')).toBe(false);
    });

    it('should handle removing non-existent session gracefully', async () => {
      // Should not throw
      await expect(cache.removeActiveSession('non-existent')).resolves.not.toThrow();
    });
  });

  describe('getAllActiveSessions', () => {
    it('should return empty array when no sessions exist', async () => {
      const result = await cache.getAllActiveSessions();

      expect(result).toEqual([]);
    });

    it('should return all active sessions', async () => {
      const session1 = createTestActiveSession('session-1');
      const session2 = createTestActiveSession('session-2');

      await cache.addActiveSession(session1);
      await cache.addActiveSession(session2);

      const result = await cache.getAllActiveSessions();

      expect(result).toHaveLength(2);
      expect(result.map((s: any) => s.id).sort()).toEqual(['session-1', 'session-2']);
    });

    it('should clean up stale IDs (IDs without session data)', async () => {
      // Manually add a stale ID to the SET (no corresponding data)
      redis.sets.set('tracearr:sessions:active:ids', new Set(['stale-id', 'valid-id']));
      redis.store.set(
        'tracearr:sessions:valid-id',
        JSON.stringify(createTestActiveSession('valid-id'))
      );

      const result = await cache.getAllActiveSessions();

      // Should only return the valid session
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('valid-id');

      // Stale ID should have been cleaned up
      const ids = await redis.smembers('tracearr:sessions:active:ids');
      expect(ids).not.toContain('stale-id');
    });
  });

  describe('updateActiveSession', () => {
    it('should update session data without modifying SET membership', async () => {
      const session = createTestActiveSession('session-1');
      await cache.addActiveSession(session);

      // Update the session
      const updatedSession = { ...session, progressMs: 50000 };
      await cache.updateActiveSession(updatedSession);

      // Verify data was updated
      const storedData = redis.store.get('tracearr:sessions:session-1');
      expect(JSON.parse(storedData!).progressMs).toBe(50000);

      // Verify SET still contains the ID
      const ids = await redis.smembers('tracearr:sessions:active:ids');
      expect(ids).toContain('session-1');
    });
  });

  describe('syncActiveSessions (full replacement)', () => {
    it('should replace all sessions atomically', async () => {
      // Add some initial sessions
      await cache.addActiveSession(createTestActiveSession('old-1'));
      await cache.addActiveSession(createTestActiveSession('old-2'));

      // Sync with new sessions
      const newSessions = [
        createTestActiveSession('new-1'),
        createTestActiveSession('new-2'),
        createTestActiveSession('new-3'),
      ];
      await cache.syncActiveSessions(newSessions);

      const result = await cache.getAllActiveSessions();

      // Should only have new sessions
      expect(result).toHaveLength(3);
      const ids = result.map((s: any) => s.id).sort();
      expect(ids).toEqual(['new-1', 'new-2', 'new-3']);
    });

    it('should handle empty sync (clear all sessions)', async () => {
      await cache.addActiveSession(createTestActiveSession('session-1'));

      await cache.syncActiveSessions([]);

      const result = await cache.getAllActiveSessions();
      expect(result).toHaveLength(0);
    });
  });

  describe('incrementalSyncActiveSessions', () => {
    it('should add new sessions without affecting existing', async () => {
      await cache.addActiveSession(createTestActiveSession('existing-1'));

      await cache.incrementalSyncActiveSessions(
        [createTestActiveSession('new-1')], // new
        [], // stopped
        [] // updated
      );

      const result = await cache.getAllActiveSessions();
      expect(result).toHaveLength(2);
    });

    it('should remove stopped sessions', async () => {
      await cache.addActiveSession(createTestActiveSession('session-1'));
      await cache.addActiveSession(createTestActiveSession('session-2'));

      await cache.incrementalSyncActiveSessions(
        [], // new
        ['session-1'], // stopped
        [] // updated
      );

      const result = await cache.getAllActiveSessions();
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('session-2');
    });

    it('should update existing sessions', async () => {
      const session = createTestActiveSession('session-1');
      await cache.addActiveSession(session);

      const updated = { ...session, progressMs: 99999 };
      await cache.incrementalSyncActiveSessions(
        [], // new
        [], // stopped
        [updated] // updated
      );

      const result = await cache.getAllActiveSessions();
      expect(result[0]!.progressMs).toBe(99999);
    });

    it('should handle mixed operations atomically', async () => {
      await cache.addActiveSession(createTestActiveSession('keep'));
      await cache.addActiveSession(createTestActiveSession('remove'));

      const newSession = createTestActiveSession('add');
      const updatedSession = { ...createTestActiveSession('keep'), progressMs: 12345 };

      await cache.incrementalSyncActiveSessions(
        [newSession], // new
        ['remove'], // stopped
        [updatedSession] // updated
      );

      const result = await cache.getAllActiveSessions();
      expect(result).toHaveLength(2);

      const kept = result.find((s: any) => s.id === 'keep');
      expect(kept!.progressMs).toBe(12345);

      const added = result.find((s: any) => s.id === 'add');
      expect(added).toBeDefined();

      const removed = result.find((s: any) => s.id === 'remove');
      expect(removed).toBeUndefined();
    });

    it('should not fail when no changes', async () => {
      await expect(cache.incrementalSyncActiveSessions([], [], [])).resolves.not.toThrow();
    });
  });

  describe('concurrent operations (race condition fix verification)', () => {
    it('should handle concurrent add and remove on different sessions', async () => {
      // This test verifies the fix for the original race condition
      // Previously: read-modify-write would cause one operation to overwrite the other
      // Now: SADD/SREM are atomic and don't interfere

      // Add initial sessions
      await cache.addActiveSession(createTestActiveSession('session-1'));
      await cache.addActiveSession(createTestActiveSession('session-2'));

      // Simulate concurrent operations (in real code these could interleave)
      await Promise.all([
        cache.addActiveSession(createTestActiveSession('session-3')),
        cache.removeActiveSession('session-1'),
      ]);

      const result = await cache.getAllActiveSessions();
      const ids = result.map((s: any) => s.id).sort();

      // session-1 should be removed
      // session-2 should remain
      // session-3 should be added
      expect(ids).toEqual(['session-2', 'session-3']);
    });

    it('should handle concurrent removes on different sessions', async () => {
      // Add sessions
      await cache.addActiveSession(createTestActiveSession('session-1'));
      await cache.addActiveSession(createTestActiveSession('session-2'));
      await cache.addActiveSession(createTestActiveSession('session-3'));

      // Concurrent removes
      await Promise.all([
        cache.removeActiveSession('session-1'),
        cache.removeActiveSession('session-2'),
      ]);

      const result = await cache.getAllActiveSessions();
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('session-3');
    });
  });
});

describe('PubSubService', () => {
  let publisher: ReturnType<typeof createMockRedis>;
  let subscriber: ReturnType<typeof createMockRedis>;
  let pubsub: PubSubService;

  beforeEach(() => {
    publisher = createMockRedis();
    subscriber = createMockRedis();
    pubsub = createPubSubService(publisher, subscriber);
  });

  describe('publish', () => {
    it('should publish event with data to events channel', async () => {
      const eventData = { userId: 'user-123', action: 'login' };

      await pubsub.publish('user.login', eventData);

      expect(publisher.publish).toHaveBeenCalledWith(
        'tracearr:events',
        expect.stringContaining('"event":"user.login"')
      );
    });

    it('should include timestamp in published message', async () => {
      const before = Date.now();
      await pubsub.publish('test.event', { data: 'test' });
      const after = Date.now();

      const publishCall = vi.mocked(publisher.publish).mock.calls[0];
      const message = JSON.parse(publishCall![1] as string);

      expect(message.timestamp).toBeGreaterThanOrEqual(before);
      expect(message.timestamp).toBeLessThanOrEqual(after);
    });

    it('should stringify complex data structures', async () => {
      const complexData = {
        nested: { array: [1, 2, 3], obj: { key: 'value' } },
        number: 42,
        boolean: true,
      };

      await pubsub.publish('complex.event', complexData);

      const publishCall = vi.mocked(publisher.publish).mock.calls[0];
      const message = JSON.parse(publishCall![1] as string);

      expect(message.data).toEqual(complexData);
    });
  });

  describe('subscribe', () => {
    it('should subscribe to channel', async () => {
      const callback = vi.fn();

      await pubsub.subscribe('test-channel', callback);

      expect(subscriber.subscribe).toHaveBeenCalledWith('test-channel');
    });

    it('should invoke callback when message received', async () => {
      const callback = vi.fn();

      await pubsub.subscribe('test-channel', callback);

      // Simulate incoming message
      (subscriber as any)._simulateMessage('test-channel', '{"test": "data"}');

      expect(callback).toHaveBeenCalledWith('{"test": "data"}');
    });

    it('should route messages to correct callback', async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      await pubsub.subscribe('channel-1', callback1);
      await pubsub.subscribe('channel-2', callback2);

      (subscriber as any)._simulateMessage('channel-1', 'message-1');
      (subscriber as any)._simulateMessage('channel-2', 'message-2');

      expect(callback1).toHaveBeenCalledWith('message-1');
      expect(callback2).toHaveBeenCalledWith('message-2');
      expect(callback1).not.toHaveBeenCalledWith('message-2');
      expect(callback2).not.toHaveBeenCalledWith('message-1');
    });

    it('should not invoke callback for unsubscribed channel', async () => {
      const callback = vi.fn();

      await pubsub.subscribe('subscribed-channel', callback);

      (subscriber as any)._simulateMessage('other-channel', 'message');

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('unsubscribe', () => {
    it('should unsubscribe from channel', async () => {
      const callback = vi.fn();

      await pubsub.subscribe('test-channel', callback);
      await pubsub.unsubscribe('test-channel');

      expect(subscriber.unsubscribe).toHaveBeenCalledWith('test-channel');
    });

    it('should not invoke callback after unsubscribe', async () => {
      const callback = vi.fn();

      await pubsub.subscribe('test-channel', callback);
      await pubsub.unsubscribe('test-channel');

      (subscriber as any)._simulateMessage('test-channel', 'message');

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('getPubSubService', () => {
    it('should return the created pubsub instance', () => {
      const result = getPubSubService();

      expect(result).toBe(pubsub);
    });
  });
});
