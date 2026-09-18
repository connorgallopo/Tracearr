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
import { renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
    select: vi.fn(),
    selectDistinct: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../../services/userService.js', async (importActual) => {
  const actual = await importActual<typeof UserServiceModule>();
  return { ...actual, recomputeIdentityAggregates: vi.fn(), updateUser: vi.fn() };
});

import { db } from '../../../db/client.js';
import { recomputeIdentityAggregates } from '../../../services/userService.js';
import {
  listRoutes,
  buildUserRosterSql,
  buildUserRosterPageQuery,
  buildUserRosterCountQuery,
  buildUserRosterAccountIdQuery,
} from '../list.js';

const mockExecute = vi.mocked(db.execute);
const mockSelect = vi.mocked(db.select);
const mockSelectDistinct = vi.mocked(db.selectDistinct);
const mockTransaction = vi.mocked(db.transaction);
const mockRecompute = vi.mocked(recomputeIdentityAggregates);

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function owner(): AuthUser {
  return { userId: randomUUID(), username: 'tester', role: 'owner', serverIds: [] };
}

function filters(overrides: Partial<UserRosterFilters> = {}): UserRosterFilters {
  return { includeRemoved: false, ...overrides };
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
    expect(orderClause('username')).toBe('coalesce(u.name, u.username) ASC NULLS LAST, u.id ASC');
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
      'coalesce(u.name, u.username) DESC NULLS LAST, u.id ASC'
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
            passwordHash: null,
            identityPlexAccountId: null,
            identityTrustScore: 72,
            identityJoinedAt: joinedAt,
            identityLastActivityAt: activeAt,
            plexAccountCount: 0,
            // A member with a Better Auth row: the client's canLogin(role)
            // guess says false here and picks the wrong merge direction.
            authAccountCount: 1,
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
      loginCapable: true,
      joinedAt: '2023-01-05T00:00:00.000Z',
      lastActivityAt: '2024-06-02T14:29:35.040Z',
      removedAt: null,
      updatedAt: '2024-06-02T14:29:35.040Z',
      identityJoinedAt: '2023-01-05T00:00:00.000Z',
      identityLastActivityAt: '2024-06-02T14:29:35.040Z',
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
