/**
 * Per-genre library stats for one media type: item counts, size and never played all-time, and
 * plays, watch time, finishes and viewers over a window of whole UTC days from
 * user_media_plays_daily. Movie and show genres come from the canonical media row, so a merged
 * alias's plays land on the canonical title's genres. Artists key on their canonical media row
 * too, so an artist held on two servers counts once; track plays and sizes roll up through each
 * copy's grandparent_rating_key, and a track whose artist row is missing or has no media row
 * drops out.
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  type GenreDetailResponse,
  type GenreRow,
  type GenresResponse,
  type GenreTitle,
  type GenreTopViewer,
  type LibraryMediaType,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { libraryFragment, scopeFragment, seesServerActivity, type Scope } from '../../lib/scope.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { personNameSql } from '../../utils/representativeAccount.js';
import { ARTIST_OF_TRACK, mediaSizeSubquery, neverPlayedSql } from '../../routes/library/utils.js';
import { queryPlaysByHourOfDay, queryPlaysOverTime } from '../../routes/stats/queries.js';
import {
  previousRange,
  resolveDateRange,
  type DateRange,
  type StatsPeriod,
} from '../../routes/stats/utils.js';
import {
  FINISHED_SQL,
  TREND_BUCKETS,
  alignToUtcDays,
  bucketLabels,
  dailyBoundsSql,
  percent,
  toIso,
  toSeries,
  trendBucketSql,
} from '../stats/windows.js';

export interface GenreScope {
  type: LibraryMediaType;
  resolvedServerIds: string[] | undefined;
  scope: Scope;
  timezone: string;
}

export interface GenreWindow {
  range: DateRange;
  prior: { start: Date; end: Date } | null;
  period: StatsPeriod;
}

const TITLE_LIMIT = 8;
const VIEWER_LIMIT = 3;
const WEEK_INTERVAL = '1 week';

/** Whole UTC days, as the plays aggregate buckets them; a custom range includes its end day. */
export function resolveGenreWindow(
  query: { period: StatsPeriod; startDate?: string; endDate?: string },
  now = new Date()
): GenreWindow {
  const range = alignToUtcDays(
    query.period,
    resolveDateRange(query.period, query.startDate, query.endDate, now)
  );
  return { range, prior: previousRange(range), period: query.period };
}

function genreFilter(genre: string | undefined, genres: SQL): SQL {
  return genre === undefined ? sql`` : sql`AND ${genre}::text = ANY(${genres})`;
}

/** `JOIN media canon` for the canonical title of `pmr`, of the type and genre. */
function canonicalTitleJoin(type: LibraryMediaType, genre?: string): SQL {
  return sql`JOIN media canon ON canon.id = COALESCE(pmr.merged_into_id, pmr.id)
    AND canon.media_type = ${type} ${genreFilter(genre, sql`canon.genres`)}`;
}

/** Track `t` to its artist copy `ar` to the canonical artist `canon`. */
function canonicalArtistOfTrack(genre?: string): SQL {
  return sql`${ARTIST_OF_TRACK}
    JOIN media pmr ON pmr.id = ar.media_id
    ${canonicalTitleJoin('artist', genre)}`;
}

/**
 * One row per chain over the prior and current windows, keyed to the title it counts toward,
 * then flagged in_range and given its trend bucket. A chain belongs to the window it started in.
 */
function chainsCte(s: GenreScope, w: GenreWindow, genre?: string): SQL {
  const playsWhere = sql`${dailyBoundsSql('p', w.prior?.start ?? w.range.start, w.range.end)}
    ${buildMultiServerFragment(s.resolvedServerIds, 'p.server_id')}
    ${scopeFragment(s.scope, sql`p.server_user_id`)}`;

  const source =
    s.type === 'artist'
      ? sql`MAX(title.id::text)::uuid AS title_id
        FROM user_media_plays_daily p
        JOIN LATERAL (
          SELECT canon.id ${canonicalArtistOfTrack(genre)}
          WHERE t.media_id = p.media_id AND t.server_id = p.server_id AND t.media_type = 'track'
          ORDER BY canon.id
          LIMIT 1
        ) title ON true
        WHERE p.media_type = 'track'`
      : sql`MAX(canon.id::text)::uuid AS title_id
        FROM user_media_plays_daily p
        JOIN media pmr ON pmr.id = p.${sql.raw(s.type === 'movie' ? 'media_id' : 'show_media_id')}
        ${canonicalTitleJoin(s.type, genre)}
        WHERE true ${s.type === 'show' ? sql`AND p.show_media_id IS NOT NULL` : sql``}`;

  const inRange = w.range.start ? sql`first_day >= ${w.range.start}::timestamptz` : sql`true`;

  return sql`
    chains AS (
      SELECT
        p.chain_id,
        MAX(p.server_user_id::text)::uuid AS server_user_id,
        MIN(p.day) AS first_day,
        BOOL_OR(p.counted) AS counted,
        SUM(p.watched_ms) AS watched_ms,
        MAX(p.max_progress_ms) AS max_progress_ms,
        MAX(p.content_duration_ms) AS content_duration_ms,
        ${source} ${playsWhere}
      GROUP BY p.chain_id
    ),
    bucketed AS (
      SELECT *, ${inRange} AS in_range, ${trendBucketSql(w.range)} AS bucket FROM chains
    )`;
}

