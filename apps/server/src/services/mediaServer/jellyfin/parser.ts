/**
 * Jellyfin API Response Parser
 *
 * Pure functions for parsing raw Jellyfin API responses into typed objects.
 * Separated from the client for testability and reuse.
 */

import {
  parseString,
  parseNumber,
  parseOptionalString,
  parseOptionalNumber,
  getNestedObject,
} from '../../../utils/parsing.js';
import type { MediaSession } from '../types.js';

// Import shared utilities for Jellyfin/Emby
import {
  ticksToMs,
  parseMediaType,
  calculateProgress,
  getBitrate,
  getVideoDimensions,
  getStreamDecisionsJellyfin as getStreamDecisions,
  buildItemImagePath,
  buildUserImagePath,
  shouldFilterItem as isNonPrimaryContent,
  extractLiveTvMetadata,
  extractMusicMetadata,
} from '../shared/jellyfinEmbyUtils.js';

// Re-export shared parser functions (identical between Jellyfin/Emby)
export {
  parsePlaybackState,
  parseUser,
  parseUsersResponse,
  parseLibrary,
  parseLibrariesResponse,
  parseWatchHistoryItem,
  parseWatchHistoryResponse,
  parseActivityLogItem,
  parseActivityLogResponse,
  parseAuthResponse,
  parseItem,
  parseItemsResponse,
  // Re-export shared types with platform-specific aliases for backward compatibility
  type JellyfinEmbyActivityEntry as JellyfinActivityEntry,
  type JellyfinEmbyAuthResult as JellyfinAuthResult,
  type JellyfinEmbyItemResult as JellyfinItemResult,
} from '../shared/jellyfinEmbyParser.js';

import { parseSessionsResponse as parseSessionsResponseShared } from '../shared/jellyfinEmbyParser.js';

// ============================================================================
// Session Parsing (Jellyfin-specific due to lastPausedDate support)
// ============================================================================

/**
 * Parse raw Jellyfin session data into a MediaSession object
 * Note: This is Jellyfin-specific because it supports lastPausedDate tracking
 */
export function parseSession(session: Record<string, unknown>): MediaSession | null {
  const nowPlaying = getNestedObject(session, 'NowPlayingItem');
  if (!nowPlaying) return null; // No active playback

  // Filter out non-primary content (trailers, prerolls, theme songs/videos)
  if (isNonPrimaryContent(nowPlaying)) return null;

  const playState = getNestedObject(session, 'PlayState');
  const imageTags = getNestedObject(nowPlaying, 'ImageTags');

  const durationMs = ticksToMs(nowPlaying.RunTimeTicks);
  const positionMs = ticksToMs(playState?.PositionTicks);
  const mediaType = parseMediaType(nowPlaying.Type);

  // Get stream decisions using the transcode normalizer
  const { videoDecision, audioDecision, isTranscode } = getStreamDecisions(session);

  // Jellyfin-specific: Parse LastPausedDate for accurate pause tracking
  const lastPausedDateStr = parseOptionalString(session.LastPausedDate);
  const lastPausedDate = lastPausedDateStr ? new Date(lastPausedDateStr) : undefined;

  // Build full image paths for Jellyfin (not just image tag IDs)
  const itemId = parseString(nowPlaying.Id);
  const userId = parseString(session.UserId);
  const userImageTag = parseOptionalString(session.UserPrimaryImageTag);
  const primaryImageTag = imageTags?.Primary ? parseString(imageTags.Primary) : undefined;

  const result: MediaSession = {
    sessionKey: parseString(session.Id),
    mediaId: itemId,
    user: {
      id: userId,
      username: parseString(session.UserName),
      thumb: buildUserImagePath(userId, userImageTag),
    },
    media: {
      title: parseString(nowPlaying.Name),
      type: mediaType,
      durationMs,
      year: parseOptionalNumber(nowPlaying.ProductionYear),
      thumbPath: buildItemImagePath(itemId, primaryImageTag),
    },
    playback: {
      state: playState?.IsPaused ? 'paused' : 'playing',
      positionMs,
      progressPercent: calculateProgress(positionMs, durationMs),
    },
    player: {
      name: parseString(session.DeviceName),
      deviceId: parseString(session.DeviceId),
      product: parseOptionalString(session.Client),
      device: parseOptionalString(session.DeviceType),
      platform: undefined, // Jellyfin doesn't provide platform separately
    },
    network: {
      ipAddress: parseString(session.RemoteEndPoint),
      isLocal: false,
    },
    quality: {
      bitrate: getBitrate(session),
      isTranscode,
      videoDecision,
      audioDecision,
      ...getVideoDimensions(session),
    },
    // Jellyfin-specific: provides exact pause timestamp for accurate tracking
    lastPausedDate,
  };

  // Add episode-specific metadata if this is an episode
  if (mediaType === 'episode') {
    const seriesId = parseOptionalString(nowPlaying.SeriesId);
    const seriesImageTag = parseOptionalString(nowPlaying.SeriesPrimaryImageTag);

    result.episode = {
      showTitle: parseString(nowPlaying.SeriesName),
      showId: seriesId,
      seasonNumber: parseNumber(nowPlaying.ParentIndexNumber),
      episodeNumber: parseNumber(nowPlaying.IndexNumber),
      seasonName: parseOptionalString(nowPlaying.SeasonName),
      showThumbPath: seriesId ? buildItemImagePath(seriesId, seriesImageTag) : undefined,
    };
  }

  // Add Live TV metadata if this is a live stream
  if (mediaType === 'live') {
    result.live = extractLiveTvMetadata(nowPlaying);
  }

  // Add music track metadata if this is a track
  if (mediaType === 'track') {
    result.music = extractMusicMetadata(nowPlaying);
  }

  return result;
}

/**
 * Parse Jellyfin sessions API response
 * Filters to only sessions with active playback
 */
export function parseSessionsResponse(sessions: unknown[]): MediaSession[] {
  return parseSessionsResponseShared(sessions, parseSession);
}
