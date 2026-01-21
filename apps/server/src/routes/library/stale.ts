/**
 * Library Stale Content Route
 *
 * GET /stale - Identify unwatched or rarely-watched content
 *
 * Categories:
 * - never_watched: Content added but never played (no sessions)
 * - stale: Content watched but not revisited in N days
 *
 * Uses LEFT JOIN with sessions table to determine watch history,
 * with configurable staleness threshold (default 90 days).
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryStaleQuerySchema,
  type LibraryStaleQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

/** Category for stale content */
type StaleCategory = 'never_watched' | 'stale';

/** Individual stale content item */
interface StaleItem {
  id: string;
  serverId: string;
  serverName: string;
  libraryId: string;
  libraryName: string;
  title: string;
  mediaType: string;
  year: number | null;
  fileSize: number | null;
  resolution: string | null;
  addedAt: string;
  lastWatched: string | null;
  watchCount: number;
  category: StaleCategory;
  daysStale: number;
}

/** Summary statistics for stale content */
interface StaleSummary {
  neverWatched: { count: number; sizeBytes: number };
  stale: { count: number; sizeBytes: number };
  total: { count: number; sizeBytes: number };
  threshold: { days: number };
}

/** Full response for stale content endpoint */
interface StaleResponse {
  items: StaleItem[];
  summary: StaleSummary;
  pagination: { page: number; pageSize: number; total: number };
}

/** Raw row from database for items */
interface RawStaleItemRow {
  id: string;
  server_id: string;
  server_name: string;
  library_id: string;
  library_name: string;
  title: string;
  media_type: string;
  year: number | null;
  file_size: string | null;
  video_resolution: string | null;
  added_at: string;
  last_watched: string | null;
  watch_count: string;
  category: StaleCategory;
  days_stale: string;
}

/** Raw row from database for summary */
interface RawSummaryRow {
  never_watched_count: string;
  stale_count: string;
  never_watched_bytes: string;
  stale_bytes: string;
  total_stale_items: string;
  total_stale_bytes: string;
}

