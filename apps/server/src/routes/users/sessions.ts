/**
 * User Sessions Route
 *
 * GET /:id/sessions - Get user's session history (grouped by play)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { userIdParamSchema, identityScopedPaginationSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import { PLAY_COUNT } from '../../db/sessions/rules.js';
import {
  resolveIdentityScopedServerUserIds,
  serverUserIdAnyFragment,
  userHistoryWindow,
} from './queries.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import { localSessionSql } from '../../db/sessions/rules.js';

export const sessionsRoutes: FastifyPluginAsync = async (app) => {
  const readSessions = { preHandler: [app.requirePermission('sessions', 'read')] };
  /**
   * GET /:id/sessions - Get user's session history (grouped by play)
   *
   * scope=identity expands the result to every account under the same
   * person that the caller can access.
   */
  app.get('/:id/sessions', readSessions, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = identityScopedPaginationSchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const { page, pageSize, scope } = query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    const scoped = await resolveIdentityScopedServerUserIds(db, authUser, id, scope, request.scope);
    if ('error' in scoped) {
      if (scoped.error === 'notFound') {
        return reply.notFound('User not found');
      }
      return reply.forbidden('You do not have access to this user');
    }

    const ids = scoped.ids;
    const idArray = uuidArraySql(ids);
    const { start: tenYearsAgo, end: nowDate } = userHistoryWindow();

    // Get total unique plays
    const [countResult] = await db.select({ count: PLAY_COUNT }).from(sessions)
      .where(sql`${sessions.serverUserId} = ANY(${idArray})
        AND ${sessions.startedAt} >= ${tenYearsAgo}
        AND ${sessions.startedAt} <= ${nowDate}`);

    const total = countResult?.count ?? 0;

    // Get sessions grouped by play (collapse pause/resume chains)
    const result = await db.execute(sql`
      WITH grouped_sessions AS (
        SELECT
          COALESCE(s.reference_id, s.id) AS play_id,
          MIN(s.started_at) AS started_at,
          MAX(s.stopped_at) AS stopped_at,
          SUM(COALESCE(s.duration_ms, 0)) AS duration_ms,
          MAX(s.progress_ms) AS progress_ms,
          MAX(s.total_duration_ms) AS total_duration_ms,
          SUM(COALESCE(s.paused_duration_ms, 0)) AS paused_duration_ms,
          COUNT(*) AS segment_count,
          BOOL_OR(s.watched) AS watched,
          (array_agg(s.id ORDER BY s.started_at))[1] AS first_session_id,
          (array_agg(s.state ORDER BY s.started_at DESC))[1] AS state
        FROM sessions s
        WHERE ${serverUserIdAnyFragment(ids, 's.server_user_id')}
          AND s.started_at >= ${tenYearsAgo}
          AND s.started_at <= ${nowDate}
        GROUP BY COALESCE(s.reference_id, s.id)
        ORDER BY MIN(s.started_at) DESC
        LIMIT ${pageSize} OFFSET ${offset}
      )
      SELECT
        gs.play_id AS id,
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
        sv.name AS server_name,
        s.server_user_id,
        s.session_key,
        s.media_type,
        s.media_title,
        s.grandparent_title,
        s.season_number,
        s.episode_number,
        s.year,
        s.thumb_path,
        s.media_id,
        s.show_media_id,
        s.rating_key,
        s.external_session_id,
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
        s.bitrate,
        s.last_paused_at
      FROM grouped_sessions gs
      -- gs.started_at is not a planner-time constant: the literal bounds exclude chunks at
      -- plan time, the InitPlan bounds narrow the rest at runtime
      JOIN sessions s ON s.id = gs.first_session_id AND s.started_at = gs.started_at
        AND s.started_at >= ${tenYearsAgo} AND s.started_at <= ${nowDate}
        AND s.started_at >= (SELECT MIN(started_at) FROM grouped_sessions)
        AND s.started_at <= (SELECT MAX(started_at) FROM grouped_sessions)
      JOIN servers sv ON sv.id = s.server_id
      ORDER BY gs.started_at DESC
    `);

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
        server_user_id: string;
        session_key: string;
        media_type: string;
        media_title: string;
        grandparent_title: string | null;
        season_number: number | null;
        episode_number: number | null;
        year: number | null;
        thumb_path: string | null;
        media_id: string | null;
        show_media_id: string | null;
        rating_key: string | null;
        external_session_id: string | null;
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
        bitrate: number | null;
        last_paused_at: Date | null;
        paused_duration_ms: string | null;
      }[]
    ).map((row) => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      serverUserId: row.server_user_id,
      sessionKey: row.session_key,
      state: row.state,
      mediaType: row.media_type,
      mediaTitle: row.media_title,
      grandparentTitle: row.grandparent_title,
      seasonNumber: row.season_number,
      episodeNumber: row.episode_number,
      year: row.year,
      thumbPath: row.thumb_path,
      mediaId: row.media_id,
      showMediaId: row.show_media_id,
      ratingKey: row.rating_key,
      externalSessionId: row.external_session_id,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
      durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
      totalDurationMs: row.total_duration_ms,
      progressMs: row.progress_ms,
      lastPausedAt: row.last_paused_at,
      pausedDurationMs: row.paused_duration_ms != null ? Number(row.paused_duration_ms) : null,
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
      bitrate: row.bitrate,
    }));

    return {
      data: sessionData,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });
};
