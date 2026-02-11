/**
 * Shared constants for Tracearr
 */

// Rule type definitions with default parameters
export const RULE_DEFAULTS = {
  impossible_travel: {
    maxSpeedKmh: 500,
    ignoreVpnRanges: false,
    excludePrivateIps: false,
  },
  simultaneous_locations: {
    minDistanceKm: 100,
    excludePrivateIps: false,
  },
  device_velocity: {
    maxIps: 5,
    windowHours: 24,
    excludePrivateIps: false,
    groupByDevice: false,
  },
  concurrent_streams: {
    maxStreams: 3,
    excludePrivateIps: false,
  },
  geo_restriction: {
    mode: 'blocklist',
    countries: [],
    excludePrivateIps: false,
  },
  account_inactivity: {
    inactivityValue: 30,
    inactivityUnit: 'days',
  },
} as const;

// Rule type display names
export const RULE_DISPLAY_NAMES = {
  impossible_travel: 'Impossible Travel',
  simultaneous_locations: 'Simultaneous Locations',
  device_velocity: 'Device Velocity',
  concurrent_streams: 'Concurrent Streams',
  geo_restriction: 'Geo Restriction',
  account_inactivity: 'Account Inactivity',
} as const;

// Severity levels
export const SEVERITY_LEVELS = {
  low: { label: 'Low', priority: 1 },
  warning: { label: 'Warning', priority: 2 },
  high: { label: 'High', priority: 3 },
} as const;

// Type for severity priority numbers (1=low, 2=warning, 3=high)
export type SeverityPriority = 1 | 2 | 3;

// Helper to get severity priority from string
export function getSeverityPriority(severity: keyof typeof SEVERITY_LEVELS): SeverityPriority {
  return SEVERITY_LEVELS[severity]?.priority ?? 1;
}

// WebSocket event names
export const WS_EVENTS = {
  SESSION_STARTED: 'session:started',
  SESSION_STOPPED: 'session:stopped',
  SESSION_UPDATED: 'session:updated',
  VIOLATION_NEW: 'violation:new',
  STATS_UPDATED: 'stats:updated',
  IMPORT_PROGRESS: 'import:progress',
  IMPORT_JELLYSTAT_PROGRESS: 'import:jellystat:progress',
  MAINTENANCE_PROGRESS: 'maintenance:progress',
  /** Library sync progress updates */
  LIBRARY_SYNC_PROGRESS: 'library:sync:progress',
  /** Unified running tasks updates */
  TASKS_UPDATED: 'tasks:updated',
  SUBSCRIBE_SESSIONS: 'subscribe:sessions',
  UNSUBSCRIBE_SESSIONS: 'unsubscribe:sessions',
  VERSION_UPDATE: 'version:update',
  SERVER_DOWN: 'server:down',
  SERVER_UP: 'server:up',
} as const;

// Redis key prefix (set at startup via setRedisPrefix)
let _redisPrefix = '';

/**
 * Set the global prefix prepended to all Redis keys.
 * Call this at server startup before any Redis operations.
 * @param prefix - Prefix string (e.g. 'myapp:')
 */
export function setRedisPrefix(prefix: string) {
  _redisPrefix = prefix;
}

/**
 * Get the current Redis key prefix.
 */
export function getRedisPrefix(): string {
  return _redisPrefix;
}

