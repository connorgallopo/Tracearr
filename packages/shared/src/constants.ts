/**
 * Shared constants for Tracearr
 */

import { classifyByDimensions, type ResolutionLabel } from './resolution.js';

export { IDENTITY_AWARE_CONDITION_FIELDS } from './automations/conditions.js';

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
  RUN_FINISHED: 'run:finished',
  STATS_UPDATED: 'stats:updated',
  IMPORT_PROGRESS: 'import:progress',
  IMPORT_JELLYSTAT_PROGRESS: 'import:jellystat:progress',
  IMPORT_PLAYBACK_REPORTING_PROGRESS: 'import:playbackreporting:progress',
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
  SERVER_CONNECTION: 'server:connection',
  NOTIFICATION_TOAST: 'notification:toast',
  DESTINATIONS_CHANGED: 'destinations:changed',
  REQUESTS_CHANGED: 'requests:changed',
  SERVERS_CHANGED: 'servers:changed',
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
  /**
   * Pending session data (before DB write) - keyed by serverId + sessionKey.
   */
  PENDING_SESSION: (serverId: string, sessionKey: string) =>
    `${_redisPrefix}tracearr:sessions:pending:${serverId}:${sessionKey}`,
  /** Set of all pending session keys (serverId:sessionKey format) for enumeration */
  get PENDING_SESSION_IDS() {
    return `${_redisPrefix}tracearr:sessions:pending:ids`;
  },
  get DASHBOARD_STATS() {
    return `${_redisPrefix}tracearr:stats:dashboard`;
  },
  RATE_LIMIT_LOGIN: (ip: string) => `${_redisPrefix}tracearr:ratelimit:login:${ip}`,
  RATE_LIMIT_MOBILE_PAIR: (ip: string) => `${_redisPrefix}tracearr:ratelimit:mobile:pair:${ip}`,
  RATE_LIMIT_MOBILE_REFRESH: (ip: string) =>
    `${_redisPrefix}tracearr:ratelimit:mobile:refresh:${ip}`,
  SERVER_HEALTH: (serverId: string) => `${_redisPrefix}tracearr:servers:${serverId}:health`,
  SERVER_HEALTH_FAIL_COUNT: (serverId: string) =>
    `${_redisPrefix}tracearr:servers:${serverId}:health:fails`,
  SERVER_CONNECTION: (serverId: string) => `${_redisPrefix}tracearr:servers:${serverId}:connection`,
  SERVER_STATS_RESOURCES: (serverId: string) =>
    `${_redisPrefix}tracearr:servers:${serverId}:stats:resources`,
  SERVER_STATS_BANDWIDTH: (serverId: string) =>
    `${_redisPrefix}tracearr:servers:${serverId}:stats:bandwidth`,
  SERVER_STATS_SAMPLES: (serverId: string) =>
    `${_redisPrefix}tracearr:servers:${serverId}:stats:samples`,
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
  // Cooldown key to prevent hammering GitHub on restarts or retry storms
  get VERSION_CHECK_COOLDOWN() {
    return `${_redisPrefix}tracearr:version:check:cooldown`;
  },
  // Library statistics. The :v2 suffix marks the multi-version payload
  // change (version-summed sizes, overlapping buckets); old keys expire via
  // TTL. Bump again whenever a cached payload's meaning shifts.
  get LIBRARY_STATS() {
    return `${_redisPrefix}tracearr:library:stats:v2`;
  },
  get LIBRARY_GROWTH() {
    return `${_redisPrefix}tracearr:library:growth`;
  },
  get LIBRARY_QUALITY() {
    return `${_redisPrefix}tracearr:library:quality:v2`;
  },
  get LIBRARY_STALE() {
    return `${_redisPrefix}tracearr:library:stale:v2`;
  },
  get LIBRARY_DUPLICATES() {
    return `${_redisPrefix}tracearr:library:duplicates:v3`;
  },
  get LIBRARY_STORAGE() {
    return `${_redisPrefix}tracearr:library:storage:v3`;
  },
  get LIBRARY_WATCH() {
    return `${_redisPrefix}tracearr:library:watch:v2`;
  },
  get LIBRARY_ROI() {
    return `${_redisPrefix}tracearr:library:roi:v2`;
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
    return `${_redisPrefix}tracearr:library:codecs:v2`;
  },
  get LIBRARY_RESOLUTION() {
    return `${_redisPrefix}tracearr:library:resolution:v2`;
  },
  get LIBRARY_SHELVES() {
    return `${_redisPrefix}tracearr:library:shelves`;
  },
  get LIBRARY_GENRES() {
    return `${_redisPrefix}tracearr:library:genres`;
  },
  get LIBRARY_CATALOG_LETTERS() {
    return `${_redisPrefix}tracearr:library:catalog-letters:v2`;
  },
  get LIBRARY_LIBRARIES() {
    return `${_redisPrefix}tracearr:library:libraries`;
  },
  // Watched-filtered ordered candidate list shared by /catalog and
  // /catalog/letters (see getWatchedCandidates in catalog.ts)
  get LIBRARY_CATALOG_WATCHED() {
    return `${_redisPrefix}tracearr:library:catalog-watched:v2`;
  },
  // Catalog COUNT + total file size per filter set - O(catalog) to compute,
  // so it must never run once per scroll page
  get LIBRARY_CATALOG_TOTALS() {
    return `${_redisPrefix}tracearr:library:catalog-totals:v2`;
  },
  // Single-flight compute lock for a cold cache miss (see
  // withComputeSingleFlight in routes/library/utils.ts), shared by /shelves
  // and the catalog watched-candidates compute. cacheKey already carries the
  // prefix, so this only appends the lock segment.
  LIBRARY_SINGLE_FLIGHT_LOCK: (cacheKey: string) => `${cacheKey}:lock`,
  // Internal media detail responses (id/segment/scope composed by the caller);
  // distinct from PUBLIC_MEDIA_STATS, which backs the public API v2 namespace
  LIBRARY_MEDIA_DETAIL: (cacheKey: string) =>
    `${_redisPrefix}tracearr:library:media-detail:v2:${cacheKey}`,
  // Library sync state
  LIBRARY_SYNC_LAST: (serverId: string, libraryId: string) =>
    `${_redisPrefix}tracearr:library:sync:last:${serverId}:${libraryId}`,
  LIBRARY_SYNC_COUNT: (serverId: string, libraryId: string) =>
    `${_redisPrefix}tracearr:library:sync:count:${serverId}:${libraryId}`,
  // Timestamp of the last completed full scan - the periodic full-scan safety
  // net is time-based so event-sync bursts can't drag it forward
  LIBRARY_SYNC_FULL_SCAN_AT: (serverId: string, libraryId: string) =>
    `${_redisPrefix}tracearr:library:sync:fullscan:${serverId}:${libraryId}`,
  // Accepted structural shortfall from the last full scan - see COUNT_MISMATCH_* in librarySync.ts
  LIBRARY_SYNC_SHORTFALL: (serverId: string, libraryId: string) =>
    `${_redisPrefix}tracearr:library:sync:shortfall:${serverId}:${libraryId}`,
  // Image precache watermark state (per server, not per library - the precache
  // job walks library_items scoped only by server)
  LIBRARY_PRECACHE_WATERMARK: (serverId: string) =>
    `${_redisPrefix}tracearr:library:precache:watermark:${serverId}`,
  LIBRARY_PRECACHE_LAST_FULL: (serverId: string) =>
    `${_redisPrefix}tracearr:library:precache:last-full:${serverId}`,
  // Poster cache: one-time boot reconciliation marker, the last sweep's tally,
  // and the disk-limited flag the precache sets when the guard refused writes.
  IMAGE_CACHE_SCHEMA: `${_redisPrefix}tracearr:image-cache:schema`,
  IMAGE_CACHE_TALLY: `${_redisPrefix}tracearr:image-cache:tally`,
  IMAGE_CACHE_DISK_LIMITED: `${_redisPrefix}tracearr:image-cache:disk-limited`,
  // Auth tokens
  REFRESH_TOKEN: (hash: string) => `${_redisPrefix}tracearr:refresh:${hash}`,
  PLEX_TEMP_TOKEN: (token: string) => `${_redisPrefix}tracearr:plex_temp:${token}`,
  MOBILE_REFRESH_TOKEN: (hash: string) => `${_redisPrefix}tracearr:mobile_refresh:${hash}`,
  MOBILE_BLACKLISTED_TOKEN: (deviceId: string) =>
    `${_redisPrefix}tracearr:mobile:blacklist:${deviceId}`,
  MOBILE_LAST_SEEN: (deviceId: string) => `${_redisPrefix}tracearr:mobile:last_seen:${deviceId}`,
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
  TERMINATION_COOLDOWN_COMPOSITE: (
    serverId: string,
    serverUserId: string,
    deviceId: string,
    ratingKey: string
  ) =>
    `${_redisPrefix}termination:cooldown:composite:${serverId}:${serverUserId}:${deviceId}:${ratingKey}`,
  // Per-action cooldown on one target. The key string keeps its v1 shape so
  // cooldowns already armed in Redis stay honoured.
  ACTION_COOLDOWN: (automationId: string, targetId: string) =>
    `${_redisPrefix}tracearr:rule:cooldown:${automationId}:${targetId}`,
  // Automation-level cooldown, keyed on the run's subject
  AUTOMATION_COOLDOWN: (automationId: string, subjectKey: string) =>
    `${_redisPrefix}tracearr:automation:cooldown:${automationId}:${subjectKey}`,
  // Capped ring of evaluations that matched a trigger but recorded no run
  AUTOMATION_EVALS: (automationId: string) =>
    `${_redisPrefix}tracearr:automation:evals:${automationId}`,
  // Session write retry queue (for failed DB writes)
  SESSION_WRITE_RETRY: (sessionId: string) =>
    `${_redisPrefix}tracearr:session:write-retry:${sessionId}`,
  get SESSION_WRITE_RETRY_SET() {
    return `${_redisPrefix}tracearr:session:write-retry:pending`;
  },
  // Filter options caching
  FILTER_OPTIONS: (userId: string, scopeHash: string) =>
    `${_redisPrefix}tracearr:filter-options:${userId}:${scopeHash}`,
  // v1 segment invalidates cached entries if the GeoLocation shape ever changes
  PLEX_GEOIP: (ip: string) => `${_redisPrefix}tracearr:geoip:plex:v1:${ip}`,
  // Public API v2 per-media stats/watchers responses
  PUBLIC_MEDIA_STATS: (cacheKey: string) =>
    `${_redisPrefix}tracearr:public:media-stats:${cacheKey}`,
  // Ordered candidate list behind /watched-media. Its aggregate is O(the whole
  // cagg) and the keyset predicate reads MAX()/BOOL_OR(), so it can only run
  // after the group - paging it directly would re-aggregate everything per page.
  PUBLIC_WATCHED_MEDIA: (cacheKey: string) =>
    `${_redisPrefix}tracearr:public:watched-media:v1:${cacheKey}`,
};

