/**
 * Test fixtures and factory functions for creating test data
 */

import type {
  Session,
  ActiveSession,
  User,
  ServerUser,
  Violation,
  AuthUser,
  UserRole,
  SourceVideoDetails,
  SourceAudioDetails,
  TranscodeInfo,
  SubtitleInfo,
} from '@tracearr/shared';
import { DEFAULT_STREAM_DETAILS } from '@tracearr/shared';
import { randomUUID } from 'node:crypto';

/**
 * Create a mock session with sensible defaults
 */
export function createMockSession(overrides: Partial<Session> = {}): Session {
  const id = overrides.id ?? randomUUID();
  const serverUserId = overrides.serverUserId ?? randomUUID();
  const serverId = overrides.serverId ?? randomUUID();

  return {
    id,
    serverId,
    serverUserId,
    sessionKey: `session_${Date.now()}_${id.slice(0, 8)}`,
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: null,
    serverVersionKey: null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    mediaId: null,
    showMediaId: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    externalSessionId: null,
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 0,
    // Pause tracking
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    // Network/device info
    ipAddress: '192.168.1.1',
    geoCity: 'New York',
    geoRegion: 'New York',
    geoCountry: 'US',
    geoContinent: 'North America',
    geoPostal: '10001',
    geoLat: 40.7128,
    geoLon: -74.006,
    geoAsnNumber: 7922,
    geoAsnOrganization: 'Comcast Cable Communications, LLC',
    isLocal: false,
    profileName: null,
    playerName: 'Test Player',
    deviceId: `device_${id.slice(0, 8)}`,
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Windows',
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 10000,
    // Stream details (all null by default - use spread)
    ...DEFAULT_STREAM_DETAILS,
    // Live TV specific fields
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    // Music track fields
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    ...overrides,
  };
}

/**
 * Create a mock active session with user and server info
 * ActiveSession extends Session with user/server objects for API responses
 */
export function createMockActiveSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  const id = overrides.id ?? randomUUID();
  const serverId = overrides.serverId ?? randomUUID();
  const serverUserId = overrides.serverUserId ?? randomUUID();

  return {
    id,
    serverId,
    serverUserId,
    sessionKey: overrides.sessionKey ?? `session_${Date.now()}_${id.slice(0, 8)}`,
    state: overrides.state ?? 'playing',
    mediaType: overrides.mediaType ?? 'movie',
    mediaTitle: overrides.mediaTitle ?? 'Test Movie',
    grandparentTitle: overrides.grandparentTitle ?? null,
    seasonNumber: overrides.seasonNumber ?? null,
    episodeNumber: overrides.episodeNumber ?? null,
    year: overrides.year ?? 2024,
    thumbPath: overrides.thumbPath ?? '/library/metadata/123/thumb',
    ratingKey: overrides.ratingKey ?? 'media-123',
    serverVersionKey: overrides.serverVersionKey ?? null,
    parentRatingKey: overrides.parentRatingKey ?? null,
    grandparentRatingKey: overrides.grandparentRatingKey ?? null,
    mediaId: overrides.mediaId ?? null,
    showMediaId: overrides.showMediaId ?? null,
    imdbId: overrides.imdbId ?? null,
    tmdbId: overrides.tmdbId ?? null,
    tvdbId: overrides.tvdbId ?? null,
    externalSessionId: overrides.externalSessionId ?? null,
    startedAt: overrides.startedAt ?? new Date(),
    stoppedAt: overrides.stoppedAt ?? null,
    durationMs: overrides.durationMs ?? 0,
    totalDurationMs: overrides.totalDurationMs ?? 7200000,
    progressMs: overrides.progressMs ?? 0,
    lastPausedAt: overrides.lastPausedAt ?? null,
    pausedDurationMs: overrides.pausedDurationMs ?? 0,
    referenceId: overrides.referenceId ?? null,
    watched: overrides.watched ?? false,
    ipAddress: overrides.ipAddress ?? '192.168.1.100',
    geoCity: overrides.geoCity ?? 'New York',
    geoRegion: overrides.geoRegion ?? 'NY',
    geoCountry: overrides.geoCountry ?? 'US',
    geoContinent: overrides.geoContinent ?? 'North America',
    geoPostal: overrides.geoPostal ?? '10001',
    geoLat: overrides.geoLat ?? 40.7128,
    geoLon: overrides.geoLon ?? -74.006,
    geoAsnNumber: overrides.geoAsnNumber ?? 7922,
    geoAsnOrganization: overrides.geoAsnOrganization ?? 'Comcast Cable Communications, LLC',
    isLocal: false,
    profileName: overrides.profileName ?? null,
    playerName: overrides.playerName ?? 'Chrome',
    deviceId: overrides.deviceId ?? `device_${id.slice(0, 8)}`,
    product: overrides.product ?? 'Plex Web',
    device: overrides.device ?? 'Chrome',
    platform: overrides.platform ?? 'Chrome',
    quality: overrides.quality ?? '1080p',
    isTranscode: overrides.isTranscode ?? false,
    videoDecision: overrides.videoDecision ?? 'directplay',
    audioDecision: overrides.audioDecision ?? 'directplay',
    bitrate: overrides.bitrate ?? 20000,
    // Stream details (spread defaults then override)
    ...DEFAULT_STREAM_DETAILS,
    // Live TV specific fields
    channelTitle: overrides.channelTitle ?? null,
    channelIdentifier: overrides.channelIdentifier ?? null,
    channelThumb: overrides.channelThumb ?? null,
    // Music track fields
    artistName: overrides.artistName ?? null,
    albumName: overrides.albumName ?? null,
    trackNumber: overrides.trackNumber ?? null,
    discNumber: overrides.discNumber ?? null,
    // User and server info (extends Session -> ActiveSession)
    user: overrides.user ?? {
      id: serverUserId,
      username: 'testuser',
      thumbUrl: null,
      identityName: null,
    },
    server: overrides.server ?? {
      id: serverId,
      name: 'Test Server',
      type: 'plex',
    },
    // Default to true for test sessions (most tests expect termination to work)
    canTerminate: overrides.canTerminate ?? true,
    // Apply overrides last to allow stream detail overrides
    ...overrides,
  };
}

