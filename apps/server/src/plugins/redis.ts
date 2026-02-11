/**
 * Redis client plugin for Fastify
 */

import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { setRedisPrefix } from '@tracearr/shared';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

const redisPlugin: FastifyPluginAsync = async (app) => {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redisPrefix = process.env.REDIS_PREFIX ?? '';
  if (redisPrefix) {
    setRedisPrefix(redisPrefix);
    app.log.info({ prefix: redisPrefix }, 'Redis key prefix configured');
  }

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    reconnectOnError(err: Error) {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    },
  });

  redis.on('connect', () => {
    app.log.info('Redis connected');
  });

  redis.on('error', (err: Error) => {
    app.log.error({ err }, 'Redis error');
  });

  app.decorate('redis', redis);

  app.addHook('onClose', async () => {
    await redis.quit();
  });
};

export default fp(redisPlugin, {
  name: 'redis',
});
