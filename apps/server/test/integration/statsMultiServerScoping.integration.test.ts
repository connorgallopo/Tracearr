/**
 * Multi-server scoping integration tests for /stats/top-content.
 *
 * Confirms the endpoint honors a `serverIds` subset (not just the legacy single
 * `serverId`), and that a non-owner can never widen results past their own
 * accessible servers by passing extra serverIds.
 *
 * Run with: pnpm --filter @tracearr/server test:integration statsMultiServerScoping
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { AuthUser } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { contentRoutes } from '../../src/routes/stats/content.js';
import { permissionGuard } from '../../src/lib/scope.js';

function ownerAuth(): AuthUser {
  return { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
}

function viewerAuth(serverIds: string[]): AuthUser {
  return { userId: 'viewer', username: 'viewer', role: 'admin', serverIds };
}

async function buildApp(
  plugin: Parameters<typeof Fastify.prototype.register>[0],
  authUser: AuthUser
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  await app.register(plugin as never);
  return app;
}

describe('stats multi-server scoping', () => {
  describe('GET /stats/top-content', () => {
    it('only aggregates movies from the servers listed in serverIds', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const userA = await createTestUser({ role: 'member' });
      const userB = await createTestUser({ role: 'member' });
      const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
      const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: suA.id,
        mediaTitle: 'Movie On A',
        mediaType: 'movie',
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: suB.id,
        mediaTitle: 'Movie On B',
        mediaType: 'movie',
      });

      const app = await buildApp(contentRoutes, ownerAuth());
      const response = await app.inject({
        method: 'GET',
        url: `/top-content?period=all&serverIds=${serverA.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const titles = (response.json().movies as { title: string }[]).map((m) => m.title);
      expect(titles).toContain('Movie On A');
      expect(titles).not.toContain('Movie On B');
    });

    it('still supports the legacy single serverId param', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const userA = await createTestUser({ role: 'member' });
      const userB = await createTestUser({ role: 'member' });
      const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
      const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: suA.id,
        mediaTitle: 'Legacy Movie On A',
        mediaType: 'movie',
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: suB.id,
        mediaTitle: 'Legacy Movie On B',
        mediaType: 'movie',
      });

      const app = await buildApp(contentRoutes, ownerAuth());
      const response = await app.inject({
        method: 'GET',
        url: `/top-content?period=all&serverId=${serverA.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const titles = (response.json().movies as { title: string }[]).map((m) => m.title);
      expect(titles).toContain('Legacy Movie On A');
      expect(titles).not.toContain('Legacy Movie On B');
    });

    it('a non-owner cannot widen results past their own servers via serverIds', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const userA = await createTestUser({ role: 'member' });
      const userB = await createTestUser({ role: 'member' });
      const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
      const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: suA.id,
        mediaTitle: 'Viewer Movie On A',
        mediaType: 'movie',
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: suB.id,
        mediaTitle: 'Viewer Movie On B',
        mediaType: 'movie',
      });

      // Viewer only has access to serverA but asks for both servers explicitly.
      const app = await buildApp(contentRoutes, viewerAuth([serverA.id]));
      const response = await app.inject({
        method: 'GET',
        url: `/top-content?period=all&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const titles = (response.json().movies as { title: string }[]).map((m) => m.title);
      expect(titles).toContain('Viewer Movie On A');
      expect(titles).not.toContain('Viewer Movie On B');
    });
  });
});
