/**
 * Shared utilities for Jellyfin and Emby parsers
 *
 * These platforms share nearly identical APIs (Emby is a Jellyfin fork).
 * Common pure utility functions are extracted here to reduce duplication
 * while keeping platform-specific logic in each parser.
 */

import {
  parseString,
  parseNumber,
  parseOptionalString,
  parseOptionalNumber,
  parseBoundedString,
  parseOptionalBoundedString,
  getNestedObject,
  getNestedValue,
} from '../../../utils/parsing.js';
import {
  normalizePlayMethod,
  isTranscodingFromInfo,
  type StreamDecisions,
} from '../../../utils/transcodeNormalizer.js';
import type { MediaSession } from '../types.js';

// Import and re-export cross-platform utilities
export { calculateProgress } from './parserUtils.js';

// ============================================================================
// Constants
// ============================================================================

/** Jellyfin/Emby ticks per millisecond (10,000 ticks = 1ms) */
export const TICKS_PER_MS = 10000;

/** Item types that should be filtered from session parsing */
export const FILTERED_ITEM_TYPES = new Set([
  'trailer', // Movie trailers
]);

/** Extra types that should be filtered (prerolls, theme songs/videos) */
export const FILTERED_EXTRA_TYPES = new Set(['themesong', 'themevideo']);

// ============================================================================
// Core Utility Functions
// ============================================================================

/**
 * Convert ticks to milliseconds
 * Both Jellyfin and Emby use 10,000 ticks per millisecond
 */
export function ticksToMs(ticks: unknown): number {
  const tickNum = parseNumber(ticks);
  return Math.floor(tickNum / TICKS_PER_MS);
}

/**
 * Parse media type to unified type
 * Both platforms use the same type strings
 */
export function parseMediaType(type: unknown): MediaSession['media']['type'] {
  const typeStr = parseString(type).toLowerCase();
  switch (typeStr) {
    case 'movie':
      return 'movie';
    case 'episode':
      return 'episode';
    case 'audio':
      return 'track';
    case 'livetvchannel':
    case 'tvchannel':
      return 'live';
    case 'photo':
      return 'photo';
    default:
      return 'unknown';
  }
}

/**
 * Get bitrate from session in kbps
 * Both APIs return bitrate in bps, we convert to kbps for Plex consistency
 */
export function getBitrate(session: Record<string, unknown>): number {
  // Check transcoding info first
  const transcodingInfo = getNestedObject(session, 'TranscodingInfo');
  if (transcodingInfo) {
    const transcodeBitrate = parseNumber(transcodingInfo.Bitrate);
    if (transcodeBitrate > 0) return Math.round(transcodeBitrate / 1000);
  }

  // Fall back to source media bitrate
  const nowPlaying = getNestedObject(session, 'NowPlayingItem');
  const mediaSources = nowPlaying?.MediaSources;
  if (Array.isArray(mediaSources) && mediaSources.length > 0) {
    const firstSource = mediaSources[0] as Record<string, unknown>;
    const bitrate = parseNumber(firstSource?.Bitrate);
    return Math.round(bitrate / 1000);
  }

  return 0;
}

/**
 * Get video dimensions from session for resolution display
 * Checks TranscodingInfo first (for transcoded resolution), then falls back to source
 */
