/**
 * Session routes - Query historical and active sessions
 *
 * Activity history is grouped by reference_id to show unique "plays" rather than
 * individual session records. Multiple pause/resume cycles for the same content
 * are aggregated into a single row with combined duration.
 */

import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { eq, sql, type SQL } from 'drizzle-orm';
import countries from 'i18n-iso-countries';
import countriesEn from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import {
  sessionQuerySchema,
  historyQuerySchema,
  historyAggregatesQuerySchema,
  filterOptionsQuerySchema,
  sessionIdParamSchema,
  sessionDetailQuerySchema,
  serverIdFilterSchema,
  terminateSessionBodySchema,
  CACHE_TTL,
  PLAYBACK_DECISIONS,
  REDIS_KEYS,
  type AuthUser,
  type ActiveSession,
  type HistorySessionResponse,
  type HistoryAggregates,
  type HistoryFilterOptions,
  type AutomationFilterOptions,
  type CountryOption,
  type HistoryAggregatesQueryInput,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, serverUsers, servers, users } from '../db/schema.js';
import { readSessionRow, readSessionRows, sessionRowsWhere } from '../db/sessions/row.js';
import {
  hasServerAccess,
  resolveServerIds,
  buildMultiServerFragment,
} from '../utils/serverFiltering.js';
import { representativeAccountOrderSql } from '../utils/representativeAccount.js';
import { compareNames } from '../utils/collation.js';
import { serverOrderBy } from '../utils/serverOrder.js';
import { isLocalSession, localSessionSql } from '../db/sessions/rules.js';
import { playbackDecisionSql, subtitleBurnInSql } from '../utils/playbackDecisionSql.js';
import { terminateSession } from '../services/termination.js';
import { getCacheService } from '../services/cache.js';
import {
  assertInScope,
  memberCacheSegment,
  scopeSessionsRaw,
  seesServerActivity,
  viewScope,
  type Scope,
} from '../lib/scope.js';

// Register English locale for country name lookups
countries.registerLocale(countriesEn);

/**
 * Result from building history filter conditions.
 * Returns null if user has no server access (caller should return empty result).
 */
type HistoryFilterResult = {
  conditions: ReturnType<typeof sql>[];
  whereClause: ReturnType<typeof sql>;
} | null;

// Display-only bound for the segments breakdown below; core aggregation has no such cap.
const CHAIN_WINDOW_DAYS = 30;
const CHAIN_WINDOW_INTERVAL = sql.raw(`INTERVAL '${CHAIN_WINDOW_DAYS} days'`);

/**
 * The filter window again on a join back to sessions. The join's own bounds come from a CTE,
 * so the planner can't drop chunks with them and plans every one; on a long history that
 * costs more than running the page. A play's first segment always sits inside the window.
 */
function windowBounds(startDate: Date | undefined, endDate: Date | undefined): SQL {
  return sql`${startDate ? sql`AND s.started_at >= ${startDate}` : sql``} ${endDate ? sql`AND s.started_at < ${endDate}` : sql``}`;
}

function buildWhereClause(conditions: ReturnType<typeof sql>[]): ReturnType<typeof sql> {
  return conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
}

/**
 * Build WHERE clause conditions for history queries.
 * Shared between /history and /history/aggregates endpoints.
 *
 * @returns null if user has no server access (caller should return empty result)
 */
