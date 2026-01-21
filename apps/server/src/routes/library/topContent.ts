/**
 * Library Top Content Routes
 *
 * GET /top-movies - Top movies by plays/watch time with time filtering
 * GET /top-shows - Top TV shows by engagement with binge scoring
 *
 * Features:
 * - Time period filtering (7d, 30d, 90d, 1y, all)
 * - Server-side sorting on all metrics
 * - Pagination support
 * - Uses fixed engagement functions (array_agg for UUIDs)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  topContentQuerySchema,
  type TopContentQueryInput,
  type TopMoviesResponse,
  type TopShowsResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Raw row from database for movies */
interface RawMovieRow {
  rating_key: string;
  media_title: string;
  year: number | null;
  thumb_path: string | null;
  server_id: string;
  total_plays: string;
  total_watch_hours: string;
  unique_viewers: string;
  completion_rate: string;
}

/** Raw row from database for shows */
interface RawShowRow {
  show_title: string;
  year: number | null;
  thumb_path: string | null;
  server_id: string;
  total_episode_views: string;
  total_watch_hours: string;
  unique_viewers: string;
  avg_completion_rate: string;
  binge_score: string;
}

/** Convert period string to date range */
function getPeriodDates(period: string): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  let startDate: Date;

  switch (period) {
    case '7d':
      startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '90d':
      startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case '1y':
      startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    case 'all':
    default:
      startDate = new Date(0); // Beginning of time
      break;
  }

  return { startDate, endDate };
}

