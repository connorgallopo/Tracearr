/**
 * Tautulli API integration and import service
 */

import { eq, and, isNull, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TautulliImportProgress, TautulliImportResult } from '@tracearr/shared';
import { db } from '../db/client.js';
import { settings, sessions, serverUsers, users } from '../db/schema.js';
import { refreshAggregates, checkAggregateNeedsRebuild } from '../db/timescale.js';
import { enqueueMaintenanceJob } from '../jobs/maintenanceQueue.js';
import { geoipService } from './geoip.js';
import { geoasnService } from './geoasn.js';
import type { PubSubService } from './cache.js';
import {
  queryExistingByExternalIds,
  queryExistingByTimeKeys,
  createTimeKey,
  createUserMapping,
  createSkippedUserTracker,
  flushInsertBatch,
  flushUpdateBatch,
  type SessionUpdate,
  type TimeBounds,
  createSimpleProgressPublisher,
} from './import/index.js';
import { normalizeClient } from '../utils/platformNormalizer.js';
import { normalizeStreamDecisions } from '../utils/transcodeNormalizer.js';
import { sanitizeCodec } from '../utils/codecNormalizer.js';
import { extractIpFromEndpoint } from '../utils/parsing.js';

const PAGE_SIZE = 5000; // Larger batches = fewer API calls (tested up to 10k, scales linearly)
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Base delay, will be multiplied by attempt number

// Helper for fields that can be number or empty string (Tautulli API inconsistency)
// Exported for testing
export const numberOrEmptyString = z.union([z.number(), z.literal('')]);
// Helper for fields that can be number, empty string, or null (movies have null parent/grandparent keys)
export const numberOrEmptyStringOrNull = z.union([z.number(), z.literal(''), z.null()]);

// Zod schemas for runtime validation of Tautulli API responses
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
  user: z.string().nullable(), // Only used in warning message
  friendly_name: z.string().nullable(),
  user_thumb: z.string().nullable(), // User avatar URL

  // Player/client info
  platform: z.string().nullable(),
  product: z.string().nullable(),
  player: z.string().nullable(),
  ip_address: z.string().nullable(),
  machine_id: z.string().nullable(),
  location: z.string().nullable(),

  // Boolean-like flags (0/1) - can be null in some Tautulli versions
  live: z.number().nullable(),
  secure: z.number().nullable(),
  relayed: z.number().nullable(),

  // Media info
  media_type: z.string(),
  rating_key: z.coerce.number(), // Coerce handles string/number inconsistency
  // These CAN be empty string, number, or null depending on media type
  parent_rating_key: numberOrEmptyStringOrNull,
  grandparent_rating_key: numberOrEmptyStringOrNull,
  full_title: z.string(),
  title: z.string(),
  parent_title: z.string().nullable(),
  grandparent_title: z.string().nullable(),
  original_title: z.string().nullable(),
  // year: number for movies, empty string "" for episodes, or null
  year: numberOrEmptyStringOrNull,
  // media_index: number for episodes, empty string for movies, or null
  media_index: numberOrEmptyStringOrNull,
  parent_media_index: numberOrEmptyStringOrNull,
  thumb: z.string().nullable(),
  originally_available_at: z.string().nullable(),
  guid: z.string().nullable(),

  // Playback info
  transcode_decision: z.string().nullable(),
  percent_complete: z.coerce.number(),
  watched_status: z.coerce.number(), // 0, 0.75, 1

  // Session grouping
  group_count: z.number().nullable(),
  group_ids: z.string().nullable(),
  state: z.string().nullable(),
  session_key: z.union([z.null(), z.coerce.number()]), // Null first, then coerce string/number
});

// Response schema with raw data array - individual records validated separately
// This allows the import to continue even if some records have unexpected data
export const TautulliHistoryResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    message: z.string().nullable(),
    data: z.object({
      recordsFiltered: z.number(),
      recordsTotal: z.number(),
      data: z.array(z.unknown()), // Validate records individually during processing
      draw: z.number(),
      filter_duration: z.string(),
      total_duration: z.string(),
    }),
  }),
});

