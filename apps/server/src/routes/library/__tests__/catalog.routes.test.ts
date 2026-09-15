/**
 * Catalog browse route tests
 *
 * SQL-shape assertions (buildCatalogPageQuery/buildCatalogTotalsQuery/
 * buildLetterCountsQuery/buildCatalogCandidatesQuery) run against rendered
 * query text with no DB; route-level assertions mock db.execute (this
 * suite's convention, see vitest.routes.config.ts) so the catalog handler
 * and the real mediaWatchedService code run end-to-end against fake rows.
 * Deep SQL plan correctness lives in
 * apps/server/test/integration/catalogExplain.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, CatalogResponse, CatalogLettersResponse } from '@tracearr/shared';
import { renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

// Poster preference read once per request; default (no preference) unless a
// test overrides it, matching production's "no setting row -> null" default.
vi.mock('../../../services/settings.js', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

import { db } from '../../../db/client.js';
import { getSetting } from '../../../services/settings.js';
import {
  libraryCatalogRoute,
  buildCatalogPageQuery,
  buildCatalogTotalsQuery,
  buildCatalogCandidatesQuery,
  buildLetterCountsQuery,
  buildLetterBuckets,
  expandMediaAliases,
} from '../catalog.js';

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

// ============================================================================
// SQL shape (no DB, no mocking)
// ============================================================================

const baseFilterParams = {
  genre: null,
  yearFrom: null,
  yearTo: null,
  searchNormalized: null,
  resolution: null,
  libraryServerId: null,
  libraryId: null,
  hdr: false,
  sizeGbMin: null,
  sizeGbMax: null,
  serverIds: undefined,
} as const;

describe('buildCatalogPageQuery', () => {
  it('title sort: orders by the article-stripped sort_title with an offset window', () => {
    const { sql, params } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 120,
        ...baseFilterParams,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('ORDER BY m.sort_title, m.id');
    expect(text).toContain('m.merged_into_id IS NULL');
    expect(text).toContain('LIMIT');
    expect(text).toContain('OFFSET');
    expect(text).not.toContain('ROW(');
    expect(text).not.toContain('normalized_title,');
    expect(params).toContain(120);
    expect(params).toContain(60);
  });

  it('added sort: descending timestamp/id, excludes null latest_added_at', () => {
    const { sql } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'added',
        offset: 0,
        ...baseFilterParams,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('ORDER BY m.latest_added_at DESC NULLS LAST, m.id DESC NULLS LAST');
    expect(text).toContain('m.latest_added_at IS NOT NULL');
  });

  it('year sort: descending year/id, excludes null year', () => {
    const { sql } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'year',
        offset: 0,
        ...baseFilterParams,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('ORDER BY m.year DESC NULLS LAST, m.id DESC NULLS LAST');
    expect(text).toContain('m.year IS NOT NULL');
  });

  it('plays sort: joins the value_rollup CTE and orders by the computed value', () => {
    const { sql } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'plays',
        offset: 0,
        ...baseFilterParams,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('value_rollup AS (');
    expect(text).toContain('LEFT JOIN value_rollup vr ON vr.canonical_id = m.id');
    expect(text).toContain('ORDER BY COALESCE(vr.plays, 0) DESC, m.id DESC');
    expect(text).toContain("am.media_type = 'movie'");
  });

  it('watch_time sort: uses the watch_time_ms rollup column', () => {
    const { sql } = renderSql(
      buildCatalogPageQuery({
        type: 'show',
        sort: 'watch_time',
        offset: 0,
        ...baseFilterParams,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('ORDER BY COALESCE(vr.watch_time_ms, 0) DESC, m.id DESC');
    expect(text).toContain('p.show_media_id IS NOT NULL');
  });

  it('viewers sort: uses the viewers rollup column', () => {
    const { sql } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'viewers',
        offset: 0,
        ...baseFilterParams,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('ORDER BY COALESCE(vr.viewers, 0) DESC, m.id DESC');
  });

  it('applies genre, year range, search and resolution predicates', () => {
    const { sql, params } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 0,
        genre: 'Action',
        yearFrom: 2000,
        yearTo: 2020,
        searchNormalized: 'dune',
        resolution: '4k',
        libraryServerId: null,
        libraryId: null,
        hdr: false,
        sizeGbMin: null,
        sizeGbMax: null,
        serverIds: undefined,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('= ANY(m.genres)');
    expect(text).toContain('m.year >=');
    expect(text).toContain('m.year <=');
    expect(text).toContain('m.normalized_title LIKE');
    expect(text).toContain('liv.library_item_id = li.id');
    // resolution now compiles to a raw IN-list over bucket spellings, not a
    // bound param - the fragment assertion above covers it
    expect(params).toEqual(expect.arrayContaining(['Action', 2000, 2020, 'dune']));
  });

  it('applies library, HDR and size-on-disk predicates', () => {
    const serverId = randomUUID();
    const { sql, params } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 0,
        ...baseFilterParams,
        libraryServerId: serverId,
        libraryId: 'lib-1',
        hdr: true,
        sizeGbMin: 5,
        sizeGbMax: 50,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('li.server_id = $');
    expect(text).toContain('li.library_id =');
    expect(text).toContain(
      "livh.video_dynamic_range IS NOT NULL AND livh.video_dynamic_range <> 'sdr'"
    );
    expect(text).toContain('li.file_size >=');
    expect(text).toContain('li.file_size <=');
    expect(params).toContain(serverId);
    expect(params).toContain('lib-1');
    // GB inputs convert to bytes before binding (base-1024, matching formatBytes).
    expect(params).toContain(5 * 1024 ** 3);
    expect(params).toContain(50 * 1024 ** 3);
  });

  it('show filters route resolution, HDR and size through episode versions', () => {
    const { sql, params } = renderSql(
      buildCatalogPageQuery({
        type: 'show',
        sort: 'title',
        offset: 0,
        ...baseFilterParams,
        resolution: '4k',
        hdr: true,
        sizeGbMin: 5,
        sizeGbMax: 50,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('em.show_media_id = m.id');
    expect(text).toContain("em.media_type = 'episode'");
    expect(text).toContain('epi.server_id = li.server_id AND epi.library_id = li.library_id');
    expect(text).toContain('COALESCE(SUM(v.file_size), 0)');
    expect(text).toContain("v.video_dynamic_range IS NOT NULL AND v.video_dynamic_range <> 'sdr'");
    // The container-item shapes must not survive on the show tab.
    expect(text).not.toContain('li.file_size >=');
    expect(text).not.toContain('liv.library_item_id');
    expect(params).toContain(5 * 1024 ** 3);
    expect(params).toContain(50 * 1024 ** 3);
  });

  it('show pages decorate copies with episode-derived resolution and size', () => {
    const { sql } = renderSql(
      buildCatalogPageQuery({
        type: 'show',
        sort: 'title',
        offset: 0,
        ...baseFilterParams,
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    expect(text).toContain("CASE WHEN p.media_type = 'show'");
    expect(text).toContain('em.show_media_id = p.id');
    expect(text).toContain('SUM(v.file_size)');
    // No filters active, so the WHERE carries no episode joins.
    expect(text).not.toContain('em.show_media_id = m.id');
  });

  it('scopes the servers/poster subqueries and EXISTS clause to a single server', () => {
    const serverId = randomUUID();
    const { sql, params } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 0,
        ...baseFilterParams,
        serverIds: [serverId],
        pageSize: 60,
      })
    );
    const text = normalize(sql);
    const scopedClauses = text.match(/li\.server_id =/g) ?? [];
    // EXISTS + servers json_agg + poster_copy subqueries all carry the scope,
    // plus the (always-present, IS NULL-guarded) library filter's own
    // li.server_id equality inside the EXISTS clause.
    expect(scopedClauses.length).toBe(4);
    expect(params).toContain(serverId);
  });

  it('poster_copy ORDER BY: no preference is newest-first', () => {
    const { sql } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 0,
        ...baseFilterParams,
        pageSize: 60,
        preferredPosterServerId: null,
      })
    );
    expect(normalize(sql)).toContain('ORDER BY li.created_at DESC LIMIT 1');
  });

  it('poster_copy ORDER BY: a preference sorts that server first, newest as tiebreak', () => {
    const preferredId = randomUUID();
    const { sql, params } = renderSql(
      buildCatalogPageQuery({
        type: 'movie',
        sort: 'title',
        offset: 0,
        ...baseFilterParams,
        pageSize: 60,
        preferredPosterServerId: preferredId,
      })
    );
    expect(normalize(sql)).toContain('ORDER BY (li.server_id =');
    expect(params).toContain(preferredId);
  });
});

describe('buildCatalogTotalsQuery', () => {
  it('counts matching media and sums file size, no window', () => {
    const { sql } = renderSql(
      buildCatalogTotalsQuery({ type: 'movie', sort: 'title', ...baseFilterParams })
    );
    const text = normalize(sql);
    expect(text).toContain('COUNT(*)::bigint AS total_items');
    expect(text).toContain('total_file_size');
    expect(text).not.toContain('LIMIT');
    expect(text).not.toContain('m.latest_added_at IS NOT NULL');
    expect(text).not.toContain('m.year IS NOT NULL');
  });

  it('mirrors the added sort null-key exclusion so the grid total matches reachable rows', () => {
    const { sql } = renderSql(
      buildCatalogTotalsQuery({ type: 'movie', sort: 'added', ...baseFilterParams })
    );
    expect(normalize(sql)).toContain('m.latest_added_at IS NOT NULL');
  });

  it('mirrors the year sort null-key exclusion', () => {
    const { sql } = renderSql(
      buildCatalogTotalsQuery({ type: 'movie', sort: 'year', ...baseFilterParams })
    );
    expect(normalize(sql)).toContain('m.year IS NOT NULL');
  });

  it('value sorts have no null-key exclusion (COALESCE makes every row reachable)', () => {
    const { sql } = renderSql(
      buildCatalogTotalsQuery({ type: 'movie', sort: 'plays', ...baseFilterParams })
    );
    const text = normalize(sql);
    expect(text).not.toContain('m.latest_added_at IS NOT NULL');
    expect(text).not.toContain('m.year IS NOT NULL');
  });
});

describe('buildLetterCountsQuery', () => {
  it('buckets by collation range over sort_title, digits-and-below under #', () => {
    const { sql } = renderSql(buildLetterCountsQuery({ type: 'movie', ...baseFilterParams }));
    const text = normalize(sql);
    expect(text).toContain("WHEN m.sort_title < 'a' THEN '#'");
    // Bucket A is everything below 'b' that survived the '#' arm - a range
    // comparison, never a first-character check.
    expect(text).toContain('WHEN m.sort_title <');
    expect(text).toContain("ELSE 'Z' END");
    expect(text).toContain('GROUP BY 1');
    expect(text).toContain('m.merged_into_id IS NULL');
  });

  it('carries the same filter predicates as the page query', () => {
    const { sql, params } = renderSql(
      buildLetterCountsQuery({
        type: 'show',
        genre: 'Drama',
        yearFrom: null,
        yearTo: null,
        searchNormalized: null,
        resolution: '1080p',
        libraryServerId: null,
        libraryId: null,
        hdr: false,
        sizeGbMin: null,
        sizeGbMax: null,
        serverIds: undefined,
      })
    );
    const text = normalize(sql);
    expect(text).toContain('= ANY(m.genres)');
    expect(text).toContain('em.show_media_id = m.id');
    expect(params).toEqual(expect.arrayContaining(['Drama', 'show']));
  });
});

describe('buildCatalogCandidatesQuery', () => {
  it('title sort: ordered ids with a per-row letter bucket, no window', () => {
    const { sql } = renderSql(
      buildCatalogCandidatesQuery({ type: 'movie', sort: 'title', ...baseFilterParams })
    );
    const text = normalize(sql);
    expect(text).toContain('AS letter');
    expect(text).toContain('ORDER BY m.sort_title, m.id');
    expect(text).not.toContain('LIMIT');
  });

  it('plays sort: includes the value rollup for ordering', () => {
    const { sql } = renderSql(
      buildCatalogCandidatesQuery({ type: 'movie', sort: 'plays', ...baseFilterParams })
    );
    const text = normalize(sql);
    expect(text).toContain('value_rollup AS (');
    expect(text).toContain('ORDER BY COALESCE(vr.plays, 0) DESC, m.id DESC');
  });
});

describe('buildLetterBuckets', () => {
  it('returns all 27 buckets in # then A-Z order, zero counts included', () => {
    const buckets = buildLetterBuckets(
      new Map([
        ['A', 2],
        ['#', 1],
        ['Z', 5],
      ])
    );
    expect(buckets).toHaveLength(27);
    expect(buckets[0]).toEqual({ letter: '#', count: 1 });
    expect(buckets[1]).toEqual({ letter: 'A', count: 2 });
    expect(buckets[26]).toEqual({ letter: 'Z', count: 5 });
    expect(buckets[2]).toEqual({ letter: 'B', count: 0 });
  });
});

describe('expandMediaAliases', () => {
  const dbExecute = vi.mocked(db.execute);

  beforeEach(() => {
    dbExecute.mockReset();
  });

  it('returns an empty array without querying when given no ids', async () => {
    await expect(expandMediaAliases([])).resolves.toEqual([]);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('queries by id or merged_into_id and maps rows back to ids', async () => {
    const winnerId = randomUUID();
    const loserId = randomUUID();
    dbExecute.mockResolvedValueOnce({ rows: [{ id: winnerId }, { id: loserId }] } as never);

    const result = await expandMediaAliases([winnerId]);

    expect(result).toEqual([winnerId, loserId]);
    const { sql } = renderSql(dbExecute.mock.calls[0]![0] as never);
    expect(normalize(sql)).toContain('merged_into_id = ANY');
  });
});

// ============================================================================
// Route-level (mocked db.execute)
// ============================================================================

function createSpyRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    // Minimal SET NX EX mock, matching withComputeSingleFlight's lock call.
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
  };
}

async function buildTestApp(
  authUser: AuthUser,
  redis: ReturnType<typeof createSpyRedis> = createSpyRedis()
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('redis', redis as never);
  await app.register(libraryCatalogRoute, { prefix: '/library' });
  return app;
}

function createOwnerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

function createViewerUser(serverIds: string[]): AuthUser {
  return { userId: randomUUID(), username: 'viewer', role: 'viewer', serverIds };
}

function rawMovieRow(overrides: Partial<Record<string, unknown>> = {}) {
  const id = (overrides.id as string) ?? randomUUID();
  return {
    id,
    media_type: 'movie',
    title: overrides.title ?? 'Dune',
    year: overrides.year ?? 2021,
    genres: overrides.genres ?? ['Action'],
    sort_title: overrides.sort_title ?? 'dune',
    latest_added_at: overrides.latest_added_at ?? new Date('2024-01-01').toISOString(),
    servers: overrides.servers ?? [],
    poster_copy: overrides.poster_copy ?? null,
    ...overrides,
  };
}

/** Routes db.execute by rendered SQL content instead of call order, so the
 * Promise.all interleavings inside the handler can't reorder mock results. */
