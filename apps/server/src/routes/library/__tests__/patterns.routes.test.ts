/**
 * Library patterns route tests
 *
 * db.execute is mocked, so these prove which window reaches every session query, not the SQL
 * itself; libraryWatch.integration.test.ts covers the queries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import { renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

import { db } from '../../../db/client.js';
import { libraryPatternsRoute } from '../patterns.js';
import { permissionGuard } from '../../../lib/scope.js';

function createSpyRedis() {
  return {
    get: vi.fn(async (_key: string) => null),
    setex: vi.fn(async (_key: string, _seconds: number, _value: string) => 'OK'),
  };
}

async function buildTestApp(redis: ReturnType<typeof createSpyRedis>): Promise<FastifyInstance> {
  const owner: AuthUser = { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = owner;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('redis', redis as never);
  await app.register(libraryPatternsRoute, { prefix: '/library' });
  return app;
}

const executed = () => vi.mocked(db.execute).mock.calls.map(([query]) => renderSql(query as never));

describe('GET /library/patterns', () => {
  let app: FastifyInstance;
  let redis: ReturnType<typeof createSpyRedis>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T15:00:00.000Z'));
    vi.mocked(db.execute).mockReset();
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
    redis = createSpyRedis();
    app = await buildTestApp(redis);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  it('passes the window to every session query', async () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-15T00:00:00.000Z');
    const response = await app.inject({
      method: 'GET',
      url: `/library/patterns?startDate=${start.toISOString()}&endDate=${end.toISOString()}`,
    });

    expect(response.statusCode).toBe(200);
    const queries = executed();
    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query.sql).toContain('sess.started_at >=');
      expect(query.params).toEqual(expect.arrayContaining([start, end]));
    }
    expect(response.json().trend).toEqual({
      bucket: 'day',
      points: [],
      busiest: null,
      quietest: null,
    });
    expect(String(redis.setex.mock.calls[0]?.[0])).toContain(
      `custom:${start.toISOString()}:${end.toISOString()}`
    );
  });

  it('drops periodWeeks', async () => {
    const response = await app.inject({ method: 'GET', url: '/library/patterns?periodWeeks=104' });

    expect(response.statusCode).toBe(200);
    for (const query of executed()) {
      expect(query.sql).not.toContain("INTERVAL '1 week' *");
      expect(query.params).toContainEqual(new Date('2026-09-23T00:00:00.000Z'));
    }
    expect(String(redis.setex.mock.calls[0]?.[0])).not.toContain('104');
  });
});
