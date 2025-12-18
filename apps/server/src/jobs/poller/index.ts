/**
 * Poller Module
 *
 * Background job for polling Plex/Jellyfin servers for active sessions.
 * This module provides a unified interface for session tracking, including:
 * - Automatic polling on configurable intervals
 * - Session state tracking (playing, paused, stopped)
 * - Pause duration accumulation
 * - Watch completion detection (85% threshold)
 * - Session grouping for resume tracking
 * - Rule evaluation and violation creation
 * - Stale session detection and force-stop (5 minute timeout, 60s sweep)
 * - Minimum play time filtering (120s threshold)
 *
 * @example
 * import { initializePoller, startPoller, stopPoller, sweepStaleSessions } from './jobs/poller';
 *
 * // Initialize with cache services
 * initializePoller(cacheService, pubSubService);
 *
 * // Start polling (also starts stale session sweep on 60s interval)
 * startPoller({ enabled: true, intervalMs: 15000 });
 *
 * // Manually trigger stale session sweep
 * await sweepStaleSessions();
 *
 * // Stop polling (also stops stale session sweep)
 * stopPoller();
 */

// ============================================================================
// Public API - Lifecycle Management
// ============================================================================

export {
  initializePoller,
  startPoller,
  stopPoller,
  triggerPoll,
  triggerReconciliationPoll,
  sweepStaleSessions,
} from './processor.js';

// ============================================================================
// Types
// ============================================================================

export type { PollerConfig } from './types.js';

// ============================================================================
// Pure Utility Functions (exported for testing)
// ============================================================================

export { isPrivateIP, parseJellyfinClient, formatQualityString } from './utils.js';

// ============================================================================
// State Tracking Functions (exported for testing)
// ============================================================================

export {
  calculatePauseAccumulation,
  calculateStopDuration,
  checkWatchCompletion,
  shouldGroupWithPreviousSession,
} from './stateTracker.js';

// ============================================================================
// Rule/Violation Functions (exported for testing)
// ============================================================================

export { getTrustScorePenalty, doesRuleApplyToUser } from './violations.js';
