/**
 * Catalog browse endpoint
 *
 * GET /catalog - Windowed canonical-media grain browse feed for the media
 * landing pages (movies/shows grids). The grid is a fixed-total virtualized
 * surface: the client asks for whatever row range is on screen, addressed by
 * absolute `offset` into the sorted, filtered ordering. There is no cursor
 * mode - the grid was the only consumer and offset windows serve every
 * access pattern it has (initial load, scroll in either direction, letter
 * jump, restore).
 *
 * Title ordering runs on media.sort_title, an article-stripped normalization
 * ("The Matrix" sorts under M) computed on every media write (buildSortTitle).
 * normalized_title is untouched:
 * it feeds identity match keys, where stripping articles would merge
 * distinct titles.
 *
 * The `watched` filter cannot be a SQL predicate today (state is resolved by
 * the alias-aware probe in mediaWatchedService), so with `watched` set both
 * this endpoint and /catalog/letters read from one shared, Redis-cached
 * ordered candidate list (see getWatchedCandidates). That single source
 * guarantees the letter rail's cumulative offsets and the page windows agree
 * on row positions - two independently computed views of a JS post-filter
 * never line up reliably.
 *
 * GET /catalog/letters - Per-first-letter title counts for the same filter
 * set, so the frontend can derive letter -> cumulative row offset for the
 * alphabet rail (a rail click is just a scrollToIndex to that offset).
 * Buckets are assigned in SQL by collation range comparison against the
 * letter boundaries ('a' <= sort_title < 'b' is bucket A), never by
 * inspecting the first character in JS: under en_US.utf8 an accent-leading
 * title sorts inside a letter's range, and only the range rule keeps every
 * bucket contiguous in the exact order the catalog pages walk.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import { sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  catalogQuerySchema,
  REDIS_KEYS,
  CACHE_TTL,
  LETTER_RAIL_ALPHABET,
  POSTER_IMAGE_SIZE,
  posterSizeFor,
  resolutionTierRank,
  resolutionBucket,
  type CatalogResponse,
  type CatalogRow,
  type CatalogLetterBucket,
  type CatalogLettersResponse,
  type CatalogCodecOptionsResponse,
  type LibraryMediaType,
  type WatchedState,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolutionBucketPredicate, resolutionRankSql } from '../../utils/resolutionBuckets.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import {
  libraryCacheSegment,
  libraryFragment,
  seesServerActivity,
  type Scope,
} from '../../lib/scope.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import { normalizeTitle } from '../../services/library/mediaMatchKey.js';
import {
  fetchEpisodeCounts,
  resolveWatchedStates,
} from '../../services/library/mediaWatchedService.js';
import { buildProxyUrl, posterVersionFor } from '../../services/imageProxy.js';
import { getSetting } from '../../services/settings.js';
import type { DateRange } from '../stats/utils.js';
import {
  ARTIST_OF_TRACK,
  LI_HAS_KNOWN_IMAGE,
  mediaSizeSubquery,
  buildLibraryCacheKey,
  withComputeSingleFlight,
} from './utils.js';
import {
  codecPredicate,
  fetchCodecOptions,
  resolveRawCodecs,
  type CodecKind,
  type RawCodec,
} from './codecFilter.js';

type CatalogQueryInput = z.infer<typeof catalogQuerySchema>;

/** Artists carry no year and no watched state, so that sort and that filter are invalid for them. */
function fitsType(query: Pick<CatalogQueryInput, 'type' | 'sort' | 'watched'>): boolean {
  return query.type !== 'artist' || (query.sort !== 'year' && query.watched === undefined);
}

const catalogPageQuerySchema = catalogQuerySchema.refine(fitsType);

// Same filter fields as catalogQuerySchema, minus the window params -
// letters is an unpaginated aggregate over the whole filtered set.
const catalogLettersQuerySchema = catalogQuerySchema
  .omit({ offset: true, pageSize: true })
  .refine(fitsType);

const catalogCodecsQuerySchema = catalogQuerySchema.pick({
  type: true,
  serverId: true,
  serverIds: true,
});

export type CatalogSort = CatalogQueryInput['sort'];

const POPULARITY_SORTS = new Set<CatalogSort>(['plays', 'watch_time', 'viewers']);

/**
 * A member browses through their own lens, since 'all' would list what anyone watched, and
 * without popularity order or counts unless the owner shows members server activity. Another
 * person's lens answers null, which the routes turn into a 404.
 */
async function viewerBrowse(
  scope: Scope,
  lens: string,
  sort: CatalogSort
): Promise<{ lensUserId: string | null; sort: CatalogSort; showActivity: boolean } | null> {
  if (scope === 'all')
    return { lensUserId: lens === 'all' ? null : lens, sort, showActivity: true };
  if (lens !== 'all' && lens !== scope.userId) return null;
  const showActivity = await seesServerActivity(scope);
  return {
    lensUserId: scope.userId,
    sort: !showActivity && POPULARITY_SORTS.has(sort) ? 'title' : sort,
    showActivity,
  };
}

/** Splits the `${serverId}:${libraryId}` composite key back into its parts;
 * libraryKeySchema already validated the shape at the request boundary. */
export function parseLibraryKey(
  libraryKey: string | undefined
): { serverId: string; libraryId: string } | null {
  if (!libraryKey) return null;
  const separator = libraryKey.indexOf(':');
  return { serverId: libraryKey.slice(0, separator), libraryId: libraryKey.slice(separator + 1) };
}

export interface CatalogPageQueryParams {
  type: LibraryMediaType;
  sort: CatalogSort;
  offset: number;
  genre: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  searchNormalized: string | null;
  resolution: string | null;
  libraryServerId: string | null;
  libraryId: string | null;
  hdr: boolean;
  atmos: boolean;
  sizeGbMin: number | null;
  sizeGbMax: number | null;
  videoCodecs?: RawCodec[] | null;
  audioCodecs?: RawCodec[] | null;
  audioChannels?: RawCodec[] | null;
  serverIds: string[] | undefined;
  scope: Scope;
  pageSize: number;
  preferredPosterServerId?: string | null;
}

export interface CatalogTotalsQueryParams {
  type: LibraryMediaType;
  sort: CatalogSort;
  genre: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  searchNormalized: string | null;
  resolution: string | null;
  libraryServerId: string | null;
  libraryId: string | null;
  hdr: boolean;
  atmos: boolean;
  sizeGbMin: number | null;
  sizeGbMax: number | null;
  videoCodecs?: RawCodec[] | null;
  audioCodecs?: RawCodec[] | null;
  audioChannels?: RawCodec[] | null;
  serverIds: string[] | undefined;
  scope: Scope;
}

