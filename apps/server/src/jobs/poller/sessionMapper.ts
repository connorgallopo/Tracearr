/**
 * Session Mapping Functions
 *
 * Functions to transform sessions between different formats:
 * - MediaSession (from mediaServer adapter) → ProcessedSession (for DB storage)
 * - Database row → Session type (for application use)
 */

import { type Session, type StreamDetailFields, MEDIA_TYPES } from '@tracearr/shared';
import type { MediaSession } from '../../services/mediaServer/types.js';
import type { ProcessedSession } from './types.js';
import { normalizeClient } from '../../utils/platformNormalizer.js';
import { formatQualityString } from '../../utils/resolutionNormalizer.js';
import type { sessions } from '../../db/schema.js';

/** Set of valid media types for O(1) validation */
const VALID_MEDIA_TYPES = new Set<string>(MEDIA_TYPES);

// ============================================================================
// Thumb Path Resolution
// ============================================================================

/**
 * Thumb path resolvers by media type
 * Using lookup table makes it easy to add new media types
 */
const THUMB_PATH_RESOLVERS: Record<string, (session: MediaSession) => string> = {
  live: (s) => s.live?.channelThumb ?? s.media.thumbPath ?? '',
  episode: (s) => s.episode?.showThumbPath ?? s.media.thumbPath ?? '',
  movie: (s) => s.media.thumbPath ?? '',
  track: (s) => s.media.thumbPath ?? '',
  photo: (s) => s.media.thumbPath ?? '',
  unknown: (s) => s.media.thumbPath ?? '',
};

/**
 * Resolve the appropriate thumbnail path based on media type
 */
function resolveThumbPath(session: MediaSession): string {
  const resolver = THUMB_PATH_RESOLVERS[session.media.type];
  return resolver ? resolver(session) : (session.media.thumbPath ?? '');
}

// ============================================================================
// Media Type Mapping
// ============================================================================

/** Map media type, warn and default to 'unknown' if unexpected */
function mapMediaType(parserType: string): ProcessedSession['mediaType'] {
  if (VALID_MEDIA_TYPES.has(parserType)) {
    return parserType as ProcessedSession['mediaType'];
  }
  console.warn(
    `[sessionMapper] Unexpected media type encountered: "${parserType}", defaulting to "unknown"`
  );
  return 'unknown';
}

// ============================================================================
// Stream Detail Helpers (DRY)
// ============================================================================

/**
 * Extract stream detail fields from MediaSession quality data.
 * Handles the field name mapping (e.g., videoWidth → sourceVideoWidth).
 */
export function extractStreamDetailsFromQuality(
  quality: MediaSession['quality']
): StreamDetailFields {
  return {
    sourceVideoCodec: quality.sourceVideoCodec ?? null,
    sourceAudioCodec: quality.sourceAudioCodec ?? null,
    sourceAudioChannels: quality.sourceAudioChannels ?? null,
    sourceVideoWidth: quality.videoWidth ?? null,
    sourceVideoHeight: quality.videoHeight ?? null,
    sourceVideoDetails: quality.sourceVideoDetails ?? null,
    sourceAudioDetails: quality.sourceAudioDetails ?? null,
    streamVideoCodec: quality.streamVideoCodec ?? null,
    streamAudioCodec: quality.streamAudioCodec ?? null,
    streamVideoDetails: quality.streamVideoDetails ?? null,
    streamAudioDetails: quality.streamAudioDetails ?? null,
    transcodeInfo: quality.transcodeInfo ?? null,
    subtitleInfo: quality.subtitleInfo ?? null,
  };
}

/**
 * Pick stream detail fields from any object that has them.
 * Useful for DB inserts where we spread ProcessedSession fields.
 */
export function pickStreamDetailFields<T extends StreamDetailFields>(
  source: T
): StreamDetailFields {
  return {
    sourceVideoCodec: source.sourceVideoCodec,
    sourceAudioCodec: source.sourceAudioCodec,
    sourceAudioChannels: source.sourceAudioChannels,
    sourceVideoWidth: source.sourceVideoWidth,
    sourceVideoHeight: source.sourceVideoHeight,
    sourceVideoDetails: source.sourceVideoDetails,
    sourceAudioDetails: source.sourceAudioDetails,
    streamVideoCodec: source.streamVideoCodec,
    streamAudioCodec: source.streamAudioCodec,
    streamVideoDetails: source.streamVideoDetails,
    streamAudioDetails: source.streamAudioDetails,
    transcodeInfo: source.transcodeInfo,
    subtitleInfo: source.subtitleInfo,
  };
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
  // Resolve thumb path using lookup table
  const thumbPath = resolveThumbPath(session);

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

  // Map media type using lookup table
  const mediaType = mapMediaType(session.media.type);

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
    // Music track metadata
    artistName: session.music?.artistName ?? null,
    albumName: session.music?.albumName ?? null,
    trackNumber: session.music?.trackNumber ?? null,
    discNumber: session.music?.discNumber ?? null,
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
    // Stream details (source media, stream output, transcode/subtitle info)
    ...extractStreamDetailsFromQuality(session.quality),
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
    // Stream details (source media, stream output, transcode/subtitle info)
    ...pickStreamDetailFields(s),
    // Live TV fields
    channelTitle: s.channelTitle,
    channelIdentifier: s.channelIdentifier,
    channelThumb: s.channelThumb,
    // Music track fields
    artistName: s.artistName,
    albumName: s.albumName,
    trackNumber: s.trackNumber,
    discNumber: s.discNumber,
  };
}
