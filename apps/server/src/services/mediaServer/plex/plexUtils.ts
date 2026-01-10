/**
 * Plex-Specific Parser Utilities
 *
 * Helper functions for extracting metadata from Plex API responses.
 * Separated from the main parser for testability and consistency with
 * the Jellyfin/Emby pattern (see shared/jellyfinEmbyUtils.ts).
 */

import {
  parseBoundedString,
  parseOptionalBoundedString,
  parseOptionalNumber,
} from '../../../utils/parsing.js';

// ============================================================================
// Live TV Metadata Extraction
// ============================================================================

/**
 * Extract live TV metadata from Plex session data
 *
 * Plex Live TV has channel info at the session level (sourceTitle) and/or
 * in the Media array (channelTitle, channelIdentifier, channelThumb).
 *
 * DB limits: channelTitle=255, channelIdentifier=100, channelThumb=500
 *
 * @param item - The session item from Plex API
 * @param firstMedia - The first Media element (if available)
 * @returns Live TV metadata or undefined if no channel info found
 */
export function extractPlexLiveTvMetadata(
  item: Record<string, unknown>,
  firstMedia: Record<string, unknown> | undefined
): { channelTitle: string; channelIdentifier?: string; channelThumb?: string } | undefined {
  // Channel title can come from sourceTitle (session level) or Media.channelTitle
  const channelTitle =
    parseOptionalBoundedString(item.sourceTitle, 255) ||
    parseOptionalBoundedString(firstMedia?.channelTitle, 255);

  if (!channelTitle) return undefined;

  return {
    channelTitle,
    channelIdentifier: parseOptionalBoundedString(firstMedia?.channelIdentifier, 100),
    channelThumb: parseOptionalBoundedString(firstMedia?.channelThumb, 500),
  };
}

// ============================================================================
// Music Track Metadata Extraction
// ============================================================================

/**
 * Extract music track metadata from Plex session data
 *
 * Plex uses the Grandparent/Parent hierarchy for music:
 * - grandparentTitle = Artist name
 * - parentTitle = Album name
 * - index = Track number
 * - parentIndex = Disc number
 *
 * DB limits: artistName=255, albumName=255
 *
 * @param item - The session item from Plex API
 * @returns Music metadata with artist, album, track, and disc info
 */
export function extractPlexMusicMetadata(item: Record<string, unknown>): {
  artistName: string;
  albumName?: string;
  trackNumber?: number;
  discNumber?: number;
} {
  return {
    artistName: parseBoundedString(item.grandparentTitle, 255),
    albumName: parseOptionalBoundedString(item.parentTitle, 255),
    trackNumber: parseOptionalNumber(item.index),
    discNumber: parseOptionalNumber(item.parentIndex),
  };
}