/**
 * Per genre over the window: plays, prior plays, watch time, finished and judged chains, the
 * trend buckets and the top viewers (by identity, each with their busiest account). One row
 * per genre, each carrying the type's totals; a lone row with a null genre when no title of
 * the type has a genre.
 */
export function buildGenreRowsSql(s: GenreScope, w: GenreWindow, genre?: string): SQL {
  const trendColumns = Array.from({ length: TREND_BUCKETS }, (_, i) => {
    const bucket = sql.raw(String(i + 1));
    return sql`COUNT(*) FILTER (WHERE counted AND in_range AND bucket = ${bucket})::int AS t${bucket}`;
  });
  const trendSums = Array.from(
    { length: TREND_BUCKETS },
    (_, i) => sql`SUM(t${sql.raw(String(i + 1))})`
  );
  const onlyGenre = genre === undefined ? sql`` : sql`WHERE genre = ${genre}`;

  return sql`
    WITH ${chainsCte(s, w)},
    per_media AS (
      SELECT
        title_id,
        server_user_id,
        COUNT(*) FILTER (WHERE counted AND in_range)::int AS plays,
        COUNT(*) FILTER (WHERE counted AND NOT in_range)::int AS prior_plays,
        COALESCE(SUM(watched_ms) FILTER (WHERE in_range), 0)::bigint AS watched_ms,
        COUNT(*) FILTER (WHERE in_range AND counted AND content_duration_ms > 0 AND (${FINISHED_SQL}))::int AS finished,
        COUNT(*) FILTER (WHERE in_range AND counted AND content_duration_ms > 0)::int AS judged,
        ${sql.join(trendColumns, sql`, `)}
      FROM bucketed
      GROUP BY title_id, server_user_id
    ),
    genre_media AS (
      SELECT genre, pm.* FROM per_media pm
      JOIN media canon ON canon.id = pm.title_id, unnest(canon.genres) AS genre
      ${onlyGenre}
    ),
    per_genre AS (
      SELECT
        genre,
        SUM(plays)::int AS plays,
        SUM(prior_plays)::int AS prior_plays,
        SUM(watched_ms)::bigint AS watched_ms,
        SUM(finished)::int AS finished,
        SUM(judged)::int AS judged,
        ARRAY[${sql.join(trendSums, sql`, `)}]::int[] AS trend
      FROM genre_media
      GROUP BY genre
    ),
    account_plays AS (
      SELECT genre, server_user_id, SUM(plays)::int AS plays
      FROM genre_media
      GROUP BY genre, server_user_id
      HAVING SUM(plays) > 0
    ),
    viewers AS (
      SELECT
        ap.genre,
        su.user_id,
        SUM(ap.plays)::int AS plays,
        (ARRAY_AGG(su.id ORDER BY ap.plays DESC, su.id))[1] AS server_user_id,
        ROW_NUMBER() OVER (PARTITION BY ap.genre ORDER BY SUM(ap.plays) DESC, su.user_id) AS rank
      FROM account_plays ap
      JOIN server_users su ON su.id = ap.server_user_id
      GROUP BY ap.genre, su.user_id
    ),
    top_viewers AS (
      SELECT
        v.genre,
        json_agg(json_build_object(
          'userId', v.user_id,
          'serverUserId', v.server_user_id,
          'name', ${personNameSql()},
          'thumbUrl', su.thumb_url,
          'serverId', su.server_id,
          'plays', v.plays
        ) ORDER BY v.rank) AS viewers
      FROM viewers v
      JOIN users u ON u.id = v.user_id
      JOIN server_users su ON su.id = v.server_user_id
      WHERE v.rank <= ${sql.raw(String(VIEWER_LIMIT))}
      GROUP BY v.genre
    ),
    totals AS (
      SELECT
        COUNT(*) FILTER (WHERE counted AND in_range)::int AS plays,
        COUNT(*) FILTER (WHERE counted AND NOT in_range)::int AS prior_plays
      FROM bucketed
    )
    SELECT t.plays AS total_plays, t.prior_plays AS total_prior_plays, pg.*, tv.viewers
    FROM totals t
    LEFT JOIN per_genre pg ON true
    LEFT JOIN top_viewers tv ON tv.genre = pg.genre
  `;
}

