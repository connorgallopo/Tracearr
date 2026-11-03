/**
 * Library Top Content Routes
 *
 * GET /top-movies - Top movies by plays, watch time, viewers or completion
 * GET /top-shows - Top shows by plays, watch time, viewers, completion or binge score
 *
 * Both read user_media_plays_daily by media identity within the page's window, the same play
 * set as ROI, the watch summary and a title page: a play counts once per resume chain, an
 * episode counts for its show, and a merged alias folds into its winner. Title, year and
 * poster come from a live library item on the selected servers, falling back to the media row
 * once every copy is gone. serverIds lists the servers whose plays contributed.
 */

import {
  CACHE_TTL,
  REDIS_KEYS,
  topContentQuerySchema,
  type TopContentQueryInput,
  type TopMoviesResponse,
  type TopShowsResponse,
} from '@tracearr/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import {
  buildLibraryCacheKey,
  LI_HAS_KNOWN_IMAGE,
  resolveLibraryWindow,
  rollupDayWindowSql,
} from './utils.js';
import { serverCacheSegment } from '../../lib/scope.js';

type SortBy = TopContentQueryInput['sortBy'];

export interface TopContentQuery {
  window: { startDate: Date | null; endDate: Date };
  serverIds: string[] | undefined;
  sortBy: SortBy;
  sortOrder: 'asc' | 'desc';
  limit: number;
  offset: number;
}

interface RawSummaryRow {
  summary_titles: string;
  summary_watch_hours: string;
}

interface RawTitleRow extends RawSummaryRow {
  ident: string;
  title: string;
  year: number | null;
  thumb_path: string | null;
  server_id: string;
  server_ids: string[];
  total_plays: string;
  total_watch_hours: string;
  unique_viewers: string;
  completion_rate: string | null;
  binge_score: string | null;
}

const SORT_COLUMNS: Record<SortBy, string> = {
  plays: 'total_plays',
  watch_hours: 'watched_ms',
  viewers: 'unique_viewers',
  completion_rate: 'completion_rate',
  binge_score: 'binge_score',
};

// A chain counts as completed the way the watch summary counts it. The alias joins hash only
// the merged rows (the partial index on merged_into_id) instead of probing media per play.
const COMPLETED = sql`(p.any_watched OR p.max_progress_ms >= 0.85 * p.content_duration_ms)`;

function playsCte(type: 'movie' | 'show', input: TopContentQuery): SQL {
  const window = rollupDayWindowSql(input.window, sql`p.day`);
  const serverFilter = buildMultiServerFragment(input.serverIds, 'p.server_id');
  if (type === 'movie') {
    return sql`
      SELECT COALESCE(pm.merged_into_id, p.media_id) AS ident,
        COALESCE(pm.merged_into_id, p.media_id) AS episode,
        su.user_id, p.server_id, p.chain_id, p.counted, p.watched_ms, p.day, ${COMPLETED} AS completed
      FROM user_media_plays_daily p
      JOIN server_users su ON su.id = p.server_user_id
      LEFT JOIN media pm ON pm.id = p.media_id AND pm.merged_into_id IS NOT NULL
      WHERE p.media_type = 'movie' ${window} ${serverFilter}`;
  }
  return sql`
      SELECT COALESCE(sh.merged_into_id, p.show_media_id) AS ident,
        COALESCE(pm.merged_into_id, p.media_id) AS episode,
        su.user_id, p.server_id, p.chain_id, p.counted, p.watched_ms, p.day, ${COMPLETED} AS completed
      FROM user_media_plays_daily p
      JOIN server_users su ON su.id = p.server_user_id
      LEFT JOIN media pm ON pm.id = p.media_id AND pm.merged_into_id IS NOT NULL
      LEFT JOIN media sh ON sh.id = p.show_media_id AND sh.merged_into_id IS NOT NULL
      WHERE p.media_type = 'episode' AND p.show_media_id IS NOT NULL ${window} ${serverFilter}`;
}

/**
 * One row per title ident with at least one counted play in the window, plus the summary over
 * all of them. Movies and shows share the shape: a movie is a show with one episode, so the
 * per-viewer episode rollup gives the movie completion rate and the show binge score alike.
 */
