/**
 * Public API v2 - GET /streams
 */

import { booleanStringSchema, formatBitrate, type ActiveSession } from '@tracearr/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { getCacheService } from '../../services/cache.js';
import { buildAvatarUrl, buildPosterUrl } from '../../services/imageProxy.js';
import { countStreams } from '../../utils/streamCounts.js';
import { displayValues, emptyToNull, type RouteConfig } from './shared.js';

export interface SessionIdentityRow {
  id: string;
  media_id: string | null;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  rating_key: string | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
  library_id: string | null;
  genres: string[] | null;
}

/**
 * The GET /streams item shape. The events route calls this with the cached
 * session only, so library_id and genres are null there; they need the
 * library_items join that only the REST handler runs.
 */
export function formatActiveStream(session: ActiveSession, identity?: SessionIdentityRow) {
  return {
    id: session.id,
    server_id: session.serverId,
    server_name: session.server.name,
    server_type: session.server.type,
    username: session.user.identityName ?? session.user.username,
    user_thumb: session.user.thumbUrl,
    user_avatar_url: buildAvatarUrl(session.serverId, session.user.thumbUrl),
    media_title: session.mediaTitle,
    media_type: session.mediaType,
    show_title: session.grandparentTitle,
    season_number: session.seasonNumber,
    episode_number: session.episodeNumber,
    year: session.year,
    artist_name: session.artistName,
    album_name: session.albumName,
    track_number: session.trackNumber,
    disc_number: session.discNumber,
    thumb_path: session.thumbPath,
    poster_url: buildPosterUrl(session.serverId, session.thumbPath),
    duration_ms: session.totalDurationMs,
    state: session.state,
    progress_ms: session.progressMs ?? 0,
    started_at: session.startedAt,
    is_transcode: session.isTranscode,
    video_decision: session.videoDecision,
    audio_decision: session.audioDecision,
    bitrate: session.bitrate,
    source_video_codec: session.sourceVideoCodec,
    source_audio_codec: session.sourceAudioCodec,
    source_audio_channels: session.sourceAudioChannels,
    source_video_width: session.sourceVideoWidth,
    source_video_height: session.sourceVideoHeight,
    source_video_details: session.sourceVideoDetails,
    source_audio_details: session.sourceAudioDetails,
    stream_video_codec: session.streamVideoCodec,
    stream_audio_codec: session.streamAudioCodec,
    stream_video_details: session.streamVideoDetails,
    stream_audio_details: session.streamAudioDetails,
    transcode_info: session.transcodeInfo,
    subtitle_info: session.subtitleInfo,
    ...displayValues(session),
    device: session.device,
    player: session.playerName,
    product: session.product,
    platform: session.platform,
    media_id: identity ? identity.media_id : (session.mediaId ?? null),
    show_media_id: identity ? identity.show_media_id : (session.showMediaId ?? null),
    imdb_id: identity ? identity.imdb_id : (session.imdbId ?? null),
    tmdb_id: identity ? identity.tmdb_id : (session.tmdbId ?? null),
    tvdb_id: identity ? identity.tvdb_id : (session.tvdbId ?? null),
    rating_key: emptyToNull(identity ? identity.rating_key : session.ratingKey),
    parent_rating_key: emptyToNull(identity ? identity.parent_rating_key : session.parentRatingKey),
    grandparent_rating_key: emptyToNull(
      identity ? identity.grandparent_rating_key : session.grandparentRatingKey
    ),
    library_id: identity?.library_id ?? null,
    genres: identity?.genres ?? null,
  };
}

export type ActiveStreamShape = ReturnType<typeof formatActiveStream>;

async function readStreamIdentities(
  active: ActiveSession[],
  floor?: Date
): Promise<SessionIdentityRow[]> {
  const result = await db.execute(sql`
    SELECT
      s.id,
      s.media_id,
      s.show_media_id,
      s.imdb_id,
      s.tmdb_id,
      s.tvdb_id,
      s.rating_key,
      s.parent_rating_key,
      s.grandparent_rating_key,
      li.library_id,
      m.genres
    FROM sessions s
    LEFT JOIN media m ON m.id = s.media_id
    LEFT JOIN library_items li ON li.server_id = s.server_id AND li.rating_key = s.rating_key
    WHERE s.id IN (${sql.join(
      active.map((s) => sql`${s.id}`),
      sql`, `
    )})
    ${floor ? sql`AND s.started_at >= ${floor}` : sql``}
  `);
  return result.rows as unknown as SessionIdentityRow[];
}

export function registerStreamsRoutes(app: FastifyInstance, routeConfig: RouteConfig): void {
  /**
   * GET /streams - Currently active playback sessions with media identity
   *
   * Reads the session cache and enriches each stream with identity, library,
   * and genre data from the session rows when the cached payload lacks it.
   */
  app.get(
    '/streams',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const streamsQuerySchema = z.object({
        server_id: z.uuid().optional(),
        summary: booleanStringSchema.optional(),
      });

      const query = streamsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { server_id: serverId, summary: summaryOnly } = query.data;

      const cacheService = getCacheService();
      let activeSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
      if (serverId) {
        activeSessions = activeSessions.filter((s) => s.serverId === serverId);
      }

      const identityById = new Map<string, SessionIdentityRow>();
      if (!summaryOnly && activeSessions.length > 0) {
        // Floored a minute under the oldest cached start, as sessionRowById does, so only the
        // live chunks are opened; an id the floor misses takes the unbounded read.
        const floor = new Date(
          Math.min(...activeSessions.map((s) => new Date(s.startedAt).getTime())) - 60_000
        );
        for (const row of await readStreamIdentities(activeSessions, floor)) {
          identityById.set(row.id, row);
        }
        const missing = activeSessions.filter((s) => !identityById.has(s.id));
        for (const row of missing.length > 0 ? await readStreamIdentities(missing) : []) {
          identityById.set(row.id, row);
        }
      }

      const streams = summaryOnly
        ? []
        : activeSessions.map((session) =>
            formatActiveStream(session, identityById.get(session.id))
          );

      const { overall, byServer } = countStreams(activeSessions);

      const summary = {
        total: overall.total,
        transcodes: overall.transcodes,
        audio_transcodes: overall.audioTranscodes,
        direct_streams: overall.directStreams,
        direct_plays: overall.directPlays,
        total_bitrate: formatBitrate(overall.bitrateKbps),
        by_server: byServer.map((s) => ({
          server_id: s.serverId,
          server_name: s.serverName,
          total: s.total,
          transcodes: s.transcodes,
          audio_transcodes: s.audioTranscodes,
          direct_streams: s.directStreams,
          direct_plays: s.directPlays,
          total_bitrate: formatBitrate(s.bitrateKbps),
        })),
      };

      if (summaryOnly) {
        return { summary };
      }

      return { data: streams, summary };
    }
  );
}
