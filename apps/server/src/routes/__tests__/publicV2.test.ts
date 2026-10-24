/**
 * Public API v2 route tests
 *
 * Covers the /docs endpoint (v2 OpenAPI document with all registered paths)
 * plus the cheap non-database branches of /history and /streams: invalid
 * cursor rejection and the empty-cache summary shape. Auth is faked via the
 * authenticatePublicApi decorator; real token behavior and the chain-grain
 * cursor contract are covered by the integration suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { sql, type SQL } from 'drizzle-orm';

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn(() => Promise.resolve([])),
      })),
    })),
    execute: vi.fn(),
  },
}));

vi.mock('../publicV2/shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../publicV2/shared.js')>()),
  runHistoryPage: vi.fn(async () => ({ data: [], nextCursor: null })),
}));

vi.mock('../../services/settings.js', () => ({
  getSetting: vi.fn(() => Promise.resolve(240)),
}));

import { db } from '../../db/client.js';
import { getSetting } from '../../services/settings.js';
import { runHistoryPage } from '../publicV2/shared.js';
import { renderSql } from '../../test/helpers.js';
import { publicV2Routes } from '../publicV2/index.js';
import { resetPublicApiRateLimitCache } from '../publicV2/rateLimitCache.js';

async function buildTestApp(authPasses: boolean, withRateLimit = false): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(sensible);
  if (withRateLimit) {
    await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  }

  app.decorate('authenticatePublicApi', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authPasses) {
      return reply.unauthorized('Invalid or missing API key');
    }
    request.publicApiContext = { userId: 'u1' };
  });

  await app.register(publicV2Routes, { prefix: '/api/v2/public' });

  return app;
}

describe('public API v2 skeleton', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    resetPublicApiRateLimitCache();
  });

  afterEach(async () => {
    await app.close();
  });

  it('registers every route with zero DB queries (a DB-down boot must not crash-loop)', async () => {
    vi.mocked(db.select).mockClear();
    vi.mocked(getSetting).mockClear();

    app = await buildTestApp(true, true);

    expect(db.select).not.toHaveBeenCalled();
    expect(getSetting).not.toHaveBeenCalled();
  });

  describe('with auth passing', () => {
    beforeEach(async () => {
      app = await buildTestApp(true);
    });

    it('documents exactly the route paths that exist (field-level drift is out of scope)', async () => {
      // Collect the real route surface from Fastify itself, then compare it
      // against the hand-maintained OpenAPI registry. A route added without a
      // spec entry (or a spec entry whose route was removed) fails here
      // instead of shipping a wrong public document.
      const collector = Fastify({ logger: false });
      await collector.register(sensible);
      collector.decorate('authenticatePublicApi', async () => undefined);
      const actualPaths = new Set<string>();
      collector.addHook('onRoute', (route) => {
        if (
          route.method === 'GET' ||
          (Array.isArray(route.method) && route.method.includes('GET'))
        ) {
          actualPaths.add(route.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}'));
        }
      });
      await collector.register(publicV2Routes, { prefix: '/api/v2/public' });
      await collector.close();

      const res = await app.inject({ method: 'GET', url: '/api/v2/public/docs' });
      expect(res.statusCode).toBe(200);
      const spec = res.json<{ paths: Record<string, unknown>; openapi: string }>();

      expect(spec.openapi).toMatch(/^3\./);
      const documentedPaths = new Set(Object.keys(spec.paths));
      expect([...documentedPaths].sort()).toEqual([...actualPaths].sort());

      // Every documented operation carries responses and bearer security
      for (const [path, pathObj] of Object.entries(spec.paths)) {
        const get = (pathObj as Record<string, { responses?: object; security?: unknown[] }>).get;
        expect(get?.responses, path).toBeDefined();
        expect(get?.security, path).toBeDefined();
      }
    });

    it('groups every operation under a described resource tag and never points at v1', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v2/public/docs' });
      const spec = res.json<{
        tags: { name: string; description: string }[];
        info: { description: string };
        paths: Record<string, Record<string, { tags?: string[]; description?: string }>>;
      }>();

      expect(spec.tags.map((t) => t.name)).toEqual([
        'Docs',
        'Streams',
        'Live events',
        'Violations',
        'Servers',
        'History',
        'Media',
        'Users',
        'Libraries',
      ]);
      for (const tag of spec.tags) expect(tag.description, tag.name).toBeTruthy();

      const names = new Set(spec.tags.map((t) => t.name));
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const op of Object.values(methods)) {
          expect(op.tags, path).toHaveLength(1);
          expect(names.has(op.tags?.[0] ?? ''), path).toBe(true);
          expect(op.description ?? '', path).not.toMatch(/\/api\/v1\//);
        }
      }
      expect(spec.info.description).not.toMatch(/\/api\/v1\//);
      expect(JSON.stringify(spec)).not.toMatch(/api\/v1\/public/);
    });

    it('serves the v2 OpenAPI document with the docs path registered', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v2/public/docs' });

      expect(res.statusCode).toBe(200);
      const spec = res.json<{
        info: { version: string };
        paths: Record<string, unknown>;
      }>();
      expect(spec.info.version).toBe('2.0.0');
      expect(spec.paths['/api/v2/public/docs']).toBeDefined();
      expect(spec.paths['/api/v2/public/history']).toBeDefined();
      expect(spec.paths['/api/v2/public/streams']).toBeDefined();
    });

    it('rejects an unreadable history cursor with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v2/public/history?cursor=not-a-cursor',
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects a decodable history cursor whose id is not a uuid with 400', async () => {
      const cursor = Buffer.from(
        JSON.stringify({ t: new Date().toISOString(), id: 'not-a-uuid' }),
        'utf8'
      ).toString('base64url');
      const res = await app.inject({
        method: 'GET',
        url: `/api/v2/public/history?cursor=${cursor}`,
      });

      expect(res.statusCode).toBe(400);
    });

    it('leaves trailers out of history unless media_type is trailer', async () => {
      const conditionsFor = async (query: string) => {
        vi.mocked(runHistoryPage).mockClear();
        const res = await app.inject({ method: 'GET', url: `/api/v2/public/history${query}` });
        expect(res.statusCode).toBe(200);
        const conditions = vi.mocked(runHistoryPage).mock.calls[0]![0];
        return conditions.map((c: SQL) => renderSql(c));
      };

      const unfiltered = await conditionsFor('');
      expect(unfiltered.map((c) => c.sql)).toContain("s.media_type <> 'trailer'");

      const trailers = await conditionsFor('?media_type=trailer');
      expect(trailers.map((c) => c.sql)).not.toContain("s.media_type <> 'trailer'");
      expect(trailers.some((c) => c.sql === 's.media_type = $1' && c.params[0] === 'trailer')).toBe(
        true
      );
    });

    it('re-applies the since and until window on the join back to sessions', async () => {
      const actual =
        await vi.importActual<typeof import('../publicV2/shared.js')>('../publicV2/shared.js');
      const since = new Date('2026-04-01T00:00:00.000Z');
      const until = new Date('2026-06-30T23:59:59.999Z');
      vi.mocked(db.execute)
        .mockResolvedValueOnce({
          rows: [
            {
              chain_ids: ['00000000-0000-4000-8000-000000000001'],
              raw_row_count: '1',
              window_lower_bound: null,
            },
          ],
        } as never)
        .mockResolvedValueOnce({ rows: [] } as never);

      await actual.runHistoryPage(
        [sql`s.started_at >= ${since}`, sql`s.started_at <= ${until}`],
        50,
        null,
        undefined,
        { since, until }
      );

      const { sql: text } = renderSql(vi.mocked(db.execute).mock.calls[1]![0] as SQL);
      const join = text
        .replace(/\s+/g, ' ')
        .match(/JOIN sessions s ON s\.id = p\.first_session_id.*?JOIN server_users/)?.[0];
      expect(join).toMatch(/s\.started_at >= \$\d+/);
      expect(join).toMatch(/s\.started_at <= \$\d+/);
    });

    it('rejects invalid history query parameters with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v2/public/history?server_id=not-a-uuid',
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects a watched-media request with no media_type with 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v2/public/watched-media' });

      expect(res.statusCode).toBe(400);
    });

    it('rejects a watched-media pageSize above the 1000 cap with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v2/public/watched-media?media_type=movie&pageSize=1001',
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects an unreadable watched-media cursor with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v2/public/watched-media?media_type=movie&cursor=not-a-cursor',
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns an empty streams payload with a zeroed summary when no cache service exists', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v2/public/streams' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        data: [],
        summary: {
          total: 0,
          transcodes: 0,
          audio_transcodes: 0,
          direct_streams: 0,
          direct_plays: 0,
          total_bitrate: expect.any(String),
          by_server: [],
        },
      });
    });
  });

  describe('rate limiting', () => {
    it('enforces one per-token budget across the whole v2 surface', async () => {
      vi.mocked(getSetting).mockResolvedValueOnce(2);
      app = await buildTestApp(true, true);

      const first = await app.inject({ method: 'GET', url: '/api/v2/public/docs' });
      const second = await app.inject({ method: 'GET', url: '/api/v2/public/docs' });
      // Budget already spent on /docs, so a different v2 route must 429.
      const third = await app.inject({ method: 'GET', url: '/api/v2/public/history' });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(third.statusCode).toBe(429);
    });

    it('charges a violations request to the same budget', async () => {
      vi.mocked(getSetting).mockResolvedValueOnce(1);
      app = await buildTestApp(true, true);

      await app.inject({ method: 'GET', url: '/api/v2/public/docs' });
      const res = await app.inject({ method: 'GET', url: '/api/v2/public/violations' });

      expect(res.statusCode).toBe(429);
    });
  });

  describe('with auth rejecting', () => {
    beforeEach(async () => {
      app = await buildTestApp(false);
    });

    it.each([
      '/api/v2/public/docs',
      '/api/v2/public/history',
      '/api/v2/public/streams',
      '/api/v2/public/watched-media?media_type=movie',
      '/api/v2/public/violations',
      '/api/v2/public/violations/0f4d2a6e-8b1c-4e3f-9a7d-6c5b4a3f2e1d',
      '/api/v2/public/servers',
    ])('returns 401 for %s', async (url) => {
      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(401);
    });
  });
});
