import { sql, type SQL } from 'drizzle-orm';
import type { WatchedState } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { encodeCursor } from '../../utils/cursor.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';

export interface WatchedProbeArgs {
  /** Canonical movie media ids, page-batched (caller keeps <=100). */
  movieIds: string[];
  /** Canonical show media ids. */
  showIds: string[];
  /** Resolved server scope; undefined means owner/all. */
  serverIds: string[] | undefined;
  /** Identity user id to scope by; null means aggregate across all users. */
  lensUserId: string | null;
  /** showId -> known episode count, supplied by the caller. */
  episodeCounts: Map<string, number>;
}

interface MovieWatchedRow {
  canonical_id: string;
  watched: boolean;
  has_plays: boolean;
}

interface ShowWatchedRow {
  canonical_id: string;
  eps_watched: number;
  has_plays: boolean;
}

/**
 * Single-hop alias map: for each canonical id, includes itself plus any media
 * row whose merged_into_id points to it (merged_into_id is already path-compressed
 * to a single hop, so no recursion is needed here).
 *
 * Builds the id list via ARRAY[...] rather than interpolating `ids` directly as
 * `${ids}::uuid[]`: drizzle's sql template expands a plain JS array into a
 * comma-separated param list (a row constructor), which `::uuid[]` cannot cast.
 */
export function buildAliasMapCte(ids: string[]): SQL {
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  return sql`WITH alias_map AS (
    SELECT id AS canonical_id, id AS any_id FROM unnest(ARRAY[${idList}]::uuid[]) AS t(id)
    UNION ALL
    SELECT m.merged_into_id, m.id FROM media m WHERE m.merged_into_id = ANY(ARRAY[${idList}]::uuid[])
  )`;
}

/** Movie matrix: watched wins, otherwise any recorded plays make it partial. */
export function movieWatchedState(watched: boolean, hasPlays: boolean): WatchedState {
  if (watched) return 'watched';
  return hasPlays ? 'partial' : 'unwatched';
}

/**
 * Show matrix: an unknown or zero episode count can never resolve to
 * watched/partial, since there's nothing to compare epsWatched against.
 */
export function showWatchedState(
  epsWatched: number,
  episodeCount: number | undefined,
  hasPlays: boolean
): WatchedState {
  if (!episodeCount) return 'unwatched';
  if (epsWatched >= episodeCount) return 'watched';
  return epsWatched > 0 || hasPlays ? 'partial' : 'unwatched';
}

export function mapMovieWatchedRows(
  movieIds: string[],
  rows: MovieWatchedRow[]
): Map<string, WatchedState> {
  const byId = new Map(rows.map((row) => [row.canonical_id, row]));
  const result = new Map<string, WatchedState>();
  for (const id of movieIds) {
    const row = byId.get(id);
    result.set(id, movieWatchedState(row?.watched ?? false, row?.has_plays ?? false));
  }
  return result;
}

export function mapShowWatchedRows(
  showIds: string[],
  rows: ShowWatchedRow[],
  episodeCounts: Map<string, number>
): Map<string, WatchedState> {
  const byId = new Map(rows.map((row) => [row.canonical_id, row]));
  const result = new Map<string, WatchedState>();
  for (const id of showIds) {
    const row = byId.get(id);
    result.set(
      id,
      showWatchedState(row?.eps_watched ?? 0, episodeCounts.get(id), row?.has_plays ?? false)
    );
  }
  return result;
}

async function fetchMovieWatchedRows(
  movieIds: string[],
  serverIds: string[] | undefined,
  lensUserId: string | null
): Promise<MovieWatchedRow[]> {
  const aliasCte = buildAliasMapCte(movieIds);
  // Bare interpolation: buildMultiServerFragment already returns '' (owner/all)
  // or a leading 'AND ...' fragment; wrapping it in parens breaks the query.
  const serverFragment = buildMultiServerFragment(serverIds, 'p.server_id');
  // A direct JOIN from alias_map to the cagg (a materialized_only=false view)
  // makes the planner seq-scan the whole cagg instead of probing
  // idx_user_media_plays_media_user per alias row. CROSS JOIN LATERAL with
  // OFFSET 0 blocks the planner from flattening the subquery back into that
  // same join, which is what actually forces the index scan (bare JOIN and
  // LATERAL without OFFSET 0 both flatten to the same seq-scanning plan).
  const result = await db.execute(sql`
    ${aliasCte}
    SELECT a.canonical_id,
           BOOL_OR(p.any_watched) AS watched,
           COALESCE(SUM(p.plays), 0) > 0 AS has_plays
    FROM alias_map a
    CROSS JOIN LATERAL (
      SELECT p2.any_watched, p2.plays, p2.server_user_id, p2.server_id
      FROM user_media_plays_daily p2
      WHERE p2.media_id = a.any_id
      OFFSET 0
    ) p
    JOIN server_users su ON su.id = p.server_user_id
    WHERE (${lensUserId}::uuid IS NULL OR su.user_id = ${lensUserId}) ${serverFragment}
    GROUP BY a.canonical_id
  `);
  return result.rows as unknown as MovieWatchedRow[];
}