/**
 * `items` (every active title of the type in scope) and `sized` (with all-time size and the
 * never played flag, for the titles of one genre when given).
 */
function itemCtes(s: GenreScope, genre?: string): SQL {
  const { resolvedServerIds: ids, scope } = s;
  const artistCopy = sql`ar.media_id = i.id AND t.media_type = 'track'
    ${libraryFragment(ids, scope, 'ar')}`;
  const sizeAndNeverPlayed =
    s.type === 'artist'
      ? sql`(SELECT COALESCE(SUM(sz), 0) FROM (
            SELECT DISTINCT COALESCE(t.media_id::text, t.id::text) AS track, v.file_size AS sz
            ${ARTIST_OF_TRACK}
            JOIN library_item_versions v
              ON v.library_item_id = t.id AND v.removed_at IS NULL AND v.file_size IS NOT NULL
            WHERE ${artistCopy} AND t.removed_at IS NULL
          ) d) AS size_bytes,
          NOT EXISTS (
            SELECT 1 ${ARTIST_OF_TRACK}
            JOIN user_media_plays_daily p ON p.media_id = t.media_id AND p.server_id = t.server_id
            WHERE ${artistCopy} AND p.counted ${scopeFragment(scope, sql`p.server_user_id`)}
          ) AS never_played`
      : sql`${mediaSizeSubquery(sql`i.id`, libraryFragment(ids, scope, 'li2'))} AS size_bytes,
          ${neverPlayedSql(s.type, sql`i.id`, ids, scope)} AS never_played`;
  return sql`
    items AS (
      SELECT m.id, m.title, m.year, m.genres
      FROM media m
      WHERE m.merged_into_id IS NULL AND m.media_type = ${s.type}
        AND EXISTS (
          SELECT 1 FROM library_items li
          WHERE li.media_id = m.id AND li.removed_at IS NULL ${libraryFragment(ids, scope, 'li')}
        )
    ),
    sized AS (
      SELECT i.*, ${sizeAndNeverPlayed}
      FROM items i
      WHERE true ${genreFilter(genre, sql`i.genres`)}
    )`;
}

/**
 * Per genre, all-time: items, deduped size, and never played count and size. One row per genre
 * carrying the type's item total; a lone row with a null genre when no title has one.
 */
export function buildGenreItemsSql(s: GenreScope, genre?: string): SQL {
  return sql`
    WITH ${itemCtes(s, genre)},
    per_genre AS (
      SELECT
        genre,
        COUNT(*)::int AS item_count,
        COALESCE(SUM(size_bytes), 0)::bigint AS size_bytes,
        COUNT(*) FILTER (WHERE never_played)::int AS never_played_count,
        COALESCE(SUM(size_bytes) FILTER (WHERE never_played), 0)::bigint AS never_played_bytes
      FROM sized, unnest(sized.genres) AS genre
      ${genre === undefined ? sql`` : sql`WHERE genre = ${genre}`}
      GROUP BY genre
    )
    SELECT t.items AS total_items, pg.*
    FROM (SELECT COUNT(*)::int AS items FROM items) t
    LEFT JOIN per_genre pg ON true
  `;
}