interface RawCatalogRow {
  id: string;
  media_type: LibraryMediaType;
  title: string;
  year: number | null;
  genres: string[] | null;
  sort_title: string | null;
  latest_added_at: string | null;
  plays_value?: string | number | null;
  viewers_value?: string | number | null;
  value?: string | number | null;
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

const VALUE_SORT_COLUMN: Record<'plays' | 'watch_time' | 'viewers', string> = {
  plays: 'plays',
  watch_time: 'watch_time_ms',
  viewers: 'viewers',
};

/**
 * Time-window predicate for the value_rollup CTE's `p.day` column.
 *
 * - dateRange === undefined: the CTE's historical default (30 days), used by
 *   every catalog.ts call site that doesn't pass an explicit window, so the
 *   catalog browse endpoint's plays/watch_time/viewers sorts are unchanged.
 * - dateRange.start === null: 'all' period, no lower bound.
 * - otherwise: bounded to [start, end) - end is only a meaningful upper bound
 *   for a 'custom' range; for the preset periods (day/week/month/year)
 *   resolveDateRange() sets end to "now", which this bound never excludes.
 *   `p.day` is a time_bucket('1 day', ...) UTC-midnight-aligned column, not an
 *   exact instant, so start/end are truncated to day boundaries before the
 *   comparison (mirrors the dailyEndFilter handling in stats/engagement.ts) -
 *   otherwise a bound that lands mid-day would exclude the rest of that day's
 *   bucket instead of including it.
 */
function buildPlaysWindowFragment(dateRange: DateRange | undefined): SQL {
  if (dateRange === undefined) {
    return sql`AND p.day >= now() - interval '30 days'`;
  }
  if (!dateRange.start) {
    return sql``;
  }
  const start = sql`date_trunc('day', ${dateRange.start}::timestamptz)`;
  const end = sql`date_trunc('day', ${dateRange.end}::timestamptz) + interval '1 day'`;
  return sql`AND p.day >= ${start} AND p.day < ${end}`;
}

/**
 * Expands canonical media ids to include their merge losers, so a caller that
 * only knows the canonical ids of a page can still match every session/play
 * row directly - those rows carry a loser's own id, never the winner's, in
 * media_id/show_media_id. Sargable against the cagg's own indexed columns,
 * unlike filtering on COALESCE(merged_into_id, media_id) (see
 * buildValueRollupCte's idsFilter).
 */
export async function expandMediaAliases(canonicalIds: string[]): Promise<string[]> {
  if (canonicalIds.length === 0) return [];
  const idsArray = uuidArraySql(canonicalIds);
  const result = await db.execute(
    sql`SELECT id FROM media WHERE id = ANY(${idsArray}) OR merged_into_id = ANY(${idsArray})`
  );
  return (result.rows as unknown as { id: string }[]).map((row) => row.id);
}

/**
 * value_rollup CTE body (no leading WITH): alias-expanded plays/watch
 * time/viewer counts per canonical media id, window-bounded per
 * buildPlaysWindowFragment. Unbounded across the catalog when idsFilter is
 * omitted (drives the plays/watch_time/viewers sorts); bounded to a specific
 * id set for page-batched display fields otherwise - idsFilter must already
 * be alias-expanded (see expandMediaAliases), since it filters mediaCol
 * directly for sargability instead of matching through the COALESCE that
 * resolves a row back to its canonical id.
 */
export function buildValueRollupCte(
  type: LibraryMediaType,
  serverIds: string[] | undefined,
  idsFilter: string[] | undefined,
  dateRange?: DateRange
): SQL {
  const mediaCol = {
    movie: sql`p.media_id`,
    show: sql`p.show_media_id`,
    artist: sql`artist.media_id`,
  }[type];
  const serverFragment = buildMultiServerFragment(serverIds, 'p.server_id');
  // A track's plays count toward the artist copy it sits under on its server;
  // a track whose artist row is missing drops out.
  const artistJoin =
    type === 'artist'
      ? sql`JOIN LATERAL (
          SELECT ar.media_id ${ARTIST_OF_TRACK}
          WHERE t.media_id = p.media_id AND t.server_id = p.server_id AND t.media_type = 'track'
          ORDER BY ar.id
          LIMIT 1
        ) artist ON true`
      : sql``;
  // The movie guard: p.media_id is set on every session-backed row regardless
  // of type, so without it an episode with a null/unresolved show_media_id (or
  // any future linkage regression) would join into the movie candidate list
  // via its own media_id and get counted as a "movie".
  const typeGuard = {
    movie: sql`AND am.media_type = 'movie'`,
    show: sql`AND p.show_media_id IS NOT NULL`,
    artist: sql`AND p.media_type = 'track'`,
  }[type];
  // Artists also narrow p to their own tracks first, so the artist LATERAL runs
  // only for those rows instead of every track play in the window.
  const idsFragment =
    idsFilter && idsFilter.length > 0
      ? type === 'artist'
        ? sql`AND (p.media_id, p.server_id) IN (
            SELECT t.media_id, t.server_id ${ARTIST_OF_TRACK}
            WHERE ar.media_id = ANY(${uuidArraySql(idsFilter)}) AND t.media_type = 'track'
          ) AND ${mediaCol} = ANY(${uuidArraySql(idsFilter)})`
        : sql`AND ${mediaCol} = ANY(${uuidArraySql(idsFilter)})`
      : sql``;
  const windowFragment = buildPlaysWindowFragment(dateRange);
  return sql`
    value_rollup AS (
      SELECT COALESCE(am.merged_into_id, ${mediaCol}) AS canonical_id,
             COUNT(DISTINCT p.chain_id) FILTER (WHERE p.counted)::bigint AS plays,
             SUM(p.watched_ms)::bigint AS watch_time_ms,
             COUNT(DISTINCT su.user_id)::bigint AS viewers
      FROM user_media_plays_daily p
      ${artistJoin}
      JOIN media am ON am.id = ${mediaCol}
      JOIN server_users su ON su.id = p.server_user_id
      WHERE 1=1 ${windowFragment} ${typeGuard} ${serverFragment} ${idsFragment}
      GROUP BY COALESCE(am.merged_into_id, ${mediaCol})
    )
  `;
}

/** Bytes-per-GB used to convert the sizeGbMin/sizeGbMax query params into the
 * file_size column's raw byte count. Base-1024, matching formatBytes (the
 * same convention the totalFileSize the toolbar already displays uses). */
const BYTES_PER_GB = 1024 ** 3;

/**
 * Correlated scope over one show copy's episodes: show containers carry no
 * MediaSources on any server type, so quality and size live on the episode
 * items reached through media.show_media_id, scoped to the same server +
 * library as the outer li copy. `showIdCol` is a trusted column expression,
 * never user input.
 */
function episodeVersionsScope(showIdCol: string): SQL {
  return sql`
    FROM media em
    JOIN library_items epi ON epi.media_id = em.id AND epi.removed_at IS NULL
    JOIN library_item_versions v ON v.library_item_id = epi.id AND v.removed_at IS NULL
    WHERE em.show_media_id = ${sql.raw(showIdCol)} AND em.media_type = 'episode'
      AND epi.server_id = li.server_id AND epi.library_id = li.library_id`;
}

function buildCommonWhere(params: {
  type: LibraryMediaType;
  genre: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  searchNormalized: string | null;
  resolution: string | null;
  libraryServerId: string | null;
  libraryId: string | null;
  hdr: boolean;
  atmos: boolean;
  sizeGbMin: number | null;
  sizeGbMax: number | null;
  videoCodecs?: RawCodec[] | null;
  audioCodecs?: RawCodec[] | null;
  audioChannels?: RawCodec[] | null;
  serverFragmentLi: SQL;
}): SQL {
  const {
    type,
    genre,
    yearFrom,
    yearTo,
    searchNormalized,
    resolution,
    libraryServerId,
    libraryId,
    hdr,
    atmos,
    sizeGbMin,
    sizeGbMax,
    videoCodecs,
    audioCodecs,
    audioChannels,
    serverFragmentLi,
  } = params;
  const sizeMinBytes = sizeGbMin !== null ? Math.round(sizeGbMin * BYTES_PER_GB) : null;
  const sizeMaxBytes = sizeGbMax !== null ? Math.round(sizeGbMax * BYTES_PER_GB) : null;
  // "Has any version at": a 4K+1080p title matches both filters, agreeing
  // with the overlapping facet counts. The UI sends display case ('4K'/'SD');
  // resolutionBucket normalizes it.
  const resolutionFilterBucket = resolution ? (resolutionBucket(resolution) ?? 'sd') : null;
  // Strict bucket membership, no NULL-as-SD: sentinel versions carry NULL
  // resolution, and the display rule would make resolution=SD match everything.
  const resolutionFilter = !resolutionFilterBucket
    ? sql``
    : type === 'show'
      ? sql`AND EXISTS (
          SELECT 1 ${episodeVersionsScope('m.id')}
            AND ${resolutionBucketPredicate('v.video_resolution', resolutionFilterBucket)}
        )`
      : sql`AND EXISTS (
          SELECT 1 FROM library_item_versions liv
          WHERE liv.library_item_id = li.id AND liv.removed_at IS NULL
            AND ${resolutionBucketPredicate('liv.video_resolution', resolutionFilterBucket)}
        )`;
  const hdrFilter = !hdr
    ? sql``
    : type === 'show'
      ? sql`AND EXISTS (
          SELECT 1 ${episodeVersionsScope('m.id')}
            AND v.video_dynamic_range IS NOT NULL AND v.video_dynamic_range <> 'sdr'
        )`
      : sql`AND EXISTS (
          SELECT 1 FROM library_item_versions livh
          WHERE livh.library_item_id = li.id AND livh.removed_at IS NULL
            AND livh.video_dynamic_range IS NOT NULL AND livh.video_dynamic_range <> 'sdr'
        )`;
  const atmosFilter = !atmos
    ? sql``
    : type === 'show'
      ? sql`AND EXISTS (
          SELECT 1 ${episodeVersionsScope('m.id')}
            AND v.audio_atmos
        )`
      : sql`AND EXISTS (
          SELECT 1 FROM library_item_versions liva
          WHERE liva.library_item_id = li.id AND liva.removed_at IS NULL
            AND liva.audio_atmos
        )`;
  // "Has any file in": a title with an HEVC and an H.264 copy matches both.
  const codecFilter = (kind: CodecKind, rawCodecs: RawCodec[] | null | undefined): SQL => {
    if (!rawCodecs) return sql``;
    return type === 'show'
      ? sql`AND EXISTS (SELECT 1 ${episodeVersionsScope('m.id')} ${codecPredicate(kind, 'v', rawCodecs)})`
      : sql`AND EXISTS (
          SELECT 1 FROM library_item_versions livc
          WHERE livc.library_item_id = li.id AND livc.removed_at IS NULL
            ${codecPredicate(kind, 'livc', rawCodecs)}
        )`;
  };
  // Per-copy grain either way: a movie copy matches on its version-summed
  // rollup, a show copy on its episode total for that server + library - the
  // same figure the detail view reports for the copy.
  const sizeFilter =
    sizeMinBytes === null && sizeMaxBytes === null
      ? sql``
      : type === 'show'
        ? sql`AND (SELECT COALESCE(SUM(v.file_size), 0) ${episodeVersionsScope('m.id')} AND v.file_size IS NOT NULL)
              BETWEEN COALESCE(${sizeMinBytes}::bigint, 0) AND COALESCE(${sizeMaxBytes}::bigint, 9223372036854775807)`
        : sql`AND (${sizeMinBytes}::bigint IS NULL OR li.file_size >= ${sizeMinBytes}::bigint)
              AND (${sizeMaxBytes}::bigint IS NULL OR li.file_size <= ${sizeMaxBytes}::bigint)`;
  return sql`
    AND (${genre}::text IS NULL OR ${genre} = ANY(m.genres))
    AND (${yearFrom}::int IS NULL OR m.year >= ${yearFrom})
    AND (${yearTo}::int IS NULL OR m.year <= ${yearTo})
    AND (${searchNormalized}::text IS NULL OR m.normalized_title LIKE '%' || ${searchNormalized} || '%')
    AND EXISTS (
      SELECT 1 FROM library_items li
      WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}
        ${resolutionFilter}
        AND (${libraryServerId}::uuid IS NULL OR li.server_id = ${libraryServerId}::uuid)
        AND (${libraryId}::text IS NULL OR li.library_id = ${libraryId})
        ${hdrFilter}
        ${atmosFilter}
        ${codecFilter('video', videoCodecs)}
        ${codecFilter('audio', audioCodecs)}
        ${codecFilter('channels', audioChannels)}
        ${sizeFilter}
    )
  `;
}

/**
 * ORDER BY fragment for the poster_copy subquery (li already scoped to
 * thumb_path IS NOT NULL by the caller). A copy with a real image comes first,
 * so an untagged Jellyfin/Emby path never beats another server's poster. Then,
 * with a preferred server, booleans sort false < true so DESC puts a matching
 * copy first; when the preferred server has no poster row it simply isn't in
 * this set, so the newest-first tiebreak naturally falls back to the current
 * behavior. A preferred id that no longer matches any server (e.g. the server
 * was deleted) resolves the same way - no special-casing needed.
 */
export function buildPosterOrderFragment(preferredServerId: string | null | undefined): SQL {
  if (!preferredServerId) return sql`ORDER BY ${LI_HAS_KNOWN_IMAGE} DESC, li.created_at DESC`;
  return sql`ORDER BY ${LI_HAS_KNOWN_IMAGE} DESC, (li.server_id = ${preferredServerId}) DESC, li.created_at DESC`;
}

/** Base WHERE + ORDER BY for one sort variant, shared by the page and
 * candidates builders so a window and the letter rail can never disagree on
 * which rows exist at which positions. */
function buildSortedBody(params: {
  type: LibraryMediaType;
  sort: CatalogSort;
  commonWhere: SQL;
  selectExtra: SQL;
  fromExtra: SQL;
}): { body: SQL; needsRollup: boolean } {
  const { type, sort, commonWhere, selectExtra, fromExtra } = params;
  if (sort === 'title') {
    return {
      needsRollup: false,
      body: sql`
        SELECT m.id, m.media_type, m.title, m.year, m.genres, m.sort_title, m.latest_added_at ${selectExtra}
        FROM media m ${fromExtra}
        WHERE m.merged_into_id IS NULL
          AND m.media_type = ${type}
          ${commonWhere}
        ORDER BY m.sort_title, m.id
      `,
    };
  }
  // DESC NULLS LAST on the added/year branches is not a semantic choice (the
  // IS NOT NULL guard already excludes nulls): drizzle builds descending
  // index columns as DESC NULLS LAST, and a bare DESC (NULLS FIRST) ORDER BY
  // cannot ride those indexes - the planner falls back to bitmap + sort.
  if (sort === 'added') {
    return {
      needsRollup: false,
      body: sql`
        SELECT m.id, m.media_type, m.title, m.year, m.genres, m.sort_title, m.latest_added_at ${selectExtra}
        FROM media m ${fromExtra}
        WHERE m.merged_into_id IS NULL
          AND m.media_type = ${type}
          AND m.latest_added_at IS NOT NULL
          ${commonWhere}
        ORDER BY m.latest_added_at DESC NULLS LAST, m.id DESC NULLS LAST
      `,
    };
  }
  if (sort === 'year') {
    return {
      needsRollup: false,
      body: sql`
        SELECT m.id, m.media_type, m.title, m.year, m.genres, m.sort_title, m.latest_added_at ${selectExtra}
        FROM media m ${fromExtra}
        WHERE m.merged_into_id IS NULL
          AND m.media_type = ${type}
          AND m.year IS NOT NULL
          ${commonWhere}
        ORDER BY m.year DESC NULLS LAST, m.id DESC NULLS LAST
      `,
    };
  }
  const valueCol = VALUE_SORT_COLUMN[sort];
  return {
    needsRollup: true,
    body: sql`
      SELECT m.id, m.media_type, m.title, m.year, m.genres, m.sort_title, m.latest_added_at,
             COALESCE(vr.plays, 0) AS plays_value,
             COALESCE(vr.viewers, 0) AS viewers_value,
             COALESCE(vr.${sql.raw(valueCol)}, 0) AS value ${selectExtra}
      FROM media m
      LEFT JOIN value_rollup vr ON vr.canonical_id = m.id ${fromExtra}
      WHERE m.merged_into_id IS NULL
        AND m.media_type = ${type}
        ${commonWhere}
      ORDER BY COALESCE(vr.${sql.raw(valueCol)}, 0) DESC, m.id DESC
    `,
  };
}

/**
 * Distinct album titles under an artist's active copies in scope; lower()
 * folds the same album held on two servers into one.
 */
export function albumCountSql(artistIdCol: SQL, serverFragmentLi: SQL): SQL {
  return sql`(
    SELECT COUNT(DISTINCT lower(a.title))::int
    FROM library_items li
    JOIN library_items a ON a.server_id = li.server_id AND a.parent_rating_key = li.rating_key
      AND a.media_type = 'album' AND a.removed_at IS NULL
    WHERE li.media_id = ${artistIdCol} AND li.media_type = 'artist' AND li.removed_at IS NULL
      ${serverFragmentLi}
  )`;
}

/**
 * The per-row servers json_agg and poster pick for a media row aliased `rowAlias`. A show's
 * copies carry no files, so its size and best resolution roll up its episodes.
 */
export function rowDecorationsSql(
  rowAlias: string,
  serverFragmentLi: SQL,
  posterOrderFragment: SQL
): SQL {
  const row = sql.raw(rowAlias);
  return sql`
      (SELECT json_agg(json_build_object(
          'serverId', li.server_id, 'addedAt', li.created_at,
          'videoResolution', CASE WHEN ${row}.media_type = 'show' THEN (
            SELECT v.video_resolution ${episodeVersionsScope(`${rowAlias}.id`)}
              AND v.video_resolution IS NOT NULL
            ORDER BY ${resolutionRankSql('v.video_resolution')} DESC LIMIT 1
          ) ELSE li.video_resolution END,
          'fileSize', CASE WHEN ${row}.media_type = 'show' THEN (
            SELECT SUM(v.file_size) ${episodeVersionsScope(`${rowAlias}.id`)} AND v.file_size IS NOT NULL
          ) ELSE li.file_size END,
          'versionCount', li.version_count)
          ORDER BY li.created_at DESC)
       FROM library_items li
       WHERE li.media_id = ${row}.id AND li.removed_at IS NULL ${serverFragmentLi}) AS servers,
      (SELECT json_build_object('thumbPath', li.thumb_path, 'dominantColor', li.dominant_color,
                                'serverId', li.server_id)
       FROM library_items li
       WHERE li.media_id = ${row}.id AND li.removed_at IS NULL AND li.thumb_path IS NOT NULL ${serverFragmentLi}
       ${posterOrderFragment} LIMIT 1) AS poster_copy`;
}

/** Attaches the row decorations and, for artists, album count to a page CTE. */
function withRowDecorations(
  type: LibraryMediaType,
  pageCte: SQL,
  serverFragmentLi: SQL,
  posterOrderFragment: SQL
): SQL {
  const albumCount =
    type === 'artist' ? sql`, ${albumCountSql(sql`p.id`, serverFragmentLi)} AS album_count` : sql``;
  return sql`
    ${pageCte}
    SELECT p.*,${rowDecorationsSql('p', serverFragmentLi, posterOrderFragment)}${albumCount}
    FROM page p
  `;
}

/**
 * One offset window of the sorted, filtered catalog. OFFSET materializes and
 * walks the ordering to the window start instead of seeking like a keyset
 * predicate would, but every ORDER BY here is index-backed
 * (idx_media_type_sort_title_id / idx_media_type_added_active) so the walk
 * is an index range scan, cheap far beyond the 50k-item design scale - and
 * it's the only mode that can serve a letter jump into an arbitrary depth.
 */
export function buildCatalogPageQuery(params: CatalogPageQueryParams): SQL {
  const { type, sort, offset, serverIds, scope, pageSize, preferredPosterServerId } = params;
  const posterOrderFragment = buildPosterOrderFragment(preferredPosterServerId);
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const commonWhere = buildCommonWhere({ ...params, serverFragmentLi });
  const { body, needsRollup } = buildSortedBody({
    type,
    sort,
    commonWhere,
    selectExtra: sql``,
    fromExtra: sql``,
  });
  const pageBody = sql`${body} LIMIT ${pageSize} OFFSET ${offset}`;
  const pageCte = needsRollup
    ? sql`WITH ${buildValueRollupCte(type, serverIds, undefined)}, page AS (${pageBody})`
    : sql`WITH page AS (${pageBody})`;
  return withRowDecorations(type, pageCte, serverFragmentLi, posterOrderFragment);
}

/**
 * Same predicates as the page query for the requested sort, no window: one
 * COUNT + SUM. The added/year sorts exclude rows whose ordering key is NULL,
 * and totals must mirror that - the client sizes a fixed-total virtualized
 * grid from totalItems, so a row the sort can never reach would render as a
 * permanent skeleton at the tail. This is O(catalog) work (the size subquery
 * runs per matching row); callers cache the result, never run it per page.
 */
export function buildCatalogTotalsQuery(params: CatalogTotalsQueryParams): SQL {
  const { type, sort, serverIds, scope } = params;
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  // The file-size subquery aliases library_items as li2, not li - it needs its
  // own fragment, or a server-scoped request 500s on a missing FROM-clause
  // entry for li.server_id.
  const serverFragmentLi2 = libraryFragment(serverIds, scope, 'li2');
  const commonWhere = buildCommonWhere({ ...params, serverFragmentLi });
  const sortGuard =
    sort === 'added'
      ? sql`AND m.latest_added_at IS NOT NULL`
      : sort === 'year'
        ? sql`AND m.year IS NOT NULL`
        : sql``;
  return sql`
    SELECT COUNT(*)::bigint AS total_items,
           COALESCE(SUM(${mediaSizeSubquery(sql`m.id`, serverFragmentLi2)}), 0)::bigint AS total_file_size
    FROM media m
    WHERE m.merged_into_id IS NULL
      AND m.media_type = ${type}
      ${sortGuard}
      ${commonWhere}
  `;
}

interface CatalogTotals {
  totalItems: number;
  totalFileSize: number;
}

/** Runs the totals query and fills the cache - the single-flight lock in
 * getCatalogTotals guards against concurrent duplication of this. */
async function computeCatalogTotals(
  redis: Redis,
  cacheKey: string,
  params: CatalogTotalsQueryParams
): Promise<CatalogTotals> {
  const result = await db.execute(buildCatalogTotalsQuery(params));
  const row = result.rows[0] as { total_items: string; total_file_size: string } | undefined;
  const totals: CatalogTotals = {
    totalItems: Number(row?.total_items ?? 0),
    totalFileSize: Number(row?.total_file_size ?? 0),
  };
  await redis.setex(cacheKey, CACHE_TTL.LIBRARY_CATALOG_LETTERS, JSON.stringify(totals));
  return totals;
}

/** Redis-cached totals per (scope, filters, sort-guard class). The guard
 * class, not the sort itself, keys the cache: title/plays/watch_time/viewers
 * share identical totals, so they share one entry. Single-flighted like
 * getWatchedCandidates: a page fetch and a letters fetch for the same filter
 * set routinely land in the same request burst. */
async function getCatalogTotals(
  redis: Redis,
  params: CatalogTotalsQueryParams
): Promise<CatalogTotals> {
  const serverKey = params.serverIds !== undefined ? [...params.serverIds].sort().join(',') : 'all';
  const guardClass = params.sort === 'added' ? 'added' : params.sort === 'year' ? 'year' : 'none';
  const filterKey = [guardClass, ...filterKeyParts(params)].join('|');
  const cacheKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_CATALOG_TOTALS, serverKey, filterKey);
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as CatalogTotals;
    } catch {
      // Fall through to compute.
    }
  }

  return withComputeSingleFlight(
    redis,
    cacheKey,
    () => computeCatalogTotals(redis, cacheKey, params),
    (raw) => JSON.parse(raw) as CatalogTotals
  );
}

