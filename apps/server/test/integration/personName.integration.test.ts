/**
 * A person's name under a server filter
 *
 * The filter decides which person rows appear and which account a row describes, never the
 * name: a person row names the Tracearr user, users.name else users.username, and lists that
 * sort by name sort by that. Media server account usernames stay on the account's own fields.
 *
 * Run with: pnpm --filter @tracearr/server test:integration personName
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type {
  PersonRow,
  ServerUserWithIdentity,
  SessionWithDetails,
  ViolationWithDetails,
} from '@tracearr/shared';
import {
  createTestAutomation,
  createTestLibraryItem,
  createTestRun,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { users } from '../../src/db/schema.js';
import { createSessionServerUsers } from '../../src/jobs/poller/database.js';
import {
  buildMediaScope,
  getMediaWatchers,
  resolveCanonicalMediaByRef,
} from '../../src/services/library/mediaDetailService.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { userRoutes } from '../../src/routes/users/index.js';
import { peopleRoutes } from '../../src/routes/stats/people.js';
import { bandwidthRoutes } from '../../src/routes/stats/bandwidth.js';
import { locationsRoutes } from '../../src/routes/stats/locations.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { violationRoutes } from '../../src/routes/violations/index.js';
import { permissionGuard } from '../../src/lib/scope.js';

type Plugin = Parameters<typeof Fastify.prototype.register>[0];

async function buildApp(plugin: Plugin, prefix?: string) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  const owner = { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
  app.decorate('authenticate', async (request: any) => {
    request.user = owner;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any) => {
    request.user = owner;
  });
  await app.register(plugin as any, prefix ? { prefix } : {});
  return app;
}

/**
 * Zoe has no display name and an Emby and a tofa account, neither named like her Tracearr
 * user; the Emby one is the more recently active, so it represents her on all servers.
 * Mike is on tofa alone, Bea has a display name and an account on each server.
 */
async function seed() {
  const emby = await createTestServer({ type: 'emby' });
  const tofa = await createTestServer({ type: 'tofa' });

  const zoe = await createTestUser({ name: null, username: 'zoe' });
  const zoeEmby = await createTestServerUser({
    userId: zoe.id,
    serverId: emby.id,
    username: 'zoe_emby',
    lastActivityAt: new Date('2026-06-02T00:00:00Z'),
  });
  const zoeTofa = await createTestServerUser({
    userId: zoe.id,
    serverId: tofa.id,
    username: 'aaron_tofa',
    lastActivityAt: new Date('2026-06-01T00:00:00Z'),
  });

  const mike = await createTestUser({ name: null, username: 'mike' });
  await createTestServerUser({ userId: mike.id, serverId: tofa.id, username: 'mike' });

  const bea = await createTestUser({ name: 'Bea', username: 'bea' });
  await createTestServerUser({ userId: bea.id, serverId: emby.id, username: 'b_emby' });
  await createTestServerUser({ userId: bea.id, serverId: tofa.id, username: 'b_tofa' });

  const zoeSession = await createTestSession({
    serverId: tofa.id,
    serverUserId: zoeTofa.id,
    durationMs: 600_000,
    bitrate: 5000,
  });

  return { emby, tofa, zoe, zoeEmby, zoeTofa, zoeSession, mike, bea };
}

