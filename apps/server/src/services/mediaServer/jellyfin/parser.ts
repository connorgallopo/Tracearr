/**
 * Jellyfin API Response Parser
 *
 * Pure functions for parsing raw Jellyfin API responses into typed objects.
 * Separated from the client for testability and reuse.
 */

import type { MediaSession } from '../types.js';
import { getStreamDecisionsJellyfin } from '../shared/jellyfinEmbyUtils.js';

// Re-export shared parser functions (identical between Jellyfin/Emby)
export {
  parsePlaybackState,
  parseUser,
  parseUsersResponse,
  parseLibrary,
  parseLibrariesResponse,
  parseWatchHistoryItem,
  parseWatchHistoryResponse,
  parseActivityLogItem,
  parseActivityLogResponse,
  parseAuthResponse,
  parseItem,
  parseItemsResponse,
  parseLibraryItemsResponse,
  // Re-export shared types with platform-specific aliases for backward compatibility
  type JellyfinEmbyActivityEntry as JellyfinActivityEntry,
  type JellyfinEmbyAuthResult as JellyfinAuthResult,
  type JellyfinEmbyItemResult as JellyfinItemResult,
} from '../shared/jellyfinEmbyParser.js';

import {
  parseSessionsResponse as parseSessionsResponseShared,
  parseSessionCore,
} from '../shared/jellyfinEmbyParser.js';

// ============================================================================
// Session Parsing (Jellyfin-specific wrapper)
// ============================================================================

/**
 * Parse raw Jellyfin session data into a MediaSession object.
 * Uses shared parsing logic with Jellyfin-specific stream decisions
 * and lastPausedDate support enabled.
 */
export function parseSession(session: Record<string, unknown>): MediaSession | null {
  return parseSessionCore(session, getStreamDecisionsJellyfin, true);
}

/**
 * Parse Jellyfin sessions API response
 * Filters to only sessions with active playback
 */
export function parseSessionsResponse(sessions: unknown[]): MediaSession[] {
  return parseSessionsResponseShared(sessions, parseSession);
}
