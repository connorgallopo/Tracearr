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
import type { BandwidthSummaryServerKpis } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { getTimescaleStatus } from '../../db/timescale.js';
import '../../db/schema.js';
import { resolveDateRange } from './utils.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { scopedServerFragment } from '../../lib/scope.js';
import { representativeAccountOrderSql } from '../../utils/representativeAccount.js';

// Extended schema with optional serverUserId filter
const bandwidthQuerySchema = statsQuerySchema.safeExtend({
  serverUserId: z.uuid().optional(),
});

/**
 * Check if the daily_bandwidth_by_user aggregate exists
 */
async function hasBandwidthAggregate(): Promise<boolean> {
  try {
    return (await getTimescaleStatus()).continuousAggregates.includes('daily_bandwidth_by_user');
  } catch {
    return false;
  }
}

export const bandwidthRoutes: FastifyPluginAsync = async (app) => {
  const readStats = { preHandler: [app.requirePermission('bandwidth', 'read')] };
  /**
   * GET /bandwidth/daily - Daily bandwidth usage over time
   *
   * Uses the daily_bandwidth_by_user continuous aggregate when available,
   * falls back to raw session queries otherwise.
   *
   * Groups by (date_bucket, server_id) so each row carries a serverId discriminator.
   * Single-server requests return one row per bucket; multi-server returns one per server per bucket.
   */
  app.get('/bandwidth/daily', readStats, async (request, reply) => {
    const query = bandwidthQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds, serverUserId, timezone } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);
    const tz = timezone ?? 'UTC';

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = scopedServerFragment(resolvedIds, request.scope);
    const userFilter = serverUserId ? sql`AND server_user_id = ${serverUserId}` : sql``;
    const useAggregate = await hasBandwidthAggregate();

    let result;

    if (useAggregate) {
      // Use the continuous aggregate - group by (day, server_id) for per-series rows
      const baseWhere = dateRange.start ? sql`WHERE day >= ${dateRange.start}` : sql`WHERE true`;

      result = await db.execute(sql`
        SELECT
          (day AT TIME ZONE ${tz})::date::text AS date,
          server_id,
          SUM(session_count)::int AS sessions,
          -- Weighted avg bitrate per (date, server): sum(avg_bitrate * sessions) / sum(sessions)
          (SUM(avg_bitrate * session_count) / NULLIF(SUM(session_count), 0))::bigint AS avg_bitrate,
          -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
          (SUM(total_bits_ms) / 8)::bigint AS total_bytes,
          MAX(peak_bitrate)::bigint AS peak_bitrate,
          SUM(total_duration_ms)::bigint AS total_duration_ms
        FROM daily_bandwidth_by_user
        ${baseWhere}
        ${period === 'custom' ? sql`AND day < ${dateRange.end}` : sql``}
        ${serverFilter}
        ${userFilter}
        GROUP BY day, server_id
        ORDER BY day, server_id
      `);
    } else {
      // Fallback to raw sessions - group by (date_trunc, server_id)
      const baseWhere = dateRange.start
        ? sql`WHERE started_at >= ${dateRange.start}`
        : sql`WHERE true`;

      result = await db.execute(sql`
        SELECT
          (DATE_TRUNC('day', started_at AT TIME ZONE ${tz}))::date::text AS date,
          server_id,
          COUNT(*)::int AS sessions,
          -- Weighted avg bitrate per (date, server): sum(bitrate) / session count, same
          -- shape as the aggregate branch above so summary and chart never disagree.
          (SUM(COALESCE(bitrate, 0)::bigint) / NULLIF(COUNT(*), 0))::bigint AS avg_bitrate,
          -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
          (SUM(COALESCE(bitrate, 0)::bigint * COALESCE(duration_ms, 0)::bigint) / 8)::bigint AS total_bytes,
          MAX(COALESCE(bitrate, 0))::bigint AS peak_bitrate,
          SUM(COALESCE(duration_ms, 0))::bigint AS total_duration_ms
        FROM sessions
        ${baseWhere}
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        ${userFilter}
        GROUP BY DATE_TRUNC('day', started_at AT TIME ZONE ${tz}), server_id
        ORDER BY date, server_id
      `);
    }

    const rows = result.rows as {
      date: string;
      server_id: string;
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
          serverId: r.server_id,
          sessions: r.sessions,
          totalBytes,
          totalGb: Math.round((totalBytes / 1e9) * 100) / 100,
          avgBitrate: Number(r.avg_bitrate ?? 0),
          peakBitrate: Number(r.peak_bitrate ?? 0),
          totalDurationMs: Number(r.total_duration_ms ?? 0),
          avgBitrateMbps: Math.round((Number(r.avg_bitrate ?? 0) / 1000) * 100) / 100,
          totalHours: Math.round((Number(r.total_duration_ms ?? 0) / 3600000) * 10) / 10,
        };
      }),
      usingAggregate: useAggregate,
    };
  });

  /**
   * GET /bandwidth/top-users - Top bandwidth consumers
   *
   * Returns identities ranked by total bandwidth consumption across selected
   * servers. A merged person is one row: bytes/sessions summed across every
   * account they have on the resolved servers, with a representative account
   * (deterministic tiebreak) carrying the serverId/serverUserId for the row.
   */
  app.get('/bandwidth/top-users', readStats, async (request, reply) => {
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
    const useAggregate = await hasBandwidthAggregate();

    let result;

    if (useAggregate) {
      const serverFilter = scopedServerFragment(
        resolvedIds,
        request.scope,
        'dbu.server_id',
        sql`dbu.server_user_id`
      );
      const serverFilterSu2 = buildMultiServerFragment(resolvedIds, 'su2.server_id');
      const baseWhere = dateRange.start
        ? sql`WHERE dbu.day >= ${dateRange.start}`
        : sql`WHERE true`;

      result = await db.execute(sql`
        SELECT
          rep.username AS username,
          u.name AS identity_name,
          rep.thumb_url AS thumb_url,
          rep.id AS server_user_id,
          rep.server_id AS server_id,
          -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
          (SUM(dbu.total_bits_ms) / 8)::bigint AS total_bytes,
          SUM(dbu.session_count)::int AS sessions,
          (SUM(dbu.avg_bitrate * dbu.session_count) / NULLIF(SUM(dbu.session_count), 0))::bigint AS avg_bitrate,
          SUM(dbu.total_duration_ms)::bigint AS total_duration_ms
        FROM daily_bandwidth_by_user dbu
        JOIN server_users su ON dbu.server_user_id = su.id
        JOIN users u ON su.user_id = u.id
        INNER JOIN LATERAL (
          SELECT su2.id, su2.username, su2.thumb_url, su2.server_id
          FROM server_users su2
          WHERE su2.user_id = u.id ${serverFilterSu2}
          ORDER BY ${representativeAccountOrderSql('su2')}
          LIMIT 1
        ) rep ON true
        ${baseWhere}
        ${period === 'custom' ? sql`AND dbu.day < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY u.id, u.name, rep.id, rep.username, rep.thumb_url, rep.server_id
        ORDER BY total_bytes DESC
        LIMIT 10
      `);
    } else {
      const serverFilter = scopedServerFragment(
        resolvedIds,
        request.scope,
        's.server_id',
        sql`s.server_user_id`
      );
      const serverFilterSu2 = buildMultiServerFragment(resolvedIds, 'su2.server_id');
      const baseWhere = dateRange.start
        ? sql`WHERE s.started_at >= ${dateRange.start}`
        : sql`WHERE true`;

      result = await db.execute(sql`
        SELECT
          rep.username AS username,
          u.name AS identity_name,
          rep.thumb_url AS thumb_url,
          rep.id AS server_user_id,
          rep.server_id AS server_id,
          -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
          (SUM(COALESCE(s.bitrate, 0)::bigint * COALESCE(s.duration_ms, 0)::bigint) / 8)::bigint AS total_bytes,
          COUNT(*)::int AS sessions,
          (SUM(COALESCE(s.bitrate, 0)::bigint) / NULLIF(COUNT(*), 0))::bigint AS avg_bitrate,
          SUM(COALESCE(s.duration_ms, 0))::bigint AS total_duration_ms
        FROM sessions s
        JOIN server_users su ON s.server_user_id = su.id
        JOIN users u ON su.user_id = u.id
        INNER JOIN LATERAL (
          SELECT su2.id, su2.username, su2.thumb_url, su2.server_id
          FROM server_users su2
          WHERE su2.user_id = u.id ${serverFilterSu2}
          ORDER BY ${representativeAccountOrderSql('su2')}
          LIMIT 1
        ) rep ON true
        ${baseWhere}
        ${period === 'custom' ? sql`AND s.started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY u.id, u.name, rep.id, rep.username, rep.thumb_url, rep.server_id
        ORDER BY total_bytes DESC
        LIMIT 10
      `);
    }

    const rows = result.rows as {
      username: string;
      identity_name: string | null;
      thumb_url: string | null;
      server_user_id: string;
      server_id: string;
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
          serverId: r.server_id,
          totalBytes,
          totalGb: Math.round((totalBytes / 1e9) * 100) / 100,
          sessions: r.sessions,
          avgBitrate: Number(r.avg_bitrate ?? 0),
          totalDurationMs: Number(r.total_duration_ms ?? 0),
          avgBitrateMbps: Math.round((Number(r.avg_bitrate ?? 0) / 1000) * 100) / 100,
          totalHours: Math.round((Number(r.total_duration_ms ?? 0) / 3600000) * 10) / 10,
        };
      }),
    };
  });

  /**
   * GET /bandwidth/summary - Overall bandwidth summary
   *
   * Returns aggregate KPIs spanning all selected servers.
   * Also returns a byServer breakdown keyed by server ID when more than one server is in scope.
   */
  app.get('/bandwidth/summary', readStats, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = scopedServerFragment(
      resolvedIds,
      request.scope,
      's.server_id',
      sql`s.server_user_id`
    );

    const baseWhere = dateRange.start
      ? sql`WHERE s.started_at >= ${dateRange.start}`
      : sql`WHERE true`;

    // Aggregate KPIs across all selected servers. unique_users is counted by
    // identity (server_users.user_id), not by account, so a person merged
    // across two selected servers counts once.
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total_sessions,
        -- Calculate actual data transferred in bytes: kbps * ms / 8 = bytes
        (SUM(COALESCE(s.bitrate, 0)::bigint * COALESCE(s.duration_ms, 0)::bigint) / 8)::bigint AS total_bytes,
        -- Session-weighted: sum(bitrate) / session count, matching the daily chart and
        -- top-users formula so this KPI never disagrees with the chart it summarizes.
        (SUM(COALESCE(s.bitrate, 0)::bigint) / NULLIF(COUNT(*), 0))::bigint AS avg_bitrate,
        MAX(COALESCE(s.bitrate, 0))::bigint AS peak_bitrate,
        MIN(COALESCE(s.bitrate, 0)) FILTER (WHERE s.bitrate > 0)::bigint AS min_bitrate,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(s.bitrate, 0))::bigint AS median_bitrate,
        SUM(COALESCE(s.duration_ms, 0))::bigint AS total_duration_ms,
        COUNT(DISTINCT su.user_id)::int AS unique_users
      FROM sessions s
      JOIN server_users su ON su.id = s.server_user_id
      ${baseWhere}
      ${period === 'custom' ? sql`AND s.started_at < ${dateRange.end}` : sql``}
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

    // Compute per-server KPI breakdown - one pass with GROUP BY server_id.
    // unique_users here is legitimately account-scoped per single server: a
    // same-server duplicate is already collapsed into one server_users row
    // by merge, so COUNT(DISTINCT server_user_id) equals distinct identities.
    const perServerResult = await db.execute(sql`
      SELECT
        s.server_id,
        COUNT(*)::int AS total_sessions,
        (SUM(COALESCE(s.bitrate, 0)::bigint * COALESCE(s.duration_ms, 0)::bigint) / 8)::bigint AS total_bytes,
        (SUM(COALESCE(s.bitrate, 0)::bigint) / NULLIF(COUNT(*), 0))::bigint AS avg_bitrate,
        MAX(COALESCE(s.bitrate, 0))::bigint AS peak_bitrate,
        MIN(COALESCE(s.bitrate, 0)) FILTER (WHERE s.bitrate > 0)::bigint AS min_bitrate,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY COALESCE(s.bitrate, 0))::bigint AS median_bitrate,
        SUM(COALESCE(s.duration_ms, 0))::bigint AS total_duration_ms,
        COUNT(DISTINCT s.server_user_id)::int AS unique_users
      FROM sessions s
      ${baseWhere}
      ${period === 'custom' ? sql`AND s.started_at < ${dateRange.end}` : sql``}
      ${serverFilter}
      GROUP BY s.server_id
    `);

    const byServer: Record<string, BandwidthSummaryServerKpis> = {};
    for (const r of perServerResult.rows as {
      server_id: string;
      total_sessions: number;
      total_bytes: string | null;
      avg_bitrate: string | null;
      peak_bitrate: string | null;
      min_bitrate: string | null;
      median_bitrate: string | null;
      total_duration_ms: string | null;
      unique_users: number;
    }[]) {
      const tb = Number(r.total_bytes ?? 0);
      byServer[r.server_id] = {
        totalSessions: r.total_sessions,
        totalBytes: tb,
        totalGb: Math.round((tb / 1e9) * 100) / 100,
        avgBitrate: Number(r.avg_bitrate ?? 0),
        peakBitrate: Number(r.peak_bitrate ?? 0),
        minBitrate: Number(r.min_bitrate ?? 0),
        medianBitrate: Number(r.median_bitrate ?? 0),
        totalDurationMs: Number(r.total_duration_ms ?? 0),
        uniqueUsers: r.unique_users,
        avgBitrateMbps: Math.round((Number(r.avg_bitrate ?? 0) / 1000) * 100) / 100,
        peakBitrateMbps: Math.round((Number(r.peak_bitrate ?? 0) / 1000) * 100) / 100,
        totalHours: Math.round((Number(r.total_duration_ms ?? 0) / 3600000) * 10) / 10,
      };
    }

    return {
      totalSessions: row.total_sessions,
      totalBytes,
      totalGb: Math.round((totalBytes / 1e9) * 100) / 100,
      avgBitrate: Number(row.avg_bitrate ?? 0),
      peakBitrate: Number(row.peak_bitrate ?? 0),
      minBitrate: Number(row.min_bitrate ?? 0),
      medianBitrate: Number(row.median_bitrate ?? 0),
      totalDurationMs: Number(row.total_duration_ms ?? 0),
      uniqueUsers: row.unique_users,
      avgBitrateMbps: Math.round((Number(row.avg_bitrate ?? 0) / 1000) * 100) / 100,
      peakBitrateMbps: Math.round((Number(row.peak_bitrate ?? 0) / 1000) * 100) / 100,
      totalHours: Math.round((Number(row.total_duration_ms ?? 0) / 3600000) * 10) / 10,
      byServer,
    };
  });
};
