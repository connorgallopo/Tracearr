/**
 * GET /api/v2/public/violations and /violations/{id}
 *
 * The select is mocked with queryChain, so each test renders the WHERE and
 * ORDER BY the handler built and checks the serialized row. The alias and
 * dismissed filters are what keep notification runs, stopped runs and
 * dismissed violations out, so they are asserted on both routes.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { SQL } from 'drizzle-orm';
import { queryChain, renderCall, renderSql } from '../../test/helpers.js';

vi.mock('../../db/client.js', () => ({ db: { select: vi.fn(), execute: vi.fn() } }));
vi.mock('../../services/settings.js', () => ({ getSetting: vi.fn(() => Promise.resolve(240)) }));

import { db } from '../../db/client.js';
import { publicV2Routes } from '../publicV2/index.js';
import { resetPublicApiRateLimitCache } from '../publicV2/rateLimitCache.js';
import { translateChannelMessage } from '../publicV2/eventsTranslate.js';
import { encodeViolationCursor } from '../publicV2/violations.js';
import type { ViolationWithDetails } from '@tracearr/shared';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticatePublicApi', async (request: FastifyRequest, _reply: FastifyReply) => {
    request.publicApiContext = { userId: 'u1' };
  });
  await app.register(publicV2Routes, { prefix: '/api/v2/public' });
  return app;
}

const serverId = randomUUID();
const ruleId = randomUUID();
const identityId = randomUUID();
const accountId = randomUUID();
const violationId = randomUUID();
const sessionId = randomUUID();
const CREATED_AT_TEXT = '2026-10-06 10:00:05.123456+00';

const row = {
  id: violationId,
  severity: 'high',
  createdAt: new Date('2026-10-06T10:00:05.123Z'),
  createdAtText: CREATED_AT_TEXT,
  acknowledgedAt: null,
  sessionId,
  data: { count: 3 },
  ruleId,
  ruleName: 'Too many streams',
  serverId,
  serverName: 'Attic',
  serverType: 'plex',
  userId: identityId,
  serverUserId: accountId,
  thumbUrl: null,
  identityName: 'Alice',
};

function expectViolationFilters(where: { text: string; params: unknown[] }) {
  expect(where.text).toContain('automation_runs.kind =');
  expect(where.params).toContain('policy');
  expect(where.text).toContain('automation_runs.outcome =');
  expect(where.params).toContain('completed');
  expect(where.text).toContain('automation_runs.server_user_id is not null');
  expect(where.text).toContain('automation_runs.dismissed_at is null');
}

describe('GET /api/v2/public/violations', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    resetPublicApiRateLimitCache();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serializes one row with the documented keys, newest first, under the alias and dismissed filters', async () => {
    const chain = queryChain(vi.fn, [row]);
    vi.mocked(db.select).mockReturnValue(chain);
    app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/v2/public/violations' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [
        {
          id: violationId,
          severity: 'high',
          created_at: '2026-10-06T10:00:05.123Z',
          acknowledged_at: null,
          session_id: sessionId,
          rule: { id: ruleId, name: 'Too many streams' },
          server: { id: serverId, name: 'Attic', type: 'plex' },
          user: {
            id: identityId,
            server_user_id: accountId,
            username: 'Alice',
            thumb_url: null,
            avatar_url: null,
          },
          data: { count: 3 },
        },
      ],
      meta: { nextCursor: null, pageSize: 25 },
    });
    expectViolationFilters(renderCall(chain, 'where'));
    // orderBy is one call with two keys, so renderCall's first-argument view does not fit here
    const orderKeys = (chain.orderBy.mock.calls[0] as SQL[]).map((key) => renderSql(key).sql);
    expect(orderKeys).toEqual(['automation_runs.created_at desc', 'automation_runs.id asc']);
  });

  it('is the same object as a violation.created event payload', async () => {
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [row]));
    app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v2/public/violations' });
    const [rest] = res.json<{ data: Record<string, unknown>[] }>().data;

    const event = translateChannelMessage({
      event: 'violation:new',
      at: '2026-10-06T10:00:05.000Z',
      data: {
        id: violationId,
        ruleId,
        serverUserId: accountId,
        sessionId,
        severity: 'high',
        data: { count: 3 },
        createdAt: new Date('2026-10-06T10:00:05.123Z'),
        acknowledgedAt: null,
        rule: { id: ruleId, name: 'Too many streams', type: null },
        user: {
          id: accountId,
          userId: identityId,
          username: 'alice',
          thumbUrl: null,
          serverId,
          identityName: 'Alice',
        },
        server: { id: serverId, name: 'Attic', type: 'plex' },
      } as unknown as ViolationWithDetails,
    });
    if (event?.kind !== 'events') throw new Error('expected events');

    expect(event.events[0]?.data).toEqual(rest);
  });

  it('applies every filter and the cursor as predicates', async () => {
    const chain = queryChain(vi.fn, []);
    vi.mocked(db.select).mockReturnValue(chain);
    app = await buildTestApp();
    const cursor = encodeViolationCursor('2026-10-06 09:00:00.000321+00', violationId);

    const res = await app.inject({
      method: 'GET',
      url:
        `/api/v2/public/violations?server_id=${serverId}&user_id=${identityId}&server_user_id=${accountId}` +
        `&rule_id=${ruleId}&severity=high&acknowledged=false&since=2026-10-01&until=2026-10-07&cursor=${cursor}`,
    });

    expect(res.statusCode).toBe(200);
    const where = renderCall(chain, 'where');
    expectViolationFilters(where);
    expect(where.text).toContain('server_users.server_id =');
    expect(where.text).toContain('server_users.user_id =');
    expect(where.text).toContain('automation_runs.server_user_id =');
    expect(where.text).toContain('automation_runs.rule_id =');
    expect(where.text).toContain('automation_runs.severity =');
    expect(where.text).toContain('automation_runs.acknowledged_at is null');
    expect(where.text).toContain('automation_runs.created_at >=');
    expect(where.text).toContain('automation_runs.created_at <=');
    expect(where.text).toContain('automation_runs.created_at <');
    expect(where.text).toContain('automation_runs.created_at =');
    expect(where.text).toContain('automation_runs.id >');
    expect(where.params).toEqual(
      expect.arrayContaining([
        serverId,
        identityId,
        accountId,
        ruleId,
        'high',
        '2026-10-06 09:00:00.000321+00',
        violationId,
      ])
    );
  });

  it('bounds a cursor page with created_at <= cursor so the index range starts there', async () => {
    const chain = queryChain(vi.fn, []);
    vi.mocked(db.select).mockReturnValue(chain);
    app = await buildTestApp();
    const cursor = encodeViolationCursor(CREATED_AT_TEXT, violationId);

    await app.inject({ method: 'GET', url: `/api/v2/public/violations?cursor=${cursor}` });

    const where = renderCall(chain, 'where');
    expect(where.text).toMatch(
      /automation_runs\.created_at <= \$\d+::timestamptz and \(automation_runs\.created_at < /
    );
    expect(where.params.filter((p) => p === CREATED_AT_TEXT)).toHaveLength(3);
  });

  it('returns a cursor only for a full page, carrying the microsecond created_at', async () => {
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [row]));
    app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/api/v2/public/violations?pageSize=1' });

    expect(res.json<{ meta: { nextCursor: string | null } }>().meta.nextCursor).toBe(
      encodeViolationCursor(CREATED_AT_TEXT, violationId)
    );
  });

  it.each([
    'severity=critical',
    'cursor=not-a-cursor',
    `cursor=${Buffer.from(JSON.stringify({ t: 'yesterday', id: violationId })).toString('base64url')}`,
    `cursor=${Buffer.from(JSON.stringify({ t: CREATED_AT_TEXT, id: 'not-a-uuid' })).toString('base64url')}`,
    `cursor=${Buffer.from(JSON.stringify({ t: `${CREATED_AT_TEXT}; drop table x`, id: violationId })).toString('base64url')}`,
    'since=2026-10-07&until=2026-10-01',
    'pageSize=101',
  ])('rejects %s with 400', async (qs) => {
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, []));
    app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: `/api/v2/public/violations?${qs}` });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v2/public/violations/{id}', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    resetPublicApiRateLimitCache();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the row with its actions, under the same filters', async () => {
    const rowChain = queryChain(vi.fn, [row]);
    const actionsChain = queryChain(vi.fn, [
      {
        actionType: 'kill_stream',
        success: true,
        skipped: false,
        skipReason: null,
        errorMessage: null,
        executedAt: new Date('2026-10-06T10:00:06.000Z'),
      },
    ]);
    vi.mocked(db.select).mockReturnValueOnce(rowChain).mockReturnValueOnce(actionsChain);
    app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/violations/${violationId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: violationId,
      rule: { id: ruleId, name: 'Too many streams' },
      actions: [
        {
          type: 'kill_stream',
          success: true,
          skipped: false,
          skip_reason: null,
          error_message: null,
          executed_at: '2026-10-06T10:00:06.000Z',
        },
      ],
    });
    const where = renderCall(rowChain, 'where');
    expectViolationFilters(where);
    expect(where.text).toContain('automation_runs.id =');
    expect(where.params).toContain(violationId);
  });

  it('404s when no violation matches and 400s on a non-uuid id', async () => {
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, []));
    app = await buildTestApp();

    expect(
      (await app.inject({ method: 'GET', url: `/api/v2/public/violations/${randomUUID()}` }))
        .statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v2/public/violations/nope' })).statusCode
    ).toBe(400);
  });
});
