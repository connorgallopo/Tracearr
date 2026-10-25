/**
 * Core type definitions for Tracearr
 */
import type {
  ActionResult,
  AutomationActions,
  AutomationConditions,
  AutomationKind,
  GroupEvidence,
  RunFinishedEvent,
  TriggerNode,
} from './automations/index.js';
import type { NotificationToast } from './destinations.js';
import type { ListMeta } from './listQuery.js';
import type { UpgradeWarning } from './releaseNotes.js';
import type { ResolutionBucket } from './resolution.js';
import type { LibraryMediaType, PlaysMediaGroup, statPeriodSchema } from './schemas.js';
import type { z } from 'zod';
import type { LOGIN_ACCESS } from './constants.js';

// Can log in: owner always; admin and member as their loginAccess allows
// Cannot log in: disabled, pending
export type UserRole = 'owner' | 'admin' | 'member' | 'disabled' | 'pending';

export type LoginAccess = (typeof LOGIN_ACCESS)[number];

export const ROLE_PERMISSIONS: Record<UserRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
  disabled: 0,
  pending: 0,
} as const;

export const LOGIN_ROLES: UserRole[] = ['owner', 'admin', 'member'];
export const canLogin = (role: UserRole): boolean => LOGIN_ROLES.includes(role);
/** Roles that manage the instance and see every server; members see only their own activity. */
export const STAFF_ROLES: UserRole[] = ['owner', 'admin'];
export const isStaff = (role: UserRole): boolean => STAFF_ROLES.includes(role);
export const hasMinRole = (userRole: UserRole, required: 'owner' | 'admin' | 'member'): boolean =>
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
  /** The address members open a Jellyfin or Emby server at; null for Plex, which links through app.plex.tv. */
  publicUrl?: string | null;
  /** The media server's own id, used to build item deep links. */
  machineIdentifier?: string | null;
  displayOrder?: number;
  color?: string | null;
  /** What the server reports running, and the newest release the update checker saw. */
  version?: string | null;
  latestVersion?: string | null;
  /** When Tracearr stopped contacting this server. Null, or absent on older payloads, while it is live. */
  historicalAt?: string | null;
  allowMemberLogin?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServerLocationEntry {
  /** ISO datetime the location took effect; null covers everything before the first dated entry */
  effectiveFrom: string | null;
  lat: number;
  lon: number;
  city: string | null;
  region: string | null;
  /** ISO 3166-1 alpha-2 */
  country: string;
}

export interface ServerLocationsResponse {
  entries: ServerLocationEntry[];
  /** Entries changed since the location sync last applied them */
  syncPending: boolean;
}

export interface UpdateServerLocationsResponse extends ServerLocationsResponse {
  syncQueued: boolean;
}

// User types - Identity layer (the real human)
export interface User {
  id: string;
  username: string; // Login identifier (unique)
  name: string | null; // Display name (optional)
  thumbnail: string | null;
  email: string | null;
  role: UserRole; // Combined permission level and account status
  loginAccess: LoginAccess;
  lastLoginAt: Date | null;
  loginCount: number;
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
  joinedAt: Date | null;
  lastActivityAt: Date | null;
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  identityName?: string | null;
}

// Server User with identity info - returned by /users API endpoints
export interface ServerUserWithIdentity extends ServerUser {
  serverName: string;
  identityName: string | null;
  role: UserRole; // From linked User identity
  loginAccess: LoginAccess; // From linked User identity
  lastLoginAt: Date | string | null; // Tracearr sign-ins of the linked identity
  loginCount: number;
  // The identity's server memberships, scoped to servers the caller can access.
  // Length > 1 means this identity is merged across servers. serverUserId/removedAt
  // describe the identity's account on that server.
  // Only populated by the list endpoint; absent on detail endpoints (/users/:id, /full).
  identityServers?: {
    id: string;
    name: string;
    serverUserId?: string;
    removedAt?: string | null;
  }[];
  // The person's overall trust score across all their server accounts
  // (users.aggregateTrustScore), distinct from `trustScore` which is just
  // this representative account's own score.
  // Only populated by the list endpoint; absent on detail endpoints (/users/:id, /full).
  identityTrustScore?: number;
  // Earliest join and latest activity across every account this person has,
  // distinct from the representative account's own joinedAt/lastActivityAt.
  // Only populated by the list endpoint.
  identityJoinedAt?: Date | string | null;
  identityLastActivityAt?: Date | string | null;
  // Server-computed: whether this identity holds sign-in credentials. Owner or
  // admin role, a password hash, a linked Plex account or any auth account. A
  // merge can only ever absorb into a login-capable target, so deriving this on
  // the client from role alone picks the wrong direction.
  // Only populated by the list endpoint.
  loginCapable?: boolean;
  // Unacknowledged violations across this identity's accounts on the scoped servers.
  // Only populated by the list endpoint.
  pendingViolations?: number;
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
  serverId: string;
  serverName: string;
  sessionId: string | null;
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
  identity: {
    userId: string;
    aggregateTrustScore: number;
    totalViolations: number;
    contactEmail: string | null;
    serverUsers: {
      id: string;
      serverId: string;
      serverName: string;
      serverType: string;
      username: string;
      thumbUrl: string | null;
      trustScore: number;
      sessionCount: number;
      removedAt: Date | null;
      mergedIn: boolean;
    }[];
    stats: { totalSessions: number; totalWatchTime: number };
  };
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
  impersonatedBy?: string; // The owner's user id while the owner views as this user
}

export interface UserMergeResult {
  targetUserId: string;
  auditId: string;
  movedServerUserIds: string[];
  combinedServerUsers: {
    sourceServerUserId: string;
    targetServerUserId: string;
    serverId: string;
  }[];
  wasSameServerCombine: boolean;
  // Names of source-account rules dropped because the target already had a
  // rule with the same name on a same-server combine (target's version wins).
  // Empty when nothing conflicted.
  droppedRuleNames: string[];
}

export interface ServerUserSplitResult {
  newUserId: string;
  serverUserId: string;
}

/** Why an account cannot be linked to the owner as it stands. */
export type OwnerLinkBlockedReason = 'other_accounts' | 'signs_in';

export interface OwnerLinkCandidate {
  serverUserId: string;
  username: string;
  thumbUrl: string | null;
  isServerAdmin: boolean;
  lastActivityAt: string | null;
  blockedReason: OwnerLinkBlockedReason | null;
}

/** The owner's own account on one Jellyfin or Emby server, or the accounts it could be. */
export interface OwnerLinkServer {
  serverId: string;
  linked: { serverUserId: string; username: string } | null;
  candidates: OwnerLinkCandidate[];
}

export interface MergeSuggestionIdentity {
  userId: string;
  username: string;
  name: string | null;
  email: string | null;
  role: UserRole;
  loginCapable: boolean;
  /** Latest activity across every account the identity has; null before any. */
  lastActivityAt: string | null;
  /** Sessions across every account the identity has. */
  sessionCount: number;
  serverUsers: {
    id: string;
    serverId: string;
    serverName: string;
    username: string;
    email: string | null;
    removedAt: string | null;
  }[];
}

export interface MergeSuggestion {
  matchType: 'email' | 'username';
  matchValue: string;
  users: [MergeSuggestionIdentity, MergeSuggestionIdentity];
  requiredTargetUserId: string | null;
  /** The identity a merge keeps unless the owner swaps: `rankMergeTarget` over the pair, so it is requiredTargetUserId whenever that is set. */
  suggestedTargetUserId: string;
  wouldCombineSameServer: boolean;
}

/** A pair the owner marked as not the same person; it is not suggested again until restored. */
export interface DismissedMergeSuggestion {
  users: [MergeSuggestionIdentity, MergeSuggestionIdentity];
  dismissedAt: string;
}

export interface SetupStatus {
  needsSetup: boolean;
  requiresClaimCode: boolean;
  hasServers: boolean;
  hasJellyfinServers: boolean;
  hasPasswordAuth: boolean;
  authMethods: {
    local: boolean;
    plex: boolean;
    oidc: boolean;
    oidcProviderName: string | null;
    member: boolean;
  };
  memberLoginServers: { id: string; name: string; type: ServerType; quickConnect: boolean }[];
}

// Session types
export type SessionState = 'playing' | 'paused' | 'stopped';

/** Supported media types */
export const MEDIA_TYPES = [
  'movie',
  'episode',
  'track',
  'live',
  'photo',
  'trailer',
  'unknown',
] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

// ============================================================================
// Stream Detail Types (JSONB column schemas)
// ============================================================================

/** Source video details from original media file */
export interface SourceVideoDetails {
  bitrate?: number;
  framerate?: string;
  dynamicRange?: string; // 'SDR' | 'HDR10' | 'HLG' | 'Dolby Vision'
  aspectRatio?: number;
  profile?: string;
  level?: string;
  colorSpace?: string;
  colorDepth?: number;
}

/** Source audio details from original media file */
export interface SourceAudioDetails {
  bitrate?: number;
  channelLayout?: string;
  language?: string;
  sampleRate?: number;
  profile?: string;
  atmos?: boolean;
}

/** Stream video details after transcode */
export interface StreamVideoDetails {
  bitrate?: number;
  width?: number;
  height?: number;
  framerate?: string;
  dynamicRange?: string;
}

/** Stream audio details after transcode */
export interface StreamAudioDetails {
  bitrate?: number;
  channels?: number;
  language?: string;
}

/** Transcode processing information */
export interface TranscodeInfo {
  containerDecision?: string;
  sourceContainer?: string;
  streamContainer?: string;
  hwRequested?: boolean;
  hwDecoding?: string;
  hwEncoding?: string;
  speed?: number;
  throttled?: boolean;
  /**
   * Plex: share of the runtime this transcode job has produced since it started (0-100), not a
   * position. Jellyfin: the server's CompletionPercentage, whose meaning is unverified.
   */
  progress?: number;
  /** Seconds from the file start that the transcoder has ready (Plex only; Jellyfin sends none) */
  maxOffsetAvailable?: number;
  reasons?: string[];
}

/** Subtitle stream information */
export interface SubtitleInfo {
  decision?: string;
  codec?: string;
  language?: string;
  forced?: boolean;
}

// ============================================================================
// Stream Detail Fields (shared interface to eliminate duplication)
// ============================================================================

/**
 * Common fields for stream metadata tracking.
 * Used by Session, ProcessedSession, MediaSession.quality, and test fixtures.
 * All fields are nullable for backwards compatibility with existing sessions.
 */