/**
 * Letter-bucket CASE over sort_title, by collation range comparison: bucket
 * 'A' is 'a' <= sort_title < 'b', anything below 'a' (digits, empty) is '#',
 * anything at or above 'z' is 'Z'. Never derived from the first character:
 * an accent-leading title ('émilie') sorts inside E's range under
 * en_US.utf8, and only the range rule keeps each bucket contiguous in the
 * order the catalog pages actually walk - a first-character rule would file
 * it under '#' at a position in the middle of the list and every cumulative
 * offset after it would point one row off.
 */
export function buildLetterBucketCase(): SQL {
  const whens: SQL[] = [sql`WHEN m.sort_title < 'a' THEN '#'`];
  for (let i = 0; i < LETTER_RAIL_ALPHABET.length - 1; i++) {
    const letter = LETTER_RAIL_ALPHABET[i] as string;
    const nextLower = (LETTER_RAIL_ALPHABET[i + 1] as string).toLowerCase();
    whens.push(sql`WHEN m.sort_title < ${nextLower} THEN ${letter}`);
  }
  return sql`CASE ${sql.join(whens, sql` `)} ELSE 'Z' END`;
}

export interface CatalogFilterParams {
  type: LibraryMediaType;
  genre: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  searchNormalized: string | null;
  resolution: string | null;
  libraryServerId: string | null;
  libraryId: string | null;
  hdr: boolean;
  atmos: boolean;
  sizeGbMin: number | null;
  sizeGbMax: number | null;
  /** Raw stored codec values from resolveRawCodecs; null or absent means no filter. */
  videoCodecs?: RawCodec[] | null;
  audioCodecs?: RawCodec[] | null;
  audioChannels?: RawCodec[] | null;
  serverIds: string[] | undefined;
  /** Narrows a member's titles to the libraries their accounts can open */
  scope: Scope;
}

