/**
 * Batch Processor Module
 *
 * Handles chunked insert and update operations for session imports.
 * Uses 500-record chunks for inserts due to Drizzle ORM stack overflow with large arrays.
 * Uses 10-record chunks for updates to respect connection pool limits.
 *
 * See: https://github.com/drizzle-team/drizzle-orm/issues/1740
 *
 * Used by both Tautulli and Jellystat importers.
 */

import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import { storedSessionRowById } from '../../db/sessions/row.js';
import { uncapDecompressionForTx } from '../../db/timescale.js';
import { resolveImportedPlays } from '../library/importedPlayIdentity.js';
import { normalizeClient, normalizePlatformName } from '../../utils/platformNormalizer.js';
import { scrubStringFields } from '../../utils/sanitizeText.js';

// Default chunk sizes
const DEFAULT_INSERT_CHUNK_SIZE = 500;
const DEFAULT_UPDATE_CHUNK_SIZE = 10;

/**
 * Session insert data type
 */
export type NewSession = typeof sessions.$inferInsert;

/**
 * Session update data - only includes fields that can be updated
 */
export interface SessionUpdate {
  id: string;
  /** The stored row's started_at, used only to locate the row */
  startedAt: Date;
  externalSessionId?: string;
  stoppedAt?: Date;
  durationMs?: number;
  pausedDurationMs?: number;
  watched?: boolean;
  progressMs?: number;
}

/**
 * Options for batch insert operations
 */
export interface InsertBatchOptions {
  /** Number of records per chunk (default: 500) */
  chunkSize?: number;
}

/**
 * Options for batch update operations
 */
export interface UpdateBatchOptions {
  /** Number of records per chunk (default: 10) */
  chunkSize?: number;
}

/**
 * Normalize session device/platform fields before insert
 */
function normalizeSessionFields(session: NewSession): NewSession {
  // Get the client string to normalize (prefer product, fallback to playerName)
  const clientString = session.product || session.playerName || '';

  if (!clientString && !session.platform) {
    return session;
  }

  // Normalize client info (derives device from client string)
  const normalized = normalizeClient(clientString);

  // For platform: if we have an existing value, normalize it; otherwise use derived
  const normalizedPlatform = session.platform
    ? normalizePlatformName(session.platform)
    : normalized.platform;

  return {
    ...session,
    device: normalized.device,
    platform: normalizedPlatform,
  };
}

/**
 * Imported plays whose rating key found no library item still get a media identity, the way
 * a live play does at insert: the rows with none are resolved by title, year and numbers.
 */
async function stampImportedIdentity(rows: NewSession[]): Promise<void> {
  const pending = rows.filter(
    (row) =>
      row.mediaId == null &&
      row.externalSessionId != null &&
      (row.mediaType === 'movie' || row.mediaType === 'episode')
  );
  if (pending.length === 0) return;
  const { identities } = await resolveImportedPlays(pending);
  for (const [row, identity] of identities) {
    row.mediaId = identity.mediaId;
    row.showMediaId = identity.showMediaId;
  }
}

/**
 * Insert sessions in chunks to avoid Drizzle ORM stack overflow
 *
 * Automatically normalizes device/platform fields before insert.
 *
 * @param sessionsToInsert - Array of session records to insert
 * @param options - Options for batch processing
 * @returns Number of sessions inserted
 */
export async function flushInsertBatch(
  sessionsToInsert: NewSession[],
  options: InsertBatchOptions = {}
): Promise<number> {
  if (sessionsToInsert.length === 0) return 0;

  const chunkSize = options.chunkSize ?? DEFAULT_INSERT_CHUNK_SIZE;
  let insertedCount = 0;

  const normalizedSessions = sessionsToInsert.map((s) =>
    scrubStringFields(normalizeSessionFields(s))
  );
  await stampImportedIdentity(normalizedSessions);

  for (let i = 0; i < normalizedSessions.length; i += chunkSize) {
    const chunk = normalizedSessions.slice(i, i + chunkSize);
    // Historical rows landing in already-compressed chunk ranges trigger
    // unique-index verification against compressed segments; the per-DML
    // decompression cap (default 100000 tuples) could abort a large chunk.
    // Imports ran uncapped before the cap was restored globally, so keep that
    // - transaction-scoped, not global.
    await db.transaction(async (tx) => {
      await uncapDecompressionForTx(tx);
      await tx.insert(sessions).values(chunk);
    });
    insertedCount += chunk.length;
  }

  return insertedCount;
}