export function getVideoDimensions(session: Record<string, unknown>): {
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

  // Fall back to source media dimensions
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

/** Stream flags extracted from session for decision logic */
interface StreamFlags {
  playMethod: string | undefined;
  transcodingInfo: Record<string, unknown> | undefined;
  isVideoDirect: boolean | undefined;
  isAudioDirect: boolean | undefined;
}

/** Default directplay result when no transcoding detected */
const DIRECT_PLAY_RESULT: StreamDecisions = {
  videoDecision: 'directplay',
  audioDecision: 'directplay',
  isTranscode: false,
};

/**
 * Extract stream decision flags from session
 * Shared by both Jellyfin and Emby parsers
 */
function extractStreamFlags(session: Record<string, unknown>): StreamFlags {
  const playState = getNestedObject(session, 'PlayState');
  const playMethod = parseOptionalString(playState?.PlayMethod);
  const transcodingInfo = getNestedObject(session, 'TranscodingInfo');

  const isVideoDirect =
    transcodingInfo && typeof getNestedValue(transcodingInfo, 'IsVideoDirect') === 'boolean'
      ? (getNestedValue(transcodingInfo, 'IsVideoDirect') as boolean)
      : undefined;
  const isAudioDirect =
    transcodingInfo && typeof getNestedValue(transcodingInfo, 'IsAudioDirect') === 'boolean'
      ? (getNestedValue(transcodingInfo, 'IsAudioDirect') as boolean)
      : undefined;

  return { playMethod, transcodingInfo, isVideoDirect, isAudioDirect };
}

/**
 * Fallback stream decision when PlayMethod is unavailable
 * Uses TranscodingInfo.IsVideoDirect to determine transcoding
 */
function getStreamDecisionsFallback(
  transcodingInfo: Record<string, unknown> | undefined
): StreamDecisions {
  if (!transcodingInfo) {
    return DIRECT_PLAY_RESULT;
  }

  const isVideoDirect = getNestedValue(transcodingInfo, 'IsVideoDirect');
  if (isTranscodingFromInfo(true, isVideoDirect as boolean | undefined)) {
    return { videoDecision: 'transcode', audioDecision: 'transcode', isTranscode: true };
  }

  return DIRECT_PLAY_RESULT;
}

/**
 * Stream decision logic for Jellyfin
 */
export function getStreamDecisionsJellyfin(session: Record<string, unknown>): StreamDecisions {
  const { playMethod, transcodingInfo, isVideoDirect, isAudioDirect } = extractStreamFlags(session);

  if (playMethod) {
    return normalizePlayMethod(playMethod, isVideoDirect, isAudioDirect);
  }

  return getStreamDecisionsFallback(transcodingInfo);
}

/**
 * Stream decision logic for Emby
 * Has additional DirectStream handling for Emby apps that incorrectly report DirectStream
 */
export function getStreamDecisionsEmby(session: Record<string, unknown>): StreamDecisions {
  const { playMethod, transcodingInfo, isVideoDirect, isAudioDirect } = extractStreamFlags(session);

  if (playMethod) {
    // Emby apps report DirectStream even when no remuxing occurs. Treat as DirectPlay
    // when TranscodingInfo is absent or shows both streams are direct.
    if (playMethod.toLowerCase() === 'directstream') {
      if (!transcodingInfo || (isVideoDirect === true && isAudioDirect === true)) {
        return DIRECT_PLAY_RESULT;
      }
    }

    return normalizePlayMethod(playMethod, isVideoDirect, isAudioDirect);
  }

  return getStreamDecisionsFallback(transcodingInfo);
}

/**
 * Build image URL path for an item
 * Both platforms use: /Items/{id}/Images/{type}
 */
export function buildItemImagePath(
  itemId: string,
  imageTag: string | undefined
): string | undefined {
  if (!imageTag || !itemId) return undefined;
  return `/Items/${itemId}/Images/Primary`;
}

/**
 * Build image URL path for a user avatar
 * Both platforms use: /Users/{id}/Images/Primary
 */
export function buildUserImagePath(
  userId: string,
  imageTag: string | undefined
): string | undefined {
  if (!imageTag || !userId) return undefined;
  return `/Users/${userId}/Images/Primary`;
}

// ============================================================================
// Live TV & Music Metadata Extraction
// ============================================================================

/**
 * Extract live TV metadata from Jellyfin/Emby NowPlayingItem
 * Both platforms use the same field names for live TV channel info.
 * DB limits: channelTitle=255, channelIdentifier=100, channelThumb=500
 */
export function extractLiveTvMetadata(
  nowPlaying: Record<string, unknown>
): { channelTitle: string; channelIdentifier?: string; channelThumb?: string } | undefined {
  const channelId = parseOptionalString(nowPlaying.ChannelId);
  const channelTitle =
    parseBoundedString(nowPlaying.ChannelName, 255) || parseBoundedString(nowPlaying.Name, 255);

  if (!channelTitle) return undefined;

  return {
    channelTitle,
    channelIdentifier: parseOptionalBoundedString(nowPlaying.ChannelNumber, 100),
    channelThumb: channelId ? buildItemImagePath(channelId, 'live')?.slice(0, 500) : undefined,
  };
}

/**
 * Extract music track metadata from Jellyfin/Emby NowPlayingItem
 * Both platforms use the same field names for music metadata.
 * DB limits: artistName=255, albumName=255
 *
 * Note: All fields are optional. When a field is not available, it's undefined
 * (stored as NULL in DB) rather than empty string for query consistency.
 */
export function extractMusicMetadata(nowPlaying: Record<string, unknown>): {
  artistName?: string;
  albumName?: string;
  trackNumber?: number;
  discNumber?: number;
} {
  const artists = nowPlaying.Artists as string[] | undefined;
  const artistFromList = artists?.[0]?.slice(0, 255);

  return {
    artistName:
      parseOptionalBoundedString(nowPlaying.AlbumArtist, 255) || artistFromList || undefined,
    albumName: parseOptionalBoundedString(nowPlaying.Album, 255),
    trackNumber: parseOptionalNumber(nowPlaying.IndexNumber),
    discNumber: parseOptionalNumber(nowPlaying.ParentIndexNumber),
  };
}

/**
 * Check if an item should be filtered (trailers, prerolls, theme songs)
 */
export function shouldFilterItem(nowPlaying: Record<string, unknown>): boolean {
  const itemType = parseString(nowPlaying.Type).toLowerCase();
  const extraType = parseOptionalString(nowPlaying.ExtraType)?.toLowerCase();
  const providerIds = getNestedObject(nowPlaying, 'ProviderIds');

  // Filter trailers
  if (FILTERED_ITEM_TYPES.has(itemType)) {
    return true;
  }

  // Filter theme songs and theme videos
  if (extraType && FILTERED_EXTRA_TYPES.has(extraType)) {
    return true;
  }

  // Filter preroll videos (identified by prerolls.video provider)
  if (providerIds && 'prerolls.video' in providerIds) {
    return true;
  }

  return false;
}
