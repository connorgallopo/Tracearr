/**
 * Poller Type Definitions
 *
 * Shared interfaces and types for the session polling system.
 * Separated from implementation for clean imports and testing.
 */

import type {
  Session,
  SessionState,
  EngineAutomation,
  ActiveSession,
  StreamDetailFields,
} from '@tracearr/shared';
import type { sessions } from '../../db/schema.js';
import type { SessionIdentity as MediaItemIdentity } from './database.js';
import type { CacheService, PubSubService } from '../../services/cache.js';
import type { GeoLocation } from '../../services/geoip.js';
import type { SessionGeo } from '../../services/serverLocations.js';
import type { SessionStopReason } from '../../services/automations/events/types.js';
import type { ViolationInsertResult } from './violations.js';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for the poller job
 */
export interface PollerConfig {
  /** Whether polling is enabled */
  enabled: boolean;
  /** Polling interval in milliseconds */
  intervalMs: number;
}

// ============================================================================
// Server Types
// ============================================================================

/**
 * Server data with decrypted token for API calls
 */
export interface ServerWithToken {
  id: string;
  name: string;
  type: 'plex' | 'jellyfin';
  url: string;
  token: string;
  /** Plex's machineIdentifier (the servers row carries it) */
  machineIdentifier?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Composite session identity for safer lookups.
 * Uses sessionKey as primary key, with optional ratingKey validation.
 */
export interface SessionIdentity {
  serverId: string;
  sessionKey: string;
  /** When provided, validates the session has this ratingKey */
  ratingKey?: string | null;
  /** When provided, only matches a row owned by this server user */
  serverUserId?: string | null;
}

/** JF/Emby session identity: user+device+content (stable across session.Id changes). */
export interface CompositeSessionIdentity {
  serverId: string;
  serverUserId: string;
  deviceId: string | null;
  ratingKey: string;
}

/** Input for building a session cache/tracking key. */
export interface BuildCompositeKeyInput {
  serverType: 'plex' | 'jellyfin' | 'emby';
  serverId: string;
  externalUserId: string;
  deviceId: string | null;
  ratingKey: string | null;
  sessionKey: string;
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Processed session format after mapping from MediaSession
 * Contains all fields needed for database storage and display.
 * Extends StreamDetailFields to inherit stream metadata fields.
 */
export interface ProcessedSession extends StreamDetailFields {
  /** Unique session key from media server */
  sessionKey: string;
  /** Plex Session.id - required for termination API (different from sessionKey) */
  plexSessionId?: string;
  /** Media item identifier (ratingKey for Plex, itemId for Jellyfin) */
  ratingKey: string;
  /** Identifier of the file/version being played, when the server reports one */
  serverVersionKey?: string | null;

  // User identification from media server
  /** External user ID from Plex/Jellyfin for lookup */
  externalUserId: string;
  /** Display name from media server */
  username: string;
  /** Avatar URL from media server */
  userThumb: string;

  // Media metadata
  /** Media title */
  mediaTitle: string;
  /** Media type classification */
  mediaType: 'movie' | 'episode' | 'track' | 'live' | 'photo' | 'unknown';
  /** Show name (for episodes) */
  grandparentTitle: string;
  /**
   * Season number (for episodes). Season 0 is Specials and is a valid value -
   * null means the season is genuinely unknown/unavailable, never coerce one into the other.
   */
  seasonNumber: number | null;
  /** Episode number (for episodes). Episode 0 is valid; null means unavailable. */
  episodeNumber: number | null;
  /** Release year */
  year: number;
  /** Poster path */
  thumbPath: string;

  // Live TV specific fields
  /** Channel name (e.g., "HBO", "ESPN") */
  channelTitle: string | null;
  /** Channel number or identifier */
  channelIdentifier: string | null;
  /** Channel logo/thumbnail path */
  channelThumb: string | null;
  /** Live TV session UUID (stable across channel changes, extracted from SSE key) */
  liveUuid: string | null;

  // Music track metadata
  /** Artist name */
  artistName: string | null;
  /** Album name */
  albumName: string | null;
  /** Track number in album */
  trackNumber: number | null;
  /** Disc number for multi-disc albums */
  discNumber: number | null;

