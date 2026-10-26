/**
 * Session State Tracking
 *
 * Pure functions for tracking session state transitions, pause accumulation,
 * watch completion, and session grouping (resume detection).
 */

import { SESSION_LIMITS, type SessionState } from '@tracearr/shared';
import type {
  BuildCompositeKeyInput,
  PauseAccumulationResult,
  StopDurationResult,
  SessionPauseData,
  PlaybackConfirmationState,
} from './types.js';
import { PLAYBACK_CONFIRM_THRESHOLD_MS } from './types.js';

// ============================================================================
// Pause Tracking
// ============================================================================

/**
 * Calculate pause accumulation when session state changes.
 * Handles transitions between playing and paused states.
 *
 * @param previousState - Previous playback state
 * @param newState - New playback state
 * @param existingSession - Current session pause data
 * @param now - Current timestamp
 * @returns Updated pause tracking data
 *
 * @example
 * // Starting to pause
 * calculatePauseAccumulation('playing', 'paused', { lastPausedAt: null, pausedDurationMs: 0 }, now);
 * // Returns: { lastPausedAt: now, pausedDurationMs: 0 }
 *
 * // Resuming playback after 5 minutes paused
 * calculatePauseAccumulation('paused', 'playing', { lastPausedAt: fiveMinutesAgo, pausedDurationMs: 0 }, now);
 * // Returns: { lastPausedAt: null, pausedDurationMs: 300000 }
 */
export function calculatePauseAccumulation(
  previousState: SessionState,
  newState: SessionState,
  existingSession: { lastPausedAt: Date | null; pausedDurationMs: number },
  now: Date
): PauseAccumulationResult {
  let lastPausedAt = existingSession.lastPausedAt;
  let pausedDurationMs = existingSession.pausedDurationMs;

  if (previousState === 'playing' && newState === 'paused') {
    // Started pausing - record timestamp
    lastPausedAt = now;
  } else if (previousState === 'paused' && newState === 'playing') {
    // Resumed playing - accumulate pause duration
    if (existingSession.lastPausedAt) {
      const pausedMs = now.getTime() - existingSession.lastPausedAt.getTime();
      pausedDurationMs = (existingSession.pausedDurationMs || 0) + pausedMs;
    }
    lastPausedAt = null;
  }

  return { lastPausedAt, pausedDurationMs };
}

/**
 * Calculate final duration when a session is stopped.
 * Accounts for any remaining pause time if stopped while paused.
 * Uses progressMs as sanity check to cap duration when pause tracking fails.
 */
export function calculateStopDuration(
  session: SessionPauseData,
  stoppedAt: Date
): StopDurationResult {
  const totalElapsedMs = stoppedAt.getTime() - session.startedAt.getTime();

  // Calculate final paused duration - accumulate any remaining pause if stopped while paused
  let finalPausedDurationMs = session.pausedDurationMs || 0;
  if (session.lastPausedAt) {
    // Session was stopped while paused - add the remaining pause time
    finalPausedDurationMs += stoppedAt.getTime() - session.lastPausedAt.getTime();
  }

  let durationMs = Math.max(0, totalElapsedMs - finalPausedDurationMs);

  // Cap duration at progressMs + 60s if pause tracking failed
  if (session.progressMs != null && session.progressMs > 0) {
    let maxDurationMs = session.progressMs + 60000;
    // Corrupt progress metadata (progressMs past the media runtime) would push
    // the cap above the real playback ceiling and let a bad duration through.
    // Bound it by the runtime when we know it. Legitimate sessions, including
    // rewatchers, never exceed totalDurationMs + 60s.
    if (session.totalDurationMs != null && session.totalDurationMs > 0) {
      maxDurationMs = Math.min(maxDurationMs, session.totalDurationMs + 60000);
    }
    if (durationMs > maxDurationMs) {
      console.log(
        `[StateTracker] Duration capped: ${Math.round(durationMs / 1000)}s -> ${Math.round(maxDurationMs / 1000)}s (progress: ${Math.round(session.progressMs / 1000)}s)`
      );
      finalPausedDurationMs += durationMs - maxDurationMs;
      durationMs = maxDurationMs;
    }
  }

  return { durationMs, finalPausedDurationMs };
}

// ============================================================================
// Stale Session Detection
// ============================================================================

