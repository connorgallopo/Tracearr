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
 * - Set operations for active sessions and the retry/pending queues
 * - Pub/sub message routing
 */

import { CACHE_TTL, POLLING_INTERVALS } from '@tracearr/shared';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  hashes: Map<string, Map<string, string>>;
  ttls: Map<string, number>;
} {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();
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
    hashes,
    ttls,
    // String operations
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, seconds: number, value: string) => {
      store.set(key, value);
      ttls.set(key, seconds);
      return 'OK';
    }),
    // Only supports the `SET key value 'EX' seconds 'NX'` shape used by withSessionCreateLock.
    set: vi.fn(async (key: string, value: string, ...rest: unknown[]) => {
      const exIdx = rest.indexOf('EX');
      const seconds = exIdx !== -1 ? (rest[exIdx + 1] as number) : undefined;
      const nx = rest.includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, value);
      if (seconds !== undefined) ttls.set(key, seconds);
      return 'OK';
    }),
    // Simulates the compare-and-delete Lua script: only deletes when the
    // stored value still matches the caller's token.
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) {
        if (store.delete(key) || sets.delete(key) || hashes.delete(key)) count++;
      }
      return count;
    }),
    keys: vi.fn(async (pattern: string) => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return Array.from(store.keys()).filter((k) => regex.test(k));
    }),
    // SCAN command - returns [cursor, keys] tuple
    // Simulates Redis SCAN by returning all matching keys in one batch (cursor '0' means done)
    scan: vi.fn(async (_cursor: string, ...args: string[]) => {
      // Parse MATCH pattern from args (e.g., ['MATCH', 'pattern:*', 'COUNT', '100'])
      const matchIdx = args.indexOf('MATCH');
      const pattern = matchIdx !== -1 ? args[matchIdx + 1] : '*';
      const regex = new RegExp('^' + (pattern ?? '*').replace(/\*/g, '.*') + '$');
      const matchingKeys = Array.from(store.keys()).filter((k) => regex.test(k));
      // Return '0' as cursor (indicating scan complete) and all matching keys
      return ['0', matchingKeys];
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
      return store.has(key) || sets.has(key) || hashes.has(key) ? 1 : 0;
    }),

    // Hash operations
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const hash = hashes.get(key)!;
      const isNew = !hash.has(field);
      hash.set(field, value);
      return isNew ? 1 : 0;
    }),
    hsetnx: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const hash = hashes.get(key)!;
      if (hash.has(field)) return 0;
      hash.set(field, value);
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => {
      const hash = hashes.get(key);
      return hash ? Object.fromEntries(hash) : {};
    }),
    hincrby: vi.fn(async (key: string, field: string, increment: number) => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const hash = hashes.get(key)!;
      const current = parseInt(hash.get(field) ?? '0', 10);
      const next = current + increment;
      hash.set(field, String(next));
      return next;
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
    hashes: Map<string, Map<string, string>>;
    ttls: Map<string, number>;
  };
}

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