async function fetchShowWatchedRows(
  showIds: string[],
  serverIds: string[] | undefined,
  lensUserId: string | null
): Promise<ShowWatchedRow[]> {
  const aliasCte = buildAliasMapCte(showIds);
  const serverFragment = buildMultiServerFragment(serverIds, 'p.server_id');
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  // Same LATERAL/OFFSET 0 shape as the movie probe, keyed on show_media_id.
  // eps_watched stays a single COUNT(DISTINCT) over every alias row's plays
  // rather than a per-any_id count summed afterward, since a per-any_id sum
  // would double count if an episode's media_id ever showed up under both
  // the winner and loser show ids (episode rows aren't aliased themselves).
  const result = await db.execute(sql`
    ${aliasCte}
    SELECT a.canonical_id,
           COUNT(DISTINCT p.media_id) FILTER (
             WHERE p.any_watched
               AND EXISTS (
                 SELECT 1 FROM library_items li
                 WHERE li.media_id = p.media_id AND li.removed_at IS NULL ${serverFragmentLi}
               )
           )::int AS eps_watched,
           COALESCE(SUM(p.plays), 0) > 0 AS has_plays
    FROM alias_map a
    CROSS JOIN LATERAL (
      SELECT p2.media_id, p2.any_watched, p2.plays, p2.server_user_id, p2.server_id
      FROM user_media_plays_daily p2
      WHERE p2.show_media_id = a.any_id
      OFFSET 0
    ) p
    JOIN server_users su ON su.id = p.server_user_id
    WHERE (${lensUserId}::uuid IS NULL OR su.user_id = ${lensUserId}) ${serverFragment}
    GROUP BY a.canonical_id
  `);
  return result.rows as unknown as ShowWatchedRow[];
}

/**
 * Resolves per-media watched state for a page of movies and shows, alias-aware
 * (merged duplicates share state) and scoped to a server set and/or a single
 * identity's lens. lensUserId === null aggregates across every identity: the
 * `su.user_id = lensUserId` filter short-circuits via the leading OR IS NULL,
 * which is equivalent to a semi-join across all users for this BOOL_OR/COUNT shape.
 */
export async function resolveWatchedStates(
  args: WatchedProbeArgs
): Promise<Map<string, WatchedState>> {
  const { movieIds, showIds, serverIds, lensUserId, episodeCounts } = args;
  const result = new Map<string, WatchedState>();

  if (movieIds.length > 0) {
    const rows = await fetchMovieWatchedRows(movieIds, serverIds, lensUserId);
    for (const [id, state] of mapMovieWatchedRows(movieIds, rows)) {
      result.set(id, state);
    }
  }

  if (showIds.length > 0) {
    const rows = await fetchShowWatchedRows(showIds, serverIds, lensUserId);
    for (const [id, state] of mapShowWatchedRows(showIds, rows, episodeCounts)) {
      result.set(id, state);
    }
  }

  return result;
}

// ============================================================================
// Watched-media listing
//
// The inverse of resolveWatchedStates: rather than probing a known id list,
// this walks user_media_plays_daily in the listing direction and returns only
// media with recorded engagement, so absence from a page means unwatched and
// no per-id probe round is needed. The state matrices below are the SQL form
// of mapMovieWatchedRows and mapShowWatchedRows and must keep agreeing with
// them, or a badge built on this endpoint contradicts the library UI.
//
// State is resolved in SQL rather than after the page is sliced: min_state
// filters and the keyset cursor both read it, and applying either after LIMIT
// would return short pages and pages that are empty behind a live cursor.
//
// userId scopes the whole aggregate, exactly as /history does, so every field
// on a row describes that one identity. It is a filter, not an annotation: a
// title the identity never played is absent rather than present-and-unwatched.
// ============================================================================

export type WatchedMediaKind = 'movie' | 'show' | 'episode';

/** Long enough for a cold full-catalog aggregate, short enough that a few
 * concurrent walks cannot pin the pool (which floors at 5 connections). */
const WATCHED_LIST_TIMEOUT_MS = 15_000;

export interface ListWatchedMediaArgs {
  kind: WatchedMediaKind;
  /** Scope every aggregate to this identity; null aggregates across everyone. */
  userId: string | null;
  serverIds: string[] | undefined;
  minState: Exclude<WatchedState, 'unwatched'>;
  pageSize: number;
  cursorValue: { startedAt: Date; id: string } | null;
}

