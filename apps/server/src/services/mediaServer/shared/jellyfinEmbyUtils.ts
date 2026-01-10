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
import type {
  SourceVideoDetails,
  SourceAudioDetails,
  StreamVideoDetails,
  StreamAudioDetails,
  TranscodeInfo,
  SubtitleInfo,
} from '@tracearr/shared';

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

/** Stream type constants matching Jellyfin/Emby API */
const STREAM_TYPE = {
  VIDEO: 'Video',
  AUDIO: 'Audio',
  SUBTITLE: 'Subtitle',
} as const;

/**
 * Map Jellyfin/Emby VideoRangeType enum to our dynamic range format.
 * See: https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Model/Entities/MediaStream.cs
 */
const VIDEO_RANGE_TYPE_MAP: Record<string, string> = {
  SDR: 'SDR',
  HDR: 'HDR',
  HDR10: 'HDR10',
  HDR10Plus: 'HDR10+',
  HLG: 'HLG',
  DOVi: 'Dolby Vision',
  DOVI: 'Dolby Vision',
  DOVIWithHDR10: 'Dolby Vision',
  DOVIWithHLG: 'Dolby Vision',
  DOVIWithHDR10Plus: 'Dolby Vision',
};

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

  // Jellyfin: NowPlayingItem.MediaSources[0].Bitrate
  const mediaSources = nowPlaying?.MediaSources;
  if (Array.isArray(mediaSources) && mediaSources.length > 0) {
    const firstSource = mediaSources[0] as Record<string, unknown>;
    const bitrate = parseNumber(firstSource?.Bitrate);
    if (bitrate > 0) return Math.round(bitrate / 1000);
  }

  // Emby: NowPlayingItem.Bitrate (directly on item)
  const itemBitrate = parseNumber(nowPlaying?.Bitrate);
  if (itemBitrate > 0) return Math.round(itemBitrate / 1000);

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

  // Get MediaStreams - Jellyfin style or Emby style
  const mediaSources = nowPlaying?.MediaSources;
  let mediaStreams: unknown[] | undefined;
  if (Array.isArray(mediaSources) && mediaSources.length > 0) {
    const firstSource = mediaSources[0] as Record<string, unknown>;
    mediaStreams = firstSource?.MediaStreams as unknown[] | undefined;
  }
  // Emby: NowPlayingItem.MediaStreams (directly on item)
  if (!mediaStreams && Array.isArray(nowPlaying?.MediaStreams)) {
    mediaStreams = nowPlaying.MediaStreams as unknown[];
  }

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

// ============================================================================
// Stream Detail Extraction (shared between Jellyfin and Emby)
// ============================================================================

/**
 * Find a stream by type from MediaStreams array.
 * Prefers the default stream if multiple of same type exist.
 */
function findStreamByType(
  mediaStreams: Array<Record<string, unknown>> | undefined,
  type: string
): Record<string, unknown> | undefined {
  if (!Array.isArray(mediaStreams)) return undefined;

  let defaultMatch: Record<string, unknown> | undefined;
  let firstMatch: Record<string, unknown> | undefined;

  for (const stream of mediaStreams) {
    const streamType = parseOptionalString(stream.Type);

    if (streamType?.toLowerCase() === type.toLowerCase()) {
      if (!firstMatch) firstMatch = stream;
      if (stream.IsDefault === true) {
        defaultMatch = stream;
        break;
      }
    }
  }

  return defaultMatch ?? firstMatch;
}

/**
 * Map VideoRangeType to dynamic range string.
 * Falls back to color attribute detection if VideoRangeType not available.
 */
function mapDynamicRange(stream: Record<string, unknown>): string {
  // Try direct VideoRangeType first (most accurate)
  const videoRangeType = parseOptionalString(stream.VideoRangeType);
  if (videoRangeType && VIDEO_RANGE_TYPE_MAP[videoRangeType]) {
    return VIDEO_RANGE_TYPE_MAP[videoRangeType];
  }

  // Fallback: check VideoRange (less specific)
  const videoRange = parseOptionalString(stream.VideoRange);
  if (videoRange?.toLowerCase() === 'hdr') {
    // Try to determine specific HDR type from color attributes
    const colorTransfer = parseOptionalString(stream.ColorTransfer);
    if (colorTransfer === 'smpte2084') return 'HDR10';
    if (colorTransfer === 'arib-std-b67') return 'HLG';
    return 'HDR';
  }

  // Check color attributes as final fallback
  const colorSpace = parseOptionalString(stream.ColorSpace);
  const bitDepth = parseOptionalNumber(stream.BitDepth);
  const colorTransfer = parseOptionalString(stream.ColorTransfer);

  if (colorSpace?.includes('bt2020') || (bitDepth && bitDepth >= 10)) {
    if (colorTransfer === 'smpte2084') return 'HDR10';
    if (colorTransfer === 'arib-std-b67') return 'HLG';
    if (colorSpace?.includes('bt2020')) return 'HDR';
  }

  return 'SDR';
}

