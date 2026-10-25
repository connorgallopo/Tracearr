/**
 * Row scope security tests
 *
 * A member reaches only their own rows. List routes carry the member's account ids into the
 * query, a single row outside them answers exactly like a missing one, routes outside the
 * member's permissions answer 404, and an owner viewing as a member gets the member's view,
 * read-only. The auth plugin is real; only the session lookup, Redis and the database are faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { REDIS_KEYS, type AuthUser } from '@tracearr/shared';
import type { SQL } from 'drizzle-orm';
import type * as Settings from '../services/settings.js';

const { fakeRedis, activeSessions, activity } = vi.hoisted(() => ({
  fakeRedis: { get: vi.fn(), set: vi.fn(), setex: vi.fn(), del: vi.fn() },
  activeSessions: [] as unknown[],
  activity: { on: false },
}));

vi.mock('../lib/sessionResolver.js', () => ({
  resolveBetterAuthUser: vi.fn(),
  resolveBetterAuthUserStrict: vi.fn(),
}));
vi.mock('../lib/redisShared.js', () => ({ getRedis: () => fakeRedis }));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(), selectDistinct: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../db/prepared.js', () => ({}));
vi.mock('../services/cache.js', () => ({
  getCacheService: () => ({
    getAllActiveSessions: async () => activeSessions,
    getFilterOptions: async () => null,
    setFilterOptions: async () => undefined,
  }),
}));
vi.mock('../services/termination.js', () => ({ terminateSession: vi.fn() }));
vi.mock('../services/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Settings>();
  return {
    ...actual,
    getSetting: vi.fn((key: string) =>
      key === 'memberServerActivity'
        ? Promise.resolve(activity.on)
        : actual.getSetting(key as never)
    ),
  };
});

import { db } from '../db/client.js';
import { resolveBetterAuthUser } from '../lib/sessionResolver.js';
import authPlugin from '../plugins/auth.js';
import { queryChain, renderSql } from '../test/helpers.js';
import { registerErrorHandler } from '../utils/errors.js';
import { automationRoutes } from './automations.js';
import { sessionRoutes } from './sessions/index.js';
import { settingsRoutes } from './settings.js';
import { dashboardRoutes } from './stats/dashboard.js';
import { userRoutes } from './users/index.js';
import { violationRoutes } from './violations/index.js';

const OWN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SERVER = '33333333-3333-4333-8333-333333333333';
const ROW_ID = '44444444-4444-4444-8444-444444444444';

const member: AuthUser = { userId: 'u-member', username: 'mia', role: 'member', serverIds: [] };
const viewingAsMember: AuthUser = { ...member, impersonatedBy: 'u-owner' };
const admin: AuthUser = { userId: 'u-admin', username: 'ada', role: 'admin', serverIds: [SERVER] };

let app: FastifyInstance;

async function build(user: AuthUser): Promise<void> {
  vi.mocked(resolveBetterAuthUser).mockResolvedValue(user);
  app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(cookie, { secret: 'test-cookie-secret' });
  app.decorate('redis', fakeRedis as never);
  await app.register(authPlugin);
  await app.register(sessionRoutes, { prefix: '/sessions' });
  await app.register(violationRoutes, { prefix: '/violations' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(dashboardRoutes, { prefix: '/stats' });
  await app.register(automationRoutes, { prefix: '/automations' });
  await app.register(settingsRoutes, { prefix: '/settings' });
  await app.ready();
}

// Every SQL text the routes sent through db.execute or a builder's where, with its params.
function sentQueries(): { text: string; params: unknown[] }[] {
  const fragments: SQL[] = vi.mocked(db.execute).mock.calls.map((call) => call[0] as SQL);
  for (const result of vi.mocked(db.select).mock.results) {
    const chain = result.value as { where: { mock: { calls: unknown[][] } } };
    for (const call of chain.where.mock.calls) if (call[0]) fragments.push(call[0] as SQL);
  }
  return fragments.map((fragment) => {
    const rendered = renderSql(fragment);
    return { text: rendered.sql.replace(/\s+/g, ' '), params: rendered.params };
  });
}

function expectOnlyOwnRows(): void {
  const queries = sentQueries();
  expect(queries.some((q) => q.params.includes(OWN))).toBe(true);
  expect(queries.flatMap((q) => q.params)).not.toContain(OTHER);
}

beforeEach(() => {
  vi.clearAllMocks();
  activity.on = false;
  fakeRedis.get.mockImplementation(async (key: string) =>
    key === REDIS_KEYS.USER_SCOPE('u-member')
      ? JSON.stringify({ serverUserIds: [OWN], serverIds: [SERVER] })
      : null
  );
  vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, []));
  vi.mocked(db.selectDistinct).mockImplementation(() => queryChain(vi.fn, []));
  vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
  vi.mocked(db.transaction).mockImplementation(((run: (tx: typeof db) => unknown) =>
    run(db)) as never);
  activeSessions.splice(
    0,
    activeSessions.length,
    { id: 'a1', serverId: SERVER, serverUserId: OWN },
    { id: 'a2', serverId: SERVER, serverUserId: OTHER },
    { id: 'a3', serverId: SERVER, serverUserId: OTHER }
  );
});

afterEach(async () => {
  await app.close();
});

describe('member list routes', () => {
  const aggregateRow = {
    play_count: 0,
    total_watch_time_ms: '0',
    unique_users: 0,
    unique_content: 0,
  };
  it.each([
    ['/sessions', []],
    ['/sessions/history', []],
    ['/sessions/history/aggregates', [aggregateRow]],
  ])('%s queries only the member accounts', async (url, rows) => {
    await build(member);
    vi.mocked(db.execute).mockResolvedValue({ rows } as never);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expectOnlyOwnRows();
  });

  it('shows own active streams, and a count of the rest only when the owner allows it', async () => {
    await build(member);
    const own = [{ id: 'a1', serverId: SERVER, serverUserId: OWN }];
    const hidden = await app.inject({ method: 'GET', url: '/sessions/active' });
    activity.on = true;
    const shown = await app.inject({ method: 'GET', url: '/sessions/active' });

    expect(hidden.json()).toEqual({ data: own });
    expect(shown.json()).toEqual({ data: own, othersActive: 2 });
  });

  it('gives the dashboard own counts, never activeUsersToday or alerts, and othersActive on request', async () => {
    await build(member);
    const hidden = (await app.inject({ method: 'GET', url: '/stats/dashboard' })).json();
    activity.on = true;
    const shown = (await app.inject({ method: 'GET', url: '/stats/dashboard' })).json();

    expect(hidden.activeStreams).toBe(1);
    expect(hidden).not.toHaveProperty('othersActive');
    expect(hidden).not.toHaveProperty('activeUsersToday');
    expect(hidden).not.toHaveProperty('alertsLast24h');
    expect(shown.othersActive).toBe(2);
    expect(shown).not.toHaveProperty('activeUsersToday');
    expectOnlyOwnRows();
  });
});

describe('member single-row routes', () => {
  it.each([['/sessions', { id: ROW_ID, serverId: SERVER, serverUserId: OTHER }]])(
    '%s/:id answers a foreign row exactly like a missing one',
    async (prefix, row) => {
      await build(member);
      vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, [row]));
      const foreign = await app.inject({ method: 'GET', url: `${prefix}/${ROW_ID}` });
      vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, []));
      const missing = await app.inject({ method: 'GET', url: `${prefix}/${ROW_ID}` });

      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).toBe(missing.body);
    }
  );

  it("answers another person's devices exactly like a missing account", async () => {
    await build(member);
    vi.mocked(db.select).mockImplementation(() =>
      queryChain(vi.fn, [{ id: OTHER, serverId: SERVER, userId: 'u-other' }])
    );
    const foreign = await app.inject({ method: 'GET', url: `/users/${OTHER}/devices` });
    vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, []));
    const missing = await app.inject({ method: 'GET', url: `/users/${OTHER}/devices` });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toBe(missing.body);
  });
});

describe('routes outside the member role', () => {
  it.each(['/automations', '/settings/ip-warning', '/users'])(
    '%s is 404 for a member and served to an admin',
    async (url) => {
      await build(member);
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
      await app.close();

      await build(admin);
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
  );

  it.each(['/violations', `/violations/${ROW_ID}`])('%s is 404 for a member', async (url) => {
    await build(member);
    vi.mocked(db.select).mockImplementation(() =>
      queryChain(vi.fn, [{ id: ROW_ID, serverId: SERVER, serverUserId: OWN }])
    );
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it.each(['full', 'terminations'])(
    'keeps the %s panel of user detail from a member, even their own',
    async (panel) => {
      await build(member);
      expect((await app.inject({ method: 'GET', url: `/users/${OWN}/${panel}` })).statusCode).toBe(
        404
      );
    }
  );

  it('is 404 for a member on a write the role lacks', async () => {
    await build(member);
    const res = await app.inject({
      method: 'POST',
      url: `/sessions/${ROW_ID}/terminate`,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('owner viewing as a member', () => {
  it('lists only the member rows and gets 404 on a users route', async () => {
    await build(viewingAsMember);
    expect((await app.inject({ method: 'GET', url: '/sessions' })).statusCode).toBe(200);
    expectOnlyOwnRows();
    expect((await app.inject({ method: 'GET', url: '/users' })).statusCode).toBe(404);
  });

  it('is read-only: a write is 403 while the read beside it is 200', async () => {
    await build(viewingAsMember);
    const read = await app.inject({ method: 'GET', url: '/sessions/active' });
    const write = await app.inject({
      method: 'POST',
      url: `/sessions/${ROW_ID}/terminate`,
      payload: {},
    });

    expect(read.statusCode).toBe(200);
    expect(write.statusCode).toBe(403);
    expect(write.json<{ message: string }>().message).toBe('Viewing as another user is read-only');
  });
});
