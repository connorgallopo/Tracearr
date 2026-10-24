/**
 * User roster route tests
 *
 * SQL-shape assertions run against rendered query text with no DB (the
 * catalog.routes.test.ts convention); route-level assertions mock db.execute
 * and the Drizzle chain so the handler's own mapping runs end to end. Whether
 * the emitted SQL actually returns the right rows is an integration-tier
 * question - this tier proves the predicates and ORDER BY keys are built and
 * shared correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, UserRosterFilters, UserSortField } from '@tracearr/shared';
import type * as UserServiceModule from '../../../services/userService.js';
import { renderCall, renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
    select: vi.fn(),
    selectDistinct: vi.fn(),
    transaction: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../lib/revoke.js', () => ({
  revokeSessionsForUsers: vi.fn(),
  refreshUserSessionSnapshots: vi.fn(),
}));
vi.mock('../../../websocket/index.js', () => ({ disconnectUserSockets: vi.fn() }));
vi.mock('../../../services/settings.js', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  getSetting: vi.fn(),
}));

vi.mock('../../../services/userService.js', async (importActual) => {
  const actual = await importActual<typeof UserServiceModule>();
  return { ...actual, recomputeIdentityAggregates: vi.fn(), updateUser: vi.fn() };
});

import { db } from '../../../db/client.js';
import { refreshUserSessionSnapshots, revokeSessionsForUsers } from '../../../lib/revoke.js';
import { disconnectUserSockets } from '../../../websocket/index.js';
import { recomputeIdentityAggregates } from '../../../services/userService.js';
import { getSetting } from '../../../services/settings.js';
import {
  listRoutes,
  buildUserRosterSql,
  buildUserRosterPageQuery,
  buildUserRosterCountQuery,
  buildUserRosterAccountIdQuery,
} from '../list.js';
import { permissionGuard } from '../../../lib/scope.js';

const mockExecute = vi.mocked(db.execute);
const mockSelect = vi.mocked(db.select);
const mockSelectDistinct = vi.mocked(db.selectDistinct);
const mockTransaction = vi.mocked(db.transaction);
const mockUpdate = vi.mocked(db.update);
const mockRecompute = vi.mocked(recomputeIdentityAggregates);

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function owner(): AuthUser {
  return { userId: randomUUID(), username: 'tester', role: 'owner', serverIds: [] };
}

function filters(overrides: Partial<UserRosterFilters> = {}): UserRosterFilters {
  return { includeRemoved: false, signInOverride: false, ...overrides };
}

function pageSql(
  rosterFilters: UserRosterFilters,
  sort: { orderBy: UserSortField; orderDir?: 'asc' | 'desc' } = { orderBy: 'username' }
) {
  const roster = buildUserRosterSql(rosterFilters, owner());
  const rendered = renderSql(
    buildUserRosterPageQuery({
      roster,
      orderBy: sort.orderBy,
      orderDir: sort.orderDir,
      pageSize: 20,
      offset: 0,
    })
  );
  return { text: normalize(rendered.sql), params: rendered.params };
}

function orderClause(orderBy: UserSortField, orderDir?: 'asc' | 'desc'): string {
  const { text } = pageSql(filters(), { orderBy, orderDir });
  const match = /ORDER BY (.*) LIMIT/.exec(text.slice(text.indexOf(') rep ON true')));
  return match?.[1] ?? '';
}

// ============================================================================
// Search
// ============================================================================

describe('roster search', () => {
  it('matches any of the identity accounts, not just the representative', () => {
    const { text, params } = pageSql(filters({ search: 'robert' }));

    expect(text).toContain('EXISTS ( SELECT 1 FROM server_users rsu WHERE rsu.user_id = u.id');
    expect(text).toContain('rsu.username ILIKE');
    expect(text).toContain('u.name ILIKE');
    expect(params).toContain('%robert%');
  });

  it('leaves the representative pick untouched, so a match on one account still renders the best one', () => {
    const { text } = pageSql(filters({ search: 'robert' }));
    const lateral = text.slice(text.indexOf('JOIN LATERAL'), text.indexOf(') rep ON true'));

    expect(lateral).not.toContain('ILIKE');
    expect(lateral).toContain('ORDER BY (su.removed_at IS NULL) DESC');
  });

  it('counts the same row set the page returns', () => {
    const roster = buildUserRosterSql(filters({ search: 'robert' }), owner());
    const { sql: text, params } = renderSql(buildUserRosterCountQuery(roster));

    expect(normalize(text)).toContain('rsu.username ILIKE');
    expect(params).toContain('%robert%');
  });

  it('escapes ILIKE wildcards so a literal _ or % is not a wildcard', () => {
    const { params } = pageSql(filters({ search: 'a_b%c\\d' }));

    expect(params).toContain('%a\\_b\\%c\\\\d%');
  });
});

// ============================================================================
// Sorting
// ============================================================================

describe('roster ORDER BY', () => {
  it('sorts by the identity display name by default, ascending, tiebroken on the identity id', () => {
    expect(orderClause('username')).toBe(
      'lower(coalesce(u.name, u.username)) ASC NULLS LAST, u.id ASC'
    );
  });

  it('sorts trust by the identity aggregate, worst-first default', () => {
    expect(orderClause('trustScore')).toBe('u.aggregate_trust_score DESC NULLS LAST, u.id ASC');
  });

  it('sorts joined by the identity first-join column, newest-first default', () => {
    expect(orderClause('joinedAt')).toBe('u.first_joined_at DESC NULLS LAST, u.id ASC');
  });

  it('sorts activity by the identity last-activity column, newest-first default', () => {
    expect(orderClause('lastActivityAt')).toBe('u.last_activity_at DESC NULLS LAST, u.id ASC');
  });

  it('honours an explicit direction and keeps NULLS LAST in both', () => {
    expect(orderClause('joinedAt', 'asc')).toBe('u.first_joined_at ASC NULLS LAST, u.id ASC');
    expect(orderClause('username', 'desc')).toBe(
      'lower(coalesce(u.name, u.username)) DESC NULLS LAST, u.id ASC'
    );
  });
});

// ============================================================================
// Date bounds
// ============================================================================

describe('roster date bounds', () => {
  it('applies a one-sided joined-after bound only', () => {
    const { text, params } = pageSql(filters({ joinedAfter: '2024-03-01' }));

    expect(text).toContain('u.first_joined_at >=');
    expect(text).not.toContain('u.first_joined_at <');
    expect(params).toContainEqual(new Date('2024-03-01T00:00:00.000Z'));
  });

  it('applies a one-sided joined-before bound as a half-open day, so the named day is included', () => {
    const { text, params } = pageSql(filters({ joinedBefore: '2024-03-01' }));

    expect(text).toContain('u.first_joined_at <');
    expect(text).not.toContain('u.first_joined_at >=');
    expect(params).toContainEqual(new Date('2024-03-02T00:00:00.000Z'));
  });

  it('applies both activity bounds together', () => {
    const { text, params } = pageSql(
      filters({ activeAfter: '2024-01-01', activeBefore: '2024-01-31' })
    );

    expect(text).toContain('u.last_activity_at >=');
    expect(text).toContain('u.last_activity_at <');
    expect(params).toContainEqual(new Date('2024-01-01T00:00:00.000Z'));
    expect(params).toContainEqual(new Date('2024-02-01T00:00:00.000Z'));
  });

  it('bounds the identity rollup columns, never the representative account row', () => {
    const { text } = pageSql(filters({ joinedAfter: '2024-03-01', activeBefore: '2024-04-01' }));

    expect(text).not.toContain('rep.joined_at >=');
    expect(text).not.toContain('rep.last_activity_at <');
  });
});

// ============================================================================
// Account scope
// ============================================================================

describe('roster signInOverride', () => {
  it('keeps only identities set to Allow or Block', () => {
    const { text } = pageSql(filters({ signInOverride: true }));

    expect(text).toContain("u.login_access <> 'default'");
    expect(pageSql(filters()).text).not.toContain('u.login_access <>');
  });
});

describe('roster pending violations', () => {
  it('selects a pending violations count per identity, scoped to the resolved servers', () => {
    const serverId = randomUUID();
    const { text, params } = pageSql(filters({ serverIds: [serverId] }));
    const count = text.slice(
      text.indexOf('FROM automation_runs v'),
      text.indexOf('"pendingViolations"')
    );

    expect(count).toContain("v.kind = 'policy' AND v.outcome = 'completed'");
    expect(count).toContain('v.acknowledged_at IS NULL AND v.dismissed_at IS NULL');
    expect(count).toContain('AND vsu.server_id =');
    expect(params).toContain(serverId);
  });

  it('filters by role, sign-in and pending-only', () => {
    const { text, params } = pageSql(
      filters({ role: 'admin', signIn: 'block', pendingOnly: true })
    );
    const where = text.slice(text.lastIndexOf(') rep ON true'));

    expect(where).toContain('u.role =');
    expect(where).toContain('u.login_access =');
    expect(where).toContain('EXISTS (SELECT 1 FROM automation_runs v');
    expect(params).toContain('admin');
    expect(params).toContain('block');
    expect(pageSql(filters()).text).not.toContain('u.role =');
  });

  it('sorts by role and by pending violations with the documented defaults', () => {
    expect(orderClause('role')).toBe('u.role ASC NULLS LAST, u.id ASC');
    expect(orderClause('pendingViolations')).toBe('"pendingViolations" DESC NULLS LAST, u.id ASC');
  });

  it('reaches the bulk seed query with pendingOnly', () => {
    const roster = buildUserRosterSql(filters({ pendingOnly: true }), owner());
    const rendered = renderSql(buildUserRosterAccountIdQuery(roster));

    expect(normalize(rendered.sql)).toContain('EXISTS (SELECT 1 FROM automation_runs v');
  });
});

describe('roster hasAccessTo', () => {
  it('requires an active account on every listed server, not any of them', () => {
    const plex = randomUUID();
    const emby = randomUUID();
    const { text, params } = pageSql(filters({ hasAccessTo: [plex, emby] }));

    expect(text).toContain('SELECT count(DISTINCT asu.server_id)');
    expect(text).toContain('asu.removed_at IS NULL');
    expect(params).toContain(plex);
    expect(params).toContain(emby);
    expect(params).toContain(2);
  });

  it('ignores the view scope, so it still answers while the roster is pinned to one server', () => {
    const plex = randomUUID();
    const emby = randomUUID();
    const { text } = pageSql(filters({ serverIds: [plex], hasAccessTo: [plex, emby] }));

    const accessClause = text.slice(text.indexOf('count(DISTINCT asu.server_id)'));
    // The lateral's own alias is `su`; `asu` is this subquery's. Word-boundary
    // matched because "asu.server_id" contains "su.server_id".
    expect(accessClause).not.toMatch(/(?<![a-z])su\.server_id/);
    expect(text).toContain('AND su.server_id =');
  });

  it('deduplicates repeated servers so the required count stays honest', () => {
    const plex = randomUUID();
    const { params } = pageSql(filters({ hasAccessTo: [plex, plex] }));

    expect(params).toContain(1);
  });

  it('refuses to answer for a server the caller cannot see', () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    const scoped: AuthUser = {
      userId: randomUUID(),
      username: 'admin',
      role: 'admin',
      serverIds: [mine],
    };
    const roster = buildUserRosterSql(filters({ hasAccessTo: [mine, theirs] }), scoped);
    const rendered = renderSql(
      buildUserRosterPageQuery({
        roster,
        orderBy: 'username',
        orderDir: undefined,
        pageSize: 20,
        offset: 0,
      })
    );

    expect(normalize(rendered.sql)).toContain('false');
    expect(rendered.params).not.toContain(theirs);
  });

  it('reaches the bulk seed query through the same builder', () => {
    const plex = randomUUID();
    const roster = buildUserRosterSql(filters({ hasAccessTo: [plex] }), owner());
    const rendered = renderSql(buildUserRosterAccountIdQuery(roster));

    expect(normalize(rendered.sql)).toContain('count(DISTINCT asu.server_id)');
    expect(rendered.params).toContain(plex);
  });
});

describe('roster account scope', () => {
  it('hides removed accounts inside the lateral by default', () => {
    const { text } = pageSql(filters());

    expect(text).toContain('WHERE su.user_id = u.id AND su.removed_at IS NULL');
  });

  it('keeps removed accounts when includeRemoved is set', () => {
    const { text } = pageSql(filters({ includeRemoved: true }));

    // The representative ordering still mentions removed_at; the WHERE must not.
    expect(text).toContain('WHERE su.user_id = u.id ORDER BY');
  });

  it('pins the lateral to the requested servers', () => {
    const serverId = randomUUID();
    const { text, params } = pageSql(filters({ serverIds: [serverId] }));

    expect(text).toContain('AND su.server_id =');
    expect(params).toContain(serverId);
  });
});

// ============================================================================
// Routes
// ============================================================================

function thenableChain(result: unknown): any {
  const chain: Record<string, unknown> = {};
  for (const method of [
    'from',
    'innerJoin',
    'leftJoin',
    'where',
    'limit',
    'offset',
    'orderBy',
    'groupBy',
    'set',
    'returning',
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any, reply: any) => {
    request.user = authUser;
    if (authUser.role !== 'owner') return reply.forbidden('Owner access required');
  });
  await app.register(listRoutes, { prefix: '/users' });
  return app;
}

describe('GET /users', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the list envelope, ISO 8601 timestamps and the server-computed login capability', async () => {
    const authUser = owner();
    app = await buildTestApp(authUser);
    const userId = randomUUID();
    const serverUserId = randomUUID();
    const serverId = randomUUID();
    // db.execute hands timestamptz back as Postgres text
    const joinedAt = '2023-01-05 00:00:00+00';
    const activeAt = '2024-06-02 14:29:35.04+00';

    mockExecute
      .mockResolvedValueOnce({
        rows: [
          {
            userId,
            identityName: 'Robert',
            role: 'member',
            loginAccess: 'allow',
            lastLoginAt: activeAt,
            loginCount: 3,
            passwordHash: null,
            identityPlexAccountId: null,
            identityTrustScore: 72,
            identityJoinedAt: joinedAt,
            identityLastActivityAt: activeAt,
            plexAccountCount: 0,
            // A member with a Better Auth row: the client's canLogin(role)
            // guess says false here and picks the wrong merge direction.
            authAccountCount: 1,
            pendingViolations: 2,
            id: serverUserId,
            serverId,
            serverName: 'Plex',
            externalId: '42',
            username: 'bob_plex',
            email: null,
            thumbUrl: null,
            isServerAdmin: false,
            trustScore: 80,
            joinedAt,
            lastActivityAt: activeAt,
            removedAt: null,
            updatedAt: activeAt,
          },
        ],
      } as any)
      .mockResolvedValueOnce({ rows: [{ total: 1 }] } as any);

    mockSelectDistinct.mockReturnValue(
      thenableChain([
        {
          userId,
          serverId,
          serverName: 'Plex',
          serverUserId,
          removedAt: null,
        },
      ])
    );

    const response = await app.inject({ method: 'GET', url: '/users?page=1&pageSize=20' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(body).not.toHaveProperty('totalPages');
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: serverUserId,
      userId,
      username: 'bob_plex',
      identityName: 'Robert',
      identityTrustScore: 72,
      trustScore: 80,
      loginAccess: 'allow',
      lastLoginAt: '2024-06-02T14:29:35.040Z',
      loginCount: 3,
      loginCapable: true,
      joinedAt: '2023-01-05T00:00:00.000Z',
      lastActivityAt: '2024-06-02T14:29:35.040Z',
      removedAt: null,
      updatedAt: '2024-06-02T14:29:35.040Z',
      identityJoinedAt: '2023-01-05T00:00:00.000Z',
      identityLastActivityAt: '2024-06-02T14:29:35.040Z',
      pendingViolations: 2,
    });
    expect(body.data[0].identityServers).toEqual([
      { id: serverId, name: 'Plex', serverUserId, removedAt: null },
    ]);
  });

  it('passes the requested sort and window straight into the page query', async () => {
    app = await buildTestApp(owner());
    mockExecute
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rows: [{ total: 0 }] } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/users?page=3&pageSize=25&orderBy=joinedAt&search=robert',
    });

    expect(response.statusCode).toBe(200);
    const pageQuery = renderSql(mockExecute.mock.calls[0]![0] as any);
    expect(normalize(pageQuery.sql)).toContain('ORDER BY u.first_joined_at DESC NULLS LAST, u.id');
    expect(pageQuery.params).toContain('%robert%');
    expect(pageQuery.params).toContain(25);
    expect(pageQuery.params).toContain(50);
  });
});

describe('POST /users/bulk/reset-trust', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('resolves selectAll through the same filters the roster used, search included', async () => {
    const authUser = owner();
    app = await buildTestApp(authUser);
    const serverUserId = randomUUID();
    const userId = randomUUID();
    const serverId = randomUUID();

    mockExecute.mockResolvedValueOnce({ rows: [{ id: serverUserId }] } as any);
    mockSelect
      .mockReturnValueOnce(thenableChain([{ id: serverUserId, serverId, userId }]))
      .mockReturnValueOnce(thenableChain([{ id: serverUserId }]));
    mockTransaction.mockImplementation(async (callback: any) =>
      callback({ update: () => thenableChain([]) })
    );

    const response = await app.inject({
      method: 'POST',
      url: '/users/bulk/reset-trust',
      payload: { selectAll: true, filters: { search: 'robert', includeRemoved: false } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, updated: 1 });

    // The regression guard: the seed query must carry the search predicate.
    // Without it, "select all 3 users" resets every account on the server.
    const seedQuery = renderSql(mockExecute.mock.calls[0]![0] as any);
    expect(normalize(seedQuery.sql)).toContain('rsu.username ILIKE');
    expect(normalize(seedQuery.sql)).toContain('u.name ILIKE');
    expect(seedQuery.params).toContain('%robert%');
    expect(mockRecompute).toHaveBeenCalledWith(userId, expect.anything());
  });

  it('carries the date bounds into the seed query too', () => {
    const roster = buildUserRosterSql(
      filters({ joinedBefore: '2024-01-31', activeAfter: '2024-01-01' }),
      owner(),
      { strict: false }
    );
    const { sql: text, params } = renderSql(buildUserRosterAccountIdQuery(roster));

    expect(normalize(text)).toContain('u.first_joined_at <');
    expect(normalize(text)).toContain('u.last_activity_at >=');
    expect(params).toContainEqual(new Date('2024-02-01T00:00:00.000Z'));
    expect(params).toContainEqual(new Date('2024-01-01T00:00:00.000Z'));
  });

  it('seeds every account of a matching identity, not just its representative', () => {
    const roster = buildUserRosterSql(filters({ search: 'robert' }), owner(), { strict: false });
    const { sql: text } = renderSql(buildUserRosterAccountIdQuery(roster));

    expect(normalize(text)).toContain(
      'FROM server_users su INNER JOIN users u ON u.id = su.user_id'
    );
    expect(normalize(text)).not.toContain('LATERAL');
  });
});

describe('GET /users/:id', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('bounds the stats read by the same window as the user detail page', async () => {
    app = await buildTestApp(owner());
    const id = randomUUID();
    const statsChain = thenableChain([{ totalSessions: 0, totalWatchTime: 0 }]);
    mockSelect
      .mockReturnValueOnce(thenableChain([{ id, serverId: randomUUID() }]))
      .mockReturnValueOnce(statsChain);

    const response = await app.inject({ method: 'GET', url: `/users/${id}` });

    expect(response.statusCode).toBe(200);
    expect(renderCall(statsChain).text).toBe(
      `sessions.server_user_id = ANY(ARRAY['${id}'::uuid]) AND sessions.started_at >= $1 AND sessions.started_at <= $2`
    );
  });
});

describe('PATCH /users/:id sign-in access', () => {
  let app: FastifyInstance;
  const serverUser = {
    id: randomUUID(),
    userId: randomUUID(),
    serverId: randomUUID(),
    trustScore: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockReturnValue(thenableChain([serverUser]));
  });

  afterEach(async () => {
    await app.close();
  });

  function identity(role: string, loginAccess = 'default', memberSwitch = true) {
    mockSelect
      .mockReturnValueOnce(thenableChain([serverUser]))
      .mockReturnValueOnce(thenableChain([{ role, loginAccess }]));
    vi.mocked(getSetting).mockResolvedValue({
      local: true,
      plex: true,
      oidc: true,
      member: memberSwitch,
    } as never);
  }

  async function patch(payload: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: `/users/${serverUser.id}`, payload });
  }

  function expectRevoked() {
    expect(revokeSessionsForUsers).toHaveBeenCalledExactlyOnceWith([serverUser.userId]);
    expect(disconnectUserSockets).not.toHaveBeenCalled();
  }

  function expectReconnectOnly() {
    expect(revokeSessionsForUsers).not.toHaveBeenCalled();
    expect(disconnectUserSockets).toHaveBeenCalledExactlyOnceWith(serverUser.userId);
  }

  it('writes the access and revokes when a person is blocked', async () => {
    app = await buildTestApp(owner());
    identity('member', 'default', true);

    const response = await patch({ loginAccess: 'block' });

    expect(response.statusCode).toBe(200);
    expect(mockUpdate.mock.results[0]?.value.set).toHaveBeenCalledWith(
      expect.objectContaining({ loginAccess: 'block' })
    );
    expectRevoked();
  });

  it('revokes when allow goes back to default while the global switch is off', async () => {
    app = await buildTestApp(owner());
    identity('member', 'allow', false);

    expect((await patch({ loginAccess: 'default' })).statusCode).toBe(200);
    expectRevoked();
  });

  it('only reconnects when allow goes back to default while the global switch is on', async () => {
    app = await buildTestApp(owner());
    identity('member', 'allow', true);

    expect((await patch({ loginAccess: 'default' })).statusCode).toBe(200);
    expectReconnectOnly();
  });

  it('only reconnects when a person is allowed', async () => {
    app = await buildTestApp(owner());
    identity('member', 'default', false);

    expect((await patch({ loginAccess: 'allow' })).statusCode).toBe(200);
    expectReconnectOnly();
  });

  it('does nothing to sessions when the access is unchanged', async () => {
    app = await buildTestApp(owner());
    identity('member', 'allow', false);

    expect((await patch({ loginAccess: 'allow' })).statusCode).toBe(200);
    expect(revokeSessionsForUsers).not.toHaveBeenCalled();
    expect(disconnectUserSockets).not.toHaveBeenCalled();
  });

  it.each([
    ['a Block', { loginAccess: 'block' }, 'block'],
    ['a demotion', { role: 'member' }, 'allow'],
  ])('revokes again when %s is resent after a revoke that failed', async (_label, body, stored) => {
    app = await buildTestApp(owner());
    identity('member', stored, true);

    expect((await patch(body)).statusCode).toBe(200);
    expectRevoked();
  });

  it('refuses an access value outside allow, block and default', async () => {
    app = await buildTestApp(owner());

    expect((await patch({ loginAccess: 'sometimes' })).statusCode).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('revokes the identity when an admin becomes a member', async () => {
    app = await buildTestApp(owner());
    identity('admin', 'allow');

    const response = await patch({ role: 'member' });

    expect(response.statusCode).toBe(200);
    expectRevoked();
  });

  it('refreshes the session snapshot and drops the sockets when a member becomes an admin', async () => {
    app = await buildTestApp(owner());
    identity('member', 'default');

    const response = await patch({ loginAccess: 'allow', role: 'admin' });

    expect(response.statusCode).toBe(200);
    expect(refreshUserSessionSnapshots).toHaveBeenCalledExactlyOnceWith(serverUser.userId);
    expectReconnectOnly();
  });

  it("refuses to change the owner's access", async () => {
    app = await buildTestApp(owner());
    identity('owner');

    const response = await patch({ loginAccess: 'block' });

    expect(response.statusCode).toBe(400);
    expect(revokeSessionsForUsers).not.toHaveBeenCalled();
  });
});
