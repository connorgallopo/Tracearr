/**
 * Library ROI (Return on Investment) Route
 *
 * GET /roi - Calculate watch value per storage cost for content optimization
 *
 * Features:
 * - Watch hours per GB calculation for each item
 * - Value scoring (0-100) with content-type-specific thresholds
 * - Age decay factor for staleness consideration
 * - Deletion suggestions for low-value, unwatched content
 *
 * Uses LEFT JOIN with sessions table to correlate watch time with storage.
 * 2-minute (120000ms) session threshold for valid "intent to watch".
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryRoiQuerySchema,
  type LibraryRoiQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

/** Value category for ROI classification */
type ValueCategory = 'low_value' | 'moderate_value' | 'high_value';

/** Individual ROI item with storage and watch metrics */
interface RoiItem {
  id: string;
  serverId: string;
  title: string;
  mediaType: string;
  year: number | null;
  // Storage metrics
  fileSizeBytes: number;
  fileSizeGb: number;
  // Watch metrics
  watchCount: number;
  totalWatchMs: number;
  totalWatchHours: number;
  lastWatchedAt: string | null;
  daysSinceLastWatch: number | null;
  // ROI metrics
  watchHoursPerGb: number;
  valueScore: number; // 0-100 composite score
  valueCategory: ValueCategory;
  // Deletion suggestion
  suggestDeletion: boolean;
}

/** Summary statistics for ROI analysis */
interface RoiSummary {
  totalItems: number;
  totalStorageGb: number;
  totalWatchHours: number;
  avgWatchHoursPerGb: number;
  lowValueItems: number;
  lowValueStorageGb: number;
  potentialSavingsGb: number; // If low-value items were deleted
}

/** Value thresholds by content type */
interface ValueThresholds {
  movie: { lowValue: number; highValue: number };
  episode: { lowValue: number; highValue: number };
  show: { lowValue: number; highValue: number };
}

/** Full response for ROI endpoint */
interface RoiResponse {
  items: RoiItem[];
  summary: RoiSummary;
  thresholds: ValueThresholds;
  pagination: { page: number; pageSize: number; total: number };
}

/** Raw row from database for items */
interface RawRoiItemRow {
  id: string;
  server_id: string;
  title: string;
  media_type: string;
  year: number | null;
  file_size_bytes: string;
  file_size_gb: string;
  watch_count: string;
  total_watch_ms: string;
  total_watch_hours: string;
  last_watched_at: string | null;
  days_since_last_watch: string | null;
  watch_hours_per_gb: string;
  value_score: string;
  value_category: ValueCategory;
  suggest_deletion: boolean;
}

/** Raw row from database for summary */
interface RawSummaryRow {
  total_items: string;
  total_storage_gb: string;
  total_watch_hours: string;
  avg_watch_hours_per_gb: string;
  low_value_items: string;
  low_value_storage_gb: string;
  potential_savings_gb: string;
}

/**
 * Value thresholds by content type (watch hours per GB)
 *
 * Movies: Expected to be watched once, so lower threshold
 * Episodes: Often rewatched (series), higher threshold
 * Shows: Aggregated level, middle ground
 */
const VALUE_THRESHOLDS: ValueThresholds = {
  movie: {
    lowValue: 0.1, // < 0.1 watch hours per GB = low value
    highValue: 0.5, // > 0.5 watch hours per GB = high value
  },
  episode: {
    lowValue: 0.5, // Episodes expected to have more rewatches
    highValue: 2.0,
  },
  show: {
    lowValue: 0.3, // Aggregated show level
    highValue: 1.0,
  },
};