/**
 * Extract source video details from a video stream
 */
function extractSourceVideoDetails(stream: Record<string, unknown> | undefined): {
  codec?: string;
  width?: number;
  height?: number;
  details: SourceVideoDetails;
} {
  if (!stream) {
    return { details: {} };
  }

  const codec = parseOptionalString(stream.Codec)?.toUpperCase();
  const width = parseOptionalNumber(stream.Width);
  const height = parseOptionalNumber(stream.Height);

  const details: SourceVideoDetails = {};

  // Bitrate (Jellyfin stores in bps, convert to kbps)
  const bitrate = parseOptionalNumber(stream.BitRate);
  if (bitrate) details.bitrate = Math.round(bitrate / 1000);

  // Framerate - prefer RealFrameRate
  const frameRate =
    parseOptionalNumber(stream.RealFrameRate) ?? parseOptionalNumber(stream.AverageFrameRate);
  if (frameRate) details.framerate = frameRate.toString();

  // Dynamic range
  const dynamicRange = mapDynamicRange(stream);
  details.dynamicRange = dynamicRange;

  // Profile and level
  const profile = parseOptionalString(stream.Profile);
  if (profile) details.profile = profile;

  const level = parseOptionalNumber(stream.Level);
  if (level) details.level = level.toString();

  // Color information
  const colorSpace = parseOptionalString(stream.ColorSpace);
  if (colorSpace) details.colorSpace = colorSpace;

  const colorDepth = parseOptionalNumber(stream.BitDepth);
  if (colorDepth) details.colorDepth = colorDepth;

  return { codec, width, height, details };
}

/**
 * Extract source audio details from an audio stream
 */
function extractSourceAudioDetails(stream: Record<string, unknown> | undefined): {
  codec?: string;
  channels?: number;
  details: SourceAudioDetails;
} {
  if (!stream) {
    return { details: {} };
  }

  const codec = parseOptionalString(stream.Codec)?.toUpperCase();
  const channels = parseOptionalNumber(stream.Channels);

  const details: SourceAudioDetails = {};

  // Bitrate (Jellyfin stores in bps, convert to kbps)
  const bitrate = parseOptionalNumber(stream.BitRate);
  if (bitrate) details.bitrate = Math.round(bitrate / 1000);

  // Channel layout
  const channelLayout = parseOptionalString(stream.ChannelLayout);
  if (channelLayout) details.channelLayout = channelLayout;

  // Language
  const language = parseOptionalString(stream.Language);
  if (language) details.language = language;

  // Sample rate
  const sampleRate = parseOptionalNumber(stream.SampleRate);
  if (sampleRate) details.sampleRate = sampleRate;

  return { codec, channels, details };
}

/**
 * Extract subtitle info from a subtitle stream
 */
