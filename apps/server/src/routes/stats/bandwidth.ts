/**
 * Bandwidth Statistics Routes
 *
 * GET /bandwidth/daily - Daily bandwidth usage over time
 * GET /bandwidth/top-users - Top bandwidth consumers
 * GET /bandwidth/summary - Overall bandwidth summary
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import '../../db/schema.js';
import { resolveDateRange } from './utils.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';

// Extended schema with optional serverUserId filter
const bandwidthQuerySchema = statsQuerySchema.safeExtend({
  serverUserId: z.uuid().optional(),
});

/**
 * Build SQL server filter fragment for raw queries
 * @param tableAlias - Table alias to prefix server_id (e.g., 'dbu', 's') for JOINed queries
 */
function buildServerFilterSql(
  serverId: string | undefined,
  authUser: { role: string; serverIds: string[] },
  tableAlias?: string
): ReturnType<typeof sql> {
  const col = tableAlias ? sql.raw(`${tableAlias}.server_id`) : sql.raw('server_id');
  if (serverId) {
    return sql`AND ${col} = ${serverId}`;
  }
  if (authUser.role !== 'owner') {
    if (authUser.serverIds.length === 0) {
      return sql`AND false`;
    } else if (authUser.serverIds.length === 1) {
      return sql`AND ${col} = ${authUser.serverIds[0]}`;
    } else {
      const serverIdList = authUser.serverIds.map((id) => sql`${id}`);
      return sql`AND ${col} IN (${sql.join(serverIdList, sql`, `)})`;
    }
  }
  return sql``;
}

/**
 * Check if the daily_bandwidth_by_user aggregate exists
 */
