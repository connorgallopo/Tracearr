/**
 * History and Map "pick a user" dropdown identity filters
 *
 * Closes the last merged-user gap: GET /sessions/filter-options and
 * GET /stats/locations used to list a merged person once PER SERVER ACCOUNT.
 * They now collapse to one entry per identity (representative account as the
 * id, plus an additive serverUserIds array covering every account), and the
 * history endpoint accepts that full array to filter a person's whole history.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- historyMapIdentityFilters
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { locationsRoutes } from '../../src/routes/stats/locations.js';
import { mergeUsers } from '../../src/services/mergeService.js';
import { permissionGuard } from '../../src/lib/scope.js';

function ownerAuth(userId: string) {
  return { userId, username: 'owner', role: 'owner' as const, serverIds: [] as string[] };
}

async function buildApp(
  plugin: Parameters<typeof Fastify.prototype.register>[0],
  authenticate?: (request: any) => Promise<void>
) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  app.decorate(
    'authenticate',
    authenticate ??
      (async (request: any) => {
        request.user = ownerAuth('owner');
      })
  );
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (request.user.role !== 'owner') return reply.forbidden('Owner access required');
  });
  await app.register(plugin as any);
  return app;
}

async function setupMergedPerson() {
  const admin = await createTestUser({ role: 'owner' });
  const serverA = await createTestServer({ type: 'plex' });
  const serverB = await createTestServer({ type: 'jellyfin' });

  const target = await createTestUser({ role: 'member', name: 'Merged Person' });
  const source = await createTestUser({ role: 'member' });
  const targetSu = await createTestServerUser({
    userId: target.id,
    serverId: serverA.id,
    lastActivityAt: new Date('2026-06-01T00:00:00Z'),
  });
  const sourceSu = await createTestServerUser({
    userId: source.id,
    serverId: serverB.id,
    lastActivityAt: new Date('2026-06-02T00:00:00Z'),
  });

  await createTestSession({ serverId: serverA.id, serverUserId: targetSu.id, durationMs: 600_000 });
  await createTestSession({ serverId: serverB.id, serverUserId: sourceSu.id, durationMs: 900_000 });

  await mergeUsers(source.id, target.id, admin.id);

  return { admin, serverA, serverB, target, source, targetSu, sourceSu };
}

describe('GET /sessions/filter-options - identity dedup', () => {
  it('returns one entry for a merged 2-server person, both account ids in serverUserIds, representative as id', async () => {
    const { targetSu, sourceSu } = await setupMergedPerson();

    const app = await buildApp(sessionRoutes);
    const response = await app.inject({ method: 'GET', url: '/filter-options' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const users = body.users as {
      id: string;
      identityName: string | null;
      serverUserIds: string[];
    }[];

    const mergedEntries = users.filter((u) => u.identityName === 'Merged Person');
    expect(mergedEntries).toHaveLength(1);
    const entry = mergedEntries[0]!;
    // sourceSu is the more recently active account, so it's the representative
    expect(entry.id).toBe(sourceSu.id);
    expect(entry.serverUserIds.sort()).toEqual([targetSu.id, sourceSu.id].sort());
  });

  it('leaves an unmerged user as a single entry with only their own account id', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const solo = await createTestUser({ role: 'member', name: 'Solo Person' });
    const soloSu = await createTestServerUser({ userId: solo.id, serverId: serverA.id });
    await createTestSession({ serverId: serverA.id, serverUserId: soloSu.id, durationMs: 300_000 });

    const app = await buildApp(sessionRoutes);
    const response = await app.inject({ method: 'GET', url: '/filter-options' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const users = body.users as {
      id: string;
      identityName: string | null;
      serverUserIds: string[];
    }[];

    const soloEntries = users.filter((u) => u.id === soloSu.id);
    expect(soloEntries).toHaveLength(1);
    expect(soloEntries[0]?.serverUserIds).toEqual([soloSu.id]);
  });

  it('scopes a merged person to servers the caller can access', async () => {
    const { serverA, targetSu, sourceSu } = await setupMergedPerson();

    const viewerAuth = async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'admin',
        serverIds: [serverA.id],
      };
    };

    const app = await buildApp(sessionRoutes, viewerAuth);
    const response = await app.inject({ method: 'GET', url: '/filter-options' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const users = body.users as {
      id: string;
      identityName: string | null;
      serverUserIds: string[];
    }[];

    const mergedEntries = users.filter((u) => u.identityName === 'Merged Person');
    expect(mergedEntries).toHaveLength(1);
    const entry = mergedEntries[0]!;
    // Only the serverA account is visible to this viewer - not the merged-in
    // serverB account, even though they belong to the same identity.
    expect(entry.id).toBe(targetSu.id);
    expect(entry.serverUserIds).toEqual([targetSu.id]);
    expect(entry.serverUserIds).not.toContain(sourceSu.id);
  });
});

describe('GET /stats/locations - identity dedup', () => {
  it('lists the availableFilters.users entry once for a merged person with both account ids', async () => {
    // createTestSession defaults to a New York geo point, which is all the
    // locations endpoint needs to surface these accounts in its filter list.
    const { targetSu, sourceSu } = await setupMergedPerson();

    const app = await buildApp(locationsRoutes);
    const response = await app.inject({ method: 'GET', url: '/locations?period=all' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const users = body.availableFilters.users as {
      id: string;
      identityName: string | null;
      serverUserIds: string[];
    }[];

    const mergedEntries = users.filter((u) => u.identityName === 'Merged Person');
    expect(mergedEntries).toHaveLength(1);
    expect(mergedEntries[0]?.serverUserIds.sort()).toEqual([targetSu.id, sourceSu.id].sort());
  });
});

describe('GET /sessions/history - person-level filtering', () => {
  it("returns sessions from both of a merged person's accounts when filtered by their full serverUserIds array", async () => {
    const { targetSu, sourceSu } = await setupMergedPerson();

    const app = await buildApp(sessionRoutes);
    const response = await app.inject({
      method: 'GET',
      url: `/history?serverUserIds=${targetSu.id},${sourceSu.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const rows = body.data as { id: string }[];
    // One grouped play per account (each createTestSession call is a separate play)
    expect(rows).toHaveLength(2);
  });
});
