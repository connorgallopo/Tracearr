/**
 * Play Statistics Routes
 *
 * GET /plays - Plays over time (engagement-based, >= 2 min sessions)
 * GET /plays-by-dayofweek - Plays grouped by day of week
 * GET /plays-by-hourofday - Plays grouped by hour of day
 *
 * All endpoints use engagement-based counting which filters out
 * sessions shorter than 2 minutes (Netflix-style "intent" threshold).
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveDateRange } from './utils.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';

// UUID validation regex for defensive checks (used by commented buildEngagementServerFilter)
// const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Minimum session duration for a "valid" play (2 minutes in milliseconds)
const MIN_PLAY_DURATION_MS = 120000;

// NOTE: Kept for potential future use with daily_content_engagement view queries
// Currently unused since plays-by-dayofweek now queries sessions table directly
// for proper timezone handling.
// function buildEngagementServerFilter(
//   serverId: string | undefined,
//   authUser: { role: string; serverIds: string[] }
// ): ReturnType<typeof sql> {
//   if (serverId) {
//     if (!UUID_REGEX.test(serverId)) {
//       return sql`AND false`;
//     }
//     return sql`AND server_id = ${serverId}::uuid`;
//   }
//   if (authUser.role !== 'owner') {
//     const validServerIds = authUser.serverIds.filter((id) => UUID_REGEX.test(id));
//     if (validServerIds.length === 0) {
//       return sql`AND false`;
//     } else if (validServerIds.length === 1) {
//       return sql`AND server_id = ${validServerIds[0]}::uuid`;
//     } else {
//       const serverIdList = validServerIds.map((id) => sql`${id}::uuid`);
//       return sql`AND server_id IN (${sql.join(serverIdList, sql`, `)})`;
//     }
//   }
//   return sql``;
// }

/**
 * Build SQL server filter fragment for sessions table queries.
 */
function buildSessionServerFilter(
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
   * GET /plays - Plays over time (engagement-based)
   *
   * Returns validated plays (sessions >= 2 min) grouped by day.
   * Uses timezone-aware day bucketing so plays are grouped by user's local day.
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

    const serverFilter = buildSessionServerFilter(serverId, authUser);

    // Query sessions table directly with timezone-aware day bucketing
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start} AND duration_ms >= ${MIN_PLAY_DURATION_MS}`
      : sql`WHERE duration_ms >= ${MIN_PLAY_DURATION_MS}`;

    const endDateWhere =
      period === 'custom' && dateRange.end ? sql`AND started_at < ${dateRange.end}` : sql``;

    const result = await db.execute(sql`
        SELECT
          (started_at AT TIME ZONE ${tz})::date::text as date,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        ${baseWhere}
        ${MEDIA_TYPE_SQL_FILTER}
        ${endDateWhere}
        ${serverFilter}
        GROUP BY 1
        ORDER BY 1
      `);

    return { data: result.rows as { date: string; count: number }[] };
  });

  /**
   * GET /plays-by-dayofweek - Plays grouped by day of week (engagement-based)
   *
   * Returns validated plays (sessions >= 2 min) grouped by day of week.
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
    const serverFilter = buildSessionServerFilter(serverId, authUser);

    // Build base WHERE with duration filter for validated plays
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start} AND duration_ms >= ${MIN_PLAY_DURATION_MS}`
      : sql`WHERE duration_ms >= ${MIN_PLAY_DURATION_MS}`;

    // Extract DOW from started_at in user's timezone for correct day bucketing
    const result = await db.execute(sql`
        SELECT
          EXTRACT(DOW FROM started_at AT TIME ZONE ${tz})::int as day,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        ${baseWhere}
        ${MEDIA_TYPE_SQL_FILTER}
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY 1
        ORDER BY 1
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
   * GET /plays-by-hourofday - Plays grouped by hour of day (engagement-based)
   *
   * Returns validated plays (sessions >= 2 min) grouped by hour of day.
   * Queries sessions table directly with duration filter since engagement
   * view only has daily granularity.
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

    const serverFilter = buildSessionServerFilter(serverId, authUser);

    // For all-time queries, we need a base WHERE clause
    // Include duration filter for engagement-based counting
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start} AND duration_ms >= ${MIN_PLAY_DURATION_MS}`
      : sql`WHERE duration_ms >= ${MIN_PLAY_DURATION_MS}`;

    // Convert to user's timezone before extracting hour
    const result = await db.execute(sql`
        SELECT
          EXTRACT(HOUR FROM started_at AT TIME ZONE ${tz})::int as hour,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        ${baseWhere}
        ${MEDIA_TYPE_SQL_FILTER}
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY 1
        ORDER BY 1
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
