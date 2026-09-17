/**
 * Library Quality Evolution Route
 *
 * GET /quality - Quality distribution over time from library_stats_daily
 *
 * Supports filtering by media type:
 * - 'all': All video content (movies + TV)
 * - 'movies': Only movies
 * - 'shows': Only episodes
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  TIME_MS,
  libraryQualityQuerySchema,
  type LibraryQualityQueryInput,
  type QualityDataPoint,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { perResolutionBucket, readResolutionCounts } from '../../utils/resolutionBuckets.js';
import {
  validateServerAccess,
  resolveServerIds,
  buildMultiServerFragment,
} from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

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

      const resolvedIds = resolveServerIds(authUser, serverId, undefined, { strict: false });
      const serverCacheSegment =
        resolvedIds !== undefined ? resolvedIds.slice().sort().join(',') : 'all';

      // Build cache key with all varying params including mediaType
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_QUALITY,
        serverCacheSegment,
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
      const endDate = new Date();

      // Build server filter for library_stats_daily
      const serverFilter = buildMultiServerFragment(resolvedIds, 'lsd.server_id');

      // Media type filter - filter by library type (movie-only vs TV vs all video)
      // Libraries are typically homogeneous in Plex, so we filter based on content counts
      let mediaTypeFilter: ReturnType<typeof sql>;
      switch (mediaType) {
        case 'movies':
          // Movie-only libraries: have movies but no episodes
          mediaTypeFilter = sql`AND lsd.movie_count > 0 AND lsd.episode_count = 0`;
          break;
        case 'shows':
          // TV libraries: have episodes
          mediaTypeFilter = sql`AND lsd.episode_count > 0`;
          break;
        case 'all':
        default:
          // All video libraries: have either movies or episodes
          mediaTypeFilter = sql`AND (lsd.movie_count > 0 OR lsd.episode_count > 0)`;
          break;
      }

      // For 'all' period, find the earliest snapshot date from library_stats_daily
      let effectiveStartDate: Date;
      if (startDate) {
        effectiveStartDate = startDate;
      } else {
        const earliestResult = await db.execute(sql`
          SELECT MIN(day)::date AS earliest
          FROM library_stats_daily lsd
          WHERE 1=1
            ${serverFilter}
        `);
        const earliest = (earliestResult.rows[0] as { earliest: string | null })?.earliest;
        effectiveStartDate = earliest ? new Date(earliest) : new Date('2020-01-01');
      }

      // Query library_stats_daily continuous aggregate
      // This uses pre-computed daily snapshots that already contain cumulative totals
      // After backfill, every day should have a snapshot, so gaps are unlikely
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
        filtered_libraries AS (
          -- Pre-filter libraries by media type before aggregating
          SELECT
            lsd.day,
            lsd.total_items,
            ${perResolutionBucket((bucket) => `lsd.count_${bucket}`)}
          FROM library_stats_daily lsd
          WHERE lsd.day >= ${effectiveStartDate.toISOString()}::date
            AND lsd.day <= ${endDate.toISOString()}::date
            ${serverFilter}
            ${mediaTypeFilter}
        ),
        daily_stats AS (
          -- Aggregate quality counts across all matching libraries per day
          SELECT
            fl.day::date AS day,
            COALESCE(SUM(fl.total_items), 0)::int AS total_items,
            ${perResolutionBucket((bucket) => `COALESCE(SUM(fl.count_${bucket}), 0)::int AS count_${bucket}`)}
          FROM filtered_libraries fl
          GROUP BY fl.day::date
        ),
        filled_data AS (
          -- Join date series with actual stats
          -- Use subquery to carry forward last known value for gaps
          SELECT
            ds.day,
            COALESCE(dst.total_items, (
              SELECT total_items FROM daily_stats dst2
              WHERE dst2.day < ds.day ORDER BY dst2.day DESC LIMIT 1
            ), 0)::int AS total_items,
            ${perResolutionBucket(
              (bucket) => `COALESCE(dst.count_${bucket}, (
              SELECT count_${bucket} FROM daily_stats dst2
              WHERE dst2.day < ds.day ORDER BY dst2.day DESC LIMIT 1
            ), 0)::int AS count_${bucket}`
            )}
          FROM date_series ds
          LEFT JOIN daily_stats dst ON dst.day = ds.day
        )
        SELECT
          fd.day::text,
          fd.total_items,
          ${perResolutionBucket((bucket) => `fd.count_${bucket}`)}
        FROM filled_data fd
        ORDER BY fd.day ASC
      `);

      // Buckets are overlapping (a 4K+1080p title counts in both), so a day's
      // title count is total_items, never the bucket sum
      const data: QualityDataPoint[] = (result.rows as Array<Record<string, unknown>>).map(
        (row) => ({
          day: String(row.day),
          totalItems: Number(row.total_items),
          counts: readResolutionCounts(row),
          // Codec counts not available per-library (set to 0)
          // Codec distribution is shown separately in CodecDistributionSection
          hevcCount: 0,
          h264Count: 0,
          av1Count: 0,
        })
      );

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