export const TautulliUserRecordSchema = z.object({
  user_id: z.coerce.number(),
  username: z.string(),
  friendly_name: z.string().nullable(),
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

// Stream data schema for detailed quality info (from get_stream_data endpoint)
const stringOrEmpty = z.union([z.string(), z.literal('')]).transform((v) => (v === '' ? null : v));
const numberOrEmpty = z
  .union([z.number(), z.string()])
  .transform((v) => (v === '' ? null : typeof v === 'string' ? parseInt(v, 10) || null : v));
// Tautulli returns "" for boolean-like fields when they're not applicable
const boolOrEmpty = z
  .union([z.number(), z.boolean(), z.literal('')])
  .transform((v) => (v === '' ? null : v === 1 || v === true));

export const TautulliStreamDataSchema = z.object({
  // Source video info
  video_codec: stringOrEmpty.nullable().optional(),
  video_width: numberOrEmpty.nullable().optional(),
  video_height: numberOrEmpty.nullable().optional(),
  video_bitrate: numberOrEmpty.nullable().optional(),
  video_bit_depth: numberOrEmpty.nullable().optional(),
  video_framerate: stringOrEmpty.nullable().optional(),
  video_dynamic_range: stringOrEmpty.nullable().optional(),
  video_profile: stringOrEmpty.nullable().optional(),
  video_codec_level: stringOrEmpty.nullable().optional(),
  video_color_primaries: stringOrEmpty.nullable().optional(),
  video_color_space: stringOrEmpty.nullable().optional(),
  video_color_trc: stringOrEmpty.nullable().optional(),

  // Source audio info
  audio_codec: stringOrEmpty.nullable().optional(),
  audio_bitrate: numberOrEmpty.nullable().optional(),
  audio_channels: numberOrEmpty.nullable().optional(),
  audio_channel_layout: stringOrEmpty.nullable().optional(),
  audio_sample_rate: numberOrEmpty.nullable().optional(),
  audio_language: stringOrEmpty.nullable().optional(),
  audio_language_code: stringOrEmpty.nullable().optional(),

  // Stream output info (after transcode)
  stream_video_codec: stringOrEmpty.nullable().optional(),
  stream_video_bitrate: numberOrEmpty.nullable().optional(),
  stream_video_width: numberOrEmpty.nullable().optional(),
  stream_video_height: numberOrEmpty.nullable().optional(),
  stream_video_framerate: stringOrEmpty.nullable().optional(),
  stream_video_dynamic_range: stringOrEmpty.nullable().optional(),

  stream_audio_codec: stringOrEmpty.nullable().optional(),
  stream_audio_bitrate: numberOrEmpty.nullable().optional(),
  stream_audio_channels: numberOrEmpty.nullable().optional(),
  stream_audio_channel_layout: stringOrEmpty.nullable().optional(),
  stream_audio_language: stringOrEmpty.nullable().optional(),

  // Transcode decisions
  transcode_decision: stringOrEmpty.nullable().optional(),
  video_decision: stringOrEmpty.nullable().optional(),
  audio_decision: stringOrEmpty.nullable().optional(),
  container_decision: stringOrEmpty.nullable().optional(),
  subtitle_decision: stringOrEmpty.nullable().optional(),

  // Container info
  container: stringOrEmpty.nullable().optional(),
  stream_container: stringOrEmpty.nullable().optional(),

  // Bandwidth/bitrate
  bitrate: numberOrEmpty.nullable().optional(),
  stream_bitrate: numberOrEmpty.nullable().optional(),
  bandwidth: numberOrEmpty.nullable().optional(),

  // Hardware transcoding
  transcode_hw_requested: boolOrEmpty.nullable().optional(),
  transcode_hw_decoding: boolOrEmpty.nullable().optional(),
  transcode_hw_encoding: boolOrEmpty.nullable().optional(),
  transcode_hw_decode: stringOrEmpty.nullable().optional(),
  transcode_hw_encode: stringOrEmpty.nullable().optional(),
  transcode_speed: stringOrEmpty.nullable().optional(),
  transcode_throttled: boolOrEmpty.nullable().optional(),

  // Subtitle info
  subtitle_codec: stringOrEmpty.nullable().optional(),
  subtitle_language: stringOrEmpty.nullable().optional(),
  subtitle_language_code: stringOrEmpty.nullable().optional(),
  subtitle_forced: boolOrEmpty.nullable().optional(),

  // Quality profile
  quality_profile: stringOrEmpty.nullable().optional(),
});

export const TautulliStreamDataResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    message: z.string().nullable(),
    data: TautulliStreamDataSchema.nullable(),
  }),
});

// Infer types from schemas - exported for testing
export type TautulliHistoryRecord = z.infer<typeof TautulliHistoryRecordSchema>;
export type TautulliHistoryResponse = z.infer<typeof TautulliHistoryResponseSchema>;
export type TautulliUserRecord = z.infer<typeof TautulliUserRecordSchema>;
export type TautulliUsersResponse = z.infer<typeof TautulliUsersResponseSchema>;
export type TautulliStreamData = z.infer<typeof TautulliStreamDataSchema>;
export type TautulliStreamDataResponse = z.infer<typeof TautulliStreamDataResponseSchema>;

export class TautulliService {
  private baseUrl: string;
  private apiKey: string;

