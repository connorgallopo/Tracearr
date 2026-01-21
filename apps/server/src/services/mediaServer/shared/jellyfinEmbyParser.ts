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
import type {
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaWatchHistoryItem,
  MediaLibraryItem,
} from '../types.js';
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
  // Music track metadata
  Album?: string;
  AlbumArtist?: string;
  Artists?: string[];
  AlbumId?: string;
  AlbumPrimaryImageTag?: string;
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

  // Parse Artists array if present
  const artistsRaw = item.Artists;
  const artists = Array.isArray(artistsRaw)
    ? artistsRaw.filter((a): a is string => typeof a === 'string')
    : undefined;

  return {
    Id: parseString(item.Id),
    ParentIndexNumber: parseOptionalNumber(item.ParentIndexNumber),
    IndexNumber: parseOptionalNumber(item.IndexNumber),
    ProductionYear: parseOptionalNumber(item.ProductionYear),
    ImageTags: imageTags?.Primary ? { Primary: parseString(imageTags.Primary) } : undefined,
    SeriesId: parseOptionalString(item.SeriesId),
    SeriesPrimaryImageTag: parseOptionalString(item.SeriesPrimaryImageTag),
    // Music metadata
    Album: parseOptionalString(item.Album),
    AlbumArtist: parseOptionalString(item.AlbumArtist),
    Artists: artists?.length ? artists : undefined,
    AlbumId: parseOptionalString(item.AlbumId),
    AlbumPrimaryImageTag: parseOptionalString(item.AlbumPrimaryImageTag),
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

// ============================================================================
// Library Items Parsing (for library snapshots)
// ============================================================================

/**
 * Parse ProviderIds object to extract external IDs
 * Handles both capitalized (Imdb) and lowercase (imdb) keys
 */
export function parseProviderIds(providerIds: unknown): {
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
} {
  if (!providerIds || typeof providerIds !== 'object') {
    return {};
  }

  const ids = providerIds as Record<string, unknown>;

  // Handle both capitalized and lowercase keys
  const imdbRaw = ids.Imdb ?? ids.imdb ?? ids.IMDB;
  const tmdbRaw = ids.Tmdb ?? ids.tmdb ?? ids.TMDB;
  const tvdbRaw = ids.Tvdb ?? ids.tvdb ?? ids.TVDB;

  const result: { imdbId?: string; tmdbId?: number; tvdbId?: number } = {};

  if (typeof imdbRaw === 'string' && imdbRaw.length > 0) {
    result.imdbId = imdbRaw;
  }

  if (tmdbRaw !== undefined && tmdbRaw !== null) {
    const parsed = typeof tmdbRaw === 'number' ? tmdbRaw : parseInt(String(tmdbRaw), 10);
    if (!isNaN(parsed)) {
      result.tmdbId = parsed;
    }
  }

  if (tvdbRaw !== undefined && tvdbRaw !== null) {
    const parsed = typeof tvdbRaw === 'number' ? tvdbRaw : parseInt(String(tvdbRaw), 10);
    if (!isNaN(parsed)) {
      result.tvdbId = parsed;
    }
  }

  return result;
}

/**
 * Map Jellyfin/Emby Type to MediaLibraryItem mediaType
 */
export function mapJellyfinType(
  type: unknown
): 'movie' | 'show' | 'season' | 'episode' | 'artist' | 'album' | 'track' {
  const typeStr = (typeof type === 'string' ? type : '').toLowerCase();

  switch (typeStr) {
    case 'movie':
      return 'movie';
    case 'series':
      return 'show';
    case 'season':
      return 'season';
    case 'episode':
      return 'episode';
    case 'musicartist':
      return 'artist';
    case 'musicalbum':
      return 'album';
    case 'audio':
      return 'track';
    default:
      return 'movie'; // Default to movie for unknown types
  }
}

/**
 * Convert video dimensions to resolution string
 */
export function getResolutionString(width?: number, _height?: number): string | undefined {
  if (!width || width <= 0) return undefined;

  if (width >= 3840) return '4k';
  if (width >= 1920) return '1080p';
  if (width >= 1280) return '720p';
  if (width >= 720) return '480p';
  return 'sd';
}

/**
 * Extract quality information from MediaSources and MediaStreams
 */
export function extractQuality(
  mediaSources: unknown,
  mediaStreams?: unknown
): {
  videoResolution?: string;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  fileSize?: number;
  container?: string;
} {
  const result: {
    videoResolution?: string;
    videoCodec?: string;
    audioCodec?: string;
    audioChannels?: number;
    fileSize?: number;
    container?: string;
  } = {};

  // Get streams from MediaSources (preferred) or direct MediaStreams
  let streams: unknown[] = [];
  let source: Record<string, unknown> | undefined;

  if (Array.isArray(mediaSources) && mediaSources.length > 0) {
    source = mediaSources[0] as Record<string, unknown>;
    streams = Array.isArray(source?.MediaStreams) ? (source.MediaStreams as unknown[]) : [];

    // Extract container and file size from source
    if (typeof source?.Container === 'string') {
      result.container = source.Container.toLowerCase();
    }
    if (typeof source?.Size === 'number') {
      result.fileSize = source.Size;
    }
  } else if (Array.isArray(mediaStreams)) {
    streams = mediaStreams;
  }

  // Find video and audio streams
  for (const stream of streams) {
    if (!stream || typeof stream !== 'object') continue;
    const s = stream as Record<string, unknown>;

    if (s.Type === 'Video' && !result.videoCodec) {
      const width = typeof s.Width === 'number' ? s.Width : undefined;
      const height = typeof s.Height === 'number' ? s.Height : undefined;
      result.videoResolution = getResolutionString(width, height);
      if (typeof s.Codec === 'string') {
        result.videoCodec = s.Codec.toUpperCase();
      }
    }

    if (s.Type === 'Audio' && !result.audioCodec) {
      if (typeof s.Codec === 'string') {
        result.audioCodec = s.Codec.toUpperCase();
      }
      if (typeof s.Channels === 'number') {
        result.audioChannels = s.Channels;
      }
    }
  }

  return result;
}

/**
 * Safely parse a date string or timestamp
 */
export function parseLibraryDate(value: unknown): Date | undefined {
  if (!value) return undefined;

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? undefined : value;
  }

  if (typeof value === 'string') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? undefined : date;
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? undefined : date;
  }

  return undefined;
}

