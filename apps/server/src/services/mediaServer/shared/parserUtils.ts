/**
 * Shared Parser Utilities
 *
 * Cross-platform utilities shared by all media server parsers and clients.
 */

/**
 * Calculate progress percentage from position and duration
 * Used by all media server parsers for playback progress
 */
export function calculateProgress(positionMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(100, Math.round((positionMs / durationMs) * 100));
}

/** Of the rows sharing a key, the one with the latest time; on a tie, the first listed */
export function newestBy<T>(rows: T[], key: (row: T) => string, at: (row: T) => number): T[] {
  const newest = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    const kept = newest.get(k);
    if (!kept || at(row) > at(kept)) newest.set(k, row);
  }
  return [...newest.values()];
}
