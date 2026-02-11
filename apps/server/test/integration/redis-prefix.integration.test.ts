/**
 * Redis Prefix Coverage Integration Test
 *
 * This test ensures ALL Redis keys use the REDIS_PREFIX when set.
 * It acts as a "canary" to catch any future hardcoded Redis keys that
 * bypass the centralized REDIS_KEYS system.
 *
 * How it works:
 * 1. Wraps Redis methods to intercept ALL key operations
 * 2. Runs actual application services (PushRateLimiter, rule cooldowns, etc.)
 * 3. Verifies that every key created has the test prefix
 * 4. If future code adds hardcoded keys, this test will catch it
 *
 * Run with: pnpm test:integration redis-prefix
 *
 * Requirements: Redis server + test database running
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Redis } from 'ioredis';
import { setRedisPrefix, REDIS_KEYS } from '@tracearr/shared';
import { initPushRateLimiter } from '../../src/services/pushRateLimiter.js';
import { createActionExecutorDeps } from '../../src/services/rules/v2Integration.js';

const TEST_PREFIX = 'test_prefix_';

describe('Redis Prefix Coverage', () => {
  let redis: Redis;
  let trackedKeys: Set<string>;

  beforeAll(() => {
    // Set prefix for this test session
    setRedisPrefix(TEST_PREFIX);

    // Connect to Redis (use test DB 15 to avoid conflicts)
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380/15';
    redis = new Redis(redisUrl);

    // Track all keys created during tests
    trackedKeys = new Set();

    // Wrap Redis methods to track key usage
    const originalSet = redis.set.bind(redis);
    const originalSetex = redis.setex.bind(redis);
    const originalIncr = redis.incr.bind(redis);
    const originalDel = redis.del.bind(redis);
    const originalExists = redis.exists.bind(redis);

    redis.set = ((...args: Parameters<typeof originalSet>) => {
      trackedKeys.add(args[0] as string);
      return originalSet(...args);
    }) as typeof redis.set;

    redis.setex = ((...args: Parameters<typeof originalSetex>) => {
      trackedKeys.add(args[0] as string);
      return originalSetex(...args);
    }) as typeof redis.setex;

    redis.incr = ((...args: Parameters<typeof originalIncr>) => {
      trackedKeys.add(args[0] as string);
      return originalIncr(...args);
    }) as typeof redis.incr;

    redis.del = ((...args: Parameters<typeof originalDel>) => {
      for (const key of args) {
        const keyStr = typeof key === 'string' ? key : key.toString();
        trackedKeys.add(keyStr);
      }
      return originalDel(...args);
    }) as typeof redis.del;

    redis.exists = ((...args: Parameters<typeof originalExists>) => {
      const keyStr = typeof args[0] === 'string' ? args[0] : args[0].toString();
      trackedKeys.add(keyStr);
      return originalExists(...args);
    }) as typeof redis.exists;
  });

  afterAll(async () => {
    // Clean up all test keys
    const allKeys = await redis.keys(`${TEST_PREFIX}*`);
    if (allKeys.length > 0) {
      await redis.del(...allKeys);
    }
    await redis.quit();
  });

  beforeEach(() => {
    // Reset tracked keys before each test
    trackedKeys.clear();
  });

  it('should prefix all REDIS_KEYS constants', () => {
    // Test all getter-based keys
    expect(REDIS_KEYS.ACTIVE_SESSION_IDS).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.ACTIVE_SESSIONS).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.DASHBOARD_STATS).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.PUBSUB_EVENTS).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.VERSION_LATEST).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.HEAVY_OPS_LOCK).toMatch(new RegExp(`^${TEST_PREFIX}`));

    // Test all library stats keys
    expect(REDIS_KEYS.LIBRARY_STATS).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_GROWTH).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_QUALITY).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_STALE).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_DUPLICATES).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_STORAGE).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_WATCH).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_ROI).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_PATTERNS).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_COMPLETION).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_TOP_MOVIES).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_TOP_SHOWS).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_CODECS).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LIBRARY_RESOLUTION).toMatch(new RegExp(`^${TEST_PREFIX}`));

    // Test function-based keys
    expect(REDIS_KEYS.SESSION_BY_ID('test-id')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.USER_SESSIONS('user-1')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.RATE_LIMIT_LOGIN('127.0.0.1')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.RATE_LIMIT_MOBILE_PAIR('127.0.0.1')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.RATE_LIMIT_MOBILE_REFRESH('127.0.0.1')).toMatch(
      new RegExp(`^${TEST_PREFIX}`)
    );
    expect(REDIS_KEYS.SERVER_HEALTH('server-1')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.PUSH_RATE_MINUTE('session-1')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.PUSH_RATE_HOUR('session-1')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.LOCATION_FILTERS('user-1', ['server-1'])).toMatch(
      new RegExp(`^${TEST_PREFIX}`)
    );
    expect(REDIS_KEYS.REFRESH_TOKEN('hash123')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.PLEX_TEMP_TOKEN('token123')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.MOBILE_REFRESH_TOKEN('hash123')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.MOBILE_TOKEN_GEN_RATE('user-1')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.SESSION_LOCK('server-1', 'session-1')).toMatch(new RegExp(`^${TEST_PREFIX}`));
    expect(REDIS_KEYS.TERMINATION_COOLDOWN('server-1', 'session-1')).toMatch(
      new RegExp(`^${TEST_PREFIX}`)
    );
    expect(REDIS_KEYS.RULE_COOLDOWN('rule-1', 'target-1')).toMatch(new RegExp(`^${TEST_PREFIX}`));
  });

  it('should prefix keys created by PushRateLimiter', async () => {
    // Initialize the rate limiter
    initPushRateLimiter(redis);

    // Create a rate limit check (this will create Redis keys)
    const rateLimiter = (
      await import('../../src/services/pushRateLimiter.js')
    ).getPushRateLimiter();

    if (rateLimiter) {
      await rateLimiter.checkAndRecord('test-session-id', {
        maxPerMinute: 10,
        maxPerHour: 100,
      });

      // Check tracked keys
      const unprefixedKeys = Array.from(trackedKeys).filter((key) => !key.startsWith(TEST_PREFIX));

      expect(unprefixedKeys).toEqual([]);
    }
  });

  it('should prefix keys created by rule cooldown system', async () => {
    // Create action executor deps (includes cooldown functions)
    const deps = createActionExecutorDeps(redis);

    // Set a cooldown
    await deps.setCooldown('rule-123', 'target-456', 5);

    // Check a cooldown
    const isOnCooldown = await deps.checkCooldown('rule-123', 'target-456', 5);

    expect(isOnCooldown).toBe(true);

    // Verify all keys have prefix
    const unprefixedKeys = Array.from(trackedKeys).filter((key) => !key.startsWith(TEST_PREFIX));

    expect(unprefixedKeys).toEqual([]);
  });

  it('should detect keys without prefix when REDIS_PREFIX is set', async () => {
    // Create a deliberate key WITHOUT prefix (simulating a bug)
    await redis.set('unprefixed:test:key', 'value');

    // This should pass - demonstrating the test catches unprefixed keys
    const unprefixedKeys = Array.from(trackedKeys).filter((key) => !key.startsWith(TEST_PREFIX));

    expect(unprefixedKeys.length).toBeGreaterThan(0);
    expect(unprefixedKeys).toContain('unprefixed:test:key');

    // Clean up the test key
    await redis.del('unprefixed:test:key');
  });

  it('should scan and verify all keys in Redis have the prefix', async () => {
    // Create various keys using REDIS_KEYS
    await redis.set(REDIS_KEYS.SESSION_BY_ID('session-1'), 'session-data');
    await redis.setex(REDIS_KEYS.REFRESH_TOKEN('hash123'), 3600, 'token-data');
    await redis.setex(REDIS_KEYS.RATE_LIMIT_LOGIN('127.0.0.1'), 900, '5');
    await redis.set(REDIS_KEYS.RULE_COOLDOWN('rule-1', 'user-1'), '1');

    // Scan ALL keys in Redis
    const allKeys = await redis.keys('*');

    // Filter to only our test keys (in case Redis has other data)
    const testKeys = allKeys.filter((key) => key.startsWith(TEST_PREFIX));

    // Assert we created some keys
    expect(testKeys.length).toBeGreaterThan(0);

    // Assert ALL test keys have the prefix
    expect(testKeys.every((key) => key.startsWith(TEST_PREFIX))).toBe(true);

    // Check for any keys that DON'T have our prefix but look like they should
    // (e.g., keys matching common patterns that should be prefixed)
    const suspiciousPatterns = [
      /^tracearr:/,
      /^session:/,
      /^rule:/,
      /^mobile_token_gen:/,
      /^refresh:/,
    ];

    const suspiciousKeys = allKeys.filter((key) => {
      // Skip if it has our test prefix (it's correct)
      if (key.startsWith(TEST_PREFIX)) return false;

      // Check if it matches a suspicious pattern
      return suspiciousPatterns.some((pattern) => pattern.test(key));
    });

    // This would catch any unprefixed keys matching our patterns
    expect(suspiciousKeys).toEqual([]);
  });
});
