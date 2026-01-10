/**
 * Shared Parser Utilities
 *
 * Cross-platform utilities shared by all media server parsers (Plex, Jellyfin, Emby).
 */

/**
 * Calculate progress percentage from position and duration
 * Used by all media server parsers for playback progress
 */
export function calculateProgress(positionMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(100, Math.round((positionMs / durationMs) * 100));
}
