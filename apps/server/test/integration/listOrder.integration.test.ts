/**
 * Whole-list ordering against a real database
 *
 * The Alpine image compares text by bytes, so the filter-option users and the
 * library options are sorted in JS with an en-US collator, and server lists
 * order by display order with the name as the tiebreak.
 *
 * Run with: pnpm --filter @tracearr/server test:integration listOrder
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
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
import { libraryLibrariesRoute } from '../../src/routes/library/libraries.js';
import { permissionGuard } from '../../src/lib/scope.js';

const MEMBER_NAMES = ['Bob', 'alice', '_x', 'Émile', 'Zed'];

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
  await app.register(libraryLibrariesRoute, { prefix: '/library' });
  return app;
}

async function seed() {
  const zed = await createTestServer({ name: 'Zed', type: 'plex' });
  const alice = await createTestServer({ name: 'alice', type: 'plex' });
  for (const [index, name] of MEMBER_NAMES.entries()) {
    const user = await createTestUser({ name, username: `member${index}` });
    const account = await createTestServerUser({
      userId: user.id,
      serverId: zed.id,
      username: `account${index}`,
    });
    await createTestSession({
      serverId: zed.id,
      serverUserId: account.id,
      startedAt: new Date(Date.UTC(2026, 0, 1 + index)),
      state: 'stopped',
    });
  }
  const libraries: { serverId: string; libraryId: string; name: string; mediaType: string }[] = [
    { serverId: alice.id, libraryId: '1', name: 'Movies', mediaType: 'movie' },
    { serverId: alice.id, libraryId: '2', name: 'anime', mediaType: 'show' },
    { serverId: zed.id, libraryId: '3', name: 'TV', mediaType: 'show' },
  ];
  for (const library of libraries) {
    await db.execute(sql`
      INSERT INTO libraries (server_id, library_id, name, media_type)
      VALUES (${library.serverId}, ${library.libraryId}, ${library.name}, ${library.mediaType})
    `);
  }
}

describe('whole-list ordering', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    await resetTestDb();
    await seed();
    app = await buildApp();
    return () => app.close();
  });

  it('lists filter-option users by display name, case and accents folded', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions/filter-options' });
    expect(
      res
        .json()
        .users.map(
          (u: { identityName: string | null; username: string }) => u.identityName ?? u.username
        )
    ).toEqual(['_x', 'alice', 'Bob', 'Émile', 'Zed']);
  });

  it('lists filter-option servers by display order then name', async () => {
    const res = await app.inject({ method: 'GET', url: '/sessions/filter-options' });
    expect(res.json().servers.map((s: { name: string }) => s.name)).toEqual(['alice', 'Zed']);
  });

  it('lists libraries by server order then library name', async () => {
    const res = await app.inject({ method: 'GET', url: '/library/libraries' });
    expect(
      res.json().data.map((l: { serverName: string; name: string }) => `${l.serverName}/${l.name}`)
    ).toEqual(['alice/anime', 'alice/Movies', 'Zed/TV']);
  });
});