  // Connection info
  /** Client IP address */
  ipAddress: string;
  /** Player/device name */
  playerName: string;
  /** Unique device identifier */
  deviceId: string;
  /** Product/app name (e.g., "Plex for iOS") */
  product: string;
  /** Device type (e.g., "iPhone") */
  device: string;
  /** Platform (e.g., "iOS") */
  platform: string;

  // Quality info
  /** Quality display string */
  quality: string;
  /** Whether stream is transcoded */
  isTranscode: boolean;
  /** Video decision: 'directplay' | 'copy' | 'transcode' */
  videoDecision: string;
  /** Audio decision: 'directplay' | 'copy' | 'transcode' */
  audioDecision: string;
  /** Bitrate in kbps */
  bitrate: number;

  // Playback state
  /** Current playback state */
  state: 'playing' | 'paused';
  /** Plex reports buffering; state above maps it to 'playing' */
  buffering: boolean;
  /** Total media duration in milliseconds */
  totalDurationMs: number;
  /** Current playback position in milliseconds */
  progressMs: number;

  /**
   * Jellyfin-specific: When the current pause started (from API).
   * More accurate than tracking pause transitions via polling.
   */
  lastPausedDate?: Date;

  /** Canonical media identity resolved from library_items, stamped at session insert. */
  identity?: MediaItemIdentity | null;
}

// ============================================================================
// Pause Tracking Types
// ============================================================================

/**
 * Result of pause accumulation calculation
 */
export interface PauseAccumulationResult {
  /** Timestamp when pause started (null if playing) */
  lastPausedAt: Date | null;
  /** Total accumulated pause duration in milliseconds */
  pausedDurationMs: number;
}

/**
 * Result of stop duration calculation
 */
export interface StopDurationResult {
  /** Actual watch duration excluding pause time in milliseconds */
  durationMs: number;
  /** Final total paused duration in milliseconds */
  finalPausedDurationMs: number;
}

/**
 * Session data needed for pause calculations
 */
export interface SessionPauseData {
  startedAt: Date;
  lastPausedAt: Date | null;
  pausedDurationMs: number;
  /** Playback position - used to cap duration when pause tracking fails */
  progressMs?: number | null;
  /** Media runtime - bounds the progress-based cap against corrupt progress metadata */
  totalDurationMs?: number | null;
}

// ============================================================================
// Playback Confirmation Types
// ============================================================================

/**
 * Playback confirmation threshold in milliseconds.
 * Session must have 30s of progress OR be active for 30s before rules evaluate.
 */
export const PLAYBACK_CONFIRM_THRESHOLD_MS = 30_000;

/**
 * Periodic DB flush for progress/lastSeenAt when no state changes.
 * Must stay well below STALE_SESSION_TIMEOUT_SECONDS (300s) including the
 * dbWriteThrottle jitter, or the stale sweep will force-stop live sessions.
 */
export const DB_WRITE_FLUSH_INTERVAL_MS = 15_000;

/** A pending session that dies unconfirmed still persists when it showed this much real progress. */
export const PENDING_STOP_PERSIST_MIN_PROGRESS_MS = 15_000;

/**
 * Tracking data for playback confirmation (stored in Redis session state)
 */
export interface PlaybackConfirmationState {
  /** Has playback been confirmed? */
  confirmedPlayback: boolean;
  /** Timestamp when session first appeared (for duration-based confirmation) */
  firstSeenAt: number;
  /** Highest viewOffset seen (tracks max progress) */
  maxViewOffset: number;
  /** First observed viewOffset; progress is measured relative to this, not absolute position. */
  initialViewOffset: number | null;
}

/**
 * Data stored in Redis for a pending session (not yet written to DB).
 * Contains all fields needed to create a session when confirmed.
 *
 * Pending sessions are:
 * - Stored in Redis only (not DB) until confirmation threshold met
 * - Shown in "Now Playing" dashboard from Redis cache
 * - Discarded if stopped before 30s (phantom sessions)
 * - Persisted to DB and rules evaluated when confirmed
 *
 * The `id` field is pre-generated when the pending session is created,
 * ensuring the same UUID is used throughout the session lifecycle.
 * This prevents UI flicker and broken session detail pages during transition.
 */
export interface PendingSessionData {
  /** Pre-generated UUID for this session (stable from creation to database persistence) */
  id: string;
  /** Confirmation state tracking */
  confirmation: PlaybackConfirmationState;
  /** Processed session data from media server */
  processed: ProcessedSession;
  /** Server info */
  server: { id: string; name: string; type: 'plex' | 'jellyfin' | 'emby' };
  /** Server user info (matches SessionCreationInput.serverUser) */
  serverUser: {
    id: string;
    /** Identity (users.id) this server_user belongs to */
    userId: string;
    username: string;
    thumbUrl: string | null;
    identityName: string | null;
    trustScore: number;
    lastActivityAt: Date | null;
    createdAt: Date;
    /** All server_user ids belonging to the same identity, for cross-server rule aggregation */
    identityServerUserIds: string[];
  };
  /** isLocal is absent on entries written before the flag existed */
  geo: GeoLocation & { isLocal?: boolean };
  /** Timestamp when session started (ms since epoch) */
  startedAt: number;
  /** Last update timestamp (ms since epoch) */
  lastSeenAt: number;
  /** Current playback state */
  currentState: SessionState;
  /** Accumulated pause duration in ms */
  pausedDurationMs: number;
  /** When pause started (ms since epoch), null if not paused */
  lastPausedAt: number | null;
}

// ============================================================================
// Processing Results
// ============================================================================

/**
 * Result of processing a single server's sessions
 */
export interface ServerProcessingResult {
  /** Whether the server was successfully polled (false = connection error) */
  success: boolean;
  /** The failed poll was a 401: the server rejected Tracearr's token */
  unauthorized?: boolean;
  /** Newly created sessions */
  newSessions: ActiveSession[];
  /** Session keys that stopped playing */
  stoppedSessionKeys: string[];
  /** Sessions that were updated (state change, progress, etc.) */
  updatedSessions: ActiveSession[];
  /** Whether any session crossed the watched-completion threshold this tick */
  watchedTransitionOccurred: boolean;
  /**
   * IDs (subset of newSessions) that were confirmed from a pending entry.
   * The pending create already published session:started, so processPollResults
   * must not publish it again for these.
   */
  confirmedFromPendingIds: Set<string>;
}

// ============================================================================
// Session Lifecycle Types
// ============================================================================

/**
 * Input for creating a session with rule evaluation
 */
export interface SessionCreationInput {
  /** Processed session data from media server */
  processed: ProcessedSession;
  /** Server info */
  server: { id: string; name: string; type: 'plex' | 'jellyfin' | 'emby' };
  /** Server user info */
  serverUser: {
    id: string;
    /** Identity (users.id) this server_user belongs to */
    userId: string;
    username: string;
    thumbUrl: string | null;
    identityName: string | null;
    trustScore: number;
    lastActivityAt: Date | null;
    createdAt: Date;
    /** All server_user ids belonging to the same identity, for cross-server rule aggregation */
    identityServerUserIds: string[];
  };
  /** GeoIP location data */
  geo: SessionGeo;
  /** Active V2 rules to evaluate */
  activeAutomations: EngineAutomation[];
  /** Active sessions for rule context (e.g., concurrent streams) */
  activeSessions: Session[];
  /** Recent sessions for rule evaluation context */
  recentSessions: Session[];
  /**
   * Pre-generated UUID for the session. If provided, this ID will be used
   * instead of letting PostgreSQL generate one. Used for pending sessions
   * to ensure stable IDs throughout the session lifecycle.
   */
  preGeneratedId?: string;
}

/**
 * Result when a quality change stops an active session
 */
export interface QualityChangeResult {
  /** The session that was stopped */
  stoppedSession: {
    id: string;
    serverUserId: string;
    sessionKey: string;
    deviceId: string | null;
    ratingKey: string | null;
  };
  /** Reference ID for the session chain */
  referenceId: string;
}

/**
 * Result of atomic session creation with rule evaluation
 */
export interface SessionCreationResult {
  /** The inserted session row */
  insertedSession: typeof sessions.$inferSelect;
  /** Violations created during session creation */
  violationResults: ViolationInsertResult[];
  /** Quality change info if an active session was stopped */
  qualityChange: QualityChangeResult | null;
  /** Reference ID for session grouping (resume tracking) */
  referenceId: string | null;
  /**
   * Whether the triggering session was terminated by a kill_stream rule action.
   * When true, the session should NOT be added to the cache (it's already stopped).
   * This prevents ghost sessions from appearing in the dashboard.
   */
  wasTerminatedByRule: boolean;
}

// ============================================================================
// Pending Session Resolution Types
// ============================================================================

/**
 * Input for resolving a Redis-only pending session before a poll branch
 * commits to treating a session as new. Shared by the isNew and not-new
 * branches so both defer to the same pending session for a given key.
 */
export interface ResolvePendingSessionInput {
  cacheService: CacheService;
  pubSubService: PubSubService | null;
  /** Server info */
  server: { id: string; name: string; type: 'plex' | 'jellyfin' | 'emby' };
  /** Redis key for the pending session lookup (sessionKey for Plex, composite key otherwise) */
  pendingKey: string;
  /** Processed session data from media server */
  processed: ProcessedSession;
  /** Server user info (matches SessionCreationInput.serverUser) */
  userDetail: SessionCreationInput['serverUser'];
  /** Active V2 rules to evaluate on confirmation */
  activeAutomations: EngineAutomation[];
  /** Active sessions for rule context (e.g., concurrent streams) */
  activeSessions: ActiveSession[];
  /** Recent sessions for rule evaluation context */
  recentSessions: Session[];
  usePlexGeoip: boolean;
}

/** Outcome of checking Redis for a pending session tracked under a given key. */
export type PendingSessionOutcome =
  | { status: 'not-pending' }
  | { status: 'confirmed'; newSession: ActiveSession | null }
  | { status: 'still-pending'; updatedSession: ActiveSession };

/**
 * Input for stopping a session
 */
export interface SessionStopInput {
  /** The session to stop */
  session: typeof sessions.$inferSelect;
  /** When the session stopped */
  stoppedAt: Date;
  /** Whether this is a force-stop (stale session cleanup) */
  forceStopped?: boolean;
  /**
   * Whether to preserve the current watched status instead of calculating.
   * Use for quality changes where playback continues in a new session.
   */
  preserveWatched?: boolean;
  /** What ended the row; the two continuations fire no stream-ended trigger. Defaults to 'ended'. */
  reason?: SessionStopReason;
}

/**
 * Result of stopping a session
 */
export interface SessionStopResult {
  /** Actual watch duration excluding pause time */
  durationMs: number;
  /** Whether the user watched enough to count as "watched" */
  watched: boolean;
  /** Whether this was a short session (< MIN_PLAY_TIME_MS) */
  shortSession: boolean;
  /** Whether the update was applied (false if session was already stopped) */
  wasUpdated: boolean;
  /** If true, caller should queue for retry */
  needsRetry?: boolean;
  /** Stop data needed for retry */
  retryData?: { stoppedAt: number; forceStopped: boolean };
}

/**
 * Input for handling media change (e.g., Emby "Play Next Episode")
 */
export interface MediaChangeInput {
  /** The existing session that will be stopped */
  existingSession: typeof sessions.$inferSelect;
  /** New media data from the poll */
  processed: ProcessedSession;
  /** Server info */
  server: { id: string; name: string; type: 'plex' | 'jellyfin' | 'emby' };
  /** Server user info */
  serverUser: {
    id: string;
    /** Identity (users.id) this server_user belongs to */
    userId: string;
    username: string;
    thumbUrl: string | null;
    identityName: string | null;
    trustScore: number;
    lastActivityAt: Date | null;
    createdAt: Date;
    /** All server_user ids belonging to the same identity, for cross-server rule aggregation */
    identityServerUserIds: string[];
  };
  /** GeoIP location data */
  geo: SessionGeo;
  /** Active V2 rules to evaluate */
  activeAutomations: EngineAutomation[];
  /** Active sessions for rule context (e.g., concurrent streams) */
  activeSessions: Session[];
  /** Recent sessions for rule evaluation context */
  recentSessions: Session[];
}

/**
 * Result of handling a media change
 */
export interface MediaChangeResult {
  /** The old session that was stopped */
  stoppedSession: {
    id: string;
    serverUserId: string;
    sessionKey: string;
  };
  /** The newly created session for the new media */
  insertedSession: typeof sessions.$inferSelect;
  /** Violations created during session creation */
  violationResults: ViolationInsertResult[];
  wasTerminatedByRule: boolean;
  /** Set when the new session's content was already tracked as another un-stopped session for this user+device; that twin was stopped and must be run through handleQualityChangeFallout */
  qualityChange: QualityChangeResult | null;
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { Session, SessionState, EngineAutomation };