function topContentCtes(type: 'movie' | 'show', input: TopContentQuery): SQL {
  return sql`
    WITH plays AS (${playsCte(type, input)}),
    viewer_episodes AS (
      SELECT ident, user_id, episode,
        COUNT(DISTINCT chain_id) FILTER (WHERE counted) AS plays,
        SUM(watched_ms) AS watched_ms,
        BOOL_OR(completed) FILTER (WHERE counted) AS completed,
        COUNT(DISTINCT day) FILTER (WHERE counted) AS viewing_days
      FROM plays
      GROUP BY ident, user_id, episode
    ),
    viewer_titles AS (
      SELECT ident, user_id, SUM(plays) AS plays, SUM(watched_ms) AS watched_ms,
        COUNT(*) FILTER (WHERE plays > 0) AS episodes_watched,
        COUNT(*) FILTER (WHERE completed) AS completed_episodes,
        SUM(viewing_days) AS viewing_days
      FROM viewer_episodes
      GROUP BY ident, user_id
    ),
    titles AS (
      SELECT ident, SUM(plays) AS total_plays, SUM(watched_ms) AS watched_ms,
        -- countedViewersSql's rule at per-identity grain: a viewer has a counted play
        COUNT(*) FILTER (WHERE plays > 0) AS unique_viewers,
        ROUND(100.0 * SUM(completed_episodes) / NULLIF(SUM(episodes_watched), 0), 1) AS completion_rate,
        LEAST(100, ROUND(
          40 * (AVG(episodes_watched) * ROUND(100.0 * SUM(completed_episodes) / NULLIF(SUM(episodes_watched), 0), 1) / 100 / 10) +
          30 * (SUM(viewing_days)::numeric / NULLIF(COUNT(*) FILTER (WHERE watched_ms > 0), 0) * 2) +
          30 * (SUM(completed_episodes)::numeric / NULLIF(SUM(episodes_watched), 0))
        , 0)) AS binge_score
      FROM viewer_titles
      GROUP BY ident
      HAVING SUM(plays) > 0
    ),
    title_servers AS (
      SELECT ident, array_agg(DISTINCT server_id::text ORDER BY server_id::text) AS server_ids
      FROM plays
      GROUP BY ident
    ),
    summary AS (
      SELECT (SELECT COUNT(*) FROM titles)::text AS summary_titles,
        COALESCE(ROUND((SELECT SUM(watched_ms) FROM plays) / 3600000.0, 1), 0)::text AS summary_watch_hours
    )`;
}

export function buildTopContentQuery(type: 'movie' | 'show', input: TopContentQuery): SQL {
  const direction = input.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const sortColumn = SORT_COLUMNS[input.sortBy];
  const orderBy = (alias: string) =>
    sql.raw(`${alias}${sortColumn} ${direction} NULLS LAST, ${alias}ident`);
  const serverFilterOnLi = buildMultiServerFragment(input.serverIds, 'li.server_id');
  return sql`
    ${topContentCtes(type, input)}
    SELECT t.ident::text AS ident,
      COALESCE(li.title, md.title) AS title,
      COALESCE(li.year, md.year) AS year,
      li.thumb_path,
      COALESCE(li.server_id, ts.server_ids[1]::uuid) AS server_id,
      ts.server_ids,
      t.total_plays::text AS total_plays,
      ROUND(t.watched_ms / 3600000.0, 1)::text AS total_watch_hours,
      t.unique_viewers::text AS unique_viewers,
      t.completion_rate::text AS completion_rate,
      t.binge_score::text AS binge_score,
      s.*
    FROM (
      SELECT * FROM titles ORDER BY ${orderBy('')} LIMIT ${input.limit} OFFSET ${input.offset}
    ) t
    JOIN media md ON md.id = t.ident
    JOIN title_servers ts ON ts.ident = t.ident
    LEFT JOIN LATERAL (
      SELECT li.title, li.year, li.thumb_path, li.server_id
      FROM library_items li
      WHERE li.removed_at IS NULL AND li.media_type = ${type}
        AND li.media_id IN (SELECT id FROM media WHERE id = t.ident OR merged_into_id = t.ident)
        ${serverFilterOnLi}
      ORDER BY ${LI_HAS_KNOWN_IMAGE} DESC, li.created_at, li.id
      LIMIT 1
    ) li ON true
    CROSS JOIN summary s
    ORDER BY ${orderBy('t.')}`;
}

export function buildTopContentSummaryQuery(
  type: 'movie' | 'show',
  input: Omit<TopContentQuery, 'sortBy' | 'sortOrder' | 'limit' | 'offset'>
): SQL {
  return sql`${topContentCtes(type, { ...input, sortBy: 'plays', sortOrder: 'desc', limit: 0, offset: 0 })}
    SELECT * FROM summary`;
}

const toInt = (value: string | null | undefined) => parseInt(value ?? '0', 10) || 0;
const toFloat = (value: string | null | undefined) => parseFloat(value ?? '0') || 0;