describe('person name under a server filter', () => {
  let s: Awaited<ReturnType<typeof seed>>;
  const filters = () => ['', `serverIds=${s.emby.id}`, `serverIds=${s.tofa.id}`];

  beforeEach(async () => {
    s = await seed();
  });

  describe('users roster', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeAll(async () => {
      app = await buildApp(userRoutes, '/users');
    });

    afterAll(async () => {
      await app.close();
    });

    async function roster(query: string): Promise<ServerUserWithIdentity[]> {
      const res = await app.inject({ method: 'GET', url: `/users?pageSize=100&${query}` });
      expect(res.statusCode).toBe(200);
      return res.json().data;
    }

    it('names a merged person without a display name the same under every filter', async () => {
      for (const query of filters()) {
        const row = (await roster(query)).find((r) => r.userId === s.zoe.id);
        expect(row?.personName, query).toBe('zoe');
      }
      const onTofa = (await roster(`serverIds=${s.tofa.id}`)).find((r) => r.userId === s.zoe.id);
      expect(onTofa?.id).toBe(s.zoeTofa.id);
      expect(onTofa?.username).toBe('aaron_tofa');
    });

    it('names a person with a display name by it under every filter', async () => {
      for (const query of filters()) {
        const row = (await roster(query)).find((r) => r.userId === s.bea.id);
        expect(row?.personName, query).toBe('Bea');
      }
    });

    it('sorts by the name it shows', async () => {
      const rows = await roster(`serverIds=${s.tofa.id}&orderBy=username&orderDir=asc`);
      expect(rows.map((r) => r.userId)).toEqual([s.bea.id, s.mike.id, s.zoe.id]);
      expect(rows.map((r) => r.personName)).toEqual(['Bea', 'mike', 'zoe']);
    });

    it('finds a person by the name it shows', async () => {
      const rows = await roster(`serverIds=${s.tofa.id}&search=zoe`);
      expect(rows.map((r) => r.userId)).toEqual([s.zoe.id]);
    });
  });

  it('people stats name the person, not the filtered account', async () => {
    const app = await buildApp(peopleRoutes);
    for (const query of filters()) {
      const res = await app.inject({ method: 'GET', url: `/people?period=all&${query}` });
      const row = (res.json().data as PersonRow[]).find((r) => r.userId === s.zoe.id);
      expect(row?.username, query).toBe('zoe');
    }
    await app.close();
  });

  it('bandwidth top users name the person, not the filtered account', async () => {
    const app = await buildApp(bandwidthRoutes);
    const res = await app.inject({
      method: 'GET',
      url: `/bandwidth/top-users?period=all&serverIds=${s.tofa.id}`,
    });
    await app.close();
    const rows = res.json().data as { serverUserId: string; username: string }[];
    expect(rows.find((r) => r.serverUserId === s.zoeTofa.id)?.username).toBe('zoe');
  });

  it('the history person picker names the person, not the filtered account', async () => {
    const app = await buildApp(sessionRoutes);
    const res = await app.inject({ method: 'GET', url: `/filter-options?serverIds=${s.tofa.id}` });
    await app.close();
    const options = res.json().users as { id: string; username: string; identityName: string }[];
    const zoe = options.find((u) => u.id === s.zoeTofa.id);
    expect(zoe?.username).toBe('zoe');
    expect(zoe?.identityName).toBe('zoe');
  });

  it('history rows and session detail name the person and keep the account username', async () => {
    const app = await buildApp(sessionRoutes);
    const history = await app.inject({ method: 'GET', url: '/history' });
    const detail = await app.inject({
      method: 'GET',
      url: `/${s.zoeSession.id}?startedAt=${s.zoeSession.startedAt.toISOString()}`,
    });
    await app.close();
    const row = (history.json().data as SessionWithDetails[]).find((r) => r.id === s.zoeSession.id);
    expect(row?.user).toMatchObject({ username: 'aaron_tofa', identityName: 'zoe' });
    expect((detail.json() as SessionWithDetails).user).toMatchObject({
      username: 'aaron_tofa',
      identityName: 'zoe',
    });
  });

  it('violations name the person and keep the account username', async () => {
    const policy = await createTestAutomation({ kind: 'policy' });
    await createTestRun({
      automationId: policy.id,
      serverUserId: s.zoeTofa.id,
      sessionId: s.zoeSession.id,
    });
    const app = await buildApp(violationRoutes);
    const res = await app.inject({ method: 'GET', url: '/' });
    await app.close();
    const row = (res.json().data as ViolationWithDetails[]).find(
      (v) => v.serverUserId === s.zoeTofa.id
    );
    expect(row?.user).toMatchObject({ username: 'aaron_tofa', identityName: 'zoe' });
  });

  it('media watchers keep the raw display name for the public API and name the person for the web', async () => {
    const item = {
      serverId: s.tofa.id,
      ratingKey: 'person-name-movie',
      mediaType: 'movie' as const,
    };
    const mediaId = await resolveMediaForItem({
      ...item,
      tmdbId: 960_001,
      title: 'Person Name Movie',
      year: 2020,
    });
    await createTestLibraryItem({ ...item, title: 'Person Name Movie', year: 2020, mediaId });
    await createTestSession({
      ...item,
      serverUserId: s.zoeTofa.id,
      mediaId,
      state: 'stopped',
      durationMs: 600_000,
      watched: true,
    });
    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    const canonical = await resolveCanonicalMediaByRef(mediaId);
    const scope = canonical ? await buildMediaScope(canonical) : null;
    expect(scope).not.toBeNull();
    if (!scope) return;
    const rows = await getMediaWatchers({ scope, windowKey: 'all_time', serverIds: undefined });
    expect(rows.map((r) => r.user)).toEqual([
      expect.objectContaining({ username: 'aaron_tofa', identity_name: null, person_name: 'zoe' }),
    ]);
  });

  it('a person the poller creates mid-stream gets no display name and is named by username', async () => {
    const created = await createSessionServerUsers(s.tofa, [
      { externalId: 'ext-new', username: 'newcomer', thumbUrl: null },
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]?.identityName).toBe('newcomer');
    const [person] = await db
      .select()
      .from(users)
      .where(eq(users.id, created[0]?.userId ?? ''));
    expect(person?.name).toBeNull();
    expect(person?.username).toBe('newcomer');
  });

  it('the map names the person, not the filtered account', async () => {
    const app = await buildApp(locationsRoutes);
    const res = await app.inject({
      method: 'GET',
      url: `/locations?period=all&serverIds=${s.tofa.id}`,
    });
    await app.close();
    const body = res.json();
    const picker = body.availableFilters.users as { id: string; username: string }[];
    expect(picker.find((u) => u.id === s.zoeTofa.id)?.username).toBe('zoe');
    const people = (body.data as { users: { id: string; username: string }[] }[]).flatMap(
      (location) => location.users
    );
    expect(people.find((p) => p.id === s.zoeTofa.id)?.username).toBe('zoe');
  });
});
