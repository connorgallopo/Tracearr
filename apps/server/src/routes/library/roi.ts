/**
 * Library ROI (Return on Investment) Route
 *
 * GET /roi - Watch hours per GB of storage for each movie and show in the selected window.
 *
 * Plays come from user_media_plays_daily by media identity (episodes roll up to their show,
 * merged aliases fold into the winner), so a title re-added under a new rating key keeps its
 * plays. Sizes are summed at episode grain with mirrored files counted once.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryRoiQuerySchema,
  type LibraryRoiQueryInput,
  type RoiItem,
  type RoiResponse,
  type RoiSummary,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import {
  buildLibraryCacheKey,
  identLastWatchedCte,
  identSizesCte,
  resolveLibraryWindow,
  rollupIdentWatchCte,
} from './utils.js';
import { serverCacheSegment } from '../../lib/scope.js';

type RoiSortBy = LibraryRoiQueryInput['sortBy'];

interface RoiQueryInput {
  window: { startDate: Date | null; endDate: Date };
  serverIds: string[] | undefined;
  libraryId: string | undefined;
  mediaType: 'movie' | 'show' | 'all';
  sortBy: RoiSortBy;
  sortOrder: 'asc' | 'desc';
  limit: number;
  offset: number;
}

interface RawSummaryRow {
  summary_items: string;
  summary_storage_gb: string;
  summary_watch_hours: string;
  summary_hours_per_gb: string;
}

interface RawRoiRow extends RawSummaryRow {
  id: string;
  media_id: string | null;
  server_id: string;
  server_name: string;
  server_ids: string[];
  title: string;
  media_type: 'movie' | 'show';
  year: number | null;
  file_size_bytes: string;
  file_size_gb: string;
  watch_count: string;
  total_watch_hours: string;
  watch_hours_per_gb: string;
  last_watched_at: string | null;
}

const SORT_COLUMNS: Record<RoiSortBy, string> = {
  watch_hours_per_gb: 'watch_hours_per_gb',
  watch_hours: 'total_watch_hours',
  file_size: 'file_size_bytes',
  last_watched: 'last_day',
  title: 'sort_key',
};

// One row per title ident with at least one byte on the selected servers, plus the summary
// over all of them.
function roiCtes(input: Omit<RoiQueryInput, 'sortBy' | 'sortOrder' | 'limit' | 'offset'>): SQL {
  const serverFilterOnLi = buildMultiServerFragment(input.serverIds, 'li.server_id');
  const serverFilterOnP = buildMultiServerFragment(input.serverIds, 'p.server_id');
  const libraryFilter = input.libraryId ? sql`AND li.library_id = ${input.libraryId}` : sql``;
  const mediaTypes = input.mediaType === 'all' ? sql`('movie', 'show')` : sql`(${input.mediaType})`;

  return sql`
    WITH top_items AS (
      SELECT li.id, li.server_id, li.title, li.media_type, li.year, li.created_at,
             COALESCE(m.merged_into_id, li.media_id) AS media_id,
             COALESCE(m.sort_title, lower(li.title)) AS sort_key,
             COALESCE(m.merged_into_id::text, li.media_id::text, li.id::text) AS ident
      FROM library_items li
      LEFT JOIN media m ON m.id = li.media_id
      WHERE li.media_type IN ${mediaTypes}
        AND li.removed_at IS NULL
        ${serverFilterOnLi}
        ${libraryFilter}
    ),
    ident_reps AS (
      SELECT ident,
             (array_agg(id ORDER BY created_at ASC NULLS LAST, id))[1] AS id,
             (array_agg(media_id ORDER BY created_at ASC NULLS LAST, id))[1] AS media_id,
             (array_agg(server_id ORDER BY created_at ASC NULLS LAST, id))[1] AS server_id,
             (array_agg(title ORDER BY created_at ASC NULLS LAST, id))[1] AS title,
             (array_agg(sort_key ORDER BY created_at ASC NULLS LAST, id))[1] AS sort_key,
             (array_agg(media_type ORDER BY created_at ASC NULLS LAST, id))[1] AS media_type,
             (array_agg(year ORDER BY created_at ASC NULLS LAST, id))[1] AS year,
             array_agg(DISTINCT server_id::text ORDER BY server_id::text) AS server_ids
      FROM top_items
      GROUP BY ident
    ),
    ident_sizes AS (${identSizesCte(serverFilterOnLi, libraryFilter)}),
    ident_watch AS (${rollupIdentWatchCte(input.window, serverFilterOnP)}),
    ident_last AS (${identLastWatchedCte(serverFilterOnP)}),
    item_roi AS (
      SELECT r.id, r.media_id, r.server_id, r.server_ids, r.title, r.sort_key, r.media_type, r.year, il.last_day,
             isz.file_size AS file_size_bytes,
             isz.file_size / 1073741824.0 AS file_size_gb,
             COALESCE(iw.watch_count, 0) AS watch_count,
             COALESCE(iw.total_watch_ms, 0) / 3600000.0 AS total_watch_hours,
             ROUND(COALESCE(iw.total_watch_ms, 0) / 3600000.0 / (isz.file_size / 1073741824.0), 3)
               AS watch_hours_per_gb
      FROM ident_reps r
      JOIN ident_sizes isz ON isz.ident = r.ident AND isz.file_size > 0
      LEFT JOIN ident_watch iw ON iw.ident = r.ident
      LEFT JOIN ident_last il ON il.ident = r.ident
    ),
    summary_stats AS (
      SELECT COUNT(*)::text AS summary_items,
             COALESCE(SUM(file_size_gb), 0)::text AS summary_storage_gb,
             COALESCE(SUM(total_watch_hours), 0)::text AS summary_watch_hours,
             COALESCE(ROUND(SUM(total_watch_hours) / SUM(file_size_gb), 2), 0)::text
               AS summary_hours_per_gb
      FROM item_roi
    )`;
}

export function buildRoiQuery(input: RoiQueryInput): SQL {
  const direction = input.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const orderBy = (alias: string) =>
    sql.raw(`${alias}${SORT_COLUMNS[input.sortBy]} ${direction} NULLS LAST, ${alias}id`);
  return sql`
    ${roiCtes(input)}
    SELECT pi.id, pi.media_id, pi.server_id, s.name AS server_name, pi.server_ids, pi.title,
           pi.media_type, pi.year,
           pi.file_size_bytes::text AS file_size_bytes,
           pi.file_size_gb::text AS file_size_gb,
           pi.watch_count::text AS watch_count,
           pi.total_watch_hours::text AS total_watch_hours,
           pi.watch_hours_per_gb::text AS watch_hours_per_gb,
           to_char(pi.last_day AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_watched_at,
           ss.*
    FROM (
      SELECT * FROM item_roi ORDER BY ${orderBy('')} LIMIT ${input.limit} OFFSET ${input.offset}
    ) pi
    JOIN servers s ON s.id = pi.server_id
    CROSS JOIN summary_stats ss
    ORDER BY ${orderBy('pi.')}`;
}

export function buildRoiSummaryQuery(
  input: Omit<RoiQueryInput, 'sortBy' | 'sortOrder' | 'limit' | 'offset'>
): SQL {
  return sql`${roiCtes(input)} SELECT * FROM summary_stats`;
}

function toSummary(row: RawSummaryRow): RoiSummary {
  return {
    totalItems: parseInt(row.summary_items, 10) || 0,
    totalStorageGb: parseFloat(row.summary_storage_gb) || 0,
    totalWatchHours: parseFloat(row.summary_watch_hours) || 0,
    avgWatchHoursPerGb: parseFloat(row.summary_hours_per_gb) || 0,
  };
}

export const libraryRoiRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: LibraryRoiQueryInput }>(
    '/roi',
    { preHandler: [app.requirePermission('insights', 'read')] },
    async (request, reply) => {
      const query = libraryRoiQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        serverIds: rawServerIds,
        libraryId,
        mediaType,
        sortBy,
        sortOrder,
        page,
        pageSize,
      } = query.data;
      const { startDate, endDate, cacheSegment } = resolveLibraryWindow(query.data);
      const serverIds = resolveServerIds(request.user, serverId, rawServerIds);

      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_ROI,
        serverCacheSegment(serverIds),
        `${libraryId ?? 'all'}-${mediaType}-${cacheSegment}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as RoiResponse;
        } catch {
          // Fall through to compute
        }
      }

      const scope = { window: { startDate, endDate }, serverIds, libraryId, mediaType };
      const result = await db.execute(
        buildRoiQuery({
          ...scope,
          sortBy,
          sortOrder,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        })
      );
      const rows = result.rows as unknown as RawRoiRow[];

      const items: RoiItem[] = rows.map((row) => ({
        id: row.id,
        mediaId: row.media_id,
        serverId: row.server_id,
        serverName: row.server_name,
        serverIds: row.server_ids,
        title: row.title,
        mediaType: row.media_type,
        year: row.year,
        fileSizeBytes: parseInt(row.file_size_bytes, 10) || 0,
        fileSizeGb: parseFloat(row.file_size_gb) || 0,
        watchCount: parseInt(row.watch_count, 10) || 0,
        totalWatchHours: parseFloat(row.total_watch_hours) || 0,
        watchHoursPerGb: parseFloat(row.watch_hours_per_gb) || 0,
        lastWatchedAt: row.last_watched_at,
      }));

      const summaryRow =
        rows[0] ??
        ((await db.execute(buildRoiSummaryQuery(scope))).rows[0] as unknown as RawSummaryRow);
      const summary = toSummary(summaryRow);

      const response: RoiResponse = {
        items,
        summary,
        pagination: { page, pageSize, total: summary.totalItems },
      };

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_ROI, JSON.stringify(response));

      return response;
    }
  );
};