/**
 * Update sessions in parallel chunks to respect connection pool limits
 *
 * Each update is independent, so we can safely parallelize within chunks.
 * Pool has max 20 connections - keep chunk size within pool limits.
 *
 * Every UPDATE deliberately runs in its own implicit transaction, so each row
 * gets a fresh decompression budget - do not wrap this loop in db.transaction.
 *
 * @param updates - Array of session updates to apply
 * @param options - Options for batch processing
 * @returns Number of sessions updated
 */
export async function flushUpdateBatch(
  updates: SessionUpdate[],
  options: UpdateBatchOptions = {}
): Promise<number> {
  if (updates.length === 0) return 0;

  const chunkSize = options.chunkSize ?? DEFAULT_UPDATE_CHUNK_SIZE;
  let updatedCount = 0;

  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);

    await Promise.all(
      chunk.map((update) => {
        const { id, startedAt, ...data } = update;
        return db.update(sessions).set(data).where(storedSessionRowById({ id, startedAt }));
      })
    );

    updatedCount += chunk.length;
  }

  return updatedCount;
}

/**
 * Create a batch collector for insert operations
 *
 * Collects records and flushes when batch reaches target size or manually.
 */
export function createInsertBatchCollector(options: InsertBatchOptions = {}) {
  const batch: NewSession[] = [];
  const chunkSize = options.chunkSize ?? DEFAULT_INSERT_CHUNK_SIZE;
  let totalInserted = 0;

  return {
    /**
     * Add a session to the batch
     */
    add(session: NewSession): void {
      batch.push(session);
    },

    /**
     * Add multiple sessions to the batch
     */
    addAll(newSessions: NewSession[]): void {
      batch.push(...newSessions);
    },

    /**
     * Get current batch size
     */
    get size(): number {
      return batch.length;
    },

    /**
     * Check if batch should be flushed (at capacity)
     */
    shouldFlush(): boolean {
      return batch.length >= chunkSize;
    },

    /**
     * Flush the batch and clear it
     */
    async flush(): Promise<number> {
      if (batch.length === 0) return 0;

      const count = await flushInsertBatch(batch, { chunkSize });
      batch.length = 0;
      totalInserted += count;
      return count;
    },

    /**
     * Get total number of records inserted across all flushes
     */
    get totalInserted(): number {
      return totalInserted;
    },
  };
}

/**
 * Create a batch collector for update operations
 */
export function createUpdateBatchCollector(options: UpdateBatchOptions = {}) {
  const batch: SessionUpdate[] = [];
  const chunkSize = options.chunkSize ?? DEFAULT_UPDATE_CHUNK_SIZE;
  let totalUpdated = 0;

  return {
    /**
     * Add an update to the batch
     */
    add(update: SessionUpdate): void {
      batch.push(update);
    },

    /**
     * Add multiple updates to the batch
     */
    addAll(updates: SessionUpdate[]): void {
      batch.push(...updates);
    },

    /**
     * Get current batch size
     */
    get size(): number {
      return batch.length;
    },

    /**
     * Check if batch should be flushed
     */
    shouldFlush(): boolean {
      return batch.length >= chunkSize;
    },

    /**
     * Flush the batch and clear it
     */
    async flush(): Promise<number> {
      if (batch.length === 0) return 0;

      const count = await flushUpdateBatch(batch, { chunkSize });
      batch.length = 0;
      totalUpdated += count;
      return count;
    },

    /**
     * Get total number of records updated across all flushes
     */
    get totalUpdated(): number {
      return totalUpdated;
    },
  };
}