// Redis key definitions (prefix-aware via getters)
export const REDIS_KEYS = {
  // Active sessions: SET of session IDs for atomic add/remove
  get ACTIVE_SESSION_IDS() {
    return `${_redisPrefix}tracearr:sessions:active:ids`;
  },
  // Legacy: JSON array of sessions (deprecated, kept for migration)
  get ACTIVE_SESSIONS() {
    return `${_redisPrefix}tracearr:sessions:active`;
  },
  // Individual session data
  SESSION_BY_ID: (id: string) => `${_redisPrefix}tracearr:sessions:${id}`,
  USER_SESSIONS: (userId: string) => `${_redisPrefix}tracearr:users:${userId}:sessions`,
  get DASHBOARD_STATS() {
    return `${_redisPrefix}tracearr:stats:dashboard`;
  },
  RATE_LIMIT_LOGIN: (ip: string) => `${_redisPrefix}tracearr:ratelimit:login:${ip}`,
  RATE_LIMIT_MOBILE_PAIR: (ip: string) => `${_redisPrefix}tracearr:ratelimit:mobile:pair:${ip}`,
  RATE_LIMIT_MOBILE_REFRESH: (ip: string) =>
    `${_redisPrefix}tracearr:ratelimit:mobile:refresh:${ip}`,
  SERVER_HEALTH: (serverId: string) => `${_redisPrefix}tracearr:servers:${serverId}:health`,
  get PUBSUB_EVENTS() {
    return `${_redisPrefix}tracearr:events`;
  },
  // Notification rate limiting (sliding window counters)
  PUSH_RATE_MINUTE: (sessionId: string) => `${_redisPrefix}tracearr:push:rate:minute:${sessionId}`,
  PUSH_RATE_HOUR: (sessionId: string) => `${_redisPrefix}tracearr:push:rate:hour:${sessionId}`,
  // Location stats filter caching (includes serverIds hash for proper scoping)
  LOCATION_FILTERS: (userId: string, serverIds: string[]) => {
    // Sort and hash serverIds for stable cache key
    const serverHash = serverIds.length > 0 ? serverIds.slice().sort().join(',') : 'all';
    return `${_redisPrefix}tracearr:filters:locations:${userId}:${serverHash}`;
  },
  // Version check cache
  get VERSION_LATEST() {
    return `${_redisPrefix}tracearr:version:latest`;
  },
  // Library statistics
  get LIBRARY_STATS() {
    return `${_redisPrefix}tracearr:library:stats`;
  },
  get LIBRARY_GROWTH() {
    return `${_redisPrefix}tracearr:library:growth`;
  },
  get LIBRARY_QUALITY() {
    return `${_redisPrefix}tracearr:library:quality`;
  },
  get LIBRARY_STALE() {
    return `${_redisPrefix}tracearr:library:stale`;
  },
  get LIBRARY_DUPLICATES() {
    return `${_redisPrefix}tracearr:library:duplicates`;
  },
  get LIBRARY_STORAGE() {
    return `${_redisPrefix}tracearr:library:storage`;
  },
  get LIBRARY_WATCH() {
    return `${_redisPrefix}tracearr:library:watch`;
  },
  get LIBRARY_ROI() {
    return `${_redisPrefix}tracearr:library:roi`;
  },
  get LIBRARY_PATTERNS() {
    return `${_redisPrefix}tracearr:library:patterns`;
  },
  get LIBRARY_COMPLETION() {
    return `${_redisPrefix}tracearr:library:completion`;
  },
  get LIBRARY_TOP_MOVIES() {
    return `${_redisPrefix}tracearr:library:top-movies`;
  },
  get LIBRARY_TOP_SHOWS() {
    return `${_redisPrefix}tracearr:library:top-shows`;
  },
  get LIBRARY_CODECS() {
    return `${_redisPrefix}tracearr:library:codecs`;
  },
  get LIBRARY_RESOLUTION() {
    return `${_redisPrefix}tracearr:library:resolution`;
  },
  // Auth tokens
  REFRESH_TOKEN: (hash: string) => `${_redisPrefix}tracearr:refresh:${hash}`,
  PLEX_TEMP_TOKEN: (token: string) => `${_redisPrefix}tracearr:plex_temp:${token}`,
  MOBILE_REFRESH_TOKEN: (hash: string) => `${_redisPrefix}tracearr:mobile_refresh:${hash}`,
  // Rate limiting
  MOBILE_TOKEN_GEN_RATE: (userId: string) => `${_redisPrefix}mobile_token_gen:${userId}`,
  // Distributed locks
  get HEAVY_OPS_LOCK() {
    return `${_redisPrefix}tracearr:heavy-ops:lock`;
  },
  SESSION_LOCK: (serverId: string, sessionKey: string) =>
    `${_redisPrefix}session:lock:${serverId}:${sessionKey}`,
  TERMINATION_COOLDOWN: (serverId: string, sessionKey: string, ratingKey: string) =>
    `${_redisPrefix}termination:cooldown:${serverId}:${sessionKey}:${ratingKey}`,
  // Rule cooldowns
  RULE_COOLDOWN: (ruleId: string, targetId: string) =>
    `${_redisPrefix}tracearr:rule:cooldown:${ruleId}:${targetId}`,
};

