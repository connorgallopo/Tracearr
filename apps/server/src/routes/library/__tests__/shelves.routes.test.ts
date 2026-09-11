/**
 * Library command center route tests
 *
 * db.execute is mocked (this suite's convention, see catalog.routes.test.ts),
 * so these prove handler mechanics, response shape, and the versioned cache
 * contract - not SQL correctness. Real-DB query correctness (window
 * parameterization, type-split shelves, KPI math, dead-weight ordering) lives
 * in apps/server/test/integration/shelves.integration.test.ts.
 *
 * computeShelves fires its independent aggregate queries via Promise.all (two
 * batches), so db.execute call ORDER is no longer a stable contract - route
 * tests dispatch by rendered SQL content (and, for the one pair of
 * structurally-identical detail queries, by which id literal appears in the
 * text) rather than by call sequence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, ShelvesResponse } from '@tracearr/shared';
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
import { libraryShelvesRoute } from '../shelves.js';

function normalize(sqlText: string): string {
  return sqlText.replace(/\s+/g, ' ').trim();
}

function renderQuery(query: unknown): { text: string } {
  const { sql } = renderSql(query as never);
  return { text: normalize(sql) };
}

function createSpyRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    // Minimal SET NX EX mock: only the args the lock helper actually sends.
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
  };
}

async function buildTestApp(
  authUser: AuthUser,
  redis: ReturnType<typeof createSpyRedis>
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('redis', redis as never);
  await app.register(libraryShelvesRoute, { prefix: '/library' });
  return app;
}

function createOwnerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

function rawShelfRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: (overrides.id as string) ?? randomUUID(),
    media_type: overrides.media_type ?? 'movie',
    title: overrides.title ?? 'Dune',
    year: overrides.year ?? 2021,
    genres: overrides.genres ?? [],
    normalized_title: overrides.normalized_title ?? 'dune',
    latest_added_at: overrides.latest_added_at ?? new Date('2024-01-01').toISOString(),
    servers: overrides.servers ?? [],
    poster_copy: overrides.poster_copy ?? null,
    ...overrides,
  };
}

/** Every compute query resolves to an empty result set, regardless of which
 * one fires or in what order - safe for the concurrent Promise.all batches,
 * since every consumer in computeShelves defaults an empty/undefined row. */
function mockEmptyCompute() {
  vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
}

const isRecentlyAddedMovies = (text: string) => text.includes('WITH page AS');
const isRecentlyAddedShows = (text: string) => text.includes('added_episodes AS');
const isMostPopularCandidates = (text: string) =>
  text.includes('ORDER BY plays DESC, viewers DESC, watch_time_ms DESC');
const isMovieGuard = (text: string) => text.includes("am.media_type = 'movie'");
const isShowGuard = (text: string) => text.includes('p.show_media_id IS NOT NULL');
const isDetailQuery = (text: string) =>
  text.includes('m.id = ANY(') && text.includes('AND EXISTS (');
const isDeadWeightCandidates = (text: string) => text.includes('NOT EXISTS (');
const isNewlyAdded = (text: string) => text.includes('added_in_window AS');
const isWatchedAggregate = (text: string) =>
  text.includes('value_rollup') && text.includes('titles_touched');
const isMeta = (text: string) => text.includes("COUNT(*) FILTER (WHERE m.media_type = 'movie')");
const isEpisodeCounts = (text: string) => text.includes('episode_count');
const isMovieWatchedProbe = (text: string) =>
  text.includes('alias_map') && text.includes('BOOL_OR');
const isShowWatchedProbe = (text: string) => text.includes('eps_watched');

