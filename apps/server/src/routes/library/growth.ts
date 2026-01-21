/**
 * Library Growth Route
 *
 * GET /growth - Time-series library growth data points
 *
 * Uses library_items.created_at (Plex's addedAt) for accurate growth tracking
 * based on when items were actually added to the media server.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  TIME_MS,
  libraryGrowthQuerySchema,
  type LibraryGrowthQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Single data point in growth timeline (per media type) */
interface GrowthDataPoint {
  day: string;
  total: number;
  additions: number;
}

/** Library growth response shape with separate series per media type */
interface LibraryGrowthResponse {
  period: string;
  movies: GrowthDataPoint[];
  episodes: GrowthDataPoint[];
  music: GrowthDataPoint[];
}

/**
 * Calculate start date based on period string.
 */
function getStartDate(period: '7d' | '30d' | '90d' | '1y' | 'all'): Date | null {
  const now = new Date();
  switch (period) {
    case '7d':
      return new Date(now.getTime() - 7 * TIME_MS.DAY);
    case '30d':
      return new Date(now.getTime() - 30 * TIME_MS.DAY);
    case '90d':
      return new Date(now.getTime() - 90 * TIME_MS.DAY);
    case '1y':
      return new Date(now.getTime() - 365 * TIME_MS.DAY);
    case 'all':
      return null;
  }
}

export const libraryGrowthRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /growth - Library growth timeline
   *
   * Returns time-series data showing items added per day based on
   * library_items.created_at (Plex's addedAt timestamp).
   *
   * Note: Removals are set to 0 since we don't track deletion dates.
   */
  app.get<{ Querystring: LibraryGrowthQueryInput }>(
    '/growth',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryGrowthQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, libraryId, period, timezone } = query.data;
      const authUser = request.user;
      const tz = timezone ?? 'UTC';

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      // Build cache key with all varying params
      const cacheKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_GROWTH, serverId, period, tz);

      // Add libraryId to cache key if provided
      const fullCacheKey = libraryId ? `${cacheKey}:${libraryId}` : cacheKey;

      // Try cache first
      const cached = await app.redis.get(fullCacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryGrowthResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build server filter for library_items table
      const serverFilter = serverId
        ? sql`AND li.server_id = ${serverId}::uuid`
        : authUser.serverIds?.length
          ? sql`AND li.server_id = ANY(${authUser.serverIds}::uuid[])`
          : sql``;

      // Optional library filter
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;

      // Calculate date range
      const startDate = getStartDate(period);
      const endDate = new Date();

      // For 'all' period, find the earliest item date from the database
      let effectiveStartDate: Date;
      if (startDate) {
        effectiveStartDate = startDate;
      } else {
        // Query for the earliest created_at date
        const earliestResult = await db.execute(sql`
          SELECT MIN(created_at)::date AS earliest
          FROM library_items li
          WHERE li.media_type IN ('movie', 'episode', 'track')
            ${serverFilter}
            ${libraryFilter}
        `);
        const earliest = (earliestResult.rows[0] as { earliest: string | null })?.earliest;
        effectiveStartDate = earliest ? new Date(earliest) : new Date('2020-01-01');
      }

      // Query with continuous date series for each category
      // This ensures we have data points for every day, even if nothing was added
      const result = await db.execute(sql`
        WITH date_series AS (
          -- Generate all dates in the range
          SELECT d::date AS day
          FROM generate_series(
            ${effectiveStartDate.toISOString()}::date,
            ${endDate.toISOString()}::date,
            '1 day'::interval
          ) d
        ),
        categories AS (
          -- The three media type categories we care about
          SELECT unnest(ARRAY['movie', 'episode', 'track']) AS category
        ),
        date_category_grid AS (
          -- Cross join to get all date+category combinations
          SELECT ds.day, c.category
          FROM date_series ds
          CROSS JOIN categories c
        ),
        base_counts AS (
          -- Count ALL items per category (total library size)
          SELECT
            CASE
              WHEN li.media_type = 'movie' THEN 'movie'
              WHEN li.media_type = 'episode' THEN 'episode'
              WHEN li.media_type = 'track' THEN 'track'
            END AS category,
            COUNT(*)::int AS total_items
          FROM library_items li
          WHERE li.media_type IN ('movie', 'episode', 'track')
            ${serverFilter}
            ${libraryFilter}
          GROUP BY 1
        ),
        items_before_period AS (
          -- Count items added BEFORE the period (for calculating running total)
          SELECT
            CASE
              WHEN li.media_type = 'movie' THEN 'movie'
              WHEN li.media_type = 'episode' THEN 'episode'
              WHEN li.media_type = 'track' THEN 'track'
            END AS category,
            COUNT(*)::int AS items_before
          FROM library_items li
          WHERE li.media_type IN ('movie', 'episode', 'track')
            ${serverFilter}
            ${libraryFilter}
            AND li.created_at < ${effectiveStartDate.toISOString()}::timestamptz
          GROUP BY 1
        ),
        daily_additions AS (
          -- Count items added per day per category
          SELECT
            DATE(li.created_at AT TIME ZONE ${tz}) AS day,
            CASE
              WHEN li.media_type = 'movie' THEN 'movie'
              WHEN li.media_type = 'episode' THEN 'episode'
              WHEN li.media_type = 'track' THEN 'track'
            END AS category,
            COUNT(*)::int AS additions
          FROM library_items li
          WHERE li.media_type IN ('movie', 'episode', 'track')
            ${serverFilter}
            ${libraryFilter}
            AND li.created_at >= ${effectiveStartDate.toISOString()}::timestamptz
          GROUP BY 1, 2
        ),
        filled_data AS (
          -- Join grid with actual data, fill nulls with 0
          SELECT
            dcg.day,
            dcg.category,
            COALESCE(da.additions, 0) AS additions,
            COALESCE(ibp.items_before, 0) AS items_before
          FROM date_category_grid dcg
          LEFT JOIN daily_additions da ON da.day = dcg.day AND da.category = dcg.category
          LEFT JOIN items_before_period ibp ON ibp.category = dcg.category
        )
        SELECT
          fd.day::text,
          fd.category,
          fd.additions,
          (fd.items_before + SUM(fd.additions) OVER (PARTITION BY fd.category ORDER BY fd.day))::int AS total
        FROM filled_data fd
        WHERE EXISTS (
          -- Only include categories that have items
          SELECT 1 FROM base_counts bc WHERE bc.category = fd.category
        )
        ORDER BY fd.day ASC, fd.category
      `);

      const rows = result.rows as Array<{
        day: string;
        category: string;
        additions: number;
        total: number;
      }>;

      // Separate into movies, episodes, music arrays
      const movies: GrowthDataPoint[] = [];
      const episodes: GrowthDataPoint[] = [];
      const music: GrowthDataPoint[] = [];

      for (const row of rows) {
        const point: GrowthDataPoint = {
          day: row.day,
          total: row.total,
          additions: row.additions,
        };

        switch (row.category) {
          case 'movie':
            movies.push(point);
            break;
          case 'episode':
            episodes.push(point);
            break;
          case 'track':
            music.push(point);
            break;
        }
      }

      const response: LibraryGrowthResponse = {
        period,
        movies,
        episodes,
        music,
      };

      // Cache for 5 minutes
      await app.redis.setex(fullCacheKey, CACHE_TTL.LIBRARY_GROWTH, JSON.stringify(response));

      return response;
    }
  );
};