/** Cache-key segment for every filter predicate, shared by the totals,
 * letters and watched-candidates caches so a new filter can't be left out of
 * one of them. An empty codec list (a name matching nothing) keys apart from
 * no codec filter. */
function filterKeyParts(params: CatalogFilterParams): (string | number)[] {
  return [
    params.type,
    params.genre ?? '',
    params.yearFrom ?? '',
    params.yearTo ?? '',
    params.resolution ?? '',
    params.searchNormalized ?? '',
    params.libraryServerId ?? '',
    params.libraryId ?? '',
    params.hdr ? 'hdr' : '',
    params.atmos ? 'atmos' : '',
    params.sizeGbMin ?? '',
    params.sizeGbMax ?? '',
    params.videoCodecs ? `v:${params.videoCodecs.join(',')}` : '',
    params.audioCodecs ? `a:${params.audioCodecs.join(',')}` : '',
    params.audioChannels ? `c:${params.audioChannels.join(',')}` : '',
    libraryCacheSegment(params.scope),
  ];
}

/** Per-letter counts straight from SQL, for the no-watched-filter path. */
export function buildLetterCountsQuery(params: CatalogFilterParams): SQL {
  const { type, serverIds, scope } = params;
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const commonWhere = buildCommonWhere({ ...params, serverFragmentLi });
  return sql`
    SELECT ${buildLetterBucketCase()} AS letter, COUNT(*)::int AS count
    FROM media m
    WHERE m.merged_into_id IS NULL
      AND m.media_type = ${type}
      ${commonWhere}
    GROUP BY 1
  `;
}