export interface StreamDetailFields {
  // Source media details (original file)
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  sourceAudioChannels: number | null;
  sourceVideoWidth: number | null;
  sourceVideoHeight: number | null;
  sourceVideoDetails: SourceVideoDetails | null;
  sourceAudioDetails: SourceAudioDetails | null;
  // Stream output details (delivered to client)
  streamVideoCodec: string | null;
  streamAudioCodec: string | null;
  streamVideoDetails: StreamVideoDetails | null;
  streamAudioDetails: StreamAudioDetails | null;
  // Transcode and subtitle info
  transcodeInfo: TranscodeInfo | null;
  subtitleInfo: SubtitleInfo | null;
}

/**
 * Default values for stream detail fields (all null).
 * Use with spread operator for test fixtures and initial values.
 */
export const DEFAULT_STREAM_DETAILS: StreamDetailFields = {
  sourceVideoCodec: null,
  sourceAudioCodec: null,
  sourceAudioChannels: null,
  sourceVideoWidth: null,
  sourceVideoHeight: null,
  sourceVideoDetails: null,
  sourceAudioDetails: null,
  streamVideoCodec: null,
  streamAudioCodec: null,
  streamVideoDetails: null,
  streamAudioDetails: null,
  transcodeInfo: null,
  subtitleInfo: null,
};

export interface Session extends StreamDetailFields {
  id: string;
  serverId: string;
  // Only populated by identity/multi-server-aware queries (e.g. the user
  // detail endpoints); absent elsewhere.
  serverName?: string;
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
  serverVersionKey: string | null; // Which file/version was played (Plex Media.id, JF/Emby MediaSource id)
  parentRatingKey: string | null;
  grandparentRatingKey: string | null;
  mediaId: string | null;
  showMediaId: string | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
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
  geoContinent: string | null;
  geoPostal: string | null;
  geoLat: number | null;
  geoLon: number | null;
  geoAsnNumber: number | null;
  geoAsnOrganization: string | null;
  // A local network session; its geo fields hold its server's location when one is set
  isLocal: boolean;
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
  // Live TV fields
  channelTitle: string | null;
  channelIdentifier: string | null;
  channelThumb: string | null;
  // Music track fields
  artistName: string | null;
  albumName: string | null;
  trackNumber: number | null;
  discNumber: number | null;
}

export interface ActiveSession extends Session {
  user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl'> & { identityName: string | null };
  server: Pick<Server, 'id' | 'name' | 'type'>;
  /** Whether this session can be terminated (some clients like Plexamp don't support termination) */
  canTerminate: boolean;
  /** True while the session is an unconfirmed pending entry; absent once confirmed. */
  pending?: boolean;
  /** Plex only: the client is buffering; state keeps the last playing or paused value. */
  buffering?: boolean;
}

export interface SessionSegment {
  startedAt: string;
  stoppedAt: string | null;
  durationMs: number | null;
  pausedDurationMs: number;
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
  // Individual segment details (up to 20), only present when segmentCount > 1
  segments?: SessionSegment[];
}

export interface ImpossibleTravelParams {
  maxSpeedKmh: number;
  ignoreVpnRanges?: boolean;
  /** When true, exclude sessions from private/local network IPs from comparison */
  excludePrivateIps?: boolean;
}

export interface SimultaneousLocationsParams {
  minDistanceKm: number;
  /** When true, exclude sessions from private/local network IPs from comparison */
  excludePrivateIps?: boolean;
}

export interface DeviceVelocityParams {
  maxIps: number;
  windowHours: number;
  /** When true, exclude private/local network IPs (192.168.x.x, 10.x.x.x, etc.) from unique IP count */
  excludePrivateIps?: boolean;
  /** When true, count by deviceId instead of IP - same device with different IPs counts as 1 */
  groupByDevice?: boolean;
}

export interface ConcurrentStreamsParams {
  maxStreams: number;
  /** When true, exclude sessions from private/local network IPs from stream count */
  excludePrivateIps?: boolean;
}

export type GeoRestrictionMode = 'blocklist' | 'allowlist';

export interface GeoRestrictionParams {
  mode: GeoRestrictionMode;
  countries: string[];
  /** When true, always allow sessions from private/local network IPs (default behavior, explicit option) */
  excludePrivateIps?: boolean;
}

/** Time unit for inactivity threshold */
export type AccountInactivityUnit = 'days' | 'weeks' | 'months';

export interface AccountInactivityParams {
  /** Inactivity threshold value (e.g., 30, 7, 3) */
  inactivityValue: number;
  /** Time unit for the inactivity threshold */
  inactivityUnit: AccountInactivityUnit;
}

export type {
  ActionResult,
  ConditionEvidence,
  GroupEvidence,
  NodeFields,
} from './automations/index.js';