describe('GET /library/shelves', () => {
  let app: FastifyInstance;
  const dbExecute = vi.mocked(db.execute);

  beforeEach(() => {
    dbExecute.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
    vi.useRealTimers();
  });

  it('returns an empty shape when nothing is in the library (per-shelf independence)', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    mockEmptyCompute();

    const response = await app.inject({ method: 'GET', url: '/library/shelves' });
    expect(response.statusCode).toBe(200);
    const body: ShelvesResponse = response.json();
    expect(body).toEqual({
      period: 'month',
      recentlyAddedMovies: [],
      recentlyAddedShows: [],
      mostPopularMovies: [],
      mostPopularShows: [],
      deadWeight: [],
      kpis: {
        watchedInPeriod: { titlesTouched: 0, totalTitles: 0 },
        hoursWatched: 0,
        newlyAdded: { count: 0, totalBytes: 0, playedCount: 0 },
        deadWeight: { count: 0, totalBytes: 0 },
      },
      meta: { movies: 0, shows: 0, totalFileSize: 0 },
    });
    expect(dbExecute).toHaveBeenCalledTimes(10);
  });

  it('includeDeadWeight=false skips the dead-weight compute and omits it from the response', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    mockEmptyCompute();

    const response = await app.inject({
      method: 'GET',
      url: '/library/shelves?includeDeadWeight=false',
    });
    expect(response.statusCode).toBe(200);
    const body: ShelvesResponse = response.json();
    expect(body.deadWeight).toBeUndefined();
    expect(body.kpis.deadWeight).toBeUndefined();
    // Two fewer queries than the default (movie + show dead-weight candidates skipped).
    expect(dbExecute).toHaveBeenCalledTimes(8);
  });

  it('includeDeadWeight=false does not reuse (or pollute) the default request cache entry', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    mockEmptyCompute();

    await app.inject({ method: 'GET', url: '/library/shelves' });
    expect(dbExecute).toHaveBeenCalledTimes(10);

    dbExecute.mockClear();
    const withoutDeadWeight = await app.inject({
      method: 'GET',
      url: '/library/shelves?includeDeadWeight=false',
    });
    expect(withoutDeadWeight.statusCode).toBe(200);
    // Distinct cache key -> full recompute, not a hit off the default entry.
    expect(dbExecute).toHaveBeenCalledTimes(8);
    expect(redis.setex).toHaveBeenCalledTimes(2);
  });

  it('the recently-added-shows query counts distinct, window-filtered episodes rather than every active copy', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    let recentlyAddedShowsSql = '';
    dbExecute.mockImplementation(((query: unknown) => {
      const { text } = renderQuery(query);
      if (isRecentlyAddedShows(text)) recentlyAddedShowsSql = text;
      return Promise.resolve({ rows: [] });
    }) as never);

    const response = await app.inject({ method: 'GET', url: '/library/shelves' });
    expect(response.statusCode).toBe(200);
    expect(recentlyAddedShowsSql).toContain('COUNT(DISTINCT e.id) FILTER (WHERE');
    expect(recentlyAddedShowsSql).not.toContain('COUNT(*)::int AS new_episodes');
  });

  it('shapes a populated response: type-split shelves, watched overlay, kpis', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const movieId = randomUUID();
    const showId = randomUUID();

    dbExecute.mockImplementation(((query: unknown) => {
      const { text } = renderQuery(query);

      if (isRecentlyAddedMovies(text)) {
        return Promise.resolve({ rows: [rawShelfRow({ id: movieId, media_type: 'movie' })] });
      }
      if (isRecentlyAddedShows(text)) {
        return Promise.resolve({
          rows: [rawShelfRow({ id: showId, media_type: 'show', new_episodes: 3 })],
        });
      }
      if (isMostPopularCandidates(text) && isMovieGuard(text)) {
        return Promise.resolve({ rows: [{ canonical_id: movieId, plays: '5', viewers: '2' }] });
      }
      if (isMostPopularCandidates(text) && isShowGuard(text)) {
        return Promise.resolve({ rows: [{ canonical_id: showId, plays: '9', viewers: '4' }] });
      }
      if (isDetailQuery(text)) {
        if (text.includes(movieId)) {
          return Promise.resolve({ rows: [rawShelfRow({ id: movieId, media_type: 'movie' })] });
        }
        if (text.includes(showId)) {
          return Promise.resolve({ rows: [rawShelfRow({ id: showId, media_type: 'show' })] });
        }
        return Promise.resolve({ rows: [] });
      }
      if (isDeadWeightCandidates(text)) {
        return Promise.resolve({ rows: [] });
      }
      if (isNewlyAdded(text)) {
        return Promise.resolve({ rows: [{ count: '1', total_bytes: '1000', played_count: '1' }] });
      }
      if (isWatchedAggregate(text) && isMovieGuard(text)) {
        return Promise.resolve({ rows: [{ titles_touched: '1', watched_ms: '300000' }] });
      }
      if (isWatchedAggregate(text) && isShowGuard(text)) {
        return Promise.resolve({ rows: [{ titles_touched: '1', watched_ms: '600000' }] });
      }
      if (isMeta(text)) {
        return Promise.resolve({ rows: [{ movies: '5', shows: '2', total_file_size: '1000' }] });
      }
      if (isEpisodeCounts(text)) {
        return Promise.resolve({ rows: [{ show_id: showId, episode_count: 5 }] });
      }
      if (isMovieWatchedProbe(text)) {
        return Promise.resolve({
          rows: [{ canonical_id: movieId, watched: true, has_plays: true }],
        });
      }
      if (isShowWatchedProbe(text)) {
        return Promise.resolve({
          rows: [{ canonical_id: showId, eps_watched: 3, has_plays: true }],
        });
      }
      return Promise.resolve({ rows: [] });
    }) as never);

    const response = await app.inject({ method: 'GET', url: '/library/shelves' });
    expect(response.statusCode).toBe(200);
    const body: ShelvesResponse = response.json();

    expect(body.period).toBe('month');
    expect(body.recentlyAddedMovies.map((r) => r.mediaId)).toEqual([movieId]);
    expect(body.recentlyAddedShows.map((r) => r.mediaId)).toEqual([showId]);
    expect(body.recentlyAddedShows[0]!.newEpisodes).toBe(3);
    expect(body.mostPopularMovies).toEqual([
      expect.objectContaining({
        mediaId: movieId,
        plays: 5,
        viewers: 2,
        rank: 1,
        watchedState: 'watched',
      }),
    ]);
    expect(body.mostPopularShows).toEqual([
      expect.objectContaining({
        mediaId: showId,
        plays: 9,
        viewers: 4,
        rank: 1,
        watchedState: 'partial',
      }),
    ]);
    expect(body.deadWeight).toEqual([]);
    expect(body.kpis).toEqual({
      watchedInPeriod: { titlesTouched: 2, totalTitles: 7 },
      hoursWatched: 900,
      newlyAdded: { count: 1, totalBytes: 1000, playedCount: 1 },
      deadWeight: { count: 0, totalBytes: 0 },
    });
    expect(body.meta).toEqual({ movies: 5, shows: 2, totalFileSize: 1000 });
  });

  it('numbers popular ranks after dropping candidates with no active copy', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const goneId = randomUUID();
    const movieId = randomUUID();

    dbExecute.mockImplementation(((query: unknown) => {
      const { text } = renderQuery(query);
      if (isMostPopularCandidates(text) && isMovieGuard(text)) {
        return Promise.resolve({
          rows: [
            { canonical_id: goneId, plays: '9', viewers: '3' },
            { canonical_id: movieId, plays: '5', viewers: '2' },
          ],
        });
      }
      if (isDetailQuery(text) && text.includes(movieId)) {
        return Promise.resolve({ rows: [rawShelfRow({ id: movieId, media_type: 'movie' })] });
      }
      return Promise.resolve({ rows: [] });
    }) as never);

    const response = await app.inject({ method: 'GET', url: '/library/shelves' });
    expect(response.statusCode).toBe(200);
    const body: ShelvesResponse = response.json();

    expect(body.mostPopularMovies.map((row) => [row.mediaId, row.rank])).toEqual([[movieId, 1]]);
  });

  it('caches the computed response per (scope, period) and serves it back verbatim on a hit', async () => {
    const redis = createSpyRedis();
    const owner = createOwnerUser();
    app = await buildTestApp(owner, redis);
    mockEmptyCompute();

    const first = await app.inject({ method: 'GET', url: '/library/shelves?period=week' });
    expect(first.statusCode).toBe(200);
    expect(dbExecute).toHaveBeenCalledTimes(10);
    expect(redis.setex).toHaveBeenCalledTimes(1);

    dbExecute.mockClear();
    const second = await app.inject({ method: 'GET', url: '/library/shelves?period=week' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // Cache hit: no recompute at all.
    expect(dbExecute).not.toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  it('scopes the cache key by period: a different period never reuses another periods cache entry', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    mockEmptyCompute();
    await app.inject({ method: 'GET', url: '/library/shelves?period=week' });
    expect(dbExecute).toHaveBeenCalledTimes(10);

    dbExecute.mockClear();
    const response = await app.inject({ method: 'GET', url: '/library/shelves?period=year' });
    expect(response.statusCode).toBe(200);
    // Different cache key -> full recompute, not a hit off the week entry.
    expect(dbExecute).toHaveBeenCalledTimes(10);
    expect(redis.setex).toHaveBeenCalledTimes(2);
  });

  it('ignores a v1-shaped cached payload under the legacy unversioned key', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    // Simulate a stale v1 entry sitting under the OLD (unversioned) cache key -
    // the v2 route must never read it, since v1 lacks kpis/deadWeight/period.
    await redis.setex(
      'tracearr:library:shelves:all:month',
      300,
      JSON.stringify({ recentlyAdded: [], mostWatched: [], neverWatched: [], meta: {} })
    );
    mockEmptyCompute();

    const response = await app.inject({ method: 'GET', url: '/library/shelves' });
    expect(response.statusCode).toBe(200);
    const body: ShelvesResponse = response.json();
    expect(body.kpis).toBeDefined();
    expect(body.period).toBe('month');
    // A full recompute happened - the v1 entry under the old key was never touched.
    expect(dbExecute).toHaveBeenCalledTimes(10);
  });

  it('reads the poster preference once per request and folds it into the cache key', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const getSettingMock = vi.mocked(getSetting);
    getSettingMock.mockClear();
    const preferredId = randomUUID();
    getSettingMock.mockResolvedValueOnce(preferredId);
    mockEmptyCompute();

    const response = await app.inject({ method: 'GET', url: '/library/shelves?period=week' });
    expect(response.statusCode).toBe(200);
    // Exactly once, not once per shelf/candidate query.
    expect(getSettingMock).toHaveBeenCalledTimes(1);
    expect(getSettingMock).toHaveBeenCalledWith('preferredPosterServerId');

    // A distinct preference value -> a distinct redis key, not a hit off the
    // "no preference" entry cached under the same (scope, period).
    dbExecute.mockClear();
    getSettingMock.mockResolvedValueOnce(null);
    mockEmptyCompute();
    await app.inject({ method: 'GET', url: '/library/shelves?period=week' });
    expect(dbExecute).toHaveBeenCalledTimes(10);
    expect(redis.setex).toHaveBeenCalledTimes(2);
  });

  it('rejects a custom period missing startDate/endDate', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    const response = await app.inject({
      method: 'GET',
      url: '/library/shelves?period=custom',
    });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('rejects a malformed period value', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    const response = await app.inject({
      method: 'GET',
      url: '/library/shelves?period=fortnight',
    });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  describe('single-flight compute lock', () => {
    it('the lock winner computes once while a concurrent request is served the cached result', async () => {
      vi.useFakeTimers();
      const redis = createSpyRedis();
      app = await buildTestApp(createOwnerUser(), redis);
      mockEmptyCompute();

      const first = app.inject({ method: 'GET', url: '/library/shelves' });
      const second = app.inject({ method: 'GET', url: '/library/shelves' });

      // Let both requests reach the lock race and let the winner's (instantly
      // resolving, mocked) compute finish and cache.
      await vi.advanceTimersByTimeAsync(0);
      // The loser is now polling every 500ms; one tick is enough to see the
      // winner's cached result.
      await vi.advanceTimersByTimeAsync(500);

      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect(firstResponse.statusCode).toBe(200);
      expect(secondResponse.statusCode).toBe(200);
      expect(secondResponse.json()).toEqual(firstResponse.json());
      // Only the lock winner ran computeShelves and wrote the cache.
      expect(redis.setex).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledTimes(2);
    });

    it('fails open and computes directly when the lock itself errors', async () => {
      const redis = createSpyRedis();
      redis.set.mockRejectedValueOnce(new Error('redis unavailable'));
      app = await buildTestApp(createOwnerUser(), redis);
      mockEmptyCompute();

      const response = await app.inject({ method: 'GET', url: '/library/shelves' });
      expect(response.statusCode).toBe(200);
      // Fail-open: computed directly instead of blocking on the broken lock.
      expect(dbExecute).toHaveBeenCalledTimes(10);
      expect(redis.setex).toHaveBeenCalledTimes(1);
    });

    it('fails open and computes directly when the wait for a concurrent winner times out', async () => {
      vi.useFakeTimers();
      const redis = createSpyRedis();
      // Lock always held by someone else, and the cache never fills - the
      // waiter must give up after ~15s rather than block forever.
      redis.set.mockResolvedValue(null);
      app = await buildTestApp(createOwnerUser(), redis);
      mockEmptyCompute();

      const pending = app.inject({ method: 'GET', url: '/library/shelves' });
      await vi.advanceTimersByTimeAsync(15_000);
      const response = await pending;

      expect(response.statusCode).toBe(200);
      expect(dbExecute).toHaveBeenCalledTimes(10);
    });
  });
});