export interface WatchedMediaRecord {
  media_id: string;
  media_type: string;
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  show_media_id: string | null;
  show_title: string | null;
  show_imdb_id: string | null;
  show_tmdb_id: number | null;
  show_tvdb_id: number | null;
  season_number: number | null;
  episode_number: number | null;
  watched_state: WatchedState;
  plays: number;
  last_watched_day: string;
  episodes_watched: number | null;
  episode_count: number | null;
}

interface WatchedMediaQueryRow {
  canonical_id: string;
  media_type: string;
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  show_media_id: string | null;
  show_title: string | null;
  show_imdb_id: string | null;
  show_tmdb_id: number | null;
  show_tvdb_id: number | null;
  season_number: number | null;
  episode_number: number | null;
  plays: string | number;
  last_day: string;
  last_watched_day: string;
  watched_any: boolean;
  has_plays_any: boolean;
  eps_watched_any: number | null;
  episode_count: number | null;
}

function mapWatchedMediaRow(row: WatchedMediaQueryRow, isShow: boolean): WatchedMediaRecord {
  const episodeCount = row.episode_count;
  return {
    media_id: row.canonical_id,
    media_type: row.media_type,
    title: row.title,
    year: row.year,
    imdb_id: row.imdb_id,
    tmdb_id: row.tmdb_id,
    tvdb_id: row.tvdb_id,
    show_media_id: row.show_media_id,
    show_title: row.show_title,
    show_imdb_id: row.show_imdb_id,
    show_tmdb_id: row.show_tmdb_id,
    show_tvdb_id: row.show_tvdb_id,
    season_number: row.season_number,
    episode_number: row.episode_number,
    watched_state: isShow
      ? showWatchedState(row.eps_watched_any ?? 0, episodeCount ?? undefined, row.has_plays_any)
      : movieWatchedState(row.watched_any, row.has_plays_any),
    plays: Number(row.plays),
    last_watched_day: row.last_watched_day,
    episodes_watched: isShow ? (row.eps_watched_any ?? 0) : null,
    episode_count: isShow ? episodeCount : null,
  };
}

/** Keyset predicate over the grouped result; mirrors the ORDER BY exactly. */
function watchedCursorFragment(cursorValue: { startedAt: Date; id: string } | null): SQL {
  if (!cursorValue) return sql``;
  return sql` AND (c.last_day, c.canonical_id) < (${cursorValue.startedAt}::timestamptz, ${cursorValue.id}::uuid)`;
}

/** Scoping an identity in the CTE's WHERE re-grains every aggregate below it,
 * which is what makes one min_state cover both grains: a user's state can
 * never exceed the all-users state, so a second per-user knob would be inert. */
function userFragment(userId: string | null): SQL {
  return userId === null ? sql`` : sql` AND su.user_id = ${userId}`;
}

export function buildMovieListQuery(args: ListWatchedMediaArgs): SQL {
  const { kind, userId, serverIds, minState, pageSize, cursorValue } = args;
  const serverFragment = buildMultiServerFragment(serverIds, 'p.server_id');
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  const stateFilter =
    minState === 'watched' ? sql`c.watched_any` : sql`(c.watched_any OR c.has_plays_any)`;
  // Movies have no season/episode of their own, and this lateral runs per
  // surviving candidate rather than per returned row, so it stays off that branch.
  const hierarchySelect =
    kind === 'episode'
      ? sql`ep.parent_index AS season_number, ep.item_index AS episode_number`
      : sql`NULL::int AS season_number, NULL::int AS episode_number`;
  const hierarchyJoin =
    kind === 'episode'
      ? sql`LEFT JOIN LATERAL (
            SELECT li.parent_index, li.item_index
            FROM library_items li
            WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}
            ORDER BY (li.parent_index IS NULL), (li.item_index IS NULL), li.id
            LIMIT 1
          ) ep ON true`
      : sql``;

  return sql`
    WITH counted AS (
      SELECT COALESCE(am.merged_into_id, p.media_id) AS canonical_id,
             BOOL_OR(p.any_watched) AS watched_any,
             COALESCE(SUM(p.plays), 0) > 0 AS has_plays_any,
             COALESCE(SUM(p.plays), 0)::bigint AS plays,
             MAX(p.day) AS last_day
      FROM user_media_plays_daily p
      JOIN media am ON am.id = p.media_id
      JOIN server_users su ON su.id = p.server_user_id
      WHERE am.media_type = ${kind}${userFragment(userId)} ${serverFragment}
      GROUP BY COALESCE(am.merged_into_id, p.media_id)
    )
    SELECT c.canonical_id,
           c.watched_any, c.has_plays_any, c.plays, c.last_day,
           (c.last_day AT TIME ZONE 'utc')::date::text AS last_watched_day,
           NULL::int AS eps_watched_any, NULL::int AS episode_count,
           m.media_type, m.title, m.year, m.imdb_id, m.tmdb_id, m.tvdb_id, m.show_media_id,
           sm.title AS show_title, sm.imdb_id AS show_imdb_id,
           sm.tmdb_id AS show_tmdb_id, sm.tvdb_id AS show_tvdb_id,
           ${hierarchySelect}
    FROM counted c
    JOIN media m ON m.id = c.canonical_id
    LEFT JOIN media sm ON sm.id = m.show_media_id
    ${hierarchyJoin}
    WHERE ${stateFilter}${watchedCursorFragment(cursorValue)}
    ORDER BY c.last_day DESC, c.canonical_id DESC
    LIMIT ${pageSize}
  `;
}