/** One genre's top titles by plays in the window and its largest never played titles. */
function genreTitlesSql(s: GenreScope, w: GenreWindow, genre: string): SQL {
  const limit = sql.raw(String(TITLE_LIMIT));
  const poster = sql`SELECT li.thumb_path, li.server_id FROM library_items li
    WHERE li.media_id = l.id AND li.removed_at IS NULL
      ${libraryFragment(s.resolvedServerIds, s.scope, 'li')}
    ORDER BY li.thumb_path IS NULL, li.created_at DESC
    LIMIT 1`;
  return sql`
    WITH ${itemCtes(s, genre)}, ${chainsCte(s, w, genre)},
    title_plays AS (
      SELECT title_id, COUNT(*) FILTER (WHERE counted AND in_range)::int AS plays
      FROM bucketed
      GROUP BY title_id
    ),
    listed AS (
      (SELECT 'top' AS list, sz.id, sz.title, sz.year, sz.size_bytes, tp.plays
       FROM sized sz JOIN title_plays tp ON tp.title_id = sz.id
       WHERE tp.plays > 0
       ORDER BY tp.plays DESC, sz.title
       LIMIT ${limit})
      UNION ALL
      (SELECT 'never' AS list, sz.id, sz.title, sz.year, sz.size_bytes, 0 AS plays
       FROM sized sz
       WHERE sz.never_played
       ORDER BY sz.size_bytes DESC, sz.title
       LIMIT ${limit})
    )
    SELECT l.*, poster.thumb_path, poster.server_id
    FROM listed l
    LEFT JOIN LATERAL (${poster}) poster ON true
  `;
}

/** Sessions of the type's titles (of one genre when given), for the hourly and weekly reads. */
function sessionTitlesFilter(s: GenreScope, genre?: string): SQL {
  const servers = sql`${buildMultiServerFragment(s.resolvedServerIds, 'sessions.server_id')}
    ${scopeFragment(s.scope, sql`sessions.server_user_id`)}`;
  if (s.type === 'artist') {
    return sql`${servers} AND sessions.media_type = 'track' AND EXISTS (
      SELECT 1 ${canonicalArtistOfTrack(genre)}
      WHERE t.media_id = sessions.media_id AND t.server_id = sessions.server_id
        AND t.media_type = 'track'
    )`;
  }
  return sql`${servers} AND COALESCE(sessions.show_media_id, sessions.media_id) IN (
    SELECT pmr.id FROM media pmr ${canonicalTitleJoin(s.type, genre)}
  )`;
}

interface ItemSqlRow {
  total_items: number;
  genre: string | null;
  item_count: number;
  size_bytes: string | number;
  never_played_count: number;
  never_played_bytes: string | number;
}

interface ViewerSqlRow {
  userId: string;
  serverUserId: string;
  name: string;
  thumbUrl: string | null;
  serverId: string;
  plays: number;
}

interface PlaysSqlRow {
  total_plays: number;
  total_prior_plays: number;
  genre: string | null;
  plays: number;
  prior_plays: number;
  watched_ms: string | number;
  finished: number;
  judged: number;
  trend: number[];
  viewers: ViewerSqlRow[] | null;
}

interface TitleSqlRow {
  list: 'top' | 'never';
  id: string;
  title: string;
  year: number | null;
  size_bytes: string | number;
  plays: number;
  thumb_path: string | null;
  server_id: string;
}

function toViewers(rows: ViewerSqlRow[] | null, plays: number): GenreTopViewer[] {
  return (rows ?? []).map((row) => ({
    userId: row.userId,
    serverUserId: row.serverUserId,
    name: row.name,
    thumbUrl: row.thumbUrl,
    serverId: row.serverId,
    share: percent(row.plays, plays) ?? 0,
  }));
}

function seriesInput(s: GenreScope, genre?: string) {
  return {
    timezone: s.timezone,
    serverFilter: sessionTitlesFilter(s, genre),
    allMediaTypes: s.type === 'artist',
  };
}

