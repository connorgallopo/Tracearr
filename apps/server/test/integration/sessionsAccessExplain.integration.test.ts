/**
 * EXPLAIN gate for the db/sessions read paths: each named read plans only the sessions chunks
 * its window can reach, on compressed weekly chunks. Also the bounded-first fallbacks and the
 * bulk delete against compressed chunks.
 *
 * Seed and assertions live in one `it` body: the per-test reset truncates everything before
 * every test, so a beforeAll seed would not survive to the first assertion.
 *
 * Run with: pnpm --filter @tracearr/server test:integration sessionsAccessExplain
 */

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { sessions } from '../../src/db/schema.js';
import {
  activeSessionFloor,
  firstSegmentJoin,
  groupedPlaysCte,
  playCountQuery,
  readSessionRowOrActive,
  readSessionRows,
  sessionRowById,
} from '../../src/db/sessions/index.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';
import { sessionRoutes } from '../../src/routes/sessions.js';
import { permissionGuard } from '../../src/lib/scope.js';

const DAY_MS = 86_400_000;
const CHUNK_NAME = /^_hyper_\d+_\d+_chunk$/;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

function flattenPlan(node: PlanNode): PlanNode[] {
  const nodes = [node];
  for (const child of node.Plans ?? []) {
    nodes.push(...flattenPlan(child));
  }
  return nodes;
}

async function explainPlan(query: SQL): Promise<PlanNode> {
  const result = await db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
  const row = result.rows[0] as Record<string, unknown>;
  const raw = row['QUERY PLAN'];
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
  return parsed[0]!.Plan;
}

interface ChunkRange {
  start: Date;
  end: Date;
}

async function sessionChunks(): Promise<Map<string, ChunkRange>> {
  const result = await db.execute(sql`
    SELECT chunk_name, range_start, range_end
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'sessions'
  `);
  const rows = result.rows as { chunk_name: string; range_start: string; range_end: string }[];
  return new Map(
    rows.map((r) => [r.chunk_name, { start: new Date(r.range_start), end: new Date(r.range_end) }])
  );
}

/** The sessions chunks a plan scans, each checked against the window [from, to). */
async function plannedChunks(
  query: SQL,
  chunks: Map<string, ChunkRange>,
  window: { from: Date; to?: Date }
): Promise<{ planned: string[]; outside: string[] }> {
  const names = flattenPlan(await explainPlan(query))
    .map((node) => node['Relation Name'])
    .filter((name): name is string => !!name && CHUNK_NAME.test(name));
  const planned = [...new Set(names)];
  const outside = planned.filter((name) => {
    const range = chunks.get(name);
    if (!range) return true;
    return !(range.end > window.from && (!window.to || range.start < window.to));
  });
  return { planned, outside };
}

/** Weekly chunks so a 120-day history spans enough chunks to tell a bounded plan from a full one. */
async function withWeeklyChunks(run: () => Promise<void>): Promise<void> {
  await db.execute(sql`SELECT set_chunk_time_interval('sessions', interval '7 days')`);
  try {
    await run();
  } finally {
    await db.execute(sql`SELECT set_chunk_time_interval('sessions', interval '30 days')`);
  }
}

async function seedAccount() {
  const owner = await createTestUser({ role: 'owner' });
  const server = await createTestServer({ type: 'plex' });
  const account = await createTestServerUser({ userId: owner.id, serverId: server.id });
  return { serverId: server.id, serverUserId: account.id };
}

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

const selectWhere = (where: SQL) => db.select({ id: sessions.id }).from(sessions).where(where);

