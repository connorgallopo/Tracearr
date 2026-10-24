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
  SQUARE_POSTER_SIZE,
  posterSizeFor,
  type AlbumShelfRow,
  type LibraryMediaType,
  type ShelfRow,
  type RecentlyAddedShelfRow,
  type RecentlyUpdatedShelfRow,
  type MostPopularShelfRow,
  type DeadWeightRow,
  type ShelvesResponse,
  type WatchedState,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import {
  albumCountSql,
  buildValueRollupCte,
  pickBestResolution,
  buildCatalogPageQuery,
  buildPosterOrderFragment,
  posterFor,
  rowDecorationsSql,
} from './catalog.js';
import {
  fetchEpisodeCounts,
  resolveWatchedStates,
} from '../../services/library/mediaWatchedService.js';
import { reAddedPredicate } from '../../services/library/reAdded.js';
import { getSetting } from '../../services/settings.js';
import {
  libraryCacheSegment,
  libraryFragment,
  seesServerActivity,
  type Scope,
} from '../../lib/scope.js';
import { resolveDateRange, type DateRange } from '../stats/utils.js';
import {
  buildLibraryCacheKey,
  mediaSizeSubquery,
  neverPlayedSql,
  withComputeSingleFlight,
} from './utils.js';

const SHELF_LIMIT = 20;
const DEAD_WEIGHT_LIMIT = 10;

export interface RawShelfRow {
  id: string;
  media_type: LibraryMediaType;
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
  album_count?: number | null;
}

interface RawRecentlyAddedShowRow extends RawShelfRow {
  new_episodes: number;
  added_at: string;
}

/** How many candidates the movie shelf reads before splitting them: two thirds of a busy week's arrivals replace a copy the server already had. */
const MOVIE_CANDIDATE_LIMIT = SHELF_LIMIT * 6;

/** ShelfRow minus watchedState: resolved once (all-users aggregate) and attached after fetch. */
type CachedShelfRow = Omit<ShelfRow, 'watchedState'>;

type CachedRecentlyAddedRow = CachedShelfRow &
  Pick<RecentlyAddedShelfRow, 'newEpisodes' | 'newestEpisodeAt'>;
type CachedRecentlyUpdatedRow = CachedShelfRow &
  Pick<RecentlyUpdatedShelfRow, 'replacedEpisodes' | 'newestEpisodeAt'> & { sortAt: string | null };
type CachedMostPopularRow = CachedShelfRow &
  Pick<MostPopularShelfRow, 'plays' | 'viewers' | 'rank'>;
type CachedDeadWeightRow = CachedShelfRow & Pick<DeadWeightRow, 'fileBytes' | 'addedAt'>;

export function toShelfRowBase(row: RawShelfRow): CachedShelfRow {
  const servers = row.servers ?? [];
  const poster = row.poster_copy;

  return {
    mediaId: row.id,
    mediaType: row.media_type,
    title: row.title,
    year: row.year,
    genres: row.genres ?? [],
    ...posterFor(poster?.serverId, poster?.thumbPath, posterSizeFor(row.media_type)),
    dominantColor: poster?.dominantColor ?? null,
    servers,
    resolutionBest: pickBestResolution(servers),
    ...(row.media_type === 'artist' && { albumCount: row.album_count ?? 0 }),
  };
}

/** Media whose newest live copy replaces one this server lost. */
async function findReAddedMedia(
  mediaIds: string[],
  serverIds: string[] | undefined,
  scope: Scope
): Promise<Set<string>> {
  if (mediaIds.length === 0) return new Set();
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const result = await db.execute(sql`
    SELECT media_id FROM (
      SELECT DISTINCT ON (li.media_id) li.media_id, ${reAddedPredicate('li')} AS re_added
      FROM library_items li
      WHERE li.media_id IN (${sql.join(
        mediaIds.map((id) => sql`${id}::uuid`),
        sql`, `
      )})
        AND li.removed_at IS NULL ${serverFragmentLi}
      ORDER BY li.media_id, li.created_at DESC
    ) newest
    WHERE re_added
  `);
  return new Set((result.rows as unknown as { media_id: string }[]).map((row) => row.media_id));
}

/**
 * Newest active copy per canonical movie, latest-added-first, split by whether
 * that copy is the title's first here or replaces one the server lost.
 */