/**
 * Determine if a session should be force-stopped due to inactivity.
 * A session is considered stale when no updates have been received for the timeout period.
 *
 * @param lastSeenAt - Last update timestamp for the session
 * @param timeoutSeconds - Optional custom timeout in seconds, defaults to 5 minutes
 * @returns true if the session should be force-stopped
 *
 * @example
 * // Session last seen 6 minutes ago
 * shouldForceStopStaleSession(sixMinutesAgo); // true
 *
 * // Session last seen 3 minutes ago
 * shouldForceStopStaleSession(threeMinutesAgo); // false
 *
 * // Exactly at threshold (5 minutes) - NOT stale yet
 * shouldForceStopStaleSession(fiveMinutesAgo); // false
 */
export function shouldForceStopStaleSession(
  lastSeenAt: Date,
  timeoutSeconds: number = SESSION_LIMITS.STALE_SESSION_TIMEOUT_SECONDS
): boolean {
  const elapsedMs = Date.now() - lastSeenAt.getTime();
  const timeoutMs = timeoutSeconds * 1000;
  // Strictly greater than - at exactly the threshold, session is NOT stale yet
  return elapsedMs > timeoutMs;
}

// ============================================================================
// Minimum Play Time Filtering
// ============================================================================

/**
 * Determine if a session should be recorded based on minimum play time.
 * Sessions shorter than the threshold are filtered out to reduce noise.
 *
 * @param durationMs - Session duration in milliseconds
 * @param minPlayTimeMs - Optional custom minimum play time, defaults to 2 minutes
 * @returns true if the session should be recorded
 *
 * @example
 * shouldRecordSession(60 * 1000);  // false (1 min < 2 min threshold)
 * shouldRecordSession(120 * 1000); // true (exactly 2 min threshold)
 * shouldRecordSession(180 * 1000); // true (3 min > threshold)
 * shouldRecordSession(1000, 0);    // true (no minimum when 0)
 */
export function shouldRecordSession(
  durationMs: number,
  minPlayTimeMs: number = SESSION_LIMITS.MIN_PLAY_TIME_MS
): boolean {
  // If minimum is 0, always record
  if (minPlayTimeMs === 0) return true;
  return durationMs >= minPlayTimeMs;
}

// ============================================================================
// Watch Completion
// ============================================================================

/**
 * Check if a session should be marked as "watched" based on watch time threshold.
 *
 * Uses a hybrid approach: checks both progressMs (playback position) and
 * durationMs (actual watch time). Either metric passing the threshold counts
 * as completion. This handles both skip-forward users (progress passes but
 * duration doesn't) and servers with incorrect position data like Emby iOS
 * transcoded sessions (duration passes but progress doesn't).
 *
 * @param durationMs - Actual watch time in milliseconds (elapsed - paused)
 * @param progressMs - Playback position reached in milliseconds
 * @param totalDurationMs - Total media duration in milliseconds
 * @param threshold - Optional custom threshold (0-1), defaults to 85%
 * @returns true if either metric meets the threshold percentage
 *
 * @example
 * checkWatchCompletion(8500, 9000, 10000);      // true (both pass)
 * checkWatchCompletion(5000, 9000, 10000);      // true (progress passes)
 * checkWatchCompletion(8500, null, 10000);      // true (duration passes, no progress)
 * checkWatchCompletion(0, 9900, 10000);         // false (position alone, nothing played)
 * checkWatchCompletion(5000, 5000, 10000);      // false (neither passes)
 * checkWatchCompletion(null, null, 10000);      // false (no data)
 */
export function checkWatchCompletion(
  durationMs: number | null,
  progressMs: number | null,
  totalDurationMs: number | null,
  threshold: number = SESSION_LIMITS.WATCH_COMPLETION_THRESHOLD
): boolean {
  if (!totalDurationMs) return false;
  // a client left sitting at the end of an item reports that position with no play time
  const played = durationMs === null || durationMs >= 1000;
  if (played && progressMs && progressMs / totalDurationMs >= threshold) return true;
  if (durationMs && durationMs / totalDurationMs >= threshold) return true;
  return false;
}

// ============================================================================
// Media Change Detection
// ============================================================================

