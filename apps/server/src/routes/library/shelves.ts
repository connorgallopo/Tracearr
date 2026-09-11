/**
 * Library command center endpoint
 *
 * GET /shelves - Windowed library overview for the Media landing page: four
 * type-split shelves (recently added / most popular, movies / shows), a KPI
 * strip (watched-in-period, hours watched, newly added, dead weight), and a
 * dead-weight module (top storage-reclaim candidates). All-users aggregate -
 * there is no per-viewer lens, so the whole response is cacheable verbatim
 * per (server scope, period).
 */

import type { FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import { sql, type SQL } from 'drizzle-orm';
import {
  shelvesQuerySchema,
  REDIS_KEYS,
  CACHE_TTL,
  POSTER_IMAGE_SIZE,
  type ShelfRow,
  type RecentlyAddedShelfRow,
  type MostPopularShelfRow,
  type DeadWeightRow,
  type ShelvesResponse,
  type WatchedState,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import {
  buildValueRollupCte,
  pickBestResolution,
  buildCatalogPageQuery,
  buildPosterOrderFragment,
} from './catalog.js';
import {
  fetchEpisodeCounts,
  resolveWatchedStates,
} from '../../services/library/mediaWatchedService.js';
import { buildProxyUrl, posterVersionFor } from '../../services/imageProxy.js';
import { getSetting } from '../../services/settings.js';
import { resolveDateRange, type DateRange } from '../stats/utils.js';
import { buildLibraryCacheKey, mediaSizeSubquery, withComputeSingleFlight } from './utils.js';

const SHELF_LIMIT = 20;
const DEAD_WEIGHT_LIMIT = 10;

interface RawShelfRow {
  id: string;
  media_type: 'movie' | 'show';
  title: string;
  year: number | null;
  genres: string[] | null;
  normalized_title: string | null;
  latest_added_at: string | null;
  servers:
    | {
        serverId: string;
        addedAt: string;
        videoResolution: string | null;
        fileSize: number | null;
        versionCount: number;
      }[]
    | null;
  poster_copy: { thumbPath: string | null; dominantColor: string | null; serverId: string } | null;
}

interface RawRecentlyAddedShowRow extends RawShelfRow {
  new_episodes: number;
  added_at: string;
}

/** ShelfRow minus watchedState: resolved once (all-users aggregate) and attached after fetch. */
type CachedShelfRow = Omit<ShelfRow, 'watchedState'>;

type CachedRecentlyAddedRow = CachedShelfRow & Pick<RecentlyAddedShelfRow, 'newEpisodes'>;
type CachedMostPopularRow = CachedShelfRow &
  Pick<MostPopularShelfRow, 'plays' | 'viewers' | 'rank'>;
type CachedDeadWeightRow = CachedShelfRow & Pick<DeadWeightRow, 'fileBytes' | 'addedAt'>;

function toShelfRowBase(row: RawShelfRow): CachedShelfRow {
  const servers = row.servers ?? [];
  const poster = row.poster_copy;
  const posterVersion = poster?.thumbPath ? posterVersionFor(poster.thumbPath) : null;
  const posterUrl =
    poster?.thumbPath && poster.serverId && posterVersion
      ? buildProxyUrl({
          serverId: poster.serverId,
          path: poster.thumbPath,
          ...POSTER_IMAGE_SIZE,
          version: posterVersion,
          fallback: 'poster',
        })
      : null;

  return {
    mediaId: row.id,
    mediaType: row.media_type,
    title: row.title,
    year: row.year,
    genres: row.genres ?? [],
    posterUrl,
    posterVersion,
    dominantColor: poster?.dominantColor ?? null,
    servers,
    resolutionBest: pickBestResolution(servers),
  };
}

/** Newest active copy per canonical movie, latest-added-first. */
async function fetchRecentlyAddedMovies(
  serverIds: string[] | undefined,
  preferredPosterServerId: string | null
): Promise<CachedRecentlyAddedRow[]> {
  const movieQuery = buildCatalogPageQuery({
    type: 'movie',
    sort: 'added',
    offset: 0,
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
    serverIds,
    pageSize: SHELF_LIMIT,
    preferredPosterServerId,
  });
  const movieResult = await db.execute(movieQuery);
  return (movieResult.rows as unknown as RawShelfRow[]).slice(0, SHELF_LIMIT).map((row) => ({
    ...toShelfRowBase(row),
    newEpisodes: null,
  }));
}

/**
 * Shows whose newly-tracked episodes group under the show's own card
 * (newEpisodes chip), latest-episode-added-first. The card itself always
 * ranks by each show's own most-recent episode add (unbounded, so the shelf
 * keeps showing its top SHELF_LIMIT regardless of the request's period), but
 * the "N new" count is scoped to the request's dateRange - otherwise a show
 * that has aired for years reports every active episode it has ever had as
 * "new" the moment any one of them is added.
 */
async function fetchRecentlyAddedShows(
  serverIds: string[] | undefined,
  dateRange: DateRange,
  preferredPosterServerId: string | null
): Promise<CachedRecentlyAddedRow[]> {
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  const posterOrderFragment = buildPosterOrderFragment(preferredPosterServerId);
  const newEpisodeWindow = buildTimestampWindowCondition(sql`li.created_at`, dateRange);
  const showResult = await db.execute(sql`
    WITH added_episodes AS (
      SELECT e.show_media_id AS show_id,
             COUNT(DISTINCT e.id) FILTER (WHERE ${newEpisodeWindow})::int AS new_episodes,
             MAX(li.created_at) AS added_at
      FROM library_items li
      JOIN media e ON e.id = li.media_id
      WHERE li.removed_at IS NULL AND e.media_type = 'episode' AND e.show_media_id IS NOT NULL
        ${serverFragmentLi}
      GROUP BY e.show_media_id
    )
    SELECT m.id, m.media_type, m.title, m.year, m.genres, m.normalized_title, m.latest_added_at,
           ae.new_episodes, ae.added_at,
      (SELECT json_agg(json_build_object(
          'serverId', li.server_id, 'addedAt', li.created_at,
          'videoResolution', li.video_resolution, 'fileSize', li.file_size,
          'versionCount', li.version_count)
          ORDER BY li.created_at DESC)
       FROM library_items li
       WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}) AS servers,
      (SELECT json_build_object('thumbPath', li.thumb_path, 'dominantColor', li.dominant_color,
                                'serverId', li.server_id)
       FROM library_items li
       WHERE li.media_id = m.id AND li.removed_at IS NULL AND li.thumb_path IS NOT NULL ${serverFragmentLi}
       ${posterOrderFragment} LIMIT 1) AS poster_copy
    FROM added_episodes ae
    JOIN media m ON m.id = ae.show_id AND m.merged_into_id IS NULL
    ORDER BY ae.added_at DESC
    LIMIT ${SHELF_LIMIT}
  `);
  return (showResult.rows as unknown as RawRecentlyAddedShowRow[]).map((row) => ({
    ...toShelfRowBase(row),
    newEpisodes: row.new_episodes,
  }));
}

interface ValueCandidate {
  canonical_id: string;
  plays: string | number;
  viewers: string | number;
}

/**
 * Top-SHELF_LIMIT canonical titles of one type by plays within the window,
 * tiebreak viewers desc then watch_time desc. Candidates come from the
 * windowed value_rollup CTE first, then a single detail lookup batches the
 * display fields for just those candidates (mirrors the catalog page-query
 * candidate/detail split). Ranks are numbered after the detail lookup, which
 * drops candidates with no active library copy.
 */
async function fetchMostPopular(
  type: 'movie' | 'show',
  serverIds: string[] | undefined,
  dateRange: DateRange,
  preferredPosterServerId: string | null
): Promise<CachedMostPopularRow[]> {
  const cte = buildValueRollupCte(type, serverIds, undefined, dateRange);
  const rows = await db.execute(sql`
    WITH ${cte}
    SELECT canonical_id, plays, viewers FROM value_rollup
    WHERE plays > 0
    ORDER BY plays DESC, viewers DESC, watch_time_ms DESC
    LIMIT ${SHELF_LIMIT}
  `);
  const candidates = (rows.rows as unknown as ValueCandidate[]).map((row) => ({
    canonicalId: row.canonical_id,
    plays: Number(row.plays),
    viewers: Number(row.viewers),
  }));
  if (candidates.length === 0) return [];

  const ids = candidates.map((c) => c.canonicalId);
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  const posterOrderFragment = buildPosterOrderFragment(preferredPosterServerId);
  const detailResult = await db.execute(sql`
    SELECT m.id, m.media_type, m.title, m.year, m.genres, m.normalized_title, m.latest_added_at,
      (SELECT json_agg(json_build_object(
          'serverId', li.server_id, 'addedAt', li.created_at,
          'videoResolution', li.video_resolution, 'fileSize', li.file_size,
          'versionCount', li.version_count)
          ORDER BY li.created_at DESC)
       FROM library_items li
       WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}) AS servers,
      (SELECT json_build_object('thumbPath', li.thumb_path, 'dominantColor', li.dominant_color,
                                'serverId', li.server_id)
       FROM library_items li
       WHERE li.media_id = m.id AND li.removed_at IS NULL AND li.thumb_path IS NOT NULL ${serverFragmentLi}
       ${posterOrderFragment} LIMIT 1) AS poster_copy
    FROM media m
    WHERE m.id = ANY(${uuidArraySql(ids)}) AND m.merged_into_id IS NULL
      ${buildActiveItemFragment(sql`m.id`, serverIds)}
  `);
  const detailById = new Map(
    (detailResult.rows as unknown as RawShelfRow[]).map((row) => [row.id, row])
  );

  const result: CachedMostPopularRow[] = [];
  for (const candidate of candidates) {
    const detail = detailById.get(candidate.canonicalId);
    if (!detail) continue;
    result.push({
      ...toShelfRowBase(detail),
      plays: candidate.plays,
      viewers: candidate.viewers,
      rank: result.length + 1,
    });
  }
  return result;
}

interface DeadWeightCandidate {
  canonicalId: string;
  totalFileSize: number;
}

/**
 * ALL never-watched canonical titles of one type (no LIMIT - the caller needs
 * an exact all-time count/size total, not just the display page), alias-aware
 * (a merged loser's plays exclude the canonical row) and, for shows,
 * episode-aware. No poster/servers lookup here - that's deferred to the
 * detail query for only the top DEAD_WEIGHT_LIMIT candidates, so this stays
 * one correlated subquery (file size) per row instead of three.
 */
async function fetchDeadWeightCandidatesForType(
  type: 'movie' | 'show',
  serverIds: string[] | undefined
): Promise<DeadWeightCandidate[]> {
  const mediaCol = type === 'movie' ? sql`media_id` : sql`show_media_id`;
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  const serverFragmentLi2 = buildMultiServerFragment(serverIds, 'li2.server_id');
  const serverFragmentSelf = buildMultiServerFragment(serverIds, 'p.server_id');
  const serverFragmentLoser = buildMultiServerFragment(serverIds, 'p2.server_id');
  const result = await db.execute(sql`
    SELECT m.id AS canonical_id,
      ${mediaSizeSubquery(sql`m.id`, serverFragmentLi2)} AS total_file_size
    FROM media m
    WHERE m.merged_into_id IS NULL
      AND m.media_type = ${type}
      AND EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_media_plays_daily p WHERE p.${mediaCol} = m.id ${serverFragmentSelf}
        UNION ALL
        SELECT 1 FROM media loser
        JOIN user_media_plays_daily p2 ON p2.${mediaCol} = loser.id
        WHERE loser.merged_into_id = m.id ${serverFragmentLoser}
      )
  `);
  return (result.rows as { canonical_id: string; total_file_size: string | number }[]).map(
    (row) => ({
      canonicalId: row.canonical_id,
      totalFileSize: Number(row.total_file_size),
    })
  );
}

interface DeadWeightResult {
  rows: CachedDeadWeightRow[];
  count: number;
  totalBytes: number;
}

/**
 * Combines both types' never-watched candidates for the all-time count/size
 * totals (kpis.deadWeight), then fetches full display detail for only the
 * top DEAD_WEIGHT_LIMIT by size (the dead-weight module itself).
 */
async function fetchDeadWeight(
  serverIds: string[] | undefined,
  preferredPosterServerId: string | null
): Promise<DeadWeightResult> {
  const movies = await fetchDeadWeightCandidatesForType('movie', serverIds);
  const shows = await fetchDeadWeightCandidatesForType('show', serverIds);
  const all = [...movies, ...shows];
  const count = all.length;
  const totalBytes = all.reduce((sum, c) => sum + c.totalFileSize, 0);

  const top = [...all]
    .sort((a, b) => b.totalFileSize - a.totalFileSize)
    .slice(0, DEAD_WEIGHT_LIMIT);
  if (top.length === 0) return { rows: [], count, totalBytes };

  const sizeById = new Map(top.map((c) => [c.canonicalId, c.totalFileSize]));
  const ids = top.map((c) => c.canonicalId);
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  const posterOrderFragment = buildPosterOrderFragment(preferredPosterServerId);
  const detailResult = await db.execute(sql`
    SELECT m.id, m.media_type, m.title, m.year, m.genres, m.normalized_title, m.latest_added_at,
      (SELECT json_agg(json_build_object(
          'serverId', li.server_id, 'addedAt', li.created_at,
          'videoResolution', li.video_resolution, 'fileSize', li.file_size,
          'versionCount', li.version_count)
          ORDER BY li.created_at DESC)
       FROM library_items li
       WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}) AS servers,
      (SELECT json_build_object('thumbPath', li.thumb_path, 'dominantColor', li.dominant_color,
                                'serverId', li.server_id)
       FROM library_items li
       WHERE li.media_id = m.id AND li.removed_at IS NULL AND li.thumb_path IS NOT NULL ${serverFragmentLi}
       ${posterOrderFragment} LIMIT 1) AS poster_copy
    FROM media m
    WHERE m.id = ANY(${uuidArraySql(ids)}) AND m.merged_into_id IS NULL
  `);
  const detailById = new Map(
    (detailResult.rows as unknown as RawShelfRow[]).map((row) => [row.id, row])
  );

  const rows: CachedDeadWeightRow[] = [];
  for (const candidate of top) {
    const detail = detailById.get(candidate.canonicalId);
    if (!detail) continue;
    rows.push({
      ...toShelfRowBase(detail),
      fileBytes: sizeById.get(candidate.canonicalId) ?? 0,
      addedAt: detail.latest_added_at ? new Date(detail.latest_added_at).toISOString() : null,
    });
  }
  return { rows, count, totalBytes };
}

/** Timestamp-column window predicate for KPI queries outside the plays cagg. */
function buildTimestampWindowFragment(column: SQL, dateRange: DateRange): SQL {
  if (!dateRange.start) return sql``;
  return sql`AND ${column} >= ${dateRange.start} AND ${column} < ${dateRange.end}`;
}

/** Bare boolean (no leading AND) mirror of buildTimestampWindowFragment, for
 * a FILTER (WHERE ...) clause rather than a WHERE/JOIN predicate. */
function buildTimestampWindowCondition(column: SQL, dateRange: DateRange): SQL {
  if (!dateRange.start) return sql`true`;
  return sql`${column} >= ${dateRange.start} AND ${column} < ${dateRange.end}`;
}

/**
 * EXISTS predicate requiring an active (non-removed) library_items row for a
 * canonical id, scoped to serverIds - the same active-item gate fetchMeta and
 * the dead-weight candidates already apply. Reused wherever a plays-derived
 * result set needs to stay a subset of the active-item population (mostPopular
 * detail, titlesTouched), so a title removed from the library can't inflate
 * either past totalTitles.
 */
function buildActiveItemFragment(idColumn: SQL, serverIds: string[] | undefined): SQL {
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  return sql`AND EXISTS (
    SELECT 1 FROM library_items li WHERE li.media_id = ${idColumn} AND li.removed_at IS NULL ${serverFragmentLi}
  )`;
}

interface WatchedAggregate {
  titlesTouched: number;
  watchedMs: number;
}

/**
 * kpis.watchedInPeriod.titlesTouched and kpis.hoursWatched: distinct canonical
 * titles (movies + shows) with >=1 play in the window, and total watched_ms
 * across the window (not gated on plays>0 - a session can register watched
 * time via a "continued" row without counting as a fresh play). titlesTouched
 * additionally requires an active library_items row, matching totalTitles'
 * gate (fetchMeta), so a title removed from the library can't push the
 * numerator past the denominator.
 */
async function fetchWatchedAggregate(
  serverIds: string[] | undefined,
  dateRange: DateRange
): Promise<WatchedAggregate> {
  const movieCte = buildValueRollupCte('movie', serverIds, undefined, dateRange);
  const showCte = buildValueRollupCte('show', serverIds, undefined, dateRange);
  const activeItemFragment = buildActiveItemFragment(sql`value_rollup.canonical_id`, serverIds);
  const movieAgg = await db.execute(sql`
    WITH ${movieCte}
    SELECT COUNT(*) FILTER (WHERE plays > 0 ${activeItemFragment})::bigint AS titles_touched,
           COALESCE(SUM(watch_time_ms), 0)::bigint AS watched_ms
    FROM value_rollup
  `);
  const showAgg = await db.execute(sql`
    WITH ${showCte}
    SELECT COUNT(*) FILTER (WHERE plays > 0 ${activeItemFragment})::bigint AS titles_touched,
           COALESCE(SUM(watch_time_ms), 0)::bigint AS watched_ms
    FROM value_rollup
  `);
  const mRow = movieAgg.rows[0] as { titles_touched: string; watched_ms: string } | undefined;
  const sRow = showAgg.rows[0] as { titles_touched: string; watched_ms: string } | undefined;
  return {
    titlesTouched: Number(mRow?.titles_touched ?? 0) + Number(sRow?.titles_touched ?? 0),
    watchedMs: Number(mRow?.watched_ms ?? 0) + Number(sRow?.watched_ms ?? 0),
  };
}

interface NewlyAddedKpi {
  count: number;
  totalBytes: number;
  playedCount: number;
}

/**
 * kpis.newlyAdded: canonical movies/shows added (by library_items.created_at,
 * not media.latest_added_at) within the window, their total file size, and
 * how many have been played since being added. playedCount is scoped to
 * plays on/after the title's own added_at, not all-time: a canonical media
 * id survives a remove-then-re-add cycle (re-resolved by external ids onto
 * the same row), and Tautulli/Jellystat imports backfill started_at
 * timestamps that can predate tracking - either can leave old, unrelated
 * plays sitting under a title that was only just added, which an unscoped
 * "ever played" check would wrongly count as fresh traction.
 *
 * Like playedCount, the byte total is not a point-in-time snapshot: a show
 * counted as newly-added in the window reports its current full episode
 * rollup, so a show that gains episodes after the window closes will report
 * a larger total than what actually landed during the window.
 */
async function fetchNewlyAdded(
  serverIds: string[] | undefined,
  dateRange: DateRange
): Promise<NewlyAddedKpi> {
  const windowFragment = buildTimestampWindowFragment(sql`li.created_at`, dateRange);
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  const serverFragmentLi2 = buildMultiServerFragment(serverIds, 'li2.server_id');
  const result = await db.execute(sql`
    WITH added_in_window AS (
      SELECT li.media_id AS canonical_id, m.media_type, MIN(li.created_at) AS added_at
      FROM library_items li
      JOIN media m ON m.id = li.media_id AND m.merged_into_id IS NULL
      WHERE li.removed_at IS NULL
        AND m.media_type IN ('movie', 'show')
        ${windowFragment}
        ${serverFragmentLi}
      GROUP BY li.media_id, m.media_type
    )
    SELECT
      COUNT(*)::bigint AS count,
      COALESCE(SUM(sub.file_size), 0)::bigint AS total_bytes,
      COUNT(*) FILTER (WHERE sub.has_plays)::bigint AS played_count
    FROM added_in_window aiw
    CROSS JOIN LATERAL (
      SELECT
        ${mediaSizeSubquery(sql`aiw.canonical_id`, serverFragmentLi2)} AS file_size,
        EXISTS (
          SELECT 1 FROM user_media_plays_daily p
          WHERE (
            (aiw.media_type = 'movie' AND p.media_id = aiw.canonical_id)
            OR (aiw.media_type = 'show' AND p.show_media_id = aiw.canonical_id)
          )
          AND p.day >= date_trunc('day', aiw.added_at)
        ) AS has_plays
    ) sub
  `);
  const row = result.rows[0] as
    { count: string; total_bytes: string; played_count: string } | undefined;
  return {
    count: Number(row?.count ?? 0),
    totalBytes: Number(row?.total_bytes ?? 0),
    playedCount: Number(row?.played_count ?? 0),
  };
}

/** Scope-wide, all-time header counts - independent of the requested window. */
async function fetchMeta(serverIds: string[] | undefined): Promise<ShelvesResponse['meta']> {
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  const serverFragmentLi2 = buildMultiServerFragment(serverIds, 'li2.server_id');
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE m.media_type = 'movie')::bigint AS movies,
      COUNT(*) FILTER (WHERE m.media_type = 'show')::bigint AS shows,
      COALESCE(SUM(${mediaSizeSubquery(sql`m.id`, serverFragmentLi2)}), 0)::bigint AS total_file_size
    FROM media m
    WHERE m.merged_into_id IS NULL
      AND m.media_type IN ('movie', 'show')
      AND EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}
      )
  `);
  const row = result.rows[0] as
    { movies: string; shows: string; total_file_size: string } | undefined;
  return {
    movies: Number(row?.movies ?? 0),
    shows: Number(row?.shows ?? 0),
    totalFileSize: Number(row?.total_file_size ?? 0),
  };
}

function withWatched<T extends CachedShelfRow>(
  row: T,
  watchedStates: Map<string, WatchedState>
): T & { watchedState: WatchedState } {
  return { ...row, watchedState: watchedStates.get(row.mediaId) ?? 'unwatched' };
}

async function computeShelves(
  serverIds: string[] | undefined,
  dateRange: DateRange,
  period: ShelvesResponse['period'],
  preferredPosterServerId: string | null,
  includeDeadWeight: boolean
): Promise<ShelvesResponse> {
  // Eight independent whole-catalog aggregate queries, split into two ~5-wide
  // Promise.all batches rather than one batch of 8 - a single request should
  // not be able to fire every heavy aggregate at the connection pool at once.
  const [recentlyAddedMovies, recentlyAddedShows, mostPopularMovies, mostPopularShows, deadWeight] =
    await Promise.all([
      fetchRecentlyAddedMovies(serverIds, preferredPosterServerId),
      fetchRecentlyAddedShows(serverIds, dateRange, preferredPosterServerId),
      fetchMostPopular('movie', serverIds, dateRange, preferredPosterServerId),
      fetchMostPopular('show', serverIds, dateRange, preferredPosterServerId),
      includeDeadWeight ? fetchDeadWeight(serverIds, preferredPosterServerId) : null,
    ]);
  const [newlyAdded, watchedAgg, meta] = await Promise.all([
    fetchNewlyAdded(serverIds, dateRange),
    fetchWatchedAggregate(serverIds, dateRange),
    fetchMeta(serverIds),
  ]);

  const movieIds = new Set<string>();
  const showIds = new Set<string>();
  for (const row of [...recentlyAddedMovies, ...mostPopularMovies]) movieIds.add(row.mediaId);
  for (const row of [...recentlyAddedShows, ...mostPopularShows]) showIds.add(row.mediaId);
  const showIdList = [...showIds];
  const episodeCounts = await fetchEpisodeCounts(showIdList, serverIds);
  const watchedStates = await resolveWatchedStates({
    movieIds: [...movieIds],
    showIds: showIdList,
    serverIds,
    lensUserId: null,
    episodeCounts,
  });

  return {
    period,
    recentlyAddedMovies: recentlyAddedMovies.map((row) => withWatched(row, watchedStates)),
    recentlyAddedShows: recentlyAddedShows.map((row) => withWatched(row, watchedStates)),
    mostPopularMovies: mostPopularMovies.map((row) => withWatched(row, watchedStates)),
    mostPopularShows: mostPopularShows.map((row) => withWatched(row, watchedStates)),
    // Dead weight is never-watched by definition - no probe needed.
    deadWeight: deadWeight?.rows.map((row) => ({ ...row, watchedState: 'unwatched' as const })),
    kpis: {
      watchedInPeriod: {
        titlesTouched: watchedAgg.titlesTouched,
        totalTitles: meta.movies + meta.shows,
      },
      hoursWatched: Math.floor(watchedAgg.watchedMs / 1000),
      newlyAdded,
      deadWeight: deadWeight
        ? { count: deadWeight.count, totalBytes: deadWeight.totalBytes }
        : undefined,
    },
    meta,
  };
}

/** Thin wrapper over the generic single-flight helper, typed to a shelves
 * compute (see withComputeSingleFlight in utils.ts for the lock mechanics). */
export async function computeShelvesSingleFlight(
  redis: Redis,
  cacheKey: string,
  compute: () => Promise<ShelvesResponse>
): Promise<ShelvesResponse> {
  const parseCached = (raw: string): ShelvesResponse => JSON.parse(raw) as ShelvesResponse;
  return withComputeSingleFlight(redis, cacheKey, compute, parseCached);
}

export const libraryShelvesRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /shelves - Windowed library command center, cached per (server
   * scope, period) since the response no longer varies per viewer.
   */
  app.get<{ Querystring: Record<string, unknown> }>(
    '/shelves',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = shelvesQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { period, startDate, endDate, serverIds, includeDeadWeight } = query.data;
      const authUser = request.user;

      // Guard: server scope, fail-closed.
      const resolvedIds = resolveServerIds(authUser, undefined, serverIds);

      const dateRange = resolveDateRange(period, startDate, endDate);
      // Read once per request (10s cache in the settings service) and thread
      // down to every poster subquery below, rather than a getSetting call
      // per shelf.
      const preferredPosterServerId = await getSetting('preferredPosterServerId');

      const serverCacheKey = resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all';
      const periodCacheKey =
        period === 'custom'
          ? `custom:${dateRange.start?.toISOString() ?? 'none'}:${dateRange.end.toISOString()}`
          : period;
      // v2 suffix: the response shape changed (four type-split shelves + kpis
      // + dead-weight module, no lens), so a v1-cached payload must never be
      // served back as v2. The poster preference is folded into the key too
      // (rather than invalidated on settings update) so a change takes effect
      // on the next request without touching PATCH /settings.
      // v3: size math changed to dedupe mirrored copies across servers, so a
      // v2-cached payload's totals are stale and must not be served as v3.
      // v4: show sizes now roll up their episodes' files instead of reading
      // the show's own (always-null) file_size, so a v3-cached payload's
      // totals are stale and must not be served as v4.
      // v5: recentlyAddedShows.newEpisodes is now a distinct, period-windowed
      // episode count instead of an unbounded per-copy count, so a v4-cached
      // payload's chip numbers are stale and must not be served as v5.
      const cacheKey = buildLibraryCacheKey(
        `${REDIS_KEYS.LIBRARY_SHELVES}:v6`,
        serverCacheKey,
        periodCacheKey,
        undefined,
        `${preferredPosterServerId ?? 'auto'}:${includeDeadWeight ? 'dw1' : 'dw0'}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as ShelvesResponse;
        } catch {
          // Fall through to compute.
        }
      }

      return computeShelvesSingleFlight(app.redis, cacheKey, async () => {
        const response = await computeShelves(
          resolvedIds,
          dateRange,
          period,
          preferredPosterServerId,
          includeDeadWeight
        );
        await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_SHELVES, JSON.stringify(response));
        return response;
      });
    }
  );
};
