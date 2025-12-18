/**
 * Play Statistics Routes
 *
 * GET /plays - Plays over time
 * GET /plays-by-dayofweek - Plays grouped by day of week
 * GET /plays-by-hourofday - Plays grouped by hour of day
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

export const playsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /plays - Plays over time
   */
  app.get('/plays', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, timezone } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);
    // Default to UTC for backwards compatibility
    const tz = timezone ?? 'UTC';

    // Validate server access if specific server requested
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    const serverFilter = buildServerFilterSql(serverId, authUser);

    // For all-time queries, we need a base WHERE clause
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;

    // Convert to user's timezone before truncating to day
    const result = await db.execute(sql`
        SELECT
          date_trunc('day', started_at AT TIME ZONE ${tz})::date::text as date,
          count(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        ${baseWhere}
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY date_trunc('day', started_at AT TIME ZONE ${tz})
        ORDER BY date_trunc('day', started_at AT TIME ZONE ${tz})
      `);

    return { data: result.rows as { date: string; count: number }[] };
  });

  /**
   * GET /plays-by-dayofweek - Plays grouped by day of week
   */
  app.get('/plays-by-dayofweek', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, timezone } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);
    // Default to UTC for backwards compatibility
    const tz = timezone ?? 'UTC';

    // Validate server access if specific server requested
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const serverFilter = buildServerFilterSql(serverId, authUser);

    // For all-time queries, we need a base WHERE clause
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;

    // Convert to user's timezone before extracting day of week
    const result = await db.execute(sql`
        SELECT
          EXTRACT(DOW FROM started_at AT TIME ZONE ${tz})::int as day,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        ${baseWhere}
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY EXTRACT(DOW FROM started_at AT TIME ZONE ${tz})
        ORDER BY day
      `);

    const dayStats = result.rows as { day: number; count: number }[];

    // Ensure all 7 days are present (fill missing with 0)
    const dayMap = new Map(dayStats.map((d) => [d.day, d.count]));
    const data = Array.from({ length: 7 }, (_, i) => ({
      day: i,
      name: DAY_NAMES[i],
      count: dayMap.get(i) ?? 0,
    }));

    return { data };
  });

  /**
   * GET /plays-by-hourofday - Plays grouped by hour of day
   */
  app.get('/plays-by-hourofday', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, timezone } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);
    // Default to UTC for backwards compatibility
    const tz = timezone ?? 'UTC';

    // Validate server access if specific server requested
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    const serverFilter = buildServerFilterSql(serverId, authUser);

    // For all-time queries, we need a base WHERE clause
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;

    // Convert to user's timezone before extracting hour
    const result = await db.execute(sql`
        SELECT
          EXTRACT(HOUR FROM started_at AT TIME ZONE ${tz})::int as hour,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        ${baseWhere}
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY EXTRACT(HOUR FROM started_at AT TIME ZONE ${tz})
        ORDER BY hour
      `);

    const hourStats = result.rows as { hour: number; count: number }[];

    // Ensure all 24 hours are present (fill missing with 0)
    const hourMap = new Map(hourStats.map((h) => [h.hour, h.count]));
    const data = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      count: hourMap.get(i) ?? 0,
    }));

    return { data };
  });
};