export function buildShowListQuery(args: ListWatchedMediaArgs): SQL {
  const { userId, serverIds, minState, pageSize, cursorValue } = args;
  const serverFragment = buildMultiServerFragment(serverIds, 'p.server_id');
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  const stateFilter =
    minState === 'watched'
      ? sql`c.eps_watched_any >= ec.episode_count`
      : sql`(c.eps_watched_any > 0 OR c.has_plays_any)`;

  return sql`
    WITH active_episodes AS (
      SELECT m.id AS media_id, m.show_media_id AS show_id
      FROM media m
      WHERE m.media_type = 'episode' AND m.show_media_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM library_items li
          WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}
        )
    ),
    episode_counts AS (
      SELECT show_id, COUNT(*)::int AS episode_count FROM active_episodes GROUP BY show_id
    ),
    counted AS (
      SELECT COALESCE(am.merged_into_id, p.show_media_id) AS canonical_id,
             COUNT(DISTINCT p.media_id) FILTER (
               WHERE p.any_watched AND ae.media_id IS NOT NULL
             )::int AS eps_watched_any,
             COALESCE(SUM(p.plays), 0) > 0 AS has_plays_any,
             COALESCE(SUM(p.plays), 0)::bigint AS plays,
             MAX(p.day) AS last_day
      FROM user_media_plays_daily p
      JOIN media am ON am.id = p.show_media_id
      JOIN server_users su ON su.id = p.server_user_id
      LEFT JOIN active_episodes ae ON ae.media_id = p.media_id
      WHERE p.show_media_id IS NOT NULL${userFragment(userId)} ${serverFragment}
      GROUP BY COALESCE(am.merged_into_id, p.show_media_id)
    )
    SELECT c.canonical_id,
           NULL::boolean AS watched_any, c.has_plays_any,
           c.plays, c.last_day,
           (c.last_day AT TIME ZONE 'utc')::date::text AS last_watched_day,
           c.eps_watched_any, ec.episode_count,
           m.media_type, m.title, m.year, m.imdb_id, m.tmdb_id, m.tvdb_id,
           NULL::uuid AS show_media_id,
           NULL::text AS show_title, NULL::varchar AS show_imdb_id,
           NULL::int AS show_tmdb_id, NULL::int AS show_tvdb_id,
           NULL::int AS season_number, NULL::int AS episode_number
    FROM counted c
    JOIN media m ON m.id = c.canonical_id
    JOIN episode_counts ec ON ec.show_id = c.canonical_id
    WHERE ${stateFilter}${watchedCursorFragment(cursorValue)}
    ORDER BY c.last_day DESC, c.canonical_id DESC
    LIMIT ${pageSize}
  `;
}

/**
 * One page of media the scope has engagement with, newest activity first.
 * A show with no active episodes resolves to unwatched and never appears,
 * matching mapShowWatchedRows' unknown-count rule.
 *
 * Every page re-runs the full aggregate, since last_day is a MAX and
 * watched_any a BOOL_OR, so the keyset predicate is semantically a HAVING.
 * The timeout bounds that rather than letting a cold walk pin a connection.
 */
export async function listWatchedMedia(
  args: ListWatchedMediaArgs
): Promise<{ data: WatchedMediaRecord[]; nextCursor: string | null }> {
  const isShow = args.kind === 'show';
  const query = isShow ? buildShowListQuery(args) : buildMovieListQuery(args);

  const rows = await db.transaction(async (tx) => {
    // SET LOCAL takes no parameters, so the value is raw-interpolated.
    await tx.execute(
      sql`SET LOCAL statement_timeout = ${sql.raw(String(WATCHED_LIST_TIMEOUT_MS))}`
    );
    const result = await tx.execute(query);
    return result.rows as unknown as WatchedMediaQueryRow[];
  });

  const data = rows.map((row) => mapWatchedMediaRow(row, isShow));
  const lastRow = rows.length === args.pageSize ? rows[rows.length - 1] : undefined;
  const nextCursor = lastRow
    ? encodeCursor(new Date(lastRow.last_day), lastRow.canonical_id)
    : null;
  return { data, nextCursor };
}