/**
 * Ordered (id, letter) candidate list for one sort variant - the input to
 * the watched-filter probe. Must share buildSortedBody/buildCommonWhere with
 * the page query: any drift would put the filtered list's positions out of
 * step with what a page window at that offset returns.
 */
export function buildCatalogCandidatesQuery(
  params: CatalogFilterParams & { sort: CatalogSort }
): SQL {
  const { type, sort, serverIds, scope } = params;
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const commonWhere = buildCommonWhere({ ...params, serverFragmentLi });
  const { body, needsRollup } = buildSortedBody({
    type,
    sort,
    commonWhere,
    selectExtra: sql`, ${buildLetterBucketCase()} AS letter`,
    fromExtra: sql``,
  });
  if (!needsRollup) return body;
  return sql`WITH ${buildValueRollupCte(type, serverIds, undefined)} ${body}`;
}

/** Fixed 27-entry bucket set, '#' first then A-Z, zero counts included - the
 * frontend needs a complete, stably-ordered key set to build cumulative
 * letter -> offset without special-casing an absent letter. '#' leads
 * because everything below 'a' (digit-leading and empty sort titles) sorts
 * before every letter under the catalog's collation. */
export function buildLetterBuckets(counts: Map<string, number>): CatalogLetterBucket[] {
  return ['#', ...LETTER_RAIL_ALPHABET].map((letter) => ({
    letter,
    count: counts.get(letter) ?? 0,
  }));
}

