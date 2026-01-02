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
  parseBoolean,
  parseOptionalString,
  parseOptionalNumber,
  getNestedObject,
  getNestedValue,
  parseDateString,
} from '../../../utils/parsing.js';
import {
  normalizePlayMethod,
  isTranscodingFromInfo,
  type StreamDecisions,
} from '../../../utils/transcodeNormalizer.js';
import type { MediaSession, MediaUser, MediaLibrary, MediaWatchHistoryItem } from '../types.js';

// ============================================================================
// Constants
// ============================================================================

/** Emby ticks per millisecond (10,000 ticks = 1ms) */
const TICKS_PER_MS = 10000;

// ============================================================================
// Session Parsing
// ============================================================================

/**
 * Convert Emby ticks to milliseconds
 */
function ticksToMs(ticks: unknown): number {
  const tickNum = parseNumber(ticks);
  return Math.floor(tickNum / TICKS_PER_MS);
}

/**
 * Parse Emby media type to unified type
 */
function parseMediaType(type: unknown): MediaSession['media']['type'] {
  const typeStr = parseString(type).toLowerCase();
  switch (typeStr) {
    case 'movie':
      return 'movie';
    case 'episode':
      return 'episode';
    case 'audio':
      return 'track';
    case 'photo':
      return 'photo';
    default:
      return 'unknown';
  }
}

/**
 * Parse playback state from Emby to unified state
 */
function parsePlaybackState(isPaused: unknown): MediaSession['playback']['state'] {
  return parseBoolean(isPaused) ? 'paused' : 'playing';
}

/**
 * Calculate progress percentage from position and duration
 */
function calculateProgress(positionMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(100, Math.round((positionMs / durationMs) * 100));
}

/**
 * Get bitrate from Emby session in kbps (prefer transcoding bitrate, fall back to source)
 * Note: Emby API returns bitrate in bps, so we convert to kbps for consistency with Plex
 */
function getBitrate(session: Record<string, unknown>): number {
  // Check transcoding info first
  const transcodingInfo = getNestedObject(session, 'TranscodingInfo');
  if (transcodingInfo) {
    const transcodeBitrate = parseNumber(transcodingInfo.Bitrate);
    if (transcodeBitrate > 0) return Math.round(transcodeBitrate / 1000); // bps -> kbps
  }

  // Fall back to source media bitrate
  const nowPlaying = getNestedObject(session, 'NowPlayingItem');
  const mediaSources = nowPlaying?.MediaSources;
  if (Array.isArray(mediaSources) && mediaSources.length > 0) {
    const firstSource = mediaSources[0] as Record<string, unknown>;
    const bitrate = parseNumber(firstSource?.Bitrate);
    return Math.round(bitrate / 1000); // bps -> kbps
  }

  return 0;
}

/**
 * Get video dimensions from Emby session for resolution display
 * Checks TranscodingInfo first (for transcoded resolution), then falls back to source
 */
function getVideoDimensions(session: Record<string, unknown>): {
  videoWidth?: number;
  videoHeight?: number;
} {
  // Check transcoding info first for transcoded resolution
  const transcodingInfo = getNestedObject(session, 'TranscodingInfo');
  if (transcodingInfo) {
    const width = parseOptionalNumber(transcodingInfo.Width);
    const height = parseOptionalNumber(transcodingInfo.Height);
    if ((width && width > 0) || (height && height > 0)) {
      return {
        videoWidth: width && width > 0 ? width : undefined,
        videoHeight: height && height > 0 ? height : undefined,
      };
    }
  }

  // Fall back to source video stream resolution
  const nowPlaying = getNestedObject(session, 'NowPlayingItem');
  const mediaSources = nowPlaying?.MediaSources;
  if (Array.isArray(mediaSources) && mediaSources.length > 0) {
    const firstSource = mediaSources[0] as Record<string, unknown>;
    const mediaStreams = firstSource?.MediaStreams;
    if (Array.isArray(mediaStreams)) {
      // Find the video stream (Type === 'Video')
      for (const stream of mediaStreams) {
        const streamObj = stream as Record<string, unknown>;
        if (parseOptionalString(streamObj.Type)?.toLowerCase() === 'video') {
          const width = parseOptionalNumber(streamObj.Width);
          const height = parseOptionalNumber(streamObj.Height);
          if ((width && width > 0) || (height && height > 0)) {
            return {
              videoWidth: width && width > 0 ? width : undefined,
              videoHeight: height && height > 0 ? height : undefined,
            };
          }
        }
      }
    }
  }

  return {};
}