export async function queryGenreRows(s: GenreScope, w: GenreWindow): Promise<GenresResponse> {
  const [itemsResult, playsResult, hourly, showViewers] = await Promise.all([
    db.execute(buildGenreItemsSql(s)),
    db.execute(buildGenreRowsSql(s, w)),
    queryPlaysByHourOfDay({ ...seriesInput(s), rangeStart: w.range.start, endDate: w.range.end }),
    seesServerActivity(s.scope),
  ]);
  const itemRows = itemsResult.rows as unknown as ItemSqlRow[];
  const playRows = playsResult.rows as unknown as PlaysSqlRow[];
  const items = new Map(itemRows.flatMap((row) => (row.genre ? [[row.genre, row] as const] : [])));
  const plays = new Map(playRows.flatMap((row) => (row.genre ? [[row.genre, row] as const] : [])));

  const data: GenreRow[] = [...new Set([...items.keys(), ...plays.keys()])].map((genre) => {
    const item = items.get(genre);
    const play = plays.get(genre);
    const playCount = play?.plays ?? 0;
    return {
      genre,
      itemCount: item?.item_count ?? 0,
      sizeBytes: Number(item?.size_bytes ?? 0),
      plays: playCount,
      priorPlays: w.prior ? (play?.prior_plays ?? 0) : null,
      watchTimeMs: Number(play?.watched_ms ?? 0),
      finishedRate: percent(play?.finished ?? 0, play?.judged ?? 0),
      topViewer: showViewers ? (toViewers(play?.viewers ?? null, playCount)[0] ?? null) : null,
      neverPlayed: {
        count: item?.never_played_count ?? 0,
        bytes: Number(item?.never_played_bytes ?? 0),
      },
      trend: play?.trend ?? Array.from({ length: TREND_BUCKETS }, () => 0),
    };
  });

  const totals = playRows[0];
  return {
    data: data.sort((a, b) => a.genre.localeCompare(b.genre)),
    hourly,
    totals: {
      items: itemRows[0]?.total_items ?? 0,
      plays: totals?.total_plays ?? 0,
      priorPlays: w.prior ? (totals?.total_prior_plays ?? 0) : null,
    },
    range: {
      start: toIso(w.range.start),
      end: w.range.end.toISOString(),
      priorStart: toIso(w.prior?.start),
      priorEnd: toIso(w.prior?.end),
    },
  };
}

function toTitle(row: TitleSqlRow): GenreTitle {
  return {
    mediaId: row.id,
    title: row.title,
    year: row.year,
    serverId: row.server_id,
    thumbPath: row.thumb_path,
    plays: row.plays,
    sizeBytes: Number(row.size_bytes),
  };
}

/**
 * Null when the genre has neither a title of the type nor a counted play in the window; a genre
 * whose titles were all removed after being played still answers, with no items.
 */
export async function queryGenreDetail(
  s: GenreScope,
  w: GenreWindow,
  genre: string
): Promise<GenreDetailResponse | null> {
  const [itemsResult, playsResult] = await Promise.all([
    db.execute(buildGenreItemsSql(s, genre)),
    db.execute(buildGenreRowsSql(s, w, genre)),
  ]);
  const itemRows = itemsResult.rows as unknown as ItemSqlRow[];
  const item = itemRows.find((row) => row.genre === genre);
  const playRows = playsResult.rows as unknown as PlaysSqlRow[];
  const play = playRows.find((row) => row.genre === genre);
  const plays = play?.plays ?? 0;
  if (!item && plays === 0) return null;

  const series = seriesInput(s, genre);
  const [titlesResult, weekly, priorWeekly, hourly, showViewers] = await Promise.all([
    db.execute(genreTitlesSql(s, w, genre)),
    queryPlaysOverTime({
      ...series,
      rangeStart: w.range.start,
      endDate: w.range.end,
      bucketInterval: WEEK_INTERVAL,
    }),
    w.prior
      ? queryPlaysOverTime({
          ...series,
          rangeStart: w.prior.start,
          endDate: w.prior.end,
          bucketInterval: WEEK_INTERVAL,
        })
      : [],
    queryPlaysByHourOfDay({ ...series, rangeStart: w.range.start, endDate: w.range.end }),
    seesServerActivity(s.scope),
  ]);
  const totals = playRows[0];
  const titles = titlesResult.rows as unknown as TitleSqlRow[];

  const judged = play?.judged ?? 0;
  const finished = play?.finished ?? 0;
  const topViewers = showViewers ? toViewers(play?.viewers ?? null, plays) : [];

  return {
    genre,
    kpis: {
      plays,
      priorPlays: w.prior ? (play?.prior_plays ?? 0) : null,
      finishedRate: percent(finished, judged),
      abandonedRate: percent(judged - finished, judged),
      itemCount: item?.item_count ?? 0,
      sizeBytes: Number(item?.size_bytes ?? 0),
      itemShare: item ? percent(item.item_count, item.total_items) : null,
      playShare: percent(plays, totals?.total_plays ?? 0),
    },
    weekly: toSeries(
      weekly,
      w.range.start ? bucketLabels(w.range.start, w.range.end, WEEK_INTERVAL, s.timezone) : null
    ),
    priorWeekly: w.prior
      ? toSeries(priorWeekly, bucketLabels(w.prior.start, w.prior.end, WEEK_INTERVAL, s.timezone))
      : [],
    hourly,
    topViewers,
    topTitles: titles.filter((row) => row.list === 'top').map(toTitle),
    neverPlayed: titles.filter((row) => row.list === 'never').map(toTitle),
  };
}
