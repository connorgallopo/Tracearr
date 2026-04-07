/**
 * Public API Routes - External access for third-party integrations
 *
 * All routes require Bearer token authentication via Authorization header.
 * Token format: Authorization: Bearer trr_pub_<base64url>
 *
 * Endpoints:
 * - GET /docs - OpenAPI 3.0 specification (JSON)
 * - GET /health - System health and server connectivity
 * - GET /stats - Dashboard overview statistics
 * - GET /stats/today - Today's statistics with timezone support
 * - GET /activity - Playback activity trends and breakdowns
 * - GET /streams - Currently active playback sessions
 * - POST /streams/:id/terminate - Terminate an active stream
 * - GET /users - User list with activity summary
 * - GET /violations - Violations list with filtering
 * - GET /history - Session history with filtering
 */

import {
  booleanStringSchema,
  formatAudioChannels,
  formatBitrate,
  formatMediaTech,
  getResolutionLabel,
  isValidTimezone,
  sessionIdParamSchema,
  terminateSessionBodySchema,
  type SourceAudioDetails,
  type SourceVideoDetails,
  type StreamAudioDetails,
  type StreamVideoDetails,
  type SubtitleInfo,
  type TranscodeInfo,
} from '@tracearr/shared';
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PLAY_COUNT } from '../constants/index.js';
import { db } from '../db/client.js';
import { rules, serverUsers, servers, sessions, users, violations } from '../db/schema.js';
import { getCacheService } from '../services/cache.js';
import { getDashboardStats } from '../services/dashboardStats.js';
import { buildAvatarUrl, buildPosterUrl } from '../services/imageProxy.js';
import { terminateSession } from '../services/termination.js';
import { getCurrentVersion } from '../utils/buildInfo.js';
import { generateOpenAPIDocument } from './public.openapi.js';
import {
  queryConcurrentStreams,
  queryPlatforms,
  queryPlaysByDayOfWeek,
  queryPlaysByHourOfDay,
  queryPlaysOverTime,
  queryQualityBreakdown,
} from './stats/queries.js';

interface StreamCodecData {
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  sourceAudioChannels: number | null;
  sourceVideoWidth: number | null;
  sourceVideoHeight: number | null;
  streamVideoCodec: string | null;
  streamAudioCodec: string | null;
}

function formatDisplayValues(data: StreamCodecData) {
  return {
    resolution: getResolutionLabel(data.sourceVideoWidth, data.sourceVideoHeight),
    sourceVideoCodecDisplay: data.sourceVideoCodec ? formatMediaTech(data.sourceVideoCodec) : null,
    sourceAudioCodecDisplay: data.sourceAudioCodec ? formatMediaTech(data.sourceAudioCodec) : null,
    audioChannelsDisplay: formatAudioChannels(data.sourceAudioChannels),
    streamVideoCodecDisplay: data.streamVideoCodec ? formatMediaTech(data.streamVideoCodec) : null,
    streamAudioCodecDisplay: data.streamAudioCodec ? formatMediaTech(data.streamAudioCodec) : null,
  };
}

// Pagination schema for public API
const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

// Timezone schema - IANA timezone identifier, defaults to UTC
const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidTimezone, { message: 'Invalid IANA timezone identifier' })
  .default('UTC');

/**
 * Convert a date to start of day in the specified timezone, returned as UTC.
 * e.g., 2026-02-07 in America/New_York → 2026-02-07T05:00:00.000Z
 */
function toStartOfDayUTC(date: Date, timezone: string): Date {
  // Format the date as YYYY-MM-DD in the target timezone
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateStr = formatter.format(date); // e.g., "2026-02-07"
  // Parse as midnight in the target timezone and convert to UTC
  const parts = dateStr.split('-');
  const year = parseInt(parts[0] ?? '0', 10);
  const month = parseInt(parts[1] ?? '0', 10) - 1;
  const day = parseInt(parts[2] ?? '0', 10);

  // Create a date string that will be parsed as the target timezone
  const tzDate = new Date(
    `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`
  );
  // Get the offset for this timezone at this date
  const utcDate = new Date(tzDate.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzOffsetDate = new Date(tzDate.toLocaleString('en-US', { timeZone: timezone }));
  const offsetMs = utcDate.getTime() - tzOffsetDate.getTime();

  return new Date(tzDate.getTime() + offsetMs);
}

/**
 * Convert a date to end of day (23:59:59.999) in the specified timezone, returned as UTC.
 */
function toEndOfDayUTC(date: Date, timezone: string): Date {
  const startOfDay = toStartOfDayUTC(date, timezone);
  // Add 23:59:59.999 to get end of day
  return new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);
}