/**
 * Get stream decisions using the transcode normalizer
 * Extracts PlayMethod and IsVideoDirect/IsAudioDirect flags, then normalizes
 */
function getStreamDecisions(session: Record<string, unknown>): StreamDecisions {
  const playState = getNestedObject(session, 'PlayState');
  const playMethod = parseOptionalString(playState?.PlayMethod);

  if (playMethod) {
    const transcodingInfo = getNestedObject(session, 'TranscodingInfo');
    const isVideoDirect =
      transcodingInfo && typeof getNestedValue(transcodingInfo, 'IsVideoDirect') === 'boolean'
        ? (getNestedValue(transcodingInfo, 'IsVideoDirect') as boolean)
        : undefined;
    const isAudioDirect =
      transcodingInfo && typeof getNestedValue(transcodingInfo, 'IsAudioDirect') === 'boolean'
        ? (getNestedValue(transcodingInfo, 'IsAudioDirect') as boolean)
        : undefined;

    // Emby apps report DirectStream even when no remuxing occurs. Treat as DirectPlay
    // when TranscodingInfo is absent or shows both streams are direct.
    if (playMethod.toLowerCase() === 'directstream') {
      if (!transcodingInfo || (isVideoDirect === true && isAudioDirect === true)) {
        return { videoDecision: 'directplay', audioDecision: 'directplay', isTranscode: false };
      }
    }

    return normalizePlayMethod(playMethod, isVideoDirect, isAudioDirect);
  }

  // Fall back to checking TranscodingInfo if PlayMethod not available
  const transcodingInfo = getNestedObject(session, 'TranscodingInfo');
  if (!transcodingInfo) {
    return { videoDecision: 'directplay', audioDecision: 'directplay', isTranscode: false };
  }

  // Use IsVideoDirect to determine if transcoding
  const isVideoDirect = getNestedValue(transcodingInfo, 'IsVideoDirect');
  if (isTranscodingFromInfo(true, isVideoDirect as boolean | undefined)) {
    return { videoDecision: 'transcode', audioDecision: 'transcode', isTranscode: true };
  }

  return { videoDecision: 'directplay', audioDecision: 'directplay', isTranscode: false };
}

/**
 * Check if session is non-primary content that should be filtered out
 * Filters: trailers, prerolls, theme songs, theme videos
 */
function isNonPrimaryContent(nowPlaying: Record<string, unknown>): boolean {
  // Filter trailers
  const itemType = parseOptionalString(nowPlaying.Type);
  if (itemType?.toLowerCase() === 'trailer') return true;

  // Filter preroll videos (check ProviderIds for prerolls.video)
  const providerIds = getNestedObject(nowPlaying, 'ProviderIds');
  if (providerIds && 'prerolls.video' in providerIds) return true;

  // Filter theme songs and theme videos (Issue #72)
  // ExtraType field identifies special content like themes, behind-the-scenes, etc.
  const extraType = parseOptionalString(nowPlaying.ExtraType);
  if (extraType === 'ThemeSong' || extraType === 'ThemeVideo') return true;

  return false;
}

/**
 * Build Emby image URL path for an item
 * Emby images use: /Items/{id}/Images/{type}
 */
function buildItemImagePath(itemId: string, imageTag: string | undefined): string | undefined {
  if (!imageTag || !itemId) return undefined;
  return `/Items/${itemId}/Images/Primary`;
}

/**
 * Build Emby image URL path for a user avatar
 * Emby user images use: /Users/{id}/Images/Primary
 */
function buildUserImagePath(userId: string, imageTag: string | undefined): string | undefined {
  if (!imageTag || !userId) return undefined;
  return `/Users/${userId}/Images/Primary`;
}