async function fetchRecentlyAddedMovies(
  serverIds: string[] | undefined,
  scope: Scope,
  preferredPosterServerId: string | null
): Promise<{ added: CachedRecentlyAddedRow[]; updated: CachedRecentlyUpdatedRow[] }> {
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
    atmos: false,
    sizeGbMin: null,
    sizeGbMax: null,
    serverIds,
    scope,
    pageSize: MOVIE_CANDIDATE_LIMIT,
    preferredPosterServerId,
  });
  const movieResult = await db.execute(movieQuery);
  const candidates = movieResult.rows as unknown as RawShelfRow[];
  const reAdded = await findReAddedMedia(
    candidates.map((row) => row.id),
    serverIds,
    scope
  );

  const added: CachedRecentlyAddedRow[] = [];
  const updated: CachedRecentlyUpdatedRow[] = [];
  for (const row of candidates) {
    if (reAdded.has(row.id)) {
      if (updated.length < SHELF_LIMIT) {
        updated.push({
          ...toShelfRowBase(row),
          replacedEpisodes: null,
          newestEpisodeAt: null,
          sortAt: row.latest_added_at,
        });
      }
      continue;
    }
    if (added.length < SHELF_LIMIT)
      added.push({ ...toShelfRowBase(row), newEpisodes: null, newestEpisodeAt: null });
  }
  return { added, updated };
}

/**
 * Shows whose episodes group under the show's own card, latest-episode-first.
 * 'added' counts episodes new to this server, 'updated' counts the ones that
 * replaced a copy it lost, and each mode ranks a show by its own newest
 * qualifying episode. The count is scoped to the request's dateRange while the
 * rank is not - otherwise a show that has aired for years reports every active
 * episode it has ever had as "new" the moment any one of them is added.
 */
async function fetchShowShelf(
  mode: 'added' | 'updated',
  serverIds: string[] | undefined,
  scope: Scope,
  dateRange: DateRange,
  preferredPosterServerId: string | null
): Promise<RawRecentlyAddedShowRow[]> {
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const posterOrderFragment = buildPosterOrderFragment(preferredPosterServerId);
  const episodeWindow = buildTimestampWindowCondition(sql`li.created_at`, dateRange);
  const qualifies =
    mode === 'updated' ? reAddedPredicate('li') : sql`NOT ${reAddedPredicate('li')}`;
  const showResult = await db.execute(sql`
    WITH added_episodes AS (
      SELECT e.show_media_id AS show_id,
             COUNT(DISTINCT e.id) FILTER (WHERE ${episodeWindow})::int AS new_episodes,
             MAX(li.created_at) AS added_at
      FROM library_items li
      JOIN media e ON e.id = li.media_id
      WHERE li.removed_at IS NULL AND e.media_type = 'episode' AND e.show_media_id IS NOT NULL
        AND ${qualifies}
        ${serverFragmentLi}
      GROUP BY e.show_media_id
    )
    SELECT m.id, m.media_type, m.title, m.year, m.genres, m.normalized_title, m.latest_added_at,
           ae.new_episodes, ae.added_at,
      ${rowDecorationsSql('m', serverFragmentLi, posterOrderFragment)}
    FROM added_episodes ae
    JOIN media m ON m.id = ae.show_id AND m.merged_into_id IS NULL
    ORDER BY ae.added_at DESC
    LIMIT ${SHELF_LIMIT}
  `);
  return showResult.rows as unknown as RawRecentlyAddedShowRow[];
}

async function fetchRecentlyAddedShows(
  serverIds: string[] | undefined,
  scope: Scope,
  dateRange: DateRange,
  preferredPosterServerId: string | null
): Promise<CachedRecentlyAddedRow[]> {
  const rows = await fetchShowShelf('added', serverIds, scope, dateRange, preferredPosterServerId);
  return rows.map((row) => ({
    ...toShelfRowBase(row),
    newEpisodes: row.new_episodes,
    newestEpisodeAt: row.added_at,
  }));
}

