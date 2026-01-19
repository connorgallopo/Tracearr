/**
 * Library Growth Route
 *
 * GET /growth - Time-series library growth data points
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
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

/** Single data point in growth timeline */
interface GrowthDataPoint {
  day: string;
  totalItems: number;
  totalSizeBytes: string;
  additions: number;
  removals: number;
}

/** Library growth response shape */
interface LibraryGrowthResponse {
  period: string;
  data: GrowthDataPoint[];
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
   * Returns time-series data points showing daily library totals.
   * Calculates additions/removals as delta from previous day.
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

      // Calculate date range
      const startDate = getStartDate(period);

      // Build server filter
      const serverFilter = buildLibraryServerFilter(serverId, authUser);

      // Optional library filter
      const libraryFilter = libraryId ? sql`AND library_id = ${libraryId}` : sql``;

      // Date filter (only if not 'all')
      const dateFilter = startDate ? sql`AND day >= ${startDate.toISOString()}::date` : sql``;

      // Query library_stats_daily aggregate for time range
      const result = await db.execute(sql`
        SELECT
          day::text AS day,
          COALESCE(SUM(total_items), 0)::int AS total_items,
          COALESCE(SUM(total_size_bytes), 0)::bigint AS total_size_bytes
        FROM library_stats_daily
        WHERE true
          ${serverFilter}
          ${libraryFilter}
          ${dateFilter}
        GROUP BY day
        ORDER BY day ASC
      `);

      const rows = result.rows as Array<{
        day: string;
        total_items: number;
        total_size_bytes: string;
      }>;

      // Calculate additions/removals as delta from previous day
      const data: GrowthDataPoint[] = rows.map((row, index) => {
        const prevRow = index > 0 ? rows[index - 1] : null;
        const prevItems = prevRow?.total_items ?? row.total_items;
        const delta = row.total_items - prevItems;

        return {
          day: row.day,
          totalItems: row.total_items,
          totalSizeBytes: row.total_size_bytes,
          additions: delta > 0 ? delta : 0,
          removals: delta < 0 ? Math.abs(delta) : 0,
        };
      });

      const response: LibraryGrowthResponse = {
        period,
        data,
      };

      // Cache for 5 minutes
      await app.redis.setex(fullCacheKey, CACHE_TTL.LIBRARY_GROWTH, JSON.stringify(response));

      return response;
    }
  );
};
