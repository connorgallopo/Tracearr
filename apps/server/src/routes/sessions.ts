/**
 * Session routes - Query historical and active sessions
 *
 * Activity history is grouped by reference_id to show unique "plays" rather than
 * individual session records. Multiple pause/resume cycles for the same content
 * are aggregated into a single row with combined duration.
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  sessionQuerySchema,
  historyQuerySchema,
  sessionIdParamSchema,
  serverIdFilterSchema,
  terminateSessionBodySchema,
  REDIS_KEYS,
  type ActiveSession,
  type HistorySessionResponse,
  type HistoryFilterOptions,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, serverUsers, servers, users } from '../db/schema.js';
import { filterByServerAccess, hasServerAccess } from '../utils/serverFiltering.js';
import { terminateSession } from '../services/termination.js';
import { getCacheService } from '../services/cache.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /sessions - Query historical sessions with pagination and filters
   *
   * Sessions are grouped by reference_id to show unique "plays". Multiple
   * pause/resume cycles for the same content appear as one row with:
   * - Aggregated duration (total watch time)
   * - First session's start time
   * - Last session's stop time
   * - Segment count (how many pause/resume cycles)
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = sessionQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const {
      page = 1,
      pageSize = 50,
      serverUserId,
      serverId,
      state,
      mediaType,
      startDate,
      endDate,
    } = query.data;

    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    // Build WHERE clause conditions dynamically for raw SQL CTE query
    // Note: Using sql.join() pattern because this query requires a CTE for reference_id grouping,
    // which isn't expressible in Drizzle's query builder.
    const conditions: ReturnType<typeof sql>[] = [];

    // Filter by user's accessible servers (owners see all)
    if (authUser.role !== 'owner') {
      if (authUser.serverIds.length === 0) {
        // No server access - return empty result
        return {
          data: [],
          page,
          pageSize,
          total: 0,
          totalPages: 0,
        };
      } else if (authUser.serverIds.length === 1) {
        conditions.push(sql`s.server_id = ${authUser.serverIds[0]}`);
      } else {
        // Multiple servers - use IN clause
        const serverIdList = authUser.serverIds.map((id: string) => sql`${id}`);
        conditions.push(sql`s.server_id IN (${sql.join(serverIdList, sql`, `)})`);
      }
    }

    if (serverUserId) {
      conditions.push(sql`s.server_user_id = ${serverUserId}`);
    }

    if (serverId) {
      conditions.push(sql`s.server_id = ${serverId}`);
    }

    if (state) {
      conditions.push(sql`s.state = ${state}`);
    }

    if (mediaType) {
      conditions.push(sql`s.media_type = ${mediaType}`);
    }

    if (startDate) {
      conditions.push(sql`s.started_at >= ${startDate}`);
    }

    if (endDate) {
      // Adjust endDate to end of day (23:59:59.999) to include all sessions from that day
      const endOfDay = new Date(endDate);
      endOfDay.setHours(23, 59, 59, 999);
      conditions.push(sql`s.started_at <= ${endOfDay}`);
    }

    // Build the WHERE clause
    const whereClause =
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

    // Query sessions grouped by reference_id (or id if no reference)
    const result = await db.execute(sql`
        WITH grouped_sessions AS (
          SELECT
            COALESCE(s.reference_id, s.id) as play_id,
            MIN(s.started_at) as started_at,
            MAX(s.stopped_at) as stopped_at,
            SUM(COALESCE(s.duration_ms, 0)) as duration_ms,
            SUM(COALESCE(s.paused_duration_ms, 0)) as paused_duration_ms,
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
          gs.paused_duration_ms,
          gs.progress_ms,
          gs.total_duration_ms,
          gs.segment_count,
          gs.watched,
          gs.state,
          s.server_id,
          sv.name as server_name,
          sv.type as server_type,
          s.server_user_id,
          su.username,
          su.thumb_url as user_thumb,
          u.name as identity_name,
          s.session_key,
          s.media_type,
          s.media_title,
          s.grandparent_title,
          s.season_number,
          s.episode_number,
          s.year,
          s.thumb_path,
          s.reference_id,
          s.ip_address,
          s.geo_city,
          s.geo_region,
          s.geo_country,
          s.geo_lat,
          s.geo_lon,
          s.player_name,
          s.device_id,
          s.product,
          s.device,
          s.platform,
          s.quality,
          s.is_transcode,
          s.video_decision,
          s.audio_decision,
          s.bitrate
        FROM grouped_sessions gs
        JOIN sessions s ON s.id = gs.first_session_id
        JOIN server_users su ON su.id = s.server_user_id
        JOIN servers sv ON sv.id = s.server_id
        LEFT JOIN users u ON u.id = su.user_id
        ORDER BY gs.started_at DESC
      `);

    // Type the result
    const sessionData = (
      result.rows as {
        id: string;
        started_at: Date;
        stopped_at: Date | null;
        duration_ms: string | null;
        paused_duration_ms: string | null;
        progress_ms: number | null;
        total_duration_ms: number | null;
        segment_count: string;
        watched: boolean;
        state: string;
        server_id: string;
        server_name: string;
        server_type: string;
        server_user_id: string;
        username: string;
        user_thumb: string | null;
        identity_name: string | null;
        session_key: string;
        media_type: string;
        media_title: string;
        grandparent_title: string | null;
        season_number: number | null;
        episode_number: number | null;
        year: number | null;
        thumb_path: string | null;
        reference_id: string | null;
        ip_address: string | null;
        geo_city: string | null;
        geo_region: string | null;
        geo_country: string | null;
        geo_lat: number | null;
        geo_lon: number | null;
        player_name: string | null;
        device_id: string | null;
        product: string | null;
        device: string | null;
        platform: string | null;
        quality: string | null;
        is_transcode: boolean | null;
        video_decision: string | null;
        audio_decision: string | null;
        bitrate: number | null;
      }[]
    ).map((row) => ({
      id: row.id,
      serverId: row.server_id,
      serverUserId: row.server_user_id,
      user: {
        id: row.server_user_id,
        username: row.username,
        thumbUrl: row.user_thumb,
        identityName: row.identity_name,
      },
      server: {
        id: row.server_id,
        name: row.server_name,
        type: row.server_type as 'plex' | 'jellyfin' | 'emby',
      },
      sessionKey: row.session_key,
      state: row.state,
      mediaType: row.media_type,
      mediaTitle: row.media_title,
      grandparentTitle: row.grandparent_title,
      seasonNumber: row.season_number,
      episodeNumber: row.episode_number,
      year: row.year,
      thumbPath: row.thumb_path,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
      durationMs: row.duration_ms ? Number(row.duration_ms) : null,
      pausedDurationMs: row.paused_duration_ms ? Number(row.paused_duration_ms) : null,
      progressMs: row.progress_ms,
      totalDurationMs: row.total_duration_ms,
      referenceId: row.reference_id,
      watched: row.watched,
      segmentCount: Number(row.segment_count),
      ipAddress: row.ip_address,
      geoCity: row.geo_city,
      geoRegion: row.geo_region,
      geoCountry: row.geo_country,
      geoLat: row.geo_lat,
      geoLon: row.geo_lon,
      playerName: row.player_name,
      deviceId: row.device_id,
      product: row.product,
      device: row.device,
      platform: row.platform,
      quality: row.quality,
      isTranscode: row.is_transcode,
      videoDecision: row.video_decision,
      audioDecision: row.audio_decision,
      bitrate: row.bitrate,
    }));

    // Get total count of unique plays
    const countResult = await db.execute(sql`
        SELECT COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as count
        FROM sessions s
        ${whereClause}
      `);
    const total = (countResult.rows[0] as { count: number })?.count ?? 0;

    return {
      data: sessionData,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });

  /**
   * GET /sessions/history - Query history with cursor-based pagination and advanced filters
   *
   * Supports comprehensive filtering for the History page:
   * - Title search (ILIKE on mediaTitle and grandparentTitle)
   * - Device/client filters (platform, product, device, playerName)
   * - Network/location filters (ipAddress, geoCountry, geoCity, geoRegion)
   * - Stream quality (isTranscode)
   * - Status filters (watched, excludeShortSessions)
   * - Cursor-based pagination for efficient infinite scroll
   */
  app.get('/history', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const {
      cursor,
      pageSize = 50,
      serverUserId,
      serverId,
      state,
      mediaType,
      startDate,
      endDate,
      search,
      platform,
      product,
      device,
      playerName,
      ipAddress,
      geoCountry,
      geoCity,
      geoRegion,
      isTranscode,
      watched,
      excludeShortSessions,
      orderBy = 'startedAt',
      orderDir = 'desc',
    } = query.data;

    const authUser = request.user;

    // Build WHERE clause conditions for the CTE
    const conditions: ReturnType<typeof sql>[] = [];

    // Filter by user's accessible servers (owners see all)
    if (authUser.role !== 'owner') {
      if (authUser.serverIds.length === 0) {
        // No server access - return empty result
        const emptyResponse: HistorySessionResponse = {
          data: [],
          aggregates: {
            totalWatchTimeMs: 0,
            playCount: 0,
            uniqueUsers: 0,
            uniqueContent: 0,
          },
          total: 0,
          hasMore: false,
        };
        return emptyResponse;
      } else if (authUser.serverIds.length === 1) {
        conditions.push(sql`s.server_id = ${authUser.serverIds[0]}`);
      } else {
        const serverIdList = authUser.serverIds.map((id: string) => sql`${id}`);
        conditions.push(sql`s.server_id IN (${sql.join(serverIdList, sql`, `)})`);
      }
    }

    // Standard filters
    if (serverUserId) conditions.push(sql`s.server_user_id = ${serverUserId}`);
    if (serverId) conditions.push(sql`s.server_id = ${serverId}`);
    if (state) conditions.push(sql`s.state = ${state}`);
    if (mediaType) conditions.push(sql`s.media_type = ${mediaType}`);
    if (startDate) conditions.push(sql`s.started_at >= ${startDate}`);
    if (endDate) {
      // Adjust endDate to end of day (23:59:59.999) to include all sessions from that day
      const endOfDay = new Date(endDate);
      endOfDay.setHours(23, 59, 59, 999);
      conditions.push(sql`s.started_at <= ${endOfDay}`);
    }

    // Full-text search across multiple fields
    if (search) {
      const searchPattern = `%${search}%`;
      conditions.push(
        sql`(
            s.media_title ILIKE ${searchPattern}
            OR s.grandparent_title ILIKE ${searchPattern}
            OR s.geo_city ILIKE ${searchPattern}
            OR s.geo_country ILIKE ${searchPattern}
            OR s.ip_address ILIKE ${searchPattern}
            OR s.platform ILIKE ${searchPattern}
            OR s.product ILIKE ${searchPattern}
            OR EXISTS (
              SELECT 1 FROM server_users su_search
              LEFT JOIN users u_search ON u_search.id = su_search.user_id
              WHERE su_search.id = s.server_user_id
              AND (su_search.username ILIKE ${searchPattern} OR u_search.name ILIKE ${searchPattern})
            )
          )`
      );
    }

    // Device/client filters
    if (platform) conditions.push(sql`s.platform = ${platform}`);
    if (product) conditions.push(sql`s.product = ${product}`);
    if (device) conditions.push(sql`s.device = ${device}`);
    if (playerName) conditions.push(sql`s.player_name ILIKE ${`%${playerName}%`}`);

    // Network/location filters
    if (ipAddress) conditions.push(sql`s.ip_address = ${ipAddress}`);
    if (geoCountry) conditions.push(sql`s.geo_country = ${geoCountry}`);
    if (geoCity) conditions.push(sql`s.geo_city = ${geoCity}`);
    if (geoRegion) conditions.push(sql`s.geo_region = ${geoRegion}`);

    // Stream quality
    if (isTranscode !== undefined) conditions.push(sql`s.is_transcode = ${isTranscode}`);

    // Status filters
    if (watched !== undefined) conditions.push(sql`s.watched = ${watched}`);
    if (excludeShortSessions) conditions.push(sql`s.short_session = false`);

    // Cursor-based pagination - parse cursor (format: `${startedAt.getTime()}_${playId}`)
    let cursorTime: Date | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      const parts = cursor.split('_');
      const timeStr = parts[0];
      const id = parts.slice(1).join('_'); // Handle UUIDs with underscores
      if (timeStr && id) {
        cursorTime = new Date(parseInt(timeStr, 10));
        cursorId = id;
      }
    }

    // Build WHERE clause
    const whereClause =
      conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

    // Build ORDER BY clause based on orderBy parameter
    // Note: Cursor pagination is based on started_at, so for other columns we use
    // started_at as secondary sort to maintain consistent pagination
    const buildOrderClause = () => {
      const dir = orderDir === 'desc' ? sql`DESC` : sql`ASC`;
      switch (orderBy) {
        case 'durationMs':
          return sql`ORDER BY SUM(COALESCE(s.duration_ms, 0)) ${dir}, MIN(s.started_at) DESC`;
        case 'mediaTitle':
          return sql`ORDER BY MIN(s.media_title) ${dir}, MIN(s.started_at) DESC`;
        case 'startedAt':
        default:
          return sql`ORDER BY MIN(s.started_at) ${dir}`;
      }
    };
    const orderClause = buildOrderClause();

    // Query grouped sessions with cursor pagination
    const result = await db.execute(sql`
        WITH grouped_sessions AS (
          SELECT
            COALESCE(s.reference_id, s.id) as play_id,
            MIN(s.started_at) as started_at,
            MAX(s.stopped_at) as stopped_at,
            SUM(COALESCE(s.duration_ms, 0)) as duration_ms,
            SUM(COALESCE(s.paused_duration_ms, 0)) as paused_duration_ms,
            MAX(s.progress_ms) as progress_ms,
            MAX(s.total_duration_ms) as total_duration_ms,
            COUNT(*) as segment_count,
            BOOL_OR(s.watched) as watched,
            (array_agg(s.id ORDER BY s.started_at))[1] as first_session_id,
            (array_agg(s.state ORDER BY s.started_at DESC))[1] as state
          FROM sessions s
          ${whereClause}
          GROUP BY COALESCE(s.reference_id, s.id)
          ${
            cursorTime && cursorId
              ? orderDir === 'desc'
                ? sql`HAVING (MIN(s.started_at), COALESCE(s.reference_id, s.id)::text) < (${cursorTime}, ${cursorId})`
                : sql`HAVING (MIN(s.started_at), COALESCE(s.reference_id, s.id)::text) > (${cursorTime}, ${cursorId})`
              : sql``
          }
          ${orderClause}
          LIMIT ${pageSize + 1}
        )
        SELECT
          gs.play_id as id,
          gs.started_at,
          gs.stopped_at,
          gs.duration_ms,
          gs.paused_duration_ms,
          gs.progress_ms,
          gs.total_duration_ms,
          gs.segment_count,
          gs.watched,
          gs.state,
          s.server_id,
          sv.name as server_name,
          sv.type as server_type,
          s.server_user_id,
          su.username,
          su.thumb_url as user_thumb,
          u.name as identity_name,
          s.session_key,
          s.media_type,
          s.media_title,
          s.grandparent_title,
          s.season_number,
          s.episode_number,
          s.year,
          s.thumb_path,
          s.reference_id,
          s.ip_address,
          s.geo_city,
          s.geo_region,
          s.geo_country,
          s.geo_lat,
          s.geo_lon,
          s.player_name,
          s.device_id,
          s.product,
          s.device,
          s.platform,
          s.quality,
          s.is_transcode,
          s.video_decision,
          s.audio_decision,
          s.bitrate
        FROM grouped_sessions gs
        JOIN sessions s ON s.id = gs.first_session_id
        JOIN server_users su ON su.id = s.server_user_id
        JOIN servers sv ON sv.id = s.server_id
        LEFT JOIN users u ON u.id = su.user_id
        ${
          cursorTime && cursorId
            ? orderDir === 'desc'
              ? sql`WHERE (gs.started_at, gs.play_id::text) < (${cursorTime}, ${cursorId})`
              : sql`WHERE (gs.started_at, gs.play_id::text) > (${cursorTime}, ${cursorId})`
            : sql``
        }
        ORDER BY gs.started_at ${orderDir === 'desc' ? sql`DESC` : sql`ASC`}
      `);

    // Check if there are more results (we fetched pageSize + 1)
    const hasMore = result.rows.length > pageSize;
    const resultRows = hasMore ? result.rows.slice(0, pageSize) : result.rows;

    // Transform results
    const sessionData = (
      resultRows as {
        id: string;
        started_at: Date;
        stopped_at: Date | null;
        duration_ms: string | null;
        paused_duration_ms: string | null;
        progress_ms: number | null;
        total_duration_ms: number | null;
        segment_count: string;
        watched: boolean;
        state: string;
        server_id: string;
        server_name: string;
        server_type: string;
        server_user_id: string;
        username: string;
        user_thumb: string | null;
        identity_name: string | null;
        session_key: string;
        media_type: string;
        media_title: string;
        grandparent_title: string | null;
        season_number: number | null;
        episode_number: number | null;
        year: number | null;
        thumb_path: string | null;
        reference_id: string | null;
        ip_address: string | null;
        geo_city: string | null;
        geo_region: string | null;
        geo_country: string | null;
        geo_lat: number | null;
        geo_lon: number | null;
        player_name: string | null;
        device_id: string | null;
        product: string | null;
        device: string | null;
        platform: string | null;
        quality: string | null;
        is_transcode: boolean | null;
        video_decision: string | null;
        audio_decision: string | null;
        bitrate: number | null;
      }[]
    ).map((row) => ({
      id: row.id,
      serverId: row.server_id,
      serverUserId: row.server_user_id,
      user: {
        id: row.server_user_id,
        username: row.username,
        thumbUrl: row.user_thumb,
        identityName: row.identity_name,
      },
      server: {
        id: row.server_id,
        name: row.server_name,
        type: row.server_type as 'plex' | 'jellyfin' | 'emby',
      },
      sessionKey: row.session_key,
      state: row.state,
      mediaType: row.media_type,
      mediaTitle: row.media_title,
      grandparentTitle: row.grandparent_title,
      seasonNumber: row.season_number,
      episodeNumber: row.episode_number,
      year: row.year,
      thumbPath: row.thumb_path,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
      durationMs: row.duration_ms ? Number(row.duration_ms) : null,
      pausedDurationMs: row.paused_duration_ms ? Number(row.paused_duration_ms) : null,
      progressMs: row.progress_ms,
      totalDurationMs: row.total_duration_ms,
      referenceId: row.reference_id,
      watched: row.watched,
      segmentCount: Number(row.segment_count),
      ipAddress: row.ip_address,
      geoCity: row.geo_city,
      geoRegion: row.geo_region,
      geoCountry: row.geo_country,
      geoLat: row.geo_lat,
      geoLon: row.geo_lon,
      playerName: row.player_name,
      deviceId: row.device_id,
      product: row.product,
      device: row.device,
      platform: row.platform,
      quality: row.quality,
      isTranscode: row.is_transcode,
      videoDecision: row.video_decision,
      audioDecision: row.audio_decision,
      bitrate: row.bitrate,
    }));

    // Get aggregates for the entire filtered result set (without pagination)
    const aggregateResult = await db.execute(sql`
        SELECT
          COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as play_count,
          COALESCE(SUM(s.duration_ms), 0)::bigint as total_watch_time_ms,
          COUNT(DISTINCT s.server_user_id)::int as unique_users,
          COUNT(DISTINCT s.media_title)::int as unique_content
        FROM sessions s
        ${whereClause}
      `);

    const aggregates = aggregateResult.rows[0] as {
      play_count: number;
      total_watch_time_ms: string;
      unique_users: number;
      unique_content: number;
    };

    // Generate next cursor
    const lastSession = sessionData[sessionData.length - 1];
    const nextCursor =
      hasMore && lastSession
        ? `${new Date(lastSession.startedAt).getTime()}_${lastSession.id}`
        : undefined;

    const response: HistorySessionResponse = {
      data: sessionData as HistorySessionResponse['data'],
      aggregates: {
        totalWatchTimeMs: Number(aggregates.total_watch_time_ms),
        playCount: aggregates.play_count,
        uniqueUsers: aggregates.unique_users,
        uniqueContent: aggregates.unique_content,
      },
      total: aggregates.play_count,
      nextCursor,
      hasMore,
    };

    return response;
  });

  /**
   * GET /sessions/filter-options - Get available filter values for dropdowns
   *
   * Returns distinct values for platforms, products, devices, countries, cities,
   * and users to populate filter dropdowns on the History page.
   */
  app.get('/filter-options', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = serverIdFilterSchema.safeParse(request.query);
    const serverId = query.success ? query.data.serverId : undefined;
    const authUser = request.user;

    // Build server access conditions
    const serverConditions: ReturnType<typeof sql>[] = [];
    if (serverId) {
      if (!hasServerAccess(authUser, serverId)) {
        return reply.forbidden('You do not have access to this server');
      }
      serverConditions.push(sql`s.server_id = ${serverId}`);
    } else if (authUser.role !== 'owner') {
      if (authUser.serverIds.length === 0) {
        const emptyResponse: HistoryFilterOptions = {
          platforms: [],
          products: [],
          devices: [],
          countries: [],
          cities: [],
          users: [],
        };
        return emptyResponse;
      } else if (authUser.serverIds.length === 1) {
        serverConditions.push(sql`s.server_id = ${authUser.serverIds[0]}`);
      } else {
        const serverIdList = authUser.serverIds.map((id: string) => sql`${id}`);
        serverConditions.push(sql`s.server_id IN (${sql.join(serverIdList, sql`, `)})`);
      }
    }

    // Only look at sessions from the last 90 days for efficiency
    serverConditions.push(sql`s.started_at >= NOW() - INTERVAL '90 days'`);

    const whereClause =
      serverConditions.length > 0 ? sql`WHERE ${sql.join(serverConditions, sql` AND `)}` : sql``;

    // Query all filter options in parallel
    const [
      platformsResult,
      productsResult,
      devicesResult,
      countriesResult,
      citiesResult,
      usersResult,
    ] = await Promise.all([
      // Platforms
      db.execute(sql`
            SELECT platform as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${whereClause}
            AND platform IS NOT NULL
            GROUP BY platform
            ORDER BY count DESC
            LIMIT 50
          `),
      // Products
      db.execute(sql`
            SELECT product as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${whereClause}
            AND product IS NOT NULL
            GROUP BY product
            ORDER BY count DESC
            LIMIT 50
          `),
      // Devices
      db.execute(sql`
            SELECT device as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${whereClause}
            AND device IS NOT NULL
            GROUP BY device
            ORDER BY count DESC
            LIMIT 50
          `),
      // Countries
      db.execute(sql`
            SELECT geo_country as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${whereClause}
            AND geo_country IS NOT NULL
            GROUP BY geo_country
            ORDER BY count DESC
            LIMIT 50
          `),
      // Cities
      db.execute(sql`
            SELECT geo_city as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${whereClause}
            AND geo_city IS NOT NULL
            GROUP BY geo_city
            ORDER BY count DESC
            LIMIT 100
          `),
      // Users with their identity info
      db.execute(sql`
            SELECT DISTINCT
              su.id,
              su.username,
              su.thumb_url,
              u.name as identity_name
            FROM sessions s
            JOIN server_users su ON su.id = s.server_user_id
            LEFT JOIN users u ON u.id = su.user_id
            ${whereClause}
            ORDER BY su.username
            LIMIT 200
          `),
    ]);

    const response: HistoryFilterOptions = {
      platforms: platformsResult.rows as unknown as HistoryFilterOptions['platforms'],
      products: productsResult.rows as unknown as HistoryFilterOptions['products'],
      devices: devicesResult.rows as unknown as HistoryFilterOptions['devices'],
      countries: countriesResult.rows as unknown as HistoryFilterOptions['countries'],
      cities: citiesResult.rows as unknown as HistoryFilterOptions['cities'],
      users: (
        usersResult.rows as unknown as {
          id: string;
          username: string;
          thumb_url: string | null;
          identity_name: string | null;
        }[]
      ).map((row) => ({
        id: row.id,
        username: row.username,
        thumbUrl: row.thumb_url,
        identityName: row.identity_name,
      })),
    };

    return response;
  });

  /**
   * GET /sessions/active - Get currently active streams from cache
   */
  app.get('/active', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Parse optional serverId filter
    const query = serverIdFilterSchema.safeParse(request.query);
    const serverId = query.success ? query.data.serverId : undefined;

    // If specific server requested, validate access
    if (serverId && !hasServerAccess(authUser, serverId)) {
      return reply.forbidden('You do not have access to this server');
    }

    // Get active sessions from atomic SET-based cache
    const cacheService = getCacheService();
    let activeSessions: ActiveSession[] = [];

    if (cacheService) {
      activeSessions = await cacheService.getAllActiveSessions();
    }

    // Filter by specific server if requested
    if (serverId) {
      activeSessions = activeSessions.filter((s) => s.serverId === serverId);
    } else {
      // Otherwise filter by user's accessible servers (owners see all)
      activeSessions = filterByServerAccess(activeSessions, authUser);
    }

    return { data: activeSessions };
  });

  /**
   * GET /sessions/:id - Get detailed info for a specific session
   */
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = sessionIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid session ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Try cache first for active sessions
    const cached = await app.redis.get(REDIS_KEYS.SESSION_BY_ID(id));
    if (cached) {
      try {
        const activeSession = JSON.parse(cached) as ActiveSession;
        // Verify access (owners can see all servers)
        if (hasServerAccess(authUser, activeSession.serverId)) {
          // Return ActiveSession directly - both types now use nested user/server
          return activeSession;
        }
      } catch {
        // Fall through to DB
      }
    }

    // Query from database using manual JOINs then transform to nested format
    const sessionData = await db
      .select({
        id: sessions.id,
        serverId: sessions.serverId,
        serverName: servers.name,
        serverType: servers.type,
        serverUserId: sessions.serverUserId,
        username: serverUsers.username,
        userThumb: serverUsers.thumbUrl,
        identityName: users.name,
        sessionKey: sessions.sessionKey,
        state: sessions.state,
        mediaType: sessions.mediaType,
        mediaTitle: sessions.mediaTitle,
        grandparentTitle: sessions.grandparentTitle,
        seasonNumber: sessions.seasonNumber,
        episodeNumber: sessions.episodeNumber,
        year: sessions.year,
        thumbPath: sessions.thumbPath,
        startedAt: sessions.startedAt,
        stoppedAt: sessions.stoppedAt,
        durationMs: sessions.durationMs,
        progressMs: sessions.progressMs,
        totalDurationMs: sessions.totalDurationMs,
        lastPausedAt: sessions.lastPausedAt,
        pausedDurationMs: sessions.pausedDurationMs,
        referenceId: sessions.referenceId,
        watched: sessions.watched,
        ipAddress: sessions.ipAddress,
        geoCity: sessions.geoCity,
        geoRegion: sessions.geoRegion,
        geoCountry: sessions.geoCountry,
        geoLat: sessions.geoLat,
        geoLon: sessions.geoLon,
        playerName: sessions.playerName,
        deviceId: sessions.deviceId,
        product: sessions.product,
        device: sessions.device,
        platform: sessions.platform,
        quality: sessions.quality,
        isTranscode: sessions.isTranscode,
        videoDecision: sessions.videoDecision,
        audioDecision: sessions.audioDecision,
        bitrate: sessions.bitrate,
      })
      .from(sessions)
      .innerJoin(serverUsers, eq(sessions.serverUserId, serverUsers.id))
      .innerJoin(servers, eq(sessions.serverId, servers.id))
      .leftJoin(users, eq(serverUsers.userId, users.id))
      .where(eq(sessions.id, id))
      .limit(1);

    const row = sessionData[0];
    if (!row) {
      return reply.notFound('Session not found');
    }

    // Verify access (owners can see all servers)
    if (!hasServerAccess(authUser, row.serverId)) {
      return reply.forbidden('You do not have access to this session');
    }

    // Transform to nested format
    return {
      id: row.id,
      serverId: row.serverId,
      serverUserId: row.serverUserId,
      user: {
        id: row.serverUserId,
        username: row.username,
        thumbUrl: row.userThumb,
        identityName: row.identityName,
      },
      server: {
        id: row.serverId,
        name: row.serverName,
        type: row.serverType,
      },
      sessionKey: row.sessionKey,
      state: row.state,
      mediaType: row.mediaType,
      mediaTitle: row.mediaTitle,
      grandparentTitle: row.grandparentTitle,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
      year: row.year,
      thumbPath: row.thumbPath,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt,
      durationMs: row.durationMs,
      progressMs: row.progressMs,
      totalDurationMs: row.totalDurationMs,
      lastPausedAt: row.lastPausedAt,
      pausedDurationMs: row.pausedDurationMs,
      referenceId: row.referenceId,
      watched: row.watched,
      ipAddress: row.ipAddress,
      geoCity: row.geoCity,
      geoRegion: row.geoRegion,
      geoCountry: row.geoCountry,
      geoLat: row.geoLat,
      geoLon: row.geoLon,
      playerName: row.playerName,
      deviceId: row.deviceId,
      product: row.product,
      device: row.device,
      platform: row.platform,
      quality: row.quality,
      isTranscode: row.isTranscode,
      videoDecision: row.videoDecision,
      audioDecision: row.audioDecision,
      bitrate: row.bitrate,
    };
  });

  /**
   * POST /sessions/:id/terminate - Terminate a playback session
   *
   * Requires admin access. Sends a stop command to the media server
   * and logs the termination for auditing.
   */
  app.post('/:id/terminate', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = sessionIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid session ID');
    }

    const body = terminateSessionBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { id } = params.data;
    const { reason } = body.data;
    const authUser = request.user;

    // Only admins and owners can terminate sessions
    if (authUser.role !== 'owner' && authUser.role !== 'admin') {
      return reply.forbidden('Only administrators can terminate sessions');
    }

    // Verify the session exists and user has access to its server
    const session = await db
      .select({
        id: sessions.id,
        serverId: sessions.serverId,
        serverUserId: sessions.serverUserId,
        state: sessions.state,
      })
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);

    const sessionData = session[0];
    if (!sessionData) {
      return reply.notFound('Session not found');
    }

    if (!hasServerAccess(authUser, sessionData.serverId)) {
      return reply.forbidden('You do not have access to this server');
    }

    // Check if session is already stopped
    if (sessionData.state === 'stopped') {
      return reply.conflict('Session has already ended');
    }

    // Attempt termination
    const result = await terminateSession({
      sessionId: id,
      trigger: 'manual',
      triggeredByUserId: authUser.userId,
      reason,
    });

    if (!result.success) {
      app.log.error(
        { sessionId: id, error: result.error, terminationLogId: result.terminationLogId },
        'Failed to terminate session'
      );
      return reply.code(500).send({
        success: false,
        error: result.error,
        terminationLogId: result.terminationLogId,
      });
    }

    return {
      success: true,
      terminationLogId: result.terminationLogId,
      message: 'Stream termination command sent successfully',
    };
  });
};
