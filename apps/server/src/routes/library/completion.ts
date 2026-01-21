/**
 * Library Completion Rate Route
 *
 * GET /completion - Completion rate analysis for library content
 *
 * Provides:
 * - Movie completion: watched_ms / runtime_ms percentage
 * - Episode completion: per-episode with show/season context
 * - Season aggregation: X of Y episodes completed per season
 * - Series aggregation: X of Y seasons completed per series
 *
 * Uses 85% threshold for "completed" status (industry standard).
 * Joins with content_engagement_summary view for engagement tier reuse.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryCompletionQuerySchema,
  type LibraryCompletionQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

/** Completion status derived from 85% threshold */
type CompletionStatus = 'completed' | 'in_progress' | 'not_started';

/** Individual item completion for movies/episodes */
interface CompletionItem {
  id: string;
  serverId: string;
  serverName: string;
  title: string;
  mediaType: string;
  completionPct: number;
  watchedMs: number;
  runtimeMs: number;
  /** For episodes: show title */
  showTitle: string | null;
  /** For episodes: season number */
  seasonNumber: number | null;
  /** For episodes: episode number */
  episodeNumber: number | null;
  status: CompletionStatus;
  lastWatchedAt: string | null;
}

/** Season-level completion aggregation */
interface SeasonCompletion {
  serverId: string;
  serverName: string;
  showTitle: string;
  seasonNumber: number;
  totalEpisodes: number;
  completedEpisodes: number;
  inProgressEpisodes: number;
  completionPct: number;
  status: CompletionStatus;
}

/** Series-level completion aggregation */
interface SeriesCompletion {
  serverId: string;
  serverName: string;
  showTitle: string;
  totalSeasons: number;
  completedSeasons: number;
  totalEpisodes: number;
  completedEpisodes: number;
  avgSeasonCompletionPct: number;
  status: CompletionStatus;
}

/** Summary statistics */
interface CompletionSummary {
  totalItems: number;
  completedCount: number;
  inProgressCount: number;
  notStartedCount: number;
  overallCompletionPct: number;
}

/** Response type varies based on aggregateLevel */
type CompletionResponse =
  | { items: CompletionItem[]; summary: CompletionSummary; pagination: PaginationInfo }
  | { seasons: SeasonCompletion[]; summary: CompletionSummary; pagination: PaginationInfo }
  | { series: SeriesCompletion[]; summary: CompletionSummary; pagination: PaginationInfo };

interface PaginationInfo {
  page: number;
  pageSize: number;
  total: number;
}

/** Raw row for item-level query */
interface RawItemRow {
  id: string;
  server_id: string;
  server_name: string;
  title: string;
  media_type: string;
  completion_pct: string;
  watched_ms: string;
  runtime_ms: string;
  show_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  status: CompletionStatus;
  last_watched_at: string | null;
}

/** Raw row for season-level query */
interface RawSeasonRow {
  server_id: string;
  server_name: string;
  show_title: string;
  season_number: number;
  total_episodes: string;
  completed_episodes: string;
  in_progress_episodes: string;
  completion_pct: string;
  status: CompletionStatus;
}

/** Raw row for series-level query */
interface RawSeriesRow {
  server_id: string;
  server_name: string;
  show_title: string;
  total_seasons: string;
  completed_seasons: string;
  total_episodes: string;
  completed_episodes: string;
  avg_season_completion_pct: string;
  status: CompletionStatus;
}

/** Raw row for summary query */
interface RawSummaryRow {
  total_items: string;
  completed_count: string;
  in_progress_count: string;
  not_started_count: string;
  overall_completion_pct: string;
}

