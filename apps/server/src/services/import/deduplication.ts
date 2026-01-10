/**
 * Session Deduplication Module
 *
 * Provides two-tier deduplication for import operations:
 * 1. Tier 1: Match by externalSessionId (fast, exact)
 * 2. Tier 2: Match by composite time-based key (fallback for missing external IDs)
 *
 * Used by both Tautulli and Jellystat importers.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';

/**
 * Existing session data needed for deduplication decisions
 */
export interface ExistingSession {
  id: string;
  externalSessionId: string | null;
  ratingKey: string | null;
  startedAt: Date | null;
  serverUserId: string;
  totalDurationMs: number | null;
  stoppedAt: Date | null;
  durationMs: number | null;
  pausedDurationMs: number | null;
  watched: boolean | null;
  sourceVideoCodec: string | null;
}

/**
 * Result of deduplication process
 */
export interface DeduplicationResult<T> {
  /** Records that should be inserted (new) */
  toInsert: T[];
  /** Records that should be updated (exist but changed) */
  toUpdate: Array<{ existing: ExistingSession; incoming: T }>;
  /** Count of records skipped (duplicates with no changes) */
  skipped: number;
  /** Count of records that were duplicates (subset of skipped) */
  duplicates: number;
}

/**
 * Configuration for deduplication behavior
 */
export interface DeduplicationConfig<T, TExternalId extends string | number> {
  /** Extract external ID from a record (e.g., Tautulli reference_id, Jellystat Id) */
  getExternalId: (record: T) => TExternalId | null;
  /** Extract time-based key for fallback matching */
  getTimeKey: (record: T) => { serverUserId: string; ratingKey: string; startedAt: Date } | null;
  /** Whether to check for updates on existing records (Tautulli: true, Jellystat: false) */
  allowUpdates?: boolean;
  /** Function to determine if an existing record should be updated */
  shouldUpdate?: (existing: ExistingSession, incoming: T) => boolean;
}

/**
 * Query existing sessions by external IDs
 */
export async function queryExistingByExternalIds(
  serverId: string,
  externalIds: string[]
): Promise<Map<string, ExistingSession>> {
  if (externalIds.length === 0) return new Map();

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
    })
    .from(sessions)
    .where(and(eq(sessions.serverId, serverId), inArray(sessions.externalSessionId, externalIds)));

  const map = new Map<string, ExistingSession>();
  for (const s of existing) {
    if (s.externalSessionId) {
      map.set(s.externalSessionId, s);
    }
  }
  return map;
}

/**
 * Query existing sessions by time-based keys (fallback dedup)
 */
export async function queryExistingByTimeKeys(
  serverId: string,
  keys: Array<{ serverUserId: string; ratingKey: string; startedAt: Date }>
): Promise<Map<string, ExistingSession>> {
  if (keys.length === 0) return new Map();

  // Build a query that matches on ratingKey and serverUserId
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
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        inArray(
          sessions.ratingKey,
          keys.map((k) => k.ratingKey)
        ),
        inArray(sessions.serverUserId, [...new Set(keys.map((k) => k.serverUserId))])
      )
    );

  const map = new Map<string, ExistingSession>();
  for (const s of existing) {
    if (s.ratingKey && s.serverUserId && s.startedAt) {
      const timeKey = `${s.serverUserId}:${s.ratingKey}:${s.startedAt.getTime()}`;
      map.set(timeKey, s);
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

/**
 * Deduplicate a batch of records against existing sessions
 *
 * @param serverId - The server ID to scope the dedup query
 * @param records - The records to deduplicate
 * @param config - Configuration for how to extract IDs and handle updates
 * @param insertedThisRun - Set of external IDs already inserted in this import run
 */
export async function deduplicateBatch<T, TExternalId extends string | number>(
  serverId: string,
  records: T[],
  config: DeduplicationConfig<T, TExternalId>,
  insertedThisRun: Set<string>
): Promise<DeduplicationResult<T>> {
  const result: DeduplicationResult<T> = {
    toInsert: [],
    toUpdate: [],
    skipped: 0,
    duplicates: 0,
  };

  if (records.length === 0) return result;

  // Collect external IDs for batch query
  const externalIds: string[] = [];
  const timeKeys: Array<{ serverUserId: string; ratingKey: string; startedAt: Date }> = [];

  for (const record of records) {
    const externalId = config.getExternalId(record);
    if (externalId !== null) {
      externalIds.push(String(externalId));
    }

    const timeKeyData = config.getTimeKey(record);
    if (timeKeyData) {
      timeKeys.push(timeKeyData);
    }
  }

  // Query existing sessions in batches
  const sessionByExternalId = await queryExistingByExternalIds(serverId, externalIds);
  const sessionByTimeKey = await queryExistingByTimeKeys(serverId, timeKeys);

  // Process each record
  for (const record of records) {
    const externalId = config.getExternalId(record);
    const externalIdStr = externalId !== null ? String(externalId) : null;

    // Check if already inserted in this import run
    if (externalIdStr && insertedThisRun.has(externalIdStr)) {
      result.skipped++;
      result.duplicates++;
      continue;
    }

    // Check by external ID first
    if (externalIdStr) {
      const existing = sessionByExternalId.get(externalIdStr);
      if (existing) {
        if (config.allowUpdates && config.shouldUpdate?.(existing, record)) {
          result.toUpdate.push({ existing, incoming: record });
        } else {
          result.skipped++;
          result.duplicates++;
        }
        continue;
      }
    }

    // Fallback: check by time-based key
    const timeKeyData = config.getTimeKey(record);
    if (timeKeyData) {
      const timeKeyStr = createTimeKey(
        timeKeyData.serverUserId,
        timeKeyData.ratingKey,
        timeKeyData.startedAt
      );
      const existing = sessionByTimeKey.get(timeKeyStr);
      if (existing) {
        if (config.allowUpdates && config.shouldUpdate?.(existing, record)) {
          result.toUpdate.push({ existing, incoming: record });
        } else {
          result.skipped++;
          result.duplicates++;
        }
        continue;
      }
    }

    // No match found - this is a new record
    result.toInsert.push(record);
    if (externalIdStr) {
      insertedThisRun.add(externalIdStr);
    }
  }

  return result;
}

/**
 * Create a deduplication context for an import operation
 *
 * This provides a convenient wrapper that manages the insertedThisRun set
 * and provides batch-by-batch deduplication.
 */
export function createDeduplicationContext<T, TExternalId extends string | number>(
  serverId: string,
  config: DeduplicationConfig<T, TExternalId>
) {
  const insertedThisRun = new Set<string>();

  return {
    /**
     * Deduplicate a batch of records
     */
    async deduplicate(records: T[]): Promise<DeduplicationResult<T>> {
      return deduplicateBatch(serverId, records, config, insertedThisRun);
    },

    /**
     * Get the set of IDs inserted in this import run
     */
    getInsertedIds(): Set<string> {
      return insertedThisRun;
    },

    /**
     * Mark an ID as inserted (for manual tracking)
     */
    markInserted(externalId: string): void {
      insertedThisRun.add(externalId);
    },
  };
}
