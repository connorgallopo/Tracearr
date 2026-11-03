/**
 * Library Watch Statistics Route
 *
 * GET /watch - Watch summary for the movies and episodes in scope.
 *
 * Titles are media identities (a merged alias folds into its winner), so a title on two
 * servers counts once and its plays on both are summed. The inventory is every title in scope
 * regardless of the window; plays, watch time and completion come from user_media_plays_daily
 * within the window, so a title re-added under a new rating key keeps its plays.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryWatchQuerySchema,
  type CompletionCounts,
  type LibraryWatchQueryInput,
  type WatchResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { rollupDayWindowSql } from '../../db/sessions/rules.js';
import { buildLibraryCacheKey, resolveLibraryWindow } from './utils.js';
import { serverCacheSegment } from '../../lib/scope.js';

interface RawWatchRow {
  total_items: string;
  watched_count: string;
  total_watch_ms: string;
  total_plays: string;
  movie_completed: string;
  movie_in_progress: string;
  movie_not_started: string;
  episode_completed: string;
  episode_in_progress: string;
  episode_not_started: string;
}

export function buildWatchSummaryQuery(input: {
  window: { startDate: Date | null; endDate: Date };
  serverIds: string[] | undefined;
  libraryId: string | undefined;
}): SQL {
  const libraryFilter = input.libraryId ? sql`AND li.library_id = ${input.libraryId}` : sql``;
  return sql`
    WITH inventory AS (
      SELECT COALESCE(m.merged_into_id, li.media_id, li.id) AS ident, MIN(li.media_type) AS media_type
      FROM library_items li
      LEFT JOIN media m ON m.id = li.media_id
      WHERE li.removed_at IS NULL AND li.media_type IN ('movie', 'episode')
        ${buildMultiServerFragment(input.serverIds, 'li.server_id')}
        ${libraryFilter}
      GROUP BY 1
    ),
    plays AS (
      SELECT COALESCE(pm.merged_into_id, p.media_id) AS ident,
        COUNT(DISTINCT p.chain_id) FILTER (WHERE p.counted) AS plays,
        SUM(p.watched_ms) AS watched_ms,
        BOOL_OR(p.any_watched OR p.max_progress_ms >= 0.85 * p.content_duration_ms)
          FILTER (WHERE p.counted) AS completed
      FROM user_media_plays_daily p
      LEFT JOIN media pm ON pm.id = p.media_id
      WHERE p.media_type IN ('movie', 'episode')
        ${rollupDayWindowSql(input.window, sql`p.day`)}
        ${buildMultiServerFragment(input.serverIds, 'p.server_id')}
      GROUP BY 1
    ),
    titles AS (
      SELECT i.media_type, COALESCE(pl.plays, 0) AS plays, COALESCE(pl.watched_ms, 0) AS watched_ms,
        CASE WHEN pl.completed THEN 'completed' WHEN pl.plays > 0 THEN 'in_progress' END AS status
      FROM inventory i
      LEFT JOIN plays pl ON pl.ident = i.ident
    )
    SELECT
      COUNT(*)::text AS total_items,
      COUNT(*) FILTER (WHERE plays > 0)::text AS watched_count,
      SUM(watched_ms)::text AS total_watch_ms,
      SUM(plays)::text AS total_plays,
      COUNT(*) FILTER (WHERE media_type = 'movie' AND status = 'completed')::text AS movie_completed,
      COUNT(*) FILTER (WHERE media_type = 'movie' AND status = 'in_progress')::text AS movie_in_progress,
      COUNT(*) FILTER (WHERE media_type = 'movie' AND status IS NULL)::text AS movie_not_started,
      COUNT(*) FILTER (WHERE media_type = 'episode' AND status = 'completed')::text AS episode_completed,
      COUNT(*) FILTER (WHERE media_type = 'episode' AND status = 'in_progress')::text AS episode_in_progress,
      COUNT(*) FILTER (WHERE media_type = 'episode' AND status IS NULL)::text AS episode_not_started
    FROM titles`;
}

const toInt = (value: string | null | undefined) => parseInt(value ?? '0', 10) || 0;

function toResponse(row: RawWatchRow | undefined): WatchResponse {
  const totalItems = toInt(row?.total_items);
  const watchedCount = toInt(row?.watched_count);
  const counts = (type: 'movie' | 'episode'): CompletionCounts => ({
    completed: toInt(row?.[`${type}_completed`]),
    inProgress: toInt(row?.[`${type}_in_progress`]),
    notStarted: toInt(row?.[`${type}_not_started`]),
  });
  return {
    summary: {
      totalItems,
      watchedCount,
      watchedPct: totalItems > 0 ? Math.round((watchedCount / totalItems) * 1000) / 10 : 0,
      totalWatchMs: toInt(row?.total_watch_ms),
      avgPlaysPerItem:
        totalItems > 0 ? Math.round((toInt(row?.total_plays) / totalItems) * 100) / 100 : 0,
      completion: { movie: counts('movie'), episode: counts('episode') },
    },
  };
}

export const libraryWatchRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: LibraryWatchQueryInput }>(
    '/watch',
    { preHandler: [app.requirePermission('insights', 'read')] },
    async (request, reply) => {
      const query = libraryWatchQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds: rawServerIds, libraryId } = query.data;
      const { startDate, endDate, cacheSegment } = resolveLibraryWindow(query.data);
      const serverIds = resolveServerIds(request.user, serverId, rawServerIds);
      if (serverIds?.length === 0) {
        return toResponse(undefined);
      }

      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_WATCH,
        serverCacheSegment(serverIds),
        `${libraryId ?? 'all'}-${cacheSegment}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as WatchResponse;
        } catch {
          // Fall through to compute
        }
      }

      const result = await db.execute(
        buildWatchSummaryQuery({ window: { startDate, endDate }, serverIds, libraryId })
      );
      const response = toResponse(result.rows[0] as unknown as RawWatchRow | undefined);

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_WATCH, JSON.stringify(response));
      return response;
    }
  );
};