export const libraryCompletionRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /completion - Library completion rates
   *
   * Returns completion percentages at item, season, or series level.
   * Uses 85% threshold for "completed" status.
   */
  app.get<{ Querystring: LibraryCompletionQueryInput }>(
    '/completion',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryCompletionQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        libraryId,
        mediaType,
        aggregateLevel,
        status: statusFilter,
        minCompletionPct,
        maxCompletionPct,
        sortBy,
        sortOrder,
        page,
        pageSize,
      } = query.data;
      const authUser = request.user;

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      // Build cache key with all varying params
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_COMPLETION,
        serverId,
        `${libraryId ?? 'all'}-${mediaType ?? 'all'}-${aggregateLevel}-${statusFilter}-${minCompletionPct ?? 'none'}-${maxCompletionPct ?? 'none'}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as CompletionResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build base filters for library_items (li)
      const serverFilter = buildLibraryServerFilter(serverId, authUser, 'li');
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      const mediaTypeFilter = mediaType ? sql`AND li.media_type = ${mediaType}` : sql``;

      // Status filter
      const statusFilterSql =
        statusFilter === 'completed'
          ? sql`AND status = 'completed'`
          : statusFilter === 'in_progress'
            ? sql`AND status = 'in_progress'`
            : statusFilter === 'not_started'
              ? sql`AND status = 'not_started'`
              : sql``;

      // Completion percentage filters
      const minCompletionFilter =
        minCompletionPct !== undefined ? sql`AND completion_pct >= ${minCompletionPct}` : sql``;
      const maxCompletionFilter =
        maxCompletionPct !== undefined ? sql`AND completion_pct <= ${maxCompletionPct}` : sql``;

      const offset = (page - 1) * pageSize;

      // Route to appropriate aggregation level
      if (aggregateLevel === 'item') {
        return executeItemLevel(
          app,
          cacheKey,
          serverFilter,
          libraryFilter,
          mediaTypeFilter,
          statusFilterSql,
          minCompletionFilter,
          maxCompletionFilter,
          sortBy,
          sortOrder,
          pageSize,
          offset,
          page
        );
      } else if (aggregateLevel === 'season') {
        return executeSeasonLevel(
          app,
          cacheKey,
          serverFilter,
          statusFilterSql,
          minCompletionFilter,
          maxCompletionFilter,
          sortBy,
          sortOrder,
          pageSize,
          offset,
          page
        );
      } else {
        return executeSeriesLevel(
          app,
          cacheKey,
          serverFilter,
          statusFilterSql,
          sortBy,
          sortOrder,
          pageSize,
          offset,
          page
        );
      }
    }
  );
};

/** Execute item-level (movies/episodes) completion query */
async function executeItemLevel(
  app: Parameters<FastifyPluginAsync>[0],
  cacheKey: string,
  serverFilter: ReturnType<typeof sql>,
  libraryFilter: ReturnType<typeof sql>,
  mediaTypeFilter: ReturnType<typeof sql>,
  statusFilterSql: ReturnType<typeof sql>,
  minCompletionFilter: ReturnType<typeof sql>,
  maxCompletionFilter: ReturnType<typeof sql>,
  sortBy: string,
  sortOrder: string,
  pageSize: number,
  offset: number,
  page: number
) {
  // Sort column mapping
  const sortColumnMap: Record<string, ReturnType<typeof sql>> = {
    completion_pct: sql`completion_pct`,
    title: sql`title`,
    last_watched: sql`last_watched_at`,
  };
  const sortColumn = sortColumnMap[sortBy] || sql`completion_pct`;
  const sortDir = sortOrder === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS FIRST`;

  // Main query: join library_items with content_engagement_summary (aggregated across users)
  const itemsResult = await db.execute(sql`
    WITH item_engagement AS (
      SELECT
        li.id,
        li.server_id,
        s.name AS server_name,
        li.title,
        li.media_type,
        -- Aggregate engagement across all users for this content
        COALESCE(SUM(ces.cumulative_watched_ms), 0) AS watched_ms,
        COALESCE(MAX(ces.content_duration_ms), 0) AS runtime_ms,
        MAX(ces.show_title) AS show_title,
        MAX(ces.season_number) AS season_number,
        MAX(ces.episode_number) AS episode_number,
        MAX(ces.last_watched_at) AS last_watched_at,
        -- Derive status from engagement tier (any user completing = completed for library)
        BOOL_OR(ces.engagement_tier IN ('completed', 'finished', 'rewatched')) AS has_completion
      FROM library_items li
      JOIN servers s ON li.server_id = s.id
      LEFT JOIN content_engagement_summary ces
        ON ces.rating_key = li.rating_key
        AND ces.server_id = li.server_id
      WHERE 1=1
        ${serverFilter}
        ${libraryFilter}
        ${mediaTypeFilter}
      GROUP BY li.id, li.server_id, s.name, li.title, li.media_type
    ),
    with_completion AS (
      SELECT
        id,
        server_id,
        server_name,
        title,
        media_type,
        watched_ms,
        runtime_ms,
        show_title,
        season_number,
        episode_number,
        last_watched_at,
        CASE
          WHEN runtime_ms > 0 THEN ROUND(100.0 * watched_ms / runtime_ms, 1)
          ELSE 0
        END AS completion_pct,
        CASE
          WHEN has_completion THEN 'completed'
          WHEN watched_ms > 0 THEN 'in_progress'
          ELSE 'not_started'
        END AS status
      FROM item_engagement
    )
    SELECT
      id,
      server_id,
      server_name,
      title,
      media_type,
      completion_pct::text AS completion_pct,
      watched_ms::text AS watched_ms,
      runtime_ms::text AS runtime_ms,
      show_title,
      season_number,
      episode_number,
      status,
      last_watched_at::text AS last_watched_at
    FROM with_completion
    WHERE 1=1
      ${statusFilterSql}
      ${minCompletionFilter}
      ${maxCompletionFilter}
    ORDER BY ${sortColumn} ${sortDir}
    LIMIT ${pageSize} OFFSET ${offset}
  `);

  const items: CompletionItem[] = (itemsResult.rows as unknown as RawItemRow[]).map((row) => ({
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    title: row.title,
    mediaType: row.media_type,
    completionPct: parseFloat(row.completion_pct),
    watchedMs: parseInt(row.watched_ms, 10),
    runtimeMs: parseInt(row.runtime_ms, 10),
    showTitle: row.show_title,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    status: row.status,
    lastWatchedAt: row.last_watched_at,
  }));

  // Summary query
  const summaryResult = await db.execute(sql`
    WITH item_engagement AS (
      SELECT
        li.id,
        COALESCE(SUM(ces.cumulative_watched_ms), 0) AS watched_ms,
        COALESCE(MAX(ces.content_duration_ms), 0) AS runtime_ms,
        BOOL_OR(ces.engagement_tier IN ('completed', 'finished', 'rewatched')) AS has_completion
      FROM library_items li
      LEFT JOIN content_engagement_summary ces
        ON ces.rating_key = li.rating_key
        AND ces.server_id = li.server_id
      WHERE 1=1
        ${serverFilter}
        ${libraryFilter}
        ${mediaTypeFilter}
      GROUP BY li.id
    ),
    with_completion AS (
      SELECT
        id,
        CASE
          WHEN runtime_ms > 0 THEN ROUND(100.0 * watched_ms / runtime_ms, 1)
          ELSE 0
        END AS completion_pct,
        CASE
          WHEN has_completion THEN 'completed'
          WHEN watched_ms > 0 THEN 'in_progress'
          ELSE 'not_started'
        END AS status
      FROM item_engagement
    ),
    filtered AS (
      SELECT * FROM with_completion
      WHERE 1=1
        ${statusFilterSql}
        ${minCompletionFilter}
        ${maxCompletionFilter}
    )
    SELECT
      COUNT(*) AS total_items,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
      COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress_count,
      COUNT(*) FILTER (WHERE status = 'not_started') AS not_started_count,
      ROUND(AVG(completion_pct), 1)::text AS overall_completion_pct
    FROM filtered
  `);

  const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;
  const totalItems = parseInt(summaryRow.total_items, 10) || 0;

  const summary: CompletionSummary = {
    totalItems,
    completedCount: parseInt(summaryRow.completed_count, 10) || 0,
    inProgressCount: parseInt(summaryRow.in_progress_count, 10) || 0,
    notStartedCount: parseInt(summaryRow.not_started_count, 10) || 0,
    overallCompletionPct: parseFloat(summaryRow.overall_completion_pct || '0'),
  };

  const response = {
    items,
    summary,
    pagination: { page, pageSize, total: totalItems },
  };

  await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_COMPLETION, JSON.stringify(response));
  return response;
}

