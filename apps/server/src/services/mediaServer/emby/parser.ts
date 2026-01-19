/**
 * Emby API Response Parser
 *
 * Pure functions for parsing raw Emby API responses into typed objects.
 * Separated from the client for testability and reuse.
 *
 * Based on Emby OpenAPI specification v4.1.1.0
 */

import type { MediaSession } from '../types.js';
import { getStreamDecisionsEmby } from '../shared/jellyfinEmbyUtils.js';

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
  type JellyfinEmbyActivityEntry as EmbyActivityEntry,
  type JellyfinEmbyAuthResult as EmbyAuthResult,
  type JellyfinEmbyItemResult as EmbyItemResult,
} from '../shared/jellyfinEmbyParser.js';

import {
  parseSessionsResponse as parseSessionsResponseShared,
  parseSessionCore,
} from '../shared/jellyfinEmbyParser.js';

// ============================================================================
// Session Parsing (Emby-specific wrapper)
// ============================================================================

/**
 * Parse raw Emby session data into a MediaSession object.
 * Uses shared parsing logic with Emby-specific stream decisions.
 * Note: lastPausedDate is disabled as Emby does not support this field.
 */
export function parseSession(session: Record<string, unknown>): MediaSession | null {
  return parseSessionCore(session, getStreamDecisionsEmby, false);
}

/**
 * Parse Emby sessions API response
 * Filters to only sessions with active playback
 */
export function parseSessionsResponse(sessions: unknown[]): MediaSession[] {
  return parseSessionsResponseShared(sessions, parseSession);
}