async function fetchPageEngagement(
  ids: string[],
  type: LibraryMediaType,
  serverIds: string[] | undefined
): Promise<Map<string, { plays: number; viewers: number }>> {
  const result = new Map<string, { plays: number; viewers: number }>();
  if (ids.length === 0) return result;
  const expandedIds = await expandMediaAliases(ids);
  // Empty only if every id vanished between the page fetch and here (a
  // concurrent delete) - an unfiltered idsFilter would scan the whole cagg
  // instead of returning nothing, so bail out rather than fall through.
  if (expandedIds.length === 0) return result;
  const cte = buildValueRollupCte(type, serverIds, expandedIds);
  const rows = await db.execute(sql`
    WITH ${cte}
    SELECT canonical_id, plays, viewers FROM value_rollup
  `);
  for (const row of rows.rows as unknown as {
    canonical_id: string;
    plays: string;
    viewers: string;
  }[]) {
    result.set(row.canonical_id, { plays: Number(row.plays), viewers: Number(row.viewers) });
  }
  return result;
}

/** The watched probe is designed for page-sized batches (its alias CTE and
 * lateral probes are per-id); feeding it a whole catalog in one call is the
 * kind of unbounded statement that falls over at scale, so candidates go
 * through in fixed chunks. */
export const WATCHED_PROBE_CHUNK = 100;

async function resolveWatchedStatesChunked(
  ids: string[],
  type: LibraryMediaType,
  serverIds: string[] | undefined,
  lensUserId: string | null
): Promise<Map<string, WatchedState>> {
  const result = new Map<string, WatchedState>();
  for (let i = 0; i < ids.length; i += WATCHED_PROBE_CHUNK) {
    const chunk = ids.slice(i, i + WATCHED_PROBE_CHUNK);
    const episodeCounts =
      type === 'show' ? await fetchEpisodeCounts(chunk, serverIds) : new Map<string, number>();
    const states = await resolveWatchedStates({
      movieIds: type === 'movie' ? chunk : [],
      showIds: type === 'show' ? chunk : [],
      serverIds,
      lensUserId,
      episodeCounts,
    });
    for (const [id, state] of states) result.set(id, state);
  }
  return result;
}

/** Set-based mirror of mediaSizeSubquery for a known id list: mirrors of the
 * same rendition (identical media_id + file_size) count once, distinct
 * renditions add up, shows roll up their episodes. */
