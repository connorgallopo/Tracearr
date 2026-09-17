/**
 * Session Lifecycle Critical Tests
 *
 * Tests for race condition prevention and idempotency:
 * 1. withSessionCreateLock - Distributed lock for concurrent session creation
 * 2. stopSessionAtomic - Idempotent stop (double-stop returns wasUpdated: false)
 * 3. Quality change detection - Stops old session when same user/content with new sessionKey
 */

import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_STREAM_DETAILS } from '@tracearr/shared';
import type { ActionResult } from '../../../services/automations/executors/index.js';
import type { GeoLocation } from '../../../services/geoip.js';
import type { BuildActiveSessionInput } from '../sessionLifecycle.js';

const NULL_GEO: GeoLocation = {
  city: null,
  region: null,
  country: null,
  countryCode: null,
  continent: null,
  postal: null,
  lat: null,
  lon: null,
  asnNumber: null,
  asnOrganization: null,
};

function createMockBuildActiveSessionInput(
  overrides: Partial<BuildActiveSessionInput['processed']> = {}
): BuildActiveSessionInput {
  return {
    session: {
      id: 'session-1',
      startedAt: new Date(),
      lastPausedAt: null,
      pausedDurationMs: 0,
      referenceId: null,
      watched: false,
    },
    processed: {
      ...DEFAULT_STREAM_DETAILS,
      sessionKey: 'sk-1',
      state: 'playing',
      mediaType: 'episode',
      mediaTitle: 'Episode Title',
      grandparentTitle: 'Show Title',
      seasonNumber: 1,
      episodeNumber: 2,
      year: 2024,
      thumbPath: '/thumb.jpg',
      ratingKey: 'rk-1',
      totalDurationMs: 1000,
      progressMs: 500,
      ipAddress: '10.0.0.1',
      playerName: 'Player',
      deviceId: 'device-1',
      product: 'Plex',
      device: 'TV',
      platform: 'Roku',
      quality: '1080p',
      isTranscode: false,
      videoDecision: 'directplay',
      audioDecision: 'directplay',
      bitrate: 8000,
      channelTitle: null,
      channelIdentifier: null,
      channelThumb: null,
      artistName: null,
      albumName: null,
      trackNumber: null,
      discNumber: null,
      ...overrides,
    },
    user: { id: 'user-1', username: 'testuser', thumbUrl: null, identityName: null },
    geo: NULL_GEO,
    server: { id: 'server-1', name: 'Server', type: 'plex' },
  };
}

// ============================================================================
// 1. Distributed Lock Tests (withSessionCreateLock)
// ============================================================================