function dispatchBySql(
  handlers: { match: (text: string) => boolean; rows: Record<string, unknown>[] }[]
) {
  return (query: unknown) => {
    const { sql } = renderSql(query as never);
    const text = normalize(sql);
    for (const handler of handlers) {
      if (handler.match(text)) return Promise.resolve({ rows: handler.rows });
    }
    return Promise.resolve({ rows: [] });
  };
}

const isPageQuery = (text: string) => text.includes('WITH page AS') || text.includes(', page AS');
const isTotalsQuery = (text: string) => text.includes('total_items');
const isWatchedProbe = (text: string) => text.includes('alias_map');
const isEngagement = (text: string) => text.includes('SELECT canonical_id, plays, viewers');
const isAliasExpansion = (text: string) => text.includes('merged_into_id = ANY');
const isCandidates = (text: string) => text.includes('AS letter');
const isLetterCounts = (text: string) => text.includes('GROUP BY 1');
const isFileSize = (text: string) => text.includes('SELECT DISTINCT li2.media_id');

describe('GET /library/catalog', () => {
  let app: FastifyInstance;
  const dbExecute = vi.mocked(db.execute);

  beforeEach(() => {
    dbExecute.mockReset();
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  afterEach(async () => {
    if (app) await app.close();
    vi.useRealTimers();
  });

  it('rejects a request missing the required type param', async () => {
    app = await buildTestApp(createOwnerUser());
    const response = await app.inject({ method: 'GET', url: '/library/catalog' });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('rejects a negative offset', async () => {
    app = await buildTestApp(createOwnerUser());
    const response = await app.inject({
      method: 'GET',
      url: '/library/catalog?type=movie&offset=-5',
    });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('forbids a lens identity with no accessible account in scope', async () => {
    const viewer = createViewerUser([randomUUID()]);
    app = await buildTestApp(viewer);
    dbExecute.mockResolvedValueOnce({ rows: [] } as never); // lens access check: none found

    const response = await app.inject({
      method: 'GET',
      url: `/library/catalog?type=movie&lens=${randomUUID()}`,
    });
    expect(response.statusCode).toBe(403);
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it('returns a shaped page for a simple movie/title request', async () => {
    app = await buildTestApp(createOwnerUser());
    const movieId = randomUUID();
    const serverId = randomUUID();

    dbExecute.mockImplementation(
      dispatchBySql([
        {
          match: isPageQuery,
          rows: [
            rawMovieRow({
              id: movieId,
              servers: [
                {
                  serverId,
                  addedAt: '2024-01-01T00:00:00Z',
                  videoResolution: '4k',
                  fileSize: 100,
                },
              ],
              poster_copy: {
                thumbPath: '/library/metadata/1/thumb',
                dominantColor: '#101010',
                serverId,
              },
            }),
          ],
        },
        { match: isTotalsQuery, rows: [{ total_items: '1', total_file_size: '100' }] },
        {
          match: isWatchedProbe,
          rows: [{ canonical_id: movieId, watched: true, has_plays: true }],
        },
        { match: isAliasExpansion, rows: [{ id: movieId }] },
        { match: isEngagement, rows: [{ canonical_id: movieId, plays: '3', viewers: '2' }] },
      ]) as never
    );

    const response = await app.inject({ method: 'GET', url: '/library/catalog?type=movie' });
    expect(response.statusCode).toBe(200);
    const body: CatalogResponse = response.json();
    expect(body.data).toHaveLength(1);
    const row = body.data[0]!;
    expect(row.mediaId).toBe(movieId);
    expect(row.watchedState).toBe('watched');
    expect(row.plays).toBe(3);
    expect(row.viewers).toBe(2);
    expect(row.resolutionBest).toBe('4k');
    expect(row.posterVersion).toEqual(expect.stringMatching(/^[0-9a-f]{8}$/));
    expect(row.posterUrl).toContain('width=360');
    expect(row.posterUrl).toContain('height=540');
    expect(row.posterUrl).toContain(`v=${row.posterVersion}`);
    expect(body.meta).toEqual({
      offset: 0,
      pageSize: 60,
      totalItems: 1,
      totalFileSize: 100,
    });
  });

  describe('watchedStateSelf', () => {
    it('flags anyone-watched but not self-watched when a different user watched it', async () => {
      const requester = createOwnerUser();
      app = await buildTestApp(requester);
      const movieId = randomUUID();

      dbExecute.mockImplementation(((query: unknown) => {
        const { sql, params } = renderSql(query as never);
        const text = normalize(sql);
        if (isPageQuery(text)) {
          return Promise.resolve({ rows: [rawMovieRow({ id: movieId })] });
        }
        if (isTotalsQuery(text)) {
          return Promise.resolve({ rows: [{ total_items: '1', total_file_size: '0' }] });
        }
        if (isWatchedProbe(text)) {
          // The self probe binds the requester's id as its lensUserId param;
          // the anyone probe binds null - that's what tells the two calls apart.
          const isSelfProbe = params.includes(requester.userId);
          return Promise.resolve({
            rows: isSelfProbe ? [] : [{ canonical_id: movieId, watched: true, has_plays: true }],
          });
        }
        if (isAliasExpansion(text)) {
          return Promise.resolve({ rows: [{ id: movieId }] });
        }
        if (isEngagement(text)) {
          return Promise.resolve({ rows: [{ canonical_id: movieId, plays: '1', viewers: '1' }] });
        }
        return Promise.resolve({ rows: [] });
      }) as never);

      const response = await app.inject({ method: 'GET', url: '/library/catalog?type=movie' });
      expect(response.statusCode).toBe(200);
      const row = response.json<CatalogResponse>().data[0]!;
      expect(row.watchedState).toBe('watched');
      expect(row.watchedStateSelf).toBe('unwatched');
    });

    it('flags both watchedState and watchedStateSelf when the requester is the one who watched it', async () => {
      const requester = createOwnerUser();
      app = await buildTestApp(requester);
      const movieId = randomUUID();

      dbExecute.mockImplementation(((query: unknown) => {
        const { sql } = renderSql(query as never);
        const text = normalize(sql);
        if (isPageQuery(text)) {
          return Promise.resolve({ rows: [rawMovieRow({ id: movieId })] });
        }
        if (isTotalsQuery(text)) {
          return Promise.resolve({ rows: [{ total_items: '1', total_file_size: '0' }] });
        }
        if (isWatchedProbe(text)) {
          // The requester watched it themselves, so both the anyone probe
          // and the self probe see it - same canned row either way.
          return Promise.resolve({
            rows: [{ canonical_id: movieId, watched: true, has_plays: true }],
          });
        }
        if (isAliasExpansion(text)) {
          return Promise.resolve({ rows: [{ id: movieId }] });
        }
        if (isEngagement(text)) {
          return Promise.resolve({ rows: [{ canonical_id: movieId, plays: '1', viewers: '1' }] });
        }
        return Promise.resolve({ rows: [] });
      }) as never);

      const response = await app.inject({ method: 'GET', url: '/library/catalog?type=movie' });
      expect(response.statusCode).toBe(200);
      const row = response.json<CatalogResponse>().data[0]!;
      expect(row.watchedState).toBe('watched');
      expect(row.watchedStateSelf).toBe('watched');
    });
  });

  it('threads the requested offset into the page query and echoes it in meta', async () => {
    app = await buildTestApp(createOwnerUser());
    dbExecute.mockImplementation(
      dispatchBySql([
        { match: isTotalsQuery, rows: [{ total_items: '500', total_file_size: '0' }] },
      ]) as never
    );

    const response = await app.inject({
      method: 'GET',
      url: '/library/catalog?type=movie&offset=240&pageSize=30',
    });
    expect(response.statusCode).toBe(200);
    const body: CatalogResponse = response.json();
    expect(body.meta.offset).toBe(240);
    expect(body.meta.pageSize).toBe(30);
    expect(body.meta.totalItems).toBe(500);
    expect(body.data).toEqual([]);

    const pageCall = dbExecute.mock.calls
      .map((call) => renderSql(call[0] as never))
      .find(({ sql }) => isPageQuery(normalize(sql)));
    expect(pageCall).toBeDefined();
    expect(pageCall!.params).toEqual(expect.arrayContaining([240, 30]));
  });

  it('threads libraryKey, hdr and size-on-disk filters into the page query', async () => {
    app = await buildTestApp(createOwnerUser());
    const serverId = randomUUID();
    dbExecute.mockImplementation(
      dispatchBySql([
        { match: isTotalsQuery, rows: [{ total_items: '0', total_file_size: '0' }] },
      ]) as never
    );

    const response = await app.inject({
      method: 'GET',
      url: `/library/catalog?type=movie&libraryKey=${serverId}:lib-1&hdr=true&sizeGbMin=1&sizeGbMax=20`,
    });
    expect(response.statusCode).toBe(200);

    const pageCall = dbExecute.mock.calls
      .map((call) => renderSql(call[0] as never))
      .find(({ sql }) => isPageQuery(normalize(sql)));
    expect(pageCall).toBeDefined();
    expect(pageCall!.params).toEqual(
      expect.arrayContaining([serverId, 'lib-1', 1 * 1024 ** 3, 20 * 1024 ** 3])
    );
    expect(normalize(pageCall!.sql)).toContain("livh.video_dynamic_range <> 'sdr'");
  });

  it('a punctuation-only search binds no search param instead of an empty-string LIKE', async () => {
    app = await buildTestApp(createOwnerUser());
    dbExecute.mockImplementation(
      dispatchBySql([
        { match: isTotalsQuery, rows: [{ total_items: '0', total_file_size: '0' }] },
      ]) as never
    );

    const response = await app.inject({
      method: 'GET',
      url: '/library/catalog?type=movie&search=...',
    });
    expect(response.statusCode).toBe(200);

    const pageCall = dbExecute.mock.calls
      .map((call) => renderSql(call[0] as never))
      .find(({ sql }) => isPageQuery(normalize(sql)));
    expect(pageCall).toBeDefined();
    expect(pageCall!.params).not.toContain('');
  });

  it('rejects a libraryKey that is not `${uuid}:${libraryId}`', async () => {
    app = await buildTestApp(createOwnerUser());
    const response = await app.inject({
      method: 'GET',
      url: '/library/catalog?type=movie&libraryKey=not-a-uuid:lib-1',
    });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('cache key coverage: hdr=true does not reuse the hdr=false totals cache entry', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    dbExecute.mockImplementation(
      dispatchBySql([
        { match: isTotalsQuery, rows: [{ total_items: '3', total_file_size: '0' }] },
      ]) as never
    );

    await app.inject({ method: 'GET', url: '/library/catalog?type=movie' });
    await app.inject({ method: 'GET', url: '/library/catalog?type=movie&hdr=true' });

    const totalsCalls = dbExecute.mock.calls
      .map((call) => renderSql(call[0] as never))
      .filter(({ sql }) => isTotalsQuery(normalize(sql))).length;
    expect(totalsCalls).toBe(2);
  });

  it('caches totals per filter set: a second page fetch skips the totals query', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    dbExecute.mockImplementation(
      dispatchBySql([
        { match: isTotalsQuery, rows: [{ total_items: '9', total_file_size: '42' }] },
      ]) as never
    );

    const first = await app.inject({ method: 'GET', url: '/library/catalog?type=movie' });
    expect(first.statusCode).toBe(200);
    const totalsCalls = () =>
      dbExecute.mock.calls
        .map((call) => renderSql(call[0] as never))
        .filter(({ sql }) => isTotalsQuery(normalize(sql))).length;
    expect(totalsCalls()).toBe(1);

    const second = await app.inject({
      method: 'GET',
      url: '/library/catalog?type=movie&offset=60',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<CatalogResponse>().meta.totalItems).toBe(9);
    expect(totalsCalls()).toBe(1);
  });

  it('reflects merged-loser plays on the winner row (watched probe already alias-expanded)', async () => {
    app = await buildTestApp(createOwnerUser());
    const winnerId = randomUUID();

    dbExecute.mockImplementation(
      dispatchBySql([
        { match: isPageQuery, rows: [rawMovieRow({ id: winnerId })] },
        { match: isTotalsQuery, rows: [{ total_items: '1', total_file_size: '0' }] },
        {
          match: isWatchedProbe,
          // The DB-side alias CTE already folds the loser's plays into this
          // row; the route just needs to read it back onto the winner's id.
          rows: [{ canonical_id: winnerId, watched: true, has_plays: true }],
        },
        // Alias expansion returns the winner plus its merge loser; the mock
        // only needs a non-empty result to prove the wiring, real alias
        // resolution is covered by the integration suite.
        { match: isAliasExpansion, rows: [{ id: winnerId }, { id: randomUUID() }] },
        { match: isEngagement, rows: [{ canonical_id: winnerId, plays: '7', viewers: '3' }] },
      ]) as never
    );

    const response = await app.inject({ method: 'GET', url: '/library/catalog?type=movie' });
    expect(response.statusCode).toBe(200);
    const row = response.json<CatalogResponse>().data[0]!;
    expect(row.watchedState).toBe('watched');
    expect(row.plays).toBe(7);
  });

  it('exposes a zero-play tail row under plays sort without an engagement lookup', async () => {
    app = await buildTestApp(createOwnerUser());
    const movieId = randomUUID();

    dbExecute.mockImplementation(
      dispatchBySql([
        {
          match: isPageQuery,
          rows: [rawMovieRow({ id: movieId, plays_value: '0', viewers_value: '0', value: '0' })],
        },
        { match: isTotalsQuery, rows: [{ total_items: '1', total_file_size: '0' }] },
        { match: isWatchedProbe, rows: [] },
      ]) as never
    );

    const response = await app.inject({
      method: 'GET',
      url: '/library/catalog?type=movie&sort=plays',
    });
    expect(response.statusCode).toBe(200);
    const row = response.json<CatalogResponse>().data[0]!;
    expect(row.plays).toBe(0);
    expect(row.watchedState).toBe('unwatched');
    const engagementCalls = dbExecute.mock.calls
      .map((call) => renderSql(call[0] as never))
      .filter(({ sql }) => isEngagement(normalize(sql)));
    expect(engagementCalls).toHaveLength(0);
  });

  it('reads the poster preference once per request and threads it into the page query', async () => {
    const preferredId = randomUUID();
    vi.mocked(getSetting).mockResolvedValue(preferredId);
    app = await buildTestApp(createOwnerUser());
    dbExecute.mockImplementation(
      dispatchBySql([
        { match: isTotalsQuery, rows: [{ total_items: '0', total_file_size: '0' }] },
      ]) as never
    );

    const response = await app.inject({ method: 'GET', url: '/library/catalog?type=movie' });
    expect(response.statusCode).toBe(200);
    expect(getSetting).toHaveBeenCalledWith('preferredPosterServerId');
    const pageCall = dbExecute.mock.calls
      .map((call) => renderSql(call[0] as never))
      .find(({ sql }) => isPageQuery(normalize(sql)));
    expect(pageCall!.params).toContain(preferredId);
  });

  it('single-flights two concurrent cold totals computes into one query', async () => {
    vi.useFakeTimers();
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    let resolveTotals!: (rows: { total_items: string; total_file_size: string }[]) => void;
    const totalsPromise = new Promise<{ total_items: string; total_file_size: string }[]>(
      (resolve) => {
        resolveTotals = resolve;
      }
    );
    let totalsCallCount = 0;

    dbExecute.mockImplementation(((query: unknown) => {
      const { sql } = renderSql(query as never);
      const text = normalize(sql);
      if (isTotalsQuery(text)) {
        totalsCallCount++;
        return totalsPromise.then((rows) => ({ rows }));
      }
      if (isPageQuery(text)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    }) as never);

    const first = app.inject({ method: 'GET', url: '/library/catalog?type=movie' });
    const second = app.inject({ method: 'GET', url: '/library/catalog?type=movie' });

    // Let both requests reach the lock race, then let the winner's compute finish.
    await vi.advanceTimersByTimeAsync(0);
    resolveTotals([{ total_items: '5', total_file_size: '0' }]);
    // The loser polls the cache every 500ms once it loses the lock race.
    await vi.advanceTimersByTimeAsync(500);

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(firstResponse.json<CatalogResponse>().meta.totalItems).toBe(5);
    expect(secondResponse.json<CatalogResponse>().meta.totalItems).toBe(5);
    // Only the lock winner ran the totals query.
    expect(totalsCallCount).toBe(1);
    expect(redis.set).toHaveBeenCalledTimes(2);
  });

  describe('watched filter', () => {
    it('slices the filtered candidate list, hydrates the window, and reports the filtered total', async () => {
      const redis = createSpyRedis();
      app = await buildTestApp(createOwnerUser(), redis);
      const keptId = randomUUID();
      const droppedId = randomUUID();

      dbExecute.mockImplementation(((query: unknown) => {
        const { sql } = renderSql(query as never);
        const text = normalize(sql);
        if (isCandidates(text)) {
          return Promise.resolve({
            rows: [
              { id: keptId, letter: 'D' },
              { id: droppedId, letter: 'M' },
            ],
          });
        }
        if (isWatchedProbe(text)) {
          // Only keptId has fully-watched plays; droppedId is partial.
          return Promise.resolve({
            rows: [
              { canonical_id: keptId, watched: true, has_plays: true },
              { canonical_id: droppedId, watched: false, has_plays: true },
            ],
          });
        }
        if (isFileSize(text)) return Promise.resolve({ rows: [{ total: '123' }] });
        if (isPageQuery(text)) {
          return Promise.resolve({ rows: [rawMovieRow({ id: keptId })] });
        }
        if (isAliasExpansion(text)) {
          return Promise.resolve({ rows: [{ id: keptId }] });
        }
        if (isEngagement(text)) {
          return Promise.resolve({ rows: [{ canonical_id: keptId, plays: '2', viewers: '1' }] });
        }
        return Promise.resolve({ rows: [] });
      }) as never);

      const response = await app.inject({
        method: 'GET',
        url: '/library/catalog?type=movie&watched=watched',
      });
      expect(response.statusCode).toBe(200);
      const body: CatalogResponse = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.mediaId).toBe(keptId);
      expect(body.data[0]!.watchedState).toBe('watched');
      expect(body.meta.totalItems).toBe(1);
      expect(body.meta.totalFileSize).toBe(123);
      // The filtered candidate list is cached for the letters endpoint and
      // subsequent windows.
      expect(redis.setex).toHaveBeenCalledTimes(1);
    });

    it('serves a later window from the cached candidate list without re-probing', async () => {
      const redis = createSpyRedis();
      app = await buildTestApp(createOwnerUser(), redis);
      const ids = [randomUUID(), randomUUID(), randomUUID()];

      dbExecute.mockImplementation(((query: unknown) => {
        const { sql } = renderSql(query as never);
        const text = normalize(sql);
        if (isCandidates(text)) {
          return Promise.resolve({ rows: ids.map((id) => ({ id, letter: 'A' })) });
        }
        if (isWatchedProbe(text)) {
          return Promise.resolve({
            rows: ids.map((id) => ({ canonical_id: id, watched: true, has_plays: true })),
          });
        }
        if (isFileSize(text)) return Promise.resolve({ rows: [{ total: '0' }] });
        if (isPageQuery(text)) {
          return Promise.resolve({ rows: [rawMovieRow({ id: ids[2] })] });
        }
        return Promise.resolve({ rows: [] });
      }) as never);

      const first = await app.inject({
        method: 'GET',
        url: '/library/catalog?type=movie&watched=watched&pageSize=2',
      });
      expect(first.statusCode).toBe(200);
      const candidateCalls = () =>
        dbExecute.mock.calls
          .map((call) => renderSql(call[0] as never))
          .filter(({ sql }) => isCandidates(normalize(sql))).length;
      expect(candidateCalls()).toBe(1);

      const second = await app.inject({
        method: 'GET',
        url: '/library/catalog?type=movie&watched=watched&pageSize=2&offset=2',
      });
      expect(second.statusCode).toBe(200);
      const body: CatalogResponse = second.json();
      expect(body.meta.totalItems).toBe(3);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.mediaId).toBe(ids[2]);
      expect(candidateCalls()).toBe(1);
    });

    it('single-flights two concurrent cold requests into one candidates compute', async () => {
      vi.useFakeTimers();
      const redis = createSpyRedis();
      app = await buildTestApp(createOwnerUser(), redis);
      const movieId = randomUUID();

      let resolveCandidates!: (rows: { id: string; letter: string }[]) => void;
      const candidatesPromise = new Promise<{ id: string; letter: string }[]>((resolve) => {
        resolveCandidates = resolve;
      });
      let candidateCallCount = 0;

      dbExecute.mockImplementation(((query: unknown) => {
        const { sql } = renderSql(query as never);
        const text = normalize(sql);
        if (isCandidates(text)) {
          candidateCallCount++;
          return candidatesPromise.then((rows) => ({ rows }));
        }
        if (isWatchedProbe(text)) {
          return Promise.resolve({
            rows: [{ canonical_id: movieId, watched: true, has_plays: true }],
          });
        }
        if (isFileSize(text)) return Promise.resolve({ rows: [{ total: '0' }] });
        if (isPageQuery(text)) return Promise.resolve({ rows: [rawMovieRow({ id: movieId })] });
        return Promise.resolve({ rows: [] });
      }) as never);

      const first = app.inject({
        method: 'GET',
        url: '/library/catalog?type=movie&watched=watched',
      });
      const second = app.inject({
        method: 'GET',
        url: '/library/catalog?type=movie&watched=watched',
      });

      // Let both requests reach the lock race, then let the winner's compute finish.
      await vi.advanceTimersByTimeAsync(0);
      resolveCandidates([{ id: movieId, letter: 'D' }]);
      // The loser polls the cache every 500ms once it loses the lock race.
      await vi.advanceTimersByTimeAsync(500);

      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.statusCode).toBe(200);
      expect(secondResponse.statusCode).toBe(200);
      expect(firstResponse.json<CatalogResponse>().meta.totalItems).toBe(1);
      expect(secondResponse.json<CatalogResponse>().meta.totalItems).toBe(1);
      // Only the lock winner ran the candidates query.
      expect(candidateCallCount).toBe(1);
      expect(redis.set).toHaveBeenCalledTimes(2);
    });
  });
});

describe('GET /library/catalog/letters', () => {
  let app: FastifyInstance;
  const dbExecute = vi.mocked(db.execute);

  beforeEach(() => {
    dbExecute.mockReset();
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('rejects a request missing the required type param', async () => {
    app = await buildTestApp(createOwnerUser());
    const response = await app.inject({ method: 'GET', url: '/library/catalog/letters' });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('a non-title sort returns an empty bucket set with no DB hit', async () => {
    app = await buildTestApp(createOwnerUser());
    const response = await app.inject({
      method: 'GET',
      url: '/library/catalog/letters?type=movie&sort=added',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<CatalogLettersResponse>().letters).toEqual([]);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('returns SQL-grouped bucket counts and caches the response', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    dbExecute.mockImplementation(
      dispatchBySql([
        {
          match: isLetterCounts,
          rows: [
            { letter: '#', count: 2 },
            { letter: 'D', count: 5 },
          ],
        },
      ]) as never
    );

    const first = await app.inject({ method: 'GET', url: '/library/catalog/letters?type=movie' });
    expect(first.statusCode).toBe(200);
    const letters = first.json<CatalogLettersResponse>().letters;
    expect(letters).toHaveLength(27);
    expect(letters[0]).toEqual({ letter: '#', count: 2 });
    expect(letters.find((b) => b.letter === 'D')).toEqual({ letter: 'D', count: 5 });
    expect(letters.find((b) => b.letter === 'A')).toEqual({ letter: 'A', count: 0 });

    const second = await app.inject({ method: 'GET', url: '/library/catalog/letters?type=movie' });
    expect(second.statusCode).toBe(200);
    expect(second.json<CatalogLettersResponse>().letters).toEqual(letters);
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it('with a watched filter, buckets the shared candidate list the catalog windows slice', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const ids = [randomUUID(), randomUUID()];

    dbExecute.mockImplementation(((query: unknown) => {
      const { sql } = renderSql(query as never);
      const text = normalize(sql);
      if (isCandidates(text)) {
        return Promise.resolve({
          rows: [
            { id: ids[0], letter: 'B' },
            { id: ids[1], letter: 'B' },
          ],
        });
      }
      if (isWatchedProbe(text)) {
        return Promise.resolve({
          rows: [
            { canonical_id: ids[0], watched: true, has_plays: true },
            { canonical_id: ids[1], watched: false, has_plays: false },
          ],
        });
      }
      if (isFileSize(text)) return Promise.resolve({ rows: [{ total: '0' }] });
      if (isPageQuery(text)) return Promise.resolve({ rows: [rawMovieRow({ id: ids[0] })] });
      return Promise.resolve({ rows: [] });
    }) as never);

    // Catalog first: computes and caches the filtered candidate list.
    const catalogResponse = await app.inject({
      method: 'GET',
      url: '/library/catalog?type=movie&watched=watched',
    });
    expect(catalogResponse.statusCode).toBe(200);
    expect(catalogResponse.json<CatalogResponse>().meta.totalItems).toBe(1);
    const candidateCalls = () =>
      dbExecute.mock.calls
        .map((call) => renderSql(call[0] as never))
        .filter(({ sql }) => isCandidates(normalize(sql))).length;
    expect(candidateCalls()).toBe(1);

    // Letters reuses the exact cached list - no second candidates query, and
    // the bucket counts reflect the same filtered rows the windows slice.
    const lettersResponse = await app.inject({
      method: 'GET',
      url: '/library/catalog/letters?type=movie&watched=watched',
    });
    expect(lettersResponse.statusCode).toBe(200);
    const letters = lettersResponse.json<CatalogLettersResponse>().letters;
    expect(letters.find((b) => b.letter === 'B')).toEqual({ letter: 'B', count: 1 });
    expect(letters.reduce((sum, b) => sum + b.count, 0)).toBe(1);
    expect(candidateCalls()).toBe(1);
  });
});