// Cache TTLs in seconds
export const CACHE_TTL = {
  DASHBOARD_STATS: 60,
  ACTIVE_SESSIONS: 300,
  USER_SESSIONS: 3600,
  RATE_LIMIT: 900,
  SERVER_HEALTH: 600, // 10 minutes - servers marked unhealthy if no update
  LOCATION_FILTERS: 300, // 5 minutes - filter options change infrequently
  VERSION_CHECK: 21600, // 6 hours - version check interval
  // Library statistics
  LIBRARY_STATS: 300, // 5 minutes
  LIBRARY_GROWTH: 300, // 5 minutes
  LIBRARY_QUALITY: 300, // 5 minutes
  LIBRARY_STALE: 3600, // 1 hour (changes slowly)
  LIBRARY_DUPLICATES: 3600, // 1 hour (changes slowly)
  LIBRARY_STORAGE: 300, // 5 minutes
  LIBRARY_WATCH: 300, // 5 minutes
  LIBRARY_ROI: 3600, // 1 hour (ROI changes slowly)
  LIBRARY_PATTERNS: 3600, // 1 hour (patterns change slowly)
  LIBRARY_COMPLETION: 300, // 5 minutes
  LIBRARY_TOP_MOVIES: 300, // 5 minutes
  LIBRARY_TOP_SHOWS: 300, // 5 minutes
  LIBRARY_CODECS: 300, // 5 minutes
  LIBRARY_RESOLUTION: 300, // 5 minutes
} as const;

// Notification event types (must match NotificationEventType in types.ts)
export const NOTIFICATION_EVENTS = {
  VIOLATION_DETECTED: 'violation_detected',
  STREAM_STARTED: 'stream_started',
  STREAM_STOPPED: 'stream_stopped',
  CONCURRENT_STREAMS: 'concurrent_streams',
  NEW_DEVICE: 'new_device',
  TRUST_SCORE_CHANGED: 'trust_score_changed',
  SERVER_DOWN: 'server_down',
  SERVER_UP: 'server_up',
} as const;

// API version
export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;

// JWT configuration
export const JWT_CONFIG = {
  ACCESS_TOKEN_EXPIRY: '48h',
  REFRESH_TOKEN_EXPIRY: '30d',
  ALGORITHM: 'HS256',
} as const;

// Polling intervals in milliseconds
export const POLLING_INTERVALS = {
  SESSIONS: 7000,
  STATS_REFRESH: 60000,
  SERVER_HEALTH: 30000,
  // Reconciliation interval when SSE is active (fallback check)
  SSE_RECONCILIATION: 30 * 1000, // 30 seconds
} as const;

// SSE (Server-Sent Events) configuration
export const SSE_CONFIG = {
  // Reconnection settings
  INITIAL_RETRY_DELAY_MS: 1000,
  MAX_RETRY_DELAY_MS: 30000,
  RETRY_MULTIPLIER: 2,
  MAX_RETRIES: 10,
  // Heartbeat/keepalive - how long without events before assuming connection died
  // Plex sends ping events every 10 seconds, so 30s = miss 3 pings = dead
  HEARTBEAT_TIMEOUT_MS: 30000, // 30 seconds
  // When to fall back to polling
  FALLBACK_THRESHOLD: 5, // consecutive failures before fallback
} as const;

