/**
 * Tautulli API integration and import service
 */

import { eq, inArray, and } from 'drizzle-orm';
import { z } from 'zod';
import type { TautulliImportProgress, TautulliImportResult } from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, serverUsers, settings } from '../db/schema.js';
import { refreshAggregates } from '../db/timescale.js';
import { geoipService } from './geoip.js';
import type { PubSubService } from './cache.js';

const PAGE_SIZE = 5000; // Larger batches = fewer API calls (tested up to 10k, scales linearly)
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Base delay, will be multiplied by attempt number

// Helper for fields that can be number or empty string (Tautulli API inconsistency)
// Exported for testing
export const numberOrEmptyString = z.union([z.number(), z.literal('')]);

// Zod schemas for runtime validation of Tautulli API responses
// Based on actual API response from http://192.168.1.32:8181
// Exported for testing
export const TautulliHistoryRecordSchema = z.object({
  // IDs - can be null for active sessions
  reference_id: z.number().nullable(),
  row_id: z.number().nullable(),
  id: z.number().nullable(), // Additional ID field

  // Timestamps and durations - always numbers
  date: z.number(),
  started: z.number(),
  stopped: z.number(),
  duration: z.number(),
  play_duration: z.number(), // Actual play time
  paused_counter: z.number(),

  // User info (coerce handles string/number inconsistency across Tautulli versions)
  user_id: z.coerce.number(),
  user: z.string(),
  friendly_name: z.string(),
  user_thumb: z.string(), // User avatar URL

  // Player/client info
  platform: z.string(),
  product: z.string(),
  player: z.string(),
  ip_address: z.string(),
  machine_id: z.string(),
  location: z.string(),

  // Boolean-like flags (0/1) - can be null in some Tautulli versions
  live: z.number().nullable(),
  secure: z.number().nullable(),
  relayed: z.number().nullable(),

  // Media info
  media_type: z.string(),
  rating_key: z.number(), // Always number per actual API
  // These CAN be empty string for movies, number for episodes
  parent_rating_key: numberOrEmptyString,
  grandparent_rating_key: numberOrEmptyString,
  full_title: z.string(),
  title: z.string(),
  parent_title: z.string(),
  grandparent_title: z.string(),
  original_title: z.string().nullable(),
  // year: number for movies, empty string "" for episodes
  year: numberOrEmptyString,
  // media_index: number for episodes, empty string for movies
  media_index: numberOrEmptyString,
  parent_media_index: numberOrEmptyString,
  thumb: z.string(),
  originally_available_at: z.string(),
  guid: z.string(),

  // Playback info
  transcode_decision: z.string(),
  percent_complete: z.number(),
  watched_status: z.number(), // 0, 0.75, 1

  // Session grouping
  group_count: z.number().nullable(),
  group_ids: z.string().nullable(),
  state: z.string().nullable(),
  session_key: z.number().nullable(), // Actually just number | null per API
});

export const TautulliHistoryResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    message: z.string().nullable(),
    data: z.object({
      recordsFiltered: z.number(),
      recordsTotal: z.number(),
      data: z.array(TautulliHistoryRecordSchema),
      draw: z.number(),
      filter_duration: z.string(),
      total_duration: z.string(),
    }),
  }),
});

export const TautulliUserRecordSchema = z.object({
  user_id: z.coerce.number(),
  username: z.string(),
  friendly_name: z.string(),
  email: z.string().nullable(), // Can be null for local users
  thumb: z.string().nullable(), // Can be null for local users
  is_home_user: z.number().nullable(), // Can be null for local users
  is_admin: z.number(),
  is_active: z.number(),
  do_notify: z.number(),
});

export const TautulliUsersResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    message: z.string().nullable(),
    data: z.array(TautulliUserRecordSchema),
  }),
});

// Infer types from schemas - exported for testing
export type TautulliHistoryRecord = z.infer<typeof TautulliHistoryRecordSchema>;
export type TautulliHistoryResponse = z.infer<typeof TautulliHistoryResponseSchema>;
export type TautulliUserRecord = z.infer<typeof TautulliUserRecordSchema>;
export type TautulliUsersResponse = z.infer<typeof TautulliUsersResponseSchema>;