/**
 * Detect media change within the same sessionKey (e.g., Emby "Play Next Episode").
 *
 * Some media servers (notably Emby) reuse the same sessionKey when automatically
 * playing the next episode in a series. This results in the same session showing
 * different content (different ratingKey). We need to detect this and create
 * separate session records for accurate play count tracking.
 *
 * For Live TV sessions, channel changes produce different ratingKeys but the
 * liveUuid remains constant. If both sessions have matching liveUuids, this is
 * a channel change within the same viewing session - NOT a media change.
 *
 * @param existingRatingKey - ratingKey from the current active session
 * @param newRatingKey - ratingKey from the incoming poll data
 * @param existingLiveUuid - liveUuid from the current session (Live TV only)
 * @param newLiveUuid - liveUuid from the incoming data (Live TV only)
 * @returns true if media has changed (different non-null ratingKeys, accounting for Live TV)
 *
 * @example
 * detectMediaChange('episode-1', 'episode-2'); // true - different episodes
 * detectMediaChange('episode-1', 'episode-1'); // false - same episode
 * detectMediaChange(null, 'episode-1');        // false - can't detect without existing
 * detectMediaChange('episode-1', null);        // false - can't detect without new
 * detectMediaChange('channel-1', 'channel-2', 'live-abc', 'live-abc'); // false - same Live TV session
 * detectMediaChange('channel-1', 'channel-2', 'live-abc', 'live-xyz'); // true - different Live TV sessions
 */
export function detectMediaChange(
  existingRatingKey: string | null,
  newRatingKey: string | null,
  existingLiveUuid?: string | null,
  newLiveUuid?: string | null
): boolean {
  // Both must be non-null to detect a change
  if (existingRatingKey === null || newRatingKey === null) {
    return false;
  }

  // Same ratingKey = same media
  if (existingRatingKey === newRatingKey) {
    return false;
  }

  // Different ratingKeys - but check Live TV UUID
  // If both have matching liveUuids, this is a channel change within the same viewing session
  if (existingLiveUuid && newLiveUuid && existingLiveUuid === newLiveUuid) {
    return false;
  }

  // Different ratingKeys and no matching liveUuid = different media
  return true;
}

// ============================================================================
// Quality Change Detection
// ============================================================================

/**
 * Determine if a new session represents a quality/resolution change during playback.
 * This happens when Plex/Jellyfin assigns a new sessionKey but the user is still
 * watching the same content.
 *
 * @param existingActiveSession - Active (not stopped) session for same user+content, or null
 * @returns referenceId to link to if this is a quality change, or null
 *
 * @example
 * // Quality change detected - link to existing session
 * isQualityChangeScenario({ id: 'sess-1', referenceId: null, stoppedAt: null });
 * // Returns: 'sess-1'
 *
 * // Quality change with existing chain - link to original
 * isQualityChangeScenario({ id: 'sess-2', referenceId: 'sess-1', stoppedAt: null });
 * // Returns: 'sess-1'
 *
 * // Session already stopped - not a quality change
 * isQualityChangeScenario({ id: 'sess-1', referenceId: null, stoppedAt: new Date() });
 * // Returns: null
 *
 * // No existing session
 * isQualityChangeScenario(null);
 * // Returns: null
 */
export function isQualityChangeScenario(
  existingActiveSession:
    | {
        id: string;
        referenceId: string | null;
        stoppedAt: Date | null;
      }
    | null
    | undefined
): string | null {
  // No existing session = not a quality change
  if (!existingActiveSession) return null;

  // Session already stopped = not a quality change (this is a resume scenario)
  if (existingActiveSession.stoppedAt !== null) return null;

  // Active session exists for same user+content = quality change
  // Link to the original session chain
  return existingActiveSession.referenceId || existingActiveSession.id;
}

// ============================================================================
// Session Grouping (Resume Detection)
// ============================================================================

/**
 * Determine if a new session should be grouped with a previous session (resume tracking).
 * Returns the referenceId to link to, or null if sessions shouldn't be grouped.
 *
 * Sessions are grouped when:
 * - Same user and same media item (ratingKey)
 * - Previous session stopped within 24 hours (absolute maximum)
 * - Previous session stopped within continued session threshold (default 60s)
 * - Previous session wasn't fully watched
 * - New session starts at same or later position (resuming, not rewatching)
 *
 * @param previousSession - Previous session data for the same user/media
 * @param newProgressMs - Current playback position of new session
 * @param continuedThresholdMs - Optional custom threshold for "continued session" grouping (default: 60s)
 * @returns referenceId to link to, or null if not grouping
 *
 * @example
 * // Resuming within 60s (default threshold)
 * shouldGroupWithPreviousSession(
 *   { id: 'sess-1', referenceId: null, progressMs: 1800000, watched: false, stoppedAt: thirtySecondsAgo },
 *   1800000
 * ); // Returns: 'sess-1'
 *
 * // Continued session with 5 minute threshold
 * shouldGroupWithPreviousSession(
 *   { id: 'sess-1', referenceId: null, progressMs: 1800000, watched: false, stoppedAt: twoMinutesAgo },
 *   1800000,
 *   5 * 60 * 1000  // 5 minute threshold
 * ); // Returns: 'sess-1' (within threshold)
 */