// Cache TTLs in seconds
export const CACHE_TTL = {
  DASHBOARD_STATS: 60,
  PUBLIC_MEDIA_STATS: 60,
  // Must exceed several SSE reconciliation intervals (30s): paused Plex sessions emit no events,
  // and an expiring entry hides the session from the dashboard and from concurrent-stream limits.
  ACTIVE_SESSIONS: 150,
  PENDING_SESSIONS: 300, // 5 minutes - pending sessions need longer TTL for pause scenarios
  RATE_LIMIT: 900,
  SERVER_HEALTH: 600, // 10 minutes - servers marked unhealthy if no update
  SERVER_CONNECTION: 600, // 10 minutes - live runtime state, not persisted to DB
  // Live stats micro-cache: collapses concurrent dashboard viewers into one
  // Plex call per tick. Each stays under its endpoint's sample spacing so a
  // tick can't serve an entry that already missed a sample.
  SERVER_STATS_RESOURCES: 4,
  SERVER_STATS_BANDWIDTH: 1,
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
  LIBRARY_SHELVES: 300, // 5 minutes
  LIBRARY_GENRES: 3600, // 1 hour
  LIBRARY_CATALOG_LETTERS: 300, // 5 minutes, matches LIBRARY_SHELVES freshness
  LIBRARY_LIBRARIES: 300, // 5 minutes - library list changes only on sync
  LIBRARY_MEDIA_DETAIL: 60, // 1 minute, matches PUBLIC_MEDIA_STATS freshness
  MOBILE_LAST_SEEN: 300, // 5 minutes - throttle for device activity updates
  // Filter options (dropdown values change infrequently)
  FILTER_OPTIONS: 120, // 2 minutes
  PLEX_GEOIP: 86400,
  // Fail-open: short negative cache keeps a down plex.tv from being hit every poll tick
  PLEX_GEOIP_NEGATIVE: 600,
} as const;