/**
 * Parse a single library item from Jellyfin/Emby API response
 */
export function parseLibraryItem(item: Record<string, unknown>): MediaLibraryItem {
  const providerIds = parseProviderIds(item.ProviderIds);
  const quality = extractQuality(item.MediaSources, item.MediaStreams);

  const result: MediaLibraryItem = {
    ratingKey: parseString(item.Id),
    title: parseString(item.Name),
    mediaType: mapJellyfinType(item.Type),
    year: parseOptionalNumber(item.ProductionYear),
    addedAt: parseLibraryDate(item.DateCreated) ?? new Date(),
    // Quality fields
    videoResolution: quality.videoResolution,
    videoCodec: quality.videoCodec,
    audioCodec: quality.audioCodec,
    audioChannels: quality.audioChannels,
    fileSize: quality.fileSize,
    container: quality.container,
    // External IDs
    imdbId: providerIds.imdbId,
    tmdbId: providerIds.tmdbId,
    tvdbId: providerIds.tvdbId,
    // File path (debug only)
    filePath: parseOptionalString(item.Path),
  };

  // Hierarchy fields for episodes and tracks
  if (result.mediaType === 'episode') {
    result.grandparentTitle = parseOptionalString(item.SeriesName);
    result.grandparentRatingKey = parseOptionalString(item.SeriesId);
    result.parentIndex = parseOptionalNumber(item.ParentIndexNumber); // season number
    result.itemIndex = parseOptionalNumber(item.IndexNumber); // episode number
  } else if (result.mediaType === 'track') {
    // AlbumArtist is preferred, fall back to first artist in Artists array
    const artists = item.Artists;
    const albumArtist = parseOptionalString(item.AlbumArtist);
    const firstArtist =
      Array.isArray(artists) && artists.length > 0 ? parseOptionalString(artists[0]) : undefined;
    result.grandparentTitle = albumArtist ?? firstArtist; // artist
    result.parentTitle = parseOptionalString(item.Album); // album
    result.itemIndex = parseOptionalNumber(item.IndexNumber); // track number
  }

  return result;
}

/**
 * Parse library items from Jellyfin/Emby /Items API response
 */
export function parseLibraryItemsResponse(data: unknown[]): MediaLibraryItem[] {
  if (!Array.isArray(data)) return [];
  return data.map((item) => parseLibraryItem(item as Record<string, unknown>));
}
