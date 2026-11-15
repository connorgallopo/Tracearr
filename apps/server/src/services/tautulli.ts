/**
 * Tautulli API integration and import service
 */

import type { TautulliImportProgress, TautulliImportResult } from '@tracearr/shared';
import { UnrecoverableError } from 'bullmq';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { servers, serverUsers, sessions, users } from '../db/schema.js';
import {
  checkAggregateNeedsRebuild,
  refreshAggregates,
  uncapDecompressionForTx,
} from '../db/timescale.js';
import { deleteSessionsRepointingChildren, importForm } from '../jobs/importDuplicateCleanup.js';
import {
  enqueueMaintenanceJob,
  enqueueServerLocationSyncIfBehind,
} from '../jobs/maintenanceQueue.js';
import { importIdentityByKey } from './import/libraryKeyMatch.js';
import {
  batchGetLibraryItemIdentity,
  batchResolveMediaByPlexGuid,
} from '../jobs/poller/database.js';
import { ts } from '../jobs/sessionWalk.js';
import { sanitizeCodec } from '../utils/codecNormalizer.js';
import { extractIpFromEndpoint } from '../utils/parsing.js';
import { normalizeClient } from '../utils/platformNormalizer.js';
import { normalizePlexGuid } from '../utils/plexGuid.js';
import { normalizeStreamDecisions } from '../utils/transcodeNormalizer.js';
import type { PubSubService } from './cache.js';
import { geoasnService } from './geoasn.js';
import { geoipService } from './geoip.js';
import {
  createSimpleProgressPublisher,
  createSkippedUserTracker,
  createTimeKey,
  createUserMapping,
  flushInsertBatch,
  flushUpdateBatch,
  getServerTrackingStart,
  queryExistingByExternalIds,
  queryExistingByTimeKeys,
  storedSessionRowById,
  type SessionUpdate,
  type TimeBounds,
  syncImportUsers,
} from './import/index.js';
import { markImportedServerLocations } from './serverLocations.js';
import { getSettings, rearmImportedHistoryLink } from './settings.js';

const GUID_HISTORY_LENGTH = 100000;
const PAGE_SIZE = 5000; // Larger batches = fewer API calls (tested up to 10k, scales linearly)
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Base delay, will be multiplied by attempt number
const ERROR_BODY_MAX_CHARS = 500;
const ABSORBED_GROUPS_PER_TX = 250;

/** A group whose group_ids name plays other than its own root */
interface AbsorbingGroup {
  rootExternalId: string;
  serverUserId: string;
  started: Date;
  stopped: Date;
  absorbedIds: string[];
}

function absorbingGroup(
  record: TautulliHistoryRecord,
  serverUserId: string
): AbsorbingGroup | null {
  const rootExternalId = String(record.reference_id);
  const absorbedIds = (record.group_ids ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '' && id !== rootExternalId);
  if (absorbedIds.length === 0) return null;
  return {
    rootExternalId,
    serverUserId,
    started: new Date(record.started * 1000),
    stopped: new Date(record.stopped * 1000),
    absorbedIds,
  };
}

export class TautulliApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`Tautulli API error: ${status} ${statusText}${body ? ` - ${body}` : ''}`);
    this.name = 'TautulliApiError';
    this.status = status;
    this.body = body;
  }
}

export class ImportInterruptedError extends Error {
  constructor() {
    super('import interrupted by shutdown');
    this.name = 'ImportInterruptedError';
  }
}

/** What a resumed import needs from the pages an earlier attempt finished. */
export interface ImportResumeState {
  minImportDate: string | null;
  maxImportDate: string | null;
  failedPages: number[];
}

interface ImportHistoryOptions {
  overwriteFriendlyNames?: boolean;
  startPage?: number;
  resumeState?: ImportResumeState;
  signal?: AbortSignal;
  /** Called after every finished or skipped page with the next page to fetch. */
  onPageDone?: (nextPage: number, state: ImportResumeState) => Promise<void>;
}

