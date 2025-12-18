/**
 * Core type definitions for Tracearr
 */

// User role - combined permission level and account status
// Can log in: owner, admin, viewer
// Cannot log in: member (default for synced users), disabled, pending
export type UserRole = 'owner' | 'admin' | 'viewer' | 'member' | 'disabled' | 'pending';

// Role permission hierarchy (higher = more permissions)
export const ROLE_PERMISSIONS: Record<UserRole, number> = {
  owner: 4,
  admin: 3,
  viewer: 2,
  member: 1, // Synced from media server, no Tracearr login until promoted
  disabled: 0,
  pending: 0,
} as const;

// Roles that can log into Tracearr
const LOGIN_ROLES: UserRole[] = ['owner', 'admin', 'viewer'];

// Role helper functions
export const canLogin = (role: UserRole): boolean => LOGIN_ROLES.includes(role);

export const hasMinRole = (userRole: UserRole, required: 'owner' | 'admin' | 'viewer'): boolean =>
  ROLE_PERMISSIONS[userRole] >= ROLE_PERMISSIONS[required];

export const isOwner = (role: UserRole): boolean => role === 'owner';
export const isActive = (role: UserRole): boolean => canLogin(role);

// Server types
export type ServerType = 'plex' | 'jellyfin' | 'emby';

export interface Server {
  id: string;
  name: string;
  type: ServerType;
  url: string;
  createdAt: Date;
  updatedAt: Date;
}

// User types - Identity layer (the real human)
export interface User {
  id: string;
  username: string; // Login identifier (unique)
  name: string | null; // Display name (optional)
  thumbnail: string | null;
  email: string | null;
  role: UserRole; // Combined permission level and account status
  aggregateTrustScore: number;
  totalViolations: number;
  createdAt: Date;
  updatedAt: Date;
}

