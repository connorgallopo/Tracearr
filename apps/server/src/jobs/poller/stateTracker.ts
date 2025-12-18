/**
 * Session State Tracking
 *
 * Pure functions for tracking session state transitions, pause accumulation,
 * watch completion, and session grouping (resume detection).
 */

import { SESSION_LIMITS, type SessionState } from '@tracearr/shared';
import type { PauseAccumulationResult, StopDurationResult, SessionPauseData } from './types.js';

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
 *
 * @param session - Session pause tracking data
 * @param stoppedAt - Timestamp when session stopped
 * @returns Actual watch duration and final paused duration
 *
 * @example
 * // Session that was playing when stopped
 * calculateStopDuration({ startedAt: tenMinutesAgo, lastPausedAt: null, pausedDurationMs: 60000 }, now);
 * // Returns: { durationMs: 540000, finalPausedDurationMs: 60000 } (9 min watch, 1 min paused)
 *
 * // Session that was paused when stopped (adds remaining pause time)
 * calculateStopDuration({ startedAt: tenMinutesAgo, lastPausedAt: twoMinutesAgo, pausedDurationMs: 60000 }, now);
 * // Returns: { durationMs: 420000, finalPausedDurationMs: 180000 } (7 min watch, 3 min paused)
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

  // Calculate actual watch duration (excludes all paused time)
  const durationMs = Math.max(0, totalElapsedMs - finalPausedDurationMs);

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
 * Check if a session should be marked as "watched" based on progress threshold.
 *
 * @param progressMs - Current playback position in milliseconds
 * @param totalDurationMs - Total media duration in milliseconds
 * @param threshold - Optional custom threshold (0-1), defaults to 85%
 * @returns true if watched at least the threshold percentage of the content
 *
 * @example
 * checkWatchCompletion(8500, 10000);         // true (85% with default threshold)
 * checkWatchCompletion(8000, 10000);         // false (80% < 85% default)
 * checkWatchCompletion(9000, 10000, 0.90);   // true (90% with custom threshold)
 * checkWatchCompletion(null, 6000000);       // false (no progress)
 */
export function checkWatchCompletion(
  progressMs: number | null,
  totalDurationMs: number | null,
  threshold: number = SESSION_LIMITS.WATCH_COMPLETION_THRESHOLD
): boolean {
  if (!progressMs || !totalDurationMs) return false;
  return progressMs / totalDurationMs >= threshold;
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