/** The engine's automation shape: definition columns plus the row's timestamps. */
export interface EngineAutomation {
  id: string;
  name: string;
  description: string | null;
  serverId: string | null;
  // Account scope - applies only to this specific server_user.
  serverUserId: string | null;
  // Identity (person) scope - applies to every server_user of this identity.
  userId: string | null;
  // Opt-in: actions may target sessions on every server the identity has an account on.
  enforceAcrossServers: boolean;
  isActive: boolean;
  severity: ViolationSeverity;
  kind: AutomationKind;
  conditions: AutomationConditions;
  actions: AutomationActions;
  // Which events evaluate this automation. Never null here: the cache mapper normalizes an unstamped row to [].
  triggers: TriggerNode[];
  /** Latest automation_versions row, stamped on every run this definition records. */
  currentVersionId: string | null;
  /** Minutes a subject is suppressed after a completed run; null disables the cooldown. */
  cooldownMinutes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

// Violation types
export type ViolationSeverity = 'low' | 'warning' | 'high';

export interface Violation {
  id: string;
  ruleId: string;
  serverUserId: string;
  sessionId: string | null;
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
  mediaId: string | null;
  showMediaId: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  year: number | null;
  ipAddress: string;
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
  isLocal: boolean;
  geoContinent: string | null;
  geoPostal: string | null;
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
  // type is a v1 leftover: rows written before the automation model carry one, automations leave it null.
  rule: { id: string; name: string; type: string | null };
  user: Pick<ServerUser, 'id' | 'username' | 'thumbUrl' | 'serverId'> & {
    identityName: string | null;
    // The person's identity id (users.id), for identity-level filtering.
    // Always populated by GET /violations; optional here so websocket
    // broadcast payloads built without a fresh identity lookup still type-check.
    userId?: string;
  };
  server?: Pick<Server, 'id' | 'name' | 'type'>;
  session?: ViolationSessionInfo;
  relatedSessions?: ViolationSessionInfo[];
  /** Action results from V2 rule execution */
  actionResults?: ActionResult[];
  /** Condition evidence from V2 rule evaluation */
  evidence?: GroupEvidence[];
  /** Display names for server-user IDs found in evidence conditions (detail endpoint only) */
  userNames?: Record<string, string>;
}

// Stats types
export interface DashboardStats {
  activeStreams: number;
  todayPlays: number; // Validated plays (sessions >= 2 min)
  todaySessions: number; // Raw session count (for comparison)
  watchTimeHours: number;
  /** Music tracks since the start of the day; watchTimeHours covers movies and episodes */
  listenTimeHours: number;
  /** Absent for members, who never see violations */
  alertsLast24h?: number;
  /** Absent for members, who get othersActive instead */
  activeUsersToday?: number;
  /** Members only: active streams on the member's servers that are not theirs */
  othersActive?: number;
}

/** GET /stats/me: the viewer's own accounts, all time. */
export interface MyStats {
  /** Distinct local days with a play of two minutes or more */
  daysWatched: number;
  /** Consecutive local days ending today or yesterday, otherwise 0 */
  currentStreak: number;
  longestStreak: number;
  /** Every session except trailers, across all servers: the same sum as the history aggregates */
  totalWatchTimeMs: number;
  firstPlay: {
    mediaTitle: string;
    grandparentTitle: string | null;
    mediaId: string | null;
    startedAt: string;
  } | null;
  /** Most distinct episodes of one show on one UTC day, when that is at least two */
  biggestBinge: {
    showTitle: string;
    showMediaId: string | null;
    episodes: number;
    /** YYYY-MM-DD, UTC */
    day: string;
  } | null;
  topGenres: { genre: string; plays: number }[];
}

/** GET /stats/me/titles: what the viewer watched most in the last 30 days, as poster rows. */
export interface MyTopTitleRow extends ShelfRow {
  watchedState: WatchedState;
  plays: number;
  watchTimeMs: number;
  /** Distinct episodes played; null for a movie */
  episodes: number | null;
  rank: number;
}

export interface MyTopTitlesResponse {
  data: MyTopTitleRow[];
}

export interface PlayStats {
  date: string;
  count: number;
  serverId: string;
  /** Present only with groupBy=mediaType */
  mediaType?: PlaysMediaGroup;
}

export interface UserStats {
  serverUserId: string;
  username: string;
  thumbUrl: string | null;
  playCount: number;
  watchTimeHours: number;
}

export interface LocationUserInfo {
  id: string; // Representative server_user id
  username: string;
  identityName: string | null;
  thumbUrl: string | null;
  serverId: string; // The representative account's server, which owns thumbUrl
  serverUserIds: string[]; // Every account of the identity within the caller's servers
  count: number; // Plays at this location
}

/** The people each location of the /stats/locations list carries; the list draws this many avatars. */
export const LOCATION_LIST_PEOPLE = 3;

export interface LocationStats {
  city: string | null;
  region: string | null; // State/province
  country: string | null;
  isLocal: boolean;
  lat: number | null; // Null when no session in the group has coordinates
  lon: number | null;
  count: number;
  lastActivity?: Date;
  firstActivity?: Date;
  // Count DESC then name: the first LOCATION_LIST_PEOPLE in the list, every person from
  // /stats/locations/people. One entry under a user filter.
  users?: LocationUserInfo[];
  peopleCount: number;
  deviceCount?: number; // Unique devices from this location
  // Per-server breakdown ordered by count DESC; servers[0] is the dominant server
  servers?: { serverId: string; count: number }[];
}

export interface LocationStatsSummary {
  totalStreams: number;
  uniqueLocations: number;
  topCity: string | null;
}

export interface LocationFilterOptions {
  users: {
    id: string;
    username: string;
    identityName: string | null;
    serverUserIds: string[];
  }[];
  mediaTypes: MediaType[];
}

export interface LocationStatsResponse {
  data: LocationStats[];
  summary: LocationStatsSummary;
  availableFilters: LocationFilterOptions;
}

export interface LocationPeopleResponse {
  data: LocationStats[];
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
  /** Present only with groupBy=mediaType */
  mediaType?: PlaysMediaGroup;
}

export interface HourOfDayStats {
  hour: number; // 0-23
  count: number;
  /** Present only with groupBy=mediaType */
  mediaType?: PlaysMediaGroup;
}

export interface QualityStats {
  directPlay: number;
  directStream: number;
  /** Every transcode, audio-only ones included. */
  transcode: number;
  /** The audio-only part of `transcode`. */
  audioTranscode: number;
  total: number;
  directPlayPercent: number;
  directStreamPercent: number;
  transcodePercent: number;
  audioTranscodePercent: number;
}

export interface TopUserStats {
  /** Identity (person) id - plays/watch time are summed across all their accounts */
  userId: string;
  /** Representative account id, used for navigation (routes to /users/:id) */
  serverUserId: string;
  username: string;
  identityName: string | null;
  thumbUrl: string | null;
  /** Representative account's server, used for avatar proxy */
  serverId: string | null;
  /** Identity-level aggregate trust score, not the representative account's own score. Absent for members. */
  trustScore?: number;
  playCount: number;
  watchTimeHours: number;
  topMediaType: string | null; // "movie", "episode", etc.
  topContent: string | null; // Most watched show/movie name
  /** Every server this identity has an account on, scoped to accessible servers */
  identityServers?: { id: string; name: string }[];
}

export interface RangeSeriesPoint {
  date: string;
  count: number;
}

export interface UserRangeStats {
  range: { start: string | null; end: string; priorStart: string | null; priorEnd: string | null };
  plays: number;
  priorPlays: number | null;
  watchMs: number;
  priorWatchMs: number | null;
  /** Percent of counted chains, null when there are none. */
  finishedRate: number | null;
  abandonedRate: number | null;
  directPlayRate: number | null;
  transcodes: number;
  /** Percent of counted chains played on the local network, null when there are none. */
  localShare: number | null;
  bytes: number;
  avgBitrateKbps: number | null;
  activeDays: number;
  daysInRange: number | null;
  currentStreak: number;
  playsByDay: RangeSeriesPoint[];
  priorPlaysByDay: RangeSeriesPoint[];
  serverAvgPlaysByDay: RangeSeriesPoint[];
  playsByDow: DayOfWeekStats[];
  playsByHour: HourOfDayStats[];
  serverPeakHour: number | null;
  personPeakHour: number | null;
  mediaTypeSplit: { movie: number; episode: number; track: number; other: number };
  /** Top 6 */
  topGenres: { genre: string; plays: number }[];
  /** Top 5 */
  mostFinished: {
    mediaId: string;
    title: string;
    type: string;
    finished: number;
    thumbPath: string | null;
    serverId: string;
  }[];
  /** Top 5 by sessions */
  devices: {
    device: string;
    platform: string | null;
    sessions: number;
    directPlayRate: number | null;
    lastSeenAt: string | null;
  }[];
  /** Top 5 by sessions */
  locations: {
    city: string | null;
    region: string | null;
    country: string | null;
    sessions: number;
    isLocal: boolean;
    lastSeenAt: string | null;
  }[];
}

export interface PersonRow {
  userId: string;
  serverUserId: string;
  username: string;
  identityName: string | null;
  thumbUrl: string | null;
  serverId: string | null;
  trustScore: number | null;
  plays: number;
  watchMs: number;
  bytes: number;
  directPlayRate: number | null;
  transcodes: number;
  transcodeShare: number | null;
  /** All time, not bound by the range. */
  requests: number;
  requestsWatched: number;
  lastPlayAt: string | null;
  /** 7 buckets of plays across the range, oldest first */
  trend: number[];
  identityServers?: { id: string; name: string }[];
}

export interface PeopleSummary {
  activePeople: number;
  totalPeople: number;
  /** Percent of counted plays held by the top three people by plays */
  topThreeShare: number | null;
  topTranscoderShare: number | null;
  topTranscoderCount: number;
  totalTranscodes: number;
  quietPeople: number;
  quietDays: 90;
}

export interface PeopleResponse {
  data: PersonRow[];
  summary: PeopleSummary;
  meta: ListMeta;
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
  /** System-wide CPU utilization percentage; null when the source cannot see the host (non-Linux plugin hosts) */
  hostCpuUtilization: number | null;
  /** Media server process CPU utilization percentage */
  processCpuUtilization: number;
  /** System-wide memory utilization percentage; null when the source cannot see the host */
  hostMemoryUtilization: number | null;
  /** Media server process memory utilization percentage */
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

// Server bandwidth statistics (Local/Remote)
// From Plex's undocumented /statistics/bandwidth endpoint
export interface ServerBandwidthDataPoint {
  /** Unix timestamp */
  at: number;
  /** Timespan interval in seconds */
  timespan: number;
  /** Total local (LAN) bandwidth in bytes for this interval */
  lanBytes: number;
  /** Total remote (WAN) bandwidth in bytes for this interval */
  wanBytes: number;
}

export interface ServerBandwidthStats {
  /** Server ID these stats belong to */
  serverId: string;
  /** Data points (newest first based on 'at' timestamp) */
  data: ServerBandwidthDataPoint[];
  /** When this data was fetched */
  fetchedAt: Date;
}

/** Plex account referenced by bandwidth samples */
export interface BandwidthAccount {
  id: number;
  name: string;
  thumb: string | null;
}

/** Plex device referenced by bandwidth samples */
export interface BandwidthDevice {
  id: number;
  name: string;
  platform: string | null;
}

/**
 * Per-account/device bandwidth sample. Entries are 1-second buckets
 * regardless of the timespan echoed by the Plex API.
 */
export interface BandwidthSample {
  at: number;
  accountId: number;
  deviceId: number;
  lan: boolean;
  bytes: number;
}

// Combined live stats for the dashboard: one request carries both series
export interface ServerLiveStats {
  /** Server ID these stats belong to */
  serverId: string;
  /** Resource data points (newest first based on 'at' timestamp) */
  statistics: ServerResourceDataPoint[];
  /** Aggregated bandwidth points (newest first based on 'at' timestamp) */
  bandwidth: ServerBandwidthDataPoint[];
  /** Raw per-account/device bandwidth samples (newest first) */
  bandwidthSamples: BandwidthSample[];
  /** Accounts referenced by bandwidthSamples */
  bandwidthAccounts: BandwidthAccount[];
  /** Devices referenced by bandwidthSamples */
  bandwidthDevices: BandwidthDevice[];
  /** ISO, on the Tracearr server's clock - the charts' axis anchor */
  fetchedAt: string;
}

// Unit system for display preferences (stored in settings)
export type UnitSystem = 'metric' | 'imperial';

export interface LoginMethods {
  local: boolean;
  plex: boolean;
  oidc: boolean;
  member: boolean;
}

// Settings types
export interface Settings {
  loginMethods: LoginMethods;
  // Display preferences
  unitSystem: UnitSystem;
  // Poller settings
  pollerEnabled: boolean;
  pollerIntervalMs: number;
  // GeoIP settings
  usePlexGeoip: boolean;
  // Tautulli integration
  tautulliUrl: string | null;
  tautulliApiKey: string | null;
  // Network/access settings
  externalUrl: string | null;
  trustProxy: boolean;
  // Mobile access
  mobileEnabled: boolean;
  // Tailscale VPN
  tailscaleEnabled: boolean;
  tailscaleHostname: string | null;
  // Backup settings
  backupScheduleType: BackupScheduleType;
  backupScheduleTime: string;
  backupScheduleDayOfWeek: number;
  backupScheduleDayOfMonth: number;
  backupRetentionCount: number;
  // Plugin update check
  pluginUpdateCheckEnabled: boolean;
  pluginManifestUrl: string | null;
  // Media-server update check
  serverUpdateCheckEnabled: boolean;
  // Watch completion thresholds (percent, per media type)
  watchedThresholdMovie: number;
  watchedThresholdTv: number;
  watchedThresholdMusic: number;
  // Public API v2
  publicApiRateLimitPerMinute: number;
  // Media browsing: warm poster caches for a server after its library sync completes
  imagePrecacheEnabled: boolean;
  // Media browsing: server whose poster wins when a title exists on multiple servers, null = automatic (most recently added copy)
  preferredPosterServerId: string | null;
  // Members see anonymous counts of other people's activity: others watching, title totals, Most Popular, popularity sorts
  memberServerActivity: boolean;
}

/** GET and PATCH /settings: the settings plus deployment facts that are not settings. */
export interface SettingsResponse extends Settings {
  /** Read-only: all three OIDC env vars are set. Not stored, and a PATCH cannot change it. */
  oidcConfigured: boolean;
}

/** GET /settings/image-cache. Sizes in bytes; timestamps ISO. */
export interface ImageCacheStatus {
  bytes: number;
  files: number;
  versionedFiles: number;
  sweptAt: string | null;
  freedBytesLastSweep: number;
  deletedFilesLastSweep: number;
  /** A completed full pass was followed by an empty cache on a directory that
   *  is not a mounted volume, so the cache is not surviving restarts. */
  notPersisting: boolean;
  /** Distinct (server, thumb path) pairs in library_items, removed rows
   *  included: one cache file each, however many rows share the image. */
  postersWithThumb: number;
  /** postersWithThumb × ESTIMATED_POSTER_BYTES. */
  estimatedNeedBytes: number;
  freeBytes: number;
  totalBytes: number;
  minFreePercent: number;
  /** IMAGE_CACHE_MAX_MB in bytes, or null when unset. */
  maxBytes: number | null;
  diskLimitedSince: string | null;
  shortfallBytes: number;
}

// Tailscale integration
export type TailscaleStatus =
  'disabled' | 'starting' | 'awaiting_auth' | 'connected' | 'error' | 'stopping';

export interface TailscaleExitNode {
  id: string;
  hostname: string;
  dnsName: string;
  ip: string;
  online: boolean;
  active: boolean;
}

export interface TailscaleInfo {
  status: TailscaleStatus;
  authUrl: string | null;
  hostname: string | null;
  dnsName: string | null;
  tailnetName: string | null;
  tailnetIp: string | null;
  tailnetUrl: string | null;
  exitNodes: TailscaleExitNode[];
  error: string | null;
  available: boolean;
}

// Heavy operations lock info (for "Waiting for X" display)
export interface HeavyOpsWaitingFor {
  jobType: 'import' | 'maintenance';
  description: string;
  startedAt: string;
}

// Tautulli import types
export interface TautulliImportProgress {
  status: 'idle' | 'waiting' | 'fetching' | 'processing' | 'complete' | 'error';
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
  /** Present when status='waiting' - what this job is waiting for */
  waitingFor?: HeavyOpsWaitingFor;
}

export interface TautulliImportResult {
  success: boolean;
  imported: number;
  updated: number;
  /** No longer set; kept for clients built against older versions */
  linked?: number;
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

// Jellystat import types
export interface JellystatImportProgress {
  status: 'idle' | 'waiting' | 'parsing' | 'enriching' | 'processing' | 'complete' | 'error';
  totalRecords: number;
  processedRecords: number;
  importedRecords: number;
  skippedRecords: number;
  /** Number of records filtered out (theme songs, theme videos, trailers, etc.) */
  filteredRecords: number;
  errorRecords: number;
  /** Number of media items enriched with metadata from Jellyfin */
  enrichedRecords: number;
  uncheckedRecords?: number;
  unlinkedEpisodeRecords?: number;
  vetoedRecords?: number;
  pluginUncheckedRecords?: number;
  overlongRecords?: number;
  /** Current phase message */
  message: string;
  /** Present when status='waiting' - what this job is waiting for */
  waitingFor?: HeavyOpsWaitingFor;
}

export interface JellystatImportResult {
  success: boolean;
  imported: number;
  updated: number;
  skipped: number;
  /** Number of records filtered out (theme songs, theme videos, trailers, etc.) */
  filtered: number;
  errors: number;
  enriched: number;
  unchecked: number;
  unlinkedEpisodes: number;
  vetoed: number;
  pluginUnchecked: number;
  overlong: number;
  message: string;
  /** Details about users that were skipped (not found in Tracearr) */
  skippedUsers?: {
    jellyfinUserId: string;
    username: string | null;
    recordCount: number;
  }[];
}

// Playback Reporting plugin import types
export interface PlaybackReportingImportProgress {
  status:
    | 'idle'
    | 'waiting'
    | 'detecting'
    | 'fetching'
    | 'enriching'
    | 'processing'
    | 'complete'
    | 'error';
  totalRecords: number;
  fetchedRecords: number;
  processedRecords: number;
  importedRecords: number;
  skippedRecords: number;
  /** Skipped: row already imported (pr- namespace) or already present via a Jellystat import (raw rowid namespace) */
  duplicateRecords: number;
  /** Skipped: user not found in Tracearr (sync server first) */
  unknownUserRecords: number;
  /** Skipped: row falls inside the span Tracearr already tracks for this server */
  overlapRecords: number;
  /** Skipped: theme songs, trailers, etc. */
  filteredRecords: number;
  /** Skipped: recorded play time runs past the media runtime plus 60 s */
  overlongRecords: number;
  errorRecords: number;
  enrichedRecords: number;
  message: string;
  /** Present when status='waiting' - what this job is waiting for */
  waitingFor?: HeavyOpsWaitingFor;
}

export interface PlaybackReportingImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  duplicates: number;
  overlap: number;
  filtered: number;
  overlong: number;
  errors: number;
  enriched: number;
  message: string;
  skippedUsers?: {
    userId: string;
    username: string | null;
    recordCount: number;
  }[];
}

// Library sync progress types
export interface LibrarySyncProgress {
  serverId: string;
  serverName: string;
  status: 'running' | 'complete' | 'error';
  currentLibrary?: string;
  currentLibraryName?: string;
  totalLibraries: number;
  processedLibraries: number;
  totalItems: number;
  processedItems: number;
  message: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

/** Why the poller marked a server down, when it knows; absent for unreachable. */
export type ServerDownReason = 'unauthorized';

// WebSocket event types
export interface ServerToClientEvents {
  'session:started': (session: ActiveSession) => void;
  'session:stopped': (sessionId: string) => void;
  'session:updated': (session: ActiveSession) => void;
  'violation:new': (violation: ViolationWithDetails) => void;
  'run:finished': (runs: RunFinishedEvent[]) => void;
  'stats:updated': (stats: DashboardStats) => void;
  'import:progress': (progress: TautulliImportProgress) => void;
  'import:jellystat:progress': (progress: JellystatImportProgress) => void;
  'import:playbackreporting:progress': (progress: PlaybackReportingImportProgress) => void;
  'maintenance:progress': (progress: MaintenanceJobProgress) => void;
  'library:sync:progress': (progress: LibrarySyncProgress) => void;
  'tasks:updated': (tasks: RunningTask[]) => void;
  'version:update': (data: { current: string; latest: string; releaseUrl: string }) => void;
  'server:down': (data: {
    serverId: string;
    serverName: string;
    reason?: ServerDownReason;
  }) => void;
  'server:up': (data: { serverId: string; serverName: string }) => void;
  'server:connection': (status: ServerConnectionStatus) => void;
  'notification:toast': (data: NotificationToast) => void;
  'destinations:changed': () => void;
  'servers:changed': () => void;
  'requests:changed': (data: { serviceId: string }) => void;
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
  isLocal: boolean;
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
  isLocal: boolean | null;
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
  downloadCount: number;
  lastSeenAt: Date;
  locations: DeviceLocation[]; // Where this device has been used from
}

export type MediaDownloadSource = 'activity_log' | 'emby_sync' | 'plex' | 'jellyfin_transcode';

export interface MediaDownloadRow {
  id: string;
  serverId: string;
  serverName: string;
  serverType: ServerType;
  serverUserId: string | null;
  username: string | null;
  identityName: string | null;
  thumbUrl: string | null;
  libraryItemId: string | null;
  mediaId: string | null;
  title: string;
  mediaType: string | null;
  thumbPath: string | null;
  app: string | null;
  device: string | null;
  source: MediaDownloadSource;
  requestCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  videoResolution: string | null;
  videoCodec: string | null;
  videoDynamicRange: string | null;
  container: string | null;
  fileSizeBytes: number | null;
  ipAddress: string | null;
  isLocal: boolean | null;
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
  deliveredBytes: number | null;
  deliveredVideoCodec: string | null;
  deliveredAudioCodec: string | null;
  deliveredContainer: string | null;
  deliveredBitrateKbps: number | null;
  deliveredResolution: string | null;
  /** A converted pull's last reported progress */
  completionPercent: number | null;
  deviceId: string | null;
  playerName: string | null;
  product: string | null;
  platform: string | null;
}

export interface DownloadsStats {
  total: number;
  people: number;
  totalBytes: number;
  topTitle: { title: string; count: number; libraryItemId: string | null } | null;
  rows: MediaDownloadRow[];
  page: number;
  pageSize: number;
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
  /** The music track share of totalWatchTimeMs */
  listenTimeMs: number;
  /** Count of unique plays (grouped by reference_id) */
  playCount: number;
  /** Count of unique users in the result set */
  uniqueUsers: number;
  /** Count of unique content items watched */
  uniqueContent: number;
}

/**
 * Response shape for history/sessions queries with cursor-based pagination.
 * Aggregate stats are fetched separately via /sessions/history/aggregates.
 */
export interface HistorySessionResponse {
  data: SessionWithDetails[];
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
  serverId: string;
  identityName: string | null;
  /** All server account ids belonging to this person (identity), access-scoped. */
  serverUserIds: string[];
}

/**
 * Server option for server filter dropdown.
 */
export interface ServerFilterOption {
  id: string;
  name: string;
  type: 'plex' | 'jellyfin' | 'emby';
}

/**
 * Country option with session activity indicator.
 * Used when includeAllCountries=true for rules builder.
 */
export interface CountryOption {
  code: string;
  name: string;
  hasSessions: boolean;
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
  /** Available countries (codes with session count) */
  countries: FilterOptionItem[];
  /** Available cities */
  cities: FilterOptionItem[];
  /** Available users (with avatar info) */
  users: UserFilterOption[];
  /** Available servers (optional, included when requested) */
  servers?: ServerFilterOption[];
}

/**
 * Extended filter options for rules builder.
 * Includes all countries with session indicators and servers.
 */
export interface AutomationFilterOptions extends Omit<HistoryFilterOptions, 'countries'> {
  /** All countries with session activity indicator */
  countries: CountryOption[];
  /** Available servers */
  servers: ServerFilterOption[];
}

export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
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
  | 'server_down'
  | 'server_up'
  | 'plugin_update_available'
  | 'server_update_available'
  | 'tracearr_update_available'
  | 'media_added'
  | 'media_upgraded'
  | 'new_device'
  | 'trust_score_changed'
  | 'newsletter_send';

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

/** The per-device toggles that filter a push after the server has decided to send it. */
export type PushEventPreference =
  | 'onViolationDetected'
  | 'onStreamStarted'
  | 'onStreamStopped'
  | 'onNewDevice'
  | 'onTrustScoreChanged'
  | 'onServerDown'
  | 'onServerUp';

/** What stands between an event and this device, apart from the device's own toggles. */
export interface PushDeliveryStatus {
  /** The server holds a push token for this device. */
  tokenRegistered: boolean;
  /** The built-in Mobile push destination is switched on. */
  destinationEnabled: boolean;
  /** Mobile push has Receive violations on, so every violation is sent. */
  violationsSubscribed: boolean;
  /** Active automations that send each event to Mobile push. */
  automations: Record<PushEventPreference, number>;
}

// Extended preferences response including live rate limit status
export interface NotificationPreferencesWithStatus extends NotificationPreferences {
  rateLimitStatus?: RateLimitStatus;
  delivery?: PushDeliveryStatus;
}

// Encrypted push payload (AES-256-GCM with separate authTag per security best practices)
export interface EncryptedPushPayload {
  v: 1; // Version for future-proofing
  iv: string; // Base64-encoded 12-byte IV
  salt: string; // Base64-encoded 16-byte PBKDF2 salt
  ct: string; // Base64-encoded ciphertext (without authTag)
  tag: string; // Base64-encoded 16-byte authentication tag
  kid?: string; // First 16 hex chars of SHA-256 of the device secret used to encrypt
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
  'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'fallback' | 'unsupported'; // Plugin not installed on this server

// Plex SSE notification container (outer wrapper)
export interface PlexSSENotification {
  NotificationContainer: {
    type: string;
    size: number;
    PlaySessionStateNotification?: PlexPlaySessionNotification[];
    ActivityNotification?: PlexActivityNotification[];
    StatusNotification?: PlexStatusNotification[];
    TranscodeSession?: PlexTranscodeNotification[];
    TimelineEntry?: PlexTimelineEntry[];
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

// Library item lifecycle notification (add/scan/delete), sent as 'timeline' events.
// state: 0-4 are in-progress metadata processing steps, 5 = fully processed/added,
// 9 = deleted. These values are inferred from community SSE consumers (Plex does
// not document them); a wrong guess just means the event is ignored, not acted on.
export interface PlexTimelineEntry {
  identifier: string;
  sectionID?: number;
  itemID: number;
  type: number;
  title?: string;
  state: number;
  updatedAt?: number;
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
      deviceID: string;
      metadataID: string;
      partID: string;
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
  pluginVersion?: string | null;
}

// Diagnosis for an SSE endpoint that 404s, from the server's own plugin list:
// 'missing' not installed; 'blocked' installed and active but the endpoint is
// unreachable (usually a reverse proxy); 'restart_required' installed, server
// restart pending; 'malfunctioned' failed to load; 'unknown' could not check.
export type PluginIssue = 'missing' | 'blocked' | 'restart_required' | 'malfunctioned' | 'unknown';

// Per-server connection status surfaced to clients
// Covers all server types (plex/jellyfin/emby) with a unified shape
export interface ServerConnectionStatus {
  serverId: string;
  serverName: string;
  serverType: ServerType;
  mode: 'realtime' | 'polling';
  state: SSEConnectionState;
  lastEventAt: string | null;
  since: string | null;
  error: string | null;
  pluginVersion: string | null;
  pluginUpdateAvailable: boolean;
  // Only set while state is 'unsupported'; null otherwise
  pluginIssue: PluginIssue | null;
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
  serverName: string | null; // Joined from servers table
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
  grandparentTitle: string | null; // Show name (for episodes)
  seasonNumber: number | null; // Season number (for episodes)
  episodeNumber: number | null; // Episode number (for episodes)
  year: number | null; // Release year
  artistName: string | null; // Artist name (for music tracks)
  albumName: string | null; // Album name (for music tracks)
}

// =============================================================================
// Plex Server Discovery Types
// =============================================================================

// Reachability error categorization for a tested Plex connection
export type PlexConnectionErrorCode =
  'timeout' | 'dns' | 'refused' | 'unreachable' | 'reset' | 'tls' | 'http' | 'unknown';

export interface PlexConnectionError {
  code: PlexConnectionErrorCode;
  message: string; // Server-side detail (hostname, TLS reason, etc.)
  status?: number; // Set when code === 'http'
}

// Connection details for a discovered Plex server
export interface PlexDiscoveredConnection {
  uri: string;
  local: boolean;
  address: string;
  port: number;
  reachable: boolean; // Tested from Tracearr server
  latencyMs: number | null; // Response time if reachable
  custom?: boolean; // True for user-supplied URLs (not from plex.tv resources)
  error?: PlexConnectionError; // Set when reachable === false
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
// Plex Account Types (Multi-Account Support)
// =============================================================================

// Linked Plex account (for server discovery and management)
export interface PlexAccount {
  id: string;
  plexAccountId: string; // Plex.tv account ID
  plexUsername: string | null;
  plexEmail: string | null;
  plexThumbnail: string | null;
  allowLogin: boolean; // Whether this account can be used for authentication
  serverCount: number; // Number of Tracearr servers linked to this account
  liveServerCount: number; // Those still contacted; historical servers no longer block unlinking
  createdAt: Date;
}

// Response from GET /auth/plex/accounts
export interface PlexAccountsResponse {
  accounts: PlexAccount[];
  /**
   * This install's Plex client identifier. The browser creates the link PIN and
   * the server redeems it, and plex.tv only honours a redemption from the
   * identifier that created the PIN, so both ends must use this exact value.
   */
  clientIdentifier: string;
}

// Request body for POST /auth/plex/link-account
export interface LinkPlexAccountRequest {
  pin: string; // Plex OAuth PIN
}

// Response from POST /auth/plex/link-account
export interface LinkPlexAccountResponse {
  account: PlexAccount;
}

// Response from DELETE /auth/plex/accounts/:id
export interface UnlinkPlexAccountResponse {
  success: boolean;
}

/**
 * refreshed - was already linked to this account, token replaced
 * adopted   - plex.tv confirmed this account owns it, so the link was corrected
 * unmatched - no link, and plex.tv could not confirm ownership; still broken
 */
export type ReauthorizedServerStatus = 'refreshed' | 'adopted' | 'unmatched';

export interface ReauthorizedServer {
  id: string;
  name: string;
  status: ReauthorizedServerStatus;
  ok: boolean; // Verified admin access with the new token; always false when unmatched
}

// Response from POST /auth/plex/accounts/:id/reauthorize
export interface ReauthorizePlexAccountResponse {
  account: PlexAccount;
  servers: ReauthorizedServer[];
}

// =============================================================================
// Maintenance Job Types
// =============================================================================

export type MaintenanceJobCategory = 'normalization' | 'backfill' | 'cleanup';

export type MaintenanceJobType =
  | 'normalize_players'
  | 'normalize_countries'
  | 'fix_imported_progress'
  | 'rebuild_timescale_views'
  | 'normalize_codecs'
  | 'normalize_resolutions'
  | 'backfill_user_dates'
  | 'backfill_library_snapshots'
  | 'normalize_library_snapshots'
  | 'cleanup_old_chunks'
  | 'full_aggregate_rebuild'
  | 'repair_corrupted_chunks'
  | 'backfill_session_identity'
  | 'remove_import_duplicates'
  | 'link_imported_history'
  | 'sync_server_locations';

export type MaintenanceJobStatus = 'idle' | 'waiting' | 'running' | 'complete' | 'error';

export interface MaintenanceJobProgress {
  type: MaintenanceJobType;
  status: MaintenanceJobStatus;
  totalRecords: number;
  processedRecords: number;
  updatedRecords: number;
  skippedRecords: number;
  errorRecords: number;
  message: string;
  startedAt?: string;
  completedAt?: string;
  /** Present when status='waiting' - what this job is waiting for */
  waitingFor?: HeavyOpsWaitingFor;
}

export interface MaintenanceJobResult {
  success: boolean;
  type: MaintenanceJobType;
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
  durationMs: number;
  message: string;
}

// =============================================================================
// Running Tasks Types (unified task status for UI)
// =============================================================================

export type RunningTaskType =
  | 'library_sync'
  | 'tautulli_import'
  | 'jellystat_import'
  | 'playback_reporting_import'
  | 'image_precache'
  | 'maintenance';

export interface RunningTask {
  /** Unique task identifier */
  id: string;
  /** Task type for categorization */
  type: RunningTaskType;
  /** Human-readable task name */
  name: string;
  /** Current status */
  status: 'pending' | 'waiting' | 'running' | 'complete' | 'error';
  /** Progress percentage (0-100), null if indeterminate */
  progress: number | null;
  /** Current status message */
  message: string;
  /** When the task started */
  startedAt: string;
  /** Additional context (e.g., server name, job type) */
  context?: string;
  /** What the task is waiting for (only when status is 'waiting') */
  waitingFor?: HeavyOpsWaitingFor;
}

export interface RunningTasksResponse {
  tasks: RunningTask[];
}

// =============================================================================
// Engagement Tracking Types
// =============================================================================

// Engagement tier based on cumulative watch completion percentage
export type EngagementTier =
  | 'abandoned' // < 20%
  | 'sampled' // 20-49%
  | 'engaged' // 50-84%
  | 'watched' // 85%+ (matches WATCH_COMPLETION_THRESHOLD)
  | 'rewatched' // 200%+
  | 'unknown'; // Missing duration data

// User behavior classification based on engagement patterns
export type UserBehaviorType =
  | 'inactive' // No activity
  | 'sampler' // >50% abandoned
  | 'casual' // Default
  | 'completionist' // >70% finished
  | 'rewatcher'; // >20% rewatched

// Individual content engagement (from content_engagement_summary view)
export interface ContentEngagement {
  ratingKey: string;
  mediaTitle: string;
  showTitle: string | null;
  mediaType: MediaType;
  thumbPath: string | null;
  serverId: string | null;
  year: number | null;
  plays: number; // Netflix-style calculated plays
  completionPct: number;
  engagementTier: EngagementTier;
  cumulativeWatchedMs: number;
  validSessions: number;
  totalSessions: number;
  firstWatchedAt: Date;
  lastWatchedAt: Date;
}

// Top content with engagement metrics (from top_content_by_plays view)
export interface TopContentEngagement {
  ratingKey: string;
  title: string;
  showTitle: string | null;
  type: MediaType;
  thumbPath: string | null;
  serverId: string | null;
  year: number | null;
  totalPlays: number;
  totalWatchHours: number;
  uniqueViewers: number;
  validSessions: number;
  totalSessions: number;
  completions: number;
  rewatches: number;
  abandonments: number;
  completionRate: number;
  abandonmentRate: number;
}

// Show-level engagement (from top_shows_by_engagement view)
export interface ShowEngagement {
  showTitle: string;
  thumbPath: string | null;
  serverId: string | null;
  year: number | null;
  totalEpisodeViews: number;
  totalWatchHours: number;
  uniqueViewers: number;
  avgEpisodesPerViewer: number;
  avgCompletionRate: number;
  bingeScore: number;
  validSessions: number;
  totalSessions: number;
}

// User engagement profile (from user_engagement_profile view)
export interface UserEngagementProfile {
  serverUserId: string;
  username: string;
  thumbUrl: string | null;
  identityName: string | null;
  contentStarted: number;
  totalPlays: number;
  totalWatchHours: number;
  validSessionCount: number;
  totalSessionCount: number;
  abandonedCount: number;
  sampledCount: number;
  engagedCount: number;
  watchedCount: number;
  rewatchedCount: number;
  completionRate: number;
  behaviorType: UserBehaviorType;
  favoriteMediaType: MediaType | null;
}

// Engagement tier breakdown for summary stats
export interface EngagementTierBreakdown {
  tier: EngagementTier;
  count: number;
  percentage: number;
}

// Main engagement stats response
export interface EngagementStats {
  topContent: TopContentEngagement[];
  topShows: ShowEngagement[];
  engagementBreakdown: EngagementTierBreakdown[];
  userProfiles: UserEngagementProfile[];
  // Summary metrics
  summary: {
    totalPlays: number;
    totalValidSessions: number;
    totalAllSessions: number;
    sessionInflationPct: number; // How much overcounting would occur with raw sessions
    avgCompletionRate: number;
  };
}

// Show stats response (for GET /stats/shows)
export interface ShowStatsResponse {
  data: ShowEngagement[];
  total: number;
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
    isPrerelease: boolean; // Whether current version is a prerelease (beta, alpha, rc)
  };
  // Latest available version (null if check hasn't run yet)
  latest: {
    version: string;
    tag: string;
    releaseUrl: string;
    publishedAt: string;
    isPrerelease: boolean; // Whether this update is a prerelease
    releaseName: string | null; // Release title from GitHub
    releaseNotes: string | null; // Release body/notes from GitHub (markdown)
    upgradeWarnings: UpgradeWarning[]; // Warnings from every release between current and latest, newest first
  } | null;
  // Update status
  updateAvailable: boolean;
  // When the last check occurred (ISO timestamp)
  lastChecked: string | null;
}

// =============================================================================
// Device Compatibility Types
// =============================================================================

// Device-codec compatibility row
export interface DeviceCompatibilityRow {
  deviceType: string;
  videoCodec: string;
  audioCodec: string;
  sessionCount: number;
  videoDirectCount: number;
  audioDirectCount: number;
  fullDirectCount: number;
  anyTranscodeCount: number;
  videoDirectPct: number;
  audioDirectPct: number;
  fullDirectPct: number;
}

// Device compatibility response with summary
export interface DeviceCompatibilityResponse {
  data: DeviceCompatibilityRow[];
  summary: {
    totalSessions: number;
    directPlayPct: number;
    uniqueDevices: number;
    uniqueCodecs: number;
  };
}

// Simplified matrix view for heatmap display
export interface DeviceCompatibilityMatrix {
  codecs: string[];
  devices: {
    device: string;
    codecs: Record<string, { sessions: number; directPct: number }>;
  }[];
}

// Device health ranking row
export interface DeviceHealthRow {
  serverId: string;
  device: string;
  sessions: number;
  directPlayCount: number;
  transcodeCount: number;
  directPlayPct: number;
}

// Device health response
export interface DeviceHealthResponse {
  data: DeviceHealthRow[];
}

// Transcode hotspot row
export interface TranscodeHotspotRow {
  serverId: string;
  device: string;
  videoCodec: string;
  audioCodec: string;
  sessions: number;
  directCount: number;
  transcodeCount: number;
  directPlayPct: number;
  pctOfTotalTranscodes: number;
}

// Transcode hotspots response
export interface TranscodeHotspotsResponse {
  data: TranscodeHotspotRow[];
  totalTranscodes: number;
}

// Top transcoding user row
export interface TopTranscodingUserRow {
  serverId: string;
  serverUserId: string;
  username: string;
  identityName: string | null;
  avatar: string | null;
  totalSessions: number;
  directPlayCount: number;
  transcodeCount: number;
  directPlayPct: number;
  pctOfTotalTranscodes: number;
}

// Top transcoding users response
export interface TopTranscodingUsersResponse {
  data: TopTranscodingUserRow[];
  totalTranscodes: number;
}

// =============================================================================
// Bandwidth Stats Types
// =============================================================================

// Daily bandwidth row
export interface DailyBandwidthRow {
  date: string;
  /** Server this row belongs to - required for per-server chart series */
  serverId: string;
  sessions: number;
  /** Total data transferred in bytes */
  totalBytes: number;
  /** Total data transferred in GB (human-readable) */
  totalGb: number;
  avgBitrate: number;
  peakBitrate: number;
  totalDurationMs: number;
  avgBitrateMbps: number;
  totalHours: number;
}

// Daily bandwidth response
export interface DailyBandwidthResponse {
  data: DailyBandwidthRow[];
  usingAggregate: boolean;
}

// Top bandwidth user
export interface BandwidthTopUser {
  username: string;
  /** Display name from linked identity (null if no linked user) */
  identityName: string | null;
  /** Avatar URL from server user */
  thumbUrl: string | null;
  /** Representative account id, used for navigation (routes to /users/:id) */
  serverUserId: string;
  /** Representative account's server - a merged identity is one row, bytes summed across servers */
  serverId: string;
  /** Total data transferred in bytes */
  totalBytes: number;
  /** Total data transferred in GB (human-readable) */
  totalGb: number;
  sessions: number;
  avgBitrate: number;
  totalDurationMs: number;
  avgBitrateMbps: number;
  totalHours: number;
}

// Top bandwidth users response
export interface BandwidthTopUsersResponse {
  data: BandwidthTopUser[];
}

// Per-server KPI slice used inside BandwidthSummary.byServer
export interface BandwidthSummaryServerKpis {
  totalSessions: number;
  totalBytes: number;
  totalGb: number;
  avgBitrate: number;
  peakBitrate: number;
  minBitrate: number;
  medianBitrate: number;
  totalDurationMs: number;
  uniqueUsers: number;
  avgBitrateMbps: number;
  peakBitrateMbps: number;
  totalHours: number;
}

// Bandwidth summary
export interface BandwidthSummary {
  totalSessions: number;
  /** Total data transferred in bytes */
  totalBytes: number;
  /** Total data transferred in GB (human-readable) */
  totalGb: number;
  avgBitrate: number;
  peakBitrate: number;
  minBitrate: number;
  medianBitrate: number;
  totalDurationMs: number;
  uniqueUsers: number;
  avgBitrateMbps: number;
  peakBitrateMbps: number;
  totalHours: number;
  /** Per-server KPI breakdown keyed by server ID (present when multiple servers selected) */
  byServer?: Record<string, BandwidthSummaryServerKpis>;
}

// =============================================================================
// Library Statistics Types
// =============================================================================

/** Titles per resolution bucket. Buckets overlap: a 4K+1080p title counts in both. */
export type ResolutionCounts = Record<ResolutionBucket, number>;

// Library Stats Response (GET /library/stats)
export interface LibraryStatsResponse {
  totalItems: number;
  totalSizeBytes: string;
  movieCount: number;
  episodeCount: number;
  showCount: number;
  qualityBreakdown: ResolutionCounts;
  asOf: string | null;
}

// Library Growth Response (GET /library/growth)
export interface GrowthDataPoint {
  day: string;
  total: number;
  additions: number;
  /** Server that produced this data point (present in multi-server responses) */
  serverId: string;
}

export interface LibraryGrowthResponse {
  period: string;
  movies: GrowthDataPoint[];
  episodes: GrowthDataPoint[];
  music: GrowthDataPoint[];
}

// Library Quality Response (GET /library/quality)
export interface QualityDataPoint {
  day: string;
  totalItems: number;
  counts: ResolutionCounts;
  hevcCount: number;
  h264Count: number;
  av1Count: number;
}

export interface LibraryQualityResponse {
  period: string;
  mediaType: 'all' | 'movie' | 'show';
  data: QualityDataPoint[];
}

// Library Storage Response (GET /library/storage)
export interface StorageHistoryPoint {
  day: string;
  totalSizeBytes: string;
}

export interface StoragePrediction {
  predicted: string;
  min: string;
  max: string;
}

/** One library of the server, sized from its live items */
export interface StorageLibraryRow {
  /** The media server's own library id */
  libraryId: string;
  name: string;
  /** Server-native: Plex movie/show/artist, Jellyfin and Emby movies/tvshows/music */
  mediaType: string;
  /** Active items with at least one active version larger than zero bytes */
  itemCount: number;
  sizeBytes: number;
}

export interface LibraryStorageResponse {
  current: {
    totalSizeBytes: string;
    totalItems: number;
    lastUpdated: string | null;
  };
  history: StorageHistoryPoint[];
  growthRate: {
    bytesPerDay: string;
    bytesPerWeek: string;
    bytesPerMonth: string;
    /** Days of history behind the numbers; below minDataDays they are unusable */
    fitDays?: number;
    /**
     * Which side of the mediaVersionsBackfilledAt changeover the fit ran on.
     * 'preChangeover' means old-semantics history is standing in until the
     * post-changeover side accumulates minDataDays of snapshots.
     */
    basis?: 'current' | 'preChangeover';
  };
  predictions: {
    day30: StoragePrediction | null;
    day90: StoragePrediction | null;
    day365: StoragePrediction | null;
    confidence: 'high' | 'medium' | 'low' | null;
    minDataDays: number;
    currentDataDays: number;
    message?: string;
  };
  /** Largest first; libraries with no sized items are listed with zeros */
  libraries: StorageLibraryRow[];
}

// Library Duplicates Response (GET /library/duplicates)
/** 'version' groups are one title whose single library item carries several
 * physical files; the others group distinct items (copies) by identity. */
export type MatchType = 'imdb' | 'tmdb' | 'tvdb' | 'mbid' | 'fuzzy' | 'version';

/** One physical file of a duplicate item */
export interface DuplicateItemVersion {
  /** The server's own id for this file, what a file-existence check answers by */
  serverVersionKey: string;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  fileSize: number | null;
  filePath: string | null;
  /**
   * The same physical file already listed elsewhere in the group (equal byte
   * size, the codebase-wide mirror heuristic). Jellyfin merged-version
   * libraries list every file under every library entry; mirrors keep the
   * listing honest without counting the file twice.
   */
  isMirror?: boolean;
}

export interface DuplicateItem {
  id: string;
  serverId: string;
  serverName: string;
  libraryId: string | null;
  libraryName: string | null;
  title: string;
  year: number | null;
  mediaType: string;
  /** Show for an episode, artist for a track; null for anything flat */
  grandparentTitle: string | null;
  /** Album for a track, season for an episode */
  parentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  fileSize: number | null;
  resolution: string | null;
  versions: DuplicateItemVersion[];
}

export interface DuplicateGroup {
  matchKey: string;
  matchType: MatchType;
  confidence: number;
  serverCount: number;
  /** All copies live on one server (cross-library copies or one item's versions) */
  sameServer: boolean;
  items: DuplicateItem[];
  /**
   * Distinct physical files in the group after mirror dedup. Optional only
   * because responses cached before the field existed can still be served
   * for up to an hour; the server always sets it.
   */
  uniqueFileCount?: number;
  /** Mirror-deduped bytes: the same physical file (equal size) counts once */
  totalStorageBytes: number;
  /** Bytes freed by keeping only the best-quality file */
  potentialSavingsBytes: number;
}

export interface DuplicatesSummary {
  totalGroups: number;
  totalDuplicateItems: number;
  totalPotentialSavingsBytes: number;
  byMatchType: {
    imdb: number;
    tmdb: number;
    tvdb: number;
    mbid: number;
    fuzzy: number;
    version: number;
  };
}

export interface DuplicatesResponse {
  duplicates: DuplicateGroup[];
  summary: DuplicatesSummary;
  pagination: { page: number; pageSize: number; total: number };
}

// Duplicate file existence (GET /library/duplicates/files)
/** One file the server was asked about, by the item it belongs to and its version key */
export interface DuplicateFileStatus {
  itemId: string;
  serverVersionKey: string;
  exists: boolean;
}

export interface DuplicateFilesResponse {
  /**
   * False when no server in the requested set can answer (only Plex can) or
   * the probe failed. Callers show nothing rather than guess at a missing file.
   */
  checked: boolean;
  files: DuplicateFileStatus[];
}

// Library Stale Content Response (GET /library/stale)
export type StaleCategory = 'never_watched' | 'stale';

export interface StaleItem {
  id: string;
  serverId: string;
  serverName: string;
  libraryId: string;
  libraryName: string;
  title: string;
  mediaType: string;
  year: number | null;
  fileSize: number | null;
  resolution: string | null;
  addedAt: string;
  lastWatched: string | null;
  watchCount: number;
  category: StaleCategory;
  daysStale: number;
}

export interface StaleSummary {
  neverWatched: { count: number; sizeBytes: number };
  stale: { count: number; sizeBytes: number };
  total: { count: number; sizeBytes: number };
  threshold: { days: number };
}

export interface StaleResponse {
  items: StaleItem[];
  summary: StaleSummary;
  pagination: { page: number; pageSize: number; total: number };
}

// Library Watch Statistics Response (GET /library/watch)

/** Titles by what happened to them in the window; the three add up to the titles in scope. */
export interface CompletionCounts {
  completed: number;
  inProgress: number;
  notStarted: number;
}

/**
 * Movies and episodes counted one by one by media identity. totalItems and notStarted cover
 * the titles in scope regardless of the window; everything else is activity in the window.
 */
export interface WatchSummary {
  totalItems: number;
  /** Titles with at least one counted play in the window. */
  watchedCount: number;
  watchedPct: number;
  totalWatchMs: number;
  avgPlaysPerItem: number;
  completion: { movie: CompletionCounts; episode: CompletionCounts };
}

export interface WatchResponse {
  summary: WatchSummary;
}

export type WatchedState = 'watched' | 'partial' | 'unwatched';

// Catalog browse endpoint (GET /library/catalog)

export interface CatalogRowServerEntry {
  serverId: string;
  addedAt: string;
  videoResolution: string | null;
  fileSize: number | null;
  /** Active physical files of this copy (1 for single-version titles) */
  versionCount: number;
}

export interface CatalogRow {
  mediaId: string;
  mediaType: LibraryMediaType;
  title: string;
  year: number | null;
  genres: string[];
  posterUrl: string | null;
  posterVersion: string | null;
  dominantColor: string | null;
  servers: CatalogRowServerEntry[];
  resolutionBest: string | null;
  watchedState: WatchedState;
  /** Same probe, scoped to the requesting admin's own identity instead of
   * the anyone-grain lens - "have I personally watched this". Absent for artists. */
  watchedStateSelf?: WatchedState;
  plays: number;
  viewers: number;
  /** Artists only: distinct album titles across the artist's copies in scope. */
  albumCount?: number;
}

export interface CatalogResponseMeta {
  /** Absolute row offset this window starts at, echoing the request. */
  offset: number;
  pageSize: number;
  totalItems: number;
  totalFileSize: number;
}

export interface CatalogResponse {
  data: CatalogRow[];
  meta: CatalogResponseMeta;
}

// Catalog letter index (GET /library/catalog/letters) - per-letter title
// counts for the same filter set as the catalog page query, so the frontend
// can derive letter -> cumulative row offset for the alphabet rail.
// Fixed 27-entry set, '#' FIRST then A-Z, zero counts included, in that
// order - the frontend needs a stable, complete key set to build offsets
// without special-casing an absent letter. Buckets are collation ranges over
// media.sort_title (article-stripped, so "The Matrix" counts under M): '#'
// is everything sorting below 'a' (digit-leading and empty sort titles),
// which is why it leads - those rows sit before every letter in the catalog
// ordering, and a bucket ordered A-Z-then-# would compute wrong offsets.
export interface CatalogLetterBucket {
  /** '#' or 'A'..'Z'. */
  letter: string;
  count: number;
}

export interface CatalogLettersResponse {
  letters: CatalogLetterBucket[];
}

/** GET /library/catalog/codecs: codec display names for the browse filters, most common first. */
export interface CatalogCodecOptionsResponse {
  video: string[];
  audio: string[];
  /** Channel layouts as the charts name them ('Stereo', '5.1'). */
  channels: string[];
}

// Shelves endpoint (GET /library/shelves) - windowed library command center:
// four type-split shelves, a KPI strip, and a dead-weight (storage reclaim)
// module. All-users aggregate (no per-viewer lens) so the whole payload is
// cacheable verbatim per (scope, period).

// Shelves are cached verbatim for every viewer (no per-viewer lens), so a
// shelf row deliberately carries no self-watched state.
export type ShelfRow = Omit<CatalogRow, 'plays' | 'viewers' | 'watchedStateSelf'>;

/** Same period convention as statsQuerySchema/TimeRangeValue on the frontend. */
export type ShelvesPeriod = z.infer<typeof statPeriodSchema>;

export interface RecentlyAddedShelfRow extends ShelfRow {
  /** Newly-tracked episode count for a show card; always null for movies. */
  newEpisodes: number | null;
  /** When the newest qualifying episode arrived. Null for movies, whose own
   *  copy date already says it; a show's copy date is when the series first
   *  appeared, which is years off once episodes keep arriving. */
  newestEpisodeAt: string | null;
}

/** A title whose file this server replaced: the old copy left and a new one took its place. */
export interface RecentlyUpdatedShelfRow extends ShelfRow {
  /** Replaced episode count for a show card; always null for movies. */
  replacedEpisodes: number | null;
  /** When the newest replaced episode arrived; null for movies. */
  newestEpisodeAt: string | null;
}

export interface MostPopularShelfRow extends ShelfRow {
  /** Absent for a member: how many people watched is the owner's to show. */
  plays?: number;
  viewers?: number;
  rank: number;
}

export interface DeadWeightRow extends ShelfRow {
  fileBytes: number;
  /** Null when the title's canonical media row has never had latest_added_at
   * stamped (no active library copy has ever been synced). */
  addedAt: string | null;
}

export interface ShelvesKpiWatchedInPeriod {
  /**
   * Distinct canonical titles (movies + shows) with >=1 play in the window. Absent for a member
   * while the owner's memberServerActivity is off.
   */
  titlesTouched?: number;
  /** Total canonical titles (movies + shows) in scope, all-time. */
  totalTitles: number;
}

export interface ShelvesKpiNewlyAdded {
  /** Canonical titles (movies + shows) added within the window. */
  count: number;
  totalBytes: number;
  /** Of the titles added in the window, how many have ever been played. Omitted for members without server activity. */
  playedCount?: number;
}

export interface ShelvesKpiDeadWeight {
  /** All-time never-watched canonical title count (not window-scoped). */
  count: number;
  totalBytes: number;
}

export interface ShelvesKpis {
  watchedInPeriod: ShelvesKpiWatchedInPeriod;
  /**
   * Total watched time across the window, in seconds. Absent for a member while the owner's
   * memberServerActivity is off.
   */
  hoursWatched?: number;
  newlyAdded: ShelvesKpiNewlyAdded;
  /** Omitted when the request opts out via includeDeadWeight=false. */
  deadWeight?: ShelvesKpiDeadWeight;
}

export interface ShelvesResponseMeta {
  movies: number;
  shows: number;
  artists: number;
  albums: number;
  totalFileSize: number;
}

/** One server's album row; albums do not fold across servers here. */
export interface AlbumShelfRow {
  serverId: string;
  ratingKey: string;
  title: string;
  artistTitle: string | null;
  /** The artist copy's media row, for linking to the artist page. */
  artistMediaId: string | null;
  year: number | null;
  posterUrl: string | null;
  posterVersion: string | null;
  addedAt: string;
}

export interface ShelvesResponse {
  period: ShelvesPeriod;
  recentlyAddedMovies: RecentlyAddedShelfRow[];
  recentlyAddedShows: RecentlyAddedShelfRow[];
  recentlyUpdated: RecentlyUpdatedShelfRow[];
  mostPopularMovies: MostPopularShelfRow[];
  mostPopularShows: MostPopularShelfRow[];
  recentlyAddedAlbums: AlbumShelfRow[];
  mostPlayedArtists: MostPopularShelfRow[];
  deadWeight?: DeadWeightRow[];
  kpis: ShelvesKpis;
  meta: ShelvesResponseMeta;
}

// Genres aggregate endpoint (GET /library/genres)

export interface GenreTopViewer {
  userId: string;
  serverUserId: string;
  name: string;
  /** Raw avatar path of the viewer's busiest account, proxied through serverId. */
  thumbUrl: string | null;
  serverId: string;
  /** Percent of the genre's counted plays */
  share: number;
}

export interface GenreRow {
  genre: string;
  /** All-time canonical items */
  itemCount: number;
  /** All-time, deduped like mediaSizeSubquery */
  sizeBytes: number;
  /** Counted chains in range */
  plays: number;
  /** Null when the range is all time */
  priorPlays: number | null;
  watchTimeMs: number;
  /** Percent of judged chains finished; null when no chain was judged */
  finishedRate: number | null;
  topViewer: GenreTopViewer | null;
  neverPlayed: { count: number; bytes: number };
  /** Counted plays in 7 equal buckets across the range, oldest first */
  trend: number[];
}

export interface GenresResponse {
  data: GenreRow[];
  /** All genres of the type, over the range, in the viewer's timezone */
  hourly: HourOfDayStats[];
  totals: { items: number; plays: number; priorPlays: number | null };
  range: { start: string | null; end: string; priorStart: string | null; priorEnd: string | null };
}

export interface GenreTitle {
  mediaId: string;
  title: string;
  year: number | null;
  serverId: string;
  thumbPath: string | null;
  plays: number;
  sizeBytes: number;
}

export interface GenreDetailResponse {
  genre: string;
  kpis: {
    plays: number;
    priorPlays: number | null;
    finishedRate: number | null;
    abandonedRate: number | null;
    itemCount: number;
    sizeBytes: number;
    itemShare: number | null;
    playShare: number | null;
  };
  weekly: RangeSeriesPoint[];
  priorWeekly: RangeSeriesPoint[];
  hourly: HourOfDayStats[];
  /** Top three */
  topViewers: GenreTopViewer[];
  /** Top eight by plays */
  topTitles: GenreTitle[];
  /** Top eight by size among titles with no counted play */
  neverPlayed: GenreTitle[];
}

// Media detail endpoints (GET /library/media/:id and sub-resources)

/** One physical file of a library copy */
export interface MediaVersionEntry {
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  dynamicRange: string | null;
  audioAtmos?: boolean;
  editionTitle?: string | null;
  container: string | null;
  fileSize: number | null;
}

export interface MediaAvailabilityEntry {
  serverId: string;
  serverType: string;
  libraryId: string;
  /** Library display name, null until that server's library sync has recorded it. */
  libraryName: string | null;
  ratingKey: string;
  addedAt: string;
  removedAt: string | null;
  videoResolution: string | null;
  fileSize: number | null;
  /** Show rows only: summed episode file bytes for this server+library; null for movies/episodes. */
  episodeFileSize: number | null;
  /** Show rows only: distinct episode resolutions ordered by frequency desc; null for movies/episodes. */
  episodeResolutions: string[] | null;
  /** Show rows only: active episode count for this server+library; null for movies/episodes. */
  episodeCount: number | null;
  /** Physical files of this copy, largest first. Empty for containers. */
  versions: MediaVersionEntry[];
  /** The copy this one replaced (event-witnessed upgrade); null when none was witnessed. */
  replaces: MediaReplacedCopy | null;
}

export interface MediaReplacedCopy {
  addedAt: string;
  removedAt: string;
  videoResolution: string | null;
  fileSize: number | null;
}

export interface MediaDetailResponse {
  id: string;
  mediaType: string;
  title: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  genres: string[] | null;
  showMediaId: string | null;
  mergedIds: string[];
  availability: MediaAvailabilityEntry[];
  seasonCount: number | null;
  episodeCount: number | null;
  posterUrl: string | null;
  posterVersion: string | null;
  dominantColor: string | null;
  downloads: MediaDownloadRow[];
}

export interface MediaChildEntry {
  id: string;
  mediaType: 'season' | 'episode' | 'album';
  title: string;
  seasonNumber: number | null;
  episodeCount: number | null;
  episodeNumber: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  showMediaId: string | null;
  genres: string[] | null;
  /** Albums only: one entry per server copy, art and date from that copy. */
  year?: number | null;
  thumbPath?: string | null;
  serverId?: string;
  addedAt?: string;
  trackCount?: number;
}

export interface MediaChildrenResponse {
  data: MediaChildEntry[];
}

export interface AlbumCopy {
  serverId: string;
  ratingKey: string;
}

export interface AlbumListener {
  name: string;
  plays: number;
  /** Percent of the album's all-time plays. */
  share: number;
}

export interface AlbumTrack {
  index: number | null;
  title: string;
  durationMs: number | null;
  plays: number;
  lastPlayedAt: string | null;
}

/** GET /library/media/:id/album. Tracks are deduped by number and title across the album's copies. */
export interface AlbumDetailResponse {
  album: {
    id: string;
    title: string;
    artistTitle: string | null;
    artistMediaId: string | null;
    year: number | null;
    trackCount: number;
    durationMs: number | null;
    addedAt: string;
    posterUrl: string | null;
    posterVersion: string | null;
    copies: AlbumCopy[];
  };
  last30: { plays: number; priorPlays: number; listenMs: number };
  /** `listeners` is empty when the caller may not see other people's activity. */
  allTime: { plays: number; listeners: AlbumListener[]; finishedRate: number | null };
  tracks: AlbumTrack[];
}

export interface MediaStatsMeasures {
  plays: number;
  watchTimeMs: number;
  uniqueUsers: number;
}

export interface MediaStatsWindow {
  combined: MediaStatsMeasures;
  perServer: (MediaStatsMeasures & { serverId: string; serverName: string | null })[];
}

export interface MediaStatsResponse {
  mediaId: string;
  mediaType: string;
  windows: { all_time: MediaStatsWindow; last_30: MediaStatsWindow; last_7: MediaStatsWindow };
}

export interface MediaWatcherEntry {
  user: {
    serverUserId: string;
    userId: string;
    serverId: string;
    username: string | null;
    identityName: string | null;
    /** Identity thumbnail when set, else the server account's avatar. */
    thumb: string | null;
  };
  plays: number;
  watchTimeMs: number;
  completionPct: number | null;
  lastWatchedDay: string | null;
  distinctEpisodesWatched: number | null;
}

export interface MediaWatchersResponse {
  mediaId: string;
  mediaType: string;
  window: 'all_time' | 'last_30' | 'last_7';
  watchers: MediaWatcherEntry[];
  /** Members only: watchers left out because they are other people */
  othersCount?: number;
}

export interface MediaPlatformBreakdownEntry {
  platform: string | null;
  player: string | null;
  plays: number;
  watchTimeMs: number;
}

export interface MediaPlatformBreakdownResponse {
  data: MediaPlatformBreakdownEntry[];
}

export interface SeasonHeatEpisode {
  episodeNumber: number | null;
  watchedState: WatchedState;
}

export interface SeasonHeatSeason {
  seasonNumber: number | null;
  title: string;
  year: number | null;
  episodeCount: number;
  watchedCount: number;
  watchedPct: number;
  episodes: SeasonHeatEpisode[];
}

export interface MediaSeasonHeatResponse {
  mediaId: string;
  seasons: SeasonHeatSeason[];
}

// Library Watch Patterns Response (GET /library/patterns)

/**
 * A single binge-show row.
 * When multiple servers are in scope, episodes of the same show across
 * different servers are collapsed into one row (deduped by show matchKey).
 */
export interface BingeShow {
  /** Show identity, a merged alias folded into its winner. */
  showMediaId: string;
  showTitle: string;
  /** Server with the most episodes watched in this binge journey. */
  primaryServerId: string;
  thumbPath: string | null;
  totalEpisodeWatches: number;
  consecutiveEpisodes: number;
  consecutivePct: number;
  avgGapMinutes: number;
  bingeScore: number;
  maxEpisodesInOneDay: number;
  /** All server IDs involved in this binge journey. */
  serverIds: string[];
}

export interface HourlyDistribution {
  hour: number;
  watchCount: number;
  totalWatchMs: number;
  pctOfTotal: number;
}

export type TrendBucket = 'day' | 'week' | 'month';

export interface TrendPoint {
  /** Bucket start in the request timezone, YYYY-MM-DD. */
  start: string;
  watchCount: number;
  totalWatchHours: number;
}

export interface PatternsResponse {
  bingeShows: BingeShow[];
  peakTimes: {
    hourlyDistribution: HourlyDistribution[];
    peakHour: number;
    peakDayOfWeek: number;
  };
  trend: {
    bucket: TrendBucket;
    points: TrendPoint[];
    busiest: string | null;
    quietest: string | null;
  };
  summary: {
    totalWatchSessions: number;
    avgSessionsPerDay: number;
    bingeSessionsPct: number;
  };
}

// Library ROI Response (GET /library/roi)
export interface RoiItem {
  id: string;
  mediaId: string | null;
  serverId: string;
  serverName: string;
  /** Every selected server holding a copy of this title. */
  serverIds: string[];
  title: string;
  mediaType: 'movie' | 'show';
  year: number | null;
  fileSizeBytes: number;
  fileSizeGb: number;
  watchCount: number;
  totalWatchHours: number;
  watchHoursPerGb: number;
  /** All time, UTC day as YYYY-MM-DD. */
  lastWatchedAt: string | null;
}

export interface RoiSummary {
  totalItems: number;
  totalStorageGb: number;
  totalWatchHours: number;
  avgWatchHoursPerGb: number;
}

export interface RoiResponse {
  items: RoiItem[];
  summary: RoiSummary;
  pagination: { page: number; pageSize: number; total: number };
}

// Library Top Content Types (GET /library/top-movies, /library/top-shows)
export interface TopMovie {
  ratingKey: string;
  title: string;
  year: number | null;
  thumbPath: string | null;
  serverId: string;
  /** All server IDs that own a copy of this title (for per-title color dots). */
  serverIds?: string[];
  totalPlays: number;
  totalWatchHours: number;
  uniqueViewers: number;
  completionRate: number;
}

export interface TopMoviesSummary {
  totalMovies: number;
  totalWatchHours: number;
}

export interface TopMoviesResponse {
  items: TopMovie[];
  summary: TopMoviesSummary;
  pagination: { page: number; pageSize: number; total: number };
}

export interface TopShow {
  /** Canonical media id of the show, unique per row where titles may repeat. */
  mediaId: string;
  showTitle: string;
  year: number | null;
  thumbPath: string | null;
  serverId: string;
  /** All server IDs that own a copy of this title (for per-title color dots). */
  serverIds?: string[];
  totalEpisodeViews: number;
  totalWatchHours: number;
  uniqueViewers: number;
  avgCompletionRate: number;
  bingeScore: number;
}

export interface TopShowsSummary {
  totalShows: number;
  totalWatchHours: number;
}

export interface TopShowsResponse {
  items: TopShow[];
  summary: TopShowsSummary;
  pagination: { page: number; pageSize: number; total: number };
}

// ============================================================================
// Library Codecs Types
// ============================================================================

/** Single codec entry with count and percentage */
export interface CodecEntry {
  codec: string;
  count: number;
  percentage: number;
  /** Movie files in `count`; absent on music breakdowns. */
  movies?: number;
  /** Episode files in `count`; absent on music breakdowns. */
  episodes?: number;
  /** On the aggregated 'Other' entry: the names folded into it, most common first. */
  includes?: string[];
}

/** Codec breakdown for a category (video, audio, or music) */
export interface CodecBreakdown {
  codecs: CodecEntry[];
  total: number;
}

/** Response from /library/codecs endpoint */
export interface LibraryCodecsResponse {
  /** Video codecs for movies and episodes */
  video: CodecBreakdown;
  /** Audio codecs for movies and episodes */
  audio: CodecBreakdown;
  /** Audio channel configurations (Stereo, 5.1, 7.1, etc.) for movies and episodes */
  channels: CodecBreakdown;
  /** Audio codecs for music tracks */
  music: CodecBreakdown;
}

// ============================================================================
// Library Resolution Types
// ============================================================================

/** Resolution breakdown for a media type */
export interface ResolutionBreakdown {
  counts: ResolutionCounts;
  total: number;
}

/** Response from /library/resolution endpoint */
export interface LibraryResolutionResponse {
  /** Resolution breakdown for movies */
  movies: ResolutionBreakdown;
  /** Resolution breakdown for TV episodes */
  tv: ResolutionBreakdown;
}

// ============================================================================
// Library Options (catalog Library filter)
// ============================================================================

/** One server's library, for the catalog browse Library select. Grouped by
 * server on the frontend when the account has more than one. */
export interface LibraryOption {
  serverId: string;
  serverName: string;
  libraryId: string;
  name: string;
  mediaType: string;
}

/** Response from /library/libraries endpoint */
export interface LibrariesResponse {
  data: LibraryOption[];
}

// ============================================================================
// Backup & Restore
// ============================================================================

export interface BackupMetadata {
  format: 1;
  createdAt: string;
  app: {
    version: string;
    commit: string;
    tag: string;
  };
  database: {
    pgVersion: string;
    migrationCount: number;
    latestMigration: string;
    tableCount: number;
    databaseSize: number;
    timescaleVersion: string;
    timescaleToolkitVersion: string | null;
  };
  counts: {
    sessions: number;
    users: number;
    servers: number;
    /** Absent in manifests written before the rename, which count automations as `rules`. */
    automations?: number;
    libraryItems: number;
    rules?: number;
  };
}

export type RestorePhase =
  | 'validating'
  | 'creating_restore_point'
  | 'shutting_down'
  | 'restoring_database'
  | 'running_migrations'
  | 'rebuilding_aggregates'
  | 'restarting'
  | 'complete'
  | 'failed';

/** Ordered restore phases (excludes 'failed') for progress UI rendering. */
export const RESTORE_PHASES: Exclude<RestorePhase, 'failed'>[] = [
  'validating',
  'creating_restore_point',
  'shutting_down',
  'restoring_database',
  'running_migrations',
  'rebuilding_aggregates',
  'restarting',
  'complete',
];

export interface RestoreProgress {
  phase: RestorePhase;
  message: string;
  startedAt: string;
  error?: string;
  /** When phase is 'failed', indicates which phase the failure occurred in. */
  failedAtPhase?: Exclude<RestorePhase, 'failed'>;
}

export type BackupType = 'manual' | 'scheduled' | 'uploaded';

export interface BackupListItem {
  filename: string;
  size: number;
  createdAt: string;
  type: BackupType;
  metadata: BackupMetadata;
}

export type BackupScheduleType = 'disabled' | 'daily' | 'weekly' | 'monthly';