// Server User types - Account on a specific media server
export interface ServerUser {
  id: string;
  userId: string;
  serverId: string;
  externalId: string;
  username: string;
  email: string | null;
  thumbUrl: string | null;
  isServerAdmin: boolean;
  trustScore: number;
  sessionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// Server User with identity info - returned by /users API endpoints
export interface ServerUserWithIdentity extends ServerUser {
  serverName: string;
  identityName: string | null;
  role: UserRole; // From linked User identity
}

// Server User detail with stats - returned by GET /users/:id
export interface ServerUserDetail extends ServerUserWithIdentity {
  stats: {
    totalSessions: number;
    totalWatchTime: number;
  };
}

// Violation summary for embedded responses (simpler than ViolationWithDetails)
export interface ViolationSummary {
  id: string;
  ruleId: string;
  rule: {
    name: string;
    type: string;
  };
  serverUserId: string;
  sessionId: string;
  mediaTitle: string | null;
  severity: string;
  data: Record<string, unknown>;
  createdAt: Date;
  acknowledgedAt: Date | null;
}

// Full user detail with all related data - returned by GET /users/:id/full
// This aggregate response reduces 6 API calls to 1 for the UserDetail page
export interface ServerUserFullDetail {
  user: ServerUserDetail;
  sessions: {
    data: Session[];
    total: number;
    hasMore: boolean;
  };
  locations: UserLocation[];
  devices: UserDevice[];
  violations: {
    data: ViolationSummary[];
    total: number;
    hasMore: boolean;
  };
  terminations: {
    data: TerminationLogWithDetails[];
    total: number;
    hasMore: boolean;
  };
}

export interface AuthUser {
  userId: string;
  username: string;
  role: UserRole;
  serverIds: string[];
  mobile?: boolean; // True for mobile app tokens
  deviceId?: string; // Device identifier for mobile tokens
}

// Session types
export type SessionState = 'playing' | 'paused' | 'stopped';
export type MediaType = 'movie' | 'episode' | 'track';

export interface Session {
  id: string;
  serverId: string;
  serverUserId: string;
  sessionKey: string;
  state: SessionState;
  mediaType: MediaType;
  mediaTitle: string;
  // Enhanced media metadata for episodes
  grandparentTitle: string | null; // Show name (for episodes)
  seasonNumber: number | null; // Season number (for episodes)
  episodeNumber: number | null; // Episode number (for episodes)
  year: number | null; // Release year
  thumbPath: string | null; // Poster path (e.g., /library/metadata/123/thumb)
  ratingKey: string | null; // Plex/Jellyfin media identifier
  externalSessionId: string | null; // External reference for deduplication
  startedAt: Date;
  stoppedAt: Date | null;
  durationMs: number | null; // Actual watch duration (excludes paused time)
  totalDurationMs: number | null; // Total media length
  progressMs: number | null; // Current playback position
  // Pause tracking - accumulates total paused time across pause/resume cycles
  lastPausedAt: Date | null; // When current pause started (null if not paused)
  pausedDurationMs: number; // Accumulated pause time in milliseconds
  // Session grouping for "resume where left off" tracking
  referenceId: string | null; // Links to first session in resume chain
  watched: boolean; // True if user watched 80%+ of content
  // Network and device info
  ipAddress: string;
  geoCity: string | null;
  geoRegion: string | null; // State/province/subdivision
  geoCountry: string | null;
  geoLat: number | null;
  geoLon: number | null;
  playerName: string | null; // Friendly device name
  deviceId: string | null; // Unique device identifier (machineIdentifier)
  product: string | null; // Product/app name (e.g., "Plex for iOS")
  device: string | null; // Device type (e.g., "iPhone")
  platform: string | null;
  quality: string | null;
  isTranscode: boolean;
  videoDecision: string | null; // 'directplay' | 'copy' | 'transcode'
  audioDecision: string | null; // 'directplay' | 'copy' | 'transcode'
  bitrate: number | null;
}

export interface ActiveSession extends Session {
  user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl'> & { identityName: string | null };
  server: Pick<Server, 'id' | 'name' | 'type'>;
}

// Session with user/server details (from paginated API)
// When returned from history queries, sessions are grouped by reference_id
// Note: The single session endpoint (GET /sessions/:id) returns totalDurationMs,
// while paginated list queries aggregate duration and don't include it.
export interface SessionWithDetails extends Omit<Session, 'ratingKey' | 'externalSessionId'> {
  user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl'> & { identityName: string | null };
  server: Pick<Server, 'id' | 'name' | 'type'>;
  // Number of pause/resume segments in this grouped play (1 = no pauses)
  segmentCount?: number;
}

// Rule types
export type RuleType =
  | 'impossible_travel'
  | 'simultaneous_locations'
  | 'device_velocity'
  | 'concurrent_streams'
  | 'geo_restriction';

export interface ImpossibleTravelParams {
  maxSpeedKmh: number;
  ignoreVpnRanges?: boolean;
}

export interface SimultaneousLocationsParams {
  minDistanceKm: number;
}

export interface DeviceVelocityParams {
  maxIps: number;
  windowHours: number;
}

export interface ConcurrentStreamsParams {
  maxStreams: number;
}

export type GeoRestrictionMode = 'blocklist' | 'allowlist';

export interface GeoRestrictionParams {
  mode: GeoRestrictionMode;
  countries: string[];
}

export type RuleParams =
  | ImpossibleTravelParams
  | SimultaneousLocationsParams
  | DeviceVelocityParams
  | ConcurrentStreamsParams
  | GeoRestrictionParams;

export interface Rule {
  id: string;
  name: string;
  type: RuleType;
  params: RuleParams;
  serverUserId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Violation types
export type ViolationSeverity = 'low' | 'warning' | 'high';

export interface Violation {
  id: string;
  ruleId: string;
  serverUserId: string;
  sessionId: string;
  severity: ViolationSeverity;
  data: Record<string, unknown>;
  createdAt: Date;
  acknowledgedAt: Date | null;
}

// Session info for violations (used in both session and relatedSessions)
export interface ViolationSessionInfo {
  id: string;
  mediaTitle: string;
  mediaType: MediaType;
  grandparentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  year: number | null;
  ipAddress: string;
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
  geoLat: number | null;
  geoLon: number | null;
  playerName: string | null;
  device: string | null;
  deviceId: string | null;
  platform: string | null;
  product: string | null;
  quality: string | null;
  startedAt: Date;
}

export interface ViolationWithDetails extends Violation {
  rule: Pick<Rule, 'id' | 'name' | 'type'>;
  user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl' | 'serverId'> & {
    identityName: string | null;
  };
  server?: Pick<Server, 'id' | 'name' | 'type'>;
  session?: ViolationSessionInfo;
  relatedSessions?: ViolationSessionInfo[];
  userHistory?: {
    previousIPs: string[];
    previousDevices: string[];
    previousLocations: Array<{ city: string | null; country: string | null; ip: string }>;
  };
}

// Stats types
export interface DashboardStats {
  activeStreams: number;
  todayPlays: number;
  watchTimeHours: number;
  alertsLast24h: number;
  activeUsersToday: number;
}

export interface PlayStats {
  date: string;
  count: number;
}

export interface UserStats {
  serverUserId: string;
  username: string;
  thumbUrl: string | null;
  playCount: number;
  watchTimeHours: number;
}

export interface LocationUserInfo {
  id: string;
  username: string;
  thumbUrl: string | null;
}

export interface LocationStats {
  city: string | null;
  region: string | null; // State/province
  country: string | null;
  lat: number;
  lon: number;
  count: number;
  lastActivity?: Date;
  firstActivity?: Date;
  // Contextual data - populated based on filters
  users?: LocationUserInfo[]; // Top users at this location (when not filtering by userId)
  deviceCount?: number; // Unique devices from this location
}

export interface LocationStatsSummary {
  totalStreams: number;
  uniqueLocations: number;
  topCity: string | null;
}

export interface LocationFilterOptions {
  users: { id: string; username: string; identityName: string | null }[];
  servers: { id: string; name: string }[];
  mediaTypes: ('movie' | 'episode' | 'track')[];
}

export interface LocationStatsResponse {
  data: LocationStats[];
  summary: LocationStatsSummary;
  availableFilters: LocationFilterOptions;
}

export interface LibraryStats {
  movies: number;
  shows: number;
  episodes: number;
  tracks: number;
}

export interface DayOfWeekStats {
  day: number; // 0 = Sunday, 6 = Saturday
  name: string; // 'Sun', 'Mon', etc.
  count: number;
}

export interface HourOfDayStats {
  hour: number; // 0-23
  count: number;
}

export interface QualityStats {
  directPlay: number;
  transcode: number;
  total: number;
  directPlayPercent: number;
  transcodePercent: number;
}

export interface TopUserStats {
  serverUserId: string;
  username: string;
  identityName: string | null;
  thumbUrl: string | null;
  serverId: string | null;
  trustScore: number;
  playCount: number;
  watchTimeHours: number;
  topMediaType: string | null; // "movie", "episode", etc.
  topContent: string | null; // Most watched show/movie name
}

export interface TopContentStats {
  title: string;
  type: string;
  showTitle: string | null; // For episodes, this is the show name
  year: number | null;
  playCount: number;
  watchTimeHours: number;
  thumbPath: string | null;
  serverId: string | null;
  ratingKey: string | null;
}

export interface PlatformStats {
  platform: string | null;
  count: number;
}

// Server resource statistics (CPU, RAM)
// From Plex's undocumented /statistics/resources endpoint
export interface ServerResourceDataPoint {
  /** Unix timestamp */
  at: number;
  /** Timespan interval in seconds */
  timespan: number;
  /** System-wide CPU utilization percentage */
  hostCpuUtilization: number;
  /** Plex process CPU utilization percentage */
  processCpuUtilization: number;
  /** System-wide memory utilization percentage */
  hostMemoryUtilization: number;
  /** Plex process memory utilization percentage */
  processMemoryUtilization: number;
}

export interface ServerResourceStats {
  /** Server ID these stats belong to */
  serverId: string;
  /** Data points (newest first based on 'at' timestamp) */
  data: ServerResourceDataPoint[];
  /** When this data was fetched */
  fetchedAt: Date;
}

// Webhook format types
export type WebhookFormat = 'json' | 'ntfy' | 'apprise';

// Unit system for display preferences (stored in settings)
export type UnitSystem = 'metric' | 'imperial';

// Settings types
export interface Settings {
  allowGuestAccess: boolean;
  // Display preferences
  unitSystem: UnitSystem;
  discordWebhookUrl: string | null;
  customWebhookUrl: string | null;
  webhookFormat: WebhookFormat | null;
  ntfyTopic: string | null;
  ntfyAuthToken: string | null;
  // Poller settings
  pollerEnabled: boolean;
  pollerIntervalMs: number;
  // Tautulli integration
  tautulliUrl: string | null;
  tautulliApiKey: string | null;
  // Network/access settings
  externalUrl: string | null;
  basePath: string;
  trustProxy: boolean;
  // Mobile access
  mobileEnabled: boolean;
  // Authentication settings
  primaryAuthMethod: 'jellyfin' | 'local';
}

// Tautulli import types
export interface TautulliImportProgress {
  status: 'idle' | 'fetching' | 'processing' | 'complete' | 'error';
  /** Expected total from API (may differ from actual if API count is stale) */
  totalRecords: number;
  /** Actual records fetched from API so far */
  fetchedRecords: number;
  /** Records processed (looped through) */
  processedRecords: number;
  /** New sessions inserted */
  importedRecords: number;
  /** Existing sessions updated with new data */
  updatedRecords: number;
  /** Total skipped (sum of duplicate + unknownUser + activeSession) */
  skippedRecords: number;
  /** Skipped: already exists in DB or duplicate in this import */
  duplicateRecords: number;
  /** Skipped: user not found in Tracearr (need to sync server first) */
  unknownUserRecords: number;
  /** Skipped: in-progress sessions without reference_id */
  activeSessionRecords: number;
  /** Records that failed to process */
  errorRecords: number;
  currentPage: number;
  totalPages: number;
  message: string;
}

export interface TautulliImportResult {
  success: boolean;
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  message: string;
  /** Details about users that were skipped (not found in Tracearr) */
  skippedUsers?: {
    tautulliUserId: number;
    username: string;
    recordCount: number;
  }[];
}

// WebSocket event types
export interface ServerToClientEvents {
  'session:started': (session: ActiveSession) => void;
  'session:stopped': (sessionId: string) => void;
  'session:updated': (session: ActiveSession) => void;
  'violation:new': (violation: ViolationWithDetails) => void;
  'stats:updated': (stats: DashboardStats) => void;
  'import:progress': (progress: TautulliImportProgress) => void;
  'version:update': (data: { current: string; latest: string; releaseUrl: string }) => void;
}

export interface ClientToServerEvents {
  'subscribe:sessions': () => void;
  'unsubscribe:sessions': () => void;
}

// User location aggregation (derived from sessions)
export interface UserLocation {
  city: string | null;
  region: string | null; // State/province/subdivision
  country: string | null;
  lat: number | null;
  lon: number | null;
  sessionCount: number;
  lastSeenAt: Date;
  ipAddresses: string[];
}

// Device location summary (where a device has been used from)
export interface DeviceLocation {
  city: string | null;
  region: string | null;
  country: string | null;
  sessionCount: number;
  lastSeenAt: Date;
}

// User device aggregation (derived from sessions)
export interface UserDevice {
  deviceId: string | null;
  playerName: string | null;
  product: string | null;
  device: string | null;
  platform: string | null;
  sessionCount: number;
  lastSeenAt: Date;
  locations: DeviceLocation[]; // Where this device has been used from
}

// API response types
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// =============================================================================
// History Page Types
// =============================================================================

/**
 * Aggregate stats returned with history query results.
 * These are computed across the entire filtered result set (not just current page).
 */
export interface HistoryAggregates {
  /** Total watch time in milliseconds across all matching sessions */
  totalWatchTimeMs: number;
  /** Count of unique plays (grouped by reference_id) */
  playCount: number;
  /** Count of unique users in the result set */
  uniqueUsers: number;
  /** Count of unique content items watched */
  uniqueContent: number;
}

/**
 * Response shape for history/sessions queries with cursor-based pagination.
 * Supports infinite scroll patterns with aggregate stats.
 */
export interface HistorySessionResponse {
  data: SessionWithDetails[];
  /** Aggregate stats for the entire filtered result set */
  aggregates: HistoryAggregates;
  /** Total count of matching plays */
  total: number;
  /** Cursor for fetching the next page (undefined if no more results) */
  nextCursor?: string;
  /** Whether more results exist beyond the current page */
  hasMore: boolean;
}

/**
 * Option item with count for filter dropdowns.
 * Count represents number of plays with this value.
 */
export interface FilterOptionItem {
  value: string;
  count: number;
}

/**
 * User option for user filter dropdown.
 */
export interface UserFilterOption {
  id: string;
  username: string;
  thumbUrl: string | null;
  identityName: string | null;
}

/**
 * Available filter options for the history page.
 * Returned by GET /sessions/filter-options to populate dropdowns.
 */
export interface HistoryFilterOptions {
  /** Available platforms (Windows, macOS, iOS, etc.) */
  platforms: FilterOptionItem[];
  /** Available products/apps (Plex for Windows, etc.) */
  products: FilterOptionItem[];
  /** Available device types (iPhone, Android TV, etc.) */
  devices: FilterOptionItem[];
  /** Available countries */
  countries: FilterOptionItem[];
  /** Available cities */
  cities: FilterOptionItem[];
  /** Available users (with avatar info) */
  users: UserFilterOption[];
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
}

// ============================================
// Mobile App Types
// ============================================

// Mobile pairing token (one-time use)
export interface MobileToken {
  id: string;
  expiresAt: Date;
  createdAt: Date;
  usedAt: Date | null;
}

// Mobile pairing token response (when generating new token)
export interface MobilePairTokenResponse {
  token: string;
  expiresAt: Date;
}

// Mobile session (paired device)
export interface MobileSession {
  id: string;
  deviceName: string;
  deviceId: string;
  platform: 'ios' | 'android';
  expoPushToken: string | null;
  lastSeenAt: Date;
  createdAt: Date;
}

// Mobile config returned to web dashboard
export interface MobileConfig {
  isEnabled: boolean;
  sessions: MobileSession[];
  serverName: string;
  pendingTokens: number; // Count of unexpired, unused tokens
  maxDevices: number; // Maximum allowed devices (5)
}

// Mobile pairing request (from mobile app)
export interface MobilePairRequest {
  token: string; // Mobile access token from QR/manual entry
  deviceName: string; // e.g., "iPhone 15 Pro"
  deviceId: string; // Unique device identifier
  platform: 'ios' | 'android';
}

// Mobile pairing response
export interface MobilePairResponse {
  accessToken: string;
  refreshToken: string;
  server: {
    id: string;
    name: string;
    type: 'plex' | 'jellyfin' | 'emby';
  };
  user: {
    userId: string;
    username: string;
    role: 'owner'; // Mobile access is owner-only for v1
  };
}

// QR code payload (base64 encoded in tracearr://pair?data=<base64>)
export interface MobileQRPayload {
  url: string; // Server URL
  token: string; // Mobile access token
  name: string; // Server name
}

// Notification event types
export type NotificationEventType =
  | 'violation_detected'
  | 'stream_started'
  | 'stream_stopped'
  | 'concurrent_streams'
  | 'new_device'
  | 'trust_score_changed'
  | 'server_down'
  | 'server_up';

// Notification preferences (per-device settings)
export interface NotificationPreferences {
  id: string;
  mobileSessionId: string;