export const libraryStaleRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /stale - Identify unwatched/stale content
   *
   * Returns library content that has never been watched or hasn't been
   * watched in the specified number of days (staleDays threshold).
   */
  app.get<{ Querystring: LibraryStaleQueryInput }>(
    '/stale',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryStaleQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        libraryId,
        mediaType,
        staleDays,
        category,
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
        REDIS_KEYS.LIBRARY_STALE,
        serverId,
        `${libraryId ?? 'all'}-${mediaType ?? 'all'}-${staleDays}-${category}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as StaleResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build filters
      const serverFilter = buildLibraryServerFilter(serverId, authUser, 'li');
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      const mediaTypeFilter = mediaType ? sql`AND li.media_type = ${mediaType}` : sql``;

      // Category filter for final results
      const categoryFilter =
        category === 'never_watched'
          ? sql`AND category = 'never_watched'`
          : category === 'stale'
            ? sql`AND category = 'stale'`
            : sql``;

      // Sort column mapping - use sql.raw() for identifiers
      const sortColumnMap: Record<string, string> = {
        size: 'file_size',
        days_stale: 'days_stale',
        title: 'title',
      };
      const sortColumnName = sortColumnMap[sortBy] || 'file_size';
      const sortDirStr = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';
      const orderByClause = sql.raw(`${sortColumnName} ${sortDirStr}`);

      const offset = (page - 1) * pageSize;

      // Combined query: items with pagination AND summary statistics in one round-trip
      // Uses window functions for summary aggregation alongside item results
      const combinedResult = await db.execute(sql`
        WITH child_stats AS (
          -- Aggregate child data for shows (episodes) and artists (tracks)
          SELECT
            grandparent_rating_key,
            server_id,
            SUM(file_size) AS total_size,
            MAX(video_resolution) AS best_resolution
          FROM library_items
          WHERE media_type IN ('episode', 'track') AND grandparent_rating_key IS NOT NULL
          GROUP BY grandparent_rating_key, server_id
        ),
        child_watch_stats AS (
          -- Get watch stats for shows/artists via their children
          SELECT
            child.grandparent_rating_key,
            child.server_id,
            MAX(sess.stopped_at) AS last_watched,
            COUNT(sess.id)::int AS watch_count
          FROM library_items child
          LEFT JOIN sessions sess ON sess.rating_key = child.rating_key
            AND sess.server_id = child.server_id
            AND sess.duration_ms >= 120000
          WHERE child.media_type IN ('episode', 'track') AND child.grandparent_rating_key IS NOT NULL
          GROUP BY child.grandparent_rating_key, child.server_id
        ),
        item_watch_stats AS (
          SELECT
            li.id,
            li.server_id,
            s.name AS server_name,
            li.library_id,
            s.name AS library_name,
            li.title,
            li.media_type,
            li.year,
            -- For shows/artists: use aggregated child size, otherwise use item's file_size
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cs.total_size, li.file_size)
              ELSE li.file_size
            END AS file_size,
            -- For shows/artists: use best child resolution
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cs.best_resolution, li.video_resolution)
              ELSE li.video_resolution
            END AS video_resolution,
            li.created_at AS added_at,
            -- For shows/artists: use child watch stats
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN cws.last_watched
              ELSE MAX(sess.stopped_at)
            END AS last_watched,
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cws.watch_count, 0)
              ELSE COUNT(sess.id)::int
            END AS watch_count
          FROM library_items li
          JOIN servers s ON li.server_id = s.id
          LEFT JOIN child_stats cs ON li.media_type IN ('show', 'artist')
            AND cs.grandparent_rating_key = li.rating_key
            AND cs.server_id = li.server_id
          LEFT JOIN child_watch_stats cws ON li.media_type IN ('show', 'artist')
            AND cws.grandparent_rating_key = li.rating_key
            AND cws.server_id = li.server_id
          LEFT JOIN sessions sess ON li.media_type NOT IN ('show', 'artist')
            AND sess.rating_key = li.rating_key
            AND sess.server_id = li.server_id
            AND sess.duration_ms >= 120000
          WHERE li.media_type NOT IN ('episode', 'track')  -- Exclude children, only show parent items
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
          GROUP BY li.id, li.server_id, s.name, li.library_id, li.title,
                   li.media_type, li.year, li.file_size, li.video_resolution, li.created_at,
                   cs.total_size, cs.best_resolution, cws.last_watched, cws.watch_count
        ),
        stale_items AS (
          SELECT
            id,
            server_id,
            server_name,
            library_id,
            library_name,
            title,
            media_type,
            year,
            file_size,
            video_resolution,
            added_at,
            last_watched,
            watch_count,
            CASE
              WHEN last_watched IS NULL THEN 'never_watched'
              ELSE 'stale'
            END AS category,
            CASE
              WHEN last_watched IS NULL THEN
                EXTRACT(DAY FROM NOW() - added_at)::int
              ELSE
                EXTRACT(DAY FROM NOW() - last_watched)::int
            END AS days_stale
          FROM item_watch_stats
          WHERE (
            last_watched IS NULL
            OR last_watched < NOW() - INTERVAL '1 day' * ${staleDays}
          )
        ),
        filtered_items AS (
          SELECT * FROM stale_items
          WHERE 1=1
            ${categoryFilter}
        ),
        -- Summary aggregation computed once over all filtered items
        summary_stats AS (
          SELECT
            COUNT(*) FILTER (WHERE category = 'never_watched') AS never_watched_count,
            COUNT(*) FILTER (WHERE category = 'stale') AS stale_count,
            COALESCE(SUM(file_size) FILTER (WHERE category = 'never_watched'), 0) AS never_watched_bytes,
            COALESCE(SUM(file_size) FILTER (WHERE category = 'stale'), 0) AS stale_bytes,
            COUNT(*) AS total_stale_items,
            COALESCE(SUM(file_size), 0) AS total_stale_bytes
          FROM filtered_items
        ),
        paginated_items AS (
          SELECT * FROM filtered_items
          ORDER BY ${orderByClause}
          LIMIT ${pageSize} OFFSET ${offset}
        )
        SELECT
          -- Item fields
          pi.id,
          pi.server_id,
          pi.server_name,
          pi.library_id,
          pi.library_name,
          pi.title,
          pi.media_type,
          pi.year,
          pi.file_size::text AS file_size,
          pi.video_resolution,
          pi.added_at::text AS added_at,
          pi.last_watched::text AS last_watched,
          pi.watch_count::text AS watch_count,
          pi.category,
          pi.days_stale::text AS days_stale,
          -- Summary fields (same for all rows)
          ss.never_watched_count::text AS _never_watched_count,
          ss.stale_count::text AS _stale_count,
          ss.never_watched_bytes::text AS _never_watched_bytes,
          ss.stale_bytes::text AS _stale_bytes,
          ss.total_stale_items::text AS _total_stale_items,
          ss.total_stale_bytes::text AS _total_stale_bytes
        FROM paginated_items pi
        CROSS JOIN summary_stats ss
      `);

      // Extract items and summary from combined result
      interface CombinedRow extends RawStaleItemRow {
        _never_watched_count: string;
        _stale_count: string;
        _never_watched_bytes: string;
        _stale_bytes: string;
        _total_stale_items: string;
        _total_stale_bytes: string;
      }

      const rows = combinedResult.rows as unknown as CombinedRow[];

      const items: StaleItem[] = rows.map((row) => ({
        id: row.id,
        serverId: row.server_id,
        serverName: row.server_name,
        libraryId: row.library_id,
        libraryName: row.library_name,
        title: row.title,
        mediaType: row.media_type,
        year: row.year,
        fileSize: row.file_size ? parseInt(row.file_size, 10) : null,
        resolution: row.video_resolution,
        addedAt: row.added_at,
        lastWatched: row.last_watched,
        watchCount: parseInt(row.watch_count, 10),
        category: row.category,
        daysStale: parseInt(row.days_stale, 10),
      }));

      // Extract summary from first row (or fetch separately if no items)
      let summary: StaleSummary;
      if (rows.length > 0) {
        const firstRow = rows[0]!;
        summary = {
          neverWatched: {
            count: parseInt(firstRow._never_watched_count, 10) || 0,
            sizeBytes: parseInt(firstRow._never_watched_bytes, 10) || 0,
          },
          stale: {
            count: parseInt(firstRow._stale_count, 10) || 0,
            sizeBytes: parseInt(firstRow._stale_bytes, 10) || 0,
          },
          total: {
            count: parseInt(firstRow._total_stale_items, 10) || 0,
            sizeBytes: parseInt(firstRow._total_stale_bytes, 10) || 0,
          },
          threshold: { days: staleDays },
        };
      } else {
        // No items on current page - need summary separately for empty page case
        const summaryResult = await db.execute(sql`
          WITH child_stats AS (
            SELECT grandparent_rating_key, server_id, SUM(file_size) AS total_size
            FROM library_items
            WHERE media_type IN ('episode', 'track') AND grandparent_rating_key IS NOT NULL
            GROUP BY grandparent_rating_key, server_id
          ),
          child_watch_stats AS (
            SELECT child.grandparent_rating_key, child.server_id, MAX(sess.stopped_at) AS last_watched
            FROM library_items child
            LEFT JOIN sessions sess ON sess.rating_key = child.rating_key
              AND sess.server_id = child.server_id AND sess.duration_ms >= 120000
            WHERE child.media_type IN ('episode', 'track') AND child.grandparent_rating_key IS NOT NULL
            GROUP BY child.grandparent_rating_key, child.server_id
          ),
          item_watch_stats AS (
            SELECT li.id, li.server_id,
              CASE WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cs.total_size, li.file_size) ELSE li.file_size END AS file_size,
              CASE WHEN li.media_type IN ('show', 'artist') THEN cws.last_watched ELSE MAX(sess.stopped_at) END AS last_watched
            FROM library_items li
            LEFT JOIN child_stats cs ON li.media_type IN ('show', 'artist') AND cs.grandparent_rating_key = li.rating_key AND cs.server_id = li.server_id
            LEFT JOIN child_watch_stats cws ON li.media_type IN ('show', 'artist') AND cws.grandparent_rating_key = li.rating_key AND cws.server_id = li.server_id
            LEFT JOIN sessions sess ON li.media_type NOT IN ('show', 'artist') AND sess.rating_key = li.rating_key AND sess.server_id = li.server_id AND sess.duration_ms >= 120000
            WHERE li.media_type NOT IN ('episode', 'track') ${serverFilter} ${libraryFilter} ${mediaTypeFilter}
            GROUP BY li.id, li.server_id, li.media_type, li.file_size, cs.total_size, cws.last_watched
          ),
          stale_items AS (
            SELECT id, file_size, CASE WHEN last_watched IS NULL THEN 'never_watched' ELSE 'stale' END AS category
            FROM item_watch_stats WHERE (last_watched IS NULL OR last_watched < NOW() - INTERVAL '1 day' * ${staleDays})
          ),
          filtered AS (SELECT * FROM stale_items WHERE 1=1 ${categoryFilter})
          SELECT COUNT(*) FILTER (WHERE category = 'never_watched') AS never_watched_count,
            COUNT(*) FILTER (WHERE category = 'stale') AS stale_count,
            COALESCE(SUM(file_size) FILTER (WHERE category = 'never_watched'), 0)::text AS never_watched_bytes,
            COALESCE(SUM(file_size) FILTER (WHERE category = 'stale'), 0)::text AS stale_bytes,
            COUNT(*) AS total_stale_items, COALESCE(SUM(file_size), 0)::text AS total_stale_bytes
          FROM filtered
        `);
        const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;
        summary = {
          neverWatched: {
            count: parseInt(summaryRow.never_watched_count, 10) || 0,
            sizeBytes: parseInt(summaryRow.never_watched_bytes, 10) || 0,
          },
          stale: {
            count: parseInt(summaryRow.stale_count, 10) || 0,
            sizeBytes: parseInt(summaryRow.stale_bytes, 10) || 0,
          },
          total: {
            count: parseInt(summaryRow.total_stale_items, 10) || 0,
            sizeBytes: parseInt(summaryRow.total_stale_bytes, 10) || 0,
          },
          threshold: { days: staleDays },
        };
      }

      // Get total count for pagination from summary
      const total = summary.total.count;

      const response: StaleResponse = {
        items,
        summary,
        pagination: { page, pageSize, total },
      };

      // Cache for 1 hour (stale content changes slowly)
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_STALE, JSON.stringify(response));

      return response;
    }
  );
};
