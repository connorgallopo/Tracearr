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
  parseArray,
  getNestedObject,
  getNestedValue,
} from '../../../utils/parsing.js';
import {
  normalizePlayMethod,
  isTranscodingFromInfo,
  type StreamDecisions,
} from '../../../utils/transcodeNormalizer.js';
import { isAtmos } from '../../../utils/codecNormalizer.js';
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
  DOVIWithSDR: 'Dolby Vision',
  DOVIWithEL: 'Dolby Vision',
  DOVIWithELHDR10Plus: 'Dolby Vision',
  // Jellyfin's own enum doc: invalid DV configs (e.g. Profile 8 compat id 6) have their
  // DV metadata stripped server-side and are then treated as HDR10, so we match that.
  DOVIInvalid: 'HDR10',
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
 * Resolve the MediaSource for the version actually playing.
 * PlayState.MediaSourceId names the played version and is the only reliable
 * identity when an item has several versions (NowPlayingItem.Path shows the
 * primary version's file regardless of what plays). Modern servers (JF 12,
 * Emby 4.9) omit MediaSources from /Sessions entirely, so callers must fall
 * back to NowPlayingItem.MediaStreams, which describe the playing version.
 */
export function findPlayingMediaSource(
  session: Record<string, unknown>
): Record<string, unknown> | undefined {
  const nowPlaying = getNestedObject(session, 'NowPlayingItem');
  const mediaSources = nowPlaying?.MediaSources;
  if (!Array.isArray(mediaSources) || mediaSources.length === 0) return undefined;

  const playState = getNestedObject(session, 'PlayState');
  const sourceId = parseOptionalString(playState?.MediaSourceId);
  if (sourceId) {
    const match = (mediaSources as unknown[]).find(
      (source) => parseOptionalString((source as Record<string, unknown>)?.Id) === sourceId
    ) as Record<string, unknown> | undefined;
    if (match) return match;
  }
  return mediaSources[0] as Record<string, unknown>;
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

  // Jellyfin/Emby: playing MediaSource's Bitrate (when /Sessions includes MediaSources)
  const mediaSource = findPlayingMediaSource(session);
  if (mediaSource) {
    const bitrate = parseNumber(mediaSource.Bitrate);
    if (bitrate > 0) return Math.round(bitrate / 1000);
  }

  // Jellyfin/Emby: NowPlayingItem.MediaStreams[].BitRate (from video stream)
  // This is the reliable source for both platforms in the /Sessions API
  const mediaStreams = nowPlaying?.MediaStreams;
  if (Array.isArray(mediaStreams)) {
    for (const stream of mediaStreams) {
      const streamObj = stream as Record<string, unknown>;
      if (parseOptionalString(streamObj.Type)?.toLowerCase() === 'video') {
        const bitrate = parseNumber(streamObj.BitRate);
        if (bitrate > 0) return Math.round(bitrate / 1000);
      }
    }
  }

  // Emby: NowPlayingItem.Bitrate (directly on item)
  const itemBitrate = parseNumber(nowPlaying?.Bitrate);
  if (itemBitrate > 0) return Math.round(itemBitrate / 1000);

  // Final fallback: Calculate from file size and duration
  // This helps for Direct Play sessions where bitrate isn't explicitly provided
  const fileSize = mediaSource ? parseNumber(mediaSource.Size) : 0;
  const runTimeTicks = parseNumber(nowPlaying?.RunTimeTicks);
  if (fileSize > 0 && runTimeTicks > 0) {
    // fileSize in bytes, runTimeTicks in ticks (10,000,000 ticks = 1 second)
    // bitrate (kbps) = (fileSize * 8 * 10,000) / runTimeTicks
    return Math.round((fileSize * 8 * 10000) / runTimeTicks);
  }

  return 0;
}

/**
 * Get source video dimensions from session.
 * Returns dimensions from MediaStreams (the original file), NOT TranscodingInfo.
 * Transcoded output dimensions are stored separately in streamVideoDetails.
 */
