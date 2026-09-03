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
  extractIpFromEndpoint,
} from '../../../utils/parsing.js';
import type { StreamDecisions } from '../../../utils/transcodeNormalizer.js';
import type {
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaWatchHistoryItem,
  MediaLibraryItem,
  MediaItemVersion,
} from '../types.js';
import { computeVersionsFingerprint, pickBestVersion, sumVersionSizes } from './versionUtils.js';
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
  mapDynamicRange,
} from './jellyfinEmbyUtils.js';
import { classifyByDimensions, normalizeDynamicRange } from '@tracearr/shared';

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
  Type?: string;
  ExtraType?: string;
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
  RunTimeTicks?: number;
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
  // A valid "no sessions" response is an empty array. A non-array body means the
  // response is malformed (proxy error page, wrong shape); throw so the caller
  // treats it as a failed poll rather than "all sessions ended".
  if (!Array.isArray(sessions)) {
    throw new Error('Unexpected sessions response: expected an array');
  }

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

  // For music tracks, extract metadata early so we can use album artwork as fallback
  const musicMetadata = mediaType === 'track' ? extractMusicMetadata(nowPlaying) : undefined;

  // Build thumb path: use item's Primary image, or album artwork for music tracks
  const itemThumbPath = buildItemImagePath(itemId, primaryImageTag);
  const thumbPath = itemThumbPath ?? musicMetadata?.albumThumbPath;

  // Parse lastPausedDate only if the platform supports it (Jellyfin only)
  let lastPausedDate: Date | undefined;
  if (supportsLastPausedDate) {
    const lastPausedDateStr = parseOptionalString(session.LastPausedDate);
    lastPausedDate = lastPausedDateStr ? new Date(lastPausedDateStr) : undefined;
  }

  const result: MediaSession = {
    sessionKey: parseString(session.Id),
    mediaId: itemId,
    serverVersionKey: parseOptionalString(playState?.MediaSourceId),
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
      thumbPath,
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
      ipAddress: extractIpFromEndpoint(parseString(session.RemoteEndPoint)),
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
      seasonNumber: parseOptionalNumber(nowPlaying.ParentIndexNumber) ?? null,
      episodeNumber: parseOptionalNumber(nowPlaying.IndexNumber) ?? null,
      seasonName: parseOptionalString(nowPlaying.SeasonName),
      showThumbPath: seriesId ? buildItemImagePath(seriesId, seriesImageTag) : undefined,
    };
  }

  // Add Live TV metadata if this is a live stream
  if (mediaType === 'live') {
    result.live = extractLiveTvMetadata(nowPlaying);
  }

  // Add music track metadata if this is a track (already extracted above for thumb fallback)
  if (musicMetadata) {
    result.music = musicMetadata;
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
    Type: parseOptionalString(item.Type),
    ExtraType: parseOptionalString(item.ExtraType),
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
    RunTimeTicks: parseOptionalNumber(item.RunTimeTicks),
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

// PostgreSQL integer max value (signed 32-bit)
const POSTGRES_INT_MAX = 2147483647;

/**
 * Fix duplicated numeric IDs (e.g., "129536129536" → 129536)
 * Some media servers have corrupted metadata where IDs get concatenated with themselves.
 * This detects the pattern and recovers the original value.
 */
function fixDuplicatedId(value: number): number {
  // Only check values that exceed PostgreSQL integer max
  if (value <= POSTGRES_INT_MAX) return value;

  const str = String(value);
  const len = str.length;

  // Must be even length to be a duplicate
  if (len % 2 !== 0) return value;

  const half = len / 2;
  const firstHalf = str.slice(0, half);
  const secondHalf = str.slice(half);

  // Check if it's the same value repeated
  if (firstHalf === secondHalf) {
    const fixed = parseInt(firstHalf, 10);
    // Ensure the recovered value is valid
    if (!isNaN(fixed) && fixed > 0 && fixed <= POSTGRES_INT_MAX) {
      return fixed;
    }
  }

  return value;
}

/**
 * Parse and validate a numeric external ID (TMDB/TVDB).
 * Handles corrupted metadata and validates within PostgreSQL integer range.
 */
function parseExternalId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;

  const parsed = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (isNaN(parsed) || parsed <= 0) return undefined;

  // Try to fix duplicated IDs (e.g., "129536129536" → 129536)
  const fixed = fixDuplicatedId(parsed);

  // Validate within PostgreSQL integer range
  if (fixed > POSTGRES_INT_MAX) return undefined;

  return fixed;
}

/**
 * Parse ProviderIds object to extract external IDs
 * Handles both capitalized (Imdb) and lowercase (imdb) keys
 *
 * @param mediaType - When 'track'/'album'/'artist', also extracts the matching
 *   MusicBrainz field (MusicBrainzTrack/Album/Artist, AlbumArtist for artist)
 */