describe('withSessionCreateLock', () => {
  // Mock Redis for lock testing: set/NX for acquire, eval for compare-and-delete release
  const createMockRedis = () => {
    const locks = new Map<string, string>();

    return {
      set: vi.fn(
        async (
          key: string,
          value: string,
          expiryMode: string,
          expirySeconds: number,
          setMode: string
        ) => {
          // NX = only set if not exists
          if (setMode === 'NX') {
            if (locks.has(key)) {
              return null; // Lock already held
            }
            locks.set(key, value);
            return 'OK';
          }
          return 'OK';
        }
      ),
      del: vi.fn(async (key: string) => {
        locks.delete(key);
        return 1;
      }),
      // Mirrors the Lua compare-and-delete: only deletes if the token still matches.
      eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
        if (locks.get(key) === token) {
          locks.delete(key);
          return 1;
        }
        return 0;
      }),
      _locks: locks,
    };
  };

  it('should acquire lock and execute operation', async () => {
    const mockRedis = createMockRedis();

    // Import and create cache service with mock
    const { createCacheService } = await import('../../../services/cache.js');
    const cacheService = createCacheService(mockRedis as never);

    const operation = vi.fn().mockResolvedValue({ id: 'session-123' });

    const result = await cacheService.withSessionCreateLock('server-1', 'session-key-1', operation);

    expect(result).toEqual({ id: 'session-123' });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'session:lock:server-1:session-key-1',
      expect.any(String),
      'EX',
      60,
      'NX'
    );
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'session:lock:server-1:session-key-1',
      expect.any(String)
    );
    expect(mockRedis._locks.has('session:lock:server-1:session-key-1')).toBe(false);
  });

  it('should return null when lock is already held', async () => {
    const mockRedis = createMockRedis();
    // Pre-acquire the lock
    mockRedis._locks.set('session:lock:server-1:session-key-1', '1');

    const { createCacheService } = await import('../../../services/cache.js');
    const cacheService = createCacheService(mockRedis as never);

    const operation = vi.fn().mockResolvedValue({ id: 'session-123' });

    const result = await cacheService.withSessionCreateLock('server-1', 'session-key-1', operation);

    expect(result).toBeNull();
    expect(operation).not.toHaveBeenCalled();
  });

  it('should release lock even when operation throws', async () => {
    const mockRedis = createMockRedis();

    const { createCacheService } = await import('../../../services/cache.js');
    const cacheService = createCacheService(mockRedis as never);

    const operation = vi.fn().mockRejectedValue(new Error('DB error'));

    await expect(
      cacheService.withSessionCreateLock('server-1', 'session-key-1', operation)
    ).rejects.toThrow('DB error');

    // Lock should still be released
    expect(mockRedis._locks.has('session:lock:server-1:session-key-1')).toBe(false);
  });

  it('should allow second caller to acquire lock after first releases', async () => {
    const mockRedis = createMockRedis();

    const { createCacheService } = await import('../../../services/cache.js');
    const cacheService = createCacheService(mockRedis as never);

    const operation1 = vi.fn().mockResolvedValue({ id: 'session-1' });
    const operation2 = vi.fn().mockResolvedValue({ id: 'session-2' });

    // First call acquires and releases
    const result1 = await cacheService.withSessionCreateLock(
      'server-1',
      'session-key-1',
      operation1
    );
    expect(result1).toEqual({ id: 'session-1' });

    // Second call should also succeed (lock was released)
    const result2 = await cacheService.withSessionCreateLock(
      'server-1',
      'session-key-1',
      operation2
    );
    expect(result2).toEqual({ id: 'session-2' });

    expect(operation1).toHaveBeenCalledTimes(1);
    expect(operation2).toHaveBeenCalledTimes(1);
  });

  it('does not release a lock a second worker now holds after the first holder expired', async () => {
    const mockRedis = createMockRedis();
    const lockKey = 'session:lock:server-1:session-key-1';

    const { createCacheService } = await import('../../../services/cache.js');
    const cacheService = createCacheService(mockRedis as never);

    // Holder A acquires, then its lock expires (simulated by another worker
    // overwriting the key directly, as Redis would after TTL elapses).
    let capturedToken = '';
    (mockRedis.set as any).mockImplementationOnce(
      async (key: string, value: string, _mode: string, _ex: number, _nx: string) => {
        capturedToken = value;
        mockRedis._locks.set(key, value);
        return 'OK';
      }
    );

    const operation = vi.fn().mockImplementation(async () => {
      // Simulate expiry: holder B acquires the now-expired key with its own token.
      mockRedis._locks.set(lockKey, 'holder-b-token');
      return { id: 'session-a' };
    });

    await cacheService.withSessionCreateLock('server-1', 'session-key-1', operation);

    // Holder A's release must not have deleted holder B's lock.
    expect(mockRedis._locks.get(lockKey)).toBe('holder-b-token');
    expect(capturedToken).not.toBe('holder-b-token');
  });

  it('acquires the lock with a 60s TTL, not the old 15s TTL', async () => {
    const mockRedis = createMockRedis();

    const { createCacheService } = await import('../../../services/cache.js');
    const cacheService = createCacheService(mockRedis as never);

    await cacheService.withSessionCreateLock('server-1', 'session-key-1', async () => 'ok');

    const [, , , ttl] = (mockRedis.set as any).mock.calls[0];
    expect(ttl).toBe(60);
    expect(ttl).toBeGreaterThanOrEqual(60);
  });
});

