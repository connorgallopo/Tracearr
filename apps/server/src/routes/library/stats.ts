/**
 * Library Stats Route
 *
 * GET /stats - Current library statistics
 *
 * SINGLE-SERVER PATH (exactly one server in scope):
 *   Uses library_snapshots for consistency with growth charts. Snapshots already
 *   filter out invalid items (missing episodes with no file size), ensuring
 *   accurate counts that match the graph data.
 *
 * MULTI-SERVER PATH (more than one server in scope):
 *   COUNT(DISTINCT matchKey) deduplication across library_items so the same title
 *   on two servers counts once. Storage is always SUM (physical bytes are never deduped).
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryStatsQuerySchema,
  RESOLUTION_BUCKETS,
  type LibraryStatsQueryInput,
  type LibraryStatsResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { latestSnapshotPerLibrary, type LatestSnapshotRow } from '../../db/librarySnapshots.js';
import { readResolutionCounts, versionBucketFlagsJoin } from '../../utils/resolutionBuckets.js';
import { libraryCacheSegment, libraryFragment } from '../../lib/scope.js';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey, dedupedStorageBytesSql } from './utils.js';

export const libraryStatsRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /stats - Current library statistics
   *
   * Returns aggregated library statistics. Single-server requests use
   * library_snapshots for consistency with growth charts; multi-server requests
   * use library_items with COUNT(DISTINCT matchKey) deduplication.
   */
  app.get<{ Querystring: LibraryStatsQueryInput }>(
    '/stats',
    { preHandler: [app.requirePermission('media', 'read')] },
    async (request, reply) => {
      const query = libraryStatsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds, libraryId, timezone } = query.data;
      const authUser = request.user;
      const tz = timezone ?? 'UTC';

      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

      // Use snapshot path when scoped to exactly one server — values match growth charts
      const singleServer = resolvedIds?.length === 1;

      // Build cache key - include sorted server IDs so order doesn't cause misses
      const serverCacheKey =
        (resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all') +
        libraryCacheSegment(request.scope);
      const cacheKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_STATS, serverCacheKey, tz);
      const fullCacheKey = libraryId ? `${cacheKey}:${libraryId}` : cacheKey;

      const cached = await app.redis.get(fullCacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryStatsResponse;
        } catch {
          // Fall through to compute
        }
      }

      let stats: LibraryStatsResponse;

      // Mirror-deduped bytes (#478): the same physical file in several
      // libraries or servers counts once. Used by both paths below in place
      // of snapshot/flat sums, which per-library-sum mirrored files.
      const dedupedServerFilter = libraryFragment(resolvedIds, request.scope, 'li');
      const dedupedLibraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      const dedupedResult = await db.execute(sql`
        SELECT ${dedupedStorageBytesSql(dedupedServerFilter, dedupedLibraryFilter)}::bigint AS total
      `);
      const dedupedBytes = String(
        (dedupedResult.rows[0] as { total: string } | undefined)?.total ?? '0'
      );

      if (singleServer) {
        // Single-server: query library_snapshots verbatim (matches main branch + growth charts)
        const serverFilter = libraryFragment(resolvedIds, request.scope, 'ls');
        const libraryFilter = libraryId ? sql`AND ls.library_id = ${libraryId}` : sql``;

        const latest = await latestSnapshotPerLibrary({
          serverFragment: serverFilter,
          libraryFilter,
        });
        const sum = (pick: (row: LatestSnapshotRow) => number) =>
          latest.reduce((total, row) => total + pick(row), 0);

        stats = {
          totalItems: sum((r) => r.item_count),
          totalSizeBytes: dedupedBytes,
          movieCount: sum((r) => r.movie_count),
          episodeCount: sum((r) => r.episode_count),
          showCount: sum((r) => r.show_count),
          qualityBreakdown: readResolutionCounts(
            Object.fromEntries(
              RESOLUTION_BUCKETS.map((bucket) => [
                `count_${bucket}`,
                sum((r) => r[`count_${bucket}`]),
              ])
            )
          ),
          asOf: latest.reduce<string | null>(
            (max, r) =>
              max === null || Date.parse(r.snapshot_time) > Date.parse(max) ? r.snapshot_time : max,
            null
          ),
        };
      } else {
        // Multi-server: deduplicate inventory via COUNT(DISTINCT matchKey)
        const serverFilter = libraryFragment(resolvedIds, request.scope, 'li');
        const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;

        const matchKey = sql`COALESCE(li.media_id::text, li.id::text)`;

        const result = await db.execute(sql`
          SELECT
            COUNT(DISTINCT CASE WHEN li.file_size > 0 OR li.media_type IN ('show', 'season') THEN ${matchKey} END)::int AS total_items,
            0::bigint AS total_size_bytes,
            COUNT(DISTINCT CASE WHEN li.media_type = 'movie' THEN ${matchKey} END)::int AS movie_count,
            COUNT(DISTINCT CASE WHEN li.media_type = 'episode' THEN ${matchKey} END)::int AS episode_count,
            COUNT(DISTINCT CASE WHEN li.media_type = 'show' THEN ${matchKey} END)::int AS show_count,
            ${sql.join(
              RESOLUTION_BUCKETS.map(
                (bucket) =>
                  sql`COUNT(CASE WHEN (li.file_size > 0 OR li.media_type IN ('show', 'season')) AND ${sql.raw(`vb.has_${bucket}`)} THEN 1 END)::int AS ${sql.raw(`count_${bucket}`)}`
              ),
              sql`, `
            )},
            MAX(li.updated_at)::text AS as_of
          FROM library_items li
          ${versionBucketFlagsJoin('li.id')}
          WHERE 1=1
            AND li.removed_at IS NULL
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
              as_of: string | null;
            }
          | undefined;

        stats = {
          totalItems: row?.total_items ?? 0,
          totalSizeBytes: dedupedBytes,
          movieCount: row?.movie_count ?? 0,
          episodeCount: row?.episode_count ?? 0,
          showCount: row?.show_count ?? 0,
          qualityBreakdown: readResolutionCounts(row),
          asOf: row?.as_of ?? null,
        };
      }

      await app.redis.setex(fullCacheKey, CACHE_TTL.LIBRARY_STATS, JSON.stringify(stats));

      return stats;
    }
  );
};
