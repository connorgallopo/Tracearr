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
import { parseJellyfinClient } from './utils.js';
import type { sessions } from '../../db/schema.js';

// ============================================================================
// Quality Formatting
// ============================================================================

/**
 * Format video resolution to a user-friendly string
 * Normalizes various resolution formats to standard labels
 *
 * @param resolution - Raw resolution string from API (e.g., "4k", "1080", "720p", "sd")
 * @param height - Video height in pixels as fallback
 * @returns Formatted resolution string (e.g., "4K", "1080p", "720p", "SD")
 */
function formatResolution(resolution?: string, height?: number): string | null {
  if (resolution) {
    const lower = resolution.toLowerCase();
    // Handle "4k" or "2160" resolution
    if (lower === '4k' || lower === '2160' || lower === '2160p') {
      return '4K';
    }
    // Handle standard numeric resolutions
    if (lower === '1080' || lower === '1080p') {
      return '1080p';
    }
    if (lower === '720' || lower === '720p') {
      return '720p';
    }
    if (lower === '480' || lower === '480p') {
      return '480p';
    }
    if (lower === 'sd') {
      return 'SD';
    }
    // Return the original with 'p' suffix if it looks numeric
    if (/^\d+$/.test(lower)) {
      return `${lower}p`;
    }
    // Return as-is if it's already formatted (e.g., "1080p")
    return resolution;
  }

  // Fall back to height-based resolution
  if (height) {
    if (height >= 2160) return '4K';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    return 'SD';
  }

  return null;
}

/**
 * Build quality display string from session quality data
 * Prefers resolution over bitrate for clarity
 *
 * @param quality - Session quality object from MediaSession
 * @returns Quality string for display (e.g., "4K", "1080p", "54Mbps", "Direct")
 */
function formatQualityString(quality: MediaSession['quality']): string {
  // Prefer resolution-based display
  const resolution = formatResolution(quality.videoResolution, quality.videoHeight);
  if (resolution) {
    return resolution;
  }

  // Fall back to bitrate if available
  if (quality.bitrate > 0) {
    return `${Math.round(quality.bitrate / 1000)}Mbps`;
  }

  // Last resort: transcode status
  return quality.isTranscode ? 'Transcoding' : 'Direct';
}

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

  // For episodes, prefer show poster; for movies, use media poster
  const thumbPath =
    isEpisode && session.episode?.showThumbPath
      ? session.episode.showThumbPath
      : (session.media.thumbPath ?? '');

  // Build quality string from resolution (preferred) or bitrate
  const quality = formatQualityString(session.quality);

  // Keep the IP address - GeoIP service handles private IPs correctly
  const ipAddress = session.network.ipAddress;

  // Get platform/device - Jellyfin and Emby may need client string parsing
  let platform = session.player.platform ?? '';
  let device = session.player.device ?? '';
  if ((serverType === 'jellyfin' || serverType === 'emby') && session.player.product) {
    const parsed = parseJellyfinClient(session.player.product, device);
    platform = platform || parsed.platform;
    device = device || parsed.device;
  }

  return {
    sessionKey: session.sessionKey,
    plexSessionId: session.plexSessionId,
    ratingKey: session.mediaId,
    // User data
    externalUserId: session.user.id,
    username: session.user.username || 'Unknown',
    userThumb: session.user.thumb ?? '',
    mediaTitle: session.media.title,
    mediaType:
      session.media.type === 'movie'
        ? 'movie'
        : session.media.type === 'episode'
          ? 'episode'
          : 'track',
    // Enhanced media metadata
    grandparentTitle: session.episode?.showTitle ?? '',
    seasonNumber: session.episode?.seasonNumber ?? 0,
    episodeNumber: session.episode?.episodeNumber ?? 0,
    year: session.media.year ?? 0,
    thumbPath,
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
  };
}