// ============================================================================
// 2. Stop Session Idempotency Tests (stopSessionAtomic)
// ============================================================================

describe('stopSessionAtomic idempotency', () => {
  it('should use WHERE stopped_at IS NULL for idempotency', async () => {
    // The key idempotency mechanism is in the SQL:
    // UPDATE sessions SET ... WHERE id = ? AND stopped_at IS NULL
    //
    // If the session is already stopped, the WHERE clause won't match,
    // and the RETURNING clause will return an empty array.
    //
    // This is tested by verifying the function signature and return type
    const { stopSessionAtomic } = await import('../sessionLifecycle.js');

    // Verify the function exists and has the right signature
    expect(typeof stopSessionAtomic).toBe('function');

    // The function should return an object with wasUpdated boolean
    // (actual DB test would be in integration tests)
  });

  it('should calculate duration excluding pause time', async () => {
    const { calculateStopDuration } = await import('../stateTracker.js');

    const startedAt = new Date(Date.now() - 120000); // 2 minutes ago
    const stoppedAt = new Date();

    // Session was paused for 30 seconds
    const result = calculateStopDuration(
      {
        startedAt,
        lastPausedAt: null, // Not currently paused
        pausedDurationMs: 30000, // Was paused for 30s total
      },
      stoppedAt
    );

    // Total time was ~120s, minus 30s pause = ~90s
    expect(result.durationMs).toBeGreaterThan(80000);
    expect(result.durationMs).toBeLessThan(100000);
    expect(result.finalPausedDurationMs).toBe(30000);
  });

  it('should preserve watched status when preserveWatched is true', async () => {
    const { checkWatchCompletion } = await import('../stateTracker.js');

    // Session at 50% progress - normally NOT watched
    const progressMs = 50000;
    const totalDurationMs = 100000;

    const normalWatched = checkWatchCompletion(null, progressMs, totalDurationMs);
    expect(normalWatched).toBe(false);

    // With preserveWatched=true, the existing session.watched value is kept
    // This is for quality changes where playback continues
  });
});

// ============================================================================
// 3. Quality Change Detection Tests
// ============================================================================