// ============================================================================
// Realistic Stream Detail Fixtures (for testing media metadata tracking)
// ============================================================================

/** Realistic HDR10 4K source video details */
export const HDR10_SOURCE_VIDEO: SourceVideoDetails = {
  bitrate: 25000,
  framerate: '23.976',
  dynamicRange: 'HDR10',
  aspectRatio: 2.39,
  profile: 'main 10',
  level: '5.1',
  colorSpace: 'bt2020nc',
  colorDepth: 10,
};

/** Realistic Dolby Vision source video details */
export const DOLBY_VISION_SOURCE_VIDEO: SourceVideoDetails = {
  bitrate: 30000,
  framerate: '23.976',
  dynamicRange: 'Dolby Vision P7',
  aspectRatio: 2.39,
  profile: 'main 10',
  level: '5.1',
  colorSpace: 'bt2020nc',
  colorDepth: 10,
};

/** Realistic SDR 1080p source video details */
export const SDR_SOURCE_VIDEO: SourceVideoDetails = {
  bitrate: 8000,
  framerate: '23.976',
  dynamicRange: 'SDR',
  aspectRatio: 1.78,
  profile: 'high',
  level: '4.1',
  colorSpace: 'bt709',
  colorDepth: 8,
};

/** Realistic Atmos audio details */
export const ATMOS_SOURCE_AUDIO: SourceAudioDetails = {
  bitrate: 768,
  channelLayout: '7.1',
  language: 'eng',
  sampleRate: 48000,
};

/** Realistic 5.1 audio details */
export const SURROUND_51_SOURCE_AUDIO: SourceAudioDetails = {
  bitrate: 640,
  channelLayout: '5.1',
  language: 'eng',
  sampleRate: 48000,
};

/** Realistic stereo audio details */
export const STEREO_SOURCE_AUDIO: SourceAudioDetails = {
  bitrate: 256,
  channelLayout: '2.0',
  language: 'eng',
  sampleRate: 44100,
};

