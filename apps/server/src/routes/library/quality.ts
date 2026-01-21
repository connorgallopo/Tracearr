/**
 * Library Quality Evolution Route
 *
 * GET /quality - Quality distribution over time from library_stats_daily aggregate
 *
 * Supports filtering by media type:
 * - 'all': All video content (movies + TV)
 * - 'movies': Only movie libraries
 * - 'shows': Only TV libraries
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  TIME_MS,
  libraryQualityQuerySchema,
  type LibraryQualityQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

/** Single data point in quality timeline */
interface QualityDataPoint {
  day: string;
  totalItems: number;
  // Absolute counts
  count4k: number;
  count1080p: number;
  count720p: number;
  countSd: number;
  // Percentages
  pct4k: number;
  pct1080p: number;
  pct720p: number;
  pctSd: number;
  // Codec counts
  hevcCount: number;
  h264Count: number;
  av1Count: number;
}

/** Library quality evolution response */
interface LibraryQualityResponse {
  period: string;
  mediaType: 'all' | 'movies' | 'shows';
  data: QualityDataPoint[];
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

export const libraryQualityRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /quality - Quality evolution timeline
   *
   * Returns daily quality distribution snapshots showing resolution breakdowns.
   * Uses library_stats_daily continuous aggregate with media type filtering.
   *
   * Media type filtering:
   * - 'all': All video libraries (movie_count > 0 OR episode_count > 0)
   * - 'movies': Only movie libraries (movie_count > 0 AND episode_count = 0)
   * - 'shows': Only TV libraries (episode_count > 0)
   */
  app.get<{ Querystring: LibraryQualityQueryInput }>(
    '/quality',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryQualityQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, period, mediaType, timezone } = query.data;
      const authUser = request.user;
      const tz = timezone ?? 'UTC';

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      // Build cache key with all varying params including mediaType
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_QUALITY,
        serverId,
        `${period}:${mediaType}`,
        tz
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryQualityResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Calculate date range
      const startDate = getStartDate(period);

      // Build server filter
      const serverFilter = buildLibraryServerFilter(serverId, authUser);

      // Date filter (only if not 'all')
      const dateFilter = startDate ? sql`AND day >= ${startDate.toISOString()}::date` : sql``;

      // Media type filter - determines which libraries to include
      // Libraries are classified by their content:
      // - Movie libraries: movie_count > 0 AND episode_count = 0
      // - TV libraries: episode_count > 0 (may have some movies as specials)
      // - Music libraries: excluded (no video quality metrics)
      let mediaTypeFilter: ReturnType<typeof sql>;
      switch (mediaType) {
        case 'movies':
          mediaTypeFilter = sql`AND movie_count > 0 AND episode_count = 0`;
          break;
        case 'shows':
          mediaTypeFilter = sql`AND episode_count > 0`;
          break;
        case 'all':
        default:
          // Exclude music-only libraries (no video quality data)
          mediaTypeFilter = sql`AND (movie_count > 0 OR episode_count > 0)`;
          break;
      }

      // Query library_stats_daily aggregate with media type filtering
      // This aggregate has per-library data, allowing us to filter by library type
      const result = await db.execute(sql`
        SELECT
          day::text AS day,
          COALESCE(SUM(count_4k), 0)::int AS count_4k,
          COALESCE(SUM(count_1080p), 0)::int AS count_1080p,
          COALESCE(SUM(count_720p), 0)::int AS count_720p,
          COALESCE(SUM(count_sd), 0)::int AS count_sd
        FROM library_stats_daily
        WHERE true
          ${serverFilter}
          ${dateFilter}
          ${mediaTypeFilter}
        GROUP BY day
        ORDER BY day ASC
      `);

      const rows = result.rows as Array<{
        day: string;
        count_4k: number;
        count_1080p: number;
        count_720p: number;
        count_sd: number;
      }>;

      // Calculate percentages in application code
      // totalItems = sum of all quality tiers (we filter out music libraries in the query)
      const data: QualityDataPoint[] = rows.map((row) => {
        const videoTotal = row.count_4k + row.count_1080p + row.count_720p + row.count_sd;
        const total = videoTotal || 1; // Avoid division by zero
        return {
          day: row.day,
          totalItems: videoTotal,
          // Absolute counts
          count4k: row.count_4k,
          count1080p: row.count_1080p,
          count720p: row.count_720p,
          countSd: row.count_sd,
          // Percentages (rounded to 2 decimal places)
          pct4k: Math.round((row.count_4k / total) * 10000) / 100,
          pct1080p: Math.round((row.count_1080p / total) * 10000) / 100,
          pct720p: Math.round((row.count_720p / total) * 10000) / 100,
          pctSd: Math.round((row.count_sd / total) * 10000) / 100,
          // Codec counts not available per-library (set to 0)
          // Codec distribution is shown separately in CodecDistributionSection
          hevcCount: 0,
          h264Count: 0,
          av1Count: 0,
        };
      });

      const response: LibraryQualityResponse = {
        period,
        mediaType,
        data,
      };

      // Cache for 5 minutes
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_QUALITY, JSON.stringify(response));

      return response;
    }
  );
};