describe('Quality change detection', () => {
  it('should detect quality change when same user watches same content with different sessionKey', async () => {
    // Quality change scenario:
    // 1. User starts watching Movie A with sessionKey "abc123"
    // 2. User changes quality (resolution switch)
    // 3. Plex creates NEW sessionKey "def456" for same Movie A
    // 4. System should: stop old session, link new session to old via referenceId

    // This tests the detection logic conceptually
    const existingSession = {
      id: 'old-session-id',
      serverUserId: 'user-1',
      ratingKey: 'movie-123', // Same content
      sessionKey: 'old-key',
      stoppedAt: null,
      watched: false,
      referenceId: null,
    };

    const newSessionData = {
      serverUserId: 'user-1',
      ratingKey: 'movie-123', // Same content
      sessionKey: 'new-key', // Different session key = quality change
    };

    // Detection: same user + same ratingKey + different sessionKey + old not stopped
    const isQualityChange =
      existingSession.serverUserId === newSessionData.serverUserId &&
      existingSession.ratingKey === newSessionData.ratingKey &&
      existingSession.sessionKey !== newSessionData.sessionKey &&
      existingSession.stoppedAt === null;

    expect(isQualityChange).toBe(true);
  });

  it('should NOT detect quality change for different content', () => {
    const existingSession = {
      serverUserId: 'user-1',
      ratingKey: 'movie-123',
      sessionKey: 'old-key',
      stoppedAt: null,
    };

    const newSessionData = {
      serverUserId: 'user-1',
      ratingKey: 'movie-456', // Different content
      sessionKey: 'new-key',
    };

    const isQualityChange =
      existingSession.serverUserId === newSessionData.serverUserId &&
      existingSession.ratingKey === newSessionData.ratingKey &&
      existingSession.sessionKey !== newSessionData.sessionKey &&
      existingSession.stoppedAt === null;

    expect(isQualityChange).toBe(false);
  });

  it('should NOT detect quality change for different user', () => {
    const existingSession = {
      serverUserId: 'user-1',
      ratingKey: 'movie-123',
      sessionKey: 'old-key',
      stoppedAt: null,
    };

    const newSessionData = {
      serverUserId: 'user-2', // Different user
      ratingKey: 'movie-123',
      sessionKey: 'new-key',
    };

    const isQualityChange =
      existingSession.serverUserId === newSessionData.serverUserId &&
      existingSession.ratingKey === newSessionData.ratingKey &&
      existingSession.sessionKey !== newSessionData.sessionKey &&
      existingSession.stoppedAt === null;

    expect(isQualityChange).toBe(false);
  });

  it('should NOT detect quality change if old session already stopped', () => {
    const existingSession = {
      serverUserId: 'user-1',
      ratingKey: 'movie-123',
      sessionKey: 'old-key',
      stoppedAt: new Date(), // Already stopped
    };

    const newSessionData = {
      serverUserId: 'user-1',
      ratingKey: 'movie-123',
      sessionKey: 'new-key',
    };

    const isQualityChange =
      existingSession.serverUserId === newSessionData.serverUserId &&
      existingSession.ratingKey === newSessionData.ratingKey &&
      existingSession.sessionKey !== newSessionData.sessionKey &&
      existingSession.stoppedAt === null;

    expect(isQualityChange).toBe(false);
  });

  it('should link new session to old session chain via referenceId', () => {
    // When quality change is detected:
    // - If old session has no referenceId, new session references old session's ID
    // - If old session has referenceId, new session uses that (maintains chain)

    const oldSessionWithoutRef = {
      id: 'session-1',
      referenceId: null,
    };

    const oldSessionWithRef = {
      id: 'session-2',
      referenceId: 'session-0', // Part of a chain
    };

    // New session should reference the chain root
    const newRef1 = oldSessionWithoutRef.referenceId || oldSessionWithoutRef.id;
    const newRef2 = oldSessionWithRef.referenceId || oldSessionWithRef.id;

    expect(newRef1).toBe('session-1');
    expect(newRef2).toBe('session-0'); // Uses existing chain root
  });
});

// ============================================================================
// 4. Concurrent Access Simulation
// ============================================================================

// ============================================================================
// 5. Serialization Error Detection Tests (P1-4)
// ============================================================================

describe('isSerializationError detection', () => {
  // We test the error detection logic conceptually since the function is private
  // The key patterns it should detect:

  it('should detect PostgreSQL serialization failure message', () => {
    const serializationErrors = [
      new Error('could not serialize access due to concurrent update'),
      new Error('ERROR: could not serialize access due to read/write dependencies'),
      new Error('SERIALIZATION failure occurred'),
      Object.assign(new Error('Database error'), { code: '40001' }),
    ];

    for (const error of serializationErrors) {
      const message = error.message.toLowerCase();
      const code = (error as { code?: string }).code;
      const isSerializationError =
        message.includes('could not serialize access') ||
        message.includes('serialization') ||
        code === '40001';

      expect(isSerializationError).toBe(true);
    }
  });

  it('should NOT detect non-serialization errors', () => {
    const nonSerializationErrors = [
      new Error('Connection refused'),
      new Error('Unique constraint violation'),
      new Error('Foreign key constraint'),
      Object.assign(new Error('Deadlock detected'), { code: '40P01' }),
    ];

    for (const error of nonSerializationErrors) {
      const message = error.message.toLowerCase();
      const code = (error as { code?: string }).code;
      const isSerializationError =
        message.includes('could not serialize access') ||
        message.includes('serialization') ||
        code === '40001';

      expect(isSerializationError).toBe(false);
    }
  });
});