export function parseProviderIds(
  providerIds: unknown,
  mediaType?: string
): {
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
  musicBrainzId?: string;
} {
  if (!providerIds || typeof providerIds !== 'object') {
    return {};
  }

  const ids = providerIds as Record<string, unknown>;

  // Handle both capitalized and lowercase keys
  const imdbRaw = ids.Imdb ?? ids.imdb ?? ids.IMDB;
  const tmdbRaw = ids.Tmdb ?? ids.tmdb ?? ids.TMDB;
  const tvdbRaw = ids.Tvdb ?? ids.tvdb ?? ids.TVDB;

  const result: { imdbId?: string; tmdbId?: number; tvdbId?: number; musicBrainzId?: string } = {};

  if (typeof imdbRaw === 'string' && imdbRaw.length > 0) {
    // Extract valid IMDB ID (tt followed by digits) - handles malformed data like "tt37547598/?ref_=..."
    const imdbMatch = imdbRaw.match(/^(tt\d+)/);
    if (imdbMatch) {
      result.imdbId = imdbMatch[1];
    }
  }

  result.tmdbId = parseExternalId(tmdbRaw);
  result.tvdbId = parseExternalId(tvdbRaw);

  const mbidRaw =
    mediaType === 'track'
      ? (ids.MusicBrainzTrack ?? ids.musicBrainzTrack)
      : mediaType === 'album'
        ? (ids.MusicBrainzAlbum ?? ids.musicBrainzAlbum)
        : mediaType === 'artist'
          ? (ids.MusicBrainzArtist ??
            ids.musicBrainzArtist ??
            ids.MusicBrainzAlbumArtist ??
            ids.musicBrainzAlbumArtist)
          : undefined;
  if (typeof mbidRaw === 'string' && mbidRaw.length > 0) {
    result.musicBrainzId = mbidRaw;
  }

  return result;
}

/**
 * Map Jellyfin/Emby Type to MediaLibraryItem mediaType
 */
export function mapJellyfinType(
  type: unknown
): 'movie' | 'show' | 'season' | 'episode' | 'artist' | 'album' | 'track' | 'photo' {
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
    case 'photo':
      return 'photo';
    default:
      return 'movie';
  }
}

/**
 * Convert video dimensions to a resolution string.
 *
 * Uses width OR height (whichever gives the higher tier) so 4:3 and other
 * non-16:9 sources aren't misclassified from width alone.
 */
export function getResolutionString(width?: number, height?: number): string | undefined {
  if (!width || width <= 0) return undefined;

  return classifyByDimensions(width, height)?.toLowerCase();
}

/**
 * First video / first audio stream quality within ONE MediaSource's streams.
 * VideoRangeType (and its color-attribute fallbacks) is already part of the
 * stream object Fields=MediaSources returns - no extra Fields entry needed.
 */
