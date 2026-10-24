/**
 * Library Stale Content Route
 *
 * GET /stale - Identify unwatched or rarely-watched content
 *
 * Categories:
 * - never_watched: Content added but never played (no sessions)
 * - stale: Content watched but not revisited in N days
 *
 * Sessions are aggregated once per server and rating key, then joined to the items,
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
import { countedSessionSql } from '../../db/sessions/rules.js';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { resolutionRankSql } from '../../utils/resolutionBuckets.js';
import { buildLibraryCacheKey } from './utils.js';

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
    { preHandler: [app.requirePermission('insights', 'read')] },
    async (request, reply) => {
      const query = libraryStaleQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        serverIds: rawServerIds,
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

      const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds);

      // Build cache key with all varying params
      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_STALE,
        serverCacheSegment,
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
      const serverFilter = buildMultiServerFragment(resolvedIds, 'li.server_id');
      const sessionServerFilter = buildMultiServerFragment(resolvedIds, 'sess.server_id');
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
        title: 'sort_key',
        added_at: 'added_at',
      };
      const sortColumnName = sortColumnMap[sortBy] || 'file_size';
      const sortDirStr = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';
      const orderByClause = sql.raw(`${sortColumnName} ${sortDirStr}, id`);
      const outerOrderByClause = sql.raw(`pi.${sortColumnName} ${sortDirStr}, pi.id`);

      const offset = (page - 1) * pageSize;

      // Watch state and bytes per identity, shared by the page and the empty-page summary
      const identCtes = sql`
        top_items AS (
          -- Every top-level entry with its identity key. A title merged
          -- across libraries or servers has several entries sharing one
          -- ident, a merged loser folds to its winner, and unmatched items
          -- fall back to their own id.
          SELECT li.id, li.server_id, li.library_id, li.rating_key, li.title,
                 li.media_type, li.year, li.video_resolution, li.created_at,
                 COALESCE(m.sort_title, lower(li.title)) AS sort_key,
                 COALESCE(m.merged_into_id::text, li.media_id::text, li.id::text) AS ident
          FROM library_items li
          LEFT JOIN media m ON m.id = li.media_id
          WHERE li.media_type NOT IN ('episode', 'track', 'season', 'album')  -- Exclude children/containers, only show content
            AND li.removed_at IS NULL
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
        ),
        ident_sizes AS MATERIALIZED (
          -- Physical bytes per identity: the entries' own versions for
          -- movies, children's versions for shows/artists, mirror-deduped by
          -- (ident, byte size) - the same heuristic the storage totals use,
          -- so a merged entry listing the same file twice counts it once
          SELECT ident, SUM(sz) AS file_size
          FROM (
            SELECT DISTINCT b.ident, v.file_size AS sz
            FROM top_items b
            LEFT JOIN library_items child ON b.media_type IN ('show', 'artist')
              AND child.grandparent_rating_key = b.rating_key
              AND child.server_id = b.server_id
              AND child.removed_at IS NULL
            JOIN library_item_versions v
              ON v.library_item_id = COALESCE(child.id, b.id)
              AND v.removed_at IS NULL AND v.file_size IS NOT NULL
          ) d
          GROUP BY ident
        ),
        ident_keys AS MATERIALIZED (
          -- The rating keys whose plays count for an identity: each entry's
          -- own key, or its children's for shows/artists. Tombstoned entries
          -- of the same title are included, so plays recorded under a
          -- re-added title's old key still count.
          SELECT e.ident, e.server_id, COALESCE(child.rating_key, e.rating_key) AS rating_key
          FROM (
            SELECT ident, server_id, rating_key, media_type, false AS removed FROM top_items
            UNION ALL
            SELECT COALESCE(m.merged_into_id::text, li.media_id::text), li.server_id,
                   li.rating_key, li.media_type, true
            FROM library_items li
            JOIN media m ON m.id = li.media_id
            WHERE li.removed_at IS NOT NULL
              AND li.media_type NOT IN ('episode', 'track', 'season', 'album')
              AND COALESCE(m.merged_into_id::text, li.media_id::text) IN (SELECT ident FROM top_items)
              ${serverFilter}
          ) e
          LEFT JOIN library_items child ON e.media_type IN ('show', 'artist')
            AND child.grandparent_rating_key = e.rating_key
            AND child.server_id = e.server_id
            AND (child.removed_at IS NULL OR e.removed)
        ),
        key_watch AS MATERIALIZED (
          SELECT sess.server_id, sess.rating_key,
                 MAX(sess.stopped_at) AS last_watched,
                 COUNT(DISTINCT COALESCE(sess.reference_id, sess.id))::int AS watch_count
          FROM sessions sess
          WHERE sess.rating_key IS NOT NULL AND ${countedSessionSql('sess')}
            ${sessionServerFilter}
          GROUP BY sess.server_id, sess.rating_key
        ),
        ident_watch AS MATERIALIZED (
          -- Resume linking only chains sessions with the same rating key, so
          -- per-key sums equal one count per play
          SELECT ik.ident, MAX(kw.last_watched) AS last_watched,
                 COALESCE(SUM(kw.watch_count), 0)::int AS watch_count
          FROM ident_keys ik
          LEFT JOIN key_watch kw ON kw.server_id = ik.server_id AND kw.rating_key = ik.rating_key
          GROUP BY ik.ident
        )
      `;

      // Combined query: items with pagination AND summary statistics in one round-trip
      // Uses window functions for summary aggregation alongside item results
      const combinedResult = await db.execute(sql`
        WITH ${identCtes},
        child_resolutions AS MATERIALIZED (
          SELECT grandparent_rating_key, server_id,
            (ARRAY_AGG(video_resolution ORDER BY ${resolutionRankSql('video_resolution')} DESC))[1]
              AS best_resolution
          FROM library_items
          WHERE media_type IN ('episode', 'track') AND grandparent_rating_key IS NOT NULL AND removed_at IS NULL
          GROUP BY grandparent_rating_key, server_id
        ),
        ident_reps AS (
          -- One representative entry per identity for display fields
          SELECT DISTINCT ON (ident) ident, id, server_id, library_id, rating_key,
                 title, sort_key, media_type, year, video_resolution, created_at
          FROM top_items
          ORDER BY ident, created_at ASC NULLS LAST, id
        ),
        item_watch_stats AS (
          SELECT
            r.id,
            r.server_id,
            r.library_id,
            r.title,
            r.sort_key,
            r.media_type,
            r.year,
            isz.file_size,
            CASE
              WHEN r.media_type IN ('show', 'artist') THEN COALESCE(cr.best_resolution, r.video_resolution)
              ELSE r.video_resolution
            END AS video_resolution,
            r.created_at AS added_at,
            iw.last_watched,
            COALESCE(iw.watch_count, 0) AS watch_count
          FROM ident_reps r
          LEFT JOIN ident_sizes isz ON isz.ident = r.ident
          LEFT JOIN ident_watch iw ON iw.ident = r.ident
          LEFT JOIN child_resolutions cr ON r.media_type IN ('show', 'artist')
            AND cr.grandparent_rating_key = r.rating_key
            AND cr.server_id = r.server_id
        ),
        stale_items AS (
          SELECT
            id,
            server_id,
            library_id,
            title,
            sort_key,
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
          s.name AS server_name,
          pi.library_id,
          COALESCE(l.name, s.name) AS library_name,
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
        JOIN servers s ON s.id = pi.server_id
        LEFT JOIN libraries l ON l.server_id = pi.server_id AND l.library_id = pi.library_id
        CROSS JOIN summary_stats ss
        ORDER BY ${outerOrderByClause}
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
      const firstRow = rows[0];
      if (firstRow) {
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
          WITH ${identCtes},
          idents AS (SELECT DISTINCT ident FROM top_items),
          stale_items AS (
            SELECT i.ident AS id, isz.file_size,
              CASE WHEN iw.last_watched IS NULL THEN 'never_watched' ELSE 'stale' END AS category
            FROM idents i
            LEFT JOIN ident_sizes isz ON isz.ident = i.ident
            LEFT JOIN ident_watch iw ON iw.ident = i.ident
            WHERE (iw.last_watched IS NULL OR iw.last_watched < NOW() - INTERVAL '1 day' * ${staleDays})
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
