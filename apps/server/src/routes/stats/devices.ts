/**
 * Device Compatibility Statistics Routes
 *
 * GET /device-compatibility - Device vs codec direct play compatibility matrix
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { statsQuerySchema, type DeviceCompatibilityMatrix } from '@tracearr/shared';
import { db } from '../../db/client.js';
import '../../db/schema.js';
import { resolveDateRange } from './utils.js';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { scopedServerFragment } from '../../lib/scope.js';
import { compareNames } from '../../utils/collation.js';

// Extended schema with minSessions filter
const deviceCompatibilitySchema = statsQuerySchema.safeExtend({
  minSessions: z.coerce.number().int().min(1).default(5),
});

interface MatrixDeviceRow {
  device_type: string;
  video_codec: string;
  session_count: number;
  direct_count: number;
  direct_pct: number;
}

function buildDeviceMatrix(rows: MatrixDeviceRow[], codecs: string[]): DeviceCompatibilityMatrix {
  const deviceMap = new Map<
    string,
    { device: string; codecs: Record<string, { sessions: number; directPct: number }> }
  >();

  for (const row of rows) {
    const entry = deviceMap.getOrInsertComputed(row.device_type, (device) => ({
      device,
      codecs: {},
    }));
    entry.codecs[row.video_codec] = {
      sessions: row.session_count,
      directPct: row.direct_pct,
    };
  }

  return {
    codecs: codecs.toSorted(compareNames),
    devices: Array.from(deviceMap.values()).sort((a, b) => compareNames(a.device, b.device)),
  };
}

export const devicesRoutes: FastifyPluginAsync = async (app) => {
  const readStats = { preHandler: [app.requirePermission('devices', 'read')] };
  /**
   * GET /device-compatibility - Device vs codec direct play compatibility matrix
   *
   * Returns a matrix showing which device/platform types can direct play
   * each codec combination. Useful for identifying problematic device+codec
   * combinations that always transcode.
   *
   * Aggregates across all selected servers - no per-row serverId.
   */
  app.get('/device-compatibility', readStats, async (request, reply) => {
    const query = deviceCompatibilitySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds, minSessions } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = scopedServerFragment(resolvedIds, request.scope);

    // For all-time queries, we need a base WHERE clause
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;

    // Get the device-codec compatibility matrix
    const result = await db.execute(sql`
      WITH compatibility_data AS (
        SELECT
          COALESCE(platform, 'Unknown') AS device_type,
          COALESCE(source_video_codec, 'Unknown') AS video_codec,
          COALESCE(source_audio_codec, 'Unknown') AS audio_codec,
          video_decision,
          audio_decision,
          COUNT(*)::int AS session_count,
          COUNT(*) FILTER (WHERE video_decision != 'transcode')::int AS video_direct_count,
          COUNT(*) FILTER (WHERE audio_decision != 'transcode')::int AS audio_direct_count,
          COUNT(*) FILTER (WHERE video_decision != 'transcode' AND audio_decision != 'transcode')::int AS full_direct_count,
          COUNT(*) FILTER (WHERE video_decision = 'transcode' OR audio_decision = 'transcode')::int AS any_transcode_count
        FROM sessions
        ${baseWhere}
        AND source_video_codec IS NOT NULL
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY platform, source_video_codec, source_audio_codec, video_decision, audio_decision
        HAVING COUNT(*) >= ${minSessions}
      )
      SELECT
        device_type,
        video_codec,
        audio_codec,
        SUM(session_count)::int AS session_count,
        SUM(video_direct_count)::int AS video_direct_count,
        SUM(audio_direct_count)::int AS audio_direct_count,
        SUM(full_direct_count)::int AS full_direct_count,
        SUM(any_transcode_count)::int AS any_transcode_count,
        ROUND(100.0 * SUM(video_direct_count) / NULLIF(SUM(session_count), 0), 1) AS video_direct_pct,
        ROUND(100.0 * SUM(audio_direct_count) / NULLIF(SUM(session_count), 0), 1) AS audio_direct_pct,
        ROUND(100.0 * SUM(full_direct_count) / NULLIF(SUM(session_count), 0), 1) AS full_direct_pct
      FROM compatibility_data
      GROUP BY device_type, video_codec, audio_codec
      ORDER BY session_count DESC
    `);

    const rows = result.rows as {
      device_type: string;
      video_codec: string;
      audio_codec: string;
      session_count: number;
      video_direct_count: number;
      audio_direct_count: number;
      full_direct_count: number;
      any_transcode_count: number;
      video_direct_pct: number;
      audio_direct_pct: number;
      full_direct_pct: number;
    }[];

    // Calculate summary stats
    const totalSessions = rows.reduce((sum, r) => sum + r.session_count, 0);
    const totalDirectPlay = rows.reduce((sum, r) => sum + r.full_direct_count, 0);
    const uniqueDevices = new Set(rows.map((r) => r.device_type)).size;
    const uniqueCodecs = new Set(rows.map((r) => r.video_codec)).size;

    return {
      data: rows.map((r) => ({
        deviceType: r.device_type,
        videoCodec: r.video_codec,
        audioCodec: r.audio_codec,
        sessionCount: r.session_count,
        videoDirectCount: r.video_direct_count,
        audioDirectCount: r.audio_direct_count,
        fullDirectCount: r.full_direct_count,
        anyTranscodeCount: r.any_transcode_count,
        videoDirectPct: r.video_direct_pct,
        audioDirectPct: r.audio_direct_pct,
        fullDirectPct: r.full_direct_pct,
      })),
      summary: {
        totalSessions,
        directPlayPct: totalSessions > 0 ? Math.round((totalDirectPlay / totalSessions) * 100) : 0,
        uniqueDevices,
        uniqueCodecs,
      },
    };
  });

  /**
   * GET /device-compatibility/matrix - Simplified matrix view
   *
   * Returns a pivoted matrix where rows are devices and columns are video codecs.
   * Each cell shows the direct play percentage for that device+codec combination.
   *
   * A single `serverId` (or no server param) returns one matrix object, unchanged
   * from before. Passing `serverIds[]` batches all requested servers into one
   * query and returns them keyed by server id, so the frontend no longer needs
   * to fan out one request per selected server.
   */
  app.get('/device-compatibility/matrix', readStats, async (request, reply) => {
    const query = deviceCompatibilitySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds, minSessions } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);
    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;
    const dateFilter = period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``;

    if (serverIds) {
      const targetIds = resolvedIds ?? [];
      const serverFilter = scopedServerFragment(targetIds, request.scope);

      const codecsResult = await db.execute(sql`
          SELECT DISTINCT server_id, COALESCE(source_video_codec, 'Unknown') AS codec
          FROM sessions
          ${baseWhere}
          AND source_video_codec IS NOT NULL
          ${dateFilter}
          ${serverFilter}
          ORDER BY server_id, codec
        `);

      const codecsByServer = new Map<string, string[]>();
      for (const row of codecsResult.rows as { server_id: string; codec: string }[]) {
        const list = codecsByServer.get(row.server_id) ?? [];
        list.push(row.codec);
        codecsByServer.set(row.server_id, list);
      }

      const matrixResult = await db.execute(sql`
          SELECT
            server_id,
            COALESCE(platform, 'Unknown') AS device_type,
            COALESCE(source_video_codec, 'Unknown') AS video_codec,
            COUNT(*)::int AS session_count,
            COUNT(*) FILTER (WHERE video_decision != 'transcode')::int AS direct_count,
            ROUND(100.0 * COUNT(*) FILTER (WHERE video_decision != 'transcode') / NULLIF(COUNT(*), 0), 1) AS direct_pct
          FROM sessions
          ${baseWhere}
          AND source_video_codec IS NOT NULL
          ${dateFilter}
          ${serverFilter}
          GROUP BY server_id, platform, source_video_codec
          HAVING COUNT(*) >= ${minSessions}
          ORDER BY server_id, device_type, video_codec
        `);

      const rowsByServer = new Map<string, MatrixDeviceRow[]>();
      for (const row of matrixResult.rows as unknown as (MatrixDeviceRow & {
        server_id: string;
      })[]) {
        const list = rowsByServer.get(row.server_id) ?? [];
        list.push(row);
        rowsByServer.set(row.server_id, list);
      }

      const response: Record<string, DeviceCompatibilityMatrix> = {};
      for (const id of targetIds) {
        response[id] = buildDeviceMatrix(rowsByServer.get(id) ?? [], codecsByServer.get(id) ?? []);
      }

      return response;
    }

    // Single serverId or no server param: unchanged, one combined matrix.
    const serverFilter = scopedServerFragment(resolvedIds, request.scope);

    const codecsResult = await db.execute(sql`
        SELECT DISTINCT COALESCE(source_video_codec, 'Unknown') AS codec
        FROM sessions
        ${baseWhere}
        AND source_video_codec IS NOT NULL
        ${dateFilter}
        ${serverFilter}
        ORDER BY codec
      `);

    const codecs = (codecsResult.rows as { codec: string }[]).map((r) => r.codec);

    const matrixResult = await db.execute(sql`
        SELECT
          COALESCE(platform, 'Unknown') AS device_type,
          COALESCE(source_video_codec, 'Unknown') AS video_codec,
          COUNT(*)::int AS session_count,
          COUNT(*) FILTER (WHERE video_decision != 'transcode')::int AS direct_count,
          ROUND(100.0 * COUNT(*) FILTER (WHERE video_decision != 'transcode') / NULLIF(COUNT(*), 0), 1) AS direct_pct
        FROM sessions
        ${baseWhere}
        AND source_video_codec IS NOT NULL
        ${dateFilter}
        ${serverFilter}
        GROUP BY platform, source_video_codec
        HAVING COUNT(*) >= ${minSessions}
        ORDER BY device_type, video_codec
      `);

    const matrixRows = matrixResult.rows as unknown as MatrixDeviceRow[];

    return buildDeviceMatrix(matrixRows, codecs);
  });

  /**
   * GET /device-compatibility/health - Device health rankings
   *
   * Returns devices sorted by direct play rate, showing how "healthy" each device is.
   * Includes session counts for context.
   *
   * Combined across selected servers - each row includes serverId so the
   * frontend can render a Server column.
   */
  app.get('/device-compatibility/health', readStats, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = scopedServerFragment(resolvedIds, request.scope);
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;

    const result = await db.execute(sql`
        SELECT
          server_id,
          COALESCE(platform, 'Unknown') AS device,
          COUNT(*)::int AS sessions,
          COUNT(*) FILTER (WHERE video_decision != 'transcode')::int AS video_direct,
          COUNT(*) FILTER (WHERE audio_decision != 'transcode')::int AS audio_direct,
          COUNT(*) FILTER (WHERE video_decision != 'transcode' AND audio_decision != 'transcode')::int AS full_direct,
          COUNT(*) FILTER (WHERE video_decision = 'transcode' OR audio_decision = 'transcode')::int AS transcode_count,
          ROUND(100.0 * COUNT(*) FILTER (WHERE video_decision != 'transcode' AND audio_decision != 'transcode') / NULLIF(COUNT(*), 0), 1) AS direct_play_pct
        FROM sessions
        ${baseWhere}
        AND source_video_codec IS NOT NULL
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY server_id, platform
        ORDER BY direct_play_pct DESC
      `);

    const rows = result.rows as {
      server_id: string;
      device: string;
      sessions: number;
      video_direct: number;
      audio_direct: number;
      full_direct: number;
      transcode_count: number;
      direct_play_pct: number;
    }[];

    return {
      data: rows.map((r) => ({
        serverId: r.server_id,
        device: r.device,
        sessions: r.sessions,
        directPlayCount: r.full_direct,
        transcodeCount: r.transcode_count,
        directPlayPct: r.direct_play_pct,
      })),
    };
  });

  /**
   * GET /device-compatibility/hotspots - Transcode hotspots
   *
   * Returns the device+codec combinations causing the most transcodes.
   * Sorted by transcode count to show biggest impact first.
   *
   * Combined across selected servers - each row includes serverId so the
   * frontend can render a Server column.
   */
  app.get('/device-compatibility/hotspots', readStats, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = scopedServerFragment(resolvedIds, request.scope);
    const baseWhere = dateRange.start
      ? sql`WHERE started_at >= ${dateRange.start}`
      : sql`WHERE true`;

    const result = await db.execute(sql`
        SELECT
          server_id,
          COALESCE(platform, 'Unknown') AS device,
          COALESCE(source_video_codec, 'Unknown') AS video_codec,
          COALESCE(source_audio_codec, 'Unknown') AS audio_codec,
          COUNT(*)::int AS sessions,
          COUNT(*) FILTER (WHERE video_decision != 'transcode' AND audio_decision != 'transcode')::int AS direct_count,
          COUNT(*) FILTER (WHERE video_decision = 'transcode' OR audio_decision = 'transcode')::int AS transcode_count,
          ROUND(100.0 * COUNT(*) FILTER (WHERE video_decision != 'transcode' AND audio_decision != 'transcode') / NULLIF(COUNT(*), 0), 1) AS direct_play_pct
        FROM sessions
        ${baseWhere}
        AND source_video_codec IS NOT NULL
        ${period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY server_id, platform, source_video_codec, source_audio_codec
        HAVING COUNT(*) FILTER (WHERE video_decision = 'transcode' OR audio_decision = 'transcode') > 0
        ORDER BY transcode_count DESC
        LIMIT 10
      `);

    const rows = result.rows as {
      server_id: string;
      device: string;
      video_codec: string;
      audio_codec: string;
      sessions: number;
      direct_count: number;
      transcode_count: number;
      direct_play_pct: number;
    }[];

    // Calculate total transcodes for percentage
    const totalTranscodes = rows.reduce((sum, r) => sum + r.transcode_count, 0);

    return {
      data: rows.map((r) => ({
        serverId: r.server_id,
        device: r.device,
        videoCodec: r.video_codec,
        audioCodec: r.audio_codec,
        sessions: r.sessions,
        directCount: r.direct_count,
        transcodeCount: r.transcode_count,
        directPlayPct: r.direct_play_pct,
        pctOfTotalTranscodes:
          totalTranscodes > 0 ? Math.round((r.transcode_count / totalTranscodes) * 100) : 0,
      })),
      totalTranscodes,
    };
  });

  /**
   * GET /device-compatibility/top-transcoding-users - Users who transcode the most
   *
   * Returns users sorted by transcode count, showing who is putting the most
   * load on the server for transcoding.
   *
   * Combined across selected servers - each row includes serverId. The same
   * human on two servers legitimately yields two rows (serverUserId is server-scoped).
   */
  app.get('/device-compatibility/top-transcoding-users', readStats, async (request, reply) => {
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

    const result = await db.execute(sql`
        SELECT
          su.server_id,
          su.id AS server_user_id,
          COALESCE(su.username, 'Unknown') AS username,
          u.name AS identity_name,
          su.thumb_url AS avatar,
          COUNT(*)::int AS total_sessions,
          COUNT(*) FILTER (WHERE s.video_decision != 'transcode' AND s.audio_decision != 'transcode')::int AS direct_play_count,
          COUNT(*) FILTER (WHERE s.video_decision = 'transcode' OR s.audio_decision = 'transcode')::int AS transcode_count,
          ROUND(100.0 * COUNT(*) FILTER (WHERE s.video_decision != 'transcode' AND s.audio_decision != 'transcode') / NULLIF(COUNT(*), 0), 1) AS direct_play_pct
        FROM sessions s
        JOIN server_users su ON s.server_user_id = su.id
        LEFT JOIN users u ON su.user_id = u.id
        ${baseWhere}
        AND s.source_video_codec IS NOT NULL
        ${period === 'custom' ? sql`AND s.started_at < ${dateRange.end}` : sql``}
        ${serverFilter}
        GROUP BY su.server_id, su.id, su.username, su.thumb_url, u.name
        HAVING COUNT(*) FILTER (WHERE s.video_decision = 'transcode' OR s.audio_decision = 'transcode') > 0
        ORDER BY transcode_count DESC
        LIMIT 10
      `);

    const rows = result.rows as {
      server_id: string;
      server_user_id: string;
      username: string;
      identity_name: string | null;
      avatar: string | null;
      total_sessions: number;
      direct_play_count: number;
      transcode_count: number;
      direct_play_pct: number;
    }[];

    // Calculate total transcodes for percentage
    const totalTranscodes = rows.reduce((sum, r) => sum + r.transcode_count, 0);

    return {
      data: rows.map((r) => ({
        serverId: r.server_id,
        serverUserId: r.server_user_id,
        username: r.username,
        identityName: r.identity_name,
        avatar: r.avatar,
        totalSessions: r.total_sessions,
        directPlayCount: r.direct_play_count,
        transcodeCount: r.transcode_count,
        directPlayPct: r.direct_play_pct,
        pctOfTotalTranscodes:
          totalTranscodes > 0 ? Math.round((r.transcode_count / totalTranscodes) * 100) : 0,
      })),
      totalTranscodes,
    };
  });
};