function streamQuality(streams: unknown[]): {
  videoResolution?: string;
  videoCodec?: string;
  videoDynamicRange?: string;
  audioCodec?: string;
  audioChannels?: number;
} {
  const result: {
    videoResolution?: string;
    videoCodec?: string;
    videoDynamicRange?: string;
    audioCodec?: string;
    audioChannels?: number;
  } = {};

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
      result.videoDynamicRange = normalizeDynamicRange(mapDynamicRange(s)) ?? undefined;
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
 * One MediaItemVersion per MediaSource, each with its own streams' quality.
 * When the payload has no MediaSources but does carry item-level MediaStreams
 * (some Emby list shapes), a single version keyed by the item id stands in;
 * JF names its primary MediaSource with the item id anyway, so the key stays
 * stable once a full payload arrives.
 */
export function extractVersions(
  mediaSources: unknown,
  mediaStreams: unknown,
  itemId: string
): MediaItemVersion[] {
  if (Array.isArray(mediaSources) && mediaSources.length > 0) {
    const versions: MediaItemVersion[] = [];
    for (const source of mediaSources) {
      if (!source || typeof source !== 'object') continue;
      const s = source as Record<string, unknown>;
      const sourceId = typeof s.Id === 'string' && s.Id ? s.Id : itemId;
      if (!sourceId) continue;
      const streams = Array.isArray(s.MediaStreams) ? (s.MediaStreams as unknown[]) : [];
      versions.push({
        serverVersionKey: sourceId,
        container: typeof s.Container === 'string' ? s.Container.toLowerCase() : undefined,
        fileSize: typeof s.Size === 'number' ? s.Size : undefined,
        // MediaSource.Bitrate is bps; versions store kbps like sessions do
        bitrate: typeof s.Bitrate === 'number' ? Math.round(s.Bitrate / 1000) : undefined,
        partCount: 1,
        filePath: typeof s.Path === 'string' && s.Path ? s.Path : undefined,
        ...streamQuality(streams),
      });
    }
    return versions;
  }

  if (Array.isArray(mediaStreams) && mediaStreams.length > 0 && itemId) {
    return [{ serverVersionKey: itemId, partCount: 1, ...streamQuality(mediaStreams) }];
  }

  return [];
}

/**
 * Extract quality information from MediaSources and MediaStreams.
 * Flat rollup over extractVersions: file size sums, the rest comes from the
 * best version.
 */
export function extractQuality(
  mediaSources: unknown,
  mediaStreams?: unknown
): {
  videoResolution?: string;
  videoCodec?: string;
  videoDynamicRange?: string;
  audioCodec?: string;
  audioChannels?: number;
  fileSize?: number;
  container?: string;
} {
  const versions = extractVersions(mediaSources, mediaStreams, 'quality:probe');
  const best = pickBestVersion(versions);
  return {
    videoResolution: best?.videoResolution,
    videoCodec: best?.videoCodec,
    videoDynamicRange: best?.videoDynamicRange,
    audioCodec: best?.audioCodec,
    audioChannels: best?.audioChannels,
    fileSize: sumVersionSizes(versions),
    container: best?.container,
  };
}

/**
 * Minimum valid year for library items.
 * Emby/Jellyfin may return ancient dates like "0001-01-01" for items with missing metadata.
 */
const MIN_VALID_YEAR = 2015;

/**
 * Safely parse a date string or timestamp.
 * Returns undefined for invalid dates or dates before MIN_VALID_YEAR.
 */
export function parseLibraryDate(value: unknown): Date | undefined {
  if (!value) return undefined;

  let date: Date | undefined;

  if (value instanceof Date) {
    date = isNaN(value.getTime()) ? undefined : value;
  } else if (typeof value === 'string') {
    const parsed = new Date(value);
    date = isNaN(parsed.getTime()) ? undefined : parsed;
  } else if (typeof value === 'number') {
    const parsed = new Date(value);
    date = isNaN(parsed.getTime()) ? undefined : parsed;
  }

  // Reject dates before MIN_VALID_YEAR - these indicate missing/corrupt metadata
  if (date && date.getFullYear() < MIN_VALID_YEAR) {
    return undefined;
  }

  return date;
}

/**
 * Parse a single library item from Jellyfin/Emby API response
 */
export function parseLibraryItem(item: Record<string, unknown>): MediaLibraryItem {
  const mappedType = mapJellyfinType(item.Type);
  const providerIds = parseProviderIds(item.ProviderIds, mappedType);
  const versions = extractVersions(item.MediaSources, item.MediaStreams, parseString(item.Id));
  const bestVersion = pickBestVersion(versions);
  const genres = Array.isArray(item.Genres)
    ? item.Genres.filter((g): g is string => typeof g === 'string' && g.length > 0)
    : undefined;

  // Parse year first so we can use it as addedAt fallback
  const year = parseOptionalNumber(item.ProductionYear);

  // Fallback chain for addedAt: DateCreated -> Jan 1 of ProductionYear -> cutoff date
  // Only use year fallback if it's >= MIN_VALID_YEAR (2015)
  // Final fallback uses cutoff date instead of "today" to cluster legacy items at the cutoff
  const dateCreated = parseLibraryDate(item.DateCreated);
  let yearFallback: Date | undefined;
  if (year && year >= MIN_VALID_YEAR) {
    const d = new Date(Date.UTC(year, 0, 1));
    if (!isNaN(d.getTime())) yearFallback = d;
  }
  const FALLBACK_DATE = new Date(Date.UTC(MIN_VALID_YEAR, 0, 1));
  const addedAt = dateCreated ?? yearFallback ?? FALLBACK_DATE;

  const itemId = parseString(item.Id);
  const imageTags = getNestedObject(item, 'ImageTags');
  const primaryTag = imageTags?.Primary ? parseString(imageTags.Primary) : undefined;
  // Tracks repeat the album cover under their own item id, so point them at the
  // album to cache it once. Only when the album has its own image: without a tag
  // it has no Primary resource and the album URL 404s.
  const albumTag =
    mappedType === 'track' ? parseOptionalString(item.AlbumPrimaryImageTag) : undefined;
  const albumId = albumTag ? parseOptionalString(item.AlbumId) : undefined;
  const thumbPath = albumId
    ? `/Items/${albumId}/Images/Primary?tag=${albumTag!}`
    : `/Items/${itemId}/Images/Primary${primaryTag ? `?tag=${primaryTag}` : ''}`;

  const result: MediaLibraryItem = {
    ratingKey: itemId,
    title: parseString(item.Name),
    mediaType: mappedType,
    year,
    addedAt,
    thumbPath,
    // Quality rollups over the version list
    videoResolution: bestVersion?.videoResolution,
    videoCodec: bestVersion?.videoCodec,
    videoDynamicRange: bestVersion?.videoDynamicRange,
    audioCodec: bestVersion?.audioCodec,
    audioChannels: bestVersion?.audioChannels,
    fileSize: sumVersionSizes(versions),
    container: bestVersion?.container,
    versions,
    versionsFingerprint: computeVersionsFingerprint(versions),
    // External IDs
    imdbId: providerIds.imdbId,
    tmdbId: providerIds.tmdbId,
    tvdbId: providerIds.tvdbId,
    musicBrainzId: providerIds.musicBrainzId,
    genres: genres && genres.length > 0 ? genres : undefined,
    // File path (debug only)
    filePath: parseOptionalString(item.Path),
  };

  // Hierarchy fields for episodes and tracks
  if (result.mediaType === 'episode') {
    result.grandparentTitle = parseOptionalString(item.SeriesName);
    result.grandparentRatingKey = parseOptionalString(item.SeriesId);
    // SeasonId/SeasonName ride the Episode DTO without being asked for in Fields.
    result.parentTitle = parseOptionalString(item.SeasonName);
    result.parentRatingKey = parseOptionalString(item.SeasonId);
    result.parentIndex = parseOptionalNumber(item.ParentIndexNumber); // season number
    result.itemIndex = parseOptionalNumber(item.IndexNumber); // episode number
  } else if (result.mediaType === 'season') {
    // A season's own Name is often the season's title ("All Systems Red"), not "Season N".
    result.parentTitle = parseOptionalString(item.SeriesName);
    result.parentRatingKey = parseOptionalString(item.SeriesId);
    result.parentIndex = parseOptionalNumber(item.IndexNumber); // season number, 0 = Specials
  } else if (result.mediaType === 'track') {
    // AlbumArtist is preferred, fall back to first artist in Artists array
    const artists = item.Artists;
    const albumArtist = parseOptionalString(item.AlbumArtist);
    const firstArtist =
      Array.isArray(artists) && artists.length > 0 ? parseOptionalString(artists[0]) : undefined;
    result.grandparentTitle = albumArtist ?? firstArtist; // artist
    result.parentTitle = parseOptionalString(item.Album); // album
    result.itemIndex = parseOptionalNumber(item.IndexNumber); // track number
    const albumArtists = item.AlbumArtists;
    if (Array.isArray(albumArtists) && albumArtists.length > 0) {
      result.grandparentRatingKey = parseOptionalString(
        (albumArtists[0] as Record<string, unknown>)?.Id
      );
    }
    result.parentRatingKey = parseOptionalString(item.AlbumId);
  } else if (result.mediaType === 'album') {
    const artists = item.AlbumArtists ?? item.Artists;
    const albumArtist = parseOptionalString(item.AlbumArtist);
    const firstArtistId =
      Array.isArray(item.AlbumArtists) && item.AlbumArtists.length > 0
        ? parseOptionalString((item.AlbumArtists[0] as Record<string, unknown>)?.Id)
        : undefined;
    const firstArtistName =
      Array.isArray(artists) && artists.length > 0
        ? parseOptionalString(
            typeof artists[0] === 'string'
              ? artists[0]
              : (artists[0] as Record<string, unknown>)?.Name
          )
        : undefined;
    result.parentTitle = albumArtist ?? firstArtistName;
    result.parentRatingKey = firstArtistId;
  }

  return result;
}

/**
 * Supported Jellyfin/Emby item types for library sync. Season is only ever
 * requested via getLibraryLeaves(Since) - see baseMediaServerClient.ts - so
 * listing it here doesn't pull seasons into the top-level items query too.
 */
const ALLOWED_LIBRARY_ITEM_TYPES = new Set([
  'movie',
  'series',
  'episode',
  'season',
  'musicartist',
  'audio',
]);

/**
 * Parse library items from Jellyfin/Emby /Items API response
 */
export function parseLibraryItemsResponse(data: unknown[]): MediaLibraryItem[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((item) => {
      const record = item as Record<string, unknown>;
      const type = (typeof record.Type === 'string' ? record.Type : '').toLowerCase();
      if (!ALLOWED_LIBRARY_ITEM_TYPES.has(type)) return false;
      // Extras (trailers, behind-the-scenes, etc.) can share Type with their parent
      // content, so the allowlist above isn't enough - reuse the same ExtraType check
      // the session parser uses. Extras already synced before this filter existed clear
      // on the next sync via the existing removed_at reconciliation (see librarySync.ts).
      return !shouldFilterItem(record);
    })
    .map((item) => parseLibraryItem(item as Record<string, unknown>));
}