function buildHistoryFilterConditions(
  params: HistoryAggregatesQueryInput,
  authUser: AuthUser,
  scope: Scope
): HistoryFilterResult {
  const {
    serverUserIds,
    serverId,
    serverIds: rawServerIds,
    state,
    mediaTypes,
    startDate,
    endDate,
    search,
    platforms,
    product,
    device,
    playerName,
    ipAddress,
    geoCountries,
    geoCity,
    geoRegion,
    geoCityMissing,
    geoRegionMissing,
    network,
    transcodeDecisions,
    subtitleBurnIn,
    watched,
    excludeShortSessions,
  } = params;

  const conditions: ReturnType<typeof sql>[] = [];

  // Resolve effective server IDs (handles owner bypass + access intersection)
  const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds, { strict: false });
  if (resolvedIds?.length === 0) {
    return null; // No accessible servers after intersection
  }
  if (resolvedIds !== undefined) {
    if (resolvedIds.length === 1) {
      conditions.push(sql`s.server_id = ${resolvedIds[0]}`);
    } else {
      const ids = resolvedIds.map((id) => sql`${id}`);
      conditions.push(sql`s.server_id IN (${sql.join(ids, sql`, `)})`);
    }
  }
  const scoped = scopeSessionsRaw(scope, sql`s.server_user_id`);
  if (scoped) conditions.push(scoped);

  if (serverUserIds && serverUserIds.length > 0) {
    const ids = serverUserIds as string[];
    if (ids.length === 1) {
      conditions.push(sql`s.server_user_id = ${ids[0]}`);
    } else {
      const userIdList = ids.map((id) => sql`${id}`);
      conditions.push(sql`s.server_user_id IN (${sql.join(userIdList, sql`, `)})`);
    }
  }
  if (state) conditions.push(sql`s.state = ${state}`);
  if (mediaTypes && mediaTypes.length > 0) {
    const types = mediaTypes as string[];
    if (types.length === 1) {
      conditions.push(sql`s.media_type = ${types[0]}`);
    } else {
      const mediaTypeList = types.map((t) => sql`${t}`);
      conditions.push(sql`s.media_type IN (${sql.join(mediaTypeList, sql`, `)})`);
    }
  } else {
    conditions.push(sql`s.media_type <> 'trailer'`);
  }
  if (startDate) conditions.push(sql`s.started_at >= ${startDate}`);
  if (endDate) conditions.push(sql`s.started_at < ${endDate}`);

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

  if (platforms && platforms.length > 0) {
    const plats = platforms as string[];
    if (plats.length === 1) {
      conditions.push(sql`s.platform = ${plats[0]}`);
    } else {
      const platformList = plats.map((p) => sql`${p}`);
      conditions.push(sql`s.platform IN (${sql.join(platformList, sql`, `)})`);
    }
  }
  if (product) conditions.push(sql`s.product = ${product}`);
  if (device) conditions.push(sql`s.device = ${device}`);
  if (playerName) conditions.push(sql`s.player_name ILIKE ${`%${playerName}%`}`);

  if (ipAddress) conditions.push(sql`s.ip_address = ${ipAddress}`);
  if (geoCountries && geoCountries.length > 0) {
    const countries = geoCountries as string[];
    if (countries.length === 1) {
      conditions.push(sql`s.geo_country = ${countries[0]}`);
    } else {
      const countryList = countries.map((c) => sql`${c}`);
      conditions.push(sql`s.geo_country IN (${sql.join(countryList, sql`, `)})`);
    }
  }
  if (geoCity) conditions.push(sql`s.geo_city = ${geoCity}`);
  if (geoRegion) conditions.push(sql`s.geo_region = ${geoRegion}`);
  if (geoCityMissing) conditions.push(sql`s.geo_city IS NULL`);
  if (geoRegionMissing) conditions.push(sql`s.geo_region IS NULL`);
  if (network === 'local') conditions.push(localSessionSql('s'));
  if (network === 'remote') conditions.push(sql`NOT ${localSessionSql('s')}`);

  if (
    transcodeDecisions &&
    transcodeDecisions.length > 0 &&
    transcodeDecisions.length < PLAYBACK_DECISIONS.length
  ) {
    const decisionList = transcodeDecisions.map((d) => sql`${d}`);
    conditions.push(sql`${playbackDecisionSql('s')} IN (${sql.join(decisionList, sql`, `)})`);
  }

  // Status filters
  if (watched !== undefined) conditions.push(sql`s.watched = ${watched}`);
  if (subtitleBurnIn !== undefined)
    conditions.push(subtitleBurnIn ? subtitleBurnInSql('s') : sql`NOT ${subtitleBurnInSql('s')}`);
  if (excludeShortSessions) conditions.push(sql`s.short_session = false`);

  return { conditions, whereClause: buildWhereClause(conditions) };
}

/**
 * Build a short hash fingerprint from filter parameters for cache keys. Dates count to the
 * minute: a preset window starts at the moment the page opened, so at full precision no two
 * visits shared a key and the cache never hit.
 */
