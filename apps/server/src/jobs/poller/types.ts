/**
 * Poller Type Definitions
 *
 * Shared interfaces and types for the session polling system.
 * Separated from implementation for clean imports and testing.
 */

import type {
  Session,
  SessionState,
  Rule,
  RuleParams,
  ActiveSession,
  StreamDetailFields,
} from '@tracearr/shared';
import type { sessions } from '../../db/schema.js';
import type { GeoLocation } from '../../services/geoip.js';
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
  createdAt: Date;
  updatedAt: Date;
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
  /** Season number (for episodes) */
  seasonNumber: number;
  /** Episode number (for episodes) */
  episodeNumber: number;
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
  /** Total media duration in milliseconds */
  totalDurationMs: number;
  /** Current playback position in milliseconds */
  progressMs: number;

  /**
   * Jellyfin-specific: When the current pause started (from API).
   * More accurate than tracking pause transitions via polling.
   */
  lastPausedDate?: Date;
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
  /** Newly created sessions */
  newSessions: ActiveSession[];
  /** Session keys that stopped playing */
  stoppedSessionKeys: string[];
  /** Sessions that were updated (state change, progress, etc.) */
  updatedSessions: ActiveSession[];
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
    username: string;
    thumbUrl: string | null;
    identityName: string | null;
  };
  /** GeoIP location data */
  geo: GeoLocation;
  /** Active rules to evaluate */
  activeRules: Rule[];
  /** Recent sessions for rule evaluation context */
  recentSessions: Session[];
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
}

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
    username: string;
    thumbUrl: string | null;
    identityName: string | null;
  };
  /** GeoIP location data */
  geo: GeoLocation;
  /** Active rules to evaluate */
  activeRules: Rule[];
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
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { Session, SessionState, Rule, RuleParams };
