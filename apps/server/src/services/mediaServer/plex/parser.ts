/**
 * Plex API Response Parser
 *
 * Pure functions for parsing raw Plex API responses into typed objects.
 * Separated from the client for testability and reuse.
 */

import {
  parseString,
  parseNumber,
  parseBoolean,
  parseOptionalString,
  parseOptionalNumber,
  parseArray,
  parseSelectedArrayElement,
  findSelectedElement,
} from '../../../utils/parsing.js';
import { normalizeStreamDecisions } from '../../../utils/transcodeNormalizer.js';
import type {
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaLibraryItem,
  MediaItemVersion,
  MediaWatchHistoryItem,
} from '../types.js';
import {
  computeVersionsFingerprint,
  pickBestVersion,
  sumVersionSizes,
} from '../shared/versionUtils.js';
import type {
  SourceVideoDetails,
  SourceAudioDetails,
  StreamVideoDetails,
  StreamAudioDetails,
  TranscodeInfo,
  SubtitleInfo,
  BandwidthAccount,
  BandwidthDevice,
  BandwidthSample,
} from '@tracearr/shared';
import { normalizeResolutionLabel, normalizeDynamicRange } from '@tracearr/shared';
import { calculateProgress } from '../shared/parserUtils.js';
import { extractPlexLiveTvMetadata, extractPlexMusicMetadata } from './plexUtils.js';

// ============================================================================
// Raw Plex API Response Types (for internal use)
// ============================================================================

/**
 * Original media metadata from /library/metadata/{ratingKey}
 * Used to get true source info when session data shows transcoded output
 */
export interface PlexOriginalMedia {
  /** Video bitrate in kbps */
  videoBitrate?: number;
  /** Audio bitrate in kbps */
  audioBitrate?: number;
  /** Video width in pixels */
  videoWidth?: number;
  /** Video height in pixels */
  videoHeight?: number;
  /** Overall media bitrate in kbps */
  bitrate?: number;
  /** Video codec (e.g., 'hevc', 'h264') */
  videoCodec?: string;
  /** Audio codec (e.g., 'eac3', 'truehd') */
  audioCodec?: string;
  /** Audio channel count */
  audioChannels?: number;
  /** Container format (e.g., 'mkv', 'mp4') */
  container?: string;
  /** Additional source video details */
  sourceVideoDetails?: SourceVideoDetails;
  /** Additional source audio details */
  sourceAudioDetails?: SourceAudioDetails;
}

/** Raw session metadata from Plex API */
export interface PlexRawSession {
  sessionKey?: unknown;
  ratingKey?: unknown;
  title?: unknown;
  type?: unknown;
  duration?: unknown;
  viewOffset?: unknown;
  grandparentTitle?: unknown;
  parentTitle?: unknown;
  grandparentRatingKey?: unknown;
  parentIndex?: unknown;
  index?: unknown;
  year?: unknown;
  thumb?: unknown;
  grandparentThumb?: unknown;
  art?: unknown;
  User?: Record<string, unknown>;
  Player?: Record<string, unknown>;
  Media?: Array<Record<string, unknown>>;
  TranscodeSession?: Record<string, unknown>;
  // Live TV fields
  live?: unknown; // '1' if Live TV
  sourceTitle?: unknown; // Channel name for Live TV
}

// ============================================================================
// Stream Detail Extraction
// ============================================================================

/** Stream type constants from Plex API
 * @internal Exported for unit testing
 */
export const STREAM_TYPE = {
  VIDEO: 1,
  AUDIO: 2,
  SUBTITLE: 3,
} as const;

/**
 * Find streams by type from Part[].Stream[] array
 * Returns the selected stream if available, otherwise the first stream of that type
 * @internal Exported for unit testing
 */
export function findStreamByType(
  part: Record<string, unknown> | undefined,
  streamType: number
): Record<string, unknown> | undefined {
  if (!part) return undefined;
  const streams = part.Stream as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(streams)) return undefined;

  // Single-pass extraction: track first match and selected stream
  let firstMatch: Record<string, unknown> | undefined;
  let selectedMatch: Record<string, unknown> | undefined;

  for (const stream of streams) {
    if (parseNumber(stream.streamType) !== streamType) continue;

    // Track first matching stream as fallback
    if (!firstMatch) firstMatch = stream;

    // Prefer selected stream - return immediately if found
    // (the JSON API sends boolean true; XML-derived payloads send 1 or '1')
    const sel = stream.selected;
    if (sel === 1 || sel === '1' || sel === true) {
      selectedMatch = stream;
      break; // Selected stream found, no need to continue
    }
  }

  return selectedMatch ?? firstMatch;
}

/**
 * Derive dynamic range from video stream color attributes
 * Following Tautulli's approach for HDR detection
 * @internal Exported for unit testing
 */
export function deriveDynamicRange(stream: Record<string, unknown>): string {
  if (parseString(stream.DOVIPresent) === '1') {
    const profile = parseOptionalString(stream.DOVIProfile);
    if (profile) {
      return `Dolby Vision ${profile}`;
    }
    return 'Dolby Vision';
  }

  if (parseString(stream.DOVIBLPresent) === '1' || parseString(stream.DOVIRPUPresent) === '1') {
    return 'Dolby Vision';
  }

  // Check extendedDisplayTitle for DV before color attributes — DV P7 has HDR10 base layer
  // attributes (bt2020nc + smpte2084) that would otherwise match HDR10.
  const extendedDisplayTitle = parseOptionalString(stream.extendedDisplayTitle) ?? '';
  if (extendedDisplayTitle.includes('Dolby Vision') || extendedDisplayTitle.includes('DoVi')) {
    return 'Dolby Vision';
  }

  const colorSpace = parseOptionalString(stream.colorSpace);
  const bitDepth = parseOptionalNumber(stream.bitDepth);
  const colorTrc = parseOptionalString(stream.colorTrc);

  if (colorSpace === 'bt2020' || colorSpace === 'bt2020nc' || (bitDepth && bitDepth >= 10)) {
    if (colorTrc === 'smpte2084') return 'HDR10';
    if (colorTrc === 'arib-std-b67') return 'HLG';
    if (colorSpace === 'bt2020' || colorSpace === 'bt2020nc') return 'HDR';
  }

  if (extendedDisplayTitle.includes('HLG')) {
    return 'HLG';
  }
  if (extendedDisplayTitle.includes('HDR10')) {
    return 'HDR10';
  }
  if (extendedDisplayTitle.includes('HDR')) {
    return 'HDR';
  }

  return 'SDR';
}

/**
 * Extract source video details from stream
 */
function extractSourceVideoDetails(
  stream: Record<string, unknown> | undefined,
  media: Record<string, unknown> | undefined
): {
  codec?: string;
  width?: number;
  height?: number;
  details: SourceVideoDetails;
} {
  if (!stream) {
    return { details: {} };
  }

  const codec = parseOptionalString(stream.codec)?.toUpperCase();
  const width = parseOptionalNumber(stream.width);
  const height = parseOptionalNumber(stream.height);

  const details: SourceVideoDetails = {};

  const bitrate = parseOptionalNumber(stream.bitrate);
  if (bitrate) details.bitrate = bitrate;

  // Framerate - prefer stream.frameRate, fallback to media.videoFrameRate
  const frameRate =
    parseOptionalString(stream.frameRate) ?? parseOptionalString(media?.videoFrameRate);
  if (frameRate) details.framerate = frameRate;

  // Dynamic range
  const dynamicRange = deriveDynamicRange(stream);
  if (dynamicRange !== 'SDR') details.dynamicRange = dynamicRange;
  else details.dynamicRange = 'SDR';

  // Aspect ratio from media level
  const aspectRatio = parseOptionalNumber(media?.aspectRatio);
  if (aspectRatio) details.aspectRatio = aspectRatio;

  // Profile and level
  const profile = parseOptionalString(stream.profile);
  if (profile) details.profile = profile;

  const level = parseOptionalString(stream.level);
  if (level) details.level = level;

  // Color information
  const colorSpace = parseOptionalString(stream.colorSpace);
  if (colorSpace) details.colorSpace = colorSpace;

  const colorDepth = parseOptionalNumber(stream.bitDepth);
  if (colorDepth) details.colorDepth = colorDepth;

  return { codec, width, height, details };
}