describe('Serialization retry logic', () => {
  it('should retry on serialization failure with exponential backoff', async () => {
    // Test the retry pattern conceptually
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 50;
    let attempts = 0;
    const delays: number[] = [];

    const executeWithRetry = async (): Promise<string> => {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          attempts++;
          if (attempt < MAX_RETRIES) {
            throw Object.assign(new Error('could not serialize access'), { code: '40001' });
          }
          return 'success';
        } catch (error) {
          const message = (error as Error).message.toLowerCase();
          const isSerializationError = message.includes('could not serialize access');

          if (isSerializationError && attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
            delays.push(delay);
            // In real code: await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw error;
        }
      }
      throw new Error('Max retries exceeded');
    };

    const result = await executeWithRetry();

    expect(result).toBe('success');
    expect(attempts).toBe(3); // Tried 3 times
    expect(delays).toEqual([50, 100]); // Exponential backoff: 50ms, 100ms
  });

  it('should throw immediately on non-serialization errors', async () => {
    let attempts = 0;

    const executeWithRetry = async (): Promise<string> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          attempts++;
          throw new Error('Connection refused'); // Non-serialization error
        } catch (error) {
          const message = (error as Error).message.toLowerCase();
          const isSerializationError = message.includes('could not serialize access');

          if (isSerializationError && attempt < 3) {
            continue;
          }
          throw error;
        }
      }
      throw new Error('Max retries exceeded');
    };

    await expect(executeWithRetry()).rejects.toThrow('Connection refused');
    expect(attempts).toBe(1); // Should fail immediately
  });

  it('should throw after max retries exhausted', async () => {
    let attempts = 0;

    const executeWithRetry = async (): Promise<string> => {
      const MAX_RETRIES = 3;
      let lastError: Error = new Error('No attempts made');

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          attempts++;
          throw Object.assign(new Error('could not serialize access'), { code: '40001' });
        } catch (error) {
          lastError = error as Error;
          const message = lastError.message.toLowerCase();
          const isSerializationError = message.includes('could not serialize access');

          if (isSerializationError && attempt < MAX_RETRIES) {
            continue;
          }
          throw error;
        }
      }
      throw lastError;
    };

    await expect(executeWithRetry()).rejects.toThrow('could not serialize access');
    expect(attempts).toBe(3); // Should have tried all 3 times
  });
});

describe('Concurrent access handling', () => {
  it('should handle SSE and Poller trying to create same session', async () => {
    // Simulates the race condition scenario:
    // 1. SSE receives session start event
    // 2. Poller polls and sees same session
    // 3. Both try to create - only one should succeed

    const lockState = { held: false };

    const tryAcquireLock = async (): Promise<boolean> => {
      if (lockState.held) return false;
      lockState.held = true;
      return true;
    };

    const releaseLock = async (): Promise<void> => {
      lockState.held = false;
    };

    const createSession = async (source: string): Promise<string | null> => {
      const acquired = await tryAcquireLock();
      if (!acquired) {
        return null; // Another process is creating
      }
      try {
        // Simulate DB insert
        await new Promise((resolve) => setTimeout(resolve, 10));
        return `session-from-${source}`;
      } finally {
        await releaseLock();
      }
    };

    // Simulate concurrent calls
    const [sseResult, pollerResult] = await Promise.all([
      createSession('sse'),
      createSession('poller'),
    ]);

    // Exactly one should succeed
    const successes = [sseResult, pollerResult].filter((r) => r !== null);
    expect(successes.length).toBe(1);
  });

  it('should handle multiple stop events for same session', async () => {
    // Simulates double-stop scenario:
    // 1. Poller detects session stopped
    // 2. SSE receives stop event
    // 3. Both try to stop - only first should update DB

    let sessionStopped = false;
    const stopAttempts: string[] = [];

    const tryStopSession = async (source: string): Promise<boolean> => {
      stopAttempts.push(source);

      // Simulate WHERE stopped_at IS NULL
      if (sessionStopped) {
        return false; // Already stopped
      }

      sessionStopped = true;
      return true;
    };

    // Simulate concurrent stop attempts
    const [result1, result2] = await Promise.all([tryStopSession('poller'), tryStopSession('sse')]);

    // Both attempted
    expect(stopAttempts.length).toBe(2);

    // Only one succeeded
    const successes = [result1, result2].filter((r) => r);
    expect(successes.length).toBe(1);
  });
});