/** Realistic transcode info with hardware acceleration */
export const HW_TRANSCODE_INFO: TranscodeInfo = {
  containerDecision: 'transcode',
  sourceContainer: 'mkv',
  streamContainer: 'mp4',
  hwRequested: true,
  hwDecoding: 'HEVC',
  hwEncoding: 'H264',
  speed: 8.5,
  throttled: false,
};

/** Realistic software transcode info */
export const SW_TRANSCODE_INFO: TranscodeInfo = {
  containerDecision: 'transcode',
  sourceContainer: 'mkv',
  streamContainer: 'mp4',
  hwRequested: false,
  speed: 1.2,
  throttled: true,
};

/** Realistic subtitle info */
export const BURN_IN_SUBTITLE_INFO: SubtitleInfo = {
  decision: 'burn',
  codec: 'ass',
  language: 'eng',
  forced: false,
};

/**
 * Create a session with HDR content (4K Dolby Vision or HDR10)
 */
export function createHDRSession(
  variant: 'dolby-vision' | 'hdr10' = 'hdr10',
  overrides: Partial<Session> = {}
): Session {
  const sourceVideo = variant === 'dolby-vision' ? DOLBY_VISION_SOURCE_VIDEO : HDR10_SOURCE_VIDEO;

  return createMockSession({
    quality: '4K',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: sourceVideo.bitrate ?? 25000,
    sourceVideoCodec: 'HEVC',
    sourceAudioCodec: 'TRUEHD',
    sourceAudioChannels: 8,
    sourceVideoWidth: 3840,
    sourceVideoHeight: 2160,
    sourceVideoDetails: sourceVideo,
    sourceAudioDetails: ATMOS_SOURCE_AUDIO,
    streamVideoCodec: 'HEVC',
    streamAudioCodec: 'TRUEHD',
    streamVideoDetails: {
      bitrate: sourceVideo.bitrate,
      width: 3840,
      height: 2160,
      framerate: sourceVideo.framerate,
      dynamicRange: sourceVideo.dynamicRange,
    },
    streamAudioDetails: {
      bitrate: ATMOS_SOURCE_AUDIO.bitrate,
      channels: 8,
      language: 'eng',
    },
    ...overrides,
  });
}

/**
 * Create a session with active transcoding
 */
export function createTranscodeSession(
  variant: 'hardware' | 'software' = 'hardware',
  overrides: Partial<Session> = {}
): Session {
  const transcodeInfo = variant === 'hardware' ? HW_TRANSCODE_INFO : SW_TRANSCODE_INFO;

  return createMockSession({
    quality: '1080p',
    isTranscode: true,
    videoDecision: 'transcode',
    audioDecision: 'copy',
    bitrate: 8000,
    // Source: 4K HEVC
    sourceVideoCodec: 'HEVC',
    sourceAudioCodec: 'EAC3',
    sourceAudioChannels: 6,
    sourceVideoWidth: 3840,
    sourceVideoHeight: 2160,
    sourceVideoDetails: HDR10_SOURCE_VIDEO,
    sourceAudioDetails: SURROUND_51_SOURCE_AUDIO,
    // Stream: 1080p H264 (transcoded)
    streamVideoCodec: 'H264',
    streamAudioCodec: 'EAC3',
    streamVideoDetails: {
      bitrate: 8000,
      width: 1920,
      height: 1080,
      framerate: '23.976',
      dynamicRange: 'SDR', // Tone-mapped
    },
    streamAudioDetails: {
      bitrate: 640,
      channels: 6,
      language: 'eng',
    },
    transcodeInfo,
    ...overrides,
  });
}

/**
 * Create a direct play session (no transcoding)
 */
export function createDirectPlaySession(overrides: Partial<Session> = {}): Session {
  return createMockSession({
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 10000,
    sourceVideoCodec: 'H264',
    sourceAudioCodec: 'AAC',
    sourceAudioChannels: 2,
    sourceVideoWidth: 1920,
    sourceVideoHeight: 1080,
    sourceVideoDetails: SDR_SOURCE_VIDEO,
    sourceAudioDetails: STEREO_SOURCE_AUDIO,
    // Stream matches source for direct play
    streamVideoCodec: 'H264',
    streamAudioCodec: 'AAC',
    streamVideoDetails: {
      bitrate: 8000,
      width: 1920,
      height: 1080,
      framerate: '23.976',
      dynamicRange: 'SDR',
    },
    streamAudioDetails: {
      bitrate: 256,
      channels: 2,
      language: 'eng',
    },
    ...overrides,
  });
}