// Common filter schema
const serverFilterSchema = z.object({
  serverId: z.uuid().optional(),
});

// Streams query schema (extends server filter with summary option)
const streamsQuerySchema = serverFilterSchema.extend({
  summary: booleanStringSchema.optional(),
});

// Response envelope helper
interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
  };
}

function paginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number
): PaginatedResponse<T> {
  return {
    data,
    meta: { total, page, pageSize },
  };
}

export const publicRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /docs - OpenAPI 3.0 specification
   * No authentication required - allows integrations to discover the API
   */
  app.get('/docs', { preHandler: [app.authenticatePublicApi] }, async (request, reply) => {
    const spec = generateOpenAPIDocument() as Record<string, unknown>;

    // Derive basePath from the pre-rewrite URL so Swagger UI's "Try it out"
    // sends requests to the correct prefixed path (e.g. /tracearr/api/v1/...)
    const originalPath = (request.originalUrl ?? request.url).split('?')[0]!;
    const basePath = originalPath.replace(/\/api\/v1\/public\/docs$/, '');
    if (basePath) {
      spec.servers = [{ url: basePath }];
    }

    // Fetch actual servers to populate serverId dropdowns
    const allServers = await db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .orderBy(servers.displayOrder);

    if (allServers.length > 0) {
      const serverIds = allServers.map((s) => s.id);
      const serverListDescription =
        'Filter to specific server. Available servers:\n' +
        allServers.map((s) => `• **${s.name}**: \`${s.id}\``).join('\n');

      const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
      if (paths) {
        for (const pathObj of Object.values(paths)) {
          for (const methodObj of Object.values(pathObj)) {
            const method = methodObj as { parameters?: Array<Record<string, unknown>> };
            if (method.parameters) {
              for (const param of method.parameters) {
                if (param.name === 'serverId' && param.in === 'query') {
                  const schema = param.schema as Record<string, unknown> | undefined;
                  if (schema) {
                    schema.enum = serverIds;
                  }
                  // Update description to list available servers
                  param.description = serverListDescription;
                }
              }
            }
          }
        }
      }
    }

    return reply.type('application/json').send(spec);
  });

  /**
   * GET /health - System health and server connectivity
   */
  app.get('/health', { preHandler: [app.authenticatePublicApi] }, async () => {
    // Get all servers
    const allServers = await db
      .select({
        id: servers.id,
        name: servers.name,
        type: servers.type,
      })
      .from(servers)
      .orderBy(servers.displayOrder);

    // Get cached health state and active sessions
    const cacheService = getCacheService();
    const activeSessions = cacheService ? await cacheService.getAllActiveSessions() : [];

    // Build server status using cached health from the poller
    const serverStatus = await Promise.all(
      allServers.map(async (server) => {
        const serverActiveStreams = activeSessions.filter((s) => s.serverId === server.id).length;
        // Use cached health state set by the poller (null = unknown/not yet checked)
        const cachedHealth = cacheService ? await cacheService.getServerHealth(server.id) : null;
        // Consider online if explicitly healthy, or unknown (null) with benefit of doubt
        const online = cachedHealth !== false;

        return {
          id: server.id,
          name: server.name,
          type: server.type,
          online,
          activeStreams: serverActiveStreams,
        };
      })
    );

    return {
      status: 'ok',
      version: getCurrentVersion(),
      timestamp: new Date().toISOString(),
      servers: serverStatus,
    };
  });

  /**
   * GET /stats - Dashboard overview statistics
   */
  app.get('/stats', { preHandler: [app.authenticatePublicApi] }, async (request) => {
    const query = serverFilterSchema.safeParse(request.query);
    const serverId = query.success ? query.data.serverId : undefined;

    // Get active streams
    const cacheService = getCacheService();
    let activeSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
    if (serverId) {
      activeSessions = activeSessions.filter((s) => s.serverId === serverId);
    }

    // Get total users
    const serverFilter = serverId ? eq(serverUsers.serverId, serverId) : undefined;
    const [userCountResult] = await db
      .select({ count: sql<number>`count(distinct ${serverUsers.userId})::int` })
      .from(serverUsers)
      .where(serverFilter);

    // Get total plays (last 30 days, deduplicated by reference_id)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const sessionFilter = serverId
      ? and(eq(sessions.serverId, serverId), gte(sessions.startedAt, thirtyDaysAgo))
      : gte(sessions.startedAt, thirtyDaysAgo);
    const [sessionCountResult] = await db
      .select({ count: PLAY_COUNT })
      .from(sessions)
      .where(sessionFilter);

    // Get recent violations (last 7 days) - join with serverUsers to filter by serverId
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const violationQuery = db
      .select({ count: sql<number>`count(*)::int` })
      .from(violations)
      .innerJoin(serverUsers, eq(violations.serverUserId, serverUsers.id));

    const violationFilter = serverId
      ? and(eq(serverUsers.serverId, serverId), gte(violations.createdAt, sevenDaysAgo))
      : gte(violations.createdAt, sevenDaysAgo);

    const [violationCountResult] = await violationQuery.where(violationFilter);

    return {
      activeStreams: activeSessions.length,
      totalUsers: userCountResult?.count ?? 0,
      totalSessions: sessionCountResult?.count ?? 0,
      recentViolations: violationCountResult?.count ?? 0,
      timestamp: new Date().toISOString(),
    };
  });

  /**
   * GET /streams - Currently active playback sessions
   * Query params:
   *   - serverId: Filter to specific server
   *   - summary: If true, returns only summary stats (omits data array for lighter payload)
   */
  app.get('/streams', { preHandler: [app.authenticatePublicApi] }, async (request) => {
    const query = streamsQuerySchema.safeParse(request.query);
    const serverId = query.success ? query.data.serverId : undefined;
    const summaryOnly = query.success ? query.data.summary : false;

    const cacheService = getCacheService();
    let activeSessions = cacheService ? await cacheService.getAllActiveSessions() : [];

    if (serverId) {
      activeSessions = activeSessions.filter((s) => s.serverId === serverId);
    }

    const streams = summaryOnly
      ? []
      : activeSessions.map((session) => ({
          id: session.id,
          serverId: session.serverId,
          serverName: session.server.name,
          username: session.user.identityName ?? session.user.username,
          userThumb: session.user.thumbUrl,
          userAvatarUrl: buildAvatarUrl(session.serverId, session.user.thumbUrl),
          mediaTitle: session.mediaTitle,
          mediaType: session.mediaType,
          showTitle: session.grandparentTitle,
          seasonNumber: session.seasonNumber,
          episodeNumber: session.episodeNumber,
          year: session.year,
          artistName: session.artistName,
          albumName: session.albumName,
          trackNumber: session.trackNumber,
          discNumber: session.discNumber,
          thumbPath: session.thumbPath,
          posterUrl: buildPosterUrl(session.serverId, session.thumbPath),
          durationMs: session.totalDurationMs,
          state: session.state,
          progressMs: session.progressMs ?? 0,
          startedAt: session.startedAt,
          isTranscode: session.isTranscode,
          videoDecision: session.videoDecision,
          audioDecision: session.audioDecision,
          bitrate: session.bitrate,
          sourceVideoCodec: session.sourceVideoCodec,
          sourceAudioCodec: session.sourceAudioCodec,
          sourceAudioChannels: session.sourceAudioChannels,
          sourceVideoWidth: session.sourceVideoWidth,
          sourceVideoHeight: session.sourceVideoHeight,
          sourceVideoDetails: session.sourceVideoDetails,
          sourceAudioDetails: session.sourceAudioDetails,
          streamVideoCodec: session.streamVideoCodec,
          streamAudioCodec: session.streamAudioCodec,
          streamVideoDetails: session.streamVideoDetails,
          streamAudioDetails: session.streamAudioDetails,
          transcodeInfo: session.transcodeInfo,
          subtitleInfo: session.subtitleInfo,
          ...formatDisplayValues(session),
          device: session.device,
          player: session.playerName,
          product: session.product,
          platform: session.platform,
        }));

    const categorizeStream = (session: (typeof activeSessions)[0]) => {
      // Transcode if either video or audio is being transcoded
      if (session.isTranscode) return 'transcode';
      // Direct stream if either video or audio is 'copy' (container remux)
      if (session.videoDecision === 'copy' || session.audioDecision === 'copy')
        return 'directStream';
      // Otherwise it's direct play
      return 'directPlay';
    };

    let transcodeCount = 0;
    let directStreamCount = 0;
    let directPlayCount = 0;
    let totalBitrate = 0;

    for (const session of activeSessions) {
      const category = categorizeStream(session);
      if (category === 'transcode') transcodeCount++;
      else if (category === 'directStream') directStreamCount++;
      else directPlayCount++;
      if (session.bitrate) totalBitrate += session.bitrate;
    }

    const serverBreakdown: Record<
      string,
      {
        serverId: string;
        serverName: string;
        total: number;
        transcodes: number;
        directStreams: number;
        directPlays: number;
        bitrateKbps: number;
      }
    > = {};

    for (const session of activeSessions) {
      let serverStats = serverBreakdown[session.serverId];
      if (!serverStats) {
        serverStats = {
          serverId: session.serverId,
          serverName: session.server.name,
          total: 0,
          transcodes: 0,
          directStreams: 0,
          directPlays: 0,
          bitrateKbps: 0,
        };
        serverBreakdown[session.serverId] = serverStats;
      }
      const category = categorizeStream(session);
      serverStats.total++;
      if (category === 'transcode') serverStats.transcodes++;
      else if (category === 'directStream') serverStats.directStreams++;
      else serverStats.directPlays++;
      if (session.bitrate) serverStats.bitrateKbps += session.bitrate;
    }

    const summary = {
      total: activeSessions.length,
      transcodes: transcodeCount,
      directStreams: directStreamCount,
      directPlays: directPlayCount,
      totalBitrate: formatBitrate(totalBitrate),
      byServer: Object.values(serverBreakdown).map((s) => ({
        serverId: s.serverId,
        serverName: s.serverName,
        total: s.total,
        transcodes: s.transcodes,
        directStreams: s.directStreams,
        directPlays: s.directPlays,
        totalBitrate: formatBitrate(s.bitrateKbps),
      })),
    };

    // If summary-only mode, omit the data array for a lighter payload
    if (summaryOnly) {
      return { summary };
    }

    return { data: streams, summary };
  });

  /**
   * GET /users - User list with activity summary
   * Returns user-server pairs (a user with accounts on multiple servers appears multiple times)
   */
  app.get('/users', { preHandler: [app.authenticatePublicApi] }, async (request, reply) => {
    const pagination = paginationSchema.safeParse(request.query);
    const filter = serverFilterSchema.safeParse(request.query);

    if (!pagination.success) {
      return reply.badRequest('Invalid pagination parameters');
    }

    const { page, pageSize } = pagination.data;
    const serverId = filter.success ? filter.data.serverId : undefined;
    const offset = (page - 1) * pageSize;

    const whereClause = serverId ? eq(serverUsers.serverId, serverId) : undefined;

    // Get total count - count all user-server pairs (not distinct users) to match pagination
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .innerJoin(serverUsers, eq(users.id, serverUsers.userId))
      .where(whereClause);

    // Get paginated users with server info
    const userRows = await db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        role: users.role,
        aggregateTrustScore: users.aggregateTrustScore,
        totalViolations: users.totalViolations,
        joinedAt: serverUsers.joinedAt,
        createdAt: users.createdAt,
        // Server-specific data
        serverId: serverUsers.serverId,
        serverUserId: serverUsers.id,
        serverUsername: serverUsers.username,
        thumbUrl: serverUsers.thumbUrl,
        lastActivityAt: serverUsers.lastActivityAt,
        // Server name joined directly
        serverName: servers.name,
      })
      .from(users)
      .innerJoin(serverUsers, eq(users.id, serverUsers.userId))
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .where(whereClause)
      .orderBy(desc(serverUsers.lastActivityAt))
      .limit(pageSize)
      .offset(offset);

    const serverUserIds = userRows.map((r) => r.serverUserId);
    const playCounts =
      serverUserIds.length > 0
        ? await db
            .select({
              serverUserId: sessions.serverUserId,
              playCount: PLAY_COUNT,
            })
            .from(sessions)
            .where(inArray(sessions.serverUserId, serverUserIds))
            .groupBy(sessions.serverUserId)
        : [];
    const playCountMap = new Map(playCounts.map((r) => [r.serverUserId, r.playCount]));

    const userData = userRows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.name ?? row.serverUsername ?? row.username,
      thumbUrl: row.thumbUrl,
      avatarUrl: buildAvatarUrl(row.serverId, row.thumbUrl),
      role: row.role,
      trustScore: row.aggregateTrustScore,
      totalViolations: row.totalViolations,
      serverId: row.serverId,
      serverName: row.serverName,
      lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
      sessionCount: playCountMap.get(row.serverUserId) ?? 0,
      createdAt: (row.joinedAt ?? row.createdAt).toISOString(),
    }));

    return paginatedResponse(userData, countResult?.count ?? 0, page, pageSize);
  });

  /**
   * GET /violations - Violations list with filtering
   */
  app.get('/violations', { preHandler: [app.authenticatePublicApi] }, async (request, reply) => {
    const querySchema = paginationSchema.extend({
      serverId: z.uuid().optional(),
      severity: z.enum(['low', 'warning', 'high']).optional(),
      acknowledged: booleanStringSchema.optional(),
    });

    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page, pageSize, serverId, severity, acknowledged } = query.data;
    const offset = (page - 1) * pageSize;

    // Build where conditions - join with serverUsers to get serverId
    const conditions: ReturnType<typeof eq>[] = [];
    if (serverId) conditions.push(eq(serverUsers.serverId, serverId));
    if (severity) conditions.push(eq(violations.severity, severity));
    if (acknowledged !== undefined) {
      // Use acknowledgedAt timestamp: acknowledged=true means IS NOT NULL, false means IS NULL
      conditions.push(
        acknowledged ? isNotNull(violations.acknowledgedAt) : isNull(violations.acknowledgedAt)
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count with join
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(violations)
      .innerJoin(serverUsers, eq(violations.serverUserId, serverUsers.id))
      .where(whereClause);

    // Get violations with joins (including servers and users to avoid N+1)
    const violationRows = await db
      .select({
        id: violations.id,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        severity: violations.severity,
        acknowledgedAt: violations.acknowledgedAt,
        data: violations.data,
        createdAt: violations.createdAt,
        // Rule info
        ruleId: rules.id,
        ruleType: rules.type,
        ruleName: rules.name,
        // User info
        userId: serverUsers.userId,
        serverUsername: serverUsers.username,
        thumbUrl: serverUsers.thumbUrl,
        userName: users.name,
        userUsername: users.username,
      })
      .from(violations)
      .innerJoin(rules, eq(violations.ruleId, rules.id))
      .innerJoin(serverUsers, eq(violations.serverUserId, serverUsers.id))
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(whereClause)
      .orderBy(desc(violations.createdAt))
      .limit(pageSize)
      .offset(offset);

    const violationData = violationRows.map((row) => ({
      id: row.id,
      serverId: row.serverId,
      serverName: row.serverName,
      severity: row.severity,
      acknowledged: row.acknowledgedAt !== null,
      data: row.data,
      createdAt: row.createdAt.toISOString(),
      rule: {
        id: row.ruleId,
        type: row.ruleType,
        name: row.ruleName,
      },
      user: {
        id: row.userId,
        username: row.userName ?? row.serverUsername ?? row.userUsername,
        thumbUrl: row.thumbUrl,
        avatarUrl: buildAvatarUrl(row.serverId, row.thumbUrl),
      },
    }));

    return paginatedResponse(violationData, countResult?.count ?? 0, page, pageSize);
  });

  /**
   * GET /history - Session history with filtering
   *
   * Sessions are grouped by reference_id to show unique "plays" rather than
   * individual session records. Multiple pause/resume cycles for the same content
   * are aggregated into a single row with combined duration (matches Web UI behavior).
   */
  app.get('/history', { preHandler: [app.authenticatePublicApi] }, async (request, reply) => {
    const querySchema = paginationSchema.extend({
      serverId: z.uuid().optional(),
      state: z.enum(['playing', 'paused', 'stopped']).optional(),
      mediaType: z.enum(['movie', 'episode', 'track', 'live', 'photo', 'unknown']).optional(),
      startDate: z.coerce.date().optional(),
      endDate: z.coerce.date().optional(),
      timezone: timezoneSchema,
    });

    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page, pageSize, serverId, state, mediaType, startDate, endDate, timezone } = query.data;
    const offset = (page - 1) * pageSize;

    // Validate date range
    if (startDate && endDate && startDate > endDate) {
      return reply.badRequest('startDate must be before or equal to endDate');
    }

    // Build WHERE conditions for raw SQL CTE query
    // Dates are converted to UTC based on the provided timezone
    const conditions: ReturnType<typeof sql>[] = [];
    if (serverId) conditions.push(sql`s.server_id = ${serverId}`);
    if (state) conditions.push(sql`s.state = ${state}`);
    if (mediaType) conditions.push(sql`s.media_type = ${mediaType}`);
    if (startDate) {
      const startUTC = toStartOfDayUTC(startDate, timezone);
      conditions.push(sql`s.started_at >= ${startUTC}`);
    }
    if (endDate) {
      const endUTC = toEndOfDayUTC(endDate, timezone);
      conditions.push(sql`s.started_at <= ${endUTC}`);
    }

    const whereClause =
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

    // Get total count of unique plays (grouped by reference_id)
    const countResult = await db.execute(sql`
      SELECT COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as count
      FROM sessions s
      ${whereClause}
    `);
    const total = (countResult.rows[0] as { count: number })?.count ?? 0;

    // Query sessions grouped by reference_id (or id if no reference)
    // This matches the behavior of the internal /sessions/history endpoint
    const result = await db.execute(sql`
      WITH grouped_sessions AS (
        SELECT
          COALESCE(s.reference_id, s.id) as play_id,
          MIN(s.started_at) as started_at,
          MAX(s.stopped_at) as stopped_at,
          SUM(COALESCE(s.duration_ms, 0)) as duration_ms,
          MAX(s.progress_ms) as progress_ms,
          MAX(s.total_duration_ms) as total_duration_ms,
          COUNT(*) as segment_count,
          BOOL_OR(s.watched) as watched,
          (array_agg(s.id ORDER BY s.started_at))[1] as first_session_id,
          (array_agg(s.state ORDER BY s.started_at DESC))[1] as state
        FROM sessions s
        ${whereClause}
        GROUP BY COALESCE(s.reference_id, s.id)
        ORDER BY MIN(s.started_at) DESC
        LIMIT ${pageSize} OFFSET ${offset}
      )
      SELECT
        gs.play_id as id,
        gs.started_at,
        gs.stopped_at,
        gs.duration_ms,
        gs.progress_ms,
        gs.total_duration_ms,
        gs.segment_count,
        gs.watched,
        gs.state,
        s.server_id,
        sv.name as server_name,
        s.media_type,
        s.media_title,
        s.grandparent_title,
        s.season_number,
        s.episode_number,
        s.year,
        s.artist_name,
        s.album_name,
        s.track_number,
        s.disc_number,
        s.thumb_path,
        s.rating_key,
        s.device,
        s.player_name,
        s.product,
        s.platform,
        s.is_transcode,
        s.video_decision,
        s.audio_decision,
        s.bitrate,
        s.source_video_codec,
        s.source_audio_codec,
        s.source_audio_channels,
        s.source_video_width,
        s.source_video_height,
        s.source_video_details,
        s.source_audio_details,
        s.stream_video_codec,
        s.stream_audio_codec,
        s.stream_video_details,
        s.stream_audio_details,
        s.transcode_info,
        s.subtitle_info,
        li.imdb_id,
        li.tmdb_id,
        li.tvdb_id,
        su.user_id,
        su.username as server_username,
        su.thumb_url as user_thumb_url,
        u.name as user_name,
        u.username as user_username
      FROM grouped_sessions gs
      JOIN sessions s ON s.id = gs.first_session_id
      LEFT JOIN library_items li
        ON li.server_id = s.server_id
       AND li.rating_key = s.rating_key
      JOIN server_users su ON su.id = s.server_user_id
      JOIN servers sv ON sv.id = s.server_id
      LEFT JOIN users u ON u.id = su.user_id
      ORDER BY gs.started_at DESC
    `);

    // Type the result and transform
    const sessionData = (
      result.rows as {
        id: string;
        started_at: Date;
        stopped_at: Date | null;
        duration_ms: string | null;
        progress_ms: number | null;
        total_duration_ms: number | null;
        segment_count: string;
        watched: boolean;
        state: string;
        server_id: string;
        server_name: string;
        media_type: string;
        media_title: string;
        grandparent_title: string | null;
        season_number: number | null;
        episode_number: number | null;
        year: number | null;
        artist_name: string | null;
        album_name: string | null;
        track_number: number | null;
        disc_number: number | null;
        thumb_path: string | null;
        rating_key: string | null;
        device: string | null;
        player_name: string | null;
        product: string | null;
        platform: string | null;
        is_transcode: boolean | null;
        video_decision: string | null;
        audio_decision: string | null;
        bitrate: number | null;
        source_video_codec: string | null;
        source_audio_codec: string | null;
        source_audio_channels: number | null;
        source_video_width: number | null;
        source_video_height: number | null;
        source_video_details: SourceVideoDetails | null;
        source_audio_details: SourceAudioDetails | null;
        stream_video_codec: string | null;
        stream_audio_codec: string | null;
        stream_video_details: StreamVideoDetails | null;
        stream_audio_details: StreamAudioDetails | null;
        transcode_info: TranscodeInfo | null;
        subtitle_info: SubtitleInfo | null;
        imdb_id: string | null;
        tmdb_id: number | null;
        tvdb_id: number | null;
        user_id: string;
        server_username: string;
        user_thumb_url: string | null;
        user_name: string | null;
        user_username: string | null;
      }[]
    ).map((row) => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      state: row.state,
      mediaType: row.media_type,
      mediaTitle: row.media_title,
      showTitle: row.grandparent_title,
      seasonNumber: row.season_number,
      episodeNumber: row.episode_number,
      year: row.year,
      ratingKey: row.rating_key,
      imdbId: row.imdb_id,
      tmdbId: row.tmdb_id,
      tvdbId: row.tvdb_id,
      artistName: row.artist_name,
      albumName: row.album_name,
      trackNumber: row.track_number,
      discNumber: row.disc_number,
      thumbPath: row.thumb_path,
      posterUrl: buildPosterUrl(row.server_id, row.thumb_path),
      durationMs: row.duration_ms ? Number(row.duration_ms) : null,
      progressMs: row.progress_ms,
      totalDurationMs: row.total_duration_ms,
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      stoppedAt: row.stopped_at ? new Date(row.stopped_at).toISOString() : null,
      watched: row.watched,
      segmentCount: Number(row.segment_count),
      device: row.device,
      player: row.player_name,
      product: row.product,
      platform: row.platform,
      isTranscode: row.is_transcode,
      videoDecision: row.video_decision,
      audioDecision: row.audio_decision,
      bitrate: row.bitrate,
      sourceVideoCodec: row.source_video_codec,
      sourceAudioCodec: row.source_audio_codec,
      sourceAudioChannels: row.source_audio_channels,
      sourceVideoWidth: row.source_video_width,
      sourceVideoHeight: row.source_video_height,
      sourceVideoDetails: row.source_video_details,
      sourceAudioDetails: row.source_audio_details,
      streamVideoCodec: row.stream_video_codec,
      streamAudioCodec: row.stream_audio_codec,
      streamVideoDetails: row.stream_video_details,
      streamAudioDetails: row.stream_audio_details,
      transcodeInfo: row.transcode_info,
      subtitleInfo: row.subtitle_info,
      ...formatDisplayValues({
        sourceVideoCodec: row.source_video_codec,
        sourceAudioCodec: row.source_audio_codec,
        sourceAudioChannels: row.source_audio_channels,
        sourceVideoWidth: row.source_video_width,
        sourceVideoHeight: row.source_video_height,
        streamVideoCodec: row.stream_video_codec,
        streamAudioCodec: row.stream_audio_codec,
      }),
      user: {
        id: row.user_id,
        username: row.user_name ?? row.server_username ?? row.user_username,
        thumbUrl: row.user_thumb_url,
        avatarUrl: buildAvatarUrl(row.server_id, row.user_thumb_url),
      },
    }));

    return paginatedResponse(sessionData, total, page, pageSize);
  });

  /**
   * GET /stats/today - Today's dashboard statistics with timezone support
   *
   * Query params:
   *   - timezone: IANA timezone identifier (default: UTC)
   *   - serverId: Optional UUID to filter stats to a specific server
   */
  app.get('/stats/today', { preHandler: [app.authenticatePublicApi] }, async (request, reply) => {
    const querySchema = z.object({
      timezone: timezoneSchema,
      serverId: z.uuid().optional(),
    });

    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { timezone, serverId } = query.data;

    return getDashboardStats({
      serverIds: serverId ? [serverId] : undefined,
      timezone,
      redis: app.redis,
    });
  });

  /**
   * GET /activity - Playback activity trends and breakdowns
   *
   * Consolidated view of six activity datasets: plays over time, concurrent
   * streams, day-of-week and hour-of-day distributions, platform usage, and
   * playback quality breakdown.
   *
   * Query params:
   *   - period: 'week' | 'month' | 'year' (default: month)
   *   - serverId: Optional UUID to filter to a specific server
   *   - timezone: IANA timezone for date bucketing (default: UTC)
   */
  app.get('/activity', { preHandler: [app.authenticatePublicApi] }, async (request, reply) => {
    const querySchema = z.object({
      period: z.enum(['week', 'month', 'year']).default('month'),
      serverId: z.uuid().optional(),
      timezone: timezoneSchema,
    });

    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      const details = query.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.badRequest(`Invalid query parameters: ${details}`);
    }

    const { period, serverId, timezone } = query.data;

    const now = new Date();
    const durationMs =
      period === 'week'
        ? 7 * 24 * 60 * 60 * 1000
        : period === 'month'
          ? 30 * 24 * 60 * 60 * 1000
          : 365 * 24 * 60 * 60 * 1000;
    const rangeStart = new Date(now.getTime() - durationMs);
    const bucketInterval = period === 'week' ? '6 hours' : '1 day';
    const serverFilter = serverId ? sql`AND server_id = ${serverId}` : sql``;

    const [plays, concurrent, byDayOfWeek, byHourOfDay, platforms, quality] = await Promise.all([
      queryPlaysOverTime({ rangeStart, timezone, bucketInterval, serverFilter }),
      queryConcurrentStreams({ rangeStart, rangeEnd: now, bucketInterval, serverFilter }),
      queryPlaysByDayOfWeek({ rangeStart, timezone, serverFilter }),
      queryPlaysByHourOfDay({ rangeStart, timezone, serverFilter }),
      queryPlatforms({ rangeStart, serverFilter }),
      queryQualityBreakdown({ rangeStart, serverFilter }),
    ]);

    return {
      period,
      range: {
        start: rangeStart.toISOString(),
        end: now.toISOString(),
      },
      plays,
      concurrent: concurrent.map((r) => ({
        date: r.hour,
        total: r.total,
        direct: r.direct,
        directStream: r.directStream,
        transcode: r.transcode,
      })),
      byDayOfWeek,
      byHourOfDay,
      platforms,
      quality,
    };
  });

  /**
   * POST /streams/:id/terminate - Terminate an active stream
   *
   * Path params:
   *   - id: Session UUID (database ID)
   *
   * Body:
   *   - reason: Optional message to display to the user
   */
  app.post(
    '/streams/:id/terminate',
    { preHandler: [app.authenticatePublicApi] },
    async (request, reply) => {
      const params = sessionIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid session ID');
      }

      const body = terminateSessionBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }

      const { id: sessionId } = params.data;
      const { reason } = body.data;

      const cacheService = getCacheService();
      if (!cacheService) {
        return reply.serviceUnavailable('Cache service unavailable');
      }

      const activeSessions = await cacheService.getAllActiveSessions();
      const activeSession = activeSessions.find((s) => s.id === sessionId);

      if (!activeSession) {
        const dbSession = await db
          .select({ id: sessions.id, state: sessions.state })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);

        if (!dbSession[0]) {
          return reply.notFound('Session not found');
        }

        if (dbSession[0].state === 'stopped') {
          return reply.conflict('Session already stopped');
        }

        return reply.notFound('Session not currently active');
      }

      const result = await terminateSession({
        sessionId,
        trigger: 'manual',
        reason,
      });

      if (!result.success) {
        return reply.internalServerError(result.error ?? 'Failed to terminate session');
      }

      return {
        success: true,
        sessionId,
        message: 'Session terminated successfully',
      };
    }
  );
};
