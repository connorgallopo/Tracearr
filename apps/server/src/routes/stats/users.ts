/**
 * User Statistics Routes
 *
 * GET /users - User statistics with play counts (per ServerUser)
 * GET /top-users - User leaderboard by watch time (per ServerUser)
 *
 * Stats are per-ServerUser (server account), not per-User (identity).
 * Each server account is tracked separately.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import type { UserStats, TopUserStats } from '@tracearr/shared';
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
    return sql`AND su.server_id = ${serverId}`;
  }
  if (authUser.role !== 'owner') {
    if (authUser.serverIds.length === 0) {
      return sql`AND false`;
    } else if (authUser.serverIds.length === 1) {
      return sql`AND su.server_id = ${authUser.serverIds[0]}`;
    } else {
      const serverIdList = authUser.serverIds.map((id) => sql`${id}`);
      return sql`AND su.server_id IN (${sql.join(serverIdList, sql`, `)})`;
    }
  }
  return sql``;
}

export const usersRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /users - User statistics (per ServerUser)
   */
  app.get('/users', { preHandler: [app.authenticate] }, async (request, reply) => {
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

    // Build date filter for JOIN condition
    const dateJoinFilter = dateRange.start
      ? period === 'custom'
        ? sql`AND s.started_at >= ${dateRange.start} AND s.started_at < ${dateRange.end}`
        : sql`AND s.started_at >= ${dateRange.start}`
      : sql``; // All-time: no date filter

    // Query server_users with session stats
    // Stats are per-server-account (ServerUser), not per-identity (User)
    const result = await db.execute(sql`
        SELECT
          su.id as server_user_id,
          su.username,
          su.thumb_url,
          COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as play_count,
          COALESCE(SUM(s.duration_ms), 0)::bigint as watch_time_ms
        FROM server_users su
        LEFT JOIN sessions s ON s.server_user_id = su.id ${dateJoinFilter}
        WHERE true ${serverFilter}
        GROUP BY su.id, su.username, su.thumb_url
        ORDER BY play_count DESC
        LIMIT 20
      `);

    const userStats: UserStats[] = (
      result.rows as {
        server_user_id: string;
        username: string;
        thumb_url: string | null;
        play_count: number;
        watch_time_ms: string;
      }[]
    ).map((r) => ({
      serverUserId: r.server_user_id,
      username: r.username,
      thumbUrl: r.thumb_url,
      playCount: r.play_count,
      watchTimeHours: Math.round((Number(r.watch_time_ms) / (1000 * 60 * 60)) * 10) / 10,
    }));

    return { data: userStats };
  });

  /**
   * GET /top-users - User leaderboard (per ServerUser)
   */
  app.get('/top-users', { preHandler: [app.authenticate] }, async (request, reply) => {
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

    // Build date filter for JOIN condition
    const dateJoinFilter = dateRange.start
      ? period === 'custom'
        ? sql`AND s.started_at >= ${dateRange.start} AND s.started_at < ${dateRange.end}`
        : sql`AND s.started_at >= ${dateRange.start}`
      : sql``; // All-time: no date filter

    // Query server_users with session stats
    // Stats are per-server-account (ServerUser), not per-identity (User)
    // Include server_id for avatar proxy and top genre/show
    // Join with users table to get identity name
    const topUsersResult = await db.execute(sql`
        SELECT
          su.id as server_user_id,
          su.username,
          u.name as identity_name,
          su.thumb_url,
          su.server_id::text,
          su.trust_score,
          COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as play_count,
          COALESCE(SUM(s.duration_ms), 0)::bigint as watch_time_ms,
          MODE() WITHIN GROUP (ORDER BY s.media_type) as top_media_type,
          MODE() WITHIN GROUP (ORDER BY COALESCE(s.grandparent_title, s.media_title)) as top_content
        FROM server_users su
        INNER JOIN users u ON su.user_id = u.id
        LEFT JOIN sessions s ON s.server_user_id = su.id ${dateJoinFilter}
        WHERE true ${serverFilter}
        GROUP BY su.id, su.username, u.name, su.thumb_url, su.server_id, su.trust_score
        ORDER BY watch_time_ms DESC
        LIMIT 10
      `);

    const topUsers: TopUserStats[] = (
      topUsersResult.rows as {
        server_user_id: string;
        username: string;
        identity_name: string | null;
        thumb_url: string | null;
        server_id: string | null;
        trust_score: number;
        play_count: number;
        watch_time_ms: string;
        top_media_type: string | null;
        top_content: string | null;
      }[]
    ).map((r) => ({
      serverUserId: r.server_user_id,
      username: r.username,
      identityName: r.identity_name,
      thumbUrl: r.thumb_url,
      serverId: r.server_id,
      trustScore: r.trust_score,
      playCount: r.play_count,
      watchTimeHours: Math.round((Number(r.watch_time_ms) / (1000 * 60 * 60)) * 10) / 10,
      topMediaType: r.top_media_type,
      topContent: r.top_content,
    }));

    return { data: topUsers };
  });
};