describe('db/sessions read paths', () => {
  it('plans only the chunks each named read can reach', { timeout: 120_000 }, async () => {
    await withWeeklyChunks(async () => {
      const account = await seedAccount();
      const now = Date.now();
      const seeded: { id: string; startedAt: Date }[] = [];
      for (let i = 0; i < 200; i++) {
        const startedAt = new Date(now - (i * 120 * DAY_MS) / 200 - 60_000);
        const row = await createTestSession({ ...account, state: 'stopped', startedAt });
        seeded.push({ id: row.id, startedAt });
      }
      expect((await compressSessionChunks(14)).length).toBeGreaterThan(0);
      const chunks = await sessionChunks();
      expect(chunks.size).toBeGreaterThanOrEqual(17);

      const counts: Record<string, string> = {};
      const check = async (name: string, query: SQL, window: { from: Date; to?: Date }) => {
        const { planned, outside } = await plannedChunks(query, chunks, window);
        counts[name] = `${planned.length} of ${chunks.size}`;
        expect(planned.length, name).toBeGreaterThan(0);
        expect(outside, name).toEqual([]);
      };

      const old = seeded.find((row) => row.startedAt.getTime() < now - 100 * DAY_MS)!;
      await check('sessionRowById', selectWhere(sessionRowById(old)).getSQL(), {
        from: new Date(old.startedAt.getTime() - 60_000),
      });

      const from = new Date(now - 30 * DAY_MS);
      const to = new Date(now);
      const window = [sql`s.started_at >= ${from}`, sql`s.started_at < ${to}`];
      await check(
        'groupedPlaysCte + firstSegmentJoin',
        sql`
            WITH grouped_sessions AS (${groupedPlaysCte({
              where: window,
              orderLimit: sql`ORDER BY MIN(s.started_at) DESC LIMIT 10`,
            })})
            SELECT gs.*, s.media_title
            FROM grouped_sessions gs
            ${firstSegmentJoin({ alias: 'gs', boundsFrom: 'grouped_sessions' }, window)}
          `,
        { from, to }
      );

      await check('playCountQuery', playCountQuery(window), { from, to });

      let floorWhere: SQL | undefined;
      await readSessionRows([old.id], async (where) => {
        floorWhere ??= where;
        return [];
      });
      await check('readSessionRows floor pass', selectWhere(floorWhere!).getSQL(), {
        from: activeSessionFloor(),
      });

      console.info('[sessionsAccessExplain] chunks planned per read', counts);
    });
  });

  it('falls back from the active floor to the id alone', async () => {
    const account = await seedAccount();
    const old = await createTestSession({
      ...account,
      state: 'stopped',
      startedAt: new Date(Date.now() - 30 * DAY_MS),
    });
    const recent = await createTestSession({
      ...account,
      state: 'stopped',
      startedAt: new Date(Date.now() - 60 * 60_000),
    });

    const readOne = vi.fn(async (where: SQL) => (await selectWhere(where).limit(1))[0]);
    expect(await readSessionRowOrActive(old.id, null, readOne)).toEqual({ id: old.id });
    expect(readOne).toHaveBeenCalledTimes(2);

    const readMany = vi.fn((where: SQL) => selectWhere(where));
    const rows = await readSessionRows([old.id, recent.id], readMany);
    expect(rows.map((row) => row.id).sort()).toEqual([old.id, recent.id].sort());
    expect(readMany).toHaveBeenCalledTimes(2);
    const secondParams = selectWhere(readMany.mock.calls[1]![0]).toSQL().params;
    expect(secondParams).toContain(old.id);
    expect(secondParams).not.toContain(recent.id);
  });

  it('bulk deletes sessions that sit in compressed chunks', { timeout: 60_000 }, async () => {
    await withWeeklyChunks(async () => {
      const account = await seedAccount();
      const ids: string[] = [];
      for (const daysAgo of [20, 30, 40]) {
        const row = await createTestSession({
          ...account,
          state: 'stopped',
          startedAt: new Date(Date.now() - daysAgo * DAY_MS),
        });
        ids.push(row.id);
      }
      expect((await compressSessionChunks(7)).length).toBeGreaterThan(0);

      const app = await buildApp();
      try {
        const res = await app.inject({ method: 'DELETE', url: '/sessions/bulk', payload: { ids } });
        expect(res.json()).toEqual({ success: true, deleted: 3 });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
      }
      const left = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.serverId, account.serverId));
      expect(left).toEqual([]);
    });
  });
});
