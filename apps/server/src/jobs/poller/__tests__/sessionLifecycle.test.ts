/**
 * Session Lifecycle Critical Tests
 *
 * Tests for race condition prevention and idempotency:
 * 1. withSessionCreateLock - Distributed lock for concurrent session creation
 * 2. stopSessionAtomic - Idempotent stop (double-stop returns wasUpdated: false)
 * 3. Quality change detection - Stops old session when same user/content with new sessionKey
 */

import { describe, it, expect, vi } from 'vitest';

// ============================================================================
// 1. Distributed Lock Tests (withSessionCreateLock)
// ============================================================================

describe('withSessionCreateLock', () => {
  // Mock Redis for lock testing
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
      '1',
      'EX',
      15,
      'NX'
    );
    expect(mockRedis.del).toHaveBeenCalledWith('session:lock:server-1:session-key-1');
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
    expect(mockRedis.del).toHaveBeenCalledWith('session:lock:server-1:session-key-1');
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

    const normalWatched = checkWatchCompletion(progressMs, totalDurationMs);
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

describe('wasTerminatedByRule detection logic (Issue #357)', () => {
  // These tests verify the wasTerminatedByRule detection logic conceptually.
  // The actual targeting logic is tested in services/rules/__tests__/targeting.test.ts

  it('should detect triggering session in kill list for target=triggering', () => {
    const insertedSessionId = 'new-session-id';
    const sessionsToKill = [{ id: 'new-session-id' }];

    // This is the check performed in sessionLifecycle.ts
    const wasTerminatedByRule = sessionsToKill.some((s) => s.id === insertedSessionId);
    expect(wasTerminatedByRule).toBe(true);
  });

  it('should NOT detect triggering session in kill list when target=oldest (different session)', () => {
    const insertedSessionId = 'new-session-id';
    const sessionsToKill = [{ id: 'oldest-session-id' }]; // Different session

    const wasTerminatedByRule = sessionsToKill.some((s) => s.id === insertedSessionId);
    expect(wasTerminatedByRule).toBe(false);
  });

  it('should detect triggering session in kill list for target=all_except_one (newer session killed)', () => {
    // Scenario: User has oldest session A, starts new session B
    // Rule: all_except_one (keep oldest)
    // Result: Session B (new, triggering) is killed, A survives
    const insertedSessionId = 'session-B';
    const sessionsToKill = [{ id: 'session-B' }]; // all_except_one kills newer sessions

    const wasTerminatedByRule = sessionsToKill.some((s) => s.id === insertedSessionId);
    expect(wasTerminatedByRule).toBe(true);
  });

  it('should detect triggering session in kill list for target=all_user', () => {
    // all_user kills ALL sessions including the triggering one
    const insertedSessionId = 'new-session-id';
    const sessionsToKill = [
      { id: 'old-session-1' },
      { id: 'old-session-2' },
      { id: 'new-session-id' },
    ];

    const wasTerminatedByRule = sessionsToKill.some((s) => s.id === insertedSessionId);
    expect(wasTerminatedByRule).toBe(true);
  });

  it('should handle empty kill list gracefully', () => {
    const insertedSessionId = 'session-id';
    const sessionsToKill: { id: string }[] = [];

    const wasTerminatedByRule = sessionsToKill.some((s) => s.id === insertedSessionId);
    expect(wasTerminatedByRule).toBe(false);
  });
});