/**
 * Parse raw Emby session data into a MediaSession object
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
      // Build full path: /Users/{userId}/Images/Primary
      thumb: buildUserImagePath(userId, userImageTag),
    },
    media: {
      title: parseString(nowPlaying.Name),
      type: mediaType,
      durationMs,
      year: parseOptionalNumber(nowPlaying.ProductionYear),
      // Build full path: /Items/{itemId}/Images/Primary
      thumbPath: buildItemImagePath(itemId, primaryImageTag),
    },
    playback: {
      state: parsePlaybackState(playState?.IsPaused),
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
      // Emby doesn't explicitly indicate local vs remote
      isLocal: false,
    },
    quality: {
      bitrate: getBitrate(session),
      isTranscode,
      videoDecision,
      audioDecision,
      ...getVideoDimensions(session),
    },
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
      // Build full path for series poster: /Items/{seriesId}/Images/Primary
      showThumbPath: seriesId ? buildItemImagePath(seriesId, seriesImageTag) : undefined,
    };
  }

  return result;
}

/**
 * Parse Emby sessions API response
 * Filters to only sessions with active playback
 */
export function parseSessionsResponse(sessions: unknown[]): MediaSession[] {
  if (!Array.isArray(sessions)) return [];

  const results: MediaSession[] = [];
  for (const session of sessions) {
    const parsed = parseSession(session as Record<string, unknown>);
    if (parsed) results.push(parsed);
  }
  return results;
}

// ============================================================================
// User Parsing
// ============================================================================

/**
 * Parse raw Emby user data into a MediaUser object
 */
export function parseUser(user: Record<string, unknown>): MediaUser {
  const policy = getNestedObject(user, 'Policy');
  const userId = parseString(user.Id);
  const imageTag = parseOptionalString(user.PrimaryImageTag);

  return {
    id: userId,
    username: parseString(user.Name),
    email: undefined, // Emby doesn't expose email in user API
    // Build full path for user avatar: /Users/{userId}/Images/Primary
    thumb: buildUserImagePath(userId, imageTag),
    isAdmin: parseBoolean(policy?.IsAdministrator),
    isDisabled: parseBoolean(policy?.IsDisabled),
    lastLoginAt: user.LastLoginDate ? new Date(parseString(user.LastLoginDate)) : undefined,
    lastActivityAt: user.LastActivityDate
      ? new Date(parseString(user.LastActivityDate))
      : undefined,
  };
}

/**
 * Parse Emby users API response
 */
export function parseUsersResponse(users: unknown[]): MediaUser[] {
  if (!Array.isArray(users)) return [];
  return users.map((user) => parseUser(user as Record<string, unknown>));
}

// ============================================================================
// Library Parsing
// ============================================================================

/**
 * Parse raw Emby library (virtual folder) data into a MediaLibrary object
 */
export function parseLibrary(folder: Record<string, unknown>): MediaLibrary {
  return {
    id: parseString(folder.ItemId),
    name: parseString(folder.Name),
    type: parseString(folder.CollectionType, 'unknown'),
    locations: Array.isArray(folder.Locations) ? (folder.Locations as string[]) : [],
  };
}

/**
 * Parse Emby libraries (virtual folders) API response
 */
export function parseLibrariesResponse(folders: unknown[]): MediaLibrary[] {
  if (!Array.isArray(folders)) return [];
  return folders.map((folder) => parseLibrary(folder as Record<string, unknown>));
}

// ============================================================================
// Watch History Parsing
// ============================================================================

/**
 * Parse raw Emby watch history item into a MediaWatchHistoryItem object
 */