// Notification event types (must match NotificationEventType in types.ts)
export const NOTIFICATION_EVENTS = {
  VIOLATION_DETECTED: 'violation_detected',
  STREAM_STARTED: 'stream_started',
  STREAM_STOPPED: 'stream_stopped',
  SERVER_DOWN: 'server_down',
  SERVER_UP: 'server_up',
  PLUGIN_UPDATE_AVAILABLE: 'plugin_update_available',
  SERVER_UPDATE_AVAILABLE: 'server_update_available',
  TRACEARR_UPDATE_AVAILABLE: 'tracearr_update_available',
  MEDIA_ADDED: 'media_added',
  MEDIA_UPGRADED: 'media_upgraded',
  NEW_DEVICE: 'new_device',
  TRUST_SCORE_CHANGED: 'trust_score_changed',
} as const;

/** The one size a poster is cached at. Every poster URL the server hands out uses it. */
export const POSTER_IMAGE_SIZE = { width: 360, height: 540 } as const;

// API version
/**
 * server_version_key of the placeholder version rows the multi-version
 * migration seeds from flat library_items columns. Never surfaced as a real
 * version and hard-deleted (not tombstoned) when observed versions replace it.
 */
export const LEGACY_VERSION_SENTINEL = 'legacy:1';

export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;
export const API_VERSION_V2 = 'v2';
export const API_V2_BASE_PATH = `/api/${API_VERSION_V2}`;