export function isFatalImportError(err: unknown): boolean {
  if (err instanceof TautulliApiError) return err.status === 401 || err.status === 403;
  return err instanceof Error && err.message.startsWith('Invalid Tautulli API response');
}

async function rearmLinking(): Promise<void> {
  try {
    await rearmImportedHistoryLink({ keepProviderPass: false });
  } catch (err) {
    console.warn('Failed to re-arm imported history linking:', err);
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_MAX_CHARS);
  } catch {
    return '';
  }
}

// Resolve external IDs from Plex legacy agent guids; new-style plex:// guids carry no external ID.
export function parseHistoryGuid(guid: string | null): {
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
} {
  if (!guid) return {};
  const legacy = guid.match(/^com\.plexapp\.agents\.(thetvdb|themoviedb|imdb):\/\/([^/?]+)/);
  if (!legacy) return {};
  const [, agent, rawId] = legacy;
  if (agent === 'imdb' && rawId!.startsWith('tt')) return { imdbId: rawId! };
  const numeric = parseInt(rawId!, 10);
  if (Number.isNaN(numeric)) return {};
  if (agent === 'thetvdb') return { tvdbId: numeric };
  if (agent === 'themoviedb') return { tmdbId: numeric };
  return {};
}

// Live content reports its actual type in media_type too, so the live flag wins.
function mapTautulliMediaType(record: {
  live: number | null;
  media_type: string;
}): 'movie' | 'episode' | 'track' | 'live' {
  if (record.live === 1) return 'live';
  if (record.media_type === 'episode') return 'episode';
  if (record.media_type === 'track') return 'track';
  return 'movie';
}

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

// Unlike TautulliHistoryResponseSchema, an error response (data: null) parses here.
const TautulliGuidHistoryResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    data: z
      .object({
        recordsFiltered: z.number(),
        data: z.array(z.unknown()),
      })
      .nullish(),
  }),
});

const TautulliGuidHistoryRowSchema = z.object({
  rating_key: z
    .union([z.number(), z.string(), z.null()])
    .transform((v) => (v === null ? null : String(v))),
  live: z.number().nullable(),
  media_type: z.string(),
  guid: z.string().nullable(),
  reference_id: z.number().nullable(),
});

const TautulliServerInfoResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    data: z.object({ pms_identifier: z.string().nullish() }).nullish(),
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
  do_notify: z.number().optional(),
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
          const body = (await readErrorBody(response)).replaceAll(this.apiKey, '[redacted]');
          throw new TautulliApiError(response.status, response.statusText, body);
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

        if (isFatalImportError(lastError)) {
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
        grouping: 1,
        include_activity: 0,
        include_archived: 1,
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
   * The machine identifier of the Plex server this Tautulli monitors
   */
  async getPmsIdentifier(): Promise<string | null> {
    const result = await this.request('get_server_info', {}, TautulliServerInfoResponseSchema);
    const identifier = result.response.data?.pms_identifier;
    return result.response.result === 'success' && identifier ? identifier : null;
  }

  /**
   * Raw guids and reference ids Tautulli recorded for each rating key, from
   * non-live movie and episode history rows. Null when the answer may be
   * incomplete: an error result, a row that does not parse, or a full page,
   * which may have been cut.
   */
  async getGuidsByRatingKey(
    ratingKeys: string[]
  ): Promise<Map<string, { guids: Set<string>; referenceIds: Set<string> }> | null> {
    const result = await this.request(
      'get_history',
      {
        rating_key: ratingKeys.join(','),
        grouping: 0,
        include_activity: 0,
        include_archived: 1,
        length: GUID_HISTORY_LENGTH,
      },
      TautulliGuidHistoryResponseSchema
    );
    const { data } = result.response;
    if (result.response.result !== 'success' || !data) return null;
    if (data.data.length >= GUID_HISTORY_LENGTH) return null;

    const requested = new Set(ratingKeys);
    const history = new Map<string, { guids: Set<string>; referenceIds: Set<string> }>();
    for (const raw of data.data) {
      const row = TautulliGuidHistoryRowSchema.safeParse(raw);
      if (!row.success) return null;
      const {
        rating_key: ratingKey,
        live,
        media_type: mediaType,
        guid,
        reference_id: referenceId,
      } = row.data;
      // Tautulli filters on session_history.rating_key but reports
      // session_history_metadata.rating_key, so check the key it reports.
      if (ratingKey === null || !requested.has(ratingKey)) continue;
      if (live !== 0 || (mediaType !== 'movie' && mediaType !== 'episode')) continue;
      const entry = history.get(ratingKey) ?? { guids: new Set(), referenceIds: new Set() };
      // A row without a guid still counts, so its key cannot look unanimous.
      entry.guids.add(guid ?? '');
      if (referenceId !== null) entry.referenceIds.add(String(referenceId));
      history.set(ratingKey, entry);
    }
    return history;
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
   * The guid fallback resolves against this server's library, so it applies
   * only when Tautulli reports the same Plex machine identifier as the server row.
   */
  private static async monitorsServer(
    tautulli: TautulliService,
    serverId: string
  ): Promise<boolean> {
    const [server] = await db
      .select({ machineIdentifier: servers.machineIdentifier })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    let pmsIdentifier: string | null = null;
    try {
      pmsIdentifier = await tautulli.getPmsIdentifier();
    } catch (err) {
      console.warn(
        `[Import] Tautulli server info failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const matches =
      pmsIdentifier !== null &&
      !!server?.machineIdentifier &&
      pmsIdentifier === server.machineIdentifier;
    if (!matches) {
      console.log(
        '[Import] Tautulli reports a different or unknown Plex server; skipping the Plex guid fallback'
      );
    }
    return matches;
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
   * - Resumes at options.startPage and stops at a page boundary once options.signal aborts
   */
  static async importHistory(
    serverId: string,
    pubSubService?: PubSubService,
    onProgress?: (progress: TautulliImportProgress) => Promise<void>,
    options?: ImportHistoryOptions
  ): Promise<TautulliImportResult> {
    const changes = { imported: 0, updated: 0, complete: false };
    try {
      return await TautulliService.runImportHistory(
        serverId,
        pubSubService,
        onProgress,
        options,
        changes
      );
    } finally {
      if (changes.complete || changes.imported > 0 || changes.updated > 0) await rearmLinking();
    }
  }

  private static async runImportHistory(
    serverId: string,
    pubSubService: PubSubService | undefined,
    onProgress: ((progress: TautulliImportProgress) => Promise<void>) | undefined,
    options: ImportHistoryOptions | undefined,
    changes: { imported: number; updated: number; complete: boolean }
  ): Promise<TautulliImportResult> {
    const overwriteFriendlyNames = options?.overwriteFriendlyNames ?? false;

    // Get Tautulli settings
    const config = await getSettings(['tautulliUrl', 'tautulliApiKey']);

    if (!config.tautulliUrl || !config.tautulliApiKey) {
      throw new UnrecoverableError(
        'Tautulli is not configured. Please add URL and API key in Settings.'
      );
    }

    const tautulli = new TautulliService(config.tautulliUrl, config.tautulliApiKey);

    // Not testConnection, which answers false for an unreachable Tautulli too: that one is retried
    const check = await tautulli.request<{ response?: { result?: unknown } } | null>('arnold');
    if (!check?.response) {
      throw new UnrecoverableError('Invalid Tautulli API response: the connection check had none');
    }
    if (check.response.result !== 'success') {
      throw new UnrecoverableError('Failed to connect to Tautulli. Please check URL and API key.');
    }

    const cutoff = await getServerTrackingStart(serverId);
    if (!cutoff) {
      throw new UnrecoverableError('Server not found; cannot determine import cutoff.');
    }

    const guidFallback = await TautulliService.monitorsServer(tautulli, serverId);

    // Initialize progress with detailed tracking
    const progress: TautulliImportProgress = {
      serverId,
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

    progress.message = 'Syncing server users...';
    publishProgress(progress);
    await syncImportUsers(serverId);

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
    const seed = options?.resumeState;
    let minImportDate: Date | null = seed?.minImportDate ? new Date(seed.minImportDate) : null;
    let maxImportDate: Date | null = seed?.maxImportDate ? new Date(seed.maxImportDate) : null;
    const widenImportRange = (at: Date) => {
      if (!minImportDate || at < minImportDate) minImportDate = at;
      if (!maxImportDate || at > maxImportDate) maxImportDate = at;
    };

    const absorbingGroups: AbsorbingGroup[] = [];
    const collectAbsorbed = (record: TautulliHistoryRecord, serverUserId: string) => {
      const group = absorbingGroup(record, serverUserId);
      if (group) absorbingGroups.push(group);
    };

    // Track skipped users using shared module
    const skippedUserTracker = createSkippedUserTracker();

    console.log('[Import] Using per-page dedup queries (memory-efficient mode)');

    // GeoIP cache (bounded - cleared every 10 pages to prevent unbounded growth)
    let geoCache = new Map<string, ReturnType<typeof geoipService.lookup>>();

    // Batch collections
    const insertBatch: (typeof sessions.$inferInsert)[] = [];
    const updateBatch: SessionUpdate[] = [];

    let skipped = 0;
    let errors = 0;
    let alreadyTracked = 0;
    let ungrouped = 0;
    let noMetadata = 0;
    let page = options?.startPage ?? 0;
    let mergedAway = 0;
    const failedPages: number[] = [...(seed?.failedPages ?? [])];
    const resumeState = (): ImportResumeState => ({
      minImportDate: minImportDate?.toISOString() ?? null,
      maxImportDate: maxImportDate?.toISOString() ?? null,
      failedPages: [...failedPages],
    });

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
      if (options?.signal?.aborted) throw new ImportInterruptedError();
      progress.status = 'processing';
      progress.currentPage = page + 1;
      progress.message = `Processing page ${page + 1} of ${progress.totalPages}`;

      // Clear geo cache periodically to prevent unbounded growth (every 10 pages)
      if (page > 0 && page % 10 === 0) {
        geoCache = new Map();
      }

      let rawRecords: unknown[];
      try {
        ({ records: rawRecords } = await tautulli.getHistory(page * PAGE_SIZE, PAGE_SIZE));
      } catch (err) {
        if (isFatalImportError(err)) throw err;
        console.warn(
          `[Import] Page ${page + 1} of ${progress.totalPages} failed after retries, skipping:`,
          err
        );
        failedPages.push(page + 1);
        page++;
        await options?.onPageDone?.(page, resumeState());
        continue;
      }

      // Track actual records fetched (may differ from API total if records changed)
      progress.fetchedRecords += rawRecords.length;

      // Validate records individually - skip bad records instead of failing entire page
      const validRecords: TautulliHistoryRecord[] = [];
      for (const raw of rawRecords) {
        if ((raw as { full_title?: unknown } | null)?.full_title === null) {
          skipped++;
          noMetadata++;
          progress.skippedRecords++;
          progress.processedRecords++;
          continue;
        }
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

      const pageRatingKeys = validRecords
        .map((r) => (typeof r.rating_key === 'number' ? String(r.rating_key) : null))
        .filter((k): k is string => k !== null);
      const identityByRatingKey = await batchGetLibraryItemIdentity(serverId, pageRatingKeys);

      // Records whose rating key resolved no library_items row at all get a second
      // chance by guid: it survives a Plex re-key that leaves the rating key
      // pointing at nothing. A rating key that DID resolve, even to a row not yet
      // linked to canonical media, keeps its own (possibly partial) identity as-is
      // rather than mixing in a second, independently-matched guid identity.
      let identityByGuid: Awaited<ReturnType<typeof batchResolveMediaByPlexGuid>> = new Map();
      if (guidFallback) {
        const pageGuidLookups: Array<{ guid: string; mediaType: 'movie' | 'episode' }> = [];
        for (const record of validRecords) {
          const ratingKeyStr =
            typeof record.rating_key === 'number' ? String(record.rating_key) : null;
          const mappedType = mapTautulliMediaType(record);
          const identity = importIdentityByKey(
            ratingKeyStr ? identityByRatingKey.get(ratingKeyStr) : undefined,
            { mediaType: mappedType, title: record.title, year: record.year || null }
          );
          if (identity !== undefined) continue;

          if (mappedType !== 'movie' && mappedType !== 'episode') continue;

          const normalizedGuid = normalizePlexGuid(record.guid);
          if (normalizedGuid && normalizedGuid.mediaType === mappedType) {
            pageGuidLookups.push(normalizedGuid);
          }
        }
        identityByGuid = await batchResolveMediaByPlexGuid(serverId, pageGuidLookups);
      }

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

          if (record.reference_id === null) {
            skipped++;
            progress.skippedRecords++;
            ungrouped += record.group_count ?? 1;
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

          // Tracearr already tracks anything at or after the server's cutoff.
          if (record.started * 1000 >= cutoff.getTime()) {
            skipped++;
            progress.skippedRecords++;
            alreadyTracked++;
            continue;
          }

          // Check if exists in database (per-page query result)
          const existingByRef = sessionByExternalId.get(referenceIdStr);
          if (existingByRef) {
            // A reference_id match whose recorded start has drifted isn't the same
            // play Tracearr stored; leave it alone rather than overwrite it.
            const startsMatch = existingByRef.startedAt?.getTime() === record.started * 1000;
            const newStoppedAt = new Date((record.started + record.duration) * 1000);
            const newDurationMs = record.duration * 1000;
            const newPausedDurationMs = record.paused_counter * 1000;
            const newWatched = record.watched_status === 1;
            const hasChanges =
              existingByRef.stoppedAt?.getTime() !== newStoppedAt.getTime() ||
              existingByRef.durationMs !== newDurationMs ||
              existingByRef.pausedDurationMs !== newPausedDurationMs ||
              existingByRef.watched !== newWatched;

            if (startsMatch && hasChanges) {
              updateBatch.push({
                id: existingByRef.id,
                startedAt: existingByRef.startedAt,
                stoppedAt: newStoppedAt,
                durationMs: newDurationMs,
                pausedDurationMs: newPausedDurationMs,
                watched: newWatched,
                progressMs: Math.round(
                  (record.percent_complete / 100) * (existingByRef.totalDurationMs ?? 0)
                ),
              });
              changes.updated++;
              progress.updatedRecords++;

              widenImportRange(new Date(record.started * 1000));
            } else {
              skipped++;
              progress.skippedRecords++;
              progress.duplicateRecords++;
            }

            if (startsMatch) collectAbsorbed(record, serverUserId);
            continue;
          }

          // Fallback dedup check by time-based key
          const startedAt = new Date(record.started * 1000);

          // Track date range for bounded aggregate refresh
          widenImportRange(startedAt);

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
                  startedAt: existingByTime.startedAt,
                  externalSessionId: referenceIdStr,
                  stoppedAt: newStoppedAt,
                  durationMs: newDurationMs,
                  pausedDurationMs: newPausedDurationMs,
                  watched: newWatched,
                });
                changes.updated++;
                progress.updatedRecords++;
              } else {
                skipped++;
                progress.skippedRecords++;
                progress.duplicateRecords++;
              }

              collectAbsorbed(record, serverUserId);
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

          const mediaType = mapTautulliMediaType(record);

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

          const identity = importIdentityByKey(
            ratingKeyStr ? identityByRatingKey.get(ratingKeyStr) : undefined,
            { mediaType, title: record.title, year: record.year || null }
          );
          const normalizedGuid = identity !== undefined ? null : normalizePlexGuid(record.guid);
          const guidIdentity =
            normalizedGuid && normalizedGuid.mediaType === mediaType
              ? identityByGuid.get(normalizedGuid.guid)
              : undefined;
          // Legacy episode guids carry the series' external ID, so trust guid IDs for movies only.
          const guidIds = record.media_type === 'movie' ? parseHistoryGuid(record.guid) : {};
          const parentRatingKeyStr =
            typeof record.parent_rating_key === 'number' ? String(record.parent_rating_key) : null;
          const grandparentRatingKeyStr =
            typeof record.grandparent_rating_key === 'number'
              ? String(record.grandparent_rating_key)
              : null;

          // Collect insert
          insertBatch.push({
            serverId,
            serverUserId,
            sessionKey,
            ratingKey: ratingKeyStr,
            externalSessionId: referenceIdStr,
            parentRatingKey: parentRatingKeyStr,
            grandparentRatingKey: grandparentRatingKeyStr,
            mediaId: identity?.mediaId ?? guidIdentity?.mediaId ?? null,
            showMediaId: identity?.showMediaId ?? guidIdentity?.showMediaId ?? null,
            imdbId: identity?.imdbId ?? guidIdentity?.imdbId ?? guidIds.imdbId ?? null,
            tmdbId: identity?.tmdbId ?? guidIdentity?.tmdbId ?? guidIds.tmdbId ?? null,
            tvdbId: identity?.tvdbId ?? guidIdentity?.tvdbId ?? guidIds.tvdbId ?? null,
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
            shortSession: record.duration * 1000 < 120000,
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
            isLocal: geoipService.isPrivateIP(extractIpFromEndpoint(record.ip_address)),
            playerName: (record.player || record.product)?.slice(0, 255) ?? null,
            deviceId: record.machine_id?.slice(0, 255) || null,
            product: record.product?.slice(0, 255) || null,
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

          collectAbsorbed(record, serverUserId);

          changes.imported++;
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

      // A regroup in Tautulli folds plays an earlier import stored as their own
      // group into another group, whose root this page just rewrote with the
      // merged total. The old rows would count that watch time twice. They go
      // before the page is reported done, so a resumed import never skips them.
      if (absorbingGroups.length > 0) {
        progress.message = 'Removing plays Tautulli merged into another play...';
        publishProgress(progress);
        const groups = absorbingGroups.splice(0);
        for (let i = 0; i < groups.length; i += ABSORBED_GROUPS_PER_TX) {
          const deletedStarts = await TautulliService.deleteAbsorbedImports(
            serverId,
            groups.slice(i, i + ABSORBED_GROUPS_PER_TX)
          );
          mergedAway += deletedStarts.length;
          for (const started of deletedStarts) widenImportRange(new Date(started));
        }
      }

      page++;
      await options?.onPageDone?.(page, resumeState());
    }

    // Final flush for any remaining records
    await flushBatches();

    if (mergedAway > 0) {
      console.log(`[Import] Removed ${mergedAway} plays Tautulli merged into another play`);
    }

    // An imported day only reaches the aggregates if a refresh covers it: once the
    // refresh policy advances the watermark past it, the real-time union stops
    // reading raw sessions for that day and the plays are invisible to every
    // aggregate-backed read (watchers, watched state, request lenses).
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
    try {
      await markImportedServerLocations(serverId);
      await enqueueServerLocationSyncIfBehind();
    } catch (err) {
      console.error('[Import] Could not queue the server location sync:', err);
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

    changes.complete = true;

    // Build final message with detailed breakdown
    const parts: string[] = [];
    if (changes.imported > 0) parts.push(`${changes.imported} new`);
    if (changes.updated > 0) parts.push(`${changes.updated} updated`);
    if (mergedAway > 0) {
      parts.push(`${mergedAway} plays Tautulli merged into another play since the last import`);
    }
    if (skipped > 0) {
      parts.push(
        alreadyTracked > 0
          ? `${skipped} skipped (${alreadyTracked} started after this server was added to Tracearr)`
          : `${skipped} skipped`
      );
    }
    if (ungrouped > 0) {
      parts.push(
        `${ungrouped} plays Tautulli never grouped (fixed in Tautulli after 2.18.2; re-import once upgraded)`
      );
    }
    if (noMetadata > 0) {
      parts.push(`${noMetadata} without metadata in Tautulli`);
    }
    if (errors > 0) parts.push(`${errors} errors`);
    if (failedPages.length > 0) {
      parts.push(`${failedPages.length} pages not fetched (${failedPages.join(', ')})`);
    }

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
      imported: changes.imported,
      updated: changes.updated,
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
   * Delete the imported rows of plays these groups absorbed, returning the
   * started_at of each row deleted. Only a row in the Tautulli import form,
   * for the group's user and inside the group's span, can match: a tracked
   * row, or a play a reset Tautulli database reused the id of, never does.
   */
  private static async deleteAbsorbedImports(
    serverId: string,
    groups: AbsorbingGroup[]
  ): Promise<string[]> {
    const plays = groups.flatMap((g) => g.absorbedIds.map((externalId) => ({ externalId, g })));
    const minStart = new Date(Math.min(...groups.map((g) => g.started.getTime())));
    const maxStop = new Date(Math.max(...groups.map((g) => g.stopped.getTime())));
    const imported = sql`s.server_id = ${serverId}::uuid AND s.started_at >= ${ts(minStart)} AND ${importForm('s', 'plex')}`;

    return db.transaction(async (tx) => {
      await uncapDecompressionForTx(tx);
      const found = await tx.execute(sql`
        SELECT DISTINCT ON (s.id) s.id, s.started_at, s.server_user_id,
          r.id AS r_id, r.started_at AS r_started, r.reference_id AS r_ref
        FROM unnest(
          ${sql.param(plays.map((p) => p.externalId))}::text[],
          ${sql.param(plays.map((p) => p.g.rootExternalId))}::text[],
          ${sql.param(plays.map((p) => p.g.serverUserId))}::uuid[],
          ${sql.param(plays.map((p) => p.g.started.toISOString()))}::timestamptz[],
          ${sql.param(plays.map((p) => p.g.stopped.toISOString()))}::timestamptz[]
        ) AS g(external_id, root_external_id, server_user_id, started, stopped)
        JOIN sessions s
          ON ${imported} AND s.started_at <= ${ts(maxStop)}
          AND s.server_user_id = g.server_user_id
          AND s.started_at >= g.started AND s.started_at <= g.stopped
          AND s.external_session_id = g.external_id
        JOIN sessions r
          ON r.server_id = ${serverId}::uuid AND r.started_at >= ${ts(minStart)} AND r.started_at <= ${ts(maxStop)}
          AND r.server_user_id = g.server_user_id AND r.started_at = g.started
          AND r.external_session_id = g.root_external_id
        ORDER BY s.id, r.id
      `);
      const rows = found.rows as Array<{
        id: string;
        started_at: string;
        server_user_id: string;
        r_id: string;
        r_started: string;
        r_ref: string | null;
      }>;
      if (rows.length === 0) return [];

      const doomedIds = new Set(rows.map((r) => r.id));
      // The removed group_ids link pass could point a root at a play it absorbed.
      // That root starts before the play, below the children lookup's bound.
      const detached = rows.filter((r) => r.r_ref !== null && doomedIds.has(r.r_ref));
      if (detached.length > 0) {
        await tx.execute(sql`
          UPDATE sessions r SET reference_id = NULL
          FROM unnest(${sql.param(detached.map((d) => d.r_id))}::uuid[], ${sql.param(detached.map((d) => d.r_started))}::timestamptz[]) AS d(id, started_at)
          WHERE r.id = d.id AND r.started_at = d.started_at
            AND r.server_id = ${serverId}::uuid AND r.started_at >= ${ts(minStart)}
            AND r.reference_id = ANY(${sql.param([...doomedIds])}::uuid[])
        `);
      }

      return deleteSessionsRepointingChildren(
        tx,
        serverId,
        rows.map((r) => ({
          id: r.id,
          started_at: r.started_at,
          server_user_id: r.server_user_id,
          root_id: r.r_ref !== null && !doomedIds.has(r.r_ref) ? r.r_ref : r.r_id,
        })),
        imported
      );
    });
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
    const tautulliConfig = await getSettings(['tautulliUrl', 'tautulliApiKey']);
    if (!tautulliConfig.tautulliUrl || !tautulliConfig.tautulliApiKey) {
      throw new Error('Tautulli is not configured');
    }

    const tautulli = new TautulliService(tautulliConfig.tautulliUrl, tautulliConfig.tautulliApiKey);

    // Test connection
    const connected = await tautulli.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to Tautulli');
    }

    // Initialize progress
    const progress: TautulliImportProgress = {
      serverId,
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
    let minEnrichedDate: Date | null = null;
    let maxEnrichedDate: Date | null = null;
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
          startedAt: sessions.startedAt,
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
          startedAt: Date;
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
                return {
                  status: 'enriched' as const,
                  id: session.id,
                  startedAt: session.startedAt,
                  data: mappedData,
                };
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
                pendingUpdates.push({
                  id: value.id,
                  startedAt: value.startedAt,
                  data: value.data,
                });
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
            // The cap on decompressed tuples is per transaction, so it adds up
            // across every UPDATE below, and the id plus started_at match no
            // segmentby column - each row decompresses its segment. Enrichment
            // ran uncapped before the cap came back globally; keep that, scoped
            // to this transaction.
            await uncapDecompressionForTx(tx);
            for (const update of pendingUpdates) {
              await tx.update(sessions).set(update.data).where(storedSessionRowById(update));
            }
          });
          for (const update of pendingUpdates) {
            if (!minEnrichedDate || update.startedAt < minEnrichedDate)
              minEnrichedDate = update.startedAt;
            if (!maxEnrichedDate || update.startedAt > maxEnrichedDate)
              maxEnrichedDate = update.startedAt;
          }
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

    // Bitrate lands on sessions that are already years old, so the refresh has to
    // cover the days it just rewrote - a 7-day window leaves every older bucket
    // holding the pre-enrichment bitrate.
    if (totalEnriched > 0) {
      progress.message = 'Refreshing aggregates...';
      publishProgress(progress);
      try {
        if (minEnrichedDate && maxEnrichedDate) {
          const startTime = new Date(minEnrichedDate.getTime() - 24 * 60 * 60 * 1000);
          const endTime = new Date(maxEnrichedDate.getTime() + 24 * 60 * 60 * 1000);
          await refreshAggregates({ startTime, endTime });
        } else {
          await refreshAggregates();
        }
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
    // get_history only has the combined transcode_decision; these split it per stream
    ...((streamData.video_decision || streamData.audio_decision) &&
      normalizeStreamDecisions(streamData.video_decision, streamData.audio_decision)),

    // JSONB fields (only set if they have content)
    ...(Object.keys(sourceVideoDetails).length > 0 && { sourceVideoDetails }),
    ...(Object.keys(sourceAudioDetails).length > 0 && { sourceAudioDetails }),
    ...(Object.keys(streamVideoDetails).length > 0 && { streamVideoDetails }),
    ...(Object.keys(streamAudioDetails).length > 0 && { streamAudioDetails }),
    ...(Object.keys(transcodeInfo).length > 0 && { transcodeInfo }),
    ...(Object.keys(subtitleInfo).length > 0 && { subtitleInfo }),
  };
}
