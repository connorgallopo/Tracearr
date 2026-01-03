/**
 * Session Mapping Functions
 *
 * Functions to transform sessions between different formats:
 * - MediaSession (from mediaServer adapter) → ProcessedSession (for DB storage)
 * - Database row → Session type (for application use)
 */

import type { Session } from '@tracearr/shared';
import type { MediaSession } from '../../services/mediaServer/types.js';
import type { ProcessedSession } from './types.js';
import { normalizeClient } from '../../utils/platformNormalizer.js';
import { formatQualityString } from '../../utils/resolutionNormalizer.js';
import type { sessions } from '../../db/schema.js';

// ============================================================================
// MediaSession → ProcessedSession Mapping
// ============================================================================

/**
 * Map unified MediaSession to ProcessedSession format
 * Works for both Plex and Jellyfin sessions from the new adapter
 *
 * @param session - Unified MediaSession from the mediaServer adapter
 * @param serverType - Type of media server ('plex' | 'jellyfin')
 * @returns ProcessedSession ready for database storage
 *
 * @example
 * const processed = mapMediaSession(mediaSession, 'plex');
 * // Use processed for DB insert
 */
export function mapMediaSession(
  session: MediaSession,
  serverType: 'plex' | 'jellyfin' | 'emby'
): ProcessedSession {
  const isEpisode = session.media.type === 'episode';
  const isLive = session.media.type === 'live';

  // For episodes, prefer show poster; for movies, use media poster
  // For live TV, use channel thumb if available
  const thumbPath = isLive
    ? (session.live?.channelThumb ?? session.media.thumbPath ?? '')
    : isEpisode && session.episode?.showThumbPath
      ? session.episode.showThumbPath
      : (session.media.thumbPath ?? '');

  // Build quality string from resolution (preferred) or bitrate
  const quality = formatQualityString(session.quality);

  // Keep the IP address - GeoIP service handles private IPs correctly
  const ipAddress = session.network.ipAddress;

  // Normalize platform/device for all server types
  // Uses product/client name as primary source, with platform/device as fallback
  const clientName = session.player.product || session.player.platform || '';
  const deviceHint = session.player.device || '';
  const normalized = normalizeClient(clientName, deviceHint, serverType);
  const platform = normalized.platform;
  const device = normalized.device;

  // Map media type - live TV gets its own type
  const mediaType =
    session.media.type === 'movie'
      ? 'movie'
      : session.media.type === 'episode'
        ? 'episode'
        : session.media.type === 'live'
          ? 'live'
          : 'track';

  return {
    sessionKey: session.sessionKey,
    plexSessionId: session.plexSessionId,
    ratingKey: session.mediaId,
    // User data
    externalUserId: session.user.id,
    username: session.user.username || 'Unknown',
    userThumb: session.user.thumb ?? '',
    mediaTitle: session.media.title,
    mediaType,
    // Enhanced media metadata
    grandparentTitle: session.episode?.showTitle ?? '',
    seasonNumber: session.episode?.seasonNumber ?? 0,
    episodeNumber: session.episode?.episodeNumber ?? 0,
    year: session.media.year ?? 0,
    thumbPath,
    // Live TV specific fields
    channelTitle: session.live?.channelTitle ?? null,
    channelIdentifier: session.live?.channelIdentifier ?? null,
    channelThumb: session.live?.channelThumb ?? null,
    // Connection info
    ipAddress,
    playerName: session.player.name,
    deviceId: session.player.deviceId,
    product: session.player.product ?? '',
    device,
    platform,
    quality,
    isTranscode: session.quality.isTranscode,
    videoDecision: session.quality.videoDecision,
    audioDecision: session.quality.audioDecision,
    bitrate: session.quality.bitrate,
    state: session.playback.state === 'paused' ? 'paused' : 'playing',
    totalDurationMs: session.media.durationMs,
    progressMs: session.playback.positionMs,
    // Jellyfin provides exact pause timestamp for more accurate tracking
    lastPausedDate: session.lastPausedDate,
  };
}

// ============================================================================
// Database Row → Session Mapping
// ============================================================================

/**
 * Map a database session row to the Session type
 *
 * @param s - Database session row from drizzle select
 * @returns Session object for application use
 *
 * @example
 * const rows = await db.select().from(sessions).where(...);
 * const sessionObjects = rows.map(mapSessionRow);
 */
export function mapSessionRow(s: typeof sessions.$inferSelect): Session {
  return {
    id: s.id,
    serverId: s.serverId,
    serverUserId: s.serverUserId,
    sessionKey: s.sessionKey,
    state: s.state,
    mediaType: s.mediaType,
    mediaTitle: s.mediaTitle,
    grandparentTitle: s.grandparentTitle,
    seasonNumber: s.seasonNumber,
    episodeNumber: s.episodeNumber,
    year: s.year,
    thumbPath: s.thumbPath,
    ratingKey: s.ratingKey,
    externalSessionId: s.externalSessionId,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    durationMs: s.durationMs,
    totalDurationMs: s.totalDurationMs,
    progressMs: s.progressMs,
    lastPausedAt: s.lastPausedAt,
    pausedDurationMs: s.pausedDurationMs,
    referenceId: s.referenceId,
    watched: s.watched,
    ipAddress: s.ipAddress,
    geoCity: s.geoCity,
    geoRegion: s.geoRegion,
    geoCountry: s.geoCountry,
    geoLat: s.geoLat,
    geoLon: s.geoLon,
    playerName: s.playerName,
    deviceId: s.deviceId,
    product: s.product,
    device: s.device,
    platform: s.platform,
    quality: s.quality,
    isTranscode: s.isTranscode,
    videoDecision: s.videoDecision,
    audioDecision: s.audioDecision,
    bitrate: s.bitrate,
    // Live TV fields
    channelTitle: s.channelTitle,
    channelIdentifier: s.channelIdentifier,
    channelThumb: s.channelThumb,
  };
}
