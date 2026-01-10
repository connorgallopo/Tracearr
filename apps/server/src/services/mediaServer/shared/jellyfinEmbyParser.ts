/**
 * Shared Jellyfin/Emby API Response Parser Functions
 *
 * These functions are 100% identical between Jellyfin and Emby parsers.
 * Extracted here to reduce duplication and ensure consistency.
 */

import {
  parseString,
  parseNumber,
  parseBoolean,
  parseOptionalString,
  parseOptionalNumber,
  getNestedObject,
  parseDateString,
} from '../../../utils/parsing.js';
import type { StreamDecisions } from '../../../utils/transcodeNormalizer.js';
import type { MediaSession, MediaUser, MediaLibrary, MediaWatchHistoryItem } from '../types.js';
import {
  ticksToMs,
  parseMediaType,
  calculateProgress,
  getBitrate,
  getVideoDimensions,
  buildItemImagePath,
  buildUserImagePath,
  shouldFilterItem,
  extractLiveTvMetadata,
  extractMusicMetadata,
  extractStreamDetails,
} from './jellyfinEmbyUtils.js';

// ============================================================================
// Stream Decisions Function Type
// ============================================================================

/**
 * Function type for platform-specific stream decision logic.
 * Jellyfin and Emby have different behaviors for DirectStream handling.
 */
export type StreamDecisionsFn = (session: Record<string, unknown>) => StreamDecisions;

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Activity log entry - identical structure for Jellyfin and Emby
 */