// JWT configuration
export const JWT_CONFIG = {
  ACCESS_TOKEN_EXPIRY: '48h',
  REFRESH_TOKEN_EXPIRY: '30d',
  ALGORITHM: 'HS256',
} as const;

// Polling intervals in milliseconds
export const POLLING_INTERVALS = {
  SESSIONS_ACTIVE: 3000,
  SESSIONS_IDLE: 10000,
  /** @deprecated Use SESSIONS_ACTIVE */
  SESSIONS: 7000,
  STATS_REFRESH: 60000,
  SERVER_HEALTH: 30000,
  // Reconciliation interval when SSE is active (fallback check)
  SSE_RECONCILIATION: 30 * 1000, // 30 seconds
} as const;

// Poller health detection
export const POLLER_CONFIG = {
  DOWN_THRESHOLD: 3, // consecutive poll failures before declaring server down
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

/** Base 1024, matching the byte formatter the dashboard renders file sizes with. */
export const BYTES_PER_GB = 1024 ** 3;

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

/** Fields that store distance values in metric (km) */
const DISTANCE_FIELDS = ['active_session_distance_km'] as const;

/** Fields that store speed values in metric (km/h) */
const SPEED_FIELDS = ['travel_speed_kmh'] as const;

/**
 * Convert a condition field value for display based on user's unit preference.
 *
 * @param value - The value to convert
 * @param field - The condition field name
 * @param unitSystem - User's preferred unit system
 * @returns Object with displayValue (rounded) and unit label
 */
export function formatConditionFieldValue(
  value: number,
  field: string,
  unitSystem: UnitSystem
): { displayValue: number; unit: string } {
  const isDistanceField = (DISTANCE_FIELDS as readonly string[]).includes(field);
  const isSpeedField = (SPEED_FIELDS as readonly string[]).includes(field);

  if (isDistanceField) {
    return {
      displayValue: Math.round(fromMetricDistance(value, unitSystem)),
      unit: getDistanceUnit(unitSystem),
    };
  }

  if (isSpeedField) {
    return {
      displayValue: Math.round(fromMetricDistance(value, unitSystem)),
      unit: getSpeedUnit(unitSystem),
    };
  }

  return { displayValue: value, unit: '' };
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

export type { ResolutionLabel };

/**
 * Get video resolution label from width and height. Thin re-export of the
 * shared dimension ladder in resolution.ts - kept here so existing imports
 * of `getResolutionLabel` from `@tracearr/shared` keep working.
 *
 * @param width - Video width in pixels
 * @param height - Video height in pixels
 * @returns Resolution label: "8K", "4K", "1440p", "1080p", "720p", "480p", "SD", or null
 *
 * @example
 * getResolutionLabel(7680, 4320) // "8K"
 * getResolutionLabel(3840, 2160) // "4K"
 * getResolutionLabel(2560, 1440) // "1440p"
 * getResolutionLabel(1920, 1080) // "1080p"
 * getResolutionLabel(1920, 800)  // "1080p" (widescreen - width indicates quality)
 * getResolutionLabel(1440, 1080) // "1080p" (4:3 - height indicates quality)
 * getResolutionLabel(1280, 720)  // "720p"
 * getResolutionLabel(null, 1080) // "1080p" (fallback to height)
 */
export const getResolutionLabel = classifyByDimensions;

/**
 * Format video resolution with dimensions and label for display.
 *
 * @param width - Video width in pixels
 * @param height - Video height in pixels
 * @returns Formatted string like "1920×1080 (1080p)" or "—" if unknown
 *
 * @example
 * formatResolutionDisplay(1920, 1080) // "1920×1080 (1080p)"
 * formatResolutionDisplay(1440, 1080) // "1440×1080 (1080p)" - 4:3 correctly labeled
 * formatResolutionDisplay(1920, 800)  // "1920×800 (1080p)" - cinemascope correctly labeled
 * formatResolutionDisplay(null, 1080) // "1080p (1080p)"
 * formatResolutionDisplay(null, null) // "—"
 */
export function formatResolutionDisplay(
  width: number | null | undefined,
  height: number | null | undefined
): string {
  const label = getResolutionLabel(width, height);
  if (!label) return '—';

  if (width && height) return `${width}×${height} (${label})`;
  if (width) return `${width}w (${label})`;
  if (height) return `${height}p (${label})`;
  return '—';
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

// Server color palette (40-60% HSL lightness, visible on both dark and light backgrounds)
export const SERVER_COLOR_PALETTE = [
  { hex: '#F4A825', label: 'Gold' }, // Plex brand
  { hex: '#895FDD', label: 'Purple' }, // Jellyfin brand
  { hex: '#39C668', label: 'Green' }, // Emby brand
  { hex: '#3B82F6', label: 'Blue' },
  { hex: '#EF4444', label: 'Red' },
  { hex: '#14B8A6', label: 'Teal' },
] as const;

export const SERVER_TYPE_BRAND_COLORS: Record<string, string> = {
  plex: '#F4A825',
  jellyfin: '#895FDD',
  emby: '#39C668',
};

/** Pick best color for a server given its type and colors already used by other servers */
export function pickServerColor(type: string, usedColors: (string | null | undefined)[]): string {
  const used = new Set(usedColors.filter(Boolean).map((c) => c!.toLowerCase()));
  const brand = SERVER_TYPE_BRAND_COLORS[type] ?? '#3B82F6';
  if (!used.has(brand.toLowerCase())) return brand;
  for (const preset of SERVER_COLOR_PALETTE) {
    if (!used.has(preset.hex.toLowerCase())) return preset.hex;
  }
  return brand; // all taken, duplicate is fine
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
// Used with Plex's undocumented /statistics/resources endpoint.
//
// Plex samples every 5s, not the 6 its per-point `timespan` field implies.
// The timer free-runs and drifts, so timestamps land on no fixed grid.
export const SERVER_STATS_CONFIG = {
  // Granularity enum, not seconds (days=3, hours=4, seconds=6).
  // Resources answers only 6; bandwidth also answers 0-4 for rollups.
  TIMESPAN_PARAM: 6,
  POLL_INTERVAL_SECONDS: 5,
  WINDOW_SECONDS: 120,
  // Charts hold their right edge this far behind real time so the newest
  // region is always populated. Sized to the slowest source, the 6s plugin.
  NOW_DELAY_SECONDS: 6,
  // Memory cap, not a window - charts bound themselves by time
  MAX_POINTS: 32,
  // Break the line rather than bridge dead air: 3 Plex samples, 2 plugin ones
  GAP_BREAK_SECONDS: 15,
} as const;

/**
 * How far back live-stats points are kept: the visible window, plus the delay
 * the chart holds its right edge by, plus slack. Retaining only the window
 * drops points while they are still inside the left wall.
 */
export function liveStatsRetentionSeconds(windowSeconds: number): number {
  return windowSeconds + SERVER_STATS_CONFIG.NOW_DELAY_SECONDS + 10;
}

// Plex-only; Jellyfin and Emby expose no server-wide byte counter.
// Rows are per-second and sparse - an absent second moved no bytes, so a
// point count is not a time window.
export const BANDWIDTH_STATS_CONFIG = {
  TIMESPAN_PARAM: 6,
  WINDOW_SECONDS: 120,
  MAX_POINTS: 150,
} as const;

// Sentinel returned by the merge API when combining server users on the same
// server needs an explicit confirmation flag before proceeding
export const MERGE_SAME_SERVER_CONFIRMATION_REQUIRED = 'same_server_combine_requires_confirmation';

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

/**
 * Session write retry configuration.
 * Used when DB writes fail during session stop.
 */
export const SESSION_WRITE_RETRY = {
  /** Number of immediate retries before queueing */
  IMMEDIATE_RETRIES: 3,
  /** Base delay for exponential backoff (ms) */
  IMMEDIATE_BACKOFF_MS: 50,
  /** Maximum total attempts before giving up */
  MAX_TOTAL_ATTEMPTS: 5,
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