function extractSubtitleInfo(
  stream: Record<string, unknown> | undefined
): SubtitleInfo | undefined {
  if (!stream) return undefined;

  const info: SubtitleInfo = {};

  const codec = parseOptionalString(stream.Codec);
  if (codec) info.codec = codec.toUpperCase();

  const language = parseOptionalString(stream.Language);
  if (language) info.language = language;

  const forced = stream.IsForced === true;
  if (forced) info.forced = true;

  // Note: Jellyfin doesn't expose subtitle decision (burn-in vs copy)
  // like Plex does, so we leave info.decision undefined

  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Extract transcode info from TranscodingInfo object
 * Note: Jellyfin/Emby don't expose hardware acceleration details
 */
function extractTranscodeInfo(
  transcodingInfo: Record<string, unknown> | undefined,
  mediaSource: Record<string, unknown> | undefined
): TranscodeInfo | undefined {
  const info: TranscodeInfo = {};

  // Source container
  const sourceContainer = parseOptionalString(mediaSource?.Container);
  if (sourceContainer) info.sourceContainer = sourceContainer.toUpperCase();

  if (transcodingInfo) {
    // Stream container (output)
    const streamContainer = parseOptionalString(transcodingInfo.Container);
    if (streamContainer) info.streamContainer = streamContainer.toUpperCase();

    // Container decision
    if (sourceContainer && streamContainer) {
      info.containerDecision =
        sourceContainer.toLowerCase() === streamContainer.toLowerCase() ? 'direct' : 'transcode';
    }

    // Note: Jellyfin/Emby don't expose these fields:
    // - hwRequested, hwDecoding, hwEncoding
    // - speed, throttled
  }

  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Extract stream video details (output after transcode)
 */
function extractStreamVideoDetails(
  transcodingInfo: Record<string, unknown> | undefined,
  sourceVideoDetails: SourceVideoDetails
): { codec?: string; details: StreamVideoDetails } {
  if (!transcodingInfo) {
    // Direct play - stream details match source
    return { details: {} };
  }

  const details: StreamVideoDetails = {};

  // Transcode output dimensions
  const width = parseOptionalNumber(transcodingInfo.Width);
  if (width) details.width = width;

  const height = parseOptionalNumber(transcodingInfo.Height);
  if (height) details.height = height;

  // Framerate preserved through transcode
  if (sourceVideoDetails.framerate) {
    details.framerate = sourceVideoDetails.framerate;
  }

  // Dynamic range may be tone-mapped (HDR → SDR)
  // Jellyfin doesn't expose this, so assume preserved
  if (sourceVideoDetails.dynamicRange) {
    details.dynamicRange = sourceVideoDetails.dynamicRange;
  }

  const codec = parseOptionalString(transcodingInfo.VideoCodec)?.toUpperCase();

  return { codec, details };
}

/**
 * Extract stream audio details (output after transcode)
 */
function extractStreamAudioDetails(transcodingInfo: Record<string, unknown> | undefined): {
  codec?: string;
  details: StreamAudioDetails;
} {
  if (!transcodingInfo) {
    return { details: {} };
  }

  const details: StreamAudioDetails = {};

  const channels = parseOptionalNumber(transcodingInfo.AudioChannels);
  if (channels) details.channels = channels;

  const codec = parseOptionalString(transcodingInfo.AudioCodec)?.toUpperCase();

  return { codec, details };
}

/** Result type for stream details extraction */
export interface StreamDetailsResult {
  sourceVideoCodec?: string;
  sourceAudioCodec?: string;
  sourceAudioChannels?: number;
  sourceVideoDetails?: SourceVideoDetails;
  sourceAudioDetails?: SourceAudioDetails;
  streamVideoCodec?: string;
  streamAudioCodec?: string;
  streamVideoDetails?: StreamVideoDetails;
  streamAudioDetails?: StreamAudioDetails;
  transcodeInfo?: TranscodeInfo;
  subtitleInfo?: SubtitleInfo;
}

/**
 * Extract all stream details from a Jellyfin/Emby session.
 * Shared by both platform parsers.
 */
export function extractStreamDetails(session: Record<string, unknown>): StreamDetailsResult {
  const nowPlaying = getNestedObject(session, 'NowPlayingItem');
  const transcodingInfo = getNestedObject(session, 'TranscodingInfo');

  // Get MediaSources and MediaStreams
  // Jellyfin: NowPlayingItem.MediaSources[0].MediaStreams
  // Emby: NowPlayingItem.MediaStreams (directly on item)
  const mediaSources = nowPlaying?.MediaSources as Array<Record<string, unknown>> | undefined;
  const mediaSource = mediaSources?.[0];
  const mediaStreams =
    (mediaSource?.MediaStreams as Array<Record<string, unknown>> | undefined) ??
    (nowPlaying?.MediaStreams as Array<Record<string, unknown>> | undefined);

  // Find streams by type
  const videoStream = findStreamByType(mediaStreams, STREAM_TYPE.VIDEO);
  const audioStream = findStreamByType(mediaStreams, STREAM_TYPE.AUDIO);
  const subtitleStream = findStreamByType(mediaStreams, STREAM_TYPE.SUBTITLE);

  // Extract source details
  const sourceVideo = extractSourceVideoDetails(videoStream);
  const sourceAudio = extractSourceAudioDetails(audioStream);

  // Extract stream (output) details
  const streamVideo = extractStreamVideoDetails(transcodingInfo, sourceVideo.details);
  const streamAudio = extractStreamAudioDetails(transcodingInfo);

  // Extract transcode and subtitle info
  const transcodeInfo = extractTranscodeInfo(transcodingInfo, mediaSource);
  const subtitleInfo = extractSubtitleInfo(subtitleStream);

  return {
    // Scalar fields for indexing
    sourceVideoCodec: sourceVideo.codec,
    sourceAudioCodec: sourceAudio.codec,
    sourceAudioChannels: sourceAudio.channels,
    streamVideoCodec: streamVideo.codec ?? sourceVideo.codec,
    streamAudioCodec: streamAudio.codec ?? sourceAudio.codec,

    // JSONB details (only include if non-empty)
    sourceVideoDetails:
      Object.keys(sourceVideo.details).length > 0 ? sourceVideo.details : undefined,
    sourceAudioDetails:
      Object.keys(sourceAudio.details).length > 0 ? sourceAudio.details : undefined,
    streamVideoDetails:
      Object.keys(streamVideo.details).length > 0 ? streamVideo.details : undefined,
    streamAudioDetails:
      Object.keys(streamAudio.details).length > 0 ? streamAudio.details : undefined,
    transcodeInfo,
    subtitleInfo,
  };
}