export interface JellyfinEmbyActivityEntry {
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
 * Authentication result - identical structure for Jellyfin and Emby
 */
export interface JellyfinEmbyAuthResult {
  id: string;
  username: string;
  token: string;
  serverId: string;
  isAdmin: boolean;
}

/**
 * Item result for media enrichment - identical structure for Jellyfin and Emby
 */
export interface JellyfinEmbyItemResult {
  Id: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  ImageTags?: {
    Primary?: string;
  };
  SeriesId?: string;
  SeriesPrimaryImageTag?: string;
}

// ============================================================================
// Session Parsing (Shared Helpers)
// ============================================================================

/**
 * Parse playback state from Jellyfin/Emby to unified state
 */
export function parsePlaybackState(isPaused: unknown): MediaSession['playback']['state'] {
  return parseBoolean(isPaused) ? 'paused' : 'playing';
}

/**
 * Parse sessions API response - filters to only sessions with active playback
 */
export function parseSessionsResponse(
  sessions: unknown[],
  parseSession: (session: Record<string, unknown>) => MediaSession | null
): MediaSession[] {
  if (!Array.isArray(sessions)) return [];

  const results: MediaSession[] = [];
  for (const session of sessions) {
    const parsed = parseSession(session as Record<string, unknown>);
    if (parsed) results.push(parsed);
  }
  return results;
}

/**
 * Core session parsing logic shared between Jellyfin and Emby.
 *
 * @param session - Raw session data from the API
 * @param getStreamDecisions - Platform-specific stream decision function
 * @param supportsLastPausedDate - Whether the platform supports LastPausedDate (Jellyfin only)
 * @returns Parsed MediaSession or null if no active playback
 */
export function parseSessionCore(
  session: Record<string, unknown>,
  getStreamDecisions: StreamDecisionsFn,
  supportsLastPausedDate: boolean
): MediaSession | null {
  const nowPlaying = getNestedObject(session, 'NowPlayingItem');
  if (!nowPlaying) return null; // No active playback

  // Filter out non-primary content (trailers, prerolls, theme songs/videos)
  if (shouldFilterItem(nowPlaying)) return null;

  const playState = getNestedObject(session, 'PlayState');
  const imageTags = getNestedObject(nowPlaying, 'ImageTags');

  const durationMs = ticksToMs(nowPlaying.RunTimeTicks);
  const positionMs = ticksToMs(playState?.PositionTicks);
  const mediaType = parseMediaType(nowPlaying.Type);

  // Get stream decisions using the platform-specific logic
  const { videoDecision, audioDecision, isTranscode } = getStreamDecisions(session);

  // Build full image paths (not just image tag IDs)
  const itemId = parseString(nowPlaying.Id);
  const userId = parseString(session.UserId);
  const userImageTag = parseOptionalString(session.UserPrimaryImageTag);
  const primaryImageTag = imageTags?.Primary ? parseString(imageTags.Primary) : undefined;

  // Parse lastPausedDate only if the platform supports it (Jellyfin only)
  let lastPausedDate: Date | undefined;
  if (supportsLastPausedDate) {
    const lastPausedDateStr = parseOptionalString(session.LastPausedDate);
    lastPausedDate = lastPausedDateStr ? new Date(lastPausedDateStr) : undefined;
  }

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
      platform: undefined, // Neither Jellyfin nor Emby provides platform separately
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
      ...extractStreamDetails(session),
    },
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

// ============================================================================
// User Parsing
// ============================================================================

/**
 * Parse raw Jellyfin/Emby user data into a MediaUser object
 */
export function parseUser(user: Record<string, unknown>): MediaUser {
  const policy = getNestedObject(user, 'Policy');
  const userId = parseString(user.Id);
  const imageTag = parseOptionalString(user.PrimaryImageTag);

  return {
    id: userId,
    username: parseString(user.Name),
    email: undefined, // Neither Jellyfin nor Emby expose email in user API
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
 * Parse users API response
 */
export function parseUsersResponse(users: unknown[]): MediaUser[] {
  if (!Array.isArray(users)) return [];
  return users.map((user) => parseUser(user as Record<string, unknown>));
}

// ============================================================================
// Library Parsing
// ============================================================================

/**
 * Parse raw library (virtual folder) data into a MediaLibrary object
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
 * Parse libraries (virtual folders) API response
 */
export function parseLibrariesResponse(folders: unknown[]): MediaLibrary[] {
  if (!Array.isArray(folders)) return [];
  return folders.map((folder) => parseLibrary(folder as Record<string, unknown>));
}

// ============================================================================
// Watch History Parsing
// ============================================================================

/**
 * Parse raw watch history item into a MediaWatchHistoryItem object
 */
export function parseWatchHistoryItem(item: Record<string, unknown>): MediaWatchHistoryItem {
  const userData = getNestedObject(item, 'UserData');
  const mediaType = parseMediaType(item.Type);

  const historyItem: MediaWatchHistoryItem = {
    mediaId: parseString(item.Id),
    title: parseString(item.Name),
    type: mediaType === 'photo' ? 'unknown' : mediaType,
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
 * Parse watch history (Items) API response
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
 * Parse raw activity log item
 */
export function parseActivityLogItem(item: Record<string, unknown>): JellyfinEmbyActivityEntry {
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
 * Parse activity log API response
 */
export function parseActivityLogResponse(data: unknown): JellyfinEmbyActivityEntry[] {
  const items = (data as { Items?: unknown[] })?.Items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => parseActivityLogItem(item as Record<string, unknown>));
}

// ============================================================================
// Authentication Response Parsing
// ============================================================================

/**
 * Parse authentication response
 */
export function parseAuthResponse(data: Record<string, unknown>): JellyfinEmbyAuthResult {
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
 * Parse a single item for enrichment
 */
export function parseItem(item: Record<string, unknown>): JellyfinEmbyItemResult {
  const imageTags = getNestedObject(item, 'ImageTags');

  return {
    Id: parseString(item.Id),
    ParentIndexNumber: parseOptionalNumber(item.ParentIndexNumber),
    IndexNumber: parseOptionalNumber(item.IndexNumber),
    ProductionYear: parseOptionalNumber(item.ProductionYear),
    ImageTags: imageTags?.Primary ? { Primary: parseString(imageTags.Primary) } : undefined,
    SeriesId: parseOptionalString(item.SeriesId),
    SeriesPrimaryImageTag: parseOptionalString(item.SeriesPrimaryImageTag),
  };
}

/**
 * Parse Items API response (batch item fetch)
 */
export function parseItemsResponse(data: unknown): JellyfinEmbyItemResult[] {
  const items = (data as { Items?: unknown[] })?.Items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => parseItem(item as Record<string, unknown>));
}
