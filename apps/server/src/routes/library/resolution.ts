/**
 * Library Resolution Route
 *
 * GET /resolution - Resolution distribution for library items by media type
 *
 * Returns per-tier counts split by:
 * - Movies
 * - TV Shows (episodes)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  REDIS_KEYS,
  CACHE_TTL,
  RESOLUTION_BUCKETS,
  uuidSchema,
  type LibraryResolutionResponse,
  type ResolutionBreakdown,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { readResolutionCounts, versionBucketFlagsJoin } from '../../utils/resolutionBuckets.js';
import {
  validateServerAccess,
  resolveServerIds,
  buildMultiServerFragment,
} from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Query schema for resolution endpoint */
const resolutionQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  libraryId: uuidSchema.optional(),
});

type ResolutionQueryInput = z.infer<typeof resolutionQuerySchema>;

/** Items with no resolution at all count as SD here, unlike the snapshot writers. */
function bucketCountsSelect(): SQL {
  return sql.join(
    RESOLUTION_BUCKETS.map((bucket) =>
      bucket === 'sd'
        ? sql`COUNT(*) FILTER (WHERE vb.has_sd OR library_items.video_resolution IS NULL)::int AS count_sd`
        : sql`COUNT(*) FILTER (WHERE ${sql.raw(`vb.has_${bucket}`)})::int AS ${sql.raw(`count_${bucket}`)}`
    ),
    sql`, `
  );
}

function buildBreakdown(row: Record<string, unknown> | undefined): ResolutionBreakdown {
  const counts = readResolutionCounts(row);
  const total = RESOLUTION_BUCKETS.reduce((sum, bucket) => sum + counts[bucket], 0);
  return { counts, total };
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

      const resolvedIds = resolveServerIds(authUser, serverId, undefined, { strict: false });
      const serverCacheSegment =
        resolvedIds !== undefined ? resolvedIds.slice().sort().join(',') : 'all';

      // Build cache key
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_RESOLUTION ?? 'library:resolution',
        serverCacheSegment,
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
      const serverFilter = buildMultiServerFragment(resolvedIds);

      // Library filter
      const libraryFilter = libraryId ? sql`AND library_id = ${libraryId}` : sql``;

      const countsFor = (mediaType: 'movie' | 'episode') =>
        db.execute(sql`
          SELECT ${bucketCountsSelect()}
          FROM library_items
          ${versionBucketFlagsJoin('library_items.id', { includeNullAsSd: true })}
          WHERE media_type = ${mediaType}
            AND removed_at IS NULL
            ${serverFilter}
            ${libraryFilter}
        `);

      const moviesResult = await countsFor('movie');
      const tvResult = await countsFor('episode');

      const response: LibraryResolutionResponse = {
        movies: buildBreakdown(moviesResult.rows[0]),
        tv: buildBreakdown(tvResult.rows[0]),
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