/**
 * Extract source audio details from stream
 */
function extractSourceAudioDetails(stream: Record<string, unknown> | undefined): {
  codec?: string;
  channels?: number;
  details: SourceAudioDetails;
} {
  if (!stream) {
    return { details: {} };
  }

  const codec = parseOptionalString(stream.codec)?.toUpperCase();
  const channels = parseOptionalNumber(stream.channels);

  const details: SourceAudioDetails = {};

  const bitrate = parseOptionalNumber(stream.bitrate);
  if (bitrate) details.bitrate = bitrate;

  const channelLayout = parseOptionalString(stream.audioChannelLayout);
  if (channelLayout) details.channelLayout = channelLayout;

  const language = parseOptionalString(stream.language);
  if (language) details.language = language;

  const sampleRate = parseOptionalNumber(stream.samplingRate);
  if (sampleRate) details.sampleRate = sampleRate;

  return { codec, channels, details };
}

/**
 * Extract subtitle info from stream
 */
function extractSubtitleInfo(
  stream: Record<string, unknown> | undefined
): SubtitleInfo | undefined {
  if (!stream) return undefined;

  const info: SubtitleInfo = {};

  const codec = parseOptionalString(stream.codec);
  if (codec) info.codec = codec.toUpperCase();

  const language = parseOptionalString(stream.language);
  if (language) info.language = language;

  const decision = parseOptionalString(stream.decision);
  if (decision) info.decision = decision;

  const forced = parseString(stream.forced) === '1';
  if (forced) info.forced = true;

  // Only return if we have any data
  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Extract transcode info from TranscodeSession
 */
function extractTranscodeInfo(
  transcodeSession: Record<string, unknown> | undefined,
  part: Record<string, unknown> | undefined
): TranscodeInfo | undefined {
  const info: TranscodeInfo = {};

  // Container info
  const sourceContainer = parseOptionalString(part?.container);
  if (sourceContainer) info.sourceContainer = sourceContainer.toUpperCase();

  if (transcodeSession) {
    const streamContainer = parseOptionalString(transcodeSession.container);
    if (streamContainer) info.streamContainer = streamContainer.toUpperCase();

    // Container decision - if containers differ, it's a transcode
    if (sourceContainer && streamContainer) {
      info.containerDecision =
        sourceContainer.toLowerCase() === streamContainer.toLowerCase() ? 'direct' : 'transcode';
    }

    // Hardware acceleration
    const hwRequested = parseString(transcodeSession.transcodeHwRequested) === '1';
    if (hwRequested) info.hwRequested = true;

    const hwDecoding = parseOptionalString(transcodeSession.transcodeHwDecoding);
    if (hwDecoding) info.hwDecoding = hwDecoding;

    const hwEncoding = parseOptionalString(transcodeSession.transcodeHwEncoding);
    if (hwEncoding) info.hwEncoding = hwEncoding;

    // Transcode performance
    const speed = parseOptionalNumber(transcodeSession.speed);
    if (speed) info.speed = speed;

    const throttled =
      transcodeSession.throttled === true || parseString(transcodeSession.throttled) === '1';
    if (throttled) info.throttled = true;

    const progress = parseOptionalNumber(transcodeSession.progress);
    if (progress !== undefined) info.progress = progress;

    const maxOffsetAvailable = parseOptionalNumber(transcodeSession.maxOffsetAvailable);
    if (maxOffsetAvailable !== undefined) info.maxOffsetAvailable = maxOffsetAvailable;
  }

  // Only return if we have any data
  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Extract stream video details (output after transcode)
 *
 * When video is being transcoded, Plex's TranscodeSession element may or may not have
 * width/height attributes depending on the transcode type:
 * - videoDecision="copy" (audio-only transcode): TranscodeSession HAS width/height (source dims)
 * - videoDecision="transcode" (video transcode): TranscodeSession has NO width/height
 *
 * For actual video transcodes, we fall back to Media/Stream element dimensions which
 * correctly show the transcoded output dimensions.
 */
function extractStreamVideoDetails(
  transcodeSession: Record<string, unknown> | undefined,
  sourceVideoDetails: SourceVideoDetails,
  fallbackDimensions?: { width?: number; height?: number }
): { codec?: string; details: StreamVideoDetails } {
  if (!transcodeSession) {
    // Direct play - stream details match source
    return { details: {} };
  }

  const details: StreamVideoDetails = {};

  // Transcode output dimensions - try TranscodeSession first, then fallback to Media/Stream
  // TranscodeSession.width/height only exists for videoDecision="copy" (audio-only transcode)
  // For actual video transcodes, use Media/Stream element dimensions (the transcoded output)
  const width = parseOptionalNumber(transcodeSession.width) ?? fallbackDimensions?.width;
  if (width) details.width = width;

  const height = parseOptionalNumber(transcodeSession.height) ?? fallbackDimensions?.height;
  if (height) details.height = height;

  // If transcoding, framerate may change (rare but possible)
  // Most transcodes preserve framerate, so we use source if not specified
  if (sourceVideoDetails.framerate) {
    details.framerate = sourceVideoDetails.framerate;
  }

  // Dynamic range may be tone-mapped (HDR → SDR)
  // TranscodeSession doesn't expose this directly, assume preserved for now
  if (sourceVideoDetails.dynamicRange) {
    details.dynamicRange = sourceVideoDetails.dynamicRange;
  }

  const codec = parseOptionalString(transcodeSession.videoCodec)?.toUpperCase();

  return { codec, details };
}

/**
 * Extract stream audio details (output after transcode)
 */
function extractStreamAudioDetails(transcodeSession: Record<string, unknown> | undefined): {
  codec?: string;
  details: StreamAudioDetails;
} {
  if (!transcodeSession) {
    return { details: {} };
  }

  const details: StreamAudioDetails = {};

  const channels = parseOptionalNumber(transcodeSession.audioChannels);
  if (channels) details.channels = channels;

  // Language is preserved through transcode
  // (would need to track from source if needed)

  const codec = parseOptionalString(transcodeSession.audioCodec)?.toUpperCase();

  return { codec, details };
}

/**
 * Extract all stream details from Media/Part/Stream hierarchy
 */
interface StreamDetailsResult {
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

function extractStreamDetails(
  mediaArray: Array<Record<string, unknown>> | undefined,
  transcodeSession: Record<string, unknown> | undefined
): StreamDetailsResult {
  // Find the selected media element (when multiple versions exist)
  const selectedMedia = findSelectedElement<Record<string, unknown>>(mediaArray);

  // The playing Part carries selected=1 in session payloads; single-part media
  // falls back to the first
  const parts = selectedMedia?.Part as Array<Record<string, unknown>> | undefined;
  const part = findSelectedElement<Record<string, unknown>>(parts);

  // Find streams by type
  const videoStream = findStreamByType(part, STREAM_TYPE.VIDEO);
  const audioStream = findStreamByType(part, STREAM_TYPE.AUDIO);
  const subtitleStream = findStreamByType(part, STREAM_TYPE.SUBTITLE);

  const sourceVideo = extractSourceVideoDetails(videoStream, selectedMedia);
  const sourceAudio = extractSourceAudioDetails(audioStream);

  // Extract stream (output) details
  // Pass Media element dimensions as fallback for when TranscodeSession lacks width/height
  // (which happens during actual video transcodes, not just audio-only transcodes)
  const mediaWidth = parseOptionalNumber(selectedMedia?.width);
  const mediaHeight = parseOptionalNumber(selectedMedia?.height);
  const streamVideo = extractStreamVideoDetails(transcodeSession, sourceVideo.details, {
    width: mediaWidth,
    height: mediaHeight,
  });
  const streamAudio = extractStreamAudioDetails(transcodeSession);

  // Extract transcode and subtitle info
  const transcodeInfo = extractTranscodeInfo(transcodeSession, part);
  const subtitleInfo = extractSubtitleInfo(subtitleStream);

  // CRITICAL: When transcoding, Plex's Stream[] array contains OUTPUT streams, not source streams.
  // The TranscodeSession object provides the actual source codec information:
  // - TranscodeSession.sourceVideoCodec / sourceAudioCodec = original file's codec
  // - TranscodeSession.videoCodec / audioCodec = transcoded output codec
  // - Stream[].codec = also the output codec when transcoding
  // Only fall back to Stream[].codec for direct play (no TranscodeSession).
  const transcodeSourceVideoCodec = parseOptionalString(transcodeSession?.sourceVideoCodec);
  const transcodeSourceAudioCodec = parseOptionalString(transcodeSession?.sourceAudioCodec);

  // Use TranscodeSession source codecs when transcoding, otherwise stream codec (direct play)
  const resolvedSourceVideoCodec = transcodeSourceVideoCodec?.toUpperCase() ?? sourceVideo.codec;
  const resolvedSourceAudioCodec = transcodeSourceAudioCodec?.toUpperCase() ?? sourceAudio.codec;

  // Handle '*' codec placeholder (Plex uses '*' when transcoding, fallback to source codec)
  const resolveCodec = (
    streamCodec: string | undefined,
    sourceCodec: string | undefined
  ): string | undefined => (streamCodec && streamCodec !== '*' ? streamCodec : sourceCodec);

  return {
    // Scalar fields for indexing
    sourceVideoCodec: resolvedSourceVideoCodec,
    sourceAudioCodec: resolvedSourceAudioCodec,
    sourceAudioChannels: sourceAudio.channels,
    streamVideoCodec: resolveCodec(streamVideo.codec, resolvedSourceVideoCodec),
    streamAudioCodec: resolveCodec(streamAudio.codec, resolvedSourceAudioCodec),

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

// ============================================================================
// Original Media Metadata Parsing
// ============================================================================

/**
 * Parse original media metadata from /library/metadata/{ratingKey} response.
 * This provides the TRUE source file information, which is needed because
 * during transcodes, the session's Media/Part/Stream data shows transcoded output.
 *
 * @param targetMediaId - When provided, selects the Media version with this id
 */
export function parseMediaMetadataResponse(
  data: unknown,
  targetMediaId?: string
): PlexOriginalMedia | null {
  const container = data as { MediaContainer?: { Metadata?: unknown[] } };
  const metadata = container?.MediaContainer?.Metadata;
  if (!Array.isArray(metadata) || metadata.length === 0) return null;

  const item = metadata[0] as Record<string, unknown>;
  const mediaArray = item?.Media as Array<Record<string, unknown>> | undefined;
  if (!mediaArray || mediaArray.length === 0) return null;

  // Match by media ID when provided, fall back to selected or first
  const selectedMedia =
    (targetMediaId ? mediaArray.find((m) => String(m.id) === targetMediaId) : undefined) ??
    findSelectedElement<Record<string, unknown>>(mediaArray);
  const parts = selectedMedia?.Part as Array<Record<string, unknown>> | undefined;
  const part = findSelectedElement<Record<string, unknown>>(parts);

  const videoStream = findStreamByType(part, STREAM_TYPE.VIDEO);
  const audioStream = findStreamByType(part, STREAM_TYPE.AUDIO);

  // Extract source video details
  const sourceVideoDetails: SourceVideoDetails = {};
  if (videoStream) {
    const videoBitrate = parseOptionalNumber(videoStream.bitrate);
    if (videoBitrate) sourceVideoDetails.bitrate = videoBitrate;

    const frameRate =
      parseOptionalString(videoStream.frameRate) ??
      parseOptionalString(selectedMedia?.videoFrameRate);
    if (frameRate) sourceVideoDetails.framerate = frameRate;

    const dynamicRange = deriveDynamicRange(videoStream);
    if (dynamicRange !== 'SDR') sourceVideoDetails.dynamicRange = dynamicRange;
    else sourceVideoDetails.dynamicRange = 'SDR';

    const aspectRatio = parseOptionalNumber(selectedMedia?.aspectRatio);
    if (aspectRatio) sourceVideoDetails.aspectRatio = aspectRatio;

    const profile = parseOptionalString(videoStream.profile);
    if (profile) sourceVideoDetails.profile = profile;

    const level = parseOptionalString(videoStream.level);
    if (level) sourceVideoDetails.level = level;

    const colorSpace = parseOptionalString(videoStream.colorSpace);
    if (colorSpace) sourceVideoDetails.colorSpace = colorSpace;

    const colorDepth = parseOptionalNumber(videoStream.bitDepth);
    if (colorDepth) sourceVideoDetails.colorDepth = colorDepth;
  }

  // Extract source audio details
  const sourceAudioDetails: SourceAudioDetails = {};
  if (audioStream) {
    const audioBitrate = parseOptionalNumber(audioStream.bitrate);
    if (audioBitrate) sourceAudioDetails.bitrate = audioBitrate;

    const channelLayout = parseOptionalString(audioStream.audioChannelLayout);
    if (channelLayout) sourceAudioDetails.channelLayout = channelLayout;

    const language = parseOptionalString(audioStream.language);
    if (language) sourceAudioDetails.language = language;

    const sampleRate = parseOptionalNumber(audioStream.samplingRate);
    if (sampleRate) sourceAudioDetails.sampleRate = sampleRate;
  }

  return {
    videoBitrate: parseOptionalNumber(videoStream?.bitrate),
    audioBitrate: parseOptionalNumber(audioStream?.bitrate),
    videoWidth: parseOptionalNumber(videoStream?.width),
    videoHeight: parseOptionalNumber(videoStream?.height),
    bitrate: parseOptionalNumber(selectedMedia?.bitrate),
    videoCodec: parseOptionalString(videoStream?.codec)?.toUpperCase(),
    audioCodec: parseOptionalString(audioStream?.codec)?.toUpperCase(),
    audioChannels: parseOptionalNumber(audioStream?.channels),
    container: parseOptionalString(selectedMedia?.container)?.toUpperCase(),
    sourceVideoDetails: Object.keys(sourceVideoDetails).length > 0 ? sourceVideoDetails : undefined,
    sourceAudioDetails: Object.keys(sourceAudioDetails).length > 0 ? sourceAudioDetails : undefined,
  };
}

// ============================================================================
// Session Parsing
// ============================================================================

/**
 * Parse Plex media type to unified type
 * @param type - The media type string from Plex
 * @param isLive - Whether this is a Live TV stream (live='1')
 */
function parseMediaType(type: unknown, isLive: boolean = false): MediaSession['media']['type'] {
  // Live TV takes precedence - can be any type but we track it as 'live'
  if (isLive) {
    return 'live';
  }

  const typeStr = parseString(type).toLowerCase();
  switch (typeStr) {
    case 'movie':
      return 'movie';
    case 'episode':
      return 'episode';
    case 'track':
      return 'track';
    case 'photo':
      return 'photo';
    case 'clip':
      return 'trailer';
    default:
      return 'unknown';
  }
}

/**
 * Parse player state from Plex to unified state
 */
function parsePlaybackState(state: unknown): MediaSession['playback']['state'] {
  const stateStr = parseString(state, 'playing').toLowerCase();
  switch (stateStr) {
    case 'paused':
      return 'paused';
    case 'buffering':
      return 'buffering';
    default:
      return 'playing';
  }
}

/**
 * Parse raw Plex session data into a MediaSession object
 *
 * @param item - Raw session data from /status/sessions
 * @param originalMedia - Optional original media metadata from /library/metadata/{ratingKey}.
 *   When provided and session is transcoding, this is used for true source info because
 *   Plex's session data shows transcoded output in Media/Part/Stream during transcodes.
 */
export function parseSession(
  item: Record<string, unknown>,
  originalMedia?: PlexOriginalMedia | null
): MediaSession {
  const player = (item.Player as Record<string, unknown>) ?? {};
  const user = (item.User as Record<string, unknown>) ?? {};
  const sessionInfo = (item.Session as Record<string, unknown>) ?? {};
  const transcodeSession = item.TranscodeSession as Record<string, unknown> | undefined;
  const mediaArray = item.Media as Array<Record<string, unknown>> | undefined;
  const selectedMediaElement = findSelectedElement<Record<string, unknown>>(mediaArray);

  const durationMs = parseNumber(item.duration);
  const positionMs = parseNumber(item.viewOffset);

  // Detect Live TV - Plex sets live='1' on the session
  const isLive = parseString(item.live) === '1';
  const mediaType = parseMediaType(item.type, isLive);

  // Get stream decisions using the transcode normalizer
  const { videoDecision, audioDecision, isTranscode } = normalizeStreamDecisions(
    transcodeSession?.videoDecision as string | null,
    transcodeSession?.audioDecision as string | null
  );

  // CRITICAL: During transcodes, Plex's session Media/Part/Stream shows the TRANSCODED output,
  // not the original source. We need originalMedia from /library/metadata to get true source info.
  //
  // When transcoding with originalMedia:
  //   - Source info comes from originalMedia (true source file)
  //   - Stream info comes from session's Media/Part/Stream (transcoded output)
  // When direct play or no originalMedia:
  //   - Session's Media/Part/Stream IS the source (no transcoding happening)

  // Get session bitrate and resolution (this is transcoded output during transcodes)
  const sessionBitrate = parseNumber(parseSelectedArrayElement(item.Media, 'bitrate'));
  const sessionVideoResolution = parseOptionalString(
    parseSelectedArrayElement(item.Media, 'videoResolution')
  );
  const sessionVideoWidth = parseOptionalNumber(parseSelectedArrayElement(item.Media, 'width'));
  const sessionVideoHeight = parseOptionalNumber(parseSelectedArrayElement(item.Media, 'height'));

  // Extract detailed stream metadata from session
  const sessionStreamDetails = extractStreamDetails(mediaArray, transcodeSession);

  // When transcoding with original media available, use it for true source info
  // and treat session data as the stream (transcoded) output
  let streamDetails: StreamDetailsResult;
  let bitrate: number;
  let videoWidth: number | undefined;
  let videoHeight: number | undefined;
  let videoResolution: string | undefined;

  // Check if originalMedia has valid dimensions (not just that it exists)
  const hasValidOriginalMedia = originalMedia?.videoWidth && originalMedia?.videoHeight;

  if (isTranscode && hasValidOriginalMedia) {
    // Use original media for source, session data for stream output
    bitrate = sessionBitrate; // Current streaming bitrate (transcoded)
    videoWidth = originalMedia.videoWidth; // Source dimensions
    videoHeight = originalMedia.videoHeight;
    videoResolution = undefined; // Will be derived from width/height

    // Build stream details with correct source vs stream separation
    streamDetails = {
      // Source info from original media
      sourceVideoCodec: sessionStreamDetails.sourceVideoCodec ?? originalMedia.videoCodec,
      sourceAudioCodec: sessionStreamDetails.sourceAudioCodec ?? originalMedia.audioCodec,
      sourceAudioChannels: sessionStreamDetails.sourceAudioChannels ?? originalMedia.audioChannels,
      sourceVideoDetails: originalMedia.sourceVideoDetails,
      sourceAudioDetails: originalMedia.sourceAudioDetails,

      // Stream (transcoded) info from session data
      streamVideoCodec: sessionStreamDetails.streamVideoCodec,
      streamAudioCodec: sessionStreamDetails.streamAudioCodec,
      streamVideoDetails: {
        ...sessionStreamDetails.streamVideoDetails,
        // TranscodeSession.width/height already extracted correctly by extractStreamVideoDetails
        // Do NOT override with sessionVideoWidth/sessionVideoHeight (those are source dimensions)
        // Session's Stream[].bitrate during transcode IS the transcoded video bitrate
        bitrate: sessionStreamDetails.sourceVideoDetails?.bitrate,
      },
      streamAudioDetails: {
        ...sessionStreamDetails.streamAudioDetails,
        // Session's Stream[].bitrate for audio during transcode IS the transcoded audio bitrate
        bitrate: sessionStreamDetails.sourceAudioDetails?.bitrate,
      },

      // Transcode and subtitle info
      transcodeInfo: {
        ...sessionStreamDetails.transcodeInfo,
        // Add source container from original media if available
        sourceContainer:
          sessionStreamDetails.transcodeInfo?.sourceContainer ?? originalMedia.container,
      },
      subtitleInfo: sessionStreamDetails.subtitleInfo,
    };
  } else {
    // Direct play or no original media - session data is the source
    streamDetails = sessionStreamDetails;
    bitrate = sessionBitrate;
    videoWidth = sessionVideoWidth;
    videoHeight = sessionVideoHeight;
    videoResolution = sessionVideoResolution;
  }

  const session: MediaSession = {
    sessionKey: parseString(item.sessionKey),
    mediaId: parseString(item.ratingKey),
    serverVersionKey:
      selectedMediaElement?.id != null ? String(selectedMediaElement.id) : undefined,
    user: {
      id: parseString(user.id),
      username: parseString(user.title),
      thumb: parseOptionalString(user.thumb),
    },
    media: {
      title: parseString(item.title),
      type: mediaType,
      durationMs,
      year: parseOptionalNumber(item.year),
      thumbPath: parseOptionalString(item.thumb),
    },
    playback: {
      state: parsePlaybackState(player.state),
      positionMs,
      progressPercent: calculateProgress(positionMs, durationMs),
    },
    player: {
      name: parseString(player.title),
      deviceId: parseString(player.machineIdentifier),
      product: parseOptionalString(player.product),
      device: parseOptionalString(player.device),
      platform: parseOptionalString(player.platform),
    },
    network: {
      // For local streams, use local address so GeoIP correctly identifies as "Local"
      // For remote streams, prefer public IP for accurate geo-location
      ipAddress: parseBoolean(player.local)
        ? parseString(player.address)
        : parseString(player.remotePublicAddress) || parseString(player.address),
      isLocal: parseBoolean(player.local),
    },
    quality: {
      bitrate,
      isTranscode,
      videoDecision,
      audioDecision,
      videoResolution,
      videoWidth,
      videoHeight,
      // Spread in detailed stream metadata
      ...streamDetails,
    },
    // Plex termination API requires Session.id, not sessionKey
    plexSessionId: parseOptionalString(sessionInfo.id),
  };

  // Add episode-specific metadata if this is an episode
  if (mediaType === 'episode') {
    session.episode = {
      showTitle: parseString(item.grandparentTitle),
      showId: parseOptionalString(item.grandparentRatingKey),
      seasonNumber: parseOptionalNumber(item.parentIndex) ?? null,
      episodeNumber: parseOptionalNumber(item.index) ?? null,
      seasonName: parseOptionalString(item.parentTitle),
      showThumbPath: parseOptionalString(item.grandparentThumb),
    };
  }

  // Add Live TV metadata if this is a live stream
  if (mediaType === 'live') {
    const liveTvMetadata = extractPlexLiveTvMetadata(item, selectedMediaElement);
    if (liveTvMetadata) {
      session.live = liveTvMetadata;
    }
  }

  // Add music track metadata if this is a track
  if (mediaType === 'track') {
    session.music = extractPlexMusicMetadata(item);
  }

  return session;
}

/**
 * Parse Plex sessions API response
 *
 * @param data - Raw response from /status/sessions
 * @param originalMediaMap - Optional map of ratingKey (or "ratingKey:mediaId") -> PlexOriginalMedia
 *   for transcoding sessions. Composite keys take precedence over ratingKey-only keys.
 */
export function parseSessionsResponse(
  data: unknown,
  originalMediaMap?: Map<string, PlexOriginalMedia>
): MediaSession[] {
  const container = data as { MediaContainer?: { Metadata?: unknown[] } };
  // A valid "no sessions" response has a MediaContainer with no Metadata array.
  // A missing/invalid MediaContainer means the body is malformed (proxy error
  // page, wrong shape); throw so the caller treats it as a failed poll rather
  // than "all sessions ended".
  if (container?.MediaContainer == null || typeof container.MediaContainer !== 'object') {
    throw new Error('Unexpected Plex sessions response: missing MediaContainer');
  }
  const metadata = container.MediaContainer.Metadata;
  return parseArray(metadata, (item) => {
    const session = item as Record<string, unknown>;
    const ratingKey = parseString(session.ratingKey);

    const mediaArray = session.Media as Array<Record<string, unknown>> | undefined;
    const selectedMedia = findSelectedElement<Record<string, unknown>>(mediaArray);
    const sessionMediaId = selectedMedia?.id != null ? String(selectedMedia.id) : undefined;

    const originalMedia =
      (sessionMediaId ? originalMediaMap?.get(`${ratingKey}:${sessionMediaId}`) : undefined) ??
      originalMediaMap?.get(ratingKey) ??
      null;

    return parseSession(session, originalMedia);
  });
}

/**
 * Extract ratingKeys of sessions that are transcoding and would benefit from
 * fetching original media metadata for accurate source info.
 *
 * @param data - Raw response from /status/sessions
 * @returns Array of `{ ratingKey, sessionMediaId }` for transcoding sessions,
 *   where `sessionMediaId` is the id of the Media element the session is playing
 */
export function getTranscodingSessionRatingKeys(
  data: unknown
): Array<{ ratingKey: string; sessionMediaId: string | undefined }> {
  const container = data as { MediaContainer?: { Metadata?: unknown[] } };
  const metadata = container?.MediaContainer?.Metadata;
  if (!Array.isArray(metadata)) return [];

  return metadata
    .filter((item) => {
      const session = item as Record<string, unknown>;
      const transcodeSession = session.TranscodeSession as Record<string, unknown> | undefined;
      // Session is transcoding if it has a TranscodeSession with video or audio transcode
      if (!transcodeSession) return false;
      const videoDecision = parseOptionalString(transcodeSession.videoDecision);
      const audioDecision = parseOptionalString(transcodeSession.audioDecision);
      return videoDecision === 'transcode' || audioDecision === 'transcode';
    })
    .map((item) => {
      const session = item as Record<string, unknown>;
      const ratingKey = parseString(session.ratingKey);
      const mediaArray = session.Media as Array<Record<string, unknown>> | undefined;
      const selectedMedia = findSelectedElement<Record<string, unknown>>(mediaArray);
      const sessionMediaId = selectedMedia?.id != null ? String(selectedMedia.id) : undefined;
      return { ratingKey, sessionMediaId };
    })
    .filter((entry) => entry.ratingKey !== '');
}

// ============================================================================
// User Parsing
// ============================================================================

/**
 * Parse raw Plex user data into a MediaUser object
 * Used for local server accounts from /accounts endpoint
 */
export function parseLocalUser(user: Record<string, unknown>): MediaUser {
  const userId = parseString(user.id);
  return {
    id: userId,
    username: parseString(user.name),
    email: undefined, // Local accounts don't have email
    thumb: parseOptionalString(user.thumb),
    // Account ID 1 is typically the owner
    isAdmin: userId === '1' || parseNumber(user.id) === 1,
    isDisabled: false,
  };
}

/**
 * Parse Unix timestamp from unknown value to Date
 */
function parseUnixTimestamp(value: unknown): Date | undefined {
  if (value == null) return undefined;
  const timestamp = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (isNaN(timestamp) || timestamp <= 0) return undefined;
  return new Date(timestamp * 1000); // Convert seconds to milliseconds
}

/**
 * Parse Plex.tv user data into a MediaUser object
 * Used for users from plex.tv API endpoints
 */
export function parsePlexTvUser(
  user: Record<string, unknown>,
  sharedLibraries?: string[]
): MediaUser {
  return {
    id: parseString(user.id),
    username: parseString(user.username) || parseString(user.title),
    email: parseOptionalString(user.email),
    thumb: parseOptionalString(user.thumb),
    isAdmin: parseBoolean(user.isAdmin),
    isDisabled: false,
    isHomeUser: parseBoolean(user.home) || parseBoolean(user.isHomeUser),
    sharedLibraries: sharedLibraries ?? [],
    // Plex.tv API returns joinedAt (Unix timestamp) for when user joined Plex
    joinedAt: parseUnixTimestamp(user.joinedAt) ?? parseUnixTimestamp(user.createdAt),
  };
}

/**
 * Parse Plex local accounts API response
 */
export function parseUsersResponse(data: unknown): MediaUser[] {
  const container = data as { MediaContainer?: { Account?: unknown[] } };
  const accounts = container?.MediaContainer?.Account;
  return parseArray(accounts, (user) => parseLocalUser(user as Record<string, unknown>));
}

// ============================================================================
// Library Parsing
// ============================================================================

/**
 * Parse raw Plex library data into a MediaLibrary object
 */
export function parseLibrary(dir: Record<string, unknown>): MediaLibrary {
  return {
    id: parseString(dir.key),
    name: parseString(dir.title),
    type: parseString(dir.type),
    agent: parseOptionalString(dir.agent),
    scanner: parseOptionalString(dir.scanner),
  };
}

/**
 * Parse Plex libraries API response
 */
export function parseLibrariesResponse(data: unknown): MediaLibrary[] {
  const container = data as { MediaContainer?: { Directory?: unknown[] } };
  const directories = container?.MediaContainer?.Directory;
  return parseArray(directories, (dir) => parseLibrary(dir as Record<string, unknown>));
}

// ============================================================================
// Watch History Parsing
// ============================================================================

/**
 * Parse raw Plex watch history item
 */
export function parseWatchHistoryItem(item: Record<string, unknown>): MediaWatchHistoryItem {
  const mediaType = parseMediaType(item.type);

  const historyItem: MediaWatchHistoryItem = {
    mediaId: parseString(item.ratingKey),
    title: parseString(item.title),
    type: mediaType === 'photo' ? 'unknown' : mediaType,
    // Plex returns Unix timestamp
    watchedAt: parseNumber(item.lastViewedAt) || parseNumber(item.viewedAt),
    userId: parseOptionalString(item.accountID),
  };

  // Add episode metadata if applicable
  if (mediaType === 'episode') {
    historyItem.episode = {
      showTitle: parseString(item.grandparentTitle),
      seasonNumber: parseOptionalNumber(item.parentIndex),
      episodeNumber: parseOptionalNumber(item.index),
    };
  }

  return historyItem;
}

/**
 * Parse Plex watch history API response
 */
export function parseWatchHistoryResponse(data: unknown): MediaWatchHistoryItem[] {
  const container = data as { MediaContainer?: { Metadata?: unknown[] } };
  const metadata = container?.MediaContainer?.Metadata;
  return parseArray(metadata, (item) => parseWatchHistoryItem(item as Record<string, unknown>));
}

// ============================================================================
// Server Resource Parsing (for plex.tv API)
// ============================================================================

/**
 * Server connection details
 */
export interface PlexServerConnection {
  protocol: string;
  address: string;
  port: number;
  uri: string;
  local: boolean;
  /**
   * True if this connection goes through Plex's relay service.
   * Relay connections are bandwidth-limited (2Mbps) and designed for client apps,
   * not server-to-server communication.
   */
  relay: boolean;
}

/**
 * Server resource from plex.tv
 */
export interface PlexServerResource {
  name: string;
  product: string;
  productVersion: string;
  platform: string;
  clientIdentifier: string;
  owned: boolean;
  accessToken: string;
  publicAddress: string;
  /**
   * True if the requesting client's public IP matches the server's public IP.
   * Used to determine which connections are reachable:
   * - true: client is on same network, local connections will work
   * - false: client is remote, only remote connections will work
   */
  publicAddressMatches: boolean;
  /**
   * True if the server requires HTTPS connections.
   * When true, HTTP connections will be rejected by the server.
   */
  httpsRequired: boolean;
  connections: PlexServerConnection[];
}

/**
 * Parse server connection
 */
export function parseServerConnection(conn: Record<string, unknown>): PlexServerConnection {
  return {
    protocol: parseString(conn.protocol, 'http'),
    address: parseString(conn.address),
    port: parseNumber(conn.port, 32400),
    uri: parseString(conn.uri),
    local: parseBoolean(conn.local),
    relay: parseBoolean(conn.relay),
  };
}

/**
 * Parse server resource from plex.tv resources API
 *
 * Filters connections based on:
 * - relay: Relay connections are filtered out (bandwidth-limited, for client apps only)
 * - httpsRequired: If true, only HTTPS connections are usable (HTTP will be rejected)
 *
 * Note: We do NOT filter based on publicAddressMatches because that field reflects
 * the browser's network context during OAuth, not Tracearr server's network context.
 * Tracearr may be on the same Docker network as Plex even if the browser is remote.
 */
export function parseServerResource(
  resource: Record<string, unknown>,
  fallbackToken: string
): PlexServerResource {
  const publicAddressMatches = parseBoolean(resource.publicAddressMatches);
  const httpsRequired = parseBoolean(resource.httpsRequired);

  // Parse all connections
  const allConnections = parseArray(resource.connections, (conn) =>
    parseServerConnection(conn as Record<string, unknown>)
  );

  // Filter connections based on what's actually usable from server-side
  const connections = allConnections.filter((conn) => {
    // Relay connections don't work for server-to-server communication
    // They're bandwidth-limited (2Mbps) and designed for client apps
    if (conn.relay) {
      return false;
    }

    // If HTTPS is required, filter out HTTP connections
    if (httpsRequired && conn.protocol !== 'https') {
      return false;
    }

    return true;
  });

  // If filtering removed all connections, fall back to showing all
  // (better to let user try than show nothing)
  const filteredConnections = connections.length > 0 ? connections : allConnections;

  // Sort connections: HTTPS first, then local preference for same-network scenarios
  const finalConnections = [...filteredConnections].sort((a, b) => {
    // HTTPS first
    const aHttps = a.protocol === 'https';
    const bHttps = b.protocol === 'https';
    if (aHttps !== bHttps) return aHttps ? -1 : 1;
    // Then local preference (local connections are typically faster)
    if (a.local !== b.local) return a.local ? -1 : 1;
    return 0;
  });

  return {
    name: parseString(resource.name, 'Plex Server'),
    product: parseString(resource.product),
    productVersion: parseString(resource.productVersion),
    platform: parseString(resource.platform),
    clientIdentifier: parseString(resource.clientIdentifier),
    owned: parseBoolean(resource.owned),
    accessToken: parseString(resource.accessToken) || fallbackToken,
    publicAddress: parseString(resource.publicAddress),
    publicAddressMatches,
    httpsRequired,
    connections: finalConnections,
  };
}

/**
 * Parse and filter plex.tv resources for owned Plex Media Servers
 */
export function parseServerResourcesResponse(
  data: unknown,
  fallbackToken: string
): PlexServerResource[] {
  if (!Array.isArray(data)) return [];

  return data
    .filter(
      (r) =>
        (r as Record<string, unknown>).provides === 'server' &&
        (r as Record<string, unknown>).owned === true &&
        (r as Record<string, unknown>).product === 'Plex Media Server'
    )
    .map((r) => parseServerResource(r as Record<string, unknown>, fallbackToken));
}

// ============================================================================
// XML Parsing Helpers (for plex.tv endpoints that return XML)
// ============================================================================

/**
 * Extract attribute value from XML string
 */
export function extractXmlAttribute(xml: string, attr: string): string {
  const match = xml.match(new RegExp(`${attr}="([^"]+)"`));
  return match?.[1] ?? '';
}

/**
 * Extract ID attribute (handles both 'id' and ' id' patterns)
 */
export function extractXmlId(xml: string): string {
  const match = xml.match(/(?:^|\s)id="([^"]+)"/);
  return match?.[1] ?? '';
}

/**
 * Parse Unix timestamp from XML attribute to Date (Plex uses seconds since epoch)
 */
function parseXmlTimestamp(xml: string, attr: string): Date | undefined {
  const value = extractXmlAttribute(xml, attr);
  if (!value) return undefined;
  const timestamp = parseInt(value, 10);
  if (isNaN(timestamp) || timestamp <= 0) return undefined;
  return new Date(timestamp * 1000); // Convert seconds to milliseconds
}

/**
 * Parse a user from XML (from /api/users endpoint)
 */
export function parseXmlUser(userXml: string): MediaUser {
  return {
    id: extractXmlId(userXml),
    username: extractXmlAttribute(userXml, 'username') || extractXmlAttribute(userXml, 'title'),
    email: extractXmlAttribute(userXml, 'email') || undefined,
    thumb: extractXmlAttribute(userXml, 'thumb') || undefined,
    isAdmin: false,
    isHomeUser: extractXmlAttribute(userXml, 'home') === '1',
    sharedLibraries: [],
    // Plex provides createdAt (account creation) - use as joinedAt
    joinedAt: parseXmlTimestamp(userXml, 'createdAt'),
  };
}

/**
 * Parse users from XML response (plex.tv /api/users)
 */
export function parseXmlUsersResponse(xml: string): MediaUser[] {
  const userMatches = Array.from(xml.matchAll(/<User[^>]*(?:\/>|>[\s\S]*?<\/User>)/g));
  return userMatches.map((match) => parseXmlUser(match[0]));
}

/**
 * Parse shared server info from XML (plex.tv /api/servers/{id}/shared_servers)
 */
export function parseSharedServersXml(
  xml: string
): Map<string, { serverToken: string; sharedLibraries: string[] }> {
  const userMap = new Map<string, { serverToken: string; sharedLibraries: string[] }>();
  const serverMatches = Array.from(xml.matchAll(/<SharedServer[^>]*>[\s\S]*?<\/SharedServer>/g));

  for (const match of serverMatches) {
    const serverXml = match[0];
    const userId = extractXmlAttribute(serverXml, 'userID');
    const serverToken = extractXmlAttribute(serverXml, 'accessToken');

    // Get shared libraries - sections with shared="1"
    const sectionMatches = Array.from(serverXml.matchAll(/<Section[^>]*shared="1"[^>]*>/g));
    const sharedLibraries = sectionMatches
      .map((sectionMatch) => extractXmlAttribute(sectionMatch[0], 'key'))
      .filter((key): key is string => key !== '');

    if (userId) {
      userMap.set(userId, { serverToken, sharedLibraries });
    }
  }

  return userMap;
}

// ============================================================================
// Server Resource Statistics Parsing
// ============================================================================

/** Raw statistics resource data point from Plex API */
interface PlexRawStatisticsResource {
  at?: unknown;
  timespan?: unknown;
  hostCpuUtilization?: unknown;
  processCpuUtilization?: unknown;
  hostMemoryUtilization?: unknown;
  processMemoryUtilization?: unknown;
}

/** Parsed statistics data point */
export interface PlexStatisticsDataPoint {
  at: number;
  timespan: number;
  hostCpuUtilization: number;
  processCpuUtilization: number;
  hostMemoryUtilization: number;
  processMemoryUtilization: number;
}

/**
 * Parse a single statistics resource data point
 */
function parseStatisticsDataPoint(raw: PlexRawStatisticsResource): PlexStatisticsDataPoint {
  return {
    at: parseNumber(raw.at),
    timespan: parseNumber(raw.timespan, 6),
    hostCpuUtilization: parseNumber(raw.hostCpuUtilization, 0),
    processCpuUtilization: parseNumber(raw.processCpuUtilization, 0),
    hostMemoryUtilization: parseNumber(raw.hostMemoryUtilization, 0),
    processMemoryUtilization: parseNumber(raw.processMemoryUtilization, 0),
  };
}

/**
 * Parse statistics resources response from /statistics/resources endpoint
 * Returns array of data points sorted by timestamp (newest first)
 */
export function parseStatisticsResourcesResponse(data: unknown): PlexStatisticsDataPoint[] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  const container = (data as Record<string, unknown>).MediaContainer;
  if (!container || typeof container !== 'object') {
    return [];
  }

  const rawStats = (container as Record<string, unknown>).StatisticsResources;

  return parseArray(rawStats, (item) =>
    parseStatisticsDataPoint(item as PlexRawStatisticsResource)
  ).sort((a, b) => b.at - a.at); // Sort newest first
}

// ============================================================================
// Bandwidth Statistics Parsing
// ============================================================================

/** Raw bandwidth entry from Plex /statistics/bandwidth API */
interface PlexRawStatisticsBandwidth {
  at?: unknown;
  timespan?: unknown;
  lan?: unknown;
  bytes?: unknown;
  accountID?: unknown;
  deviceID?: unknown;
}

export interface PlexBandwidthDataPoint {
  at: number;
  timespan: number;
  lanBytes: number;
  wanBytes: number;
}

export interface PlexBandwidthStats {
  points: PlexBandwidthDataPoint[];
  samples: BandwidthSample[];
  accounts: BandwidthAccount[];
  devices: BandwidthDevice[];
}

const EMPTY_BANDWIDTH_STATS: PlexBandwidthStats = {
  points: [],
  samples: [],
  accounts: [],
  devices: [],
};

/**
 * Parse statistics bandwidth response from /statistics/bandwidth endpoint.
 *
 * The endpoint returns per-second entries per device/account plus Account and
 * Device lookup maps. Samples keep the per-account/device attribution; points
 * aggregate the same samples per timestamp into local/remote totals.
 * Note: Plex echoes the query timespan (6) but data is per-second, so points
 * use timespan=1 since each entry represents 1 second of bandwidth.
 */
export function parseStatisticsBandwidthResponse(data: unknown): PlexBandwidthStats {
  if (!data || typeof data !== 'object') {
    return EMPTY_BANDWIDTH_STATS;
  }

  const container = (data as Record<string, unknown>).MediaContainer;
  if (!container || typeof container !== 'object') {
    return EMPTY_BANDWIDTH_STATS;
  }

  const rawStats = (container as Record<string, unknown>).StatisticsBandwidth;
  if (!Array.isArray(rawStats)) {
    return EMPTY_BANDWIDTH_STATS;
  }

  const samples: BandwidthSample[] = [];
  const byTimestamp = new Map<number, { lanBytes: number; wanBytes: number }>();

  for (const raw of rawStats) {
    const entry = raw as PlexRawStatisticsBandwidth;
    const at = parseNumber(entry.at);
    if (at === 0) continue;

    const bytes = parseNumber(entry.bytes, 0);
    const lan = parseBoolean(entry.lan);

    samples.push({
      at,
      accountId: parseNumber(entry.accountID),
      deviceId: parseNumber(entry.deviceID),
      lan,
      bytes,
    });

    let bucket = byTimestamp.get(at);
    if (!bucket) {
      bucket = { lanBytes: 0, wanBytes: 0 };
      byTimestamp.set(at, bucket);
    }

    if (lan) {
      bucket.lanBytes += bytes;
    } else {
      bucket.wanBytes += bytes;
    }
  }

  samples.sort((a, b) => b.at - a.at);

  const points = Array.from(byTimestamp.entries())
    .map(([at, bucket]) => ({
      at,
      timespan: 1,
      lanBytes: bucket.lanBytes,
      wanBytes: bucket.wanBytes,
    }))
    .sort((a, b) => b.at - a.at);

  const referencedAccounts = new Set(samples.map((s) => s.accountId));
  const referencedDevices = new Set(samples.map((s) => s.deviceId));

  const accounts = parseArray((container as Record<string, unknown>).Account, (item) => {
    const raw = item as Record<string, unknown>;
    return {
      id: parseNumber(raw.id),
      name: parseString(raw.name),
      thumb: parseOptionalString(raw.thumb) ?? null,
    };
  }).filter((a) => referencedAccounts.has(a.id));

  const devices = parseArray((container as Record<string, unknown>).Device, (item) => {
    const raw = item as Record<string, unknown>;
    return {
      id: parseNumber(raw.id),
      name: parseString(raw.name),
      platform: parseOptionalString(raw.platform) ?? null,
    };
  }).filter((d) => referencedDevices.has(d.id));

  return { points, samples, accounts, devices };
}

// ============================================================================
// Library Item Parsing (for library sync)
// ============================================================================

/**
 * Parse external IDs from Plex Guid array
 *
 * CRITICAL: Plex new agents return `plex://` internal IDs in the main guid attribute.
 * External IDs (IMDB, TMDB, TVDB) are in nested Guid elements requiring `includeGuids=1`.
 *
 * Guid array format: [{ id: "imdb://tt1234567" }, { id: "tmdb://12345" }, ...]
 */
function parseExternalIds(guids: Array<{ id: string }> | undefined): {
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
  musicBrainzId?: string;
} {
  if (!guids || !Array.isArray(guids)) return {};

  const result: { imdbId?: string; tmdbId?: number; tvdbId?: number; musicBrainzId?: string } = {};

  for (const guid of guids) {
    const id = guid.id;
    if (id?.startsWith('imdb://')) {
      result.imdbId = id.replace('imdb://', '');
    } else if (id?.startsWith('tmdb://')) {
      const parsed = parseInt(id.replace('tmdb://', ''), 10);
      if (!isNaN(parsed)) result.tmdbId = parsed;
    } else if (id?.startsWith('tvdb://')) {
      const parsed = parseInt(id.replace('tvdb://', ''), 10);
      if (!isNaN(parsed)) result.tvdbId = parsed;
    } else if (id?.startsWith('mbid://')) {
      result.musicBrainzId = id.replace('mbid://', '');
    }
  }

  return result;
}

function parseGenres(genre: Array<{ tag?: string }> | undefined): string[] | undefined {
  if (!Array.isArray(genre)) return undefined;
  const tags = genre.map((g) => g.tag).filter((t): t is string => !!t);
  return tags.length > 0 ? tags : undefined;
}

/**
 * Normalize video resolution string
 * Plex returns "4k", "1080", "720", "480", "sd"
 * Normalize to consistent format with 'p' suffix for numeric resolutions
 */
function normalizeVideoResolution(resolution: string | undefined): string | undefined {
  const normalized = normalizeResolutionLabel(resolution);
  return normalized ? normalized.toLowerCase() : undefined;
}

/**
 * Map Plex type to MediaLibraryItem mediaType
 */
function mapPlexTypeToMediaType(
  type: string
): 'movie' | 'show' | 'season' | 'episode' | 'artist' | 'album' | 'track' | 'photo' {
  const typeStr = type.toLowerCase();
  switch (typeStr) {
    case 'movie':
      return 'movie';
    case 'show':
      return 'show';
    case 'season':
      return 'season';
    case 'episode':
      return 'episode';
    case 'artist':
      return 'artist';
    case 'album':
      return 'album';
    case 'track':
      return 'track';
    case 'photo':
      return 'photo';
    default:
      return 'movie';
  }
}

/**
 * Parse a single library item from Plex API response
 */
function parseLibraryItem(item: Record<string, unknown>): MediaLibraryItem {
  const mediaArray = item.Media as Array<Record<string, unknown>> | undefined;
  const versions: MediaItemVersion[] = [];
  for (const [index, media] of (mediaArray ?? []).entries()) {
    if (media == null || typeof media !== 'object') continue;
    const parts = (media.Part as Array<Record<string, unknown>> | undefined) ?? [];
    let versionSize: number | undefined;
    for (const part of parts) {
      const size = parseOptionalNumber(part?.size);
      if (size != null) versionSize = (versionSize ?? 0) + size;
    }
    versions.push({
      // Media.id is always present in practice; the index form only guards
      // malformed payloads so a version is never silently dropped
      serverVersionKey: media.id != null ? String(media.id) : `idx:${index}`,
      videoResolution: normalizeVideoResolution(parseOptionalString(media.videoResolution)),
      videoDynamicRange:
        normalizeDynamicRange(parseOptionalString(media.videoDynamicRange)) ?? undefined,
      videoCodec: parseOptionalString(media.videoCodec)?.toUpperCase(),
      audioCodec: parseOptionalString(media.audioCodec)?.toUpperCase(),
      audioChannels: parseOptionalNumber(media.audioChannels),
      container: parseOptionalString(media.container)?.toLowerCase(),
      bitrate: parseOptionalNumber(media.bitrate),
      fileSize: versionSize,
      partCount: Math.max(parts.length, 1),
      filePath: parseOptionalString(parts[0]?.file),
    });
  }
  const bestVersion = pickBestVersion(versions);

  // Parse external IDs from Guid array (NOT main guid attribute)
  const guids = item.Guid as Array<{ id: string }> | undefined;
  const externalIds = parseExternalIds(guids);

  // Parse addedAt from Unix timestamp with validation
  // Reject dates before 2015 to prevent bad data like 1969/1970
  // Fallback chain: addedAt timestamp -> Jan 1 of year -> cutoff date
  const MIN_VALID_YEAR = 2015;
  const addedAtTimestamp = parseOptionalNumber(item.addedAt);
  const year = parseOptionalNumber(item.year);
  let addedAt: Date;
  // Fallback date for items with invalid/missing addedAt - use cutoff date instead of "today"
  // This clusters legacy items at the cutoff rather than polluting current date stats
  const FALLBACK_DATE = new Date(Date.UTC(MIN_VALID_YEAR, 0, 1));

  if (addedAtTimestamp) {
    const parsedDate = new Date(addedAtTimestamp * 1000);
    if (!isNaN(parsedDate.getTime()) && parsedDate.getFullYear() >= MIN_VALID_YEAR) {
      addedAt = parsedDate;
    } else {
      const yearDate = year && year >= MIN_VALID_YEAR ? new Date(Date.UTC(year, 0, 1)) : undefined;
      addedAt = yearDate && !isNaN(yearDate.getTime()) ? yearDate : FALLBACK_DATE;
    }
  } else {
    const yearDate = year && year >= MIN_VALID_YEAR ? new Date(Date.UTC(year, 0, 1)) : undefined;
    addedAt = yearDate && !isNaN(yearDate.getTime()) ? yearDate : FALLBACK_DATE;
  }

  const result: MediaLibraryItem = {
    ratingKey: parseString(item.ratingKey),
    title: parseString(item.title),
    mediaType: mapPlexTypeToMediaType(parseString(item.type)),
    year: parseOptionalNumber(item.year),
    addedAt,

    // Plex item modification timestamp (Unix seconds)
    updatedAt: (() => {
      const ts = parseOptionalNumber(item.updatedAt);
      if (!ts) return undefined;
      const d = new Date(ts * 1000);
      return isNaN(d.getTime()) ? undefined : d;
    })(),

    // Quality rollups over the version list. Media.videoDynamicRange is
    // Plex's own per-item HDR label ('SDR', 'HDR10', 'Dolby Vision', ...),
    // distinct from the color-attribute-derived deriveDynamicRange() used for
    // live session streams above.
    videoResolution: bestVersion?.videoResolution,
    videoDynamicRange: bestVersion?.videoDynamicRange,
    videoCodec: bestVersion?.videoCodec,
    audioCodec: bestVersion?.audioCodec,
    audioChannels: bestVersion?.audioChannels,
    fileSize: sumVersionSizes(versions),
    container: bestVersion?.container,
    versions,
    versionsFingerprint: computeVersionsFingerprint(versions),

    // External IDs
    ...externalIds,

    genres: parseGenres(item.Genre as Array<{ tag?: string }> | undefined),

    // File path (debug only)
    filePath: bestVersion?.filePath,

    // Poster thumbnail path (browsing UI)
    thumbPath: parseOptionalString(item.thumb),
  };

  // Hierarchy fields for episodes and tracks
  if (result.mediaType === 'episode' || result.mediaType === 'track') {
    result.grandparentTitle = parseOptionalString(item.grandparentTitle);
    result.grandparentRatingKey = parseOptionalString(item.grandparentRatingKey);
    result.parentTitle = parseOptionalString(item.parentTitle);
    result.parentRatingKey = parseOptionalString(item.parentRatingKey);
    result.itemIndex = parseOptionalNumber(item.index);
    if (result.mediaType === 'episode') {
      result.parentIndex = parseOptionalNumber(item.parentIndex); // season number
    }
  } else if (result.mediaType === 'season') {
    // For a season, parentRatingKey/parentTitle/parentIndex are the show's id/title/season number
    result.parentTitle = parseOptionalString(item.parentTitle);
    result.parentRatingKey = parseOptionalString(item.parentRatingKey);
    result.parentIndex = parseOptionalNumber(item.index);
  } else if (result.mediaType === 'album') {
    // For an album, parentRatingKey/parentTitle are its own parent: the artist
    result.parentTitle = parseOptionalString(item.parentTitle);
    result.parentRatingKey = parseOptionalString(item.parentRatingKey);
  }

  return result;
}

/**
 * Parse library items response from Plex /library/sections/{id}/all endpoint
 *
 * Handles all item types: Video (movies), Directory (shows), Track (music)
 * The MediaContainer may contain Metadata array with various item types.
 *
 * @param data - Raw response from Plex API
 * @returns Array of parsed MediaLibraryItem objects
 */
export function parseLibraryItemsResponse(data: unknown): MediaLibraryItem[] {
  const container = data as { MediaContainer?: { Metadata?: unknown[] } };
  const metadata = container?.MediaContainer?.Metadata;
  return parseArray(metadata, (item) => parseLibraryItem(item as Record<string, unknown>));
}

/** Full genre lists keyed by ratingKey, from a batched /library/metadata/{keys} response. */
export function parseGenresByRatingKey(data: unknown): Map<string, string[]> {
  const container = data as { MediaContainer?: { Metadata?: unknown[] } };
  const genres = new Map<string, string[]>();
  for (const raw of container?.MediaContainer?.Metadata ?? []) {
    const item = raw as Record<string, unknown>;
    const tags = parseGenres(item.Genre as Array<{ tag?: string }> | undefined);
    if (tags) genres.set(parseString(item.ratingKey), tags);
  }
  return genres;
}