export function shouldGroupWithPreviousSession(
  previousSession: {
    referenceId: string | null;
    id: string;
    progressMs: number | null;
    watched: boolean;
    stoppedAt: Date | null;
  },
  newProgressMs: number,
  continuedThresholdMs?: number
): string | null {
  // Must have a stoppedAt time
  if (!previousSession.stoppedAt) return null;

  // Calculate 24h window internally - absolute maximum for any grouping
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (previousSession.stoppedAt < twentyFourHoursAgo) return null;

  // Apply continued session threshold (default: 60 seconds from SESSION_LIMITS)
  const thresholdMs = continuedThresholdMs ?? SESSION_LIMITS.CONTINUED_SESSION_THRESHOLD_MS;
  const gapMs = Date.now() - previousSession.stoppedAt.getTime();
  if (gapMs > thresholdMs) return null;

  // Must not be fully watched
  if (previousSession.watched) return null;

  // New session must be resuming from same or later position
  const prevProgress = previousSession.progressMs || 0;
  if (newProgressMs >= prevProgress) {
    // Link to the first session in the chain
    return previousSession.referenceId || previousSession.id;
  }

  return null;
}

// ============================================================================
// Playback Confirmation (Rule Evaluation Delay)
// ============================================================================

/**
 * Check if playback has been confirmed for rule evaluation.
 *
 * A session is confirmed when ANY of these conditions are met:
 * 1. Already marked as confirmed (idempotent)
 * 2. Session has been active for 30+ seconds (any state)
 */
export function isPlaybackConfirmed(
  state: PlaybackConfirmationState,
  _currentViewOffset: number,
  _currentState: string,
  now: number
): boolean {
  if (state.confirmedPlayback) return true;
  // Absolute position must not confirm: a resumed item reports its saved
  // position on first sight, which let rules evaluate against a cache that
  // still contained the session the user switched away from. Age is the
  // only confirmation signal; 30s is enough for the stale twin to sweep.
  return now - state.firstSeenAt > PLAYBACK_CONFIRM_THRESHOLD_MS;
}

/**
 * Create initial confirmation state for a new session.
 */
export function createInitialConfirmationState(now: number): PlaybackConfirmationState {
  return {
    confirmedPlayback: false,
    firstSeenAt: now,
    maxViewOffset: 0,
    initialViewOffset: null,
  };
}

/**
 * Update confirmation state with new progress data.
 */
export function updateConfirmationState(
  state: PlaybackConfirmationState,
  viewOffset: number
): PlaybackConfirmationState {
  return {
    ...state,
    // Redis blobs from before this field default null here, first update fills it.
    initialViewOffset: state.initialViewOffset ?? viewOffset,
    maxViewOffset: Math.max(state.maxViewOffset, viewOffset),
  };
}

// ============================================================================
// Session Identity
// ============================================================================

/**
 * Build a cache/tracking key for a session.
 * Plex: `serverId:sessionKey`. JF/Emby: `serverId:userId:deviceId:ratingKey`.
 */
export function buildCompositeKey(input: BuildCompositeKeyInput): string {
  const { serverType, serverId, externalUserId, deviceId, ratingKey, sessionKey } = input;

  if (serverType === 'plex') {
    return `${serverId}:${sessionKey}`;
  }

  const deviceIdentifier = deviceId || sessionKey;
  return `${serverId}:${externalUserId}:${deviceIdentifier}:${ratingKey ?? ''}`;
}

// ============================================================================
// Change Detection
// ============================================================================

/** True if the session has state/quality/codec changes worth writing to DB immediately. */
export function shouldWriteToDb(
  existing: {
    state: string;
    isTranscode: boolean;
    videoDecision: string | null;
    audioDecision: string | null;
    watched: boolean;
    sourceVideoCodec?: string | null;
    sourceAudioCodec?: string | null;
  },
  processed: {
    state: string;
    isTranscode: boolean;
    videoDecision: string | null;
    audioDecision: string | null;
    sourceVideoCodec?: string | null;
    sourceAudioCodec?: string | null;
  },
  watchedThresholdReached = false
): boolean {
  if (existing.state !== processed.state) return true;
  if (existing.isTranscode !== processed.isTranscode) return true;
  if (existing.videoDecision !== processed.videoDecision) return true;
  if (existing.audioDecision !== processed.audioDecision) return true;
  if (watchedThresholdReached && !existing.watched) return true;
  if (existing.sourceVideoCodec !== processed.sourceVideoCodec) return true;
  if (existing.sourceAudioCodec !== processed.sourceAudioCodec) return true;
  return false;
}
