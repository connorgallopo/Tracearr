/**
 * Quality and Performance Statistics Routes
 *
 * GET /quality - Transcode vs direct play breakdown
 * GET /platforms - Plays by platform
 * GET /watch-time - Total watch time breakdown
 * GET /concurrent - Concurrent stream history
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import '../../db/schema.js';
import { resolveDateRange } from './utils.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';

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

export const qualityRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /quality - Transcode vs direct play breakdown
   */
  app.get('/quality', { preHandler: [app.authenticate] }, async (request, reply) => {
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
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;

    const result = await db.execute(sql`
        SELECT
          is_transcode,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        ${baseWhere}
        ${MEDIA_TYPE_SQL_FILTER}
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY is_transcode
      `);

    const qualityStats = result.rows as { is_transcode: boolean | null; count: number }[];

    const directPlay = qualityStats.find((q) => !q.is_transcode)?.count ?? 0;
    const transcode = qualityStats.find((q) => q.is_transcode)?.count ?? 0;
    const total = directPlay + transcode;

    return {
      directPlay,
      transcode,
      total,
      directPlayPercent: total > 0 ? Math.round((directPlay / total) * 100) : 0,
      transcodePercent: total > 0 ? Math.round((transcode / total) * 100) : 0,
    };
  });

  /**
   * GET /platforms - Plays by platform
   */
  app.get('/platforms', { preHandler: [app.authenticate] }, async (request, reply) => {
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
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;

    const result = await db.execute(sql`
        SELECT
          platform,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        ${baseWhere}
        ${MEDIA_TYPE_SQL_FILTER}
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY platform
        ORDER BY count DESC
      `);

    return { data: result.rows as { platform: string | null; count: number }[] };
  });

  /**
   * GET /watch-time - Total watch time breakdown
   * Note: Total is filtered to movies/episodes, but byType shows breakdown of ALL types
   */
  app.get('/watch-time', { preHandler: [app.authenticate] }, async (request, reply) => {
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
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;
    const customEndFilter = period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``;

    const [totalResult, byTypeResult] = await Promise.all([
      // Total filtered to movies/episodes only
      db.execute(sql`
          SELECT COALESCE(SUM(duration_ms), 0)::bigint as total_ms
          FROM sessions
          ${baseWhere}
          ${MEDIA_TYPE_SQL_FILTER}
          ${customEndFilter}
          ${serverFilter}
        `),
      // By type shows ALL media types for breakdown comparison
      db.execute(sql`
          SELECT
            media_type,
            COALESCE(SUM(duration_ms), 0)::bigint as total_ms
          FROM sessions
          ${baseWhere}
          ${customEndFilter}
          ${serverFilter}
          GROUP BY media_type
        `),
    ]);

    const totalMs = (totalResult.rows[0] as { total_ms: string })?.total_ms ?? '0';
    const byType = byTypeResult.rows as { media_type: string | null; total_ms: string }[];

    return {
      totalHours: Math.round((Number(totalMs) / (1000 * 60 * 60)) * 10) / 10,
      byType: byType.map((t) => ({
        mediaType: t.media_type,
        hours: Math.round((Number(t.total_ms) / (1000 * 60 * 60)) * 10) / 10,
      })),
    };
  });

  /**
   * GET /concurrent - Peak concurrent streams per hour with direct/transcode breakdown
   *
   * Calculates TRUE peak concurrent: the maximum number of sessions running
   * simultaneously at any moment within each hour.
   *
   * Algorithm:
   * 1. Create "initial state" events for sessions already running at startDate
   * 2. Create events for session starts (+1) and stops (-1) within the window
   * 3. Use window function to calculate running count at each event
   * 4. Group by hour and take MAX for peak concurrent
   */
  app.get('/concurrent', { preHandler: [app.authenticate] }, async (request, reply) => {
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

    // For all-time, we use epoch as start; otherwise use the resolved date
    const queryStartDate = dateRange.start ?? new Date(0);
    const customEndFilter = period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``;
    const customStopEndFilter =
      period === 'custom' ? sql`AND stopped_at < ${dateRange.end}` : sql``;

    // Event-based calculation with proper boundary handling
    // Uses TimescaleDB-optimized time-based filtering on hypertable
    // Convert to user's timezone before truncating to hour for grouping
    // Excludes live TV and music tracks from concurrent stream calculations
    const result = await db.execute(sql`
        WITH events AS (
          -- Sessions already running at startDate (started before, not yet stopped)
          -- These need a +1 event at startDate to establish initial state
          SELECT
            ${queryStartDate}::timestamp AS event_time,
            1 AS delta,
            CASE WHEN is_transcode THEN 0 ELSE 1 END AS direct_delta,
            CASE WHEN is_transcode THEN 1 ELSE 0 END AS transcode_delta
          FROM sessions
          WHERE started_at < ${queryStartDate}
            AND (stopped_at IS NULL OR stopped_at >= ${queryStartDate})
            ${MEDIA_TYPE_SQL_FILTER}
            ${serverFilter}

          UNION ALL

          -- Session start events within the window
          SELECT
            started_at AS event_time,
            1 AS delta,
            CASE WHEN is_transcode THEN 0 ELSE 1 END AS direct_delta,
            CASE WHEN is_transcode THEN 1 ELSE 0 END AS transcode_delta
          FROM sessions
          WHERE started_at >= ${queryStartDate}
            ${MEDIA_TYPE_SQL_FILTER}
            ${customEndFilter}
            ${serverFilter}

          UNION ALL

          -- Session stop events within the window
          SELECT
            stopped_at AS event_time,
            -1 AS delta,
            CASE WHEN is_transcode THEN 0 ELSE -1 END AS direct_delta,
            CASE WHEN is_transcode THEN -1 ELSE 0 END AS transcode_delta
          FROM sessions
          WHERE stopped_at IS NOT NULL
            AND stopped_at >= ${queryStartDate}
            ${MEDIA_TYPE_SQL_FILTER}
            ${customStopEndFilter}
            ${serverFilter}
        ),
        running_counts AS (
          -- Running sum gives concurrent count at each event point
          SELECT
            event_time,
            SUM(delta) OVER w AS concurrent,
            SUM(direct_delta) OVER w AS direct_concurrent,
            SUM(transcode_delta) OVER w AS transcode_concurrent
          FROM events
          WHERE event_time IS NOT NULL
          WINDOW w AS (ORDER BY event_time ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
        )
        SELECT
          date_trunc('hour', event_time AT TIME ZONE ${tz})::text AS hour,
          COALESCE(MAX(concurrent), 0)::int AS total,
          COALESCE(MAX(direct_concurrent), 0)::int AS direct,
          COALESCE(MAX(transcode_concurrent), 0)::int AS transcode
        FROM running_counts
        GROUP BY 1
        ORDER BY 1
      `);

    const hourlyData = (
      result.rows as {
        hour: string;
        total: number;
        direct: number;
        transcode: number;
      }[]
    ).map((r) => ({
      hour: r.hour,
      total: r.total,
      direct: r.direct,
      transcode: r.transcode,
    }));

    return { data: hourlyData };
  });
};