/** Execute season-level completion aggregation */
async function executeSeasonLevel(
  app: Parameters<FastifyPluginAsync>[0],
  cacheKey: string,
  serverFilter: ReturnType<typeof sql>,
  statusFilterSql: ReturnType<typeof sql>,
  minCompletionFilter: ReturnType<typeof sql>,
  maxCompletionFilter: ReturnType<typeof sql>,
  sortBy: string,
  sortOrder: string,
  pageSize: number,
  offset: number,
  page: number
) {
  // Sort column mapping (different columns for season view)
  const sortColumnMap: Record<string, ReturnType<typeof sql>> = {
    completion_pct: sql`completion_pct`,
    title: sql`show_title`,
    last_watched: sql`show_title`, // No last_watched at season level, fall back to title
  };
  const sortColumn = sortColumnMap[sortBy] || sql`completion_pct`;
  const sortDir = sortOrder === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS FIRST`;

  const seasonsResult = await db.execute(sql`
    WITH episode_stats AS (
      SELECT
        li.server_id,
        s.name AS server_name,
        ces.show_title,
        ces.season_number,
        COUNT(DISTINCT li.id) AS total_episodes,
        COUNT(DISTINCT li.id) FILTER (
          WHERE ces.engagement_tier IN ('completed', 'finished', 'rewatched')
        ) AS completed_episodes,
        COUNT(DISTINCT li.id) FILTER (
          WHERE ces.engagement_tier IN ('engaged', 'sampled')
        ) AS in_progress_episodes
      FROM library_items li
      JOIN servers s ON li.server_id = s.id
      LEFT JOIN content_engagement_summary ces
        ON ces.rating_key = li.rating_key
        AND ces.server_id = li.server_id
      WHERE li.media_type = 'episode'
        AND ces.show_title IS NOT NULL
        AND ces.season_number IS NOT NULL
        ${serverFilter}
      GROUP BY li.server_id, s.name, ces.show_title, ces.season_number
    ),
    with_completion AS (
      SELECT
        server_id,
        server_name,
        show_title,
        season_number,
        total_episodes,
        completed_episodes,
        in_progress_episodes,
        ROUND(100.0 * completed_episodes / NULLIF(total_episodes, 0), 1) AS completion_pct,
        CASE
          WHEN completed_episodes >= total_episodes * 0.85 THEN 'completed'
          WHEN completed_episodes + in_progress_episodes > 0 THEN 'in_progress'
          ELSE 'not_started'
        END AS status
      FROM episode_stats
    )
    SELECT
      server_id,
      server_name,
      show_title,
      season_number,
      total_episodes::text AS total_episodes,
      completed_episodes::text AS completed_episodes,
      in_progress_episodes::text AS in_progress_episodes,
      completion_pct::text AS completion_pct,
      status
    FROM with_completion
    WHERE 1=1
      ${statusFilterSql}
      ${minCompletionFilter}
      ${maxCompletionFilter}
    ORDER BY ${sortColumn} ${sortDir}
    LIMIT ${pageSize} OFFSET ${offset}
  `);

  const seasons: SeasonCompletion[] = (seasonsResult.rows as unknown as RawSeasonRow[]).map(
    (row) => ({
      serverId: row.server_id,
      serverName: row.server_name,
      showTitle: row.show_title,
      seasonNumber: row.season_number,
      totalEpisodes: parseInt(row.total_episodes, 10),
      completedEpisodes: parseInt(row.completed_episodes, 10),
      inProgressEpisodes: parseInt(row.in_progress_episodes, 10),
      completionPct: parseFloat(row.completion_pct),
      status: row.status,
    })
  );

  // Summary for seasons
  const summaryResult = await db.execute(sql`
    WITH episode_stats AS (
      SELECT
        li.server_id,
        ces.show_title,
        ces.season_number,
        COUNT(DISTINCT li.id) AS total_episodes,
        COUNT(DISTINCT li.id) FILTER (
          WHERE ces.engagement_tier IN ('completed', 'finished', 'rewatched')
        ) AS completed_episodes,
        COUNT(DISTINCT li.id) FILTER (
          WHERE ces.engagement_tier IN ('engaged', 'sampled')
        ) AS in_progress_episodes
      FROM library_items li
      LEFT JOIN content_engagement_summary ces
        ON ces.rating_key = li.rating_key
        AND ces.server_id = li.server_id
      WHERE li.media_type = 'episode'
        AND ces.show_title IS NOT NULL
        AND ces.season_number IS NOT NULL
        ${serverFilter}
      GROUP BY li.server_id, ces.show_title, ces.season_number
    ),
    with_completion AS (
      SELECT
        ROUND(100.0 * completed_episodes / NULLIF(total_episodes, 0), 1) AS completion_pct,
        CASE
          WHEN completed_episodes >= total_episodes * 0.85 THEN 'completed'
          WHEN completed_episodes + in_progress_episodes > 0 THEN 'in_progress'
          ELSE 'not_started'
        END AS status
      FROM episode_stats
    ),
    filtered AS (
      SELECT * FROM with_completion
      WHERE 1=1
        ${statusFilterSql}
        ${minCompletionFilter}
        ${maxCompletionFilter}
    )
    SELECT
      COUNT(*) AS total_items,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
      COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress_count,
      COUNT(*) FILTER (WHERE status = 'not_started') AS not_started_count,
      COALESCE(ROUND(AVG(completion_pct), 1), 0)::text AS overall_completion_pct
    FROM filtered
  `);

  const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;
  const totalItems = parseInt(summaryRow.total_items, 10) || 0;

  const summary: CompletionSummary = {
    totalItems,
    completedCount: parseInt(summaryRow.completed_count, 10) || 0,
    inProgressCount: parseInt(summaryRow.in_progress_count, 10) || 0,
    notStartedCount: parseInt(summaryRow.not_started_count, 10) || 0,
    overallCompletionPct: parseFloat(summaryRow.overall_completion_pct || '0'),
  };

  const response = {
    seasons,
    summary,
    pagination: { page, pageSize, total: totalItems },
  };

  await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_COMPLETION, JSON.stringify(response));
  return response;
}

/** Execute series-level completion aggregation */
async function executeSeriesLevel(
  app: Parameters<FastifyPluginAsync>[0],
  cacheKey: string,
  serverFilter: ReturnType<typeof sql>,
  statusFilterSql: ReturnType<typeof sql>,
  sortBy: string,
  sortOrder: string,
  pageSize: number,
  offset: number,
  page: number
) {
  // Sort column mapping for series
  const sortColumnMap: Record<string, ReturnType<typeof sql>> = {
    completion_pct: sql`avg_season_completion_pct`,
    title: sql`show_title`,
    last_watched: sql`show_title`, // Fall back to title
  };
  const sortColumn = sortColumnMap[sortBy] || sql`avg_season_completion_pct`;
  const sortDir = sortOrder === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS FIRST`;

  const seriesResult = await db.execute(sql`
    WITH episode_stats AS (
      SELECT
        li.server_id,
        s.name AS server_name,
        ces.show_title,
        ces.season_number,
        COUNT(DISTINCT li.id) AS total_episodes,
        COUNT(DISTINCT li.id) FILTER (
          WHERE ces.engagement_tier IN ('completed', 'finished', 'rewatched')
        ) AS completed_episodes
      FROM library_items li
      JOIN servers s ON li.server_id = s.id
      LEFT JOIN content_engagement_summary ces
        ON ces.rating_key = li.rating_key
        AND ces.server_id = li.server_id
      WHERE li.media_type = 'episode'
        AND ces.show_title IS NOT NULL
        AND ces.season_number IS NOT NULL
        ${serverFilter}
      GROUP BY li.server_id, s.name, ces.show_title, ces.season_number
    ),
    season_completion AS (
      SELECT
        server_id,
        server_name,
        show_title,
        season_number,
        total_episodes,
        completed_episodes,
        ROUND(100.0 * completed_episodes / NULLIF(total_episodes, 0), 1) AS completion_pct
      FROM episode_stats
    ),
    series_agg AS (
      SELECT
        server_id,
        server_name,
        show_title,
        COUNT(DISTINCT season_number) AS total_seasons,
        COUNT(DISTINCT season_number) FILTER (WHERE completion_pct >= 85) AS completed_seasons,
        SUM(total_episodes) AS total_episodes,
        SUM(completed_episodes) AS completed_episodes,
        ROUND(AVG(completion_pct), 1) AS avg_season_completion_pct
      FROM season_completion
      GROUP BY server_id, server_name, show_title
    ),
    with_status AS (
      SELECT
        server_id,
        server_name,
        show_title,
        total_seasons,
        completed_seasons,
        total_episodes,
        completed_episodes,
        avg_season_completion_pct,
        CASE
          WHEN completed_seasons >= total_seasons * 0.85 THEN 'completed'
          WHEN completed_episodes > 0 THEN 'in_progress'
          ELSE 'not_started'
        END AS status
      FROM series_agg
    )
    SELECT
      server_id,
      server_name,
      show_title,
      total_seasons::text AS total_seasons,
      completed_seasons::text AS completed_seasons,
      total_episodes::text AS total_episodes,
      completed_episodes::text AS completed_episodes,
      avg_season_completion_pct::text AS avg_season_completion_pct,
      status
    FROM with_status
    WHERE 1=1
      ${statusFilterSql}
    ORDER BY ${sortColumn} ${sortDir}
    LIMIT ${pageSize} OFFSET ${offset}
  `);

  const series: SeriesCompletion[] = (seriesResult.rows as unknown as RawSeriesRow[]).map(
    (row) => ({
      serverId: row.server_id,
      serverName: row.server_name,
      showTitle: row.show_title,
      totalSeasons: parseInt(row.total_seasons, 10),
      completedSeasons: parseInt(row.completed_seasons, 10),
      totalEpisodes: parseInt(row.total_episodes, 10),
      completedEpisodes: parseInt(row.completed_episodes, 10),
      avgSeasonCompletionPct: parseFloat(row.avg_season_completion_pct),
      status: row.status,
    })
  );

  // Summary for series
  const summaryResult = await db.execute(sql`
    WITH episode_stats AS (
      SELECT
        li.server_id,
        ces.show_title,
        ces.season_number,
        COUNT(DISTINCT li.id) AS total_episodes,
        COUNT(DISTINCT li.id) FILTER (
          WHERE ces.engagement_tier IN ('completed', 'finished', 'rewatched')
        ) AS completed_episodes
      FROM library_items li
      LEFT JOIN content_engagement_summary ces
        ON ces.rating_key = li.rating_key
        AND ces.server_id = li.server_id
      WHERE li.media_type = 'episode'
        AND ces.show_title IS NOT NULL
        AND ces.season_number IS NOT NULL
        ${serverFilter}
      GROUP BY li.server_id, ces.show_title, ces.season_number
    ),
    season_completion AS (
      SELECT
        server_id,
        show_title,
        season_number,
        ROUND(100.0 * completed_episodes / NULLIF(total_episodes, 0), 1) AS completion_pct,
        completed_episodes
      FROM episode_stats
    ),
    series_agg AS (
      SELECT
        server_id,
        show_title,
        COUNT(DISTINCT season_number) AS total_seasons,
        COUNT(DISTINCT season_number) FILTER (WHERE completion_pct >= 85) AS completed_seasons,
        SUM(completed_episodes) AS completed_episodes
      FROM season_completion
      GROUP BY server_id, show_title
    ),
    with_status AS (
      SELECT
        CASE
          WHEN completed_seasons >= total_seasons * 0.85 THEN 'completed'
          WHEN completed_episodes > 0 THEN 'in_progress'
          ELSE 'not_started'
        END AS status
      FROM series_agg
    ),
    filtered AS (
      SELECT * FROM with_status
      WHERE 1=1
        ${statusFilterSql}
    )
    SELECT
      COUNT(*) AS total_items,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
      COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress_count,
      COUNT(*) FILTER (WHERE status = 'not_started') AS not_started_count,
      0::text AS overall_completion_pct
    FROM filtered
  `);

  const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;
  const totalItems = parseInt(summaryRow.total_items, 10) || 0;

  const summary: CompletionSummary = {
    totalItems,
    completedCount: parseInt(summaryRow.completed_count, 10) || 0,
    inProgressCount: parseInt(summaryRow.in_progress_count, 10) || 0,
    notStartedCount: parseInt(summaryRow.not_started_count, 10) || 0,
    overallCompletionPct: 0, // Not meaningful at series level
  };

  const response = {
    series,
    summary,
    pagination: { page, pageSize, total: totalItems },
  };

  await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_COMPLETION, JSON.stringify(response));
  return response;
}