export function parseWatchHistoryItem(item: Record<string, unknown>): MediaWatchHistoryItem {
  const userData = getNestedObject(item, 'UserData');
  const mediaType = parseMediaType(item.Type);

  const historyItem: MediaWatchHistoryItem = {
    mediaId: parseString(item.Id),
    title: parseString(item.Name),
    type: mediaType === 'photo' ? 'unknown' : mediaType,
    // Emby returns ISO date string
    watchedAt: parseDateString(userData?.LastPlayedDate) ?? '',
    playCount: parseNumber(userData?.PlayCount),
  };

  // Add episode metadata if applicable
  if (mediaType === 'episode') {
    historyItem.episode = {
      showTitle: parseString(item.SeriesName),
      seasonNumber: parseOptionalNumber(item.ParentIndexNumber),
      episodeNumber: parseOptionalNumber(item.IndexNumber),
    };
  }

  return historyItem;
}

/**
 * Parse Emby watch history (Items) API response
 */
export function parseWatchHistoryResponse(data: unknown): MediaWatchHistoryItem[] {
  const items = (data as { Items?: unknown[] })?.Items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => parseWatchHistoryItem(item as Record<string, unknown>));
}

// ============================================================================
// Activity Log Parsing
// ============================================================================

/**
 * Activity log entry from Emby
 */
export interface EmbyActivityEntry {
  id: number;
  name: string;
  overview?: string;
  shortOverview?: string;
  type: string;
  itemId?: string;
  userId?: string;
  date: string;
  severity: string;
}

/**
 * Parse raw Emby activity log item
 */
export function parseActivityLogItem(item: Record<string, unknown>): EmbyActivityEntry {
  return {
    id: parseNumber(item.Id),
    name: parseString(item.Name),
    overview: parseOptionalString(item.Overview),
    shortOverview: parseOptionalString(item.ShortOverview),
    type: parseString(item.Type),
    itemId: parseOptionalString(item.ItemId),
    userId: parseOptionalString(item.UserId),
    date: parseString(item.Date),
    severity: parseString(item.Severity, 'Information'),
  };
}

/**
 * Parse Emby activity log API response
 */
export function parseActivityLogResponse(data: unknown): EmbyActivityEntry[] {
  const items = (data as { Items?: unknown[] })?.Items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => parseActivityLogItem(item as Record<string, unknown>));
}

// ============================================================================
// Authentication Response Parsing
// ============================================================================

/**
 * Authentication result from Emby
 */
export interface EmbyAuthResult {
  id: string;
  username: string;
  token: string;
  serverId: string;
  isAdmin: boolean;
}

/**
 * Parse Emby authentication response
 */
export function parseAuthResponse(data: Record<string, unknown>): EmbyAuthResult {
  const user = getNestedObject(data, 'User') ?? {};
  const policy = getNestedObject(user, 'Policy') ?? {};

  return {
    id: parseString(user.Id),
    username: parseString(user.Name),
    token: parseString(data.AccessToken),
    serverId: parseString(data.ServerId),
    isAdmin: parseBoolean(policy.IsAdministrator),
  };
}

// ============================================================================
// Items Parsing (for media enrichment)
// ============================================================================

/**
 * Item result for media enrichment
 * Used when fetching items by ID for Jellystat import
 */
export interface EmbyItemResult {
  Id: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  ImageTags?: {
    Primary?: string;
  };
  // Episode series info for poster lookup
  SeriesId?: string;
  SeriesPrimaryImageTag?: string;
}

/**
 * Parse a single Emby item for enrichment
 */
export function parseItem(item: Record<string, unknown>): EmbyItemResult {
  const imageTags = getNestedObject(item, 'ImageTags');

  return {
    Id: parseString(item.Id),
    ParentIndexNumber: parseOptionalNumber(item.ParentIndexNumber),
    IndexNumber: parseOptionalNumber(item.IndexNumber),
    ProductionYear: parseOptionalNumber(item.ProductionYear),
    ImageTags: imageTags?.Primary ? { Primary: parseString(imageTags.Primary) } : undefined,
    // Episode series info for poster lookup
    SeriesId: parseOptionalString(item.SeriesId),
    SeriesPrimaryImageTag: parseOptionalString(item.SeriesPrimaryImageTag),
  };
}

/**
 * Parse Emby Items API response (batch item fetch)
 */
export function parseItemsResponse(data: unknown): EmbyItemResult[] {
  const items = (data as { Items?: unknown[] })?.Items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => parseItem(item as Record<string, unknown>));
}
