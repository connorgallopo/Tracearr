/**
 * User Statistics Routes
 *
 * GET /users - User statistics with play counts (per identity)
 * GET /top-users - User leaderboard by watch time (per identity)
 *
 * Stats are per-User (identity), not per-ServerUser (server account): a merged
 * person with accounts on multiple servers appears once, with plays and watch
 * time summed across every account they have on the resolved servers.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, eq, and, inArray } from 'drizzle-orm';
import { statsQuerySchema, SESSION_LIMITS } from '@tracearr/shared';
import type { UserStats, TopUserStats } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { serverUsers, servers } from '../../db/schema.js';
import { resolveDateRange } from './utils.js';
import {
  resolveServerIds,
  buildMultiServerFragment,
  buildServerAccessCondition,
} from '../../utils/serverFiltering.js';
import { representativeAccountOrderSql } from '../../utils/representativeAccount.js';
import { MEDIA_TYPE_SQL_FILTER_S } from '../../constants/index.js';

export const usersRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /users - User statistics (per identity)
   */
  app.get('/users', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    if (resolvedIds?.length === 0) {
      return { data: [] };
    }

    const serverFilterSu = buildMultiServerFragment(resolvedIds, 'su.server_id');
    const serverFilterSu2 = buildMultiServerFragment(resolvedIds, 'su2.server_id');

    // Build date filter for JOIN condition
    // Also filter to only movies/episodes (exclude live TV and music tracks)
    const dateJoinFilter = dateRange.start
      ? period === 'custom'
        ? sql`AND s.started_at >= ${dateRange.start} AND s.started_at < ${dateRange.end} ${MEDIA_TYPE_SQL_FILTER_S}`
        : sql`AND s.started_at >= ${dateRange.start} ${MEDIA_TYPE_SQL_FILTER_S}`
      : MEDIA_TYPE_SQL_FILTER_S; // All-time: only media type filter

    const result = await db.execute(sql`
        SELECT
          rep.id as server_user_id,
          rep.server_id::text as server_id,
          rep.username,
          rep.thumb_url,
          COUNT(DISTINCT COALESCE(s.reference_id, s.id)) FILTER (WHERE s.duration_ms >= ${SESSION_LIMITS.MIN_PLAY_TIME_MS})::int as play_count,
          COALESCE(SUM(s.duration_ms), 0)::bigint as watch_time_ms
        FROM users u
        INNER JOIN server_users su ON su.user_id = u.id
        LEFT JOIN sessions s ON s.server_user_id = su.id ${dateJoinFilter}
        INNER JOIN LATERAL (
          SELECT su2.id, su2.server_id, su2.username, su2.thumb_url
          FROM server_users su2
          WHERE su2.user_id = u.id ${serverFilterSu2}
          ORDER BY ${representativeAccountOrderSql('su2')}
          LIMIT 1
        ) rep ON true
        WHERE true ${serverFilterSu}
        GROUP BY u.id, rep.id, rep.server_id, rep.username, rep.thumb_url
        ORDER BY play_count DESC, watch_time_ms DESC, u.id
        LIMIT 20
      `);

    const userStats: UserStats[] = (
      result.rows as {
        server_user_id: string;
        server_id: string | null;
        username: string;
        thumb_url: string | null;
        play_count: number;
        watch_time_ms: string;
      }[]
    ).map((r) => ({
      serverUserId: r.server_user_id,
      serverId: r.server_id,
      username: r.username,
      thumbUrl: r.thumb_url,
      playCount: r.play_count,
      watchTimeHours: Math.round((Number(r.watch_time_ms) / (1000 * 60 * 60)) * 10) / 10,
    }));

    return { data: userStats };
  });

  /**
   * GET /top-users - User leaderboard (per identity)
   */
  app.get('/top-users', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    if (resolvedIds?.length === 0) {
      return { data: [] };
    }

    const serverFilterSu = buildMultiServerFragment(resolvedIds, 'su.server_id');
    const serverFilterSu2 = buildMultiServerFragment(resolvedIds, 'su2.server_id');

    // Build date filter for JOIN condition
    // Also filter to only movies/episodes (exclude live TV and music tracks)
    const topDateJoinFilter = dateRange.start
      ? period === 'custom'
        ? sql`AND s.started_at >= ${dateRange.start} AND s.started_at < ${dateRange.end} ${MEDIA_TYPE_SQL_FILTER_S}`
        : sql`AND s.started_at >= ${dateRange.start} ${MEDIA_TYPE_SQL_FILTER_S}`
      : MEDIA_TYPE_SQL_FILTER_S; // All-time: only media type filter

    // Aggregate by identity: plays/watch time are summed across every account
    // the person has on the resolved servers. `rep` picks one representative
    // account (deterministic tiebreak) for navigation, avatar, and username
    // fallback; the identity's own name and aggregate trust score win when set.
    const topUsersResult = await db.execute(sql`
        SELECT
          u.id as user_id,
          u.name as identity_name,
          u.aggregate_trust_score,
          rep.id as server_user_id,
          rep.username,
          rep.thumb_url,
          rep.server_id::text as server_id,
          COUNT(DISTINCT COALESCE(s.reference_id, s.id)) FILTER (WHERE s.duration_ms >= ${SESSION_LIMITS.MIN_PLAY_TIME_MS})::int as play_count,
          COALESCE(SUM(s.duration_ms), 0)::bigint as watch_time_ms,
          MODE() WITHIN GROUP (ORDER BY s.media_type) as top_media_type,
          MODE() WITHIN GROUP (ORDER BY COALESCE(s.grandparent_title, s.media_title)) as top_content
        FROM users u
        INNER JOIN server_users su ON su.user_id = u.id
        LEFT JOIN sessions s ON s.server_user_id = su.id ${topDateJoinFilter}
        INNER JOIN LATERAL (
          SELECT su2.id, su2.username, su2.thumb_url, su2.server_id
          FROM server_users su2
          WHERE su2.user_id = u.id ${serverFilterSu2}
          ORDER BY ${representativeAccountOrderSql('su2')}
          LIMIT 1
        ) rep ON true
        WHERE true ${serverFilterSu}
        GROUP BY u.id, u.name, u.aggregate_trust_score, rep.id, rep.username, rep.thumb_url, rep.server_id
        ORDER BY watch_time_ms DESC, play_count DESC, u.id
        LIMIT 10
      `);

    const rows = topUsersResult.rows as {
      user_id: string;
      identity_name: string | null;
      aggregate_trust_score: number;
      server_user_id: string;
      username: string;
      thumb_url: string | null;
      server_id: string | null;
      play_count: number;
      watch_time_ms: string;
      top_media_type: string | null;
      top_content: string | null;
    }[];

    // Batch-fetch each identity's server memberships, scoped to servers the
    // caller can access (owners see all), for the multi-server pill display.
    const userIds = [...new Set(rows.map((r) => r.user_id))];
    const identityServersByUserId = new Map<string, { id: string; name: string }[]>();
    if (userIds.length > 0) {
      const accessCondition = buildServerAccessCondition(authUser, serverUsers.serverId);
      const identityWhere = accessCondition
        ? and(inArray(serverUsers.userId, userIds), accessCondition)
        : inArray(serverUsers.userId, userIds);

      const identityServerRows = await db
        .selectDistinct({
          userId: serverUsers.userId,
          serverId: serverUsers.serverId,
          serverName: servers.name,
        })
        .from(serverUsers)
        .innerJoin(servers, eq(serverUsers.serverId, servers.id))
        .where(identityWhere);

      for (const row of identityServerRows) {
        const existing = identityServersByUserId.get(row.userId);
        const entry = { id: row.serverId, name: row.serverName };
        if (existing) {
          existing.push(entry);
        } else {
          identityServersByUserId.set(row.userId, [entry]);
        }
      }
    }

    const topUsers: TopUserStats[] = rows.map((r) => ({
      userId: r.user_id,
      serverUserId: r.server_user_id,
      username: r.username,
      identityName: r.identity_name,
      thumbUrl: r.thumb_url,
      serverId: r.server_id,
      trustScore: r.aggregate_trust_score,
      playCount: r.play_count,
      watchTimeHours: Math.round((Number(r.watch_time_ms) / (1000 * 60 * 60)) * 10) / 10,
      topMediaType: r.top_media_type,
      topContent: r.top_content,
      identityServers: identityServersByUserId.get(r.user_id) ?? [],
    }));

    return { data: topUsers };
  });
};
