/**
 * History paging for the Content and Duration sorts
 *
 * The page CTE orders by the requested sort, the final SELECT keeps that
 * order through the page's row number, and the cursor carries the sort key,
 * so walking every page ascending or descending yields each play exactly
 * once in sort order.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- historySortPaging
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { HistorySessionResponse } from '@tracearr/shared';
import { resetTestDb } from '@tracearr/test-utils/db';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { permissionGuard } from '../../src/lib/scope.js';

const TITLES: { title: string; sortTitle: string; durationMs: number }[] = [
  { title: 'Zed', sortTitle: 'zed', durationMs: 5_000_000 },
  { title: 'alice', sortTitle: 'alice', durationMs: 1_000_000 },
  { title: '_x', sortTitle: 'x', durationMs: 3_000_000 },
  { title: 'Émile', sortTitle: 'emile', durationMs: 4_000_000 },
  { title: 'Bob', sortTitle: 'bob', durationMs: 2_000_000 },
];

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  app.decorate('authenticate', async (request: any) => {
    request.user = { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (request.user.role !== 'owner') return reply.forbidden('Owner access required');
  });
  await app.register(sessionRoutes, { prefix: '/sessions' });
  return app;
}

async function seed() {
  const owner = await createTestUser({ role: 'owner' });
  const server = await createTestServer({ type: 'plex' });
  const account = await createTestServerUser({ userId: owner.id, serverId: server.id });
  for (const [index, entry] of TITLES.entries()) {
    const mediaId = randomUUID();
    await db.execute(sql`
      INSERT INTO media (id, media_type, match_key, title, sort_title)
      VALUES (${mediaId}, 'movie', ${`movie:title:${entry.sortTitle}:0`}, ${entry.title}, ${entry.sortTitle})
    `);
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaTitle: entry.title,
      mediaId,
      durationMs: entry.durationMs,
      startedAt: new Date(Date.UTC(2026, 0, 1 + index)),
      state: 'stopped',
    });
  }
  return account;
}

async function seedTrackAndEpisode(account: { id: string; serverId: string }) {
  const pilotId = randomUUID();
  await db.execute(sql`
    INSERT INTO media (id, media_type, match_key, title, sort_title)
    VALUES (${pilotId}, 'episode', 'episode:title:pilot:0', 'Pilot', 'pilot')
  `);
  await createTestSession({
    serverId: account.serverId,
    serverUserId: account.id,
    mediaType: 'track',
    mediaTitle: 'Zebra Song',
    grandparentTitle: 'Alice Artist',
    startedAt: new Date(Date.UTC(2026, 0, 10)),
    state: 'stopped',
  });
  await createTestSession({
    serverId: account.serverId,
    serverUserId: account.id,
    mediaType: 'episode',
    mediaTitle: 'Pilot',
    grandparentTitle: 'Bob Show',
    mediaId: pilotId,
    startedAt: new Date(Date.UTC(2026, 0, 11)),
    state: 'stopped',
  });
}

async function walk(
  app: Awaited<ReturnType<typeof buildApp>>,
  orderBy: 'mediaTitle' | 'durationMs',
  orderDir: 'asc' | 'desc'
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ orderBy, orderDir, pageSize: '2' });
    if (cursor) query.set('cursor', cursor);
    const res = await app.inject({ method: 'GET', url: `/sessions/history?${query}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HistorySessionResponse;
    seen.push(...body.data.map((row) => row.mediaTitle));
    if (!body.hasMore) return seen;
    expect(body.nextCursor).toBeDefined();
    cursor = body.nextCursor;
  }
  throw new Error('did not reach the last page');
}

describe('history paging under the Content and Duration sorts', () => {
  let account: Awaited<ReturnType<typeof seed>>;

  beforeEach(async () => {
    await resetTestDb();
    account = await seed();
  });

  it('walks the Content sort ascending in key order without repeating or dropping a play', async () => {
    const app = await buildApp();
    expect(await walk(app, 'mediaTitle', 'asc')).toEqual(['alice', 'Bob', 'Émile', '_x', 'Zed']);
    await app.close();
  });

  it('walks the Content sort descending', async () => {
    const app = await buildApp();
    expect(await walk(app, 'mediaTitle', 'desc')).toEqual(['Zed', '_x', 'Émile', 'Bob', 'alice']);
    await app.close();
  });

  it('walks the Duration sort in numeric order both ways', async () => {
    const app = await buildApp();
    expect(await walk(app, 'durationMs', 'desc')).toEqual(['Zed', 'Émile', '_x', 'Bob', 'alice']);
    expect(await walk(app, 'durationMs', 'asc')).toEqual(['alice', 'Bob', '_x', 'Émile', 'Zed']);
    await app.close();
  });

  it('keys an episode on its show and a track on its own title', async () => {
    await seedTrackAndEpisode(account);
    const app = await buildApp();
    expect(await walk(app, 'mediaTitle', 'asc')).toEqual([
      'alice',
      'Bob',
      'Pilot',
      'Émile',
      '_x',
      'Zebra Song',
      'Zed',
    ]);
    await app.close();
  });

  it('rejects a Content cursor that carries no sort key', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/sessions/history?orderBy=mediaTitle&cursor=${Date.now()}_${randomUUID()}`,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
