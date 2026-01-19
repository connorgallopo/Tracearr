/**
 * Library Stats Route
 *
 * GET /stats - Current library statistics from library_stats_daily aggregate
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryStatsQuerySchema,
  type LibraryStatsQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

/** Library stats response shape */
interface LibraryStatsResponse {
  totalItems: number;
  totalSizeBytes: string;
  movieCount: number;
  episodeCount: number;
  showCount: number;
  qualityBreakdown: {
    count4k: number;
    count1080p: number;
    count720p: number;
    countSd: number;
  };
  asOf: string | null;
}

export const libraryStatsRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /stats - Current library statistics
   *
   * Returns aggregated library statistics from the latest day's data.
   * Supports filtering by serverId and libraryId.
   */
  app.get<{ Querystring: LibraryStatsQueryInput }>(
    '/stats',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryStatsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, libraryId, timezone } = query.data;
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
      const cacheKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_STATS, serverId, libraryId, tz);

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryStatsResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build server filter
      const serverFilter = buildLibraryServerFilter(serverId, authUser);

      // Optional library filter
      const libraryFilter = libraryId ? sql`AND library_id = ${libraryId}` : sql``;

      // Query library_stats_daily aggregate for latest day's data
      const result = await db.execute(sql`
        SELECT
          COALESCE(SUM(total_items), 0)::int AS total_items,
          COALESCE(SUM(total_size_bytes), 0)::bigint AS total_size_bytes,
          COALESCE(SUM(movie_count), 0)::int AS movie_count,
          COALESCE(SUM(episode_count), 0)::int AS episode_count,
          COALESCE(SUM(show_count), 0)::int AS show_count,
          COALESCE(SUM(count_4k), 0)::int AS count_4k,
          COALESCE(SUM(count_1080p), 0)::int AS count_1080p,
          COALESCE(SUM(count_720p), 0)::int AS count_720p,
          COALESCE(SUM(count_sd), 0)::int AS count_sd,
          MAX(day) AS as_of
        FROM library_stats_daily
        WHERE day = (SELECT MAX(day) FROM library_stats_daily WHERE true ${serverFilter} ${libraryFilter})
          ${serverFilter}
          ${libraryFilter}
      `);

      const row = result.rows[0] as
        | {
            total_items: number;
            total_size_bytes: string;
            movie_count: number;
            episode_count: number;
            show_count: number;
            count_4k: number;
            count_1080p: number;
            count_720p: number;
            count_sd: number;
            as_of: string | null;
          }
        | undefined;

      const stats: LibraryStatsResponse = {
        totalItems: row?.total_items ?? 0,
        totalSizeBytes: row?.total_size_bytes ?? '0',
        movieCount: row?.movie_count ?? 0,
        episodeCount: row?.episode_count ?? 0,
        showCount: row?.show_count ?? 0,
        qualityBreakdown: {
          count4k: row?.count_4k ?? 0,
          count1080p: row?.count_1080p ?? 0,
          count720p: row?.count_720p ?? 0,
          countSd: row?.count_sd ?? 0,
        },
        asOf: row?.as_of ?? null,
      };

      // Cache for 5 minutes
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_STATS, JSON.stringify(stats));

      return stats;
    }
  );
};
