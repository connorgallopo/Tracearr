/**
 * User detail aggregate route tests
 *
 * The db is mocked and every query records the WHERE it was handed, so the
 * assertions render the predicates the handler actually built. The violations
 * panel and its count read automation_runs, which also holds notification runs
 * and runs that stopped or errored; both have to carry the alias filter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import { queryChain, renderCall, renderSql, renderedWheres } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: { transaction: vi.fn() },
}));

import { db } from '../../../db/client.js';
import { fullRoutes } from '../full.js';
import { permissionGuard } from '../../../lib/scope.js';

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  await app.register(fullRoutes, { prefix: '/users' });
  return app;
}

describe('GET /users/:id/full violations panel', () => {
  let app: FastifyInstance;
  let chains: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    chains = [];
  });

  afterEach(async () => {
    await app.close();
  });

  it('filters the violations list and its count to completed policy runs', async () => {
    const serverUserId = randomUUID();
    const serverId = randomUUID();
    const authUser: AuthUser = {
      userId: randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [serverId],
    };
    app = await buildTestApp(authUser);

    let selectCall = 0;
    const tx = {
      select: vi.fn(() => {
        selectCall++;
        const rows = selectCall === 1 ? [{ id: serverUserId, serverId, userId: randomUUID() }] : [];
        const chain = queryChain(vi.fn, rows);
        chains.push(chain);
        return chain;
      }),
      execute: vi.fn(async () => ({ rows: [] })),
    };
    vi.mocked((db as any).transaction).mockImplementation(async (callback: any) => callback(tx));

    const response = await app.inject({
      method: 'GET',
      url: `/users/${serverUserId}/full`,
    });

    expect(response.statusCode).toBe(200);

    const runWheres = renderedWheres(chains).filter((text) => text.includes('automation_runs'));
    expect(runWheres).toHaveLength(2);
    for (const where of runWheres) {
      expect(where).toContain('automation_runs.kind =');
      expect(where).toContain('automation_runs.outcome =');
      expect(where).toContain('automation_runs.dismissed_at is null');
    }
  });

  it('counts sessions for the identity in one grouped read instead of a count per row', async () => {
    const serverUserId = randomUUID();
    const siblingId = randomUUID();
    const serverId = randomUUID();
    app = await buildTestApp({
      userId: randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [serverId],
    });

    let selectCall = 0;
    const tx = {
      select: vi.fn(() => {
        selectCall++;
        const rows =
          selectCall === 1
            ? [{ id: serverUserId, serverId, userId: randomUUID() }]
            : selectCall === 2
              ? [
                  { id: serverUserId, serverId },
                  { id: siblingId, serverId },
                ]
              : selectCall === 3
                ? [{ serverUserId: siblingId, count: 4 }]
                : [];
        const chain = queryChain(vi.fn, rows);
        chains.push(chain);
        return chain;
      }),
      execute: vi.fn(async () => ({ rows: [] })),
    };
    vi.mocked((db as any).transaction).mockImplementation(async (callback: any) => callback(tx));

    const response = await app.inject({ method: 'GET', url: `/users/${serverUserId}/full` });

    expect(response.statusCode).toBe(200);
    const countChain = chains[2];
    expect(renderCall(countChain).text).toBe(
      `sessions.server_user_id = ANY(ARRAY['${serverUserId}'::uuid,'${siblingId}'::uuid]) AND sessions.started_at >= $1 AND sessions.started_at <= $2`
    );
    expect(countChain.groupBy).toHaveBeenCalledTimes(1);
    expect(renderedWheres(chains).join(' ')).not.toContain('select count(*)::int from');
    expect(response.json().user.sessionCount).toBe(0);
    expect(response.json().identity.serverUsers.map((su: any) => su.sessionCount)).toEqual([0, 4]);
  });

  it('carries the identity contact email in the identity block', async () => {
    const serverUserId = randomUUID();
    const serverId = randomUUID();
    const authUser: AuthUser = {
      userId: randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [serverId],
    };
    app = await buildTestApp(authUser);

    let selectCall = 0;
    const tx = {
      select: vi.fn(() => {
        selectCall++;
        const rows =
          selectCall === 1
            ? [
                {
                  id: serverUserId,
                  serverId,
                  userId: randomUUID(),
                  identityName: 'Ann',
                  identityContactEmail: 'ann@example.com',
                  identityAggregateTrustScore: 90,
                  identityTotalViolations: 0,
                },
              ]
            : [];
        const chain = queryChain(vi.fn, rows);
        chains.push(chain);
        return chain;
      }),
      execute: vi.fn(async () => ({ rows: [] })),
    };
    vi.mocked((db as any).transaction).mockImplementation(async (callback: any) => callback(tx));

    const response = await app.inject({ method: 'GET', url: `/users/${serverUserId}/full` });

    expect(response.statusCode).toBe(200);
    expect(response.json().identity.contactEmail).toBe('ann@example.com');
    expect(response.json().user).not.toHaveProperty('identityContactEmail');
  });

  it('selects the identity sign-in facts and keeps them on the user block', async () => {
    const serverUserId = randomUUID();
    const serverId = randomUUID();
    const authUser: AuthUser = {
      userId: randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [serverId],
    };
    app = await buildTestApp(authUser);

    let selectCall = 0;
    const tx = {
      select: vi.fn((_projection?: Record<string, unknown>) => {
        selectCall++;
        const rows =
          selectCall === 1
            ? [
                {
                  id: serverUserId,
                  serverId,
                  userId: randomUUID(),
                  loginAccess: 'allow',
                  loginCount: 7,
                  lastLoginAt: '2026-10-01T15:30:00.000Z',
                  identityContactEmail: null,
                  identityAggregateTrustScore: 90,
                  identityTotalViolations: 0,
                },
              ]
            : [];
        const chain = queryChain(vi.fn, rows);
        chains.push(chain);
        return chain;
      }),
      execute: vi.fn(async () => ({ rows: [] })),
    };
    vi.mocked((db as any).transaction).mockImplementation(async (callback: any) => callback(tx));

    const response = await app.inject({ method: 'GET', url: `/users/${serverUserId}/full` });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(tx.select.mock.calls[0]?.[0] ?? {})).toEqual(
      expect.arrayContaining(['loginAccess', 'loginCount', 'lastLoginAt'])
    );
    expect(response.json().user).toMatchObject({ loginAccess: 'allow', loginCount: 7 });
  });

  it('bounds the recent-sessions join and the devices read by the page window', async () => {
    const serverUserId = randomUUID();
    app = await buildTestApp({
      userId: randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [],
    });
    let selectCall = 0;
    const tx = {
      select: vi.fn(() => {
        selectCall++;
        const rows =
          selectCall === 1
            ? [{ id: serverUserId, serverId: randomUUID(), userId: randomUUID() }]
            : [];
        return queryChain(vi.fn, rows);
      }),
      execute: vi.fn(async (_query: SQL) => ({ rows: [] })),
    };
    vi.mocked((db as any).transaction).mockImplementation(async (callback: any) => callback(tx));

    await app.inject({ method: 'GET', url: `/users/${serverUserId}/full` });

    const texts = tx.execute.mock.calls.map(([query]) => renderSql(query).sql.replace(/\s+/g, ' '));
    const join = texts
      .find((text) => text.includes('grouped_sessions'))
      ?.match(/JOIN sessions s ON s\.id = gs\.first_session_id.*?JOIN servers/)?.[0];
    expect(join).toMatch(/s\.started_at >= \$\d+/);
    expect(join).toMatch(/s\.started_at <= \$\d+/);
    expect(texts.find((text) => text.includes('device_id, player_name'))).toMatch(
      /WHERE server_user_id = ANY\(.*\) AND started_at >= \$\d+ AND started_at < \$\d+/
    );
  });

  it('returns the media ids on each recent session', async () => {
    const serverUserId = randomUUID();
    const serverId = randomUUID();
    const mediaId = randomUUID();
    const showMediaId = randomUUID();
    app = await buildTestApp({
      userId: randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [serverId],
    });

    let selectCall = 0;
    const tx = {
      select: vi.fn(() => {
        selectCall++;
        const rows = selectCall === 1 ? [{ id: serverUserId, serverId, userId: randomUUID() }] : [];
        return queryChain(vi.fn, rows);
      }),
      execute: vi.fn(async (_query: SQL) => ({
        rows: [
          { id: randomUUID(), segment_count: '1', media_id: mediaId, show_media_id: showMediaId },
        ],
      })),
    };
    vi.mocked((db as any).transaction).mockImplementation(async (callback: any) => callback(tx));

    const response = await app.inject({ method: 'GET', url: `/users/${serverUserId}/full` });

    const sessionQuery = tx.execute.mock.calls
      .map(([query]) => renderSql(query).sql)
      .find((text) => text.includes('grouped_sessions'));
    expect(sessionQuery).toContain('s.media_id,');
    expect(sessionQuery).toContain('s.show_media_id,');
    const [session] = response.json().sessions.data;
    expect(session.mediaId).toBe(mediaId);
    expect(session.showMediaId).toBe(showMediaId);
  });
});