export const libraryRoiRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /roi - Content ROI analysis
   *
   * Returns library items with watch value per storage cost calculations.
   * Identifies low-value content for potential deletion.
   */
  app.get<{ Querystring: LibraryRoiQueryInput }>(
    '/roi',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryRoiQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        libraryId,
        mediaType,
        valueCategory,
        periodDays,
        includeAgeDecay,
        minFileSize,
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
        REDIS_KEYS.LIBRARY_ROI,
        serverId,
        `${libraryId ?? 'all'}-${mediaType}-${valueCategory}-${periodDays}-${includeAgeDecay}-${minFileSize}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as RoiResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build filters
      const serverFilter = buildLibraryServerFilter(serverId, authUser, 'li');
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      const mediaTypeFilter =
        mediaType && mediaType !== 'all' ? sql`AND li.media_type = ${mediaType}` : sql``;

      // Value category filter for final results
      const valueCategoryFilter =
        valueCategory === 'low_value'
          ? sql`AND value_category = 'low_value'`
          : valueCategory === 'moderate_value'
            ? sql`AND value_category = 'moderate_value'`
            : valueCategory === 'high_value'
              ? sql`AND value_category = 'high_value'`
              : sql``;

      // Sort column mapping - use sql.raw() for identifiers
      const sortColumnMap: Record<string, string> = {
        watch_hours_per_gb: 'watch_hours_per_gb',
        value_score: 'value_score',
        file_size: 'file_size_bytes',
        title: 'title',
      };
      const sortColumnName = sortColumnMap[sortBy] || 'watch_hours_per_gb';
      const sortDirStr = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';
      const orderByClause = sql.raw(`${sortColumnName} ${sortDirStr}`);

      const offset = (page - 1) * pageSize;

      // Combined ROI query: items, summary, and count in one round-trip
      // Uses window functions for summary aggregation alongside item results
      const combinedResult = await db.execute(sql`
        WITH child_stats AS (
          -- Aggregate child data for shows (episodes) and artists (tracks)
          SELECT
            grandparent_rating_key,
            server_id,
            SUM(file_size) AS total_size
          FROM library_items
          WHERE media_type IN ('episode', 'track') AND grandparent_rating_key IS NOT NULL
          GROUP BY grandparent_rating_key, server_id
        ),
        child_watch_stats AS (
          -- Get watch stats for shows/artists via their children
          SELECT
            child.grandparent_rating_key,
            child.server_id,
            COUNT(sess.id) FILTER (WHERE sess.duration_ms >= 120000) AS watch_count,
            COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) AS total_watch_ms,
            MAX(sess.stopped_at) AS last_watched_at
          FROM library_items child
          LEFT JOIN sessions sess ON sess.rating_key = child.rating_key
            AND sess.server_id = child.server_id
            AND sess.started_at >= NOW() - INTERVAL '1 day' * ${periodDays}
          WHERE child.media_type IN ('episode', 'track') AND child.grandparent_rating_key IS NOT NULL
          GROUP BY child.grandparent_rating_key, child.server_id
        ),
        item_roi AS (
          SELECT
            li.id,
            li.server_id,
            li.title,
            li.media_type,
            li.year,
            -- For shows/artists: use aggregated child size, otherwise use item's file_size
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cs.total_size, li.file_size)
              ELSE li.file_size
            END AS file_size_bytes,
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cs.total_size, li.file_size) / 1073741824.0
              ELSE li.file_size / 1073741824.0
            END AS file_size_gb,
            li.created_at AS added_at,
            -- For shows/artists: use child watch stats
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cws.watch_count, 0)
              ELSE COUNT(sess.id) FILTER (WHERE sess.duration_ms >= 120000)
            END AS watch_count,
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cws.total_watch_ms, 0)
              ELSE COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0)
            END AS total_watch_ms,
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cws.total_watch_ms, 0) / 3600000.0
              ELSE COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) / 3600000.0
            END AS total_watch_hours,
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN cws.last_watched_at
              ELSE MAX(sess.stopped_at)
            END AS last_watched_at,
            CASE
              WHEN li.media_type IN ('show', 'artist') THEN EXTRACT(DAY FROM NOW() - cws.last_watched_at)::int
              ELSE EXTRACT(DAY FROM NOW() - MAX(sess.stopped_at))::int
            END AS days_since_last_watch
          FROM library_items li
          LEFT JOIN child_stats cs ON li.media_type IN ('show', 'artist')
            AND cs.grandparent_rating_key = li.rating_key
            AND cs.server_id = li.server_id
          LEFT JOIN child_watch_stats cws ON li.media_type IN ('show', 'artist')
            AND cws.grandparent_rating_key = li.rating_key
            AND cws.server_id = li.server_id
          LEFT JOIN sessions sess ON li.media_type NOT IN ('show', 'artist')
            AND sess.rating_key = li.rating_key
            AND sess.server_id = li.server_id
            AND sess.started_at >= NOW() - INTERVAL '1 day' * ${periodDays}
          WHERE li.media_type NOT IN ('episode', 'track')  -- Exclude children, only show parent items
            AND (
              CASE
                WHEN li.media_type IN ('show', 'artist') THEN COALESCE(cs.total_size, li.file_size)
                ELSE li.file_size
              END
            ) > ${minFileSize}
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
          GROUP BY li.id, li.server_id, li.title, li.media_type, li.year, li.file_size, li.created_at,
                   cs.total_size, cws.watch_count, cws.total_watch_ms, cws.last_watched_at
        ),
        roi_scored AS (
          SELECT
            *,
            -- Watch hours per GB (core ROI metric)
            CASE
              WHEN file_size_gb > 0 THEN ROUND((total_watch_hours / file_size_gb)::numeric, 3)
              ELSE 0
            END AS watch_hours_per_gb,
            -- Value score (0-100) with optional age decay
            CASE
              WHEN file_size_gb > 0 THEN
                LEAST(100, GREATEST(0,
                  -- Base score from watch hours per GB (0-70 points)
                  LEAST(70, (total_watch_hours / file_size_gb) *
                    CASE media_type
                      WHEN 'movie' THEN 140  -- 0.5 hrs/GB = 70 points
                      WHEN 'episode' THEN 35 -- 2.0 hrs/GB = 70 points
                      ELSE 70               -- 1.0 hrs/GB = 70 points
                    END
                  ) +
                  -- Recency bonus (0-30 points, decays with age if includeAgeDecay)
                  CASE
                    WHEN days_since_last_watch IS NULL THEN 0
                    WHEN ${includeAgeDecay} AND days_since_last_watch > 90 THEN
                      GREATEST(0, 30 - (days_since_last_watch - 90) * 0.2)
                    ELSE 30
                  END
                ))
              ELSE 0
            END AS value_score,
            -- Value category based on type-specific thresholds
            CASE
              WHEN file_size_gb = 0 THEN 'moderate_value'
              WHEN media_type = 'movie' AND (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.1 THEN 'low_value'
              WHEN media_type = 'movie' AND (total_watch_hours / NULLIF(file_size_gb, 0)) > 0.5 THEN 'high_value'
              WHEN media_type = 'episode' AND (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.5 THEN 'low_value'
              WHEN media_type = 'episode' AND (total_watch_hours / NULLIF(file_size_gb, 0)) > 2.0 THEN 'high_value'
              WHEN (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.3 THEN 'low_value'
              WHEN (total_watch_hours / NULLIF(file_size_gb, 0)) > 1.0 THEN 'high_value'
              ELSE 'moderate_value'
            END AS value_category
          FROM item_roi
        ),
        filtered_items AS (
          SELECT
            *,
            -- Suggest deletion for low-value items with no recent watches
            (value_category = 'low_value' AND (days_since_last_watch IS NULL OR days_since_last_watch > 180)) AS suggest_deletion
          FROM roi_scored
          WHERE 1=1
            ${valueCategoryFilter}
        ),
        -- Summary aggregation computed once over all filtered items
        summary_stats AS (
          SELECT
            COUNT(*) AS total_items,
            COALESCE(SUM(file_size_gb), 0) AS total_storage_gb,
            COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours,
            CASE
              WHEN SUM(file_size_gb) > 0 THEN ROUND((SUM(total_watch_hours) / SUM(file_size_gb))::numeric, 2)
              ELSE 0
            END AS avg_watch_hours_per_gb,
            COUNT(*) FILTER (WHERE value_category = 'low_value') AS low_value_items,
            COALESCE(SUM(file_size_gb) FILTER (WHERE value_category = 'low_value'), 0) AS low_value_storage_gb,
            COALESCE(SUM(file_size_gb) FILTER (WHERE suggest_deletion), 0) AS potential_savings_gb
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
          pi.title,
          pi.media_type,
          pi.year,
          pi.file_size_bytes::text AS file_size_bytes,
          pi.file_size_gb::text AS file_size_gb,
          pi.watch_count::text AS watch_count,
          pi.total_watch_ms::text AS total_watch_ms,
          pi.total_watch_hours::text AS total_watch_hours,
          pi.last_watched_at::text AS last_watched_at,
          pi.days_since_last_watch::text AS days_since_last_watch,
          pi.watch_hours_per_gb::text AS watch_hours_per_gb,
          pi.value_score::text AS value_score,
          pi.value_category,
          pi.suggest_deletion,
          -- Summary fields (same for all rows)
          ss.total_items::text AS _total_items,
          ss.total_storage_gb::text AS _total_storage_gb,
          ss.total_watch_hours::text AS _total_watch_hours,
          ss.avg_watch_hours_per_gb::text AS _avg_watch_hours_per_gb,
          ss.low_value_items::text AS _low_value_items,
          ss.low_value_storage_gb::text AS _low_value_storage_gb,
          ss.potential_savings_gb::text AS _potential_savings_gb
        FROM paginated_items pi
        CROSS JOIN summary_stats ss
      `);

      // Extract items and summary from combined result
      interface CombinedRoiRow extends RawRoiItemRow {
        _total_items: string;
        _total_storage_gb: string;
        _total_watch_hours: string;
        _avg_watch_hours_per_gb: string;
        _low_value_items: string;
        _low_value_storage_gb: string;
        _potential_savings_gb: string;
      }

      const rows = combinedResult.rows as unknown as CombinedRoiRow[];

      const items: RoiItem[] = rows.map((row) => ({
        id: row.id,
        serverId: row.server_id,
        title: row.title,
        mediaType: row.media_type,
        year: row.year,
        fileSizeBytes: parseInt(row.file_size_bytes, 10) || 0,
        fileSizeGb: parseFloat(row.file_size_gb) || 0,
        watchCount: parseInt(row.watch_count, 10) || 0,
        totalWatchMs: parseInt(row.total_watch_ms, 10) || 0,
        totalWatchHours: parseFloat(row.total_watch_hours) || 0,
        lastWatchedAt: row.last_watched_at,
        daysSinceLastWatch: row.days_since_last_watch
          ? parseInt(row.days_since_last_watch, 10)
          : null,
        watchHoursPerGb: parseFloat(row.watch_hours_per_gb) || 0,
        valueScore: parseFloat(row.value_score) || 0,
        valueCategory: row.value_category,
        suggestDeletion: row.suggest_deletion,
      }));

      // Extract summary from first row (or fetch separately if no items)
      let summary: RoiSummary;
      let total: number;

      if (rows.length > 0) {
        const firstRow = rows[0]!;
        summary = {
          totalItems: parseInt(firstRow._total_items, 10) || 0,
          totalStorageGb: parseFloat(firstRow._total_storage_gb) || 0,
          totalWatchHours: parseFloat(firstRow._total_watch_hours) || 0,
          avgWatchHoursPerGb: parseFloat(firstRow._avg_watch_hours_per_gb) || 0,
          lowValueItems: parseInt(firstRow._low_value_items, 10) || 0,
          lowValueStorageGb: parseFloat(firstRow._low_value_storage_gb) || 0,
          potentialSavingsGb: parseFloat(firstRow._potential_savings_gb) || 0,
        };
        total = summary.totalItems;
      } else {
        // No items on current page - need summary separately for empty page case
        const summaryResult = await db.execute(sql`
          WITH item_roi AS (
            SELECT li.id, li.file_size / 1073741824.0 AS file_size_gb,
              COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) / 3600000.0 AS total_watch_hours,
              EXTRACT(DAY FROM NOW() - MAX(sess.stopped_at))::int AS days_since_last_watch, li.media_type
            FROM library_items li
            LEFT JOIN sessions sess ON sess.rating_key = li.rating_key AND sess.server_id = li.server_id
              AND sess.started_at >= NOW() - INTERVAL '1 day' * ${periodDays}
            WHERE li.file_size > ${minFileSize} ${serverFilter} ${libraryFilter} ${mediaTypeFilter}
            GROUP BY li.id
          ),
          roi_scored AS (
            SELECT *, CASE
              WHEN file_size_gb = 0 THEN 'moderate_value'
              WHEN media_type = 'movie' AND (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.1 THEN 'low_value'
              WHEN media_type = 'movie' AND (total_watch_hours / NULLIF(file_size_gb, 0)) > 0.5 THEN 'high_value'
              WHEN media_type = 'episode' AND (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.5 THEN 'low_value'
              WHEN media_type = 'episode' AND (total_watch_hours / NULLIF(file_size_gb, 0)) > 2.0 THEN 'high_value'
              WHEN (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.3 THEN 'low_value'
              WHEN (total_watch_hours / NULLIF(file_size_gb, 0)) > 1.0 THEN 'high_value'
              ELSE 'moderate_value' END AS value_category
            FROM item_roi
          ),
          filtered AS (
            SELECT *, (value_category = 'low_value' AND (days_since_last_watch IS NULL OR days_since_last_watch > 180)) AS suggest_deletion
            FROM roi_scored WHERE 1=1 ${valueCategoryFilter}
          )
          SELECT COUNT(*) AS total_items, COALESCE(SUM(file_size_gb), 0)::text AS total_storage_gb,
            COALESCE(SUM(total_watch_hours), 0)::text AS total_watch_hours,
            CASE WHEN SUM(file_size_gb) > 0 THEN ROUND((SUM(total_watch_hours) / SUM(file_size_gb))::numeric, 2)::text ELSE '0' END AS avg_watch_hours_per_gb,
            COUNT(*) FILTER (WHERE value_category = 'low_value') AS low_value_items,
            COALESCE(SUM(file_size_gb) FILTER (WHERE value_category = 'low_value'), 0)::text AS low_value_storage_gb,
            COALESCE(SUM(file_size_gb) FILTER (WHERE suggest_deletion), 0)::text AS potential_savings_gb
          FROM filtered
        `);
        const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;
        summary = {
          totalItems: parseInt(summaryRow.total_items, 10) || 0,
          totalStorageGb: parseFloat(summaryRow.total_storage_gb) || 0,
          totalWatchHours: parseFloat(summaryRow.total_watch_hours) || 0,
          avgWatchHoursPerGb: parseFloat(summaryRow.avg_watch_hours_per_gb) || 0,
          lowValueItems: parseInt(summaryRow.low_value_items, 10) || 0,
          lowValueStorageGb: parseFloat(summaryRow.low_value_storage_gb) || 0,
          potentialSavingsGb: parseFloat(summaryRow.potential_savings_gb) || 0,
        };
        total = summary.totalItems;
      }

      const response: RoiResponse = {
        items,
        summary,
        thresholds: VALUE_THRESHOLDS,
        pagination: { page, pageSize, total },
      };

      // Cache response
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_ROI, JSON.stringify(response));

      return response;
    }
  );
};