async function fetchRecentlyUpdatedShows(
  serverIds: string[] | undefined,
  scope: Scope,
  dateRange: DateRange,
  preferredPosterServerId: string | null
): Promise<CachedRecentlyUpdatedRow[]> {
  const rows = await fetchShowShelf(
    'updated',
    serverIds,
    scope,
    dateRange,
    preferredPosterServerId
  );
  return rows.map((row) => ({
    ...toShelfRowBase(row),
    replacedEpisodes: row.new_episodes,
    newestEpisodeAt: row.added_at,
    sortAt: row.added_at,
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
  type: LibraryMediaType,
  serverIds: string[] | undefined,
  scope: Scope,
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
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const posterOrderFragment = buildPosterOrderFragment(preferredPosterServerId);
  const detailResult = await db.execute(sql`
    SELECT m.id, m.media_type, m.title, m.year, m.genres, m.normalized_title, m.latest_added_at,
      ${rowDecorationsSql('m', serverFragmentLi, posterOrderFragment)}
      ${type === 'artist' ? sql`, ${albumCountSql(sql`m.id`, serverFragmentLi)} AS album_count` : sql``}
    FROM media m
    WHERE m.id = ANY(${uuidArraySql(ids)}) AND m.merged_into_id IS NULL
      ${buildActiveItemFragment(sql`m.id`, serverIds, scope)}
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

interface RawAlbumShelfRow {
  server_id: string;
  rating_key: string;
  title: string;
  artist_title: string | null;
  artist_media_id: string | null;
  year: number | null;
  thumb_path: string | null;
  added_at: string | Date;
}

/**
 * Newest album rows in scope, one per server copy rather than folded into a
 * canonical album. An album whose artist row is missing is dropped, the same
 * way a track with no artist row drops out of the artist rollups.
 */
async function fetchRecentlyAddedAlbums(
  serverIds: string[] | undefined,
  scope: Scope
): Promise<AlbumShelfRow[]> {
  const result = await db.execute(sql`
    SELECT a.server_id, a.rating_key, a.title, a.parent_title AS artist_title,
           ar.media_id AS artist_media_id, a.year, a.thumb_path, a.created_at AS added_at
    FROM library_items a
    JOIN library_items ar ON ar.server_id = a.server_id AND ar.rating_key = a.parent_rating_key
      AND ar.media_type = 'artist' AND ar.removed_at IS NULL
    WHERE a.media_type = 'album' AND a.removed_at IS NULL ${libraryFragment(serverIds, scope, 'a')}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${SHELF_LIMIT}
  `);
  return (result.rows as unknown as RawAlbumShelfRow[]).map((row) => ({
    serverId: row.server_id,
    ratingKey: row.rating_key,
    title: row.title,
    artistTitle: row.artist_title,
    artistMediaId: row.artist_media_id,
    year: row.year,
    ...posterFor(row.server_id, row.thumb_path, SQUARE_POSTER_SIZE),
    addedAt: new Date(row.added_at).toISOString(),
  }));
}

interface DeadWeightCandidate {
  canonicalId: string;
  totalFileSize: number;
}

/**
 * ALL never-watched canonical titles of one type (no LIMIT - the caller needs
 * an exact all-time count/size total, not just the display page), by
 * neverPlayedSql. No poster/servers lookup here - that's deferred to the
 * detail query for only the top DEAD_WEIGHT_LIMIT candidates, so this stays
 * one correlated subquery (file size) per row instead of three.
 */
async function fetchDeadWeightCandidatesForType(
  type: 'movie' | 'show',
  serverIds: string[] | undefined,
  scope: Scope
): Promise<DeadWeightCandidate[]> {
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const serverFragmentLi2 = libraryFragment(serverIds, scope, 'li2');
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
      AND ${neverPlayedSql(type, sql`m.id`, serverIds)}
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
  scope: Scope,
  preferredPosterServerId: string | null
): Promise<DeadWeightResult> {
  const movies = await fetchDeadWeightCandidatesForType('movie', serverIds, scope);
  const shows = await fetchDeadWeightCandidatesForType('show', serverIds, scope);
  const all = [...movies, ...shows];
  const count = all.length;
  const totalBytes = all.reduce((sum, c) => sum + c.totalFileSize, 0);

  const top = [...all]
    .sort((a, b) => b.totalFileSize - a.totalFileSize)
    .slice(0, DEAD_WEIGHT_LIMIT);
  if (top.length === 0) return { rows: [], count, totalBytes };

  const sizeById = new Map(top.map((c) => [c.canonicalId, c.totalFileSize]));
  const ids = top.map((c) => c.canonicalId);
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const posterOrderFragment = buildPosterOrderFragment(preferredPosterServerId);
  const detailResult = await db.execute(sql`
    SELECT m.id, m.media_type, m.title, m.year, m.genres, m.normalized_title, m.latest_added_at,
      ${rowDecorationsSql('m', serverFragmentLi, posterOrderFragment)}
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
function buildActiveItemFragment(
  idColumn: SQL,
  serverIds: string[] | undefined,
  scope: Scope
): SQL {
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
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
  scope: Scope,
  dateRange: DateRange
): Promise<WatchedAggregate> {
  const movieCte = buildValueRollupCte('movie', serverIds, undefined, dateRange);
  const showCte = buildValueRollupCte('show', serverIds, undefined, dateRange);
  const activeItemFragment = buildActiveItemFragment(
    sql`value_rollup.canonical_id`,
    serverIds,
    scope
  );
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
  scope: Scope,
  dateRange: DateRange
): Promise<NewlyAddedKpi> {
  const windowFragment = buildTimestampWindowFragment(sql`li.created_at`, dateRange);
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const serverFragmentLi2 = libraryFragment(serverIds, scope, 'li2');
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
async function fetchMeta(
  serverIds: string[] | undefined,
  scope: Scope
): Promise<ShelvesResponse['meta']> {
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const serverFragmentLi2 = libraryFragment(serverIds, scope, 'li2');
  const result = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE m.media_type = 'movie')::bigint AS movies,
      COUNT(*) FILTER (WHERE m.media_type = 'show')::bigint AS shows,
      COUNT(*) FILTER (WHERE m.media_type = 'artist')::bigint AS artists,
      COUNT(*) FILTER (WHERE m.media_type = 'album')::bigint AS albums,
      COALESCE(SUM(CASE WHEN m.media_type IN ('movie', 'show')
        THEN ${mediaSizeSubquery(sql`m.id`, serverFragmentLi2)} END), 0)::bigint AS total_file_size
    FROM media m
    WHERE m.merged_into_id IS NULL
      AND m.media_type IN ('movie', 'show', 'artist', 'album')
      AND EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}
      )
  `);
  const row = result.rows[0] as
    | { movies: string; shows: string; artists: string; albums: string; total_file_size: string }
    | undefined;
  return {
    movies: Number(row?.movies ?? 0),
    shows: Number(row?.shows ?? 0),
    artists: Number(row?.artists ?? 0),
    albums: Number(row?.albums ?? 0),
    totalFileSize: Number(row?.total_file_size ?? 0),
  };
}

function withWatched<T extends CachedShelfRow>(
  row: T,
  watchedStates: Map<string, WatchedState>
): T & { watchedState: WatchedState } {
  return { ...row, watchedState: watchedStates.get(row.mediaId) ?? 'unwatched' };
}

function withoutCounts(watchedStates: Map<string, WatchedState>) {
  return ({ plays: _plays, viewers: _viewers, ...row }: MostPopularShelfRow) =>
    withWatched(row, watchedStates);
}

async function computeShelves(
  serverIds: string[] | undefined,
  scope: Scope,
  dateRange: DateRange,
  period: ShelvesResponse['period'],
  preferredPosterServerId: string | null,
  includeDeadWeight: boolean
): Promise<ShelvesResponse> {
  // The independent whole-catalog aggregate queries run in two ~5-wide
  // Promise.all batches rather than one - a single request should not be
  // able to fire every heavy aggregate at the connection pool at once.
  const [
    movies,
    recentlyAddedShows,
    updatedShows,
    mostPopularMovies,
    mostPopularShows,
    deadWeight,
  ] = await Promise.all([
    fetchRecentlyAddedMovies(serverIds, scope, preferredPosterServerId),
    fetchRecentlyAddedShows(serverIds, scope, dateRange, preferredPosterServerId),
    fetchRecentlyUpdatedShows(serverIds, scope, dateRange, preferredPosterServerId),
    fetchMostPopular('movie', serverIds, scope, dateRange, preferredPosterServerId),
    fetchMostPopular('show', serverIds, scope, dateRange, preferredPosterServerId),
    includeDeadWeight ? fetchDeadWeight(serverIds, scope, preferredPosterServerId) : null,
  ]);
  const recentlyAddedMovies = movies.added;
  // One row for both types, so the two lists interleave on when the copy landed
  const recentlyUpdated = [...movies.updated, ...updatedShows]
    .sort((a, b) => (b.sortAt ?? '').localeCompare(a.sortAt ?? ''))
    .slice(0, SHELF_LIMIT);
  const [newlyAdded, watchedAgg, meta, recentlyAddedAlbums, mostPlayedArtists] = await Promise.all([
    fetchNewlyAdded(serverIds, scope, dateRange),
    fetchWatchedAggregate(serverIds, scope, dateRange),
    fetchMeta(serverIds, scope),
    fetchRecentlyAddedAlbums(serverIds, scope),
    fetchMostPopular('artist', serverIds, scope, dateRange, preferredPosterServerId),
  ]);

  const movieIds = new Set<string>();
  const showIds = new Set<string>();
  for (const row of [...recentlyAddedMovies, ...mostPopularMovies]) movieIds.add(row.mediaId);
  for (const row of [...recentlyAddedShows, ...mostPopularShows]) showIds.add(row.mediaId);
  for (const row of recentlyUpdated) {
    if (row.mediaType === 'show') showIds.add(row.mediaId);
    else movieIds.add(row.mediaId);
  }
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
    recentlyUpdated: recentlyUpdated.map(({ sortAt: _sortAt, ...row }) =>
      withWatched(row, watchedStates)
    ),
    mostPopularMovies: mostPopularMovies.map((row) => withWatched(row, watchedStates)),
    mostPopularShows: mostPopularShows.map((row) => withWatched(row, watchedStates)),
    recentlyAddedAlbums,
    mostPlayedArtists: mostPlayedArtists.map((row) => withWatched(row, watchedStates)),
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

/**
 * The cached shelves are everyone's. A member gets each title's watched state as their own, the
 * Most Popular and Most Played Artists shelves whatever the owner's activity switch says but
 * never their play and viewer counts, no Recently Updated (a replaced file is the owner's
 * business), and the server's watched figures only with the switch on.
 */
async function forMember(
  response: ShelvesResponse,
  userId: string,
  serverIds: string[] | undefined,
  showActivity: boolean
): Promise<ShelvesResponse> {
  const movieIds = new Set<string>();
  const showIds = new Set<string>();
  for (const row of [...response.recentlyAddedMovies, ...response.mostPopularMovies]) {
    movieIds.add(row.mediaId);
  }
  for (const row of [...response.recentlyAddedShows, ...response.mostPopularShows]) {
    showIds.add(row.mediaId);
  }
  const showIdList = [...showIds];
  const watchedStates = await resolveWatchedStates({
    movieIds: [...movieIds],
    showIds: showIdList,
    serverIds,
    lensUserId: userId,
    episodeCounts: await fetchEpisodeCounts(showIdList, serverIds),
  });
  // Dead weight is the titles nobody watched, judged from everyone's plays.
  const { deadWeight: _everyone, hoursWatched, watchedInPeriod, ...kpis } = response.kpis;
  // playedCount counts titles anyone played.
  if (!showActivity)
    kpis.newlyAdded = { count: kpis.newlyAdded.count, totalBytes: kpis.newlyAdded.totalBytes };
  const activity = showActivity
    ? { hoursWatched, watchedInPeriod }
    : { watchedInPeriod: { totalTitles: watchedInPeriod.totalTitles } };
  return {
    ...response,
    deadWeight: undefined,
    kpis: { ...kpis, ...activity },
    recentlyAddedMovies: response.recentlyAddedMovies.map((r) => withWatched(r, watchedStates)),
    recentlyAddedShows: response.recentlyAddedShows.map((r) => withWatched(r, watchedStates)),
    recentlyUpdated: [],
    mostPopularMovies: response.mostPopularMovies.map(withoutCounts(watchedStates)),
    mostPopularShows: response.mostPopularShows.map(withoutCounts(watchedStates)),
    mostPlayedArtists: response.mostPlayedArtists.map(withoutCounts(watchedStates)),
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
    { preHandler: [app.requirePermission('media', 'read')] },
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

      const serverCacheKey =
        (resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all') +
        libraryCacheSegment(request.scope);
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
      // v8: the recently-added shelves drop copies that replace one the server
      // lost, and those move to recentlyUpdated, which a v7 payload lacks.
      // v10: recentlyAddedAlbums, mostPlayedArtists and the music meta counts.
      // v11: album rows carry posterVersion, and artist and album art is square.
      const cacheKey = buildLibraryCacheKey(
        `${REDIS_KEYS.LIBRARY_SHELVES}:v11`,
        serverCacheKey,
        periodCacheKey,
        undefined,
        `${preferredPosterServerId ?? 'auto'}:${includeDeadWeight ? 'dw1' : 'dw0'}`
      );

      const scope = request.scope;
      const forViewer = async (response: ShelvesResponse) =>
        scope === 'all'
          ? response
          : forMember(response, scope.userId, resolvedIds, await seesServerActivity(scope));

      const cachedRaw = await app.redis.get(cacheKey);
      let cached: ShelvesResponse | null = null;
      if (cachedRaw) {
        try {
          cached = JSON.parse(cachedRaw) as ShelvesResponse;
        } catch {
          // Fall through to compute.
        }
      }
      if (cached) return forViewer(cached);

      const response = await computeShelvesSingleFlight(app.redis, cacheKey, async () => {
        const computed = await computeShelves(
          resolvedIds,
          scope,
          dateRange,
          period,
          preferredPosterServerId,
          includeDeadWeight
        );
        await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_SHELVES, JSON.stringify(computed));
        return computed;
      });
      return forViewer(response);
    }
  );
};
