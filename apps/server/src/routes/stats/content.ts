/**
 * Content Statistics Routes
 *
 * GET /top-content - Top movies and shows by play count
 * GET /libraries - Library counts (placeholder)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveDateRange } from './utils.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';

/**
 * Build SQL server filter fragment for raw queries
 */
function buildServerFilterSql(
  serverId: string | undefined,
  authUser: { role: string; serverIds: string[] }
): ReturnType<typeof sql> {
  if (serverId) {
    return sql`AND server_id = ${serverId}`;
  }
  if (authUser.role !== 'owner') {
    if (authUser.serverIds.length === 0) {
      return sql`AND false`;
    } else if (authUser.serverIds.length === 1) {
      return sql`AND server_id = ${authUser.serverIds[0]}`;
    } else {
      const serverIdList = authUser.serverIds.map((id) => sql`${id}`);
      return sql`AND server_id IN (${sql.join(serverIdList, sql`, `)})`;
    }
  }
  return sql``;
}

export const contentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /top-content - Top movies and shows by play count
   *
   * Returns separate arrays for movies and TV shows:
   * - Movies: Grouped by movie title
   * - Shows: Aggregated by series (grandparent_title), counting total episode plays
   */
  app.get('/top-content', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    // Validate server access if specific server requested
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    const serverFilter = buildServerFilterSql(serverId, authUser);

    // For all-time queries, we need a base WHERE clause
    const startDateFilter = dateRange.start ? sql`started_at >= ${dateRange.start}` : sql`true`;
    const customEndFilter = period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``;

    // Run both queries in parallel for better performance
    const [moviesResult, showsResult] = await Promise.all([
      // Query top movies (media_type = 'movie')
      db.execute(sql`
          SELECT
            media_title,
            year,
            COUNT(DISTINCT COALESCE(reference_id, id))::int as play_count,
            COALESCE(SUM(duration_ms), 0)::bigint as total_watch_ms,
            MAX(thumb_path) as thumb_path,
            MAX(server_id::text) as server_id,
            MAX(rating_key) as rating_key
          FROM sessions
          WHERE ${startDateFilter} AND media_type = 'movie'
          ${customEndFilter}
          ${serverFilter}
          GROUP BY media_title, year
          ORDER BY play_count DESC
          LIMIT 10
        `),
      // Query top TV shows (aggregate by series using grandparent_title)
      db.execute(sql`
          SELECT
            grandparent_title,
            MAX(year) as year,
            COUNT(DISTINCT COALESCE(reference_id, id))::int as play_count,
            COUNT(DISTINCT media_title)::int as episode_count,
            COALESCE(SUM(duration_ms), 0)::bigint as total_watch_ms,
            MAX(thumb_path) as thumb_path,
            MAX(server_id::text) as server_id,
            MAX(rating_key) as rating_key
          FROM sessions
          WHERE ${startDateFilter} AND media_type = 'episode' AND grandparent_title IS NOT NULL
          ${customEndFilter}
          ${serverFilter}
          GROUP BY grandparent_title
          ORDER BY play_count DESC
          LIMIT 10
        `),
    ]);

    const movies = (
      moviesResult.rows as {
        media_title: string;
        year: number | null;
        play_count: number;
        total_watch_ms: string;
        thumb_path: string | null;
        server_id: string | null;
        rating_key: string | null;
      }[]
    ).map((m) => ({
      title: m.media_title,
      type: 'movie' as const,
      year: m.year,
      playCount: m.play_count,
      watchTimeHours: Math.round((Number(m.total_watch_ms) / (1000 * 60 * 60)) * 10) / 10,
      thumbPath: m.thumb_path,
      serverId: m.server_id,
      ratingKey: m.rating_key,
    }));

    const shows = (
      showsResult.rows as {
        grandparent_title: string;
        year: number | null;
        play_count: number;
        episode_count: number;
        total_watch_ms: string;
        thumb_path: string | null;
        server_id: string | null;
        rating_key: string | null;
      }[]
    ).map((s) => ({
      title: s.grandparent_title, // Series name
      type: 'episode' as const,
      year: s.year,
      playCount: s.play_count,
      episodeCount: s.episode_count, // Number of unique episodes watched
      watchTimeHours: Math.round((Number(s.total_watch_ms) / (1000 * 60 * 60)) * 10) / 10,
      thumbPath: s.thumb_path,
      serverId: s.server_id,
      ratingKey: s.rating_key,
    }));

    return { movies, shows };
  });

  /**
   * GET /libraries - Library counts (placeholder - would need library sync)
   */
  app.get('/libraries', { preHandler: [app.authenticate] }, async () => {
    // In a real implementation, we'd sync library counts from servers
    // For now, return a placeholder
    return {
      movies: 0,
      shows: 0,
      episodes: 0,
      tracks: 0,
    };
  });
};