export const libraryTopContentRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /top-movies - Top movies by engagement metrics
   *
   * Returns movies sorted by plays, watch hours, viewers, or completion rate.
   * Supports time period filtering.
   */
  app.get<{ Querystring: TopContentQueryInput }>(
    '/top-movies',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = topContentQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, period, sortBy, sortOrder, page, pageSize } = query.data;
      const authUser = request.user;

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      // Build cache key
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_TOP_MOVIES,
        serverId,
        `${period}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as TopMoviesResponse;
        } catch {
          // Fall through to compute
        }
      }

      const { startDate, endDate } = getPeriodDates(period);
      const offset = (page - 1) * pageSize;

      // Sort column mapping - movies don't have binge_score
      const sortColumnMap: Record<string, string> = {
        plays: 'total_plays',
        watch_hours: 'total_watch_hours',
        viewers: 'unique_viewers',
        completion_rate: 'completion_rate',
        binge_score: 'total_plays', // fallback for movies
      };
      const sortColumn = sortColumnMap[sortBy] || 'total_plays';
      const sortDir = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';

      // Main query using get_content_engagement function
      const itemsResult = await db.execute(sql`
        SELECT
          rating_key,
          media_title,
          year,
          thumb_path,
          server_id,
          total_plays,
          total_watch_hours,
          unique_viewers,
          completion_rate
        FROM get_content_engagement(
          ${startDate}::timestamptz,
          ${endDate}::timestamptz,
          ${serverId ?? null}::uuid,
          'movie'
        )
        WHERE media_title IS NOT NULL
        ORDER BY ${sql.raw(sortColumn)} ${sql.raw(sortDir)}
        LIMIT ${pageSize} OFFSET ${offset}
      `);

      const items = (itemsResult.rows as unknown as RawMovieRow[]).map((row) => ({
        ratingKey: row.rating_key,
        title: row.media_title,
        year: row.year,
        thumbPath: row.thumb_path,
        serverId: row.server_id,
        totalPlays: parseInt(row.total_plays, 10) || 0,
        totalWatchHours: parseFloat(row.total_watch_hours) || 0,
        uniqueViewers: parseInt(row.unique_viewers, 10) || 0,
        completionRate: parseFloat(row.completion_rate) || 0,
      }));

      // Summary query
      const summaryResult = await db.execute(sql`
        SELECT
          COUNT(*) AS total_movies,
          COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours
        FROM get_content_engagement(
          ${startDate}::timestamptz,
          ${endDate}::timestamptz,
          ${serverId ?? null}::uuid,
          'movie'
        )
        WHERE media_title IS NOT NULL
      `);

      const summaryRow = summaryResult.rows[0] as {
        total_movies: string;
        total_watch_hours: string;
      };
      const total = parseInt(summaryRow.total_movies, 10) || 0;

      const response: TopMoviesResponse = {
        items,
        summary: {
          totalMovies: total,
          totalWatchHours: parseFloat(summaryRow.total_watch_hours) || 0,
        },
        pagination: { page, pageSize, total },
      };

      // Cache response
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_TOP_MOVIES, JSON.stringify(response));

      return response;
    }
  );

  /**
   * GET /top-shows - Top TV shows by engagement metrics
   *
   * Returns TV shows sorted by episode views, watch hours, viewers, completion rate, or binge score.
   * Supports time period filtering.
   */
  app.get<{ Querystring: TopContentQueryInput }>(
    '/top-shows',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = topContentQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, period, sortBy, sortOrder, page, pageSize } = query.data;
      const authUser = request.user;

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      // Build cache key
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_TOP_SHOWS,
        serverId,
        `${period}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as TopShowsResponse;
        } catch {
          // Fall through to compute
        }
      }

      const { startDate, endDate } = getPeriodDates(period);
      const offset = (page - 1) * pageSize;

      // Sort column mapping
      const sortColumnMap: Record<string, string> = {
        plays: 'total_episode_views',
        watch_hours: 'total_watch_hours',
        viewers: 'unique_viewers',
        completion_rate: 'avg_completion_rate',
        binge_score: 'binge_score',
      };
      const sortColumn = sortColumnMap[sortBy] || 'total_episode_views';
      const sortDir = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';

      // Main query using get_show_engagement function
      const itemsResult = await db.execute(sql`
        SELECT
          show_title,
          year,
          thumb_path,
          server_id,
          total_episode_views,
          total_watch_hours,
          unique_viewers,
          avg_completion_rate,
          binge_score
        FROM get_show_engagement(
          ${startDate}::timestamptz,
          ${endDate}::timestamptz,
          ${serverId ?? null}::uuid
        )
        WHERE show_title IS NOT NULL
        ORDER BY ${sql.raw(sortColumn)} ${sql.raw(sortDir)}
        LIMIT ${pageSize} OFFSET ${offset}
      `);

      const items = (itemsResult.rows as unknown as RawShowRow[]).map((row) => ({
        showTitle: row.show_title,
        year: row.year,
        thumbPath: row.thumb_path,
        serverId: row.server_id,
        totalEpisodeViews: parseInt(row.total_episode_views, 10) || 0,
        totalWatchHours: parseFloat(row.total_watch_hours) || 0,
        uniqueViewers: parseInt(row.unique_viewers, 10) || 0,
        avgCompletionRate: parseFloat(row.avg_completion_rate) || 0,
        bingeScore: parseFloat(row.binge_score) || 0,
      }));

      // Summary query
      const summaryResult = await db.execute(sql`
        SELECT
          COUNT(*) AS total_shows,
          COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours
        FROM get_show_engagement(
          ${startDate}::timestamptz,
          ${endDate}::timestamptz,
          ${serverId ?? null}::uuid
        )
        WHERE show_title IS NOT NULL
      `);

      const summaryRow = summaryResult.rows[0] as {
        total_shows: string;
        total_watch_hours: string;
      };
      const total = parseInt(summaryRow.total_shows, 10) || 0;

      const response: TopShowsResponse = {
        items,
        summary: {
          totalShows: total,
          totalWatchHours: parseFloat(summaryRow.total_watch_hours) || 0,
        },
        pagination: { page, pageSize, total },
      };

      // Cache response
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_TOP_SHOWS, JSON.stringify(response));

      return response;
    }
  );
};