async function queryTopContent(
  type: 'movie' | 'show',
  input: TopContentQuery
): Promise<{ rows: RawTitleRow[]; total: number; totalWatchHours: number }> {
  const rows = (await db.execute(buildTopContentQuery(type, input)))
    .rows as unknown as RawTitleRow[];
  const summary =
    rows[0] ??
    ((await db.execute(buildTopContentSummaryQuery(type, input)))
      .rows[0] as unknown as RawSummaryRow);
  return {
    rows,
    total: toInt(summary.summary_titles),
    totalWatchHours: toFloat(summary.summary_watch_hours),
  };
}

interface TopContentPage {
  rows: RawTitleRow[];
  total: number;
  totalWatchHours: number;
  page: number;
  pageSize: number;
}

function toMovies(r: TopContentPage): TopMoviesResponse {
  return {
    items: r.rows.map((row) => ({
      ratingKey: row.ident,
      title: row.title,
      year: row.year,
      thumbPath: row.thumb_path,
      serverId: row.server_id,
      serverIds: row.server_ids,
      totalPlays: toInt(row.total_plays),
      totalWatchHours: toFloat(row.total_watch_hours),
      uniqueViewers: toInt(row.unique_viewers),
      completionRate: toFloat(row.completion_rate),
    })),
    summary: { totalMovies: r.total, totalWatchHours: r.totalWatchHours },
    pagination: { page: r.page, pageSize: r.pageSize, total: r.total },
  };
}

function toShows(r: TopContentPage): TopShowsResponse {
  return {
    items: r.rows.map((row) => ({
      mediaId: row.ident,
      showTitle: row.title,
      year: row.year,
      thumbPath: row.thumb_path,
      serverId: row.server_id,
      serverIds: row.server_ids,
      totalEpisodeViews: toInt(row.total_plays),
      totalWatchHours: toFloat(row.total_watch_hours),
      uniqueViewers: toInt(row.unique_viewers),
      avgCompletionRate: toFloat(row.completion_rate),
      bingeScore: toFloat(row.binge_score),
    })),
    summary: { totalShows: r.total, totalWatchHours: r.totalWatchHours },
    pagination: { page: r.page, pageSize: r.pageSize, total: r.total },
  };
}

const EMPTY_PAGE: Omit<TopContentPage, 'page' | 'pageSize'> = {
  rows: [],
  total: 0,
  totalWatchHours: 0,
};

export const libraryTopContentRoute: FastifyPluginAsync = async (app) => {
  const register = (
    path: string,
    type: 'movie' | 'show',
    cachePrefix: string,
    ttl: number,
    toResponse: (page: TopContentPage) => TopMoviesResponse | TopShowsResponse
  ) => {
    app.get<{ Querystring: TopContentQueryInput }>(
      path,
      { preHandler: [app.requirePermission('insights', 'read')] },
      async (request, reply) => {
        const query = topContentQuerySchema.safeParse(request.query);
        if (!query.success) {
          return reply.badRequest('Invalid query parameters');
        }

        const { serverId, serverIds, sortBy, sortOrder, page, pageSize } = query.data;
        const { startDate, endDate, cacheSegment } = resolveLibraryWindow(query.data);
        const resolvedIds = resolveServerIds(request.user, serverId, serverIds);
        if (resolvedIds?.length === 0) {
          return toResponse({ ...EMPTY_PAGE, page, pageSize });
        }

        const cacheKey = buildLibraryCacheKey(
          cachePrefix,
          serverCacheSegment(resolvedIds),
          `${cacheSegment}-${sortBy}-${sortOrder}-${page}-${pageSize}`
        );
        const cached = await app.redis.get(cacheKey);
        if (cached) {
          try {
            return JSON.parse(cached) as TopMoviesResponse | TopShowsResponse;
          } catch {
            // Fall through to compute
          }
        }

        const result = await queryTopContent(type, {
          window: { startDate, endDate },
          serverIds: resolvedIds,
          sortBy,
          sortOrder,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        });
        const response = toResponse({ ...result, page, pageSize });
        await app.redis.setex(cacheKey, ttl, JSON.stringify(response));
        return response;
      }
    );
  };

  register(
    '/top-movies',
    'movie',
    REDIS_KEYS.LIBRARY_TOP_MOVIES,
    CACHE_TTL.LIBRARY_TOP_MOVIES,
    toMovies
  );
  register(
    '/top-shows',
    'show',
    REDIS_KEYS.LIBRARY_TOP_SHOWS,
    CACHE_TTL.LIBRARY_TOP_SHOWS,
    toShows
  );
};
