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
} from '../../../utils/parsing.js';
import { normalizeStreamDecisions } from '../../../utils/transcodeNormalizer.js';
import type { MediaSession, MediaUser, MediaLibrary, MediaWatchHistoryItem } from '../types.js';
import type {
  SourceVideoDetails,
  SourceAudioDetails,
  StreamVideoDetails,
  StreamAudioDetails,
  TranscodeInfo,
  SubtitleInfo,
} from '@tracearr/shared';
import { calculateProgress } from '../shared/parserUtils.js';
import { extractPlexLiveTvMetadata, extractPlexMusicMetadata } from './plexUtils.js';

// ============================================================================
// Raw Plex API Response Types (for internal use)
// ============================================================================

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
    if (parseString(stream.selected) === '1') {
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
  // Check for Dolby Vision via DOVI fields
  if (parseString(stream.DOVIPresent) === '1') {
    const profile = parseOptionalString(stream.DOVIProfile);
    if (profile) {
      return `Dolby Vision ${profile}`;
    }
    return 'Dolby Vision';
  }

  const colorSpace = parseOptionalString(stream.colorSpace);
  const bitDepth = parseOptionalNumber(stream.bitDepth);
  const colorTrc = parseOptionalString(stream.colorTrc);

  // Check for HDR10/HDR10+/HLG via color attributes
  if (colorSpace === 'bt2020' || (bitDepth && bitDepth >= 10)) {
    if (colorTrc === 'smpte2084') return 'HDR10';
    if (colorTrc === 'arib-std-b67') return 'HLG';
    if (colorSpace === 'bt2020') return 'HDR';
  }

  // Fallback: check extendedDisplayTitle for HDR keywords (Tautulli approach)
  const extendedDisplayTitle = parseOptionalString(stream.extendedDisplayTitle) ?? '';
  if (extendedDisplayTitle.includes('Dolby Vision') || extendedDisplayTitle.includes('DoVi')) {
    return 'Dolby Vision';
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

    const throttled = parseString(transcodeSession.throttled) === '1';
    if (throttled) info.throttled = true;
  }

  // Only return if we have any data
  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Extract stream video details (output after transcode)
 */
function extractStreamVideoDetails(
  transcodeSession: Record<string, unknown> | undefined,
  sourceVideoDetails: SourceVideoDetails
): { codec?: string; details: StreamVideoDetails } {
  if (!transcodeSession) {
    // Direct play - stream details match source
    return { details: {} };
  }

  const details: StreamVideoDetails = {};

  // Transcode output dimensions
  const width = parseOptionalNumber(transcodeSession.width);
  if (width) details.width = width;

  const height = parseOptionalNumber(transcodeSession.height);
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
  const selectedMedia = mediaArray?.find((m) => parseString(m.selected) === '1') ?? mediaArray?.[0];

  // Get the first Part (most media has single part)
  const parts = selectedMedia?.Part as Array<Record<string, unknown>> | undefined;
  const part = parts?.[0];

  // Find streams by type
  const videoStream = findStreamByType(part, STREAM_TYPE.VIDEO);
  const audioStream = findStreamByType(part, STREAM_TYPE.AUDIO);
  const subtitleStream = findStreamByType(part, STREAM_TYPE.SUBTITLE);

  const sourceVideo = extractSourceVideoDetails(videoStream, selectedMedia);
  const sourceAudio = extractSourceAudioDetails(audioStream);

  // Extract stream (output) details
  const streamVideo = extractStreamVideoDetails(transcodeSession, sourceVideo.details);
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
 */
export function parseSession(item: Record<string, unknown>): MediaSession {
  const player = (item.Player as Record<string, unknown>) ?? {};
  const user = (item.User as Record<string, unknown>) ?? {};
  const sessionInfo = (item.Session as Record<string, unknown>) ?? {};
  const transcodeSession = item.TranscodeSession as Record<string, unknown> | undefined;
  const mediaArray = item.Media as Array<Record<string, unknown>> | undefined;
  const firstMedia = mediaArray?.[0];

  const durationMs = parseNumber(item.duration);
  const positionMs = parseNumber(item.viewOffset);

  // Detect Live TV - Plex sets live='1' on the session
  const isLive = parseString(item.live) === '1';
  const mediaType = parseMediaType(item.type, isLive);

  // Get bitrate and resolution from the selected Media element
  // When multiple versions exist (e.g., 4K and 1080p), Plex marks the playing one with selected=1
  const bitrate = parseNumber(parseSelectedArrayElement(item.Media, 'bitrate'));
  const videoResolution = parseOptionalString(
    parseSelectedArrayElement(item.Media, 'videoResolution')
  );
  const videoWidth = parseOptionalNumber(parseSelectedArrayElement(item.Media, 'width'));
  const videoHeight = parseOptionalNumber(parseSelectedArrayElement(item.Media, 'height'));

  // Get stream decisions using the transcode normalizer
  const { videoDecision, audioDecision, isTranscode } = normalizeStreamDecisions(
    transcodeSession?.videoDecision as string | null,
    transcodeSession?.audioDecision as string | null
  );

  // Extract detailed stream metadata from Media[].Part[].Stream[]
  const streamDetails = extractStreamDetails(mediaArray, transcodeSession);

  const session: MediaSession = {
    sessionKey: parseString(item.sessionKey),
    mediaId: parseString(item.ratingKey),
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
      seasonNumber: parseNumber(item.parentIndex),
      episodeNumber: parseNumber(item.index),
      seasonName: parseOptionalString(item.parentTitle),
      showThumbPath: parseOptionalString(item.grandparentThumb),
    };
  }

  // Add Live TV metadata if this is a live stream
  if (mediaType === 'live') {
    const liveTvMetadata = extractPlexLiveTvMetadata(item, firstMedia);
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
 */
export function parseSessionsResponse(data: unknown): MediaSession[] {
  const container = data as { MediaContainer?: { Metadata?: unknown[] } };
  const metadata = container?.MediaContainer?.Metadata;
  return parseArray(metadata, (item) => parseSession(item as Record<string, unknown>));
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