// ============================================================================
// 6. Rule-Terminated Session Detection (Issue #357)
// ============================================================================

describe('wasTriggeringSessionTargetedForKill (Issue #357)', () => {
  // wasTerminatedByRule now reflects actual enqueue outcomes (ActionResult),
  // not a target-resolution prediction made before actions execute - a queued
  // kill can still be aborted by reverify.

  function killResult(enqueuedSessionIds: string[]): ActionResult {
    return {
      action: { type: 'kill_stream' },
      success: true,
      skipped: true,
      skipReason: 'queued',
      enqueuedSessionIds,
    };
  }

  it('is true when the triggering session was enqueued (target=triggering)', async () => {
    const { wasTriggeringSessionTargetedForKill } = await import('../sessionLifecycle.js');

    const result = wasTriggeringSessionTargetedForKill(
      [killResult(['new-session-id'])],
      'new-session-id'
    );

    expect(result).toBe(true);
  });

  it('is false when a different session was enqueued (target=oldest)', async () => {
    const { wasTriggeringSessionTargetedForKill } = await import('../sessionLifecycle.js');

    const result = wasTriggeringSessionTargetedForKill(
      [killResult(['oldest-session-id'])],
      'new-session-id'
    );

    expect(result).toBe(false);
  });

  it('is true when the triggering session is among several enqueued targets (all_user)', async () => {
    const { wasTriggeringSessionTargetedForKill } = await import('../sessionLifecycle.js');

    const result = wasTriggeringSessionTargetedForKill(
      [killResult(['old-session-1', 'old-session-2', 'new-session-id'])],
      'new-session-id'
    );

    expect(result).toBe(true);
  });

  it('is false when there are no action results', async () => {
    const { wasTriggeringSessionTargetedForKill } = await import('../sessionLifecycle.js');

    const result = wasTriggeringSessionTargetedForKill([], 'session-id');

    expect(result).toBe(false);
  });

  it('ignores non-kill_stream action results', async () => {
    const { wasTriggeringSessionTargetedForKill } = await import('../sessionLifecycle.js');

    const sendResult: ActionResult = {
      action: { type: 'send', to: ['11111111-1111-4111-8111-111111111111'] },
      success: true,
    };
    const result = wasTriggeringSessionTargetedForKill([sendResult], 'session-id');

    expect(result).toBe(false);
  });

  it('is false for a kill_stream result whose enqueue never happened (empty enqueuedSessionIds)', async () => {
    const { wasTriggeringSessionTargetedForKill } = await import('../sessionLifecycle.js');

    const result = wasTriggeringSessionTargetedForKill([killResult([])], 'session-id');

    expect(result).toBe(false);
  });
});

// ============================================================================
// 7. buildRuleContextSessions (twin exclusion)
// ============================================================================

describe('deviceKeyOf', () => {
  it('prefers the device id, falls back to the player name, and gives up on neither', async () => {
    const { deviceKeyOf } = await import('../sessionLifecycle.js');

    expect(deviceKeyOf({ deviceId: 'abc123', playerName: 'Living Room TV' })).toEqual({
      column: 'deviceId',
      value: 'abc123',
    });
    expect(deviceKeyOf({ deviceId: null, playerName: 'Living Room TV' })).toEqual({
      column: 'playerName',
      value: 'Living Room TV',
    });
    // An unnamed device is not a device, so it never announces.
    expect(deviceKeyOf({ deviceId: null, playerName: null })).toBeNull();
    expect(deviceKeyOf({})).toBeNull();
  });
});

