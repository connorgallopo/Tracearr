/**
 * The latest-snapshot reads bound to the last 7 days first and fall back to the whole history
 * for libraries the window missed, so a library whose last snapshot is old still counts, even
 * when its libraries row is gone.
 *
 * Run with: pnpm --filter @tracearr/server test:integration libraryLatestSnapshot
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { AuthUser, LibraryStatsResponse } from '@tracearr/shared';
import { sql } from 'drizzle-orm';
import { createTestServer } from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { latestSnapshotFor } from '../../src/db/librarySnapshots.js';
import { libraryStatsRoute } from '../../src/routes/library/stats.js';
import { permissionGuard } from '../../src/lib/scope.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  const owner: AuthUser = { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = owner;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('redis', createMockRedis() as unknown as Redis);
  await app.register(libraryStatsRoute, { prefix: '/library' });
  return app;
}

async function snapshot(serverId: string, libraryId: string, daysAgo: number, items: number) {
  await db.execute(sql`
    INSERT INTO library_snapshots (server_id, library_id, snapshot_time, item_count, total_size, movie_count, count_4k)
    VALUES (${serverId}::uuid, ${libraryId}, now() - make_interval(days => ${daysAgo}), ${items}, 1, ${items}, 1)
  `);
}

describe('latest library snapshot reads', () => {
  it('counts a library with no libraries row whose latest snapshot is 50 days old', async () => {
    const server = await createTestServer({ type: 'plex' });
    await db.execute(sql`
      INSERT INTO libraries (server_id, library_id, name, media_type)
      VALUES (${server.id}::uuid, 'recent', 'Recent', 'movie')
    `);
    await snapshot(server.id, 'recent', 1, 10);
    await snapshot(server.id, 'recent', 3, 99);
    await snapshot(server.id, 'gone', 50, 5);
    await snapshot(server.id, 'gone', 80, 77);

    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: `/library/stats?serverId=${server.id}` });
      expect(res.statusCode).toBe(200);
      const stats = res.json() as LibraryStatsResponse;
      expect(stats.totalItems).toBe(15);
      expect(stats.movieCount).toBe(15);
      expect(stats.qualityBreakdown['4k']).toBe(2);
    } finally {
      await app.close();
    }

    expect((await latestSnapshotFor(server.id, 'gone'))?.itemCount).toBe(5);
    expect((await latestSnapshotFor(server.id, 'recent'))?.itemCount).toBe(10);
    expect(await latestSnapshotFor(server.id, 'none')).toBeUndefined();
  });
});
