/**
 * Dashboard Statistics Route
 *
 * GET /dashboard - Dashboard summary metrics (active streams, plays, watch time, alerts)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, gte, sql, and } from 'drizzle-orm';
import { REDIS_KEYS, TIME_MS, type DashboardStats, dashboardQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import {
  playsCountSince,
  watchTimeSince,
  violationsCountSince,
  uniqueUsersSince,
} from '../../db/prepared.js';
import {
  filterByServerAccess,
  validateServerAccess,
  buildServerAccessCondition,
} from '../../utils/serverFiltering.js';
import { getCacheService } from '../../services/cache.js';
import { getStartOfDayInTimezone } from './utils.js';

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /dashboard - Dashboard summary metrics
   *
   * Query params:
   * - serverId: Optional UUID to filter stats to a specific server
   */
  app.get('/dashboard', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = dashboardQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { serverId, timezone } = query.data;
    const authUser = request.user;
    // Default to UTC for backwards compatibility
    const tz = timezone ?? 'UTC';

    // Validate server access if specific server requested
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    // Build cache key (includes server and timezone for correct caching)
    const cacheKey = serverId
      ? `${REDIS_KEYS.DASHBOARD_STATS}:${serverId}:${tz}`
      : `${REDIS_KEYS.DASHBOARD_STATS}:${tz}`;

    // Try cache first
    const cached = await app.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as DashboardStats;
      } catch {
        // Fall through to compute
      }
    }

    // Get active streams count - filter by server access
    let activeStreams = 0;
    const cacheService = getCacheService();
    if (cacheService) {
      try {
        let activeSessions = await cacheService.getAllActiveSessions();
        // Filter by user's accessible servers
        activeSessions = filterByServerAccess(activeSessions, authUser);
        // If specific server requested, filter further
        if (serverId) {
          activeSessions = activeSessions.filter((s) => s.serverId === serverId);
        }
        activeStreams = activeSessions.length;
      } catch {
        // Ignore cache errors - activeStreams stays 0
      }
    }

    // Get today's plays and watch time (using user's timezone for "today")
    const todayStart = getStartOfDayInTimezone(tz);
    const last24h = new Date(Date.now() - TIME_MS.DAY);

    // If no serverId and user is owner, use prepared statements for performance
    // Otherwise, use dynamic queries with server filtering
    let todayPlays: number;
    let watchTimeHours: number;
    let alertsLast24h: number;
    let activeUsersToday: number;

    if (!serverId && authUser.role === 'owner') {
      // Owner with no filter - use prepared statements (fastest)
      const [todayPlaysResult, watchTimeResult, alertsResult, activeUsersResult] =
        await Promise.all([
          playsCountSince.execute({ since: todayStart }),
          watchTimeSince.execute({ since: todayStart }),
          violationsCountSince.execute({ since: last24h }),
          uniqueUsersSince.execute({ since: todayStart }),
        ]);

      todayPlays = todayPlaysResult[0]?.count ?? 0;
      watchTimeHours =
        Math.round((Number(watchTimeResult[0]?.totalMs ?? 0) / (1000 * 60 * 60)) * 10) / 10;
      alertsLast24h = alertsResult[0]?.count ?? 0;
      activeUsersToday = activeUsersResult[0]?.count ?? 0;
    } else {
      // Build server filter conditions for dynamic queries
      const buildSessionConditions = (since: Date) => {
        const conditions = [gte(sessions.startedAt, since)];

        if (serverId) {
          // Specific server requested
          conditions.push(eq(sessions.serverId, serverId));
        } else if (authUser.role !== 'owner') {
          // Non-owner needs server access filter
          const serverCondition = buildServerAccessCondition(authUser, sessions.serverId);
          if (serverCondition) {
            conditions.push(serverCondition);
          }
        }

        return conditions;
      };

      // Build server filter SQL for violations (via serverUsers join)
      const buildViolationServerFilter = () => {
        if (serverId) {
          return sql`AND su.server_id = ${serverId}`;
        }
        if (authUser.role !== 'owner') {
          if (authUser.serverIds.length === 0) {
            return sql`AND false`;
          } else if (authUser.serverIds.length === 1) {
            return sql`AND su.server_id = ${authUser.serverIds[0]}`;
          } else {
            const serverIdList = authUser.serverIds.map((id: string) => sql`${id}`);
            return sql`AND su.server_id IN (${sql.join(serverIdList, sql`, `)})`;
          }
        }
        return sql``;
      };

      // Execute dynamic queries in parallel
      const [todayPlaysResult, watchTimeResult, alertsResult, activeUsersResult] =
        await Promise.all([
          // Plays count
          db
            .select({
              count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
            })
            .from(sessions)
            .where(and(...buildSessionConditions(todayStart))),

          // Watch time
          db
            .select({
              totalMs: sql<number>`COALESCE(SUM(duration_ms), 0)::bigint`,
            })
            .from(sessions)
            .where(and(...buildSessionConditions(todayStart))),

          // Violations count (join through serverUsers for server filtering)
          db
            .execute(
              sql`
            SELECT count(*)::int as count
            FROM violations v
            INNER JOIN server_users su ON su.id = v.server_user_id
            WHERE v.created_at >= ${last24h}
            ${buildViolationServerFilter()}
          `
            )
            .then((r) => [{ count: (r.rows[0] as { count: number })?.count ?? 0 }]),

          // Unique users
          db
            .select({
              count: sql<number>`count(DISTINCT server_user_id)::int`,
            })
            .from(sessions)
            .where(and(...buildSessionConditions(todayStart))),
        ]);

      todayPlays = todayPlaysResult[0]?.count ?? 0;
      watchTimeHours =
        Math.round((Number(watchTimeResult[0]?.totalMs ?? 0) / (1000 * 60 * 60)) * 10) / 10;
      alertsLast24h = alertsResult[0]?.count ?? 0;
      activeUsersToday = activeUsersResult[0]?.count ?? 0;
    }

    const stats: DashboardStats = {
      activeStreams,
      todayPlays,
      watchTimeHours,
      alertsLast24h,
      activeUsersToday,
    };

    // Cache for 60 seconds
    await app.redis.setex(cacheKey, 60, JSON.stringify(stats));

    return stats;
  });
};