function buildCacheFingerprint(params: Record<string, unknown>): string {
  // Sort keys for stable hashing regardless of parameter order
  const sorted = Object.keys(params)
    .filter((k) => k !== 'cursor' && k !== 'pageSize')
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const val = params[key];
      if (val instanceof Date) {
        acc[key] = val.toISOString().slice(0, 16);
      } else if (val !== undefined && val !== null && val !== '') {
        acc[key] = Array.isArray(val) ? val.slice().sort() : val;
      }
      return acc;
    }, {});
  const raw = JSON.stringify(sorted);
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const readSessions = { preHandler: [app.requirePermission('sessions', 'read')] };
  const readHistory = { preHandler: [app.requirePermission('history', 'read')] };
  const terminateSessions = { preHandler: [app.requirePermission('sessions', 'terminate')] };
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
  app.get('/', readSessions, async (request, reply) => {
    const query = sessionQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page, pageSize, serverUserId, serverId, state, mediaType, startDate, endDate } =
      query.data;

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

    const scoped = scopeSessionsRaw(request.scope, sql`s.server_user_id`);
    if (scoped) conditions.push(scoped);

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
    } else {
      conditions.push(sql`s.media_type <> 'trailer'`);
    }

    if (startDate) {
      conditions.push(sql`s.started_at >= ${startDate}`);
    }

    if (endDate) {
      conditions.push(sql`s.started_at < ${endDate}`);
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
          s.artist_name,
          s.album_name,
          s.thumb_path,
          s.media_id,
          s.show_media_id,
          s.reference_id,
          s.ip_address,
          s.geo_city,
          s.geo_region,
          s.geo_country,
          s.geo_continent,
          s.geo_postal,
          s.geo_lat,
          s.geo_lon,
          s.geo_asn_number,
          s.geo_asn_organization,
          ${localSessionSql('s')} AS is_local,
          s.player_name,
          s.device_id,
          s.product,
          s.device,
          s.platform,
          s.quality,
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
          s.subtitle_info
        FROM grouped_sessions gs
        -- gs.started_at is not a planner-time constant; the InitPlan bounds are what let
        -- TimescaleDB exclude chunks at runtime
        JOIN sessions s ON s.id = gs.first_session_id AND s.started_at = gs.started_at
          AND s.started_at >= (SELECT MIN(started_at) FROM grouped_sessions)
          AND s.started_at <= (SELECT MAX(started_at) FROM grouped_sessions)
          ${windowBounds(startDate, endDate)}
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
        artist_name: string | null;
        album_name: string | null;
        thumb_path: string | null;
        media_id: string | null;
        show_media_id: string | null;
        reference_id: string | null;
        ip_address: string | null;
        geo_city: string | null;
        geo_region: string | null;
        geo_country: string | null;
        geo_continent: string | null;
        geo_postal: string | null;
        geo_lat: number | null;
        geo_lon: number | null;
        geo_asn_number: number | null;
        geo_asn_organization: string | null;
        is_local: boolean;
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
        source_video_codec: string | null;
        source_audio_codec: string | null;
        source_audio_channels: number | null;
        source_video_width: number | null;
        source_video_height: number | null;
        source_video_details: Record<string, unknown> | null;
        source_audio_details: Record<string, unknown> | null;
        stream_video_codec: string | null;
        stream_audio_codec: string | null;
        stream_video_details: Record<string, unknown> | null;
        stream_audio_details: Record<string, unknown> | null;
        transcode_info: Record<string, unknown> | null;
        subtitle_info: Record<string, unknown> | null;
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
      artistName: row.artist_name,
      albumName: row.album_name,
      thumbPath: row.thumb_path,
      mediaId: row.media_id,
      showMediaId: row.show_media_id,
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      stoppedAt: row.stopped_at ? new Date(row.stopped_at).toISOString() : null,
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
      geoContinent: row.geo_continent,
      geoPostal: row.geo_postal,
      geoLat: row.geo_lat,
      geoLon: row.geo_lon,
      geoAsnNumber: row.geo_asn_number,
      geoAsnOrganization: row.geo_asn_organization,
      isLocal: row.is_local === true,
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
      // Stream detail fields
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
  app.get('/history', readHistory, async (request, reply) => {
    const query = historyQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { cursor, pageSize, orderBy, orderDir } = query.data;

    const authUser = request.user;

    // Build WHERE conditions using shared helper
    const filterResult = buildHistoryFilterConditions(query.data, authUser, request.scope);
    if (!filterResult) {
      // No server access - return empty result
      return { data: [], hasMore: false } satisfies HistorySessionResponse;
    }
    const { conditions } = filterResult;

    // Cursor: `${startedAtMs}_${playId}`, plus `_${hex(JSON sort key)}` for the
    // Content and Duration sorts so the keyset comparison starts from the key.
    let cursorTime: Date | null = null;
    let cursorId: string | null = null;
    let cursorKey: string | number | null = null;
    if (cursor) {
      const [timeStr, id, keyHex, ...extra] = cursor.split('_');
      const parsedTime = timeStr ? Number(timeStr) : NaN;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        !timeStr ||
        !id ||
        extra.length > 0 ||
        !Number.isInteger(parsedTime) ||
        !uuidRegex.test(id)
      ) {
        return reply.badRequest('Invalid cursor');
      }
      if (orderBy !== 'startedAt') {
        if (!keyHex || !/^[0-9a-f]*$/.test(keyHex)) return reply.badRequest('Invalid cursor');
        let parsedKey: unknown;
        try {
          parsedKey = JSON.parse(Buffer.from(keyHex, 'hex').toString('utf8'));
        } catch {
          return reply.badRequest('Invalid cursor');
        }
        if (orderBy === 'durationMs') {
          const asNumber = Number(parsedKey);
          if (!Number.isInteger(asNumber)) return reply.badRequest('Invalid cursor');
          cursorKey = asNumber;
        } else if (typeof parsedKey === 'string') {
          cursorKey = parsedKey;
        } else {
          return reply.badRequest('Invalid cursor');
        }
      } else if (keyHex !== undefined) {
        return reply.badRequest('Invalid cursor');
      }
      cursorTime = new Date(parsedTime);
      cursorId = id;
    }

    const dir = orderDir === 'desc' ? sql`DESC` : sql`ASC`;
    const playIdTiebreak = sql`COALESCE(s.reference_id, s.id)::text`;
    // The key follows the title the table shows: an episode keys on its show's
    // media row, every other type on its own row, and a session with no linked
    // row falls back to that shown title (the show for an episode, else its own).
    const sortKeyExpr =
      orderBy === 'durationMs'
        ? sql`SUM(COALESCE(s.duration_ms, 0))`
        : orderBy === 'mediaTitle'
          ? sql`COALESCE(MIN(m.sort_title), lower(MIN(CASE WHEN s.media_type = 'episode' AND s.grandparent_title <> '' THEN s.grandparent_title ELSE s.media_title END)))`
          : null;
    const mediaJoin =
      orderBy === 'mediaTitle'
        ? sql`LEFT JOIN media m ON m.id = CASE WHEN s.media_type = 'episode' THEN s.show_media_id ELSE s.media_id END`
        : sql``;
    // Every key in one direction so the keyset tuple comparison below is exact.
    const orderByExpr = sortKeyExpr
      ? sql`${sortKeyExpr} ${dir}, MIN(s.started_at) ${dir}, ${playIdTiebreak} ${dir}`
      : sql`MIN(s.started_at) ${dir}, ${playIdTiebreak} ${dir}`;

    const cursorOp = orderDir === 'desc' ? sql`<` : sql`>`;
    const cursorKeyParam =
      orderBy === 'durationMs' ? sql`${cursorKey}::bigint` : sql`${cursorKey}::text`;
    const havingClause =
      cursorTime && cursorId
        ? sortKeyExpr
          ? sql`HAVING (${sortKeyExpr}, MIN(s.started_at), ${playIdTiebreak}) ${cursorOp} (${cursorKeyParam}, ${cursorTime}, ${cursorId})`
          : sql`HAVING (MIN(s.started_at), ${playIdTiebreak}) ${cursorOp} (${cursorTime}, ${cursorId})`
        : sql``;

    // Full per-play aggregation is scoped to this page's play ids and to started_at at or
    // after the page's earliest play (a segment can never start before its own play's start,
    // so this lower bound never drops a segment that HEAD's unbounded aggregation would count).
    const groupedConditions = [
      ...conditions,
      sql`COALESCE(s.reference_id, s.id) IN (SELECT play_id FROM history_page_ids)`,
      sql`s.started_at >= (SELECT MIN(started_at) FROM history_page_ids)`,
    ];
    const { startDate, endDate } = query.data;
    const headWindow = windowBounds(startDate, endDate);
    const segmentWindow = startDate
      ? sql`AND s2.started_at >= ${startDate}::timestamptz - ${CHAIN_WINDOW_INTERVAL}`
      : sql``;

    const result = await db.execute(sql`
        WITH history_page AS MATERIALIZED (
          SELECT
            COALESCE(s.reference_id, s.id) as play_id,
            MIN(s.started_at) as started_at,
            ${sortKeyExpr ?? sql`NULL`} as sort_key,
            ROW_NUMBER() OVER (ORDER BY ${orderByExpr}) as rn
          FROM sessions s
          ${mediaJoin}
          ${buildWhereClause(conditions)}
          GROUP BY COALESCE(s.reference_id, s.id)
          ${havingClause}
          ORDER BY ${orderByExpr}
          LIMIT ${pageSize + 1}
        ),
        history_page_ids AS MATERIALIZED (
          SELECT play_id, started_at, sort_key, rn FROM history_page WHERE rn <= ${pageSize}
        ),
        grouped_sessions AS (
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
          ${buildWhereClause(groupedConditions)}
          GROUP BY COALESCE(s.reference_id, s.id)
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
          lat.segments,
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
          s.artist_name,
          s.album_name,
          s.thumb_path,
          s.media_id,
          s.show_media_id,
          s.reference_id,
          s.ip_address,
          s.geo_city,
          s.geo_region,
          s.geo_country,
          s.geo_continent,
          s.geo_postal,
          s.geo_lat,
          s.geo_lon,
          s.geo_asn_number,
          s.geo_asn_organization,
          ${localSessionSql('s')} AS is_local,
          s.player_name,
          s.device_id,
          s.product,
          s.device,
          s.platform,
          s.quality,
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
          hp.sort_key,
          (SELECT count(*) FROM history_page)::int as page_candidate_count
        FROM grouped_sessions gs
        JOIN history_page_ids hp ON hp.play_id = gs.play_id
        -- gs.started_at is not a planner-time constant; the InitPlan bounds are what let
        -- TimescaleDB exclude chunks at runtime
        JOIN sessions s ON s.id = gs.first_session_id AND s.started_at = gs.started_at
          AND s.started_at >= (SELECT MIN(started_at) FROM history_page_ids)
          AND s.started_at <= (SELECT MAX(started_at) FROM history_page_ids)
          ${headWindow}
        JOIN server_users su ON su.id = s.server_user_id
        JOIN servers sv ON sv.id = s.server_id
        LEFT JOIN users u ON u.id = su.user_id
        LEFT JOIN LATERAL (
          SELECT json_agg(sub ORDER BY sub.started_at) AS segments
          FROM (
            SELECT s2.started_at, s2.stopped_at, s2.duration_ms, s2.paused_duration_ms
            FROM sessions s2
            WHERE COALESCE(s2.reference_id, s2.id) = gs.play_id
              AND gs.segment_count > 1
              AND s2.started_at >= gs.started_at - ${CHAIN_WINDOW_INTERVAL}
              ${segmentWindow}
            ORDER BY s2.started_at
            LIMIT 20
          ) sub
        ) lat ON true
        ORDER BY hp.rn
      `);

    const firstRow = result.rows[0] as { page_candidate_count: number } | undefined;
    const hasMore = firstRow ? Number(firstRow.page_candidate_count) > pageSize : false;

    if (result.rows.length === 0) {
      return { data: [], hasMore: false } satisfies HistorySessionResponse;
    }

    // Transform results
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
        segments:
          | {
              started_at: string;
              stopped_at: string | null;
              duration_ms: string | null;
              paused_duration_ms: string | null;
            }[]
          | null;
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
        artist_name: string | null;
        album_name: string | null;
        thumb_path: string | null;
        media_id: string | null;
        show_media_id: string | null;
        reference_id: string | null;
        ip_address: string | null;
        geo_city: string | null;
        geo_region: string | null;
        geo_country: string | null;
        geo_continent: string | null;
        geo_postal: string | null;
        geo_lat: number | null;
        geo_lon: number | null;
        geo_asn_number: number | null;
        geo_asn_organization: string | null;
        is_local: boolean;
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
        source_video_codec: string | null;
        source_audio_codec: string | null;
        source_audio_channels: number | null;
        source_video_width: number | null;
        source_video_height: number | null;
        source_video_details: Record<string, unknown> | null;
        source_audio_details: Record<string, unknown> | null;
        stream_video_codec: string | null;
        stream_audio_codec: string | null;
        stream_video_details: Record<string, unknown> | null;
        stream_audio_details: Record<string, unknown> | null;
        transcode_info: Record<string, unknown> | null;
        subtitle_info: Record<string, unknown> | null;
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
      artistName: row.artist_name,
      albumName: row.album_name,
      thumbPath: row.thumb_path,
      mediaId: row.media_id,
      showMediaId: row.show_media_id,
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      stoppedAt: row.stopped_at ? new Date(row.stopped_at).toISOString() : null,
      durationMs: row.duration_ms ? Number(row.duration_ms) : null,
      pausedDurationMs: row.paused_duration_ms ? Number(row.paused_duration_ms) : null,
      progressMs: row.progress_ms,
      totalDurationMs: row.total_duration_ms,
      referenceId: row.reference_id,
      watched: row.watched,
      segmentCount: Number(row.segment_count),
      segments: row.segments?.map((seg) => ({
        startedAt: new Date(seg.started_at).toISOString(),
        stoppedAt: seg.stopped_at ? new Date(seg.stopped_at).toISOString() : null,
        durationMs: seg.duration_ms != null ? Number(seg.duration_ms) : null,
        pausedDurationMs: seg.paused_duration_ms != null ? Number(seg.paused_duration_ms) : 0,
      })),
      ipAddress: row.ip_address,
      geoCity: row.geo_city,
      geoRegion: row.geo_region,
      geoCountry: row.geo_country,
      geoContinent: row.geo_continent,
      geoPostal: row.geo_postal,
      geoLat: row.geo_lat,
      geoLon: row.geo_lon,
      geoAsnNumber: row.geo_asn_number,
      geoAsnOrganization: row.geo_asn_organization,
      isLocal: row.is_local === true,
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
      // Stream detail fields
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
    }));

    // Generate next cursor
    const lastSession = sessionData[sessionData.length - 1];
    const lastRow = result.rows[result.rows.length - 1] as { sort_key: string | number | null };
    const nextCursor =
      hasMore && lastSession?.startedAt
        ? [
            `${new Date(lastSession.startedAt).getTime()}`,
            lastSession.id,
            ...(orderBy === 'startedAt'
              ? []
              : [Buffer.from(JSON.stringify(lastRow.sort_key)).toString('hex')]),
          ].join('_')
        : undefined;

    const response: HistorySessionResponse = {
      // Cast through unknown since we're serializing dates to ISO strings for the wire format
      data: sessionData as unknown as HistorySessionResponse['data'],
      nextCursor,
      hasMore,
    };

    return response;
  });

  /**
   * GET /sessions/history/aggregates - Get aggregate stats for filtered history
   *
   * Returns only aggregate statistics (total plays, watch time, unique users/content)
   * without the actual session data. This endpoint is called separately from /history
   * so that sorting changes don't trigger a refetch of these stats (since aggregates
   * are not affected by sort order).
   */
  app.get('/history/aggregates', readHistory, async (request, reply) => {
    const query = historyAggregatesQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const authUser = request.user;
    const scope = await viewScope(request);

    // Build WHERE clause using shared helper (also enforces server access via resolveServerIds)
    const filterResult = buildHistoryFilterConditions(query.data, authUser, scope);
    if (!filterResult) {
      // No server access - return empty result
      const emptyAggregates: HistoryAggregates = {
        totalWatchTimeMs: 0,
        listenTimeMs: 0,
        playCount: 0,
        uniqueUsers: 0,
        uniqueContent: 0,
      };
      return emptyAggregates;
    }
    const { whereClause } = filterResult;

    const resolvedIds = resolveServerIds(authUser, query.data.serverId, query.data.serverIds, {
      strict: false,
    });
    const cacheKey = `${REDIS_KEYS.HISTORY_AGGREGATES(
      buildCacheFingerprint({ ...query.data, scope, resolvedIds })
    )}${memberCacheSegment(scope)}`;
    const cached = await app.redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as HistoryAggregates;

    // Unique Titles KPI. Single-server: COUNT(DISTINCT media_title), matching main exactly.
    // Multi-server: dedupe by canonical media identity - a merged-loser id folds to its
    // winner via media.merged_into_id (mirrors value_rollup's alias fold in catalog.ts) -
    // falling back to an ASCII-stripped title+year key, then the raw title (catches non-Latin
    // titles the strip empties out), then the per-server rating key for titleless sessions.
    // A session with none of those resolves to NULL, which COUNT(DISTINCT) already excludes.
    const singleServer = resolvedIds?.length === 1;
    const mediaJoinFragment = singleServer ? sql`` : sql`LEFT JOIN media am ON am.id = s.media_id`;
    const uniqueContentExpr = singleServer
      ? sql`COUNT(DISTINCT s.media_title)`
      : sql`COUNT(DISTINCT
          COALESCE(
            COALESCE(am.merged_into_id, s.media_id)::text,
            'title:' || NULLIF(LOWER(REGEXP_REPLACE(COALESCE(s.media_title, ''), '[^a-zA-Z0-9]', '', 'g')), '') || ':' || COALESCE(s.year::text, ''),
            'raw:' || NULLIF(s.media_title, ''),
            'rk:' || s.server_id || ':' || NULLIF(s.rating_key, '')
          )
        )`;

    // uniqueUsers is counted by identity (server_users.user_id), not by
    // account, so a person merged across two servers in the filtered set
    // counts once - consistent with unique_content's cross-server dedup.
    const aggregateResult = await db.execute(sql`
      SELECT
        COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as play_count,
        COALESCE(SUM(s.duration_ms), 0)::bigint as total_watch_time_ms,
        COALESCE(SUM(s.duration_ms) FILTER (WHERE s.media_type = 'track'), 0)::bigint as listen_time_ms,
        COUNT(DISTINCT su_agg.user_id)::int as unique_users,
        ${uniqueContentExpr}::int as unique_content
      FROM sessions s
      JOIN server_users su_agg ON su_agg.id = s.server_user_id
      ${mediaJoinFragment}
      ${whereClause}
    `);

    const result = aggregateResult.rows[0] as {
      play_count: number;
      total_watch_time_ms: string;
      listen_time_ms: string;
      unique_users: number;
      unique_content: number;
    };

    const aggregates: HistoryAggregates = {
      totalWatchTimeMs: Number(result.total_watch_time_ms),
      listenTimeMs: Number(result.listen_time_ms),
      playCount: result.play_count,
      uniqueUsers: result.unique_users,
      uniqueContent: result.unique_content,
    };

    await app.redis.setex(cacheKey, CACHE_TTL.HISTORY_AGGREGATES, JSON.stringify(aggregates));
    return aggregates;
  });

  /**
   * GET /sessions/filter-options - Get available filter values for dropdowns
   *
   * Returns distinct values for platforms, products, devices, countries, cities,
   * users, and optionally servers to populate filter dropdowns.
   *
   * Query params:
   * - serverId: Filter by specific server
   * - startDate: Filter by start date (ISO 8601)
   * - endDate: Filter by end date, exclusive (ISO 8601)
   * - includeAllCountries: When true, returns all countries with hasSessions indicator
   *                        (for rules builder). When false/omitted, returns only
   *                        countries with sessions (for history page).
   */
  app.get('/filter-options', readHistory, async (request, reply) => {
    const query = filterOptionsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const {
      serverId,
      serverIds: rawServerIds,
      startDate,
      endDate,
      includeAllCountries,
    } = query.data;

    const authUser = request.user;

    // Resolve effective server IDs (handles owner bypass + access intersection)
    const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds, { strict: false });
    if (resolvedIds?.length === 0) {
      // No accessible servers - return empty filter options
      if (includeAllCountries) {
        const emptyRulesResponse: AutomationFilterOptions = {
          platforms: [],
          products: [],
          devices: [],
          countries: [],
          cities: [],
          users: [],
          servers: [],
        };
        return emptyRulesResponse;
      }
      const emptyResponse: HistoryFilterOptions = {
        platforms: [],
        products: [],
        devices: [],
        countries: [],
        cities: [],
        users: [],
      };
      return emptyResponse;
    }

    // Check cache
    const cacheService = getCacheService();
    const filterScopeHash = buildCacheFingerprint({
      userId: authUser.userId,
      resolvedIds: resolvedIds ? [...resolvedIds].sort() : null,
      startDate,
      endDate,
      includeAllCountries,
    });
    if (cacheService) {
      const cached = await cacheService.getFilterOptions(authUser.userId, filterScopeHash);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    // Build server access conditions from resolved IDs
    const serverConditions: ReturnType<typeof sql>[] = [];
    if (resolvedIds !== undefined) {
      if (resolvedIds.length === 1) {
        serverConditions.push(sql`s.server_id = ${resolvedIds[0]}`);
      } else {
        const serverIdList = resolvedIds.map((id) => sql`${id}`);
        serverConditions.push(sql`s.server_id IN (${sql.join(serverIdList, sql`, `)})`);
      }
    }

    const scoped = scopeSessionsRaw(request.scope, sql`s.server_user_id`);
    if (scoped) serverConditions.push(scoped);
    if (startDate) {
      serverConditions.push(sql`s.started_at >= ${startDate}`);
    }
    if (endDate) {
      serverConditions.push(sql`s.started_at < ${endDate}`);
    }

    // Helper to build WHERE clause with additional conditions
    const buildWhereWithCondition = (extraCondition: ReturnType<typeof sql>) => {
      const allConditions = [...serverConditions, extraCondition];
      return sql`WHERE ${sql.join(allConditions, sql` AND `)}`;
    };

    // Query all filter options in parallel
    const [
      platformsResult,
      productsResult,
      devicesResult,
      countriesResult,
      citiesResult,
      usersResult,
      serversResult,
    ] = await Promise.all([
      // Platforms
      db.execute(sql`
            SELECT platform as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${buildWhereWithCondition(sql`platform IS NOT NULL`)}
            GROUP BY platform
            ORDER BY count DESC
            LIMIT 50
          `),
      // Products
      db.execute(sql`
            SELECT product as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${buildWhereWithCondition(sql`product IS NOT NULL`)}
            GROUP BY product
            ORDER BY count DESC
            LIMIT 50
          `),
      // Devices
      db.execute(sql`
            SELECT device as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${buildWhereWithCondition(sql`device IS NOT NULL`)}
            GROUP BY device
            ORDER BY count DESC
            LIMIT 50
          `),
      // Countries (codes with session count)
      db.execute(sql`
            SELECT geo_country as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${buildWhereWithCondition(sql`geo_country IS NOT NULL`)}
            GROUP BY geo_country
            ORDER BY count DESC
            LIMIT 250
          `),
      // Cities
      db.execute(sql`
            SELECT geo_city as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
            FROM sessions s
            ${buildWhereWithCondition(sql`geo_city IS NOT NULL`)}
            GROUP BY geo_city
            ORDER BY count DESC
            LIMIT 100
          `),
      // Users - one row per identity (merged accounts collapse to a representative),
      // filtered to identities with sessions matching current filter context.
      db.execute(sql`
        WITH representative AS (
          SELECT DISTINCT ON (su.user_id) su.id, su.user_id
          FROM server_users su
          INNER JOIN users u ON u.id = su.user_id
          WHERE true ${
            serverConditions.length > 0
              ? sql`AND su.id IN (
                  SELECT DISTINCT s.server_user_id
                  FROM sessions s
                  WHERE ${sql.join(serverConditions, sql` AND `)}
                )`
              : sql``
          }
          ORDER BY su.user_id, ${representativeAccountOrderSql('su')}
        )
        SELECT
          su.id,
          su.username,
          su.thumb_url,
          su.server_id,
          u.name as identity_name,
          COALESCE(
            (SELECT ARRAY_AGG(su2.id ORDER BY su2.id)
             FROM server_users su2
             WHERE su2.user_id = su.user_id
             ${buildMultiServerFragment(resolvedIds, 'su2.server_id')}
            ),
            ARRAY[su.id]
          ) AS server_user_ids
        FROM representative rep
        JOIN server_users su ON su.id = rep.id
        LEFT JOIN users u ON u.id = su.user_id
        ORDER BY LOWER(COALESCE(u.name, su.username))
      `),
      // Servers (for rules builder)
      db
        .select({ id: servers.id, name: servers.name, type: servers.type })
        .from(servers)
        .orderBy(...serverOrderBy()),
    ]);

    // Transform users result
    const usersData = (
      usersResult.rows as unknown as {
        id: string;
        username: string;
        thumb_url: string | null;
        server_id: string;
        identity_name: string | null;
        server_user_ids: string[] | null;
      }[]
    ).map((row) => ({
      id: row.id,
      username: row.username,
      thumbUrl: row.thumb_url,
      serverId: row.server_id,
      identityName: row.identity_name,
      serverUserIds: row.server_user_ids ?? [row.id],
    }));
    usersData.sort(
      (a, b) =>
        compareNames(a.identityName ?? a.username, b.identityName ?? b.username) ||
        a.id.localeCompare(b.id)
    );

    const serversData = serversResult
      .filter((row) => request.scope === 'all' || authUser.serverIds.includes(row.id))
      .map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
      }));

    // Get countries that have sessions
    const countriesWithSessions = new Set(
      (countriesResult.rows as { value: string }[]).map((r) => r.value)
    );

    // When includeAllCountries is true, return all countries with hasSessions indicator
    if (includeAllCountries) {
      // Get all country codes and names from i18n-iso-countries
      const allCountryNames = countries.getNames('en');
      const allCountries: CountryOption[] = Object.entries(allCountryNames)
        .map(([code, name]) => ({
          code,
          name,
          hasSessions: countriesWithSessions.has(code),
        }))
        .sort((a, b) => {
          // Sort: countries with sessions first, then alphabetically by name
          if (a.hasSessions !== b.hasSessions) {
            return a.hasSessions ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

      const rulesResponse: AutomationFilterOptions = {
        platforms: platformsResult.rows as unknown as HistoryFilterOptions['platforms'],
        products: productsResult.rows as unknown as HistoryFilterOptions['products'],
        devices: devicesResult.rows as unknown as HistoryFilterOptions['devices'],
        countries: allCountries,
        cities: citiesResult.rows as unknown as HistoryFilterOptions['cities'],
        users: usersData,
        servers: serversData,
      };

      // Cache the result
      if (cacheService) {
        void cacheService.setFilterOptions(
          authUser.userId,
          filterScopeHash,
          JSON.stringify(rulesResponse)
        );
      }

      return rulesResponse;
    }

    // Default response for history page (only countries with sessions)
    const response: HistoryFilterOptions = {
      platforms: platformsResult.rows as unknown as HistoryFilterOptions['platforms'],
      products: productsResult.rows as unknown as HistoryFilterOptions['products'],
      devices: devicesResult.rows as unknown as HistoryFilterOptions['devices'],
      countries: countriesResult.rows as unknown as HistoryFilterOptions['countries'],
      cities: citiesResult.rows as unknown as HistoryFilterOptions['cities'],
      users: usersData,
      servers: serversData,
    };

    // Cache the result
    if (cacheService) {
      void cacheService.setFilterOptions(
        authUser.userId,
        filterScopeHash,
        JSON.stringify(response)
      );
    }

    return response;
  });

  /**
   * GET /sessions/active - Get currently active streams from cache
   */
  app.get('/active', readSessions, async (request, _reply) => {
    const authUser = request.user;

    // Parse optional server filter (supports both legacy serverId and serverIds[])
    const query = serverIdFilterSchema.safeParse(request.query);
    const { serverId: legacyServerId, serverIds: rawServerIds } = query.success
      ? query.data
      : { serverId: undefined, serverIds: undefined };
    const resolvedIds = resolveServerIds(authUser, legacyServerId, rawServerIds, { strict: false });

    // Get active sessions from atomic SET-based cache
    const cacheService = getCacheService();
    let activeSessions: ActiveSession[] = [];

    if (cacheService) {
      activeSessions = await cacheService.getAllActiveSessions();
    }

    // Filter by resolved server IDs
    if (resolvedIds !== undefined) {
      const idSet = new Set(resolvedIds);
      activeSessions = activeSessions.filter((s) => idSet.has(s.serverId));
    }
    // else: owner with no filter, keep all

    const scope = await viewScope(request);
    if (scope === 'all') return { data: activeSessions };
    const own = new Set(scope.serverUserIds);
    const mine = activeSessions.filter((s) => own.has(s.serverUserId));
    // The count is a member's view of others; an owner asking for self wants only their streams.
    if (request.scope === 'all' || !(await seesServerActivity(request.scope))) {
      return { data: mine };
    }
    return { data: mine, othersActive: activeSessions.length - mine.length };
  });

  /**
   * GET /sessions/:id - Get detailed info for a specific session
   */
  app.get('/:id', readSessions, async (request, reply) => {
    const params = sessionIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid session ID');
    }
    const detailQuery = sessionDetailQuerySchema.safeParse(request.query);
    if (!detailQuery.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Try cache first for active sessions
    const cached = await app.redis.get(REDIS_KEYS.SESSION_BY_ID(id));
    if (cached) {
      try {
        const activeSession = JSON.parse(cached) as ActiveSession;
        // Verify access (owners can see all servers)
        if (
          hasServerAccess(authUser, activeSession.serverId) &&
          assertInScope(request.scope, activeSession.serverUserId)
        ) {
          // Return ActiveSession directly - both types now use nested user/server
          return activeSession;
        }
      } catch {
        // Fall through to DB
      }
    }

    // Query from database using manual JOINs then transform to nested format
    const row = await readSessionRow(id, detailQuery.data.startedAt, (where) =>
      db
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
          artistName: sessions.artistName,
          albumName: sessions.albumName,
          thumbPath: sessions.thumbPath,
          mediaId: sessions.mediaId,
          showMediaId: sessions.showMediaId,
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
          geoAsnNumber: sessions.geoAsnNumber,
          geoAsnOrganization: sessions.geoAsnOrganization,
          isLocal: sessions.isLocal,
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
          // Stream detail columns
          sourceVideoCodec: sessions.sourceVideoCodec,
          sourceAudioCodec: sessions.sourceAudioCodec,
          sourceAudioChannels: sessions.sourceAudioChannels,
          sourceVideoWidth: sessions.sourceVideoWidth,
          sourceVideoHeight: sessions.sourceVideoHeight,
          sourceVideoDetails: sessions.sourceVideoDetails,
          sourceAudioDetails: sessions.sourceAudioDetails,
          streamVideoCodec: sessions.streamVideoCodec,
          streamAudioCodec: sessions.streamAudioCodec,
          streamVideoDetails: sessions.streamVideoDetails,
          streamAudioDetails: sessions.streamAudioDetails,
          transcodeInfo: sessions.transcodeInfo,
          subtitleInfo: sessions.subtitleInfo,
        })
        .from(sessions)
        .innerJoin(serverUsers, eq(sessions.serverUserId, serverUsers.id))
        .innerJoin(servers, eq(sessions.serverId, servers.id))
        .leftJoin(users, eq(serverUsers.userId, users.id))
        .where(where)
        .limit(1)
        .then((rows) => rows[0])
    );
    // Out of scope answers exactly like a missing id, so a member cannot probe for others' rows.
    if (!row || !assertInScope(request.scope, row.serverUserId)) {
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
      artistName: row.artistName,
      albumName: row.albumName,
      thumbPath: row.thumbPath,
      mediaId: row.mediaId,
      showMediaId: row.showMediaId,
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
      geoAsnNumber: row.geoAsnNumber,
      geoAsnOrganization: row.geoAsnOrganization,
      isLocal: isLocalSession(row),
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
      // Stream detail fields
      sourceVideoCodec: row.sourceVideoCodec,
      sourceAudioCodec: row.sourceAudioCodec,
      sourceAudioChannels: row.sourceAudioChannels,
      sourceVideoWidth: row.sourceVideoWidth,
      sourceVideoHeight: row.sourceVideoHeight,
      sourceVideoDetails: row.sourceVideoDetails,
      sourceAudioDetails: row.sourceAudioDetails,
      streamVideoCodec: row.streamVideoCodec,
      streamAudioCodec: row.streamAudioCodec,
      streamVideoDetails: row.streamVideoDetails,
      streamAudioDetails: row.streamAudioDetails,
      transcodeInfo: row.transcodeInfo,
      subtitleInfo: row.subtitleInfo,
    };
  });

  /**
   * POST /sessions/:id/terminate - Terminate a playback session
   *
   * Requires admin access. Sends a stop command to the media server
   * and logs the termination for auditing.
   */
  app.post('/:id/terminate', terminateSessions, async (request, reply) => {
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

    // Verify the session exists and user has access to its server; a live one is in the cache

    const cached = await getCacheService()?.getSessionById(id);

    const sessionData = await readSessionRow(id, cached?.startedAt, (where) =>
      db

        .select({
          id: sessions.id,

          serverId: sessions.serverId,

          serverUserId: sessions.serverUserId,

          state: sessions.state,

          startedAt: sessions.startedAt,
        })

        .from(sessions)

        .where(where)

        .limit(1)

        .then((rows) => rows[0])
    );
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
      sessionStartedAt: sessionData.startedAt,
    });

    if (result.outcome === 'server_historical') {
      return reply.conflict('Resume this server to end its streams');
    }

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

  /**
   * DELETE /sessions/bulk - Bulk delete historical sessions
   * Owner-only. Accepts array of session IDs.
   */
  app.delete('/bulk', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const authUser = request.user;

    const body = request.body as { ids: string[] };

    if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
      return reply.badRequest('ids array is required');
    }

    const sessionDetails = await readSessionRows(body.ids, (where) =>
      db
        .select({ id: sessions.id, serverId: sessions.serverId, startedAt: sessions.startedAt })
        .from(sessions)
        .where(where)
    );

    const accessibleRows = sessionDetails.filter((s) => hasServerAccess(authUser, s.serverId));

    if (accessibleRows.length === 0) {
      return { success: true, deleted: 0 };
    }

    await db.delete(sessions).where(sessionRowsWhere(accessibleRows));

    return { success: true, deleted: accessibleRows.length };
  });
};