// Plex SSE notification types (from /:/eventsource/notifications)
export const PLEX_SSE_EVENTS = {
  // Session-related
  PLAYING: 'playing',
  PROGRESS: 'progress',
  STOPPED: 'stopped',
  PAUSED: 'paused',
  RESUMED: 'resumed',
  // Library updates
  LIBRARY_UPDATE: 'library.update',
  LIBRARY_SCAN: 'library.scan',
  // Server status
  SERVER_BACKUP: 'server.backup',
  SERVER_UPDATE: 'server.update',
  // Activity
  ACTIVITY: 'activity',
  // Transcoder
  TRANSCODE_SESSION_UPDATE: 'transcodeSession.update',
  TRANSCODE_SESSION_END: 'transcodeSession.end',
} as const;

// SSE connection states
export const SSE_STATE = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  FALLBACK: 'fallback', // Using polling as fallback
} as const;

// Pagination defaults
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
} as const;

// GeoIP configuration
export const GEOIP_CONFIG = {
  EARTH_RADIUS_KM: 6371,
  DEFAULT_UNKNOWN_LOCATION: 'Unknown',
} as const;

// Unit conversion constants
export const UNIT_CONVERSION = {
  KM_TO_MILES: 0.621371,
  MILES_TO_KM: 1.60934,
} as const;

// Unit system types and utilities
export type UnitSystem = 'metric' | 'imperial';

/**
 * Convert kilometers to miles
 */
export function kmToMiles(km: number): number {
  return km * UNIT_CONVERSION.KM_TO_MILES;
}

/**
 * Convert miles to kilometers
 */
export function milesToKm(miles: number): number {
  return miles * UNIT_CONVERSION.MILES_TO_KM;
}

/**
 * Format distance based on unit system
 * @param km - Distance in kilometers (internal unit)
 * @param unitSystem - User's preferred unit system
 * @param decimals - Number of decimal places (default: 0)
 */
export function formatDistance(km: number, unitSystem: UnitSystem, decimals = 0): string {
  if (unitSystem === 'imperial') {
    const miles = kmToMiles(km);
    return `${miles.toFixed(decimals)} mi`;
  }
  return `${km.toFixed(decimals)} km`;
}

/**
 * Format speed based on unit system
 * @param kmh - Speed in km/h (internal unit)
 * @param unitSystem - User's preferred unit system
 * @param decimals - Number of decimal places (default: 0)
 */
export function formatSpeed(kmh: number, unitSystem: UnitSystem, decimals = 0): string {
  if (unitSystem === 'imperial') {
    const mph = kmToMiles(kmh);
    return `${mph.toFixed(decimals)} mph`;
  }
  return `${kmh.toFixed(decimals)} km/h`;
}

/**
 * Get distance unit label
 */
export function getDistanceUnit(unitSystem: UnitSystem): string {
  return unitSystem === 'imperial' ? 'mi' : 'km';
}

/**
 * Get speed unit label
 */
export function getSpeedUnit(unitSystem: UnitSystem): string {
  return unitSystem === 'imperial' ? 'mph' : 'km/h';
}

/**
 * Convert display value to internal metric value (for form inputs)
 * @param value - Value in user's preferred unit
 * @param unitSystem - User's preferred unit system
 * @returns Value in kilometers (internal unit)
 */
export function toMetricDistance(value: number, unitSystem: UnitSystem): number {
  if (unitSystem === 'imperial') {
    return milesToKm(value);
  }
  return value;
}

/**
 * Convert internal metric value to display value (for form inputs)
 * @param km - Value in kilometers (internal unit)
 * @param unitSystem - User's preferred unit system
 * @returns Value in user's preferred unit
 */
export function fromMetricDistance(km: number, unitSystem: UnitSystem): number {
  if (unitSystem === 'imperial') {
    return kmToMiles(km);
  }
  return km;
}

/**
 * Format bitrate for display with appropriate unit (kbps, Mbps, Gbps)
 * @param kbps - Bitrate in kilobits per second
 * @returns Formatted string with unit (e.g., "20.5 Mbps", "800 kbps")
 */