describe('CacheService', () => {
  let redis: ReturnType<typeof createMockRedis>;
  let cache: CacheService;

  beforeEach(() => {
    redis = createMockRedis();
    cache = createCacheService(redis);
  });

  describe('getSessionById', () => {
    it('should return null for non-existent session', async () => {
      const result = await cache.getSessionById('nonexistent');

      expect(result).toBeNull();
      expect(redis.get).toHaveBeenCalledWith('tracearr:sessions:nonexistent');
    });

    it('should return null on JSON parse error', async () => {
      redis.store.set('tracearr:sessions:session-123', 'invalid-json');

      const result = await cache.getSessionById('session-123');

      expect(result).toBeNull();
    });
  });

  describe('getServerConnectionStatus / setServerConnectionStatus', () => {
    it('should return null when no status cached', async () => {
      const result = await cache.getServerConnectionStatus('srv-1');
      expect(result).toBeNull();
    });

    it('should store and retrieve server connection status', async () => {
      const status = {
        serverId: 'srv-1',
        serverName: 'My Jellyfin',
        serverType: 'jellyfin' as const,
        mode: 'realtime' as const,
        state: 'connected' as const,
        lastEventAt: '2024-01-01T00:00:00.000Z',
        since: '2024-01-01T00:00:00.000Z',
        error: null,
        pluginVersion: null,
        pluginUpdateAvailable: false,
        pluginIssue: null,
      };

      await cache.setServerConnectionStatus('srv-1', status);
      const result = await cache.getServerConnectionStatus('srv-1');

      expect(result).toEqual(status);
    });

    it('should use the correct TTL', async () => {
      const status = {
        serverId: 'srv-1',
        serverName: 'My Emby',
        serverType: 'emby' as const,
        mode: 'polling' as const,
        state: 'fallback' as const,
        lastEventAt: null,
        since: null,
        error: null,
        pluginVersion: null,
        pluginUpdateAvailable: false,
        pluginIssue: null,
      };

      await cache.setServerConnectionStatus('srv-1', status);

      // TTL should be 600 (SERVER_CONNECTION = 600)
      const key = 'tracearr:servers:srv-1:connection';
      expect(redis.ttls.get(key)).toBe(600);
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
      // Verify scan was used (KEYS replaced with SCAN for performance)
      expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'tracearr:sessions:*', 'COUNT', 100);
    });

    it('should not call del when no keys match pattern', async () => {
      await cache.invalidatePattern('nonexistent:*');

      expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'nonexistent:*', 'COUNT', 100);
      // del should not be called since no keys matched
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('withSessionCreateLock', () => {
    it('acquires the lock with a TTL of at least 60s', async () => {
      await cache.withSessionCreateLock('server-1', 'session-key-1', async () => 'ok');

      expect(redis.set).toHaveBeenCalledWith(
        'session:lock:server-1:session-key-1',
        expect.any(String),
        'EX',
        60,
        'NX'
      );
      const setCall = (redis.set as any).mock.calls[0];
      expect(setCall[3]).toBeGreaterThanOrEqual(60);
    });

    it("does not let holder A's release free holder B's lock after A's lock expired", async () => {
      const lockKey = 'session:lock:server-1:session-key-1';

      // Holder A acquires the lock.
      await cache.withSessionCreateLock('server-1', 'session-key-1', async () => {
        // Simulate the lock expiring mid-operation and holder B acquiring it
        // with its own token, exactly like Redis would after the TTL elapses.
        redis.store.delete(lockKey);
        const secondAcquired = await redis.set(lockKey, 'holder-b-token', 'EX', 60, 'NX');
        expect(secondAcquired).toBe('OK');
        return 'a-result';
      });

      // Holder A's finally-block release must not have deleted holder B's lock.
      expect(redis.store.get(lockKey)).toBe('holder-b-token');
    });

    it('returns null and skips the operation when the lock is already held', async () => {
      const lockKey = 'session:lock:server-1:session-key-1';
      redis.store.set(lockKey, 'existing-token');

      const operation = vi.fn().mockResolvedValue('should-not-run');
      const result = await cache.withSessionCreateLock('server-1', 'session-key-1', operation);

      expect(result).toBeNull();
      expect(operation).not.toHaveBeenCalled();
    });

    it('releases its own lock after the operation completes', async () => {
      const lockKey = 'session:lock:server-1:session-key-1';

      await cache.withSessionCreateLock('server-1', 'session-key-1', async () => 'ok');

      expect(redis.store.has(lockKey)).toBe(false);
    });

    it('releases its own lock even when the operation throws', async () => {
      const lockKey = 'session:lock:server-1:session-key-1';

      await expect(
        cache.withSessionCreateLock('server-1', 'session-key-1', async () => {
          throw new Error('operation failed');
        })
      ).rejects.toThrow('operation failed');

      expect(redis.store.has(lockKey)).toBe(false);
    });
  });

  describe('addSessionWriteRetry / getSessionWriteRetries / removeSessionWriteRetry', () => {
    it('records a new retry with attempts starting at 1', async () => {
      await cache.addSessionWriteRetry('session-1', 5000, { stoppedAt: 1000, forceStopped: false });

      const retries = await cache.getSessionWriteRetries();

      expect(retries).toEqual([
        {
          sessionId: 'session-1',
          attempts: 1,
          startedAt: 5000,
          stopData: { stoppedAt: 1000, forceStopped: false },
        },
      ]);
    });

    it('preserves the attempt count across a re-add for the same session (hsetnx)', async () => {
      await cache.addSessionWriteRetry('session-1', 5000, { stoppedAt: 1000, forceStopped: false });
      await cache.incrementSessionWriteRetry('session-1');
      await cache.incrementSessionWriteRetry('session-1');

      // A later failed stop attempt for the same session re-adds it to the queue.
      await cache.addSessionWriteRetry('session-1', 5000, { stoppedAt: 2000, forceStopped: true });

      const retries = await cache.getSessionWriteRetries();

      expect(retries).toEqual([
        {
          sessionId: 'session-1',
          attempts: 3,
          startedAt: 5000,
          stopData: { stoppedAt: 2000, forceStopped: true },
        },
      ]);
    });

    it('sets a TTL on the retry set itself, not just the per-session hash', async () => {
      await cache.addSessionWriteRetry('session-1', 5000, { stoppedAt: 1000, forceStopped: false });

      expect(redis.ttls.get('tracearr:session:write-retry:pending')).toBe(3600);
    });

    it('srems a set member whose per-session hash already expired', async () => {
      // Simulate a zombie: present in the SET but its hash TTL'd out separately.
      redis.sets.set('tracearr:session:write-retry:pending', new Set(['zombie-session']));

      const retries = await cache.getSessionWriteRetries();

      expect(retries).toEqual([]);
      const members = await redis.smembers('tracearr:session:write-retry:pending');
      expect(members).not.toContain('zombie-session');
    });

    it('leaves live members in the set alongside a swept zombie', async () => {
      await cache.addSessionWriteRetry('live-session', 5000, {
        stoppedAt: 1000,
        forceStopped: false,
      });
      await redis.sadd('tracearr:session:write-retry:pending', 'zombie-session');

      const retries = await cache.getSessionWriteRetries();

      expect(retries.map((r) => r.sessionId)).toEqual(['live-session']);
      const members = await redis.smembers('tracearr:session:write-retry:pending');
      expect(members).toEqual(['live-session']);
    });

    it('removes both the hash and the set member', async () => {
      await cache.addSessionWriteRetry('session-1', 5000, { stoppedAt: 1000, forceStopped: false });

      await cache.removeSessionWriteRetry('session-1');

      const retries = await cache.getSessionWriteRetries();
      expect(retries).toEqual([]);
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

    it('skips dashboard invalidation when skipDashboardInvalidation is set', async () => {
      const session = createTestActiveSession('session-1');
      await cache.addActiveSession(session);
      (redis.scan as any).mockClear();

      await cache.removeActiveSession('session-1', { skipDashboardInvalidation: true });

      expect(redis.scan).not.toHaveBeenCalled();
      // Set membership removal still happens immediately.
      const ids = await redis.smembers('tracearr:sessions:active:ids');
      expect(ids).not.toContain('session-1');
    });

    it('still invalidates dashboard stats when skipDashboardInvalidation is false', async () => {
      const session = createTestActiveSession('session-1');
      await cache.addActiveSession(session);
      (redis.scan as any).mockClear();

      await cache.removeActiveSession('session-1', { skipDashboardInvalidation: false });

      expect(redis.scan).toHaveBeenCalled();
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

    it('refreshes the TTL of a present-but-unchanged session', async () => {
      // Paused Plex sessions emit no SSE events, so the reconciliation pass is the
      // only thing keeping their cache entry alive. It passes every session in the
      // poll response through the `updated` array regardless of whether anything
      // changed, so that pass must still be a setex (not a no-op) for this session.
      const session = createTestActiveSession('session-1');
      await cache.addActiveSession(session);

      const key = 'tracearr:sessions:session-1';
      redis.ttls.set(key, 1); // simulate a nearly-expired entry

      await cache.incrementalSyncActiveSessions([], [], [session]);

      expect(redis.ttls.get(key)).toBe(CACHE_TTL.ACTIVE_SESSIONS);
    });
  });

  describe('ACTIVE_SESSIONS TTL vs reconciliation interval', () => {
    it('gives at least 4 reconciliation cycles of headroom before a present session could expire', () => {
      const reconciliationIntervalSeconds = POLLING_INTERVALS.SSE_RECONCILIATION / 1000;

      expect(CACHE_TTL.ACTIVE_SESSIONS).toBeGreaterThanOrEqual(4 * reconciliationIntervalSeconds);
    });
  });

  describe('dashboard stats invalidation gating', () => {
    it('does not invalidate dashboard stats on a progress-only sync (updates only)', async () => {
      await cache.addActiveSession(createTestActiveSession('session-1'));
      (redis.scan as any).mockClear();

      const updated = { ...createTestActiveSession('session-1'), progressMs: 5000 };
      await cache.incrementalSyncActiveSessions([], [], [updated], false);

      expect(redis.scan).not.toHaveBeenCalled();
    });

    it('invalidates dashboard stats when a new session was added', async () => {
      (redis.scan as any).mockClear();

      await cache.incrementalSyncActiveSessions([createTestActiveSession('new-1')], [], [], false);

      expect(redis.scan).toHaveBeenCalled();
    });

    it('invalidates dashboard stats when a session stopped', async () => {
      await cache.addActiveSession(createTestActiveSession('session-1'));
      (redis.scan as any).mockClear();

      await cache.incrementalSyncActiveSessions([], ['session-1'], [], false);

      expect(redis.scan).toHaveBeenCalled();
    });

    it('invalidates dashboard stats when a watched transition occurred, even with only updates', async () => {
      await cache.addActiveSession(createTestActiveSession('session-1'));
      (redis.scan as any).mockClear();

      const updated = { ...createTestActiveSession('session-1'), watched: true };
      await cache.incrementalSyncActiveSessions([], [], [updated], true);

      expect(redis.scan).toHaveBeenCalled();
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

  describe('public channel', () => {
    it('repeats allowlisted events on the public channel and never fails on a public publish error', async () => {
      const failing = {
        publish: vi.fn(async (channel: string) => {
          if (channel.endsWith('public:events')) throw new Error('channel down');
          return 1;
        }),
      };
      const service = createPubSubService(failing as never, subscriber);

      await expect(service.publish('session:stopped', 'abc')).resolves.toBeUndefined();
      const channels = failing.publish.mock.calls.map(([channel]) => channel);
      expect(channels.filter((c) => c.endsWith('tracearr:events'))).toHaveLength(1);
      expect(channels.filter((c) => c.endsWith('public:events'))).toHaveLength(1);

      await service.publish('stats:updated', {});
      expect(failing.publish.mock.calls.filter(([c]) => c.endsWith('public:events'))).toHaveLength(
        1
      );
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