  // Master toggle
  pushEnabled: boolean;

  // Event toggles
  onViolationDetected: boolean;
  onStreamStarted: boolean;
  onStreamStopped: boolean;
  onConcurrentStreams: boolean;
  onNewDevice: boolean;
  onTrustScoreChanged: boolean;
  onServerDown: boolean;
  onServerUp: boolean;

  // Violation filtering
  violationMinSeverity: number; // 1=low, 2=warning, 3=high
  violationRuleTypes: string[]; // Empty = all rule types

  // Rate limiting
  maxPerMinute: number;
  maxPerHour: number;

  // Quiet hours
  quietHoursEnabled: boolean;
  quietHoursStart: string | null; // "23:00"
  quietHoursEnd: string | null; // "08:00"
  quietHoursTimezone: string;
  quietHoursOverrideCritical: boolean;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

// Rate limit status (returned with preferences for UI display)
export interface RateLimitStatus {
  remainingMinute: number;
  remainingHour: number;
  resetMinuteIn: number; // seconds until minute window resets
  resetHourIn: number; // seconds until hour window resets
}

// Extended preferences response including live rate limit status
export interface NotificationPreferencesWithStatus extends NotificationPreferences {
  rateLimitStatus?: RateLimitStatus;
}

// Notification channel types
export type NotificationChannel = 'discord' | 'webhook' | 'push' | 'webToast';

// Notification channel routing configuration (per-event type)
export interface NotificationChannelRouting {
  id: string;
  eventType: NotificationEventType;
  discordEnabled: boolean;
  webhookEnabled: boolean;
  pushEnabled: boolean;
  webToastEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Encrypted push payload (AES-256-GCM with separate authTag per security best practices)
export interface EncryptedPushPayload {
  v: 1; // Version for future-proofing
  iv: string; // Base64-encoded 12-byte IV
  salt: string; // Base64-encoded 16-byte PBKDF2 salt
  ct: string; // Base64-encoded ciphertext (without authTag)
  tag: string; // Base64-encoded 16-byte authentication tag
}

// Push notification payload structure (before encryption)
export interface PushNotificationPayload {
  type: NotificationEventType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channelId?: string; // Android notification channel
  badge?: number; // iOS badge count
  sound?: string | boolean;
  priority?: 'default' | 'high';
}

// =============================================================================
// SSE (Server-Sent Events) Types
// =============================================================================

// SSE connection states
export type SSEConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'fallback';

// Plex SSE notification container (outer wrapper)
export interface PlexSSENotification {
  NotificationContainer: {
    type: string;
    size: number;
    PlaySessionStateNotification?: PlexPlaySessionNotification[];
    ActivityNotification?: PlexActivityNotification[];
    StatusNotification?: PlexStatusNotification[];
    TranscodeSession?: PlexTranscodeNotification[];
  };
}

// Play session state notification (start/stop/pause/resume)
export interface PlexPlaySessionNotification {
  sessionKey: string;
  clientIdentifier: string;
  guid: string;
  ratingKey: string;
  url: string;
  key: string;
  viewOffset: number;
  playQueueItemID: number;
  state: 'playing' | 'paused' | 'stopped' | 'buffering';
}

// Activity notification (library scans, etc.)
export interface PlexActivityNotification {
  event: string;
  uuid: string;
  Activity: {
    uuid: string;
    type: string;
    cancellable: boolean;
    userID: number;
    title: string;
    subtitle: string;
    progress: number;
    Context?: {
      key: string;
    };
  };
}

// Status notification (server updates, etc.)
export interface PlexStatusNotification {
  title: string;
  description: string;
  notificationName: string;
}

// Transcode session notification
export interface PlexTranscodeNotification {
  key: string;
  throttled: boolean;
  complete: boolean;
  progress: number;
  size: number;
  speed: number;
  error: boolean;
  duration: number;
  remaining: number;
  context: string;
  sourceVideoCodec: string;
  sourceAudioCodec: string;
  videoDecision: string;
  audioDecision: string;
  subtitleDecision: string;
  protocol: string;
  container: string;
  videoCodec: string;
  audioCodec: string;
  audioChannels: number;
  transcodeHwRequested: boolean;
  transcodeHwDecoding: string;
  transcodeHwEncoding: string;
  transcodeHwDecodingTitle: string;
  transcodeHwEncodingTitle: string;
}

// SSE connection status for monitoring
export interface SSEConnectionStatus {
  serverId: string;
  serverName: string;
  state: SSEConnectionState;
  connectedAt: Date | null;
  lastEventAt: Date | null;
  reconnectAttempts: number;
  error: string | null;
}

// =============================================================================
// Termination Log Types
// =============================================================================

// Trigger source for stream terminations
export type TerminationTrigger = 'manual' | 'rule';

// Termination log with joined details for display
export interface TerminationLogWithDetails {
  id: string;
  sessionId: string;
  serverId: string;
  serverUserId: string;
  trigger: TerminationTrigger;
  triggeredByUserId: string | null;
  triggeredByUsername: string | null; // Joined from users table
  ruleId: string | null;
  ruleName: string | null; // Joined from rules table
  violationId: string | null;
  reason: string | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: Date;
  // Session info for context
  mediaTitle: string | null;
  mediaType: MediaType | null;
}

// =============================================================================
// Plex Server Discovery Types
// =============================================================================

// Connection details for a discovered Plex server
export interface PlexDiscoveredConnection {
  uri: string;
  local: boolean;
  address: string;
  port: number;
  reachable: boolean; // Tested from Tracearr server
  latencyMs: number | null; // Response time if reachable
}

// Discovered Plex server from plex.tv resources API
export interface PlexDiscoveredServer {
  name: string;
  platform: string;
  version: string;
  clientIdentifier: string; // Unique server identifier
  recommendedUri: string | null; // Best reachable connection
  connections: PlexDiscoveredConnection[];
}

// Response from GET /auth/plex/available-servers
export interface PlexAvailableServersResponse {
  servers: PlexDiscoveredServer[];
  hasPlexToken: boolean; // False if user has no Plex servers connected
}

// =============================================================================
// Version & Update Types
// =============================================================================

// Version information returned by the /version endpoint
export interface VersionInfo {
  // Current running version
  current: {
    version: string; // Semantic version (e.g., "1.3.8")
    tag: string | null; // Docker tag (e.g., "latest", "stable", "v1.3.8")
    commit: string | null; // Git commit SHA (short)
    buildDate: string | null; // ISO date of build
  };
  // Latest available version (null if check hasn't run yet)
  latest: {
    version: string;
    tag: string;
    releaseUrl: string;
    publishedAt: string;
  } | null;
  // Update status
  updateAvailable: boolean;
  // When the last check occurred (ISO timestamp)
  lastChecked: string | null;
}