  constructor(url: string, apiKey: string) {
    // Validate URL format
    try {
      new URL(url);
    } catch {
      throw new Error('Invalid Tautulli URL format');
    }
    if (!apiKey || apiKey.length < 1) {
      throw new Error('Tautulli API key is required');
    }
    this.baseUrl = url.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Sync friendly/custom user names from Tautulli to Tracearr identities
   */
  private static async syncFriendlyNamesFromTautulli(
    serverId: string,
    tautulli: TautulliService,
    overwriteAll: boolean
  ): Promise<number> {
    const tautulliUsers = await tautulli.getUsers();

    // Build map of externalId -> friendly name (trimmed, non-empty)
    const friendlyByExternalId = new Map<string, string>();
    for (const user of tautulliUsers) {
      const friendlyName = user.friendly_name?.trim();
      if (friendlyName) {
        friendlyByExternalId.set(String(user.user_id), friendlyName);
      }
    }

    if (friendlyByExternalId.size === 0) {
      return 0;
    }

    // Fetch server users for this server with linked identity info
    const serverUserRows = await db
      .select({
        serverUserId: serverUsers.id,
        externalId: serverUsers.externalId,
        userId: serverUsers.userId,
        identityName: users.name,
      })
      .from(serverUsers)
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(eq(serverUsers.serverId, serverId));

    const updates = new Map<string, string>();

    for (const row of serverUserRows) {
      const friendlyName = friendlyByExternalId.get(row.externalId);
      if (!friendlyName) continue;

      const currentName = row.identityName?.trim();
      const hasExistingName = !!currentName && currentName.length > 0;
      if (hasExistingName && !overwriteAll) continue;

      if (currentName === friendlyName) continue;

      updates.set(row.userId, friendlyName);
    }

    if (updates.size === 0) {
      return 0;
    }

    await db.transaction(async (tx) => {
      for (const [userId, friendlyName] of updates) {
        await tx
          .update(users)
          .set({
            name: friendlyName,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
      }
    });

    return updates.size;
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
    } catch (err) {
      console.warn('[Tautulli] Connection test failed:', err instanceof Error ? err.message : err);
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
   * Returns raw records (unknown[]) - caller must validate each record individually
   */
  async getHistory(
    start: number = 0,
    length: number = PAGE_SIZE
  ): Promise<{ records: unknown[]; total: number }> {
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
   * Get detailed stream data for a specific session
   * This provides codec, bitrate, resolution, and transcode details not available in get_history
   *
   * @param rowId - The row_id from get_history (used as the session identifier)
   * @param sessionKey - Optional session key for additional lookup
   * @returns Stream data or null if not found/failed
   */
  async getStreamData(rowId: number, sessionKey?: string): Promise<TautulliStreamData | null> {
    try {
      const params: Record<string, string | number> = { row_id: rowId };
      if (sessionKey) {
        params.session_key = sessionKey;
      }

      const result = await this.request<TautulliStreamDataResponse>(
        'get_stream_data',
        params,
        TautulliStreamDataResponseSchema
      );

      // Tautulli returns empty object {} for non-existent row_ids
      if (
        result.response.result !== 'success' ||
        !result.response.data ||
        Object.keys(result.response.data).length === 0
      ) {
        return null;
      }

      return result.response.data;
    } catch (error) {
      // Log errors - important for debugging
      console.warn(`[Tautulli] Failed to get stream data for row ${rowId}:`, error);
      return null;
    }
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
    onProgress?: (progress: TautulliImportProgress) => Promise<void>,
    options?: { overwriteFriendlyNames?: boolean; skipRefresh?: boolean }
  ): Promise<TautulliImportResult> {
    const overwriteFriendlyNames = options?.overwriteFriendlyNames ?? false;
    const skipRefresh = options?.skipRefresh ?? false;

    // Get Tautulli settings
    const settingsRow = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);

    const config = settingsRow[0];
    if (!config?.tautulliUrl || !config?.tautulliApiKey) {
      return {
        success: false,
        imported: 0,
        updated: 0,
        linked: 0,
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
        linked: 0,
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

    // Create progress publisher using shared module
    const publishProgress = createSimpleProgressPublisher(
      pubSubService,
      'import:progress',
      onProgress
    );

    publishProgress(progress);

    // Sync friendly/custom names from Tautulli before importing history
    progress.message = 'Syncing user display names from Tautulli...';
    publishProgress(progress);

    try {
      const updatedNames = await TautulliService.syncFriendlyNamesFromTautulli(
        serverId,
        tautulli,
        overwriteFriendlyNames
      );
      if (updatedNames > 0) {
        console.log(`[Import] Updated ${updatedNames} user display names from Tautulli`);
      }
    } catch (err) {
      console.warn('[Import] Failed to sync Tautulli friendly names:', err);
    }

    // Get user mapping using shared module
    const userMapRaw = await createUserMapping(serverId);
    // Convert to number keys for Tautulli (Plex uses numeric user IDs)
    const userMap = new Map<number, string>();
    for (const [externalId, userId] of userMapRaw) {
      // Strict numeric validation to prevent parseInt('123abc') -> 123
      if (/^\d+$/.test(externalId)) {
        userMap.set(parseInt(externalId, 10), userId);
      }
    }

    // Get total count
    const { total } = await tautulli.getHistory(0, 1);
    progress.totalRecords = total;
    progress.totalPages = Math.ceil(total / PAGE_SIZE);
    progress.message = `Found ${total} records to import`;
    publishProgress(progress);

    // Track externalSessionIds we've already inserted in THIS import run
    const insertedThisRun = new Set<string>();

    // Track date range of imported data for bounded aggregate refresh
    let minImportDate: Date | null = null;
    let maxImportDate: Date | null = null;

    // Track sessions that need referenceId linking (child → parent external IDs)
    // group_ids from Tautulli contains comma-separated session IDs in the same viewing chain
    // startedAt is stored to enable time-bounded queries in the linking phase
    const sessionGroupLinks: Array<{
      childExternalId: string;
      parentExternalId: string;
      startedAt: Date;
    }> = [];

    // Track skipped users using shared module
    const skippedUserTracker = createSkippedUserTracker();

    console.log('[Import] Using per-page dedup queries (memory-efficient mode)');

    // GeoIP cache (bounded - cleared every 10 pages to prevent unbounded growth)
    let geoCache = new Map<string, ReturnType<typeof geoipService.lookup>>();

    // Batch collections
    const insertBatch: (typeof sessions.$inferInsert)[] = [];
    const updateBatch: SessionUpdate[] = [];

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    let page = 0;

    // Throttle tracking for progress updates
    let lastProgressTime = Date.now();

    // Helper to flush batches using shared modules
    const flushBatches = async () => {
      if (insertBatch.length > 0) {
        await flushInsertBatch(insertBatch);
        insertBatch.length = 0;
      }
      if (updateBatch.length > 0) {
        await flushUpdateBatch(updateBatch);
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

      const { records: rawRecords } = await tautulli.getHistory(page * PAGE_SIZE, PAGE_SIZE);

      // Track actual records fetched (may differ from API total if records changed)
      progress.fetchedRecords += rawRecords.length;

      // Validate records individually - skip bad records instead of failing entire page
      const validRecords: TautulliHistoryRecord[] = [];
      for (const raw of rawRecords) {
        const parsed = TautulliHistoryRecordSchema.safeParse(raw);
        if (parsed.success) {
          validRecords.push(parsed.data);
        } else {
          // Log first error for debugging, count as error
          const refId = (raw as Record<string, unknown>)?.reference_id ?? 'unknown';
          console.warn(`[Tautulli] Skipping malformed record ${refId}:`, parsed.error.issues[0]);
          errors++;
          progress.errorRecords++;
          progress.processedRecords++;
        }
      }

      // === Per-page dedup queries using shared modules ===
      const pageRefIds: string[] = [];
      const pageTimeKeys: Array<{ serverUserId: string; ratingKey: string; startedAt: Date }> = [];
      const pageTimestamps: number[] = [];

      for (const record of validRecords) {
        if (record.reference_id !== null) {
          pageRefIds.push(String(record.reference_id));
        }
        // Collect timestamps for time bounds
        pageTimestamps.push(record.started * 1000);

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

      // Compute time bounds for this page to enable TimescaleDB chunk exclusion
      const pageTimeBounds: TimeBounds | undefined =
        pageTimestamps.length > 0
          ? {
              minTime: new Date(Math.min(...pageTimestamps)),
              maxTime: new Date(Math.max(...pageTimestamps)),
            }
          : undefined;

      // Query existing sessions for this page using shared modules
      const sessionByExternalId = await queryExistingByExternalIds(
        serverId,
        pageRefIds,
        pageTimeBounds
      );
      const sessionByTimeKey = await queryExistingByTimeKeys(serverId, pageTimeKeys);

      for (const record of validRecords) {
        progress.processedRecords++;

        try {
          // Find Tracearr server user by Plex user ID
          const serverUserId = userMap.get(record.user_id);
          if (!serverUserId) {
            skippedUserTracker.track(
              record.user_id,
              record.friendly_name || record.user || 'Unknown'
            );
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

          // Validate field lengths to prevent varchar overflow errors
          // Check fields that map to varchar columns with limits
          const fieldOverflows: string[] = [];
          if (record.product && record.product.length > 255) fieldOverflows.push('product');
          if (record.player && record.player.length > 255) fieldOverflows.push('player');
          if (record.machine_id && record.machine_id.length > 255)
            fieldOverflows.push('machine_id');
          if (record.thumb && record.thumb.length > 500) fieldOverflows.push('thumb');
          // For music tracks, artist/album names map to varchar(255)
          if (record.media_type === 'track') {
            if (record.grandparent_title && record.grandparent_title.length > 255)
              fieldOverflows.push('grandparent_title(artistName)');
            if (record.parent_title && record.parent_title.length > 255)
              fieldOverflows.push('parent_title(albumName)');
          }
          if (fieldOverflows.length > 0) {
            console.warn(
              `[Tautulli] Skipping record ${referenceIdStr}: field overflow in ${fieldOverflows.join(', ')}`
            );
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Check if exists in database (per-page query result)
          const existingByRef = sessionByExternalId.get(referenceIdStr);
          if (existingByRef) {
            // Calculate new values
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
              skipped++;
              progress.skippedRecords++;
              progress.duplicateRecords++;
            }

            // Still collect group links for existing records (to fix historical data)
            if (record.group_count && record.group_count > 1 && record.group_ids) {
              const groupIds = record.group_ids.split(',').map((id) => id.trim());
              const parentExternalId = groupIds[0];
              if (parentExternalId && parentExternalId !== referenceIdStr) {
                sessionGroupLinks.push({
                  childExternalId: referenceIdStr,
                  parentExternalId,
                  startedAt: new Date(record.started * 1000),
                });
              }
            }
            continue;
          }

          // Fallback dedup check by time-based key
          const startedAt = new Date(record.started * 1000);

          // Track date range for bounded aggregate refresh
          if (!minImportDate || startedAt < minImportDate) minImportDate = startedAt;
          if (!maxImportDate || startedAt > maxImportDate) maxImportDate = startedAt;

          const ratingKeyStr =
            typeof record.rating_key === 'number' ? String(record.rating_key) : null;

          if (ratingKeyStr) {
            const timeKeyStr = createTimeKey(serverUserId, ratingKeyStr, startedAt);
            const existingByTime = sessionByTimeKey.get(timeKeyStr);

            if (existingByTime) {
              const newStoppedAt = new Date((record.started + record.duration) * 1000);
              const newDurationMs = record.duration * 1000;
              const newPausedDurationMs = record.paused_counter * 1000;
              const newWatched = record.watched_status === 1;

              const needsExternalId = !existingByTime.externalSessionId;
              const stoppedAtChanged =
                existingByTime.stoppedAt?.getTime() !== newStoppedAt.getTime();
              const durationChanged = existingByTime.durationMs !== newDurationMs;
              const pausedChanged = existingByTime.pausedDurationMs !== newPausedDurationMs;
              const watchedChanged = existingByTime.watched !== newWatched;

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
                skipped++;
                progress.skippedRecords++;
                progress.duplicateRecords++;
              }

              // Still collect group links for existing records (to fix historical data)
              if (record.group_count && record.group_count > 1 && record.group_ids) {
                const groupIds = record.group_ids.split(',').map((id) => id.trim());
                const parentExternalId = groupIds[0];
                if (parentExternalId && parentExternalId !== referenceIdStr) {
                  sessionGroupLinks.push({
                    childExternalId: referenceIdStr,
                    parentExternalId,
                    startedAt,
                  });
                }
              }
              continue;
            }
          }

          // Cached GeoIP lookup
          const ipForLookup = extractIpFromEndpoint(record.ip_address);
          let geo = geoCache.get(ipForLookup);
          if (!geo) {
            const baseGeo = geoipService.lookup(ipForLookup);
            const asn = geoasnService.lookup(ipForLookup);
            geo = {
              ...baseGeo,
              asnNumber: asn.number,
              asnOrganization: asn.organization,
            };
            geoCache.set(ipForLookup, geo);
          }

          // Map media type - check live flag FIRST (live content reports as movie/episode)
          let mediaType: 'movie' | 'episode' | 'track' | 'live' = 'movie';
          if (record.live === 1) {
            mediaType = 'live';
          } else if (record.media_type === 'episode') {
            mediaType = 'episode';
          } else if (record.media_type === 'track') {
            mediaType = 'track';
          }

          // Music-specific fields (only for tracks)
          const isMusic = record.media_type === 'track';
          const artistName = isMusic ? record.grandparent_title || null : null;
          const albumName = isMusic ? record.parent_title || null : null;
          const trackNumber =
            isMusic && typeof record.media_index === 'number' ? record.media_index : null;
          const discNumber =
            isMusic && typeof record.parent_media_index === 'number'
              ? record.parent_media_index
              : null;

          const sessionKey =
            record.session_key != null
              ? String(record.session_key)
              : `tautulli-${record.reference_id}`;

          // Track this insert to prevent duplicates within this import run
          insertedThisRun.add(referenceIdStr);

          // Collect insert
          insertBatch.push({
            serverId,
            serverUserId,
            sessionKey,
            ratingKey: ratingKeyStr,
            externalSessionId: referenceIdStr,
            state: 'stopped',
            mediaType,
            mediaTitle: record.title,
            grandparentTitle: record.grandparent_title || null,
            seasonNumber:
              typeof record.parent_media_index === 'number' ? record.parent_media_index : null,
            episodeNumber: typeof record.media_index === 'number' ? record.media_index : null,
            year: record.year || null,
            thumbPath: record.thumb || null,
            startedAt,
            lastSeenAt: startedAt,
            stoppedAt: new Date((record.started + record.duration) * 1000),
            durationMs: record.duration * 1000,
            // Calculate totalDurationMs from duration and percent_complete
            // e.g., if 441s watched = 44%, total = 441/0.44 = 1002s
            totalDurationMs:
              record.percent_complete > 0
                ? Math.round((record.duration * 1000 * 100) / record.percent_complete)
                : null,
            // For imported sessions, progressMs ≈ durationMs (assumes linear playback)
            progressMs: record.duration * 1000,
            pausedDurationMs: record.paused_counter * 1000,
            watched: record.watched_status === 1,
            ipAddress: extractIpFromEndpoint(record.ip_address),
            geoCity: geo.city,
            geoRegion: geo.region,
            geoCountry: geo.countryCode ?? geo.country,
            geoContinent: geo.continent,
            geoPostal: geo.postal,
            geoLat: geo.lat,
            geoLon: geo.lon,
            geoAsnNumber: geo.asnNumber,
            geoAsnOrganization: geo.asnOrganization,
            playerName: record.player || record.product,
            deviceId: record.machine_id || null,
            product: record.product || null,
            // Use normalizeClient with product info to detect Android TV vs Android
            // product contains context like "Plex for Android (TV)" that platform alone lacks
            ...(() => {
              const normalized = normalizeClient(
                record.product || record.platform || '',
                record.player ?? undefined,
                'plex'
              );
              return {
                platform: normalized.platform,
                device: normalized.device,
              };
            })(),
            // Tautulli uses single transcode_decision for both video/audio
            ...(() => {
              const { videoDecision, audioDecision, isTranscode } = normalizeStreamDecisions(
                record.transcode_decision,
                record.transcode_decision
              );
              return {
                quality: isTranscode ? 'Transcode' : 'Direct',
                isTranscode,
                videoDecision,
                audioDecision,
              };
            })(),
            bitrate: null,
            // Music fields (only populated for tracks)
            artistName,
            albumName,
            trackNumber,
            discNumber,
            // Live TV fields (not available in get_history API - would require get_stream_data)
            channelTitle: null,
            channelIdentifier: null,
            channelThumb: null,
          });

          // Track session grouping for referenceId linking
          // group_ids contains comma-separated Tautulli row IDs (e.g., "12351,12362")
          // The first ID is the "parent" session in the resume chain
          if (record.group_count && record.group_count > 1 && record.group_ids) {
            const groupIds = record.group_ids.split(',').map((id) => id.trim());
            const parentExternalId = groupIds[0];
            // Only link if this session is NOT the parent (avoid self-reference)
            if (parentExternalId && parentExternalId !== referenceIdStr) {
              sessionGroupLinks.push({
                childExternalId: referenceIdStr,
                parentExternalId,
                startedAt,
              });
            }
          }

          imported++;
          progress.importedRecords++;
        } catch (error) {
          console.error('Error processing record:', record.reference_id, error);
          errors++;
          progress.errorRecords++;
        }

        // Throttled progress updates
        const now = Date.now();
        if (progress.processedRecords % 100 === 0 || now - lastProgressTime > 2000) {
          publishProgress(progress);
          lastProgressTime = now;
        }
      }

      // Flush batches at end of each page
      await flushBatches();

      page++;
    }

    // Final flush for any remaining records
    await flushBatches();

    // Link sessions using group_ids data (referenceId linking pass)
    // Process in mega-chunks to avoid lock exhaustion from querying all IDs at once
    let linkedSessions = 0;
    if (sessionGroupLinks.length > 0) {
      progress.message = `Linking ${sessionGroupLinks.length} resume sessions...`;
      publishProgress(progress);

      // Process links in chunks to spread lock acquisition and reduce memory pressure
      // Each mega-chunk queries only the parent/child IDs it needs
      const LINK_MEGA_CHUNK_SIZE = 500;
      const UPDATE_BATCH_SIZE = 50;

      for (let i = 0; i < sessionGroupLinks.length; i += LINK_MEGA_CHUNK_SIZE) {
        const megaChunk = sessionGroupLinks.slice(i, i + LINK_MEGA_CHUNK_SIZE);

        // Get unique parent/child IDs for this mega-chunk only
        const chunkParentIds = [...new Set(megaChunk.map((l) => l.parentExternalId))];
        const chunkChildIds = megaChunk.map((l) => l.childExternalId);

        // Compute time bounds for this chunk to enable TimescaleDB chunk exclusion
        const chunkTimestamps = megaChunk.map((l) => l.startedAt.getTime());
        const chunkTimeBounds: TimeBounds = {
          minTime: new Date(Math.min(...chunkTimestamps)),
          maxTime: new Date(Math.max(...chunkTimestamps)),
        };

        const parentMap = await queryExistingByExternalIds(
          serverId,
          chunkParentIds,
          chunkTimeBounds
        );
        const childMap = await queryExistingByExternalIds(serverId, chunkChildIds, chunkTimeBounds);

        // Batch updates within this mega-chunk
        for (let j = 0; j < megaChunk.length; j += UPDATE_BATCH_SIZE) {
          const updateBatch = megaChunk.slice(j, j + UPDATE_BATCH_SIZE);
          await Promise.all(
            updateBatch.map(async ({ childExternalId, parentExternalId }) => {
              const parent = parentMap.get(parentExternalId);
              const child = childMap.get(childExternalId);
              if (parent && child) {
                await db
                  .update(sessions)
                  .set({ referenceId: parent.id })
                  .where(eq(sessions.id, child.id));
                linkedSessions++;
              }
            })
          );
        }
      }

      if (linkedSessions > 0) {
        console.log(`[Import] Linked ${linkedSessions} sessions via group_ids`);
      }
    }

    // Refresh TimescaleDB aggregates so imported data appears in stats immediately
    // Skip if enrichment will follow (it will refresh after updating bitrate data)
    if (!skipRefresh) {
      progress.message = 'Refreshing aggregates...';
      publishProgress(progress);
      try {
        // Use bounded refresh based on actual import date range (memory-efficient)
        // Add 1 day buffer on each side for timezone edge cases
        if (minImportDate && maxImportDate) {
          const startTime = new Date(minImportDate.getTime() - 24 * 60 * 60 * 1000);
          const endTime = new Date(maxImportDate.getTime() + 24 * 60 * 60 * 1000);
          console.log(
            `[Import] Refreshing aggregates for date range: ${startTime.toISOString()} to ${endTime.toISOString()}`
          );
          await refreshAggregates({ startTime, endTime });
        } else {
          // Fallback to default 7-day bounded refresh if no dates tracked
          await refreshAggregates();
        }

        // Check if this is a fresh install that needs full aggregate rebuild
        // (aggregates missing >7 days of historical data)
        const rebuildStatus = await checkAggregateNeedsRebuild();
        if (rebuildStatus.needsRebuild) {
          console.log(
            `[Import] Fresh install detected - queueing safe aggregate rebuild: ${rebuildStatus.reason}`
          );
          try {
            await enqueueMaintenanceJob('full_aggregate_rebuild', 'system');
            console.log('[Import] Safe aggregate rebuild job queued');
          } catch {
            // Job might already be running/queued - that's fine
            console.log('[Import] Could not queue aggregate rebuild (may already be running)');
          }
        }
      } catch (err) {
        console.warn('Failed to refresh aggregates after import:', err);
      }
    }

    // Update joinedAt for users based on their earliest session
    // Always update to earliest session date (reflects first activity on this server)
    // Uses DISTINCT ON instead of MIN() to leverage index and avoid full hypertable scan
    progress.message = 'Updating user join dates...';
    publishProgress(progress);
    try {
      const joinDateUpdates = await db.execute(sql`
        UPDATE server_users su
        SET joined_at = earliest.started_at
        FROM (
          SELECT DISTINCT ON (server_user_id) server_user_id, started_at
          FROM sessions
          WHERE server_id = ${serverId}
          ORDER BY server_user_id, started_at ASC
        ) earliest
        WHERE su.id = earliest.server_user_id
          AND su.server_id = ${serverId}
      `);
      const updatedCount =
        typeof joinDateUpdates === 'object' &&
        joinDateUpdates !== null &&
        'rowCount' in joinDateUpdates
          ? (joinDateUpdates.rowCount as number)
          : 0;
      if (updatedCount > 0) {
        console.log(`[Import] Updated join dates for ${updatedCount} users`);
      }
    } catch (err) {
      console.warn('Failed to update user join dates:', err);
    }

    // Build final message with detailed breakdown
    const parts: string[] = [];
    if (imported > 0) parts.push(`${imported} new`);
    if (updated > 0) parts.push(`${updated} updated`);
    if (linkedSessions > 0) parts.push(`${linkedSessions} linked`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (errors > 0) parts.push(`${errors} errors`);

    let message = `Import complete: ${parts.join(', ')}`;

    // Add skipped users warning using shared module
    const skippedUserWarning = skippedUserTracker.formatWarning();
    if (skippedUserWarning) {
      message += `. Warning: ${skippedUserWarning}`;
      console.warn(
        `Tautulli import skipped users: ${skippedUserTracker
          .getAll()
          .map((u) => u.username)
          .join(', ')}`
      );
    }

    // Final progress update
    progress.status = 'complete';
    progress.message = message;
    publishProgress(progress);

    return {
      success: true,
      imported,
      updated,
      linked: linkedSessions,
      skipped,
      errors,
      message,
      skippedUsers:
        skippedUserTracker.size > 0
          ? skippedUserTracker.getAll().map((u) => ({
              tautulliUserId: parseInt(u.externalId, 10),
              username: u.username ?? 'Unknown',
              recordCount: u.count,
            }))
          : undefined,
    };
  }

  /**
   * Enrich existing sessions with detailed stream quality data (BETA)
   *
   * Rate limiting: 50ms delay between requests (no server-side limits)
   *
   * @param serverId - Server to enrich sessions for
   * @param pubSubService - Optional pubsub for progress updates
   * @param onProgress - Optional callback for progress updates
   * @param options - Enrichment options
   */
  static async enrichStreamDetails(
    serverId: string,
    pubSubService?: PubSubService,
    onProgress?: (progress: TautulliImportProgress) => Promise<void>,
    options?: { limit?: number }
  ): Promise<{ enriched: number; failed: number; skipped: number }> {
    const CHUNK_SIZE = options?.limit ?? 10000; // Process in chunks of 10k, auto-continue until done
    const BATCH_SIZE = 50; // Process 50 sessions per batch for DB writes
    const CONCURRENCY = 10; // 10 parallel API calls

    // Get Tautulli settings
    const settingsRow = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
    const config = settingsRow[0];
    if (!config?.tautulliUrl || !config?.tautulliApiKey) {
      throw new Error('Tautulli is not configured');
    }

    const tautulli = new TautulliService(config.tautulliUrl, config.tautulliApiKey);

    // Test connection
    const connected = await tautulli.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to Tautulli');
    }

    // Initialize progress
    const progress: TautulliImportProgress = {
      status: 'processing',
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
      totalPages: 1,
      message: 'Starting enrichment...',
    };

    const publishProgress = createSimpleProgressPublisher(
      pubSubService,
      'import:progress',
      onProgress
    );
    publishProgress(progress);

    let totalEnriched = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let lastProgressTime = Date.now();
    let chunkNumber = 0;
    let cursor: number | undefined;

    // Process in chunks until no more sessions to enrich
    while (true) {
      chunkNumber++;

      // Query sessions missing quality data that have an externalSessionId
      // Only enrich sessions where sourceVideoCodec is NULL (indicates no stream data)
      // Order by externalSessionId DESC to process recent sessions first (higher row_id = more recent)
      // Note: Tautulli may have purged stream data for older sessions, those will be skipped
      const sessionsToEnrich = await db
        .select({
          id: sessions.id,
          externalSessionId: sessions.externalSessionId,
          sessionKey: sessions.sessionKey,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.serverId, serverId),
            isNotNull(sessions.externalSessionId),
            isNull(sessions.sourceVideoCodec),
            cursor ? sql`CAST(${sessions.externalSessionId} AS INTEGER) < ${cursor}` : undefined
          )
        )
        .orderBy(sql`CAST(${sessions.externalSessionId} AS INTEGER) DESC`)
        .limit(CHUNK_SIZE);

      if (sessionsToEnrich.length === 0) {
        break; // No more sessions to enrich
      }

      progress.totalRecords += sessionsToEnrich.length;
      progress.message = `Chunk ${chunkNumber}: Enriching ${sessionsToEnrich.length} sessions...`;
      publishProgress(progress);

      // Process sessions in batches with parallel API calls
      for (let batchStart = 0; batchStart < sessionsToEnrich.length; batchStart += BATCH_SIZE) {
        const batch = sessionsToEnrich.slice(batchStart, batchStart + BATCH_SIZE);

        // Process batch with concurrency limit
        const pendingUpdates: Array<{
          id: string;
          data: ReturnType<typeof mapStreamDataToSession>;
        }> = [];

        // Process in chunks of CONCURRENCY
        for (let i = 0; i < batch.length; i += CONCURRENCY) {
          const chunk = batch.slice(i, i + CONCURRENCY);

          const results = await Promise.allSettled(
            chunk.map(async (session) => {
              // Parse the externalSessionId as row_id (Tautulli's reference_id)
              if (!session.externalSessionId) {
                return { status: 'skipped' as const, id: session.id };
              }
              const rowId = parseInt(session.externalSessionId, 10);
              if (isNaN(rowId)) {
                return { status: 'skipped' as const, id: session.id };
              }

              // Fetch stream data from Tautulli
              const streamData = await tautulli.getStreamData(
                rowId,
                session.sessionKey ?? undefined
              );

              if (!streamData) {
                return { status: 'skipped' as const, id: session.id };
              }

              // Map the data
              const mappedData = mapStreamDataToSession(streamData);

              // Only return update if we got meaningful data
              if (
                mappedData.sourceVideoCodec ||
                mappedData.sourceAudioCodec ||
                mappedData.bitrate
              ) {
                return { status: 'enriched' as const, id: session.id, data: mappedData };
              }
              return { status: 'skipped' as const, id: session.id };
            })
          );

          // Process results
          for (const result of results) {
            progress.processedRecords++;

            if (result.status === 'fulfilled') {
              const value = result.value;
              if (value.status === 'enriched' && value.data) {
                pendingUpdates.push({ id: value.id, data: value.data });
              } else {
                totalSkipped++;
                progress.skippedRecords++;
              }
            } else {
              console.warn(`[Tautulli] Failed to enrich session:`, result.reason);
              totalFailed++;
              progress.errorRecords++;
            }
          }
        }

        // Batch write all updates in a single transaction
        if (pendingUpdates.length > 0) {
          await db.transaction(async (tx) => {
            for (const update of pendingUpdates) {
              await tx.update(sessions).set(update.data).where(eq(sessions.id, update.id));
            }
          });
          totalEnriched += pendingUpdates.length;
          progress.updatedRecords += pendingUpdates.length;
        }

        // Progress update after each batch
        const now = Date.now();
        if (now - lastProgressTime > 1000 || batchStart + BATCH_SIZE >= sessionsToEnrich.length) {
          progress.message = `Chunk ${chunkNumber}: Enriched ${totalEnriched} total (${progress.processedRecords}/${progress.totalRecords} processed)...`;
          publishProgress(progress);
          lastProgressTime = now;
        }
      }

      // Advance cursor to the lowest externalSessionId in this chunk so the next
      // iteration skips already-processed sessions (including ones we skipped)
      const lastSession = sessionsToEnrich.at(-1);
      if (lastSession?.externalSessionId) {
        cursor = parseInt(lastSession.externalSessionId, 10);
      }

      // If we got fewer than CHUNK_SIZE, we're done
      if (sessionsToEnrich.length < CHUNK_SIZE) {
        break;
      }
    }

    // Refresh aggregates so updated bitrate data appears in bandwidth stats
    // Enrichment only updates existing sessions, doesn't add new dates, so default bounded refresh is fine
    if (totalEnriched > 0) {
      progress.message = 'Refreshing aggregates...';
      publishProgress(progress);
      try {
        // Default 7-day bounded refresh is sufficient for enrichment updates
        await refreshAggregates();
      } catch (err) {
        console.warn('[Tautulli] Failed to refresh aggregates after enrichment:', err);
      }
    }

    // Final progress
    progress.status = 'complete';
    progress.message = `Enrichment complete: ${totalEnriched} enriched, ${totalFailed} failed, ${totalSkipped} skipped`;
    publishProgress(progress);

    return { enriched: totalEnriched, failed: totalFailed, skipped: totalSkipped };
  }
}

/**
 * Map Tautulli stream data to our session schema fields
 * This converts the Tautulli API response to our database column format
 */
export function mapStreamDataToSession(
  streamData: TautulliStreamData
): Partial<typeof sessions.$inferInsert> {
  // Helper to convert boolean-like values
  const toBool = (v: number | boolean | null | undefined): boolean => v === 1 || v === true;

  // Build source video details JSONB
  const sourceVideoDetails: Record<string, unknown> = {};
  if (streamData.video_bitrate) sourceVideoDetails.bitrate = streamData.video_bitrate;
  if (streamData.video_framerate) sourceVideoDetails.framerate = streamData.video_framerate;
  if (streamData.video_dynamic_range)
    sourceVideoDetails.dynamicRange = streamData.video_dynamic_range;
  if (streamData.video_profile) sourceVideoDetails.profile = streamData.video_profile;
  if (streamData.video_codec_level) sourceVideoDetails.level = streamData.video_codec_level;
  if (streamData.video_color_space) sourceVideoDetails.colorSpace = streamData.video_color_space;
  if (streamData.video_bit_depth) sourceVideoDetails.colorDepth = streamData.video_bit_depth;
  if (streamData.video_color_primaries)
    sourceVideoDetails.colorPrimaries = streamData.video_color_primaries;

  // Build source audio details JSONB
  const sourceAudioDetails: Record<string, unknown> = {};
  if (streamData.audio_bitrate) sourceAudioDetails.bitrate = streamData.audio_bitrate;
  if (streamData.audio_channel_layout)
    sourceAudioDetails.channelLayout = streamData.audio_channel_layout;
  if (streamData.audio_language) sourceAudioDetails.language = streamData.audio_language;
  if (streamData.audio_sample_rate) sourceAudioDetails.sampleRate = streamData.audio_sample_rate;

  // Build stream video details JSONB
  const streamVideoDetails: Record<string, unknown> = {};
  if (streamData.stream_video_bitrate) streamVideoDetails.bitrate = streamData.stream_video_bitrate;
  if (streamData.stream_video_width) streamVideoDetails.width = streamData.stream_video_width;
  if (streamData.stream_video_height) streamVideoDetails.height = streamData.stream_video_height;
  if (streamData.stream_video_framerate)
    streamVideoDetails.framerate = streamData.stream_video_framerate;
  if (streamData.stream_video_dynamic_range)
    streamVideoDetails.dynamicRange = streamData.stream_video_dynamic_range;

  // Build stream audio details JSONB
  const streamAudioDetails: Record<string, unknown> = {};
  if (streamData.stream_audio_bitrate) streamAudioDetails.bitrate = streamData.stream_audio_bitrate;
  if (streamData.stream_audio_channels)
    streamAudioDetails.channels = streamData.stream_audio_channels;
  if (streamData.stream_audio_language)
    streamAudioDetails.language = streamData.stream_audio_language;

  // Build transcode info JSONB
  const transcodeInfo: Record<string, unknown> = {};
  if (streamData.container_decision)
    transcodeInfo.containerDecision = streamData.container_decision;
  if (streamData.container) transcodeInfo.sourceContainer = streamData.container;
  if (streamData.stream_container) transcodeInfo.streamContainer = streamData.stream_container;
  if (streamData.transcode_hw_decoding !== undefined) {
    transcodeInfo.hwDecoding = toBool(streamData.transcode_hw_decoding);
  }
  if (streamData.transcode_hw_encoding !== undefined) {
    transcodeInfo.hwEncoding = toBool(streamData.transcode_hw_encoding);
  }
  if (streamData.transcode_hw_decode) transcodeInfo.hwDecodeType = streamData.transcode_hw_decode;
  if (streamData.transcode_hw_encode) transcodeInfo.hwEncodeType = streamData.transcode_hw_encode;
  if (streamData.transcode_speed) {
    const speed = parseFloat(streamData.transcode_speed);
    if (!isNaN(speed)) transcodeInfo.speed = speed;
  }
  if (streamData.transcode_throttled !== undefined) {
    transcodeInfo.throttled = toBool(streamData.transcode_throttled);
  }

  // Build subtitle info JSONB
  const subtitleInfo: Record<string, unknown> = {};
  if (streamData.subtitle_decision) subtitleInfo.decision = streamData.subtitle_decision;
  if (streamData.subtitle_codec) subtitleInfo.codec = streamData.subtitle_codec;
  if (streamData.subtitle_language) subtitleInfo.language = streamData.subtitle_language;
  if (streamData.subtitle_forced !== undefined) {
    subtitleInfo.forced = toBool(streamData.subtitle_forced);
  }

  // Return mapped fields (only include non-empty objects)
  return {
    // Scalar fields (uppercase codecs for consistency with other importers)
    sourceVideoCodec: sanitizeCodec(streamData.video_codec),
    sourceVideoWidth: streamData.video_width ?? null,
    sourceVideoHeight: streamData.video_height ?? null,
    sourceAudioCodec: sanitizeCodec(streamData.audio_codec),
    sourceAudioChannels: streamData.audio_channels ?? null,
    streamVideoCodec: sanitizeCodec(streamData.stream_video_codec),
    streamAudioCodec: sanitizeCodec(streamData.stream_audio_codec),
    bitrate: streamData.bandwidth ?? streamData.stream_bitrate ?? streamData.bitrate ?? null,
    quality: streamData.quality_profile ?? null,

    // JSONB fields (only set if they have content)
    ...(Object.keys(sourceVideoDetails).length > 0 && { sourceVideoDetails }),
    ...(Object.keys(sourceAudioDetails).length > 0 && { sourceAudioDetails }),
    ...(Object.keys(streamVideoDetails).length > 0 && { streamVideoDetails }),
    ...(Object.keys(streamAudioDetails).length > 0 && { streamAudioDetails }),
    ...(Object.keys(transcodeInfo).length > 0 && { transcodeInfo }),
    ...(Object.keys(subtitleInfo).length > 0 && { subtitleInfo }),
  };
}
