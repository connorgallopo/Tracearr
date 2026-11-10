/**
 * Jellyfin API Response Parser
 *
 * Functions for parsing raw Jellyfin API responses into typed objects, separated from
 * the client for testability and reuse. parseSessionsResponse is the one stateful
 * entry point: it holds TranscodingInfo across reads (see transcodingInfoLatch).
 */

import type { MediaSession } from '../types.js';
import { getStreamDecisionsJellyfin } from '../shared/jellyfinEmbyUtils.js';
import { latchTranscodingInfo } from './transcodingInfoLatch.js';

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
  parseItem,
  parseItemsResponse,
  parseLibraryItemsResponse,
  // Re-export shared types with platform-specific aliases for backward compatibility
  type JellyfinEmbyActivityEntry as JellyfinActivityEntry,
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
  return parseSessionsResponseShared(sessions, (session) =>
    parseSession(latchTranscodingInfo(session))
  );
}