export function getVideoDimensions(session: Record<string, unknown>): {
  videoWidth?: number;
  videoHeight?: number;
} {
  // Get source media dimensions from MediaStreams (original file)
  const nowPlaying = getNestedObject(session, 'NowPlayingItem');

  // Get MediaStreams from the playing MediaSource, or directly on the item
  // (modern servers omit MediaSources from /Sessions)
  const mediaSource = findPlayingMediaSource(session);
  let mediaStreams = mediaSource?.MediaStreams as unknown[] | undefined;
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
 * Stream decision logic for Jellyfin.
 *
 * Jellyfin copies PlayMethod verbatim from the client's report, and clients label a
 * static raw-file play DirectStream. TranscodingInfo exists only while the server runs
 * ffmpeg, so it decides when present: copied streams are a remux, anything else a
 * transcode. Without it, only a Transcode report means the server is encoding.
 *
 * An audio-only job has a null VideoCodec and IsVideoDirect false, since there is no
 * video to copy; its video decision is directplay, as Plex reports music.
 */
export function getStreamDecisionsJellyfin(session: Record<string, unknown>): StreamDecisions {
  const { playMethod, transcodingInfo, isVideoDirect, isAudioDirect } = extractStreamFlags(session);

  if (transcodingInfo) {
    const decisions = normalizePlayMethod('transcode', isVideoDirect, isAudioDirect);
    if (parseOptionalString(transcodingInfo.VideoCodec)) return decisions;
    return {
      videoDecision: 'directplay',
      audioDecision: decisions.audioDecision,
      isTranscode: decisions.audioDecision === 'transcode',
    };
  }

  return playMethod?.toLowerCase() === 'transcode'
    ? normalizePlayMethod(playMethod)
    : DIRECT_PLAY_RESULT;
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
 *
 * Album artwork: Music tracks often don't have their own Primary image - the artwork
 * is on the album. We extract AlbumId + AlbumPrimaryImageTag as a fallback.
 */
export function extractMusicMetadata(nowPlaying: Record<string, unknown>): {
  artistName?: string;
  albumName?: string;
  trackNumber?: number;
  discNumber?: number;
  albumThumbPath?: string;
} {
  const artists = nowPlaying.Artists as string[] | undefined;
  const artistFromList = artists?.[0]?.slice(0, 255);
  const albumArtist = parseOptionalBoundedString(nowPlaying.AlbumArtist, 255);

  // For compilations ("Various Artists"), prefer track artist; otherwise prefer album artist
  const isCompilation = albumArtist?.toLowerCase() === 'various artists';
  const artistName = isCompilation ? artistFromList || albumArtist : albumArtist || artistFromList;

  // Extract album artwork path as fallback for tracks without their own image
  const albumId = parseOptionalString(nowPlaying.AlbumId);
  const albumImageTag = parseOptionalString(nowPlaying.AlbumPrimaryImageTag);
  const albumThumbPath = buildItemImagePath(albumId ?? '', albumImageTag);

  return {
    artistName: artistName || undefined,
    albumName: parseOptionalBoundedString(nowPlaying.Album, 255),
    trackNumber: parseOptionalNumber(nowPlaying.IndexNumber),
    discNumber: parseOptionalNumber(nowPlaying.ParentIndexNumber),
    albumThumbPath,
  };
}

/**
 * Check if an item is an extra (trailer, behind-the-scenes, clip, theme song/video, etc.)
 * rather than primary playable content. Shared by session parsing (filters what shows up
 * as "now playing") and library item parsing (filters what gets ingested into library_items).
 *
 * Jellyfin/Emby mark extras with a non-empty ExtraType field (Trailer, BehindTheScenes,
 * Clip, ThemeVideo, ThemeSong, Interview, Scene, Sample, etc.) even when the item's own
 * Type matches its parent's (e.g. a local trailer file scanned as Type: Movie). Any
 * non-empty ExtraType means the item is an extra, not primary content.
 */
export function shouldFilterItem(nowPlaying: Record<string, unknown>): boolean {
  const itemType = parseString(nowPlaying.Type).toLowerCase();
  const providerIds = getNestedObject(nowPlaying, 'ProviderIds');

  // Filter trailers (item itself typed as Trailer, e.g. from an active playback session)
  if (FILTERED_ITEM_TYPES.has(itemType)) {
    return true;
  }

  // ExtraType must be a real string here, not just non-nullish: parseOptionalString
  // coerces any non-nullish value via String(), so a non-string ExtraType (e.g. a
  // numeric enum 0) would come back as the truthy string '0' and filter every item.
  const extraType = typeof nowPlaying.ExtraType === 'string' ? nowPlaying.ExtraType.trim() : '';

  // Filter any extra (trailer, behind-the-scenes, clip, theme song/video, etc.)
  if (extraType) {
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
 * Priority: activeIndex match > IsDefault match > first match.
 */
function findStreamByType(
  mediaStreams: Array<Record<string, unknown>> | undefined,
  type: string,
  activeIndex?: number
): Record<string, unknown> | undefined {
  if (!Array.isArray(mediaStreams)) return undefined;

  let activeMatch: Record<string, unknown> | undefined;
  let defaultMatch: Record<string, unknown> | undefined;
  let firstMatch: Record<string, unknown> | undefined;

  for (const stream of mediaStreams) {
    const streamType = parseOptionalString(stream.Type);

    if (streamType?.toLowerCase() === type.toLowerCase()) {
      if (!firstMatch) firstMatch = stream;

      if (activeIndex !== undefined) {
        if (parseOptionalNumber(stream.Index) === activeIndex) {
          activeMatch = stream;
          break;
        }
      } else if (stream.IsDefault === true) {
        defaultMatch = stream;
        break;
      }
    }
  }

  return activeMatch ?? defaultMatch ?? firstMatch;
}

/**
 * Map VideoRangeType to dynamic range string.
 * Falls back to color attribute detection if VideoRangeType not available.
 * @internal Exported for reuse by library sync's extractQuality and for unit testing
 */
export function mapDynamicRange(stream: Record<string, unknown>): string {
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

  const frameRate = getStreamFrameRate(stream);
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

  const profile = parseOptionalString(stream.Profile);
  if (profile) details.profile = profile;
  if (isAtmos(profile, parseOptionalString(stream.Title))) details.atmos = true;

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

/** Preferred frame rate for a media stream */
function getStreamFrameRate(stream: Record<string, unknown>): number | undefined {
  return parseOptionalNumber(stream.RealFrameRate) ?? parseOptionalNumber(stream.AverageFrameRate);
}

/**
 * Extract transcode info from TranscodingInfo object
 */
function extractTranscodeInfo(
  transcodingInfo: Record<string, unknown> | undefined,
  mediaSource: Record<string, unknown> | undefined,
  sourceFrameRate?: number
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

    // Parse Jellyfin/Emby transcode reasons (if provided)
    const reasons = parseArray(transcodingInfo.TranscodeReasons, (reason) =>
      parseString(reason).trim()
    ).filter((reason) => reason.length > 0);
    if (reasons.length > 0) {
      info.reasons = Array.from(new Set(reasons));
    }

    const progress = parseOptionalNumber(transcodingInfo.CompletionPercentage);
    if (progress !== undefined) info.progress = progress;

    // Framerate is the transcoder's output fps; against the source fps that
    // is the x-realtime speed Plex reports natively
    const transcodeFps = parseOptionalNumber(transcodingInfo.Framerate);
    if (transcodeFps && sourceFrameRate && sourceFrameRate > 0) {
      info.speed = Math.round((transcodeFps / sourceFrameRate) * 10) / 10;
    }

    // Emby: CurrentThrottle is the applied throttle rate; nonzero means active
    const currentThrottle = parseOptionalNumber(transcodingInfo.CurrentThrottle);
    if (currentThrottle !== undefined && currentThrottle > 0) info.throttled = true;

    // Emby: absolute position the transcoder has reached in the file
    const positionTicks = parseOptionalNumber(transcodingInfo.TranscodingPositionTicks);
    if (positionTicks !== undefined && positionTicks > 0) {
      info.maxOffsetAvailable = Math.round(ticksToMs(positionTicks) / 1000);
    }

    // Jellyfin: one pipeline-wide acceleration enum ('none' when software)
    const jfAccel = parseOptionalString(transcodingInfo.HardwareAccelerationType);
    if (jfAccel && jfAccel !== 'none') {
      info.hwRequested = true;
      info.hwEncoding = jfAccel;
    }

    // Emby: per-direction acceleration detail
    const decoderHw =
      transcodingInfo.VideoDecoderIsHardware === true
        ? parseOptionalString(transcodingInfo.VideoDecoderHwAccel)
        : undefined;
    if (decoderHw) {
      info.hwRequested = true;
      info.hwDecoding = decoderHw;
    }

    const encoderHw =
      transcodingInfo.VideoEncoderIsHardware === true
        ? parseOptionalString(transcodingInfo.VideoEncoderHwAccel)
        : undefined;
    if (encoderHw) {
      info.hwRequested = true;
      info.hwEncoding = encoderHw;
    }
  }

  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Extract stream video details (output after transcode)
 */
function extractStreamVideoDetails(
  transcodingInfo: Record<string, unknown> | undefined,
  sourceVideoDetails: SourceVideoDetails,
  videoDecision?: string
): { codec?: string; details: StreamVideoDetails } {
  if (!transcodingInfo) {
    return { details: {} };
  }

  const details: StreamVideoDetails = {};

  const width = parseOptionalNumber(transcodingInfo.Width);
  if (width) details.width = width;

  const height = parseOptionalNumber(transcodingInfo.Height);
  if (height) details.height = height;

  if (sourceVideoDetails.framerate) {
    details.framerate = sourceVideoDetails.framerate;
  }

  // Video transcoding tone-maps HDR/DV to SDR; copy/passthrough preserves it
  if (videoDecision === 'transcode') {
    details.dynamicRange = 'SDR';
  } else if (sourceVideoDetails.dynamicRange) {
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

  // Streams come from the playing MediaSource when /Sessions includes the
  // array, else directly off NowPlayingItem (JF 12 / Emby 4.9 shape)
  const mediaSource = findPlayingMediaSource(session);
  const mediaStreams =
    (mediaSource?.MediaStreams as Array<Record<string, unknown>> | undefined) ??
    (nowPlaying?.MediaStreams as Array<Record<string, unknown>> | undefined);

  const playState = getNestedObject(session, 'PlayState');
  const audioStreamIndex = playState ? parseOptionalNumber(playState.AudioStreamIndex) : undefined;
  const subtitleStreamIndex = playState
    ? parseOptionalNumber(playState.SubtitleStreamIndex)
    : undefined;

  const videoStream = findStreamByType(mediaStreams, STREAM_TYPE.VIDEO);
  const audioStream = findStreamByType(mediaStreams, STREAM_TYPE.AUDIO, audioStreamIndex);
  const subtitleStream = findStreamByType(mediaStreams, STREAM_TYPE.SUBTITLE, subtitleStreamIndex);

  const sourceVideo = extractSourceVideoDetails(videoStream);
  const sourceAudio = extractSourceAudioDetails(audioStream);

  const isVideoDirect = transcodingInfo?.IsVideoDirect;
  const videoDecision = transcodingInfo
    ? isVideoDirect === true
      ? 'copy'
      : 'transcode'
    : undefined;

  const streamVideo = extractStreamVideoDetails(
    transcodingInfo,
    sourceVideo.details,
    videoDecision
  );
  const streamAudio = extractStreamAudioDetails(transcodingInfo);

  const transcodeInfo = extractTranscodeInfo(
    transcodingInfo,
    mediaSource,
    videoStream ? getStreamFrameRate(videoStream) : undefined
  );
  const subtitleInfo = extractSubtitleInfo(subtitleStream);

  return {
    sourceVideoCodec: sourceVideo.codec,
    sourceAudioCodec: sourceAudio.codec,
    sourceAudioChannels: sourceAudio.channels,
    streamVideoCodec: streamVideo.codec ?? sourceVideo.codec,
    streamAudioCodec: streamAudio.codec ?? sourceAudio.codec,

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