async function fetchTotalFileSizeForIds(
  ids: string[],
  serverIds: string[] | undefined,
  scope: Scope
): Promise<number> {
  if (ids.length === 0) return 0;
  const serverFragmentLi2 = libraryFragment(serverIds, scope, 'li2');
  let total = 0;
  // Chunked so the ARRAY literal stays bounded no matter the catalog size; a
  // media id appears in exactly one chunk (and a show's episodes key on that
  // show's id), so chunk sums never overlap.
  const CHUNK = 5000;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = uuidArraySql(ids.slice(i, i + CHUNK));
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(sz), 0)::bigint AS total FROM (
        SELECT DISTINCT li2.media_id, v.file_size AS sz
        FROM library_items li2
        JOIN library_item_versions v
          ON v.library_item_id = li2.id AND v.removed_at IS NULL AND v.file_size IS NOT NULL
        JOIN media im ON im.id = li2.media_id
        WHERE (
            (im.id = ANY(${chunk}) AND im.media_type <> 'show')
            OR im.show_media_id = ANY(${chunk})
          )
          AND li2.removed_at IS NULL ${serverFragmentLi2}
      ) d
    `);
    total += Number((result.rows[0] as { total: string } | undefined)?.total ?? 0);
  }
  return total;
}

export interface WatchedCandidates {
  /** Canonical ids in the requested sort order, watched-filter applied. */
  ids: string[];
  /** Rail bucket per id, aligned with ids ('#' or 'A'..'Z'). */
  letters: string[];
  totalFileSize: number;
}

interface WatchedCandidatesArgs extends CatalogFilterParams {
  sort: CatalogSort;
  lensUserId: string | null;
  watched: WatchedState;
}

// A lens is one person's plays, so its entries carry the member segment and go when clearScope
// clears that person after a merge or split.
function watchedCandidatesCacheKey(args: WatchedCandidatesArgs): string {
  const serverKey = args.serverIds !== undefined ? [...args.serverIds].sort().join(',') : 'all';
  const filterKey = [args.sort, ...filterKeyParts(args), args.watched].join('|');
  const lensKey = args.lensUserId ? `:member:${args.lensUserId}` : '';
  return `${buildLibraryCacheKey(REDIS_KEYS.LIBRARY_CATALOG_WATCHED, serverKey, filterKey)}${lensKey}`;
}

/** Runs the candidates query and the watched probe rounds, uncached - the
 * expensive body getWatchedCandidates' single-flight lock guards against
 * concurrent duplication. */
async function computeWatchedCandidates(args: WatchedCandidatesArgs): Promise<WatchedCandidates> {
  const candidatesResult = await db.execute(buildCatalogCandidatesQuery(args));
  const candidates = candidatesResult.rows as unknown as { id: string; letter: string }[];
  const states = await resolveWatchedStatesChunked(
    candidates.map((row) => row.id),
    args.type,
    args.serverIds,
    args.lensUserId
  );
  const surviving = candidates.filter((row) => states.get(row.id) === args.watched);
  const ids = surviving.map((row) => row.id);
  return {
    ids,
    letters: surviving.map((row) => row.letter),
    totalFileSize: await fetchTotalFileSizeForIds(ids, args.serverIds, args.scope),
  };
}

/**
 * The single source of truth for a watched-filtered catalog: the full
 * ordered id list surviving the probe, with per-id rail buckets and the
 * filtered total file size. Both /catalog (slice a window out of it) and
 * /catalog/letters (bucket-count it) read the same cached value, which is
 * what makes a rail offset and a page window provably agree. Cold cost is
 * one candidates query plus ceil(n / WATCHED_PROBE_CHUNK) probe rounds -
 * at the 50k design ceiling that's a slow first hit (hundreds of ms), then
 * served from Redis for CACHE_TTL.LIBRARY_CATALOG_LETTERS.
 *
 * A cold cache miss single-flights through withComputeSingleFlight: a page
 * fetch and a letters fetch for the same filter set routinely land in the
 * same request burst, and without the lock both would run the full compute
 * concurrently instead of the second one reusing the first's result.
 */
async function getWatchedCandidates(
  redis: Redis,
  args: WatchedCandidatesArgs
): Promise<WatchedCandidates> {
  const cacheKey = watchedCandidatesCacheKey(args);
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as WatchedCandidates;
    } catch {
      // Fall through to compute.
    }
  }

  return withComputeSingleFlight(
    redis,
    cacheKey,
    async () => {
      const result = await computeWatchedCandidates(args);
      await redis.setex(cacheKey, CACHE_TTL.LIBRARY_CATALOG_LETTERS, JSON.stringify(result));
      return result;
    },
    (raw) => JSON.parse(raw) as WatchedCandidates
  );
}

/** Hydrates display rows for an already-ordered id window (the watched
 * path); output preserves the input order. */
async function fetchRowsByIds(
  type: LibraryMediaType,
  ids: string[],
  serverIds: string[] | undefined,
  scope: Scope,
  preferredPosterServerId: string | null | undefined
): Promise<RawCatalogRow[]> {
  if (ids.length === 0) return [];
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const posterOrderFragment = buildPosterOrderFragment(preferredPosterServerId);
  const pageCte = sql`WITH page AS (
    SELECT m.id, m.media_type, m.title, m.year, m.genres, m.sort_title, m.latest_added_at
    FROM media m
    WHERE m.id = ANY(${uuidArraySql(ids)})
  )`;
  const result = await db.execute(
    withRowDecorations(type, pageCte, serverFragmentLi, posterOrderFragment)
  );
  const byId = new Map((result.rows as unknown as RawCatalogRow[]).map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is RawCatalogRow => row !== undefined);
}

export function pickBestResolution(servers: { videoResolution: string | null }[]): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const server of servers) {
    const rank = resolutionTierRank(server.videoResolution) ?? 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = server.videoResolution;
    }
  }
  return best;
}

/** Proxy URL and cache version for one copy's art; both null when it has none. */
export function posterFor(
  serverId: string | null | undefined,
  thumbPath: string | null | undefined,
  size: { width: number; height: number } = POSTER_IMAGE_SIZE
): Pick<CatalogRow, 'posterUrl' | 'posterVersion'> {
  const posterVersion = thumbPath ? posterVersionFor(thumbPath) : null;
  const posterUrl =
    thumbPath && serverId && posterVersion
      ? buildProxyUrl({
          serverId,
          path: thumbPath,
          ...size,
          version: posterVersion,
          fallback: 'poster',
        })
      : null;
  return { posterUrl, posterVersion };
}

function toCatalogRow(
  row: RawCatalogRow,
  watchedState: WatchedState,
  watchedStateSelf: WatchedState,
  engagement: { plays: number; viewers: number }
): CatalogRow {
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
    watchedState,
    ...(row.media_type === 'artist' ? { albumCount: row.album_count ?? 0 } : { watchedStateSelf }),
    plays: engagement.plays,
    viewers: engagement.viewers,
  };
}

/** The request's filters in builder form: library key split, search
 * normalized, codec display names expanded to their raw stored values. */
async function toFilterParams(
  data: z.infer<typeof catalogLettersQuerySchema>,
  serverIds: string[] | undefined,
  scope: Scope
): Promise<CatalogFilterParams> {
  const library = parseLibraryKey(data.libraryKey);
  const [videoCodecs, audioCodecs, audioChannels] = await Promise.all([
    resolveRawCodecs('video', data.videoCodec),
    resolveRawCodecs('audio', data.audioCodec),
    resolveRawCodecs('channels', data.audioChannels),
  ]);
  return {
    type: data.type,
    genre: data.genre ?? null,
    yearFrom: data.yearFrom ?? null,
    yearTo: data.yearTo ?? null,
    // A punctuation-only search (e.g. "...") normalizes to '' - treat that
    // the same as no search rather than a LIKE '%%' that matches everything.
    searchNormalized: data.search ? normalizeTitle(data.search) || null : null,
    resolution: data.resolution ?? null,
    libraryServerId: library?.serverId ?? null,
    libraryId: library?.libraryId ?? null,
    hdr: data.hdr,
    atmos: data.atmos,
    sizeGbMin: data.sizeGbMin ?? null,
    sizeGbMax: data.sizeGbMax ?? null,
    videoCodecs,
    audioCodecs,
    audioChannels,
    serverIds,
    scope,
  };
}

export const libraryCatalogRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /catalog - Offset-windowed canonical-media browse feed.
   */
  app.get<{ Querystring: Record<string, unknown> }>(
    '/catalog',
    { preHandler: [app.requirePermission('media', 'read')] },
    async (request, reply) => {
      const query = catalogPageQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const {
        type,
        serverId,
        serverIds,
        watched,
        lens,
        sort: requestedSort,
        offset,
        pageSize,
      } = query.data;
      const authUser = request.user;

      // Guard 1: server scope, fail-closed (throws ForbiddenError on an
      // explicit serverId the caller can't reach). serverIds takes
      // precedence over serverId when both are provided.
      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

      // Guard 2: lens identity must have at least one account within scope.
      const browse = await viewerBrowse(request.scope, lens, requestedSort);
      if (!browse) return reply.notFound();
      const { lensUserId, sort } = browse;
      if (lensUserId !== null) {
        const serverFragment = buildMultiServerFragment(resolvedIds, 'server_id');
        const hasAccess =
          resolvedIds?.length === 0
            ? false
            : (
                await db.execute(
                  sql`SELECT 1 FROM server_users WHERE user_id = ${lensUserId}::uuid ${serverFragment} LIMIT 1`
                )
              ).rows.length > 0;
        if (!hasAccess) {
          return reply.forbidden(
            'You do not have access to this identity within the requested scope'
          );
        }
      }

      const preferredPosterServerId = await getSetting('preferredPosterServerId');
      const filterParams = await toFilterParams(query.data, resolvedIds, request.scope);

      let rows: RawCatalogRow[];
      let watchedStates: Map<string, WatchedState>;
      // Same probe, scoped to the requesting admin's own identity instead of
      // the lens - "watched" always means anyone now, and this is the
      // per-card "have I personally seen this" overlay. It derives from the
      // existing per-user plays rollup (nothing new is tracked), so an admin
      // with no linked media-server account simply probes to 'unwatched'.
      let watchedStatesSelf: Map<string, WatchedState>;
      let totalItems: number;
      let totalFileSize: number;

      if (watched) {
        const candidates = await getWatchedCandidates(app.redis, {
          ...filterParams,
          sort,
          lensUserId,
          watched,
        });
        totalItems = candidates.ids.length;
        totalFileSize = candidates.totalFileSize;
        const windowIds = candidates.ids.slice(offset, offset + pageSize);
        const [windowRows, selfEpisodeCounts] = await Promise.all([
          fetchRowsByIds(type, windowIds, resolvedIds, request.scope, preferredPosterServerId),
          type === 'show'
            ? fetchEpisodeCounts(windowIds, resolvedIds)
            : Promise.resolve(new Map<string, number>()),
        ]);
        rows = windowRows;
        // Every id in the window already passed the probe with this exact
        // watched value; re-probing the page would only re-derive it.
        watchedStates = new Map(windowIds.map((id) => [id, watched]));
        watchedStatesSelf =
          windowIds.length > 0
            ? await resolveWatchedStates({
                movieIds: type === 'movie' ? windowIds : [],
                showIds: type === 'show' ? windowIds : [],
                serverIds: resolvedIds,
                lensUserId: authUser.userId,
                episodeCounts: selfEpisodeCounts,
              })
            : new Map<string, WatchedState>();
      } else {
        const pageQuery = buildCatalogPageQuery({
          ...filterParams,
          sort,
          offset,
          pageSize,
          preferredPosterServerId,
        });
        const [pageResult, totals] = await Promise.all([
          db.execute(pageQuery),
          getCatalogTotals(app.redis, { ...filterParams, sort }),
        ]);
        rows = pageResult.rows as unknown as RawCatalogRow[];
        totalItems = totals.totalItems;
        totalFileSize = totals.totalFileSize;
        const episodeCounts =
          type === 'show'
            ? await fetchEpisodeCounts(
                rows.map((row) => row.id),
                resolvedIds
              )
            : new Map<string, number>();
        const movieIds = type === 'movie' ? rows.map((row) => row.id) : [];
        const showRowIds = type === 'show' ? rows.map((row) => row.id) : [];
        if (rows.length > 0) {
          // Self probe reuses the same episodeCounts already fetched above
          // for the anyone-grain probe rather than fetching them twice.
          [watchedStates, watchedStatesSelf] = await Promise.all([
            resolveWatchedStates({
              movieIds,
              showIds: showRowIds,
              serverIds: resolvedIds,
              lensUserId,
              episodeCounts,
            }),
            resolveWatchedStates({
              movieIds,
              showIds: showRowIds,
              serverIds: resolvedIds,
              lensUserId: authUser.userId,
              episodeCounts,
            }),
          ]);
        } else {
          watchedStates = new Map();
          watchedStatesSelf = new Map();
        }
      }

      const needsEngagementLookup = !POPULARITY_SORTS.has(sort);
      const engagement =
        browse.showActivity && (needsEngagementLookup || watched)
          ? await fetchPageEngagement(
              rows.map((row) => row.id),
              type,
              resolvedIds
            )
          : null;

      const data: CatalogRow[] = rows.map((row) => {
        const rowEngagement = !browse.showActivity
          ? { plays: 0, viewers: 0 }
          : engagement
            ? (engagement.get(row.id) ?? { plays: 0, viewers: 0 })
            : { plays: Number(row.plays_value ?? 0), viewers: Number(row.viewers_value ?? 0) };
        return toCatalogRow(
          row,
          watchedStates.get(row.id) ?? 'unwatched',
          watchedStatesSelf.get(row.id) ?? 'unwatched',
          rowEngagement
        );
      });

      const response: CatalogResponse = {
        data,
        meta: {
          offset,
          pageSize,
          totalItems,
          totalFileSize,
        },
      };

      return response;
    }
  );

  /**
   * GET /catalog/letters - Per-first-letter title counts for the alphabet
   * rail, same filter set as GET /catalog.
   */
  app.get<{ Querystring: Record<string, unknown> }>(
    '/catalog/letters',
    { preHandler: [app.requirePermission('media', 'read')] },
    async (request, reply) => {
      const query = catalogLettersQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { serverId, serverIds, watched, lens, sort: requestedSort } = query.data;
      const authUser = request.user;

      // Same server-scope and lens-access guards as GET /catalog.
      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

      const browse = await viewerBrowse(request.scope, lens, requestedSort);
      if (!browse) return reply.notFound();
      const { lensUserId, sort } = browse;
      if (lensUserId !== null) {
        const serverFragment = buildMultiServerFragment(resolvedIds, 'server_id');
        const hasAccess =
          resolvedIds?.length === 0
            ? false
            : (
                await db.execute(
                  sql`SELECT 1 FROM server_users WHERE user_id = ${lensUserId}::uuid ${serverFragment} LIMIT 1`
                )
              ).rows.length > 0;
        if (!hasAccess) {
          return reply.forbidden(
            'You do not have access to this identity within the requested scope'
          );
        }
      }

      // Bucket boundaries only line up with the catalog page's row order
      // under sort=title (every other sort orders by a value unrelated to
      // the title alphabet) - contract: any other sort returns an empty
      // bucket set with no DB hit, rather than a 400, so the frontend can
      // pass through whatever sort is currently active without branching.
      if (sort !== 'title') {
        const response: CatalogLettersResponse = { letters: [] };
        return response;
      }

      const filterParams = await toFilterParams(query.data, resolvedIds, request.scope);

      if (watched) {
        // Shares the exact cached candidate list the catalog windows slice,
        // so rail offsets and page contents can't disagree.
        const candidates = await getWatchedCandidates(app.redis, {
          ...filterParams,
          sort: 'title',
          lensUserId,
          watched,
        });
        const counts = new Map<string, number>();
        for (const letter of candidates.letters) {
          counts.set(letter, (counts.get(letter) ?? 0) + 1);
        }
        const response: CatalogLettersResponse = { letters: buildLetterBuckets(counts) };
        return response;
      }

      const serverCacheKey = resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all';
      const filterKey = filterKeyParts(filterParams).join('|');
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_CATALOG_LETTERS,
        serverCacheKey,
        filterKey
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as CatalogLettersResponse;
        } catch {
          // Fall through to compute.
        }
      }

      const countsResult = await db.execute(buildLetterCountsQuery(filterParams));
      const counts = new Map<string, number>();
      for (const row of countsResult.rows as unknown as { letter: string; count: number }[]) {
        counts.set(row.letter, Number(row.count));
      }

      const response: CatalogLettersResponse = { letters: buildLetterBuckets(counts) };
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_CATALOG_LETTERS, JSON.stringify(response));

      return response;
    }
  );

  /**
   * GET /catalog/codecs - Video and audio codecs present among the browse
   * type's files in scope, as the codec charts name them, for the filters.
   */
  app.get<{ Querystring: Record<string, unknown> }>(
    '/catalog/codecs',
    { preHandler: [app.requirePermission('media', 'read')] },
    async (request, reply) => {
      const query = catalogCodecsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { type, serverId, serverIds } = query.data;
      const resolvedIds = resolveServerIds(request.user, serverId, serverIds);
      const response: CatalogCodecOptionsResponse = await fetchCodecOptions(
        type,
        resolvedIds,
        request.scope
      );
      return response;
    }
  );
};