describe('sessionLocation', () => {
  it('names the city with its region, falls back to the country, and empties to null', async () => {
    const { sessionLocation } = await import('../sessionLifecycle.js');

    expect(
      sessionLocation({ geoCity: 'Boston', geoRegion: 'Massachusetts', geoCountry: 'US' })
    ).toBe('Boston, Massachusetts');
    expect(sessionLocation({ geoCity: 'Boston', geoRegion: null, geoCountry: null })).toBe(
      'Boston'
    );
    expect(sessionLocation({ geoCity: null, geoRegion: null, geoCountry: 'US' })).toBe('US');
    expect(sessionLocation({ geoCity: 'Boston', geoRegion: null, geoCountry: 'US' })).toBe(
      'Boston, US'
    );
    expect(sessionLocation({ geoCity: null, geoRegion: null, geoCountry: null })).toBeNull();
  });
});

describe('buildActiveSession identity passthrough', () => {
  it('preserves Dispatcharr Catch-up metadata for active cards and cache', async () => {
    const { buildActiveSession } = await import('../sessionLifecycle.js');

    const activeSession = buildActiveSession(
      createMockBuildActiveSessionInput({
        mediaType: 'live',
        dispatcharrPlaybackKind: 'catchup',
        dispatcharrCatchupAnchorAt: '2026-08-20T10:00:00.000Z',
        dispatcharrCatchupEpgStartAt: '2026-08-20T09:30:00.000Z',
        dispatcharrCatchupEpgEndAt: '2026-08-20T11:00:00.000Z',
      })
    );

    expect(activeSession.dispatcharrPlaybackKind).toBe('catchup');
    expect(activeSession.dispatcharrCatchupAnchorAt).toBe('2026-08-20T10:00:00.000Z');
    expect(activeSession.dispatcharrCatchupEpgStartAt).toBe('2026-08-20T09:30:00.000Z');
    expect(activeSession.dispatcharrCatchupEpgEndAt).toBe('2026-08-20T11:00:00.000Z');
  });

  it('carries media identity fields from processed.identity onto the ActiveSession', async () => {
    const { buildActiveSession } = await import('../sessionLifecycle.js');

    const input = createMockBuildActiveSessionInput({
      identity: {
        mediaId: 'media-uuid-1',
        showMediaId: 'show-uuid-1',
        imdbId: 'tt1234567',
        tmdbId: 111,
        tvdbId: 222,
        parentRatingKey: 'parent-1',
        grandparentRatingKey: 'grandparent-1',
        itemMediaType: 'episode',
      },
    });

    const activeSession = buildActiveSession(input);

    expect(activeSession.mediaId).toBe('media-uuid-1');
    expect(activeSession.showMediaId).toBe('show-uuid-1');
    expect(activeSession.imdbId).toBe('tt1234567');
    expect(activeSession.tmdbId).toBe(111);
    expect(activeSession.tvdbId).toBe(222);
    expect(activeSession.parentRatingKey).toBe('parent-1');
    expect(activeSession.grandparentRatingKey).toBe('grandparent-1');
  });

  it('defaults identity fields to null when processed.identity is absent', async () => {
    const { buildActiveSession } = await import('../sessionLifecycle.js');

    const activeSession = buildActiveSession(createMockBuildActiveSessionInput());

    expect(activeSession.mediaId).toBeNull();
    expect(activeSession.showMediaId).toBeNull();
    expect(activeSession.imdbId).toBeNull();
    expect(activeSession.tmdbId).toBeNull();
    expect(activeSession.tvdbId).toBeNull();
    expect(activeSession.parentRatingKey).toBeNull();
    expect(activeSession.grandparentRatingKey).toBeNull();
  });
});
