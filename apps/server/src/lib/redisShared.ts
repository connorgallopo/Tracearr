/**
 * Redis accessor for the Better Auth instance, the Plex login plugin, and the
 * SSE stats recorder. Prefers the Fastify plugin's client (see plugins/redis.ts)
 * so the process holds one connection with one retry policy and one error handler.
 */

import { Redis } from 'ioredis';

// TTL only on creation: a rate-limit window is fixed from first hit, later
// increments must not slide it. Lua instead of EXPIRE NX (7.0+) because
// self-hosted Redis versions vary and the repo documents no minimum; scripts
// run on anything 2.6+.
export const INCREMENT_SCRIPT = `local value = redis.call('INCR', KEYS[1])
if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return value`;

// Lua instead of GETDEL (6.2+) for the reason INCREMENT_SCRIPT gives.
export const GET_AND_DELETE_SCRIPT = `local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value`;

/** The Fastify plugin's client. Owned by the plugin - closeRedis must not quit it. */
let injected: Redis | null = null;
/** Only created when nothing injected a client: scripts and unit tests. */
let fallback: Redis | null = null;

export function setSharedRedis(redis: Redis): void {
  injected = redis;
}

export function getRedis(): Redis {
  if (injected) return injected;
  fallback ??= new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return fallback;
}

export async function closeRedis(): Promise<void> {
  if (fallback) {
    await fallback.quit();
    fallback = null;
  }
}