/**
 * Create a session with burn-in subtitles (forces transcode)
 */
export function createSubtitleBurnSession(overrides: Partial<Session> = {}): Session {
  return createMockSession({
    quality: '1080p',
    isTranscode: true,
    videoDecision: 'transcode',
    audioDecision: 'directplay',
    bitrate: 8000,
    sourceVideoCodec: 'H264',
    sourceAudioCodec: 'AAC',
    sourceAudioChannels: 2,
    sourceVideoWidth: 1920,
    sourceVideoHeight: 1080,
    sourceVideoDetails: SDR_SOURCE_VIDEO,
    sourceAudioDetails: STEREO_SOURCE_AUDIO,
    streamVideoCodec: 'H264',
    streamAudioCodec: 'AAC',
    streamVideoDetails: {
      bitrate: 8000,
      width: 1920,
      height: 1080,
      framerate: '23.976',
      dynamicRange: 'SDR',
    },
    streamAudioDetails: {
      bitrate: 256,
      channels: 2,
      language: 'eng',
    },
    subtitleInfo: BURN_IN_SUBTITLE_INFO,
    transcodeInfo: {
      ...SW_TRANSCODE_INFO,
      speed: 3.5, // Subtitle burn is faster than full transcode
    },
    ...overrides,
  });
}

/**
 * Create a mock user (identity layer)
 */
export function createMockUser(overrides: Partial<User> & { role?: UserRole } = {}): User {
  const id = overrides.id ?? randomUUID();

  return {
    id,
    username: overrides.username ?? `testuser_${id.slice(0, 8)}`,
    name: overrides.name ?? null,
    thumbnail: overrides.thumbnail ?? null,
    email: overrides.email ?? null,
    role: overrides.role ?? 'member',
    loginAccess: overrides.loginAccess ?? 'default',
    lastLoginAt: overrides.lastLoginAt ?? null,
    loginCount: overrides.loginCount ?? 0,
    aggregateTrustScore: overrides.aggregateTrustScore ?? 100,
    totalViolations: overrides.totalViolations ?? 0,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

/**
 * Create a mock server user (account on a specific media server)
 */
export function createMockServerUser(overrides: Partial<ServerUser> = {}): ServerUser {
  const id = overrides.id ?? randomUUID();

  return {
    id,
    userId: overrides.userId ?? randomUUID(),
    serverId: overrides.serverId ?? randomUUID(),
    externalId: overrides.externalId ?? `ext_${id.slice(0, 8)}`,
    username: overrides.username ?? `serveruser_${id.slice(0, 8)}`,
    email: overrides.email ?? null,
    thumbUrl: overrides.thumbUrl ?? null,
    isServerAdmin: overrides.isServerAdmin ?? false,
    trustScore: overrides.trustScore ?? 100,
    joinedAt: overrides.joinedAt ?? null,
    lastActivityAt: overrides.lastActivityAt ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    removedAt: overrides.removedAt ?? null,
    identityName: overrides.identityName ?? null,
  };
}

/**
 * Create a mock violation
 */
export function createMockViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    id: overrides.id ?? randomUUID(),
    ruleId: overrides.ruleId ?? randomUUID(),
    serverUserId: overrides.serverUserId ?? randomUUID(),
    sessionId: overrides.sessionId ?? randomUUID(),
    severity: overrides.severity ?? 'warning',
    data: overrides.data ?? {},
    createdAt: overrides.createdAt ?? new Date(),
    acknowledgedAt: overrides.acknowledgedAt ?? null,
  };
}

/**
 * Create a mock auth user for request authentication
 */
export function createMockAuthUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: overrides.userId ?? randomUUID(),
    username: overrides.username ?? 'testuser',
    role: overrides.role ?? 'owner',
    serverIds: overrides.serverIds ?? [randomUUID()],
  };
}