export function formatBitrate(kbps: number | null | undefined): string {
  if (!kbps) return '—';
  if (kbps >= 1_000_000) {
    // Gbps
    const gbps = kbps / 1_000_000;
    const formatted = gbps % 1 === 0 ? gbps.toFixed(0) : gbps.toFixed(1);
    return `${formatted} Gbps`;
  }
  if (kbps >= 1000) {
    // Mbps
    const mbps = kbps / 1000;
    const formatted = mbps % 1 === 0 ? mbps.toFixed(0) : mbps.toFixed(1);
    return `${formatted} Mbps`;
  }
  // kbps
  return `${kbps} kbps`;
}

/**
 * Display names for video/audio tech strings (resolution, codecs, dynamic range).
 * Keys are lowercase, values are proper display casing.
 */
const MEDIA_TECH_DISPLAY: Record<string, string> = {
  // Resolution
  '4k': '4K',
  '2k': '2K',
  uhd: 'UHD',
  sd: 'SD',
  hd: 'HD',
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p',
  // Dynamic range
  sdr: 'SDR',
  hdr: 'HDR',
  hdr10: 'HDR10',
  'hdr10+': 'HDR10+',
  hlg: 'HLG',
  'dolby vision': 'Dolby Vision',
  dv: 'DV',
  // Video codecs
  hevc: 'HEVC',
  h265: 'HEVC',
  x265: 'HEVC',
  h264: 'H.264',
  avc: 'H.264',
  x264: 'H.264',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  'mpeg-4': 'MPEG-4',
  mpeg4: 'MPEG-4',
  'mpeg-2': 'MPEG-2',
  mpeg2: 'MPEG-2',
  mpeg2video: 'MPEG-2',
  'mpeg-1': 'MPEG-1',
  mpeg1: 'MPEG-1',
  'vc-1': 'VC-1',
  vc1: 'VC-1',
  wmv: 'WMV',
  theora: 'Theora',
  prores: 'ProRes',
  dnxhd: 'DNxHD',
  // Audio codecs
  aac: 'AAC',
  ac3: 'AC3',
  'ac-3': 'AC3',
  eac3: 'EAC3',
  'e-ac-3': 'EAC3',
  truehd: 'TrueHD',
  atmos: 'Atmos',
  dts: 'DTS',
  dca: 'DTS',
  'dts-hd': 'DTS-HD',
  'dts-hd ma': 'DTS-HD MA',
  'dca-ma': 'DTS-HD MA',
  'dts-hd hra': 'DTS-HD HRA',
  'dts:x': 'DTS:X',
  dtsx: 'DTS:X',
  flac: 'FLAC',
  alac: 'ALAC',
  mp2: 'MP2',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  pcm: 'PCM',
  lpcm: 'PCM',
  pcm_s16le: 'PCM',
  pcm_s24le: 'PCM',
  pcm_s32le: 'PCM',
  aiff: 'AIFF',
  wav: 'WAV',
  wma: 'WMA',
  wmav2: 'WMA',
  wmapro: 'WMA Pro',
  // Container formats
  mkv: 'MKV',
  matroska: 'MKV',
  mp4: 'MP4',
  avi: 'AVI',
  mov: 'MOV',
  webm: 'WebM',
  flv: 'FLV',
  ts: 'TS',
  m2ts: 'M2TS',
  mpegts: 'MPEG-TS',
  // Subtitle formats
  srt: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  pgs: 'PGS',
  vobsub: 'VobSub',
  dvdsub: 'DVD Sub',
  webvtt: 'WebVTT',
  vtt: 'VTT',
  eia_608: 'EIA-608',
  cc: 'CC',
};

/**
 * Format a media tech string (resolution, codec, dynamic range) for display.
 * Uses a lookup map for known values, falls back to uppercase for unknown.
 *
 * @param value - Tech string (e.g., "4k", "hevc", "truehd", "dolby vision")
 * @returns Formatted string with proper casing
 *
 * @example
 * formatMediaTech("4k")           // "4K"
 * formatMediaTech("hevc")         // "HEVC"
 * formatMediaTech("truehd")       // "TrueHD"
 * formatMediaTech("dolby vision") // "Dolby Vision"
 */
