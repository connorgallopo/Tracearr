/**
 * Library Watch Statistics Route
 *
 * GET /watch - Per-item watch counts and watched/unwatched ratios
 *
 * Joins library_items with sessions table to provide:
 * - Watch count per item
 * - Total watch time per item
 * - Last watched timestamp
 * - Summary with watched/unwatched ratio
 *
 * Uses LEFT JOIN to ensure items without sessions return 0 watch count.
 * 2-minute (120000ms) session threshold for valid "intent to watch".
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryWatchQuerySchema,
  type LibraryWatchQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

/** Individual library item with watch statistics */
interface WatchItem {
  id: string;
  serverId: string;
  serverName: string;
  libraryId: string;
  title: string;
  mediaType: string;
  year: number | null;
  fileSize: number | null;
  resolution: string | null;
  addedAt: string;
  watchCount: number;
  totalWatchMs: number;
  lastWatchedAt: string | null;
}

/** Summary statistics for watch data */
interface WatchSummary {
  totalItems: number;
  watchedCount: number;
  unwatchedCount: number;
  watchedPct: number;
  totalWatchMs: number;
  avgWatchesPerItem: number;
}

/** Full response for watch statistics endpoint */
interface WatchResponse {
  items: WatchItem[];
  summary: WatchSummary;
  pagination: { page: number; pageSize: number; total: number };
}

/** Raw row from database for items */
interface RawWatchItemRow {
  id: string;
  server_id: string;
  server_name: string;
  library_id: string;
  title: string;
  media_type: string;
  year: number | null;
  file_size: string | null;
  video_resolution: string | null;
  added_at: string;
  watch_count: string;
  total_watch_ms: string;
  last_watched_at: string | null;
}

/** Raw row from database for summary */
interface RawSummaryRow {
  total_items: string;
  watched_count: string;
  unwatched_count: string;
  total_watch_ms: string;
  avg_watches_per_item: string | null;
}

