/**
 * Library query module: SQL shared by the library routes and the public API.
 */

import { sql, type SQL } from 'drizzle-orm';
import { TIME_MS, type LibraryMediaType } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { countedViewersSql, lastDaysWindow, rollupDayWindowSql } from '../../db/sessions/rules.js';
import { encodeRankCursor } from '../../utils/cursor.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import { startOfUtcDay } from '../../services/stats/windows.js';
import { ARTIST_OF_TRACK } from './utils.js';
import type { DateRange } from '../stats/utils.js';

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
 * time/viewer counts per canonical media id, plus the last day with a counted
 * play. The window runs from dateRange's start through the UTC day holding its
 * end, so a preset covers N UTC days ending today and a custom range its first
 * to last day; without a dateRange it is the last 30 days. Unbounded across the
 * catalog when idsFilter is omitted (drives the plays/watch_time/viewers
 * sorts); bounded to a specific id set for page-batched display fields
 * otherwise - idsFilter must already be alias-expanded (see
 * expandMediaAliases), since it filters mediaCol directly for sargability
 * instead of matching through the COALESCE that resolves a row back to its
 * canonical id.
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
    // The type predicate lets the planner estimate the join and hash-join media.
    show: sql`AND p.show_media_id IS NOT NULL AND am.media_type = 'show'`,
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
  const window = dateRange
    ? {
        startDate: dateRange.start,
        endDate: new Date(startOfUtcDay(dateRange.end) + TIME_MS.DAY),
      }
    : lastDaysWindow(30);
  return sql`
    value_rollup AS (
      SELECT COALESCE(am.merged_into_id, ${mediaCol}) AS canonical_id,
             COUNT(DISTINCT p.chain_id) FILTER (WHERE p.counted)::bigint AS plays,
             SUM(p.watched_ms)::bigint AS watch_time_ms,
             ${countedViewersSql(sql`p.counted`)}::bigint AS viewers,
             MAX(p.day) FILTER (WHERE p.counted) AS last_day
      FROM user_media_plays_daily p
      ${artistJoin}
      JOIN media am ON am.id = ${mediaCol}
      JOIN server_users su ON su.id = p.server_user_id
      WHERE 1=1 ${rollupDayWindowSql(window, sql`p.day`)} ${typeGuard} ${serverFragment} ${idsFragment}
      GROUP BY COALESCE(am.merged_into_id, ${mediaCol})
    )
  `;
}

export type TopMediaSort = 'plays' | 'watch_time' | 'viewers';

export interface TopMediaRow {
  media_id: string;
  media_type: 'movie' | 'show';
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  plays: number;
  watch_time_ms: number;
  unique_users: number;
  last_watched_day: string;
}

interface RawTopMediaRow {
  media_id: string;
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  plays: string;
  watch_time_ms: string;
  unique_users: string;
  last_watched_day: string;
  sort_value: string;
}

// A watched-flag play with no duration adds NULL watch time, so a title can sum to NULL.
const TOP_MEDIA_SORT: Record<TopMediaSort, SQL> = {
  plays: sql`plays`,
  watch_time: sql`COALESCE(watch_time_ms, 0)`,
  viewers: sql`viewers`,
};

/**
 * One page of canonical movies or shows ranked by plays, watch time or viewers over the last
 * `days` UTC days, keyset-paged on the sort value then the id. Only titles with a counted play
 * in the window appear, and each row's numbers are the media stats ones for the same window.
 */
export async function listTopMedia(args: {
  kind: 'movie' | 'show';
  days: number;
  serverIds: string[] | undefined;
  sort: TopMediaSort;
  pageSize: number;
  after: { value: number; id: string } | null;
}): Promise<{ data: TopMediaRow[]; nextCursor: string | null }> {
  const { startDate, endDate } = lastDaysWindow(args.days);
  const cte = buildValueRollupCte(args.kind, args.serverIds, undefined, {
    start: startDate,
    end: endDate,
  });
  const sortValue = TOP_MEDIA_SORT[args.sort];
  const afterFragment = args.after
    ? sql`AND (${sortValue}, canonical_id) < (${args.after.value}, ${args.after.id}::uuid)`
    : sql``;
  const result = await db.execute(sql`
    WITH ${cte},
    page AS (
      SELECT canonical_id, plays, ${TOP_MEDIA_SORT.watch_time} AS watch_time_ms, viewers, last_day,
        ${sortValue} AS sort_value
      FROM value_rollup
      WHERE plays > 0 ${afterFragment}
      ORDER BY ${sortValue} DESC, canonical_id DESC
      LIMIT ${args.pageSize + 1}
    )
    SELECT page.canonical_id AS media_id, m.title, m.year, m.imdb_id, m.tmdb_id, m.tvdb_id,
      page.plays, page.watch_time_ms, page.viewers AS unique_users,
      (page.last_day AT TIME ZONE 'utc')::date::text AS last_watched_day, page.sort_value
    FROM page
    JOIN media m ON m.id = page.canonical_id
    ORDER BY page.sort_value DESC, page.canonical_id DESC
  `);
  const rows = result.rows as unknown as RawTopMediaRow[];
  const pageRows = rows.slice(0, args.pageSize);
  const last = pageRows[pageRows.length - 1];
  return {
    data: pageRows.map((row) => ({
      media_id: row.media_id,
      media_type: args.kind,
      title: row.title,
      year: row.year,
      imdb_id: row.imdb_id,
      tmdb_id: row.tmdb_id,
      tvdb_id: row.tvdb_id,
      plays: Number(row.plays),
      watch_time_ms: Number(row.watch_time_ms),
      unique_users: Number(row.unique_users),
      last_watched_day: row.last_watched_day,
    })),
    nextCursor:
      rows.length > args.pageSize && last
        ? encodeRankCursor(Number(last.sort_value), last.media_id)
        : null,
  };
}