export function formatMediaTech(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  const lower = value.toLowerCase().trim();
  return MEDIA_TECH_DISPLAY[lower] ?? value.toUpperCase();
}

/**
 * Get video resolution label from width and height.
 * Uses width-first logic to correctly classify widescreen/cinemascope content
 * (e.g., 1920x800 = 1080p, not 720p based on height alone).
 *
 * @param width - Video width in pixels
 * @param height - Video height in pixels
 * @returns Resolution label: "4K", "1080p", "720p", "480p", "SD", or null if unknown
 *
 * @example
 * getResolutionLabel(3840, 2160) // "4K"
 * getResolutionLabel(1920, 1080) // "1080p"
 * getResolutionLabel(1920, 800)  // "1080p" (cinemascope)
 * getResolutionLabel(1280, 720)  // "720p"
 * getResolutionLabel(null, 1080) // "1080p" (fallback to height)
 */
export function getResolutionLabel(
  width: number | null | undefined,
  height: number | null | undefined
): string | null {
  // Prefer width-based classification (industry standard)
  if (width) {
    if (width >= 3840) return '4K';
    if (width >= 1920) return '1080p';
    if (width >= 1280) return '720p';
    if (width >= 854) return '480p';
    return 'SD';
  }
  // Fallback to height when width unavailable
  if (height) {
    if (height >= 2160) return '4K';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    return 'SD';
  }
  return null;
}

/**
 * Format audio channels for display.
 *
 * @param channels - Number of audio channels
 * @returns Formatted string: "7.1", "5.1", "Stereo", "Mono", or "Nch"
 *
 * @example
 * formatAudioChannels(8) // "7.1"
 * formatAudioChannels(6) // "5.1"
 * formatAudioChannels(2) // "Stereo"
 * formatAudioChannels(1) // "Mono"
 */
export function formatAudioChannels(channels: number | null | undefined): string | null {
  if (!channels) return null;
  if (channels === 8) return '7.1';
  if (channels === 6) return '5.1';
  if (channels === 2) return 'Stereo';
  if (channels === 1) return 'Mono';
  return `${channels}ch`;
}

// Time constants in milliseconds (avoid magic numbers)
export const TIME_MS = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
} as const;

// Server resource statistics configuration (CPU, RAM)
// Used with Plex's undocumented /statistics/resources endpoint
export const SERVER_STATS_CONFIG = {
  // Poll interval in seconds (how often we fetch new data)
  POLL_INTERVAL_SECONDS: 6,
  // Timespan parameter for Plex API (MUST be 6 - other values return empty!)
  TIMESPAN_SECONDS: 6,
  // Fixed 2-minute window (20 data points at 6s intervals)
  WINDOW_SECONDS: 120,
  // Data points to display (2 min / 6s = 20 points)
  DATA_POINTS: 20,
} as const;

// Session limits
export const SESSION_LIMITS = {
  MAX_RECENT_PER_USER: 100,
  RESUME_WINDOW_HOURS: 24,
  // Watch completion threshold - 85% is industry standard
  WATCH_COMPLETION_THRESHOLD: 0.85,
  // Stale session timeout - force stop after 5 minutes of no updates
  STALE_SESSION_TIMEOUT_SECONDS: 300,
  // Minimum play time to record session - filter short plays (2 minutes default)
  MIN_PLAY_TIME_MS: 120 * 1000,
  // Continued session threshold - max gap to consider a "resume" vs new watch
  CONTINUED_SESSION_THRESHOLD_MS: 60 * 1000,
  // Stale session sweep interval - how often to check for stale sessions (1 minute)
  STALE_SWEEP_INTERVAL_MS: 60 * 1000,
} as const;

// ============================================================================
// Timezone Utilities
// ============================================================================

/**
 * Get the client's IANA timezone identifier.
 * Works in both browser and React Native environments.
 *
 * @returns IANA timezone string (e.g., 'America/Los_Angeles') or 'UTC' as fallback
 */
export function getClientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * Validate an IANA timezone identifier.
 *
 * @param tz - Timezone string to validate
 * @returns true if valid IANA timezone, false otherwise
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
