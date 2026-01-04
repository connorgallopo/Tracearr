/**
 * Emby API Response Parser
 *
 * Pure functions for parsing raw Emby API responses into typed objects.
 * Separated from the client for testability and reuse.
 *
 * Based on Emby OpenAPI specification v4.1.1.0
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
  getStreamDecisionsEmby as getStreamDecisions,
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
  type JellyfinEmbyActivityEntry as EmbyActivityEntry,
  type JellyfinEmbyAuthResult as EmbyAuthResult,
  type JellyfinEmbyItemResult as EmbyItemResult,
} from '../shared/jellyfinEmbyParser.js';

import { parseSessionsResponse as parseSessionsResponseShared } from '../shared/jellyfinEmbyParser.js';

// ============================================================================
// Session Parsing (Emby-specific - no lastPausedDate support)
// ============================================================================

/**
 * Parse raw Emby session data into a MediaSession object
 * Note: Unlike Jellyfin, Emby does not support lastPausedDate tracking
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

  // Build full image paths for Emby (not just image tag IDs)
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
      platform: undefined, // Emby doesn't provide platform separately
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
    // Note: Emby does not support lastPausedDate (unlike Jellyfin)
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
 * Parse Emby sessions API response
 * Filters to only sessions with active playback
 */
export function parseSessionsResponse(sessions: unknown[]): MediaSession[] {
  return parseSessionsResponseShared(sessions, parseSession);
}