export const libraryWatchRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /watch - Library watch statistics
   *
   * Returns per-item watch counts with summary ratios.
   * Supports filtering by server, library, media type, and watch count ranges.
   */
  app.get<{ Querystring: LibraryWatchQueryInput }>(
    '/watch',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryWatchQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        libraryId,
        mediaType,
        minWatchCount,
        maxWatchCount,
        includeUnwatched,
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
        REDIS_KEYS.LIBRARY_WATCH,
        serverId,
        `${libraryId ?? 'all'}-${mediaType ?? 'all'}-${minWatchCount ?? 'none'}-${maxWatchCount ?? 'none'}-${includeUnwatched}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as WatchResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build filters
      const serverFilter = buildLibraryServerFilter(serverId, authUser);
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      const mediaTypeFilter = mediaType ? sql`AND li.media_type = ${mediaType}` : sql``;

      // Watch count filters for final results
      const minWatchFilter =
        minWatchCount !== undefined ? sql`AND watch_count >= ${minWatchCount}` : sql``;
      const maxWatchFilter =
        maxWatchCount !== undefined ? sql`AND watch_count <= ${maxWatchCount}` : sql``;
      const unwatchedFilter = !includeUnwatched ? sql`AND watch_count > 0` : sql``;

      // Sort column mapping
      const sortColumnMap = {
        watch_count: sql`watch_count`,
        last_watched: sql`last_watched_at`,
        title: sql`title`,
        file_size: sql`file_size`,
      };
      const sortColumn = sortColumnMap[sortBy] || sql`watch_count`;
      const sortDir = sortOrder === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS FIRST`;

      const offset = (page - 1) * pageSize;

      // Main query to get items with watch stats
      // Uses CTE to join library_items with sessions
      const itemsResult = await db.execute(sql`
        WITH item_watch_stats AS (
          SELECT
            li.id,
            li.server_id,
            s.name AS server_name,
            li.library_id,
            li.title,
            li.media_type,
            li.year,
            li.file_size,
            li.video_resolution,
            li.created_at AS added_at,
            COUNT(sess.id) FILTER (WHERE sess.duration_ms >= 120000) AS watch_count,
            COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) AS total_watch_ms,
            MAX(sess.stopped_at) AS last_watched_at
          FROM library_items li
          JOIN servers s ON li.server_id = s.id
          LEFT JOIN sessions sess ON sess.rating_key = li.rating_key
            AND sess.server_id = li.server_id
          WHERE 1=1
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
          GROUP BY li.id, li.server_id, s.name, li.library_id, li.title,
                   li.media_type, li.year, li.file_size, li.video_resolution, li.created_at
        )
        SELECT
          id,
          server_id,
          server_name,
          library_id,
          title,
          media_type,
          year,
          file_size::text AS file_size,
          video_resolution,
          added_at::text AS added_at,
          watch_count::text AS watch_count,
          total_watch_ms::text AS total_watch_ms,
          last_watched_at::text AS last_watched_at
        FROM item_watch_stats
        WHERE 1=1
          ${minWatchFilter}
          ${maxWatchFilter}
          ${unwatchedFilter}
        ORDER BY ${sortColumn} ${sortDir}
        LIMIT ${pageSize} OFFSET ${offset}
      `);

      const items: WatchItem[] = (itemsResult.rows as unknown as RawWatchItemRow[]).map((row) => ({
        id: row.id,
        serverId: row.server_id,
        serverName: row.server_name,
        libraryId: row.library_id,
        title: row.title,
        mediaType: row.media_type,
        year: row.year,
        fileSize: row.file_size ? parseInt(row.file_size, 10) : null,
        resolution: row.video_resolution,
        addedAt: row.added_at,
        watchCount: parseInt(row.watch_count, 10),
        totalWatchMs: parseInt(row.total_watch_ms, 10),
        lastWatchedAt: row.last_watched_at,
      }));

      // Summary query for totals (applies same base filters but not pagination)
      const summaryResult = await db.execute(sql`
        WITH item_watch_stats AS (
          SELECT
            li.id,
            COUNT(sess.id) FILTER (WHERE sess.duration_ms >= 120000) AS watch_count,
            COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) AS total_watch_ms
          FROM library_items li
          LEFT JOIN sessions sess ON sess.rating_key = li.rating_key
            AND sess.server_id = li.server_id
          WHERE 1=1
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
          GROUP BY li.id
        ),
        filtered_stats AS (
          SELECT * FROM item_watch_stats
          WHERE 1=1
            ${minWatchFilter}
            ${maxWatchFilter}
            ${unwatchedFilter}
        )
        SELECT
          COUNT(*) AS total_items,
          COUNT(*) FILTER (WHERE watch_count > 0) AS watched_count,
          COUNT(*) FILTER (WHERE watch_count = 0) AS unwatched_count,
          COALESCE(SUM(total_watch_ms), 0)::text AS total_watch_ms,
          ROUND(AVG(watch_count)::numeric, 2)::text AS avg_watches_per_item
        FROM filtered_stats
      `);

      const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;

      const totalItems = parseInt(summaryRow.total_items, 10) || 0;
      const watchedCount = parseInt(summaryRow.watched_count, 10) || 0;
      const unwatchedCount = parseInt(summaryRow.unwatched_count, 10) || 0;

      const summary: WatchSummary = {
        totalItems,
        watchedCount,
        unwatchedCount,
        watchedPct: totalItems > 0 ? Math.round((watchedCount / totalItems) * 100 * 10) / 10 : 0,
        totalWatchMs: parseInt(summaryRow.total_watch_ms, 10) || 0,
        avgWatchesPerItem: parseFloat(summaryRow.avg_watches_per_item || '0'),
      };

      const response: WatchResponse = {
        items,
        summary,
        pagination: { page, pageSize, total: totalItems },
      };

      // Cache response
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_WATCH, JSON.stringify(response));

      return response;
    }
  );
};
