/**
 * Redis-based Rate Limiter for Push Notifications
 *
 * Uses sliding window counters in Redis to enforce per-minute and per-hour
 * limits on push notifications for each mobile session. This prevents
 * notification spam and respects user preferences.
 */

import type { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';

/**
 * Result of a rate limit check
 */
export interface RateLimitResult {
  /** Whether the notification is allowed */
  allowed: boolean;
  /** Remaining notifications in the minute window */
  remainingMinute: number;
  /** Remaining notifications in the hour window */
  remainingHour: number;
  /** Seconds until the minute window resets */
  resetMinuteIn: number;
  /** Seconds until the hour window resets */
  resetHourIn: number;
  /** Which limit was exceeded (if any) */
  exceededLimit?: 'minute' | 'hour';
}

/**
 * Rate limit preferences for a session
 */
export interface RateLimitPrefs {
  maxPerMinute: number;
  maxPerHour: number;
}

/**
 * Lua script for atomic rate limit check-and-increment
 *
 * KEYS[1] = minute key
 * KEYS[2] = hour key
 * ARGV[1] = max per minute
 * ARGV[2] = max per hour
 *
 * Returns: [allowed (0/1), minuteCount, hourCount, minuteTTL, hourTTL, exceededLimit (0=none, 1=minute, 2=hour)]
 */
const RATE_LIMIT_SCRIPT = `
local minuteKey = KEYS[1]
local hourKey = KEYS[2]
local maxPerMinute = tonumber(ARGV[1])
local maxPerHour = tonumber(ARGV[2])

-- Get current counts
local minuteCount = tonumber(redis.call('GET', minuteKey) or '0')
local hourCount = tonumber(redis.call('GET', hourKey) or '0')

-- Get TTLs
local minuteTTL = redis.call('TTL', minuteKey)
local hourTTL = redis.call('TTL', hourKey)

-- Check minute limit first
if minuteCount >= maxPerMinute then
  return {0, minuteCount, hourCount, minuteTTL, hourTTL, 1}
end

-- Check hour limit
if hourCount >= maxPerHour then
  return {0, minuteCount, hourCount, minuteTTL, hourTTL, 2}
end

-- Increment minute counter atomically
local newMinuteCount = redis.call('INCR', minuteKey)
if minuteTTL < 0 then
  redis.call('EXPIRE', minuteKey, 60)
  minuteTTL = 60
end

-- Increment hour counter atomically
local newHourCount = redis.call('INCR', hourKey)
if hourTTL < 0 then
  redis.call('EXPIRE', hourKey, 3600)
  hourTTL = 3600
end

return {1, newMinuteCount, newHourCount, minuteTTL, hourTTL, 0}
`;

/**
 * Push notification rate limiter using Redis sliding windows
 */
export class PushRateLimiter {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Check if a notification is allowed and record it if so
   *
   * Uses a Lua script for atomic check-and-increment to prevent race conditions.
   * Returns the result including remaining limits and reset times.
   */
  async checkAndRecord(mobileSessionId: string, prefs: RateLimitPrefs): Promise<RateLimitResult> {
    const minuteKey = REDIS_KEYS.PUSH_RATE_MINUTE(mobileSessionId);
    const hourKey = REDIS_KEYS.PUSH_RATE_HOUR(mobileSessionId);

    // Execute atomic Lua script
    const result = (await this.redis.eval(
      RATE_LIMIT_SCRIPT,
      2,
      minuteKey,
      hourKey,
      prefs.maxPerMinute.toString(),
      prefs.maxPerHour.toString()
    )) as [number, number, number, number, number, number];

    const [allowed, minuteCount, hourCount, minuteTTL, hourTTL, exceededLimit] = result;

    // Calculate remaining
    const remainingMinute = Math.max(0, prefs.maxPerMinute - minuteCount);
    const remainingHour = Math.max(0, prefs.maxPerHour - hourCount);

    // Calculate reset times (TTL returns -2 if key doesn't exist, -1 if no expiry)
    const resetMinuteIn = minuteTTL > 0 ? minuteTTL : 60;
    const resetHourIn = hourTTL > 0 ? hourTTL : 3600;

    if (!allowed) {
      return {
        allowed: false,
        remainingMinute: exceededLimit === 1 ? 0 : remainingMinute,
        remainingHour: exceededLimit === 2 ? 0 : remainingHour,
        resetMinuteIn,
        resetHourIn,
        exceededLimit: exceededLimit === 1 ? 'minute' : 'hour',
      };
    }

    return {
      allowed: true,
      remainingMinute,
      remainingHour,
      resetMinuteIn,
      resetHourIn,
    };
  }

  /**
   * Check rate limit status without recording (for UI display)
   */
  async getStatus(
    mobileSessionId: string,
    prefs: RateLimitPrefs
  ): Promise<Omit<RateLimitResult, 'allowed' | 'exceededLimit'>> {
    const minuteKey = REDIS_KEYS.PUSH_RATE_MINUTE(mobileSessionId);
    const hourKey = REDIS_KEYS.PUSH_RATE_HOUR(mobileSessionId);

    const [minuteCount, hourCount, minuteTTL, hourTTL] = await Promise.all([
      this.redis.get(minuteKey).then((v) => parseInt(v ?? '0', 10)),
      this.redis.get(hourKey).then((v) => parseInt(v ?? '0', 10)),
      this.redis.ttl(minuteKey),
      this.redis.ttl(hourKey),
    ]);

    return {
      remainingMinute: Math.max(0, prefs.maxPerMinute - minuteCount),
      remainingHour: Math.max(0, prefs.maxPerHour - hourCount),
      resetMinuteIn: minuteTTL > 0 ? minuteTTL : 60,
      resetHourIn: hourTTL > 0 ? hourTTL : 3600,
    };
  }

  /**
   * Reset rate limits for a session (for testing/admin)
   */
  async reset(mobileSessionId: string): Promise<void> {
    const minuteKey = REDIS_KEYS.PUSH_RATE_MINUTE(mobileSessionId);
    const hourKey = REDIS_KEYS.PUSH_RATE_HOUR(mobileSessionId);

    await this.redis.del(minuteKey, hourKey);
  }
}

// Module-level instance storage
let rateLimiterInstance: PushRateLimiter | null = null;

/**
 * Initialize the push rate limiter with a Redis connection
 */
export function initPushRateLimiter(redis: Redis): PushRateLimiter {
  rateLimiterInstance = new PushRateLimiter(redis);
  return rateLimiterInstance;
}

/**
 * Get the global push rate limiter instance
 * Returns null if not initialized
 */
export function getPushRateLimiter(): PushRateLimiter | null {
  return rateLimiterInstance;
}