export class TautulliService {
  private baseUrl: string;
  private apiKey: string;

  constructor(url: string, apiKey: string) {
    this.baseUrl = url.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Make API request to Tautulli with timeout and retry logic
   */
  private async request<T>(
    cmd: string,
    params: Record<string, string | number> = {},
    schema?: z.ZodType<T>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v2`);
    url.searchParams.set('apikey', this.apiKey);
    url.searchParams.set('cmd', cmd);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url.toString(), {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Tautulli API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();

        // Validate response with Zod schema if provided
        if (schema) {
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            console.error('Tautulli API response validation failed:', z.treeifyError(parsed.error));
            throw new Error(`Invalid Tautulli API response: ${parsed.error.message}`);
          }
          return parsed.data;
        }

        return json as T;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error) {
          // Don't retry on abort (timeout) after max retries
          if (error.name === 'AbortError') {
            lastError = new Error(`Tautulli API timeout after ${REQUEST_TIMEOUT_MS}ms`);
          } else {
            lastError = error;
          }
        } else {
          lastError = new Error('Unknown error');
        }

        // Don't retry on validation errors
        if (lastError.message.includes('Invalid Tautulli API response')) {
          throw lastError;
        }

        // Wait before retrying (exponential backoff)
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt;
          console.warn(
            `Tautulli API request failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Tautulli API request failed after retries');
  }

  /**
   * Test connection to Tautulli
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.request<{ response: { result: string } }>('arnold');
      return result.response.result === 'success';
    } catch {
      return false;
    }
  }

  /**
   * Get all users from Tautulli
   */
  async getUsers(): Promise<TautulliUserRecord[]> {
    const result = await this.request<TautulliUsersResponse>(
      'get_users',
      {},
      TautulliUsersResponseSchema
    );
    return result.response.data ?? [];
  }

  /**
   * Get paginated history from Tautulli
   */
  async getHistory(
    start: number = 0,
    length: number = PAGE_SIZE
  ): Promise<{ records: TautulliHistoryRecord[]; total: number }> {
    const result = await this.request<TautulliHistoryResponse>(
      'get_history',
      {
        start,
        length,
        order_column: 'date',
        order_dir: 'desc',
      },
      TautulliHistoryResponseSchema
    );

    return {
      records: result.response.data?.data ?? [],
      // Use recordsFiltered (not recordsTotal) - Tautulli applies grouping/filtering by default
      total: result.response.data?.recordsFiltered ?? 0,
    };
  }

  /**
   * Import all history from Tautulli into Tracearr (OPTIMIZED)
   *
   * Performance improvements over original:
   * - Pre-fetches all existing sessions (1 query vs N queries for dedup)
   * - Batches INSERT operations (100 per batch vs individual inserts)
   * - Batches UPDATE operations in transactions
   * - Caches GeoIP lookups per IP address
   * - Throttles WebSocket updates (every 100 records or 2 seconds)
   * - Extends BullMQ lock on progress to prevent stalls with large imports
   */
  static async importHistory(
    serverId: string,
    pubSubService?: PubSubService,
    onProgress?: (progress: TautulliImportProgress) => Promise<void>
  ): Promise<TautulliImportResult> {
    // Get Tautulli settings
    const settingsRow = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);

    const config = settingsRow[0];
    if (!config?.tautulliUrl || !config?.tautulliApiKey) {
      return {
        success: false,
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        message: 'Tautulli is not configured. Please add URL and API key in Settings.',
      };
    }

    const tautulli = new TautulliService(config.tautulliUrl, config.tautulliApiKey);

    // Test connection
    const connected = await tautulli.testConnection();
    if (!connected) {
      return {
        success: false,
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        message: 'Failed to connect to Tautulli. Please check URL and API key.',
      };
    }

    // Initialize progress with detailed tracking
    const progress: TautulliImportProgress = {
      status: 'fetching',
      totalRecords: 0,
      fetchedRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      updatedRecords: 0,
      skippedRecords: 0,
      duplicateRecords: 0,
      unknownUserRecords: 0,
      activeSessionRecords: 0,
      errorRecords: 0,
      currentPage: 0,
      totalPages: 0,
      message: 'Connecting to Tautulli...',
    };

    // Throttled progress publishing (fire-and-forget, every 100 records or 2 seconds)
    // Also calls onProgress callback for BullMQ lock extension
    let lastProgressTime = Date.now();
    const publishProgress = () => {
      if (pubSubService) {
        pubSubService.publish('import:progress', progress).catch((err: unknown) => {
          console.warn('Failed to publish progress:', err);
        });
      }
      // Call onProgress callback (extends BullMQ lock for large imports)
      if (onProgress) {
        onProgress(progress).catch((err: unknown) => {
          console.warn('Failed to call onProgress callback:', err);
        });
      }
    };

    publishProgress();

    // Get user mapping (Tautulli user_id → Tracearr user_id)
    const userMap = new Map<number, string>();

    // Get all Tracearr server users for this server
    const tracearrUsers = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.serverId, serverId));

    // Map by externalId (Plex user ID)
    for (const serverUser of tracearrUsers) {
      if (serverUser.externalId) {
        const plexUserId = parseInt(serverUser.externalId, 10);
        if (!isNaN(plexUserId)) {
          userMap.set(plexUserId, serverUser.id);
        }
      }
    }

    // Get total count
    const { total } = await tautulli.getHistory(0, 1);
    progress.totalRecords = total;
    progress.totalPages = Math.ceil(total / PAGE_SIZE);
    progress.message = `Found ${total} records to import`;
    publishProgress();

    // === MEMORY OPTIMIZATION: Per-page dedup instead of pre-loading all sessions ===
    // This uses constant memory regardless of total import size (critical for 300k+ imports)
    // Trade-off: One extra query per page, but avoids loading 300k+ sessions into memory
    interface ExistingSession {
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
    }

    // Track externalSessionIds we've already inserted in THIS import run
    // (prevents duplicates within the same import when records appear on multiple pages)
    const insertedThisRun = new Set<string>();

    // Helper to query existing sessions for a batch of reference IDs
    const queryExistingByRefIds = async (
      refIds: string[]
    ): Promise<Map<string, ExistingSession>> => {
      if (refIds.length === 0) return new Map();

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
        })
        .from(sessions)
        .where(and(eq(sessions.serverId, serverId), inArray(sessions.externalSessionId, refIds)));

      const map = new Map<string, ExistingSession>();
      for (const s of existing) {
        if (s.externalSessionId) {
          map.set(s.externalSessionId, s);
        }
      }
      return map;
    };

    // Helper to query existing sessions by time-based key (fallback dedup)
    const queryExistingByTimeKeys = async (
      keys: Array<{ serverUserId: string; ratingKey: string; startedAt: Date }>
    ): Promise<Map<string, ExistingSession>> => {
      if (keys.length === 0) return new Map();

      // Build OR conditions for each key
      // This is less efficient than IN but necessary for composite key matching
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
    };

    console.log('[Import] Using per-page dedup queries (memory-efficient mode)');

    // === OPTIMIZATION: GeoIP cache (bounded - cleared every 50 pages to prevent unbounded growth) ===
    let geoCache = new Map<string, ReturnType<typeof geoipService.lookup>>();

    // === OPTIMIZATION: Batch collections ===
    // Inserts are batched per page (100 records) and flushed at end of each page
    const insertBatch: (typeof sessions.$inferInsert)[] = [];

    // Update batches - collected and flushed per page
    interface SessionUpdate {
      id: string;
      externalSessionId?: string;
      stoppedAt: Date;
      durationMs: number;
      pausedDurationMs: number;
      watched: boolean;
      progressMs?: number;
    }
    const updateBatch: SessionUpdate[] = [];

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let page = 0;

    // Track skipped users for warning message
    const skippedUsers = new Map<number, { username: string; count: number }>();

    // Helper to flush batches
    const flushBatches = async () => {
      // Flush inserts in chunks (drizzle-orm has stack overflow with large arrays due to spread operator)
      // See: https://github.com/drizzle-team/drizzle-orm/issues/1740
      if (insertBatch.length > 0) {
        const INSERT_CHUNK_SIZE = 500;
        for (let i = 0; i < insertBatch.length; i += INSERT_CHUNK_SIZE) {
          const chunk = insertBatch.slice(i, i + INSERT_CHUNK_SIZE);
          await db.insert(sessions).values(chunk);
        }
        insertBatch.length = 0;
      }

      // Flush updates in parallel chunks (much faster than sequential transaction)
      // Each update is independent, so we can safely parallelize
      // Pool has max 20 connections - chunks of 100 will queue but process efficiently
      if (updateBatch.length > 0) {
        const UPDATE_CHUNK_SIZE = 100;
        for (let i = 0; i < updateBatch.length; i += UPDATE_CHUNK_SIZE) {
          const chunk = updateBatch.slice(i, i + UPDATE_CHUNK_SIZE);
          await Promise.all(
            chunk.map((update) =>
              db
                .update(sessions)
                .set({
                  externalSessionId: update.externalSessionId,
                  stoppedAt: update.stoppedAt,
                  durationMs: update.durationMs,
                  pausedDurationMs: update.pausedDurationMs,
                  watched: update.watched,
                  progressMs: update.progressMs,
                })
                .where(eq(sessions.id, update.id))
            )
          );
        }
        updateBatch.length = 0;
      }
    };

    // Process all pages
    while (page * PAGE_SIZE < total) {
      progress.status = 'processing';
      progress.currentPage = page + 1;
      progress.message = `Processing page ${page + 1} of ${progress.totalPages}`;

      // Clear geo cache periodically to prevent unbounded growth (every 10 pages)
      if (page > 0 && page % 10 === 0) {
        geoCache = new Map();
      }

      const { records } = await tautulli.getHistory(page * PAGE_SIZE, PAGE_SIZE);

      // Track actual records fetched (may differ from API total if records changed)
      progress.fetchedRecords += records.length;

      // === MEMORY OPTIMIZATION: Per-page dedup queries ===
      // Extract all reference IDs from this page for batch dedup query
      const pageRefIds: string[] = [];
      const pageTimeKeys: Array<{ serverUserId: string; ratingKey: string; startedAt: Date }> = [];

      for (const record of records) {
        if (record.reference_id !== null) {
          pageRefIds.push(String(record.reference_id));
        }
        // Collect time-based keys for fallback dedup
        const serverUserId = userMap.get(record.user_id);
        const ratingKey = typeof record.rating_key === 'number' ? String(record.rating_key) : null;
        if (serverUserId && ratingKey) {
          pageTimeKeys.push({
            serverUserId,
            ratingKey,
            startedAt: new Date(record.started * 1000),
          });
        }
      }

      // Query existing sessions for this page (2 queries per page max)
      const sessionByExternalId = await queryExistingByRefIds(pageRefIds);
      const sessionByTimeKey = await queryExistingByTimeKeys(pageTimeKeys);

      for (const record of records) {
        progress.processedRecords++;

        try {
          // Find Tracearr server user by Plex user ID
          const serverUserId = userMap.get(record.user_id);
          if (!serverUserId) {
            // User not found in Tracearr - track for warning
            const existing = skippedUsers.get(record.user_id);
            if (existing) {
              existing.count++;
            } else {
              skippedUsers.set(record.user_id, {
                username: record.friendly_name || record.user,
                count: 1,
              });
            }
            skipped++;
            progress.skippedRecords++;
            progress.unknownUserRecords++;
            continue;
          }

          // Skip records without reference_id (active/in-progress sessions)
          if (record.reference_id === null) {
            skipped++;
            progress.skippedRecords++;
            progress.activeSessionRecords++;
            continue;
          }

          const referenceIdStr = String(record.reference_id);

          // Skip if we already inserted this in a previous page of THIS import run
          if (insertedThisRun.has(referenceIdStr)) {
            skipped++;
            progress.skippedRecords++;
            progress.duplicateRecords++;
            continue;
          }

          // Check if exists in database (per-page query result)
          const existingByRef = sessionByExternalId.get(referenceIdStr);
          if (existingByRef) {
            // Calculate new values - use started + duration for accurate concurrent calculations
            const newStoppedAt = new Date((record.started + record.duration) * 1000);
            const newDurationMs = record.duration * 1000;
            const newPausedDurationMs = record.paused_counter * 1000;
            const newWatched = record.watched_status === 1;
            const newProgressMs = Math.round(
              (record.percent_complete / 100) * (existingByRef.totalDurationMs ?? 0)
            );

            // Only update if something actually changed
            const stoppedAtChanged = existingByRef.stoppedAt?.getTime() !== newStoppedAt.getTime();
            const durationChanged = existingByRef.durationMs !== newDurationMs;
            const pausedChanged = existingByRef.pausedDurationMs !== newPausedDurationMs;
            const watchedChanged = existingByRef.watched !== newWatched;

            if (stoppedAtChanged || durationChanged || pausedChanged || watchedChanged) {
              updateBatch.push({
                id: existingByRef.id,
                stoppedAt: newStoppedAt,
                durationMs: newDurationMs,
                pausedDurationMs: newPausedDurationMs,
                watched: newWatched,
                progressMs: newProgressMs,
              });
              updated++;
              progress.updatedRecords++;
            } else {
              // No changes needed - true duplicate
              skipped++;
              progress.skippedRecords++;
              progress.duplicateRecords++;
            }
            continue;
          }

          // Fallback dedup check by time-based key
          const startedAt = new Date(record.started * 1000);
          const ratingKeyStr =
            typeof record.rating_key === 'number' ? String(record.rating_key) : null;

          if (ratingKeyStr) {
            const timeKey = `${serverUserId}:${ratingKeyStr}:${startedAt.getTime()}`;
            const existingByTime = sessionByTimeKey.get(timeKey);

            if (existingByTime) {
              // Calculate new values - use started + duration for accurate concurrent calculations
              const newStoppedAt = new Date((record.started + record.duration) * 1000);
              const newDurationMs = record.duration * 1000;
              const newPausedDurationMs = record.paused_counter * 1000;
              const newWatched = record.watched_status === 1;

              // Check if externalSessionId needs to be set (fallback match means it was missing)
              const needsExternalId = !existingByTime.externalSessionId;

              // Check if other fields changed
              const stoppedAtChanged =
                existingByTime.stoppedAt?.getTime() !== newStoppedAt.getTime();
              const durationChanged = existingByTime.durationMs !== newDurationMs;
              const pausedChanged = existingByTime.pausedDurationMs !== newPausedDurationMs;
              const watchedChanged = existingByTime.watched !== newWatched;

              // Only update if externalSessionId is missing OR something actually changed
              if (
                needsExternalId ||
                stoppedAtChanged ||
                durationChanged ||
                pausedChanged ||
                watchedChanged
              ) {
                updateBatch.push({
                  id: existingByTime.id,
                  externalSessionId: referenceIdStr,
                  stoppedAt: newStoppedAt,
                  durationMs: newDurationMs,
                  pausedDurationMs: newPausedDurationMs,
                  watched: newWatched,
                });
                updated++;
                progress.updatedRecords++;
              } else {
                // No changes needed - true duplicate
                skipped++;
                progress.skippedRecords++;
                progress.duplicateRecords++;
              }
              continue;
            }
          }

          // === OPTIMIZATION: Cached GeoIP lookup ===
          let geo = geoCache.get(record.ip_address);
          if (!geo) {
            geo = geoipService.lookup(record.ip_address);
            geoCache.set(record.ip_address, geo);
          }

          // Map media type
          let mediaType: 'movie' | 'episode' | 'track' = 'movie';
          if (record.media_type === 'episode') {
            mediaType = 'episode';
          } else if (record.media_type === 'track') {
            mediaType = 'track';
          }

          const sessionKey =
            record.session_key != null
              ? String(record.session_key)
              : `tautulli-${record.reference_id}`;

          // Track this insert to prevent duplicates within this import run
          insertedThisRun.add(referenceIdStr);

          // === OPTIMIZATION: Collect insert instead of executing ===
          insertBatch.push({
            serverId,
            serverUserId,
            sessionKey,
            ratingKey: ratingKeyStr,
            externalSessionId: referenceIdStr,
            state: 'stopped',
            mediaType,
            mediaTitle: record.full_title || record.title,
            grandparentTitle: record.grandparent_title || null,
            seasonNumber:
              typeof record.parent_media_index === 'number' ? record.parent_media_index : null,
            episodeNumber: typeof record.media_index === 'number' ? record.media_index : null,
            year: record.year || null,
            thumbPath: record.thumb || null,
            startedAt,
            lastSeenAt: startedAt,
            // Use started + duration as effective stop time for accurate concurrent stream calculations
            // Tautulli's `stopped` represents wall-clock time which can span days/months if user paused/resumed
            stoppedAt: new Date((record.started + record.duration) * 1000),
            durationMs: record.duration * 1000,
            totalDurationMs: null,
            progressMs: null,
            pausedDurationMs: record.paused_counter * 1000,
            watched: record.watched_status === 1,
            ipAddress: record.ip_address || '0.0.0.0',
            geoCity: geo.city,
            geoRegion: geo.region,
            geoCountry: geo.country,
            geoLat: geo.lat,
            geoLon: geo.lon,
            playerName: record.player || record.product,
            deviceId: record.machine_id || null,
            product: record.product || null,
            platform: record.platform,
            quality: record.transcode_decision === 'transcode' ? 'Transcode' : 'Direct',
            isTranscode: record.transcode_decision === 'transcode',
            // Tautulli only provides combined decision - use same value for both
            // 'direct play' → 'directplay' to match Plex/Jellyfin format
            videoDecision:
              record.transcode_decision === 'direct play'
                ? 'directplay'
                : record.transcode_decision,
            audioDecision:
              record.transcode_decision === 'direct play'
                ? 'directplay'
                : record.transcode_decision,
            bitrate: null,
          });

          imported++;
          progress.importedRecords++;
        } catch (error) {
          console.error('Error processing record:', record.reference_id, error);
          errors++;
          progress.errorRecords++;
        }

        // === OPTIMIZATION: Throttled progress updates ===
        const now = Date.now();
        if (progress.processedRecords % 100 === 0 || now - lastProgressTime > 2000) {
          publishProgress();
          lastProgressTime = now;
        }
      }

      // Flush batches at end of each page
      await flushBatches();

      page++;
    }

    // Final flush for any remaining records
    await flushBatches();

    // Refresh TimescaleDB aggregates so imported data appears in stats immediately
    progress.message = 'Refreshing aggregates...';
    publishProgress();
    try {
      await refreshAggregates();
    } catch (err) {
      console.warn('Failed to refresh aggregates after import:', err);
    }

    // Build final message with detailed breakdown
    const parts: string[] = [];
    if (imported > 0) parts.push(`${imported} new`);
    if (updated > 0) parts.push(`${updated} updated`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (errors > 0) parts.push(`${errors} errors`);

    let message = `Import complete: ${parts.join(', ')}`;

    if (skippedUsers.size > 0) {
      const skippedUserList = [...skippedUsers.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 5) // Show top 5 skipped users
        .map((u) => `${u.username} (${u.count} records)`)
        .join(', ');

      const moreUsers = skippedUsers.size > 5 ? ` and ${skippedUsers.size - 5} more` : '';
      message += `. Warning: ${skippedUsers.size} users not found in Tracearr: ${skippedUserList}${moreUsers}. Sync your server to import these users first.`;

      console.warn(
        `Tautulli import skipped users: ${[...skippedUsers.values()].map((u) => u.username).join(', ')}`
      );
    }

    // Final progress update
    progress.status = 'complete';
    progress.message = message;
    publishProgress();

    return {
      success: true,
      imported,
      updated,
      skipped,
      errors,
      message,
      skippedUsers:
        skippedUsers.size > 0
          ? [...skippedUsers.entries()].map(([id, data]) => ({
              tautulliUserId: id,
              username: data.username,
              recordCount: data.count,
            }))
          : undefined,
    };
  }
}
