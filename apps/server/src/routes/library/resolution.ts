/**
 * Library Resolution Route
 *
 * GET /resolution - Resolution distribution for library items by media type
 *
 * Returns resolution breakdowns (4K, 1080p, 720p, SD) split by:
 * - Movies
 * - TV Shows (episodes)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { REDIS_KEYS, CACHE_TTL, uuidSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

/** Query schema for resolution endpoint */
const resolutionQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  libraryId: uuidSchema.optional(),
});

type ResolutionQueryInput = z.infer<typeof resolutionQuerySchema>;

/** Single resolution entry with count and percentage */
interface ResolutionEntry {
  resolution: string;
  count: number;
  percentage: number;
}

/** Resolution breakdown for a media type */
interface ResolutionBreakdown {
  count4k: number;
  count1080p: number;
  count720p: number;
  countSd: number;
  total: number;
  entries: ResolutionEntry[];
}

/** Response structure for resolution endpoint */
interface LibraryResolutionResponse {
  movies: ResolutionBreakdown;
  tv: ResolutionBreakdown;
}

/**
 * Convert raw counts to ResolutionBreakdown with percentages
 */
function buildBreakdown(
  count4k: number,
  count1080p: number,
  count720p: number,
  countSd: number
): ResolutionBreakdown {
  const total = count4k + count1080p + count720p + countSd;
  const pct = (count: number) => (total > 0 ? Math.round((count / total) * 1000) / 10 : 0);

  const entries: ResolutionEntry[] = [];

  if (count4k > 0) {
    entries.push({ resolution: '4K', count: count4k, percentage: pct(count4k) });
  }
  if (count1080p > 0) {
    entries.push({ resolution: '1080p', count: count1080p, percentage: pct(count1080p) });
  }
  if (count720p > 0) {
    entries.push({ resolution: '720p', count: count720p, percentage: pct(count720p) });
  }
  if (countSd > 0) {
    entries.push({ resolution: 'SD', count: countSd, percentage: pct(countSd) });
  }

  return {
    count4k,
    count1080p,
    count720p,
    countSd,
    total,
    entries,
  };
}

export const libraryResolutionRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /resolution - Resolution distribution by media type
   *
   * Returns resolution breakdowns for movies and TV shows.
   */
  app.get<{ Querystring: ResolutionQueryInput }>(
    '/resolution',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = resolutionQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, libraryId } = query.data;
      const authUser = request.user;

      // Validate server access
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      // Build cache key
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_RESOLUTION ?? 'library:resolution',
        serverId,
        libraryId ?? 'all'
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryResolutionResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build server filter
      const serverFilter = buildLibraryServerFilter(serverId, authUser);

      // Library filter
      const libraryFilter = libraryId ? sql`AND library_id = ${libraryId}` : sql``;

      // Query resolution counts for movies
      const moviesResult = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE video_resolution = '4k')::int AS count_4k,
          COUNT(*) FILTER (WHERE video_resolution = '1080p')::int AS count_1080p,
          COUNT(*) FILTER (WHERE video_resolution = '720p')::int AS count_720p,
          COUNT(*) FILTER (WHERE video_resolution = 'sd' OR video_resolution IS NULL)::int AS count_sd
        FROM library_items
        WHERE media_type = 'movie'
          ${serverFilter}
          ${libraryFilter}
      `);

      // Query resolution counts for TV episodes
      const tvResult = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE video_resolution = '4k')::int AS count_4k,
          COUNT(*) FILTER (WHERE video_resolution = '1080p')::int AS count_1080p,
          COUNT(*) FILTER (WHERE video_resolution = '720p')::int AS count_720p,
          COUNT(*) FILTER (WHERE video_resolution = 'sd' OR video_resolution IS NULL)::int AS count_sd
        FROM library_items
        WHERE media_type = 'episode'
          ${serverFilter}
          ${libraryFilter}
      `);

      const moviesRow = moviesResult.rows[0] as
        | {
            count_4k: number;
            count_1080p: number;
            count_720p: number;
            count_sd: number;
          }
        | undefined;

      const tvRow = tvResult.rows[0] as
        | {
            count_4k: number;
            count_1080p: number;
            count_720p: number;
            count_sd: number;
          }
        | undefined;

      const response: LibraryResolutionResponse = {
        movies: buildBreakdown(
          moviesRow?.count_4k ?? 0,
          moviesRow?.count_1080p ?? 0,
          moviesRow?.count_720p ?? 0,
          moviesRow?.count_sd ?? 0
        ),
        tv: buildBreakdown(
          tvRow?.count_4k ?? 0,
          tvRow?.count_1080p ?? 0,
          tvRow?.count_720p ?? 0,
          tvRow?.count_sd ?? 0
        ),
      };

      // Cache for 5 minutes
      await app.redis.setex(
        cacheKey,
        CACHE_TTL.LIBRARY_RESOLUTION ?? 300,
        JSON.stringify(response)
      );

      return response;
    }
  );
};
