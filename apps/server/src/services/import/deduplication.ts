/**
 * Session Deduplication Module
 *
 * Provides two-tier deduplication for import operations:
 * 1. Tier 1: Match by externalSessionId (fast, exact)
 * 2. Tier 2: Match by composite time-based key (fallback for missing external IDs)
 *
 * Used by both Tautulli and Jellystat importers.
 */

import { eq, and, inArray, gte, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';

/**
 * Maximum size for IN clause arrays to prevent PostgreSQL lock exhaustion.
 * TimescaleDB with many chunks can exhaust max_locks_per_transaction when
 * queries have large IN clauses that touch many partitions.
 */
const DEDUP_CHUNK_SIZE = 500;

/**
 * Existing session data needed for deduplication decisions
 */
export interface ExistingSession {
  id: string;
  externalSessionId: string | null;
  ratingKey: string | null;
  startedAt: Date;
  serverUserId: string;
  totalDurationMs: number | null;
  stoppedAt: Date | null;
  durationMs: number | null;
  pausedDurationMs: number | null;
  watched: boolean | null;
  sourceVideoCodec: string | null;
  mediaType: string;
  mediaId: string | null;
  showMediaId: string | null;
}

/**
 * Time bounds for limiting chunk scans in TimescaleDB queries.
 * Adding time bounds enables chunk exclusion, dramatically reducing locks.
 */
export interface TimeBounds {
  minTime: Date;
  maxTime: Date;
}

/**
 * Default buffer to add around time bounds (1 day in milliseconds).
 * This handles timezone edge cases and ensures we don't miss matches.
 */
const TIME_BOUNDS_BUFFER_MS = 24 * 60 * 60 * 1000;

/**
 * Query existing sessions by external IDs
 *
 * Chunks the query to avoid PostgreSQL lock exhaustion with large IN clauses.
 * Each chunk runs in a separate query to minimize lock contention on TimescaleDB.
 *
 * IMPORTANT: Pass timeBounds when available to enable TimescaleDB chunk exclusion.
 * Without time bounds, the query must scan indexes on ALL chunks.
 */
export async function queryExistingByExternalIds(
  serverId: string,
  externalIds: string[],
  timeBounds?: TimeBounds
): Promise<Map<string, ExistingSession>> {
  if (externalIds.length === 0) return new Map();

  const map = new Map<string, ExistingSession>();

  // Add buffer to time bounds for safety
  const minTime = timeBounds
    ? new Date(timeBounds.minTime.getTime() - TIME_BOUNDS_BUFFER_MS)
    : undefined;
  const maxTime = timeBounds
    ? new Date(timeBounds.maxTime.getTime() + TIME_BOUNDS_BUFFER_MS)
    : undefined;

  // Process in chunks to avoid lock exhaustion
  for (let i = 0; i < externalIds.length; i += DEDUP_CHUNK_SIZE) {
    const chunk = externalIds.slice(i, i + DEDUP_CHUNK_SIZE);

    // Build WHERE conditions
    const conditions = [
      eq(sessions.serverId, serverId),
      inArray(sessions.externalSessionId, chunk),
    ];

    // Add time bounds if provided (enables TimescaleDB chunk exclusion)
    if (minTime && maxTime) {
      conditions.push(gte(sessions.startedAt, minTime));
      conditions.push(lte(sessions.startedAt, maxTime));
    }

    const existing = await db
      .select({
        id: sessions.id,
        externalSessionId: sessions.externalSessionId,
        ratingKey: sessions.ratingKey,
        startedAt: sessions.startedAt,
        serverUserId: sessions.serverUserId,
        totalDurationMs: sessions.totalDurationMs,
        stoppedAt: sessions.stoppedAt,
        durationMs: sessions.durationMs,
        pausedDurationMs: sessions.pausedDurationMs,
        watched: sessions.watched,
        sourceVideoCodec: sessions.sourceVideoCodec,
        mediaType: sessions.mediaType,
        mediaId: sessions.mediaId,
        showMediaId: sessions.showMediaId,
      })
      .from(sessions)
      .where(and(...conditions));

    for (const s of existing) {
      if (s.externalSessionId) {
        map.set(s.externalSessionId, s);
      }
    }
  }

  return map;
}

/**
 * Query existing sessions by time-based keys (fallback dedup)
 *
 * Chunks the query to avoid PostgreSQL lock exhaustion with large IN clauses.
 * Uses time bounds derived from keys to enable TimescaleDB chunk exclusion.
 */
export async function queryExistingByTimeKeys(
  serverId: string,
  keys: Array<{ serverUserId: string; ratingKey: string; startedAt: Date }>
): Promise<Map<string, ExistingSession>> {
  if (keys.length === 0) return new Map();

  const map = new Map<string, ExistingSession>();

  // Get unique ratingKeys and serverUserIds
  const uniqueRatingKeys = [...new Set(keys.map((k) => k.ratingKey))];
  const uniqueUserIds = [...new Set(keys.map((k) => k.serverUserId))];

  // Compute time bounds from keys for TimescaleDB chunk exclusion
  // Add buffer to handle timezone/precision edge cases
  const TIME_BUFFER_MS = 60_000; // 1 minute buffer
  const timestamps = keys.map((k) => k.startedAt.getTime());
  const minTime = new Date(Math.min(...timestamps) - TIME_BUFFER_MS);
  const maxTime = new Date(Math.max(...timestamps) + TIME_BUFFER_MS);

  // Process ratingKeys in chunks to avoid lock exhaustion
  // (serverUserIds is typically much smaller, so we don't chunk it)
  for (let i = 0; i < uniqueRatingKeys.length; i += DEDUP_CHUNK_SIZE) {
    const ratingKeyChunk = uniqueRatingKeys.slice(i, i + DEDUP_CHUNK_SIZE);

    // Build a query that matches on ratingKey, serverUserId, and time bounds
    // Then we filter by startedAt in memory for exact time matching
    const existing = await db
      .select({
        id: sessions.id,
        externalSessionId: sessions.externalSessionId,
        ratingKey: sessions.ratingKey,
        startedAt: sessions.startedAt,
        serverUserId: sessions.serverUserId,
        totalDurationMs: sessions.totalDurationMs,
        stoppedAt: sessions.stoppedAt,
        durationMs: sessions.durationMs,
        pausedDurationMs: sessions.pausedDurationMs,
        watched: sessions.watched,
        sourceVideoCodec: sessions.sourceVideoCodec,
        mediaType: sessions.mediaType,
        mediaId: sessions.mediaId,
        showMediaId: sessions.showMediaId,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.serverId, serverId),
          inArray(sessions.ratingKey, ratingKeyChunk),
          inArray(sessions.serverUserId, uniqueUserIds),
          // Time bounds enable TimescaleDB chunk exclusion
          gte(sessions.startedAt, minTime),
          lte(sessions.startedAt, maxTime)
        )
      );

    for (const s of existing) {
      if (s.ratingKey && s.serverUserId && s.startedAt) {
        const timeKey = `${s.serverUserId}:${s.ratingKey}:${s.startedAt.getTime()}`;
        map.set(timeKey, s);
      }
    }
  }

  return map;
}

/**
 * Create a time-based key string from components
 */
export function createTimeKey(serverUserId: string, ratingKey: string, startedAt: Date): string {
  return `${serverUserId}:${ratingKey}:${startedAt.getTime()}`;
}