async function hasBandwidthAggregate(): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM timescaledb_information.continuous_aggregates
        WHERE view_name = 'daily_bandwidth_by_user'
      ) as exists
    `);
    return (result.rows[0] as { exists: boolean })?.exists ?? false;
  } catch {
    return false;
  }
}

export const bandwidthRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /bandwidth/daily - Daily bandwidth usage over time
   *
   * Uses the daily_bandwidth_by_user continuous aggregate when available,
   * falls back to raw session queries otherwise.
   */
  app.get('/bandwidth/daily', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = bandwidthQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverUserId, timezone } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);
    const tz = timezone ?? 'UTC';

    // Validate server access if specific server requested
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    const serverFilter = buildServerFilterSql(serverId, authUser);
    const userFilter = serverUserId ? sql`AND server_user_id = ${serverUserId}` : sql``;
    const useAggregate = await hasBandwidthAggregate();

    let result;

    if (useAggregate) {
      // Use the continuous aggregate
      const baseWhere = dateRange.start ? sql`WHERE day >= ${dateRange.start}` : sql`WHERE true`;

      result = await db.execute(sql`
        SELECT
          (day AT TIME ZONE ${tz})::date::text AS date,
          SUM(session_count)::int AS sessions,
          -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
          -- (bitrate is stored in kbps, duration in ms, so kbps * ms / 1000 = kb, / 8 = bytes)
          (SUM(total_bits_ms) / 8)::bigint AS total_bytes,
          (SUM(avg_bitrate * session_count) / NULLIF(SUM(session_count), 0))::bigint AS avg_bitrate,
          MAX(peak_bitrate)::bigint AS peak_bitrate,
          SUM(total_duration_ms)::bigint AS total_duration_ms
        FROM daily_bandwidth_by_user
        ${baseWhere}
        ${period === 'custom' ? sql`AND day < ${dateRange.end}` : sql``}
        ${serverFilter}
        ${userFilter}
        GROUP BY day
        ORDER BY day
      `);
    } else {
      // Fallback to raw sessions query
      const baseWhere = dateRange.start
        ? sql`WHERE started_at >= ${dateRange.start}`
        : sql`WHERE true`;

      result = await db.execute(sql`
        SELECT
          (DATE_TRUNC('day', started_at AT TIME ZONE ${tz}))::date::text AS date,
          COUNT(*)::int AS sessions,
          -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
          (SUM(COALESCE(bitrate, 0)::bigint * COALESCE(duration_ms, 0)::bigint) / 8)::bigint AS total_bytes,
          AVG(COALESCE(bitrate, 0))::bigint AS avg_bitrate,
          MAX(COALESCE(bitrate, 0))::bigint AS peak_bitrate,
          SUM(COALESCE(duration_ms, 0))::bigint AS total_duration_ms
        FROM sessions
        ${baseWhere}
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        ${userFilter}
        GROUP BY DATE_TRUNC('day', started_at AT TIME ZONE ${tz})
        ORDER BY date
      `);
    }

    const rows = result.rows as {
      date: string;
      sessions: number;
      total_bytes: string | null;
      avg_bitrate: string | null;
      peak_bitrate: string | null;
      total_duration_ms: string | null;
    }[];

    return {
      data: rows.map((r) => {
        const totalBytes = Number(r.total_bytes ?? 0);
        return {
          date: r.date,
          sessions: r.sessions,
          // Total data transferred in bytes
          totalBytes,
          // Human-readable: total GB transferred
          totalGb: Math.round((totalBytes / 1e9) * 100) / 100,
          avgBitrate: Number(r.avg_bitrate ?? 0),
          peakBitrate: Number(r.peak_bitrate ?? 0),
          totalDurationMs: Number(r.total_duration_ms ?? 0),
          // Calculated field: average bitrate in Mbps (bitrate stored in kbps)
          avgBitrateMbps: Math.round((Number(r.avg_bitrate ?? 0) / 1000) * 100) / 100,
          // Calculated field: total hours watched
          totalHours: Math.round((Number(r.total_duration_ms ?? 0) / 3600000) * 10) / 10,
        };
      }),
      usingAggregate: useAggregate,
    };
  });

  /**
   * GET /bandwidth/top-users - Top bandwidth consumers
   *
   * Returns users ranked by total bandwidth consumption.
   */
  app.get('/bandwidth/top-users', { preHandler: [app.authenticate] }, async (request, reply) => {
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

    const useAggregate = await hasBandwidthAggregate();

    let result;

    if (useAggregate) {
      const serverFilter = buildServerFilterSql(serverId, authUser, 'dbu');
      const baseWhere = dateRange.start
        ? sql`WHERE dbu.day >= ${dateRange.start}`
        : sql`WHERE true`;

      result = await db.execute(sql`
        SELECT
          su.username AS username,
          u.name AS identity_name,
          su.thumb_url AS thumb_url,
          su.id AS server_user_id,
          -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
          (SUM(dbu.total_bits_ms) / 8)::bigint AS total_bytes,
          SUM(dbu.session_count)::int AS sessions,
          (SUM(dbu.avg_bitrate * dbu.session_count) / NULLIF(SUM(dbu.session_count), 0))::bigint AS avg_bitrate,
          SUM(dbu.total_duration_ms)::bigint AS total_duration_ms
        FROM daily_bandwidth_by_user dbu
        JOIN server_users su ON dbu.server_user_id = su.id
        LEFT JOIN users u ON su.user_id = u.id
        ${baseWhere}
        ${period === 'custom' ? sql`AND dbu.day < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY su.id, su.username, su.thumb_url, u.name
        ORDER BY total_bytes DESC
        LIMIT 10
      `);
    } else {
      const serverFilter = buildServerFilterSql(serverId, authUser, 's');
      const baseWhere = dateRange.start
        ? sql`WHERE s.started_at >= ${dateRange.start}`
        : sql`WHERE true`;

      result = await db.execute(sql`
        SELECT
          su.username AS username,
          u.name AS identity_name,
          su.thumb_url AS thumb_url,
          su.id AS server_user_id,
          -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
          (SUM(COALESCE(s.bitrate, 0)::bigint * COALESCE(s.duration_ms, 0)::bigint) / 8)::bigint AS total_bytes,
          COUNT(*)::int AS sessions,
          AVG(COALESCE(s.bitrate, 0))::bigint AS avg_bitrate,
          SUM(COALESCE(s.duration_ms, 0))::bigint AS total_duration_ms
        FROM sessions s
        JOIN server_users su ON s.server_user_id = su.id
        LEFT JOIN users u ON su.user_id = u.id
        ${baseWhere}
        ${period === 'custom' ? sql`AND s.started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY su.id, su.username, su.thumb_url, u.name
        ORDER BY total_bytes DESC
        LIMIT 10
      `);
    }

    const rows = result.rows as {
      username: string;
      identity_name: string | null;
      thumb_url: string | null;
      server_user_id: string;
      total_bytes: string | null;
      sessions: number;
      avg_bitrate: string | null;
      total_duration_ms: string | null;
    }[];

    return {
      data: rows.map((r) => {
        const totalBytes = Number(r.total_bytes ?? 0);
        return {
          username: r.username,
          identityName: r.identity_name,
          thumbUrl: r.thumb_url,
          serverUserId: r.server_user_id,
          // Total data transferred in bytes
          totalBytes,
          // Human-readable: total GB transferred
          totalGb: Math.round((totalBytes / 1e9) * 100) / 100,
          sessions: r.sessions,
          avgBitrate: Number(r.avg_bitrate ?? 0),
          totalDurationMs: Number(r.total_duration_ms ?? 0),
          // Calculated fields (bitrate stored in kbps)
          avgBitrateMbps: Math.round((Number(r.avg_bitrate ?? 0) / 1000) * 100) / 100,
          totalHours: Math.round((Number(r.total_duration_ms ?? 0) / 3600000) * 10) / 10,
        };
      }),
    };
  });

  /**
   * GET /bandwidth/summary - Overall bandwidth summary
   *
   * Returns aggregate bandwidth statistics for the time period.
   */
  app.get('/bandwidth/summary', { preHandler: [app.authenticate] }, async (request, reply) => {
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
        COUNT(*)::int AS total_sessions,
        -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
        (SUM(COALESCE(bitrate, 0)::bigint * COALESCE(duration_ms, 0)::bigint) / 8)::bigint AS total_bytes,
        AVG(COALESCE(bitrate, 0))::bigint AS avg_bitrate,
        MAX(COALESCE(bitrate, 0))::bigint AS peak_bitrate,
        MIN(COALESCE(bitrate, 0)) FILTER (WHERE bitrate > 0)::bigint AS min_bitrate,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(bitrate, 0))::bigint AS median_bitrate,
        SUM(COALESCE(duration_ms, 0))::bigint AS total_duration_ms,
        COUNT(DISTINCT server_user_id)::int AS unique_users
      FROM sessions
      ${baseWhere}
      ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
      ${serverFilter}
    `);

    const row = result.rows[0] as {
      total_sessions: number;
      total_bytes: string | null;
      avg_bitrate: string | null;
      peak_bitrate: string | null;
      min_bitrate: string | null;
      median_bitrate: string | null;
      total_duration_ms: string | null;
      unique_users: number;
    };

    const totalBytes = Number(row.total_bytes ?? 0);

    return {
      totalSessions: row.total_sessions,
      // Total data transferred in bytes
      totalBytes,
      // Human-readable: total GB transferred
      totalGb: Math.round((totalBytes / 1e9) * 100) / 100,
      avgBitrate: Number(row.avg_bitrate ?? 0),
      peakBitrate: Number(row.peak_bitrate ?? 0),
      minBitrate: Number(row.min_bitrate ?? 0),
      medianBitrate: Number(row.median_bitrate ?? 0),
      totalDurationMs: Number(row.total_duration_ms ?? 0),
      uniqueUsers: row.unique_users,
      // Calculated fields (bitrate stored in kbps)
      avgBitrateMbps: Math.round((Number(row.avg_bitrate ?? 0) / 1000) * 100) / 100,
      peakBitrateMbps: Math.round((Number(row.peak_bitrate ?? 0) / 1000) * 100) / 100,
      totalHours: Math.round((Number(row.total_duration_ms ?? 0) / 3600000) * 10) / 10,
    };
  });
};
