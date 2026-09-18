/**
 * Jellystat Backup Import Service
 *
 * Parses Jellystat backup files (legacy JSON or 1.1.12 JSONL) and imports historical watch data
 * into Tracearr's sessions table.
 *
 * Key features:
 * - File-based import (JSON or JSONL upload from Jellystat backup)
 * - Optional media enrichment via Jellyfin /Items API
 * - GeoIP lookup for IP addresses
 * - Progress tracking via WebSocket
 */

import type {
  JellystatImportProgress,
  JellystatImportResult,
  JellystatLibraryEpisode,
  JellystatLibraryItem,
  JellystatPlaybackActivity,
  JellystatPluginRow,
  SourceAudioDetails,
  SourceVideoDetails,
  StreamAudioDetails,
  StreamVideoDetails,
  SubtitleInfo,
  TranscodeInfo,
} from '@tracearr/shared';
import {
  jellystatBackupSchema,
  jellystatLibraryEpisodeSchema,
  jellystatLibraryItemSchema,
  jellystatPluginRowSchema,
} from '@tracearr/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../db/client.js';
import { servers, sessions } from '../db/schema.js';
import {
  checkAggregateNeedsRebuild,
  refreshAggregates,
  uncapDecompressionForTx,
} from '../db/timescale.js';
import { enqueueMaintenanceJob } from '../jobs/maintenanceQueue.js';
import { batchGetLibraryItemIdentity, type SessionIdentity } from '../jobs/poller/database.js';
import { sanitizeCodec } from '../utils/codecNormalizer.js';
import { extractIpFromEndpoint } from '../utils/parsing.js';
import { normalizeClient } from '../utils/platformNormalizer.js';
import { parseJellystatPlayMethod } from '../utils/transcodeNormalizer.js';
import type { PubSubService } from './cache.js';
import { geoasnService } from './geoasn.js';
import { geoipService } from './geoip.js';
import {
  createSimpleProgressPublisher,
  createSkippedUserTracker,
  createUserMapping,
  exceedsRuntime,
  fetchMediaEnrichment,
  flushInsertBatch,
  type MediaEnrichment,
  queryExistingByExternalIds,
  type ExistingSession,
  type TimeBounds,
} from './import/index.js';
import {
  buildJellystatRemapIndex,
  chooseJellystatItemKey,
  isImportedEpisodeRowRewritten,
  isRemapVetoed,
  resolveJellystatItemKey,
} from './import/jellystatRemapVeto.js';
import { EmbyClient } from './mediaServer/emby/client.js';
import { JellyfinClient } from './mediaServer/jellyfin/client.js';
import { parseMediaType } from './mediaServer/shared/jellyfinEmbyUtils.js';
import { getWatchedThresholds, watchedThresholdFor, type WatchedThresholds } from './settings.js';

const BATCH_SIZE = 500;
const DEDUP_BATCH_SIZE = 5000;
const ENRICHMENT_BATCH_SIZE = 200;
const PROGRESS_THROTTLE_MS = 2000;
const PROGRESS_RECORD_INTERVAL = 500;
// Plugin-origin rows (imported === true) carry ActivityDateInserted in the
// plugin's database timezone, so the true UTC start is only known to within
// this margin around it.
const PLUGIN_ORIGIN_UNCERTAINTY_MS = 27 * 60 * 60 * 1000;

// parsePlayMethod moved to utils/transcodeNormalizer.ts as parseJellystatPlayMethod

/**
 * JellyStat MediaStream from backup (video, audio, or subtitle stream)
 */
interface JellystatMediaStream {
  Type?: string; // 'Video' | 'Audio' | 'Subtitle' etc.
  Codec?: string;
  BitRate?: number;
  Width?: number;
  Height?: number;
  BitDepth?: number;
  Channels?: number;
  ChannelLayout?: string;
  SampleRate?: number;
  Language?: string;
  VideoRange?: string; // SDR, HDR10, etc.
  ColorSpace?: string;
  ColorTransfer?: string;
  ColorPrimaries?: string;
  Profile?: string;
  Level?: number;
  AspectRatio?: string;
  RealFrameRate?: number;
  AverageFrameRate?: number;
  IsDefault?: boolean;
  IsForced?: boolean;
}

/**
 * JellyStat TranscodingInfo from backup
 */
interface JellystatTranscodingInfoFull {
  AudioCodec?: string | null;
  VideoCodec?: string | null;
  Container?: string | null;
  IsVideoDirect?: boolean | null;
  IsAudioDirect?: boolean | null;
  Bitrate?: number | null;
  Framerate?: number | null;
  Width?: number | null;
  Height?: number | null;
  AudioChannels?: number | null;
  HardwareAccelerationType?: string | null;
  TranscodeReasons?: string[];
  CompletionPercentage?: number | null;
}

/**
 * Stream details extracted from JellyStat backup
 */
interface JellystatStreamDetails {
  // Scalar fields
  sourceVideoCodec: string | null;
  sourceVideoWidth: number | null;
  sourceVideoHeight: number | null;
  sourceAudioCodec: string | null;
  sourceAudioChannels: number | null;
  streamVideoCodec: string | null;
  streamAudioCodec: string | null;
  // JSONB fields
  sourceVideoDetails: SourceVideoDetails | null;
  sourceAudioDetails: SourceAudioDetails | null;
  streamVideoDetails: StreamVideoDetails | null;
  streamAudioDetails: StreamAudioDetails | null;
  transcodeInfo: TranscodeInfo | null;
  subtitleInfo: SubtitleInfo | null;
}

/**
 * Extract stream details from JellyStat MediaStreams and TranscodingInfo
 *
 * Maps JellyStat's backup format to our session schema fields
 */
export function extractJellystatStreamDetails(
  mediaStreams: JellystatMediaStream[] | null | undefined,
  transcodingInfo: JellystatTranscodingInfoFull | null | undefined
): JellystatStreamDetails {
  const result: JellystatStreamDetails = {
    sourceVideoCodec: null,
    sourceVideoWidth: null,
    sourceVideoHeight: null,
    sourceAudioCodec: null,
    sourceAudioChannels: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
  };

  // Extract source media info from MediaStreams array
  if (mediaStreams && Array.isArray(mediaStreams)) {
    const videoStream = mediaStreams.find((s) => s.Type === 'Video');
    const audioStream = mediaStreams.find((s) => s.Type === 'Audio' && s.IsDefault !== false);
    const subtitleStream = mediaStreams.find(
      (s) => s.Type === 'Subtitle' && (s.IsDefault || s.IsForced)
    );

    // Source video
    if (videoStream) {
      result.sourceVideoCodec = sanitizeCodec(videoStream.Codec);
      result.sourceVideoWidth = videoStream.Width ?? null;
      result.sourceVideoHeight = videoStream.Height ?? null;

      // Build source video details JSONB
      const videoDetails: SourceVideoDetails = {};
      // Jellystat reports bps; sessions store kbps like the live parsers
      if (videoStream.BitRate) videoDetails.bitrate = Math.floor(videoStream.BitRate / 1000);
      if (videoStream.RealFrameRate || videoStream.AverageFrameRate) {
        videoDetails.framerate = String(videoStream.RealFrameRate ?? videoStream.AverageFrameRate);
      }
      if (videoStream.VideoRange) videoDetails.dynamicRange = videoStream.VideoRange;
      if (videoStream.Profile) videoDetails.profile = videoStream.Profile;
      if (videoStream.Level) videoDetails.level = String(videoStream.Level);
      if (videoStream.ColorSpace) videoDetails.colorSpace = videoStream.ColorSpace;
      if (videoStream.BitDepth) videoDetails.colorDepth = videoStream.BitDepth;

      if (Object.keys(videoDetails).length > 0) {
        result.sourceVideoDetails = videoDetails;
      }
    }

    // Source audio
    if (audioStream) {
      result.sourceAudioCodec = sanitizeCodec(audioStream.Codec);
      result.sourceAudioChannels = audioStream.Channels ?? null;

      // Build source audio details JSONB
      const audioDetails: SourceAudioDetails = {};
      if (audioStream.BitRate) audioDetails.bitrate = Math.floor(audioStream.BitRate / 1000);
      if (audioStream.ChannelLayout) audioDetails.channelLayout = audioStream.ChannelLayout;
      if (audioStream.Language) audioDetails.language = audioStream.Language;
      if (audioStream.SampleRate) audioDetails.sampleRate = audioStream.SampleRate;

      if (Object.keys(audioDetails).length > 0) {
        result.sourceAudioDetails = audioDetails;
      }
    }

    // Subtitle info
    if (subtitleStream) {
      const subInfo: SubtitleInfo = {};
      if (subtitleStream.Codec) subInfo.codec = subtitleStream.Codec;
      if (subtitleStream.Language) subInfo.language = subtitleStream.Language;
      if (subtitleStream.IsForced !== undefined) subInfo.forced = subtitleStream.IsForced;

      if (Object.keys(subInfo).length > 0) {
        result.subtitleInfo = subInfo;
      }
    }
  }

  // Extract transcode/stream output info from TranscodingInfo
  if (transcodingInfo) {
    // Stream output codecs (after transcode)
    result.streamVideoCodec = sanitizeCodec(transcodingInfo.VideoCodec);
    result.streamAudioCodec = sanitizeCodec(transcodingInfo.AudioCodec);

    // Build stream video details JSONB
    const streamVideo: StreamVideoDetails = {};
    if (transcodingInfo.Bitrate) streamVideo.bitrate = transcodingInfo.Bitrate;
    if (transcodingInfo.Width) streamVideo.width = transcodingInfo.Width;
    if (transcodingInfo.Height) streamVideo.height = transcodingInfo.Height;
    if (transcodingInfo.Framerate) streamVideo.framerate = String(transcodingInfo.Framerate);

    if (Object.keys(streamVideo).length > 0) {
      result.streamVideoDetails = streamVideo;
    }

    // Build stream audio details JSONB
    const streamAudio: StreamAudioDetails = {};
    if (transcodingInfo.AudioChannels) streamAudio.channels = transcodingInfo.AudioChannels;

    if (Object.keys(streamAudio).length > 0) {
      result.streamAudioDetails = streamAudio;
    }

    // Build transcode info JSONB
    const transcodeDetails: TranscodeInfo = {};
    if (transcodingInfo.Container) transcodeDetails.streamContainer = transcodingInfo.Container;
    if (transcodingInfo.HardwareAccelerationType) {
      transcodeDetails.hwEncoding = transcodingInfo.HardwareAccelerationType;
    }

    if (Object.keys(transcodeDetails).length > 0) {
      result.transcodeInfo = transcodeDetails;
    }
  }

  return result;
}

interface ParsedJellystatBackup {
  activities: unknown[];
  libraryItems: JellystatLibraryItem[] | null;
  libraryEpisodes: JellystatLibraryEpisode[] | null;
  pluginRows: JellystatPluginRow[] | null;
}

/**
 * Keep only the rows of a table that parse, as slim records. Returns null when
 * the backup excluded the table.
 */
function projectBackupTable<Schema extends z.ZodType>(
  rows: unknown[] | undefined,
  schema: Schema,
  table: string
): z.output<Schema>[] | null {
  if (!rows) return null;
  const records: z.output<Schema>[] = [];
  let malformed = 0;
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) records.push(parsed.data);
    else malformed++;
  }
  if (malformed > 0) {
    console.warn(`[Jellystat] Skipped ${malformed} malformed ${table} rows during parsing`);
  }
  return records;
}

const READ_TABLES: ReadonlySet<string> = new Set(Object.keys(jellystatBackupSchema.element.shape));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Tables of a JSONL backup, keyed by table name. Jellystat's own restore
 * refuses a row whose table is not the last header, so this does too. The
 * text is walked in place: a split into lines would hold a second copy of
 * an upload that can be 500 MB. Rows are kept as JSON.parse built them, and
 * only for the tables the import reads; every other table keeps its header
 * and an empty list, since a backup's largest tables are ones Tracearr never
 * reads and the whole result stays on the heap for the length of the import.
 */
export function readJsonlTables(text: string): Map<string, unknown[]> {
  const tables = new Map<string, unknown[]>();
  let currentTable: string | null = null;
  let lineNumber = 0;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(offset, end).trim();
    offset = end + 1;
    lineNumber++;
    if (!line) continue;

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`Invalid Jellystat backup: line ${lineNumber} is not valid JSON`);
    }
    const isHeader = isPlainObject(record) && record.type === 'table';
    const isRow = isPlainObject(record) && record.type === 'row' && isPlainObject(record.data);
    if (!isPlainObject(record) || typeof record.table !== 'string' || !(isHeader || isRow)) {
      throw new Error(`Invalid Jellystat backup: line ${lineNumber} is not a table or row record`);
    }

    if (isHeader) {
      currentTable = record.table;
      if (!tables.has(currentTable)) tables.set(currentTable, []);
      continue;
    }
    const rows = currentTable === null ? undefined : tables.get(currentTable);
    if (!rows || record.table !== currentTable) {
      throw new Error(
        `Invalid Jellystat backup: line ${lineNumber} holds a ${record.table} row before that table's header`
      );
    }
    if (READ_TABLES.has(currentTable)) rows.push(record.data);
  }
  return tables;
}

/**
 * Parse and validate a Jellystat backup, either the legacy JSON array or the
 * JSONL Jellystat 1.1.12 writes, told apart by the first character.
 * Returns raw activity records (validated individually during import) and the
 * library and plugin tables as slim records, each null when the backup left it out
 */
export function parseJellystatBackup(text: string): ParsedJellystatBackup {
  const root: unknown = /^\s*\{/.test(text)
    ? [Object.fromEntries(readJsonlTables(text))]
    : JSON.parse(text);
  const parsed = jellystatBackupSchema.safeParse(root);

  if (!parsed.success) {
    throw new Error(`Invalid Jellystat backup format: ${parsed.error.message}`);
  }

  // Each table sits in its own section, and their order varies between backup files
  const sections = parsed.data;
  const findTable = <K extends keyof (typeof sections)[number]>(key: K) =>
    sections.find((section) => section[key] !== undefined)?.[key];

  return {
    activities: findTable('jf_playback_activity') ?? [],
    libraryItems: projectBackupTable(
      findTable('jf_library_items'),
      jellystatLibraryItemSchema,
      'jf_library_items'
    ),
    libraryEpisodes: projectBackupTable(
      findTable('jf_library_episodes'),
      jellystatLibraryEpisodeSchema,
      'jf_library_episodes'
    ),
    pluginRows: projectBackupTable(
      findTable('jf_playback_reporting_plugin_data'),
      jellystatPluginRowSchema,
      'jf_playback_reporting_plugin_data'
    ),
  };
}

/**
 * Compute the playback start from ActivityDateInserted (the end time) and duration.
 */
function computeActivityStartedAt(activity: JellystatPlaybackActivity): Date {
  const durationSeconds =
    typeof activity.PlaybackDuration === 'string'
      ? parseInt(activity.PlaybackDuration, 10)
      : activity.PlaybackDuration;
  const durationMs = isNaN(durationSeconds) ? 0 : durationSeconds * 1000;

  return new Date(new Date(activity.ActivityDateInserted).getTime() - durationMs);
}

/**
 * Transform Jellystat activity to session insert data
 */
export function transformActivityToSession(
  activity: JellystatPlaybackActivity,
  serverId: string,
  serverUserId: string,
  geo: ReturnType<typeof geoipService.lookup>,
  enrichment?: MediaEnrichment,
  identity?: SessionIdentity,
  ratingKey: string | null = activity.NowPlayingItemId,
  thresholds?: WatchedThresholds
): typeof sessions.$inferInsert {
  const stoppedAt = new Date(activity.ActivityDateInserted);
  const startedAt = computeActivityStartedAt(activity);
  const durationMs = stoppedAt.getTime() - startedAt.getTime();

  const totalDurationMs = enrichment?.runtimeMs ?? null;

  // Detect media type - prefer enrichment data from media server API when available
  // Uses shared parseMediaType for consistency with live session polling
  let mediaType = enrichment?.itemType ? parseMediaType(enrichment.itemType) : 'unknown';

  // Fallback: use SeriesName or MediaStreams heuristics for non-enriched imports
  if (mediaType === 'unknown') {
    if (activity.SeriesName) {
      mediaType = 'episode';
    } else {
      const activityForStreams = activity as Record<string, unknown>;
      const streams = activityForStreams.MediaStreams as JellystatMediaStream[] | null;
      const hasVideoStream = streams?.some((s) => s.Type === 'Video') ?? true;
      const hasAudioStream = streams?.some((s) => s.Type === 'Audio') ?? false;

      mediaType = !hasVideoStream && hasAudioStream ? 'track' : 'movie';
    }
  }

  const watched =
    thresholds != null &&
    totalDurationMs != null &&
    durationMs >= totalDurationMs * watchedThresholdFor(thresholds, mediaType);

  // Extract TranscodingInfo for DirectStream vs DirectPlay detection
  // Jellystat exports "DirectStream" for what Emby shows as "DirectPlay"
  const activityAnyForTranscode = activity as Record<string, unknown>;
  const transcodingInfoForDecision = activityAnyForTranscode.TranscodingInfo as {
    IsVideoDirect?: boolean | null;
    IsAudioDirect?: boolean | null;
  } | null;

  const { videoDecision, audioDecision, isTranscode } = parseJellystatPlayMethod(
    activity.PlayMethod,
    transcodingInfoForDecision
  );

  // Extract stream details from MediaStreams and TranscodingInfo
  // These fields exist in JellyStat backups but aren't typed in the schema (looseObject allows them)
  const activityAny = activity as Record<string, unknown>;
  const mediaStreams = activityAny.MediaStreams as JellystatMediaStream[] | null | undefined;
  const transcodingInfoFull = activityAny.TranscodingInfo as
    JellystatTranscodingInfoFull | null | undefined;
  const streamDetails = extractJellystatStreamDetails(mediaStreams, transcodingInfoFull);

  // Bitrate: prefer TranscodingInfo bitrate (in bps), convert to kbps.
  // Fall back to source video bitrate, which extract already stores as kbps.
  const bitrate = transcodingInfoFull?.Bitrate
    ? Math.floor(transcodingInfoFull.Bitrate / 1000)
    : (streamDetails.sourceVideoDetails?.bitrate ?? null);

  return {
    serverId,
    serverUserId,
    sessionKey: activity.Id,
    plexSessionId: null,
    ratingKey,
    externalSessionId: activity.Id,
    referenceId: null,
    parentRatingKey: identity?.parentRatingKey ?? null,
    grandparentRatingKey: identity?.grandparentRatingKey ?? null,
    mediaId: identity?.mediaId ?? null,
    showMediaId: identity?.showMediaId ?? null,
    imdbId: identity?.imdbId ?? null,
    tmdbId: identity?.tmdbId ?? null,
    tvdbId: identity?.tvdbId ?? null,
    state: 'stopped',
    mediaType,
    mediaTitle: activity.NowPlayingItemName,
    grandparentTitle: activity.SeriesName ?? null,
    seasonNumber: enrichment?.seasonNumber ?? null,
    episodeNumber: enrichment?.episodeNumber ?? null,
    year: enrichment?.year ?? null,
    thumbPath: enrichment?.thumbPath ?? null,
    // Music track metadata (only applied for track type)
    artistName: mediaType === 'track' ? (enrichment?.artistName ?? null) : null,
    albumName: mediaType === 'track' ? (enrichment?.albumName ?? null) : null,
    trackNumber: mediaType === 'track' ? (enrichment?.trackNumber ?? null) : null,
    discNumber: mediaType === 'track' ? (enrichment?.discNumber ?? null) : null,
    startedAt,
    lastSeenAt: stoppedAt,
    lastPausedAt: null,
    stoppedAt,
    durationMs,
    totalDurationMs,
    progressMs: null,
    pausedDurationMs: 0,
    watched,
    forceStopped: false,
    shortSession: durationMs < 120000,
    ipAddress: extractIpFromEndpoint(activity.RemoteEndPoint),
    geoCity: geo.city,
    geoRegion: geo.region,
    geoCountry: geo.countryCode ?? geo.country,
    geoContinent: geo.continent,
    geoPostal: geo.postal,
    geoLat: geo.lat,
    geoLon: geo.lon,
    geoAsnNumber: geo.asnNumber,
    geoAsnOrganization: geo.asnOrganization,
    // Normalize client info for consistency with live sessions
    // normalizeClient handles "AndroidTv" → "Android TV", "Emby for Kodi Next Gen" → "Kodi", etc.
    ...(() => {
      const clientName = activity.Client ?? '';
      const deviceName = activity.DeviceName ?? '';
      const normalized = normalizeClient(clientName, deviceName, 'jellyfin');
      return {
        // Truncate string fields to varchar limits - some Jellyfin clients send very long strings
        playerName: (deviceName || clientName || 'Unknown').substring(0, 255),
        device: normalized.device.substring(0, 255),
        deviceId: activity.DeviceId?.substring(0, 255) ?? null,
        product: clientName.substring(0, 255) || null,
        platform: normalized.platform.substring(0, 100), // platform is varchar(100)
      };
    })(),
    quality: null,
    isTranscode,
    videoDecision,
    audioDecision,
    bitrate,
    // Stream details from MediaStreams and TranscodingInfo
    ...streamDetails,
  };
}

/**
 * Import Jellystat backup into Tracearr
 *
 * @param serverId - Target Tracearr server ID
 * @param backupJson - Raw JSON string from Jellystat backup file
 * @param enrichMedia - Whether to fetch metadata from Jellyfin API
 * @param pubSubService - Optional pub/sub service for progress updates
 * @param options - Additional import options
 */
export async function importJellystatBackup(
  serverId: string,
  backupJson: string,
  enrichMedia: boolean = true,
  pubSubService?: PubSubService,
  options?: { updateStreamDetails?: boolean }
): Promise<JellystatImportResult> {
  const progress: JellystatImportProgress = {
    status: 'idle',
    totalRecords: 0,
    processedRecords: 0,
    importedRecords: 0,
    skippedRecords: 0,
    filteredRecords: 0,
    errorRecords: 0,
    enrichedRecords: 0,
    message: 'Starting import...',
  };

  let lastProgressTime = Date.now();
  const publishProgress = createSimpleProgressPublisher<JellystatImportProgress>(
    pubSubService,
    'import:jellystat:progress'
  );

  publishProgress(progress);

  try {
    progress.status = 'parsing';
    progress.message = 'Parsing Jellystat backup file...';
    publishProgress(progress);

    const {
      activities: rawActivities,
      libraryItems,
      libraryEpisodes,
      pluginRows,
    } = parseJellystatBackup(backupJson);
    const remapIndex = buildJellystatRemapIndex(libraryItems, libraryEpisodes, pluginRows);
    progress.totalRecords = rawActivities.length;
    progress.message = `Parsed ${rawActivities.length} records from backup`;
    publishProgress(progress);

    if (rawActivities.length === 0) {
      progress.status = 'complete';
      progress.message = 'No playback activity records found in backup';
      publishProgress(progress);
      return {
        success: true,
        imported: 0,
        updated: 0,
        skipped: 0,
        filtered: 0,
        errors: 0,
        enriched: 0,
        unchecked: 0,
        unlinkedEpisodes: 0,
        vetoed: 0,
        pluginUnchecked: 0,
        overlong: 0,
        message: 'No playback activity records found in backup',
      };
    }

    // Validate records individually - skip bad records instead of failing entire backup
    const { jellystatPlaybackActivitySchema } = await import('@tracearr/shared');
    const activities: JellystatPlaybackActivity[] = [];
    let parseErrors = 0;

    for (const raw of rawActivities) {
      const parsed = jellystatPlaybackActivitySchema.safeParse(raw);
      if (parsed.success) {
        activities.push(parsed.data);
      } else {
        const activityId = (raw as Record<string, unknown>)?.Id ?? 'unknown';
        console.warn(
          `[Jellystat] Skipping malformed record ${activityId}:`,
          parsed.error.issues[0]
        );
        parseErrors++;
        progress.errorRecords++;
      }
    }

    if (parseErrors > 0) {
      console.warn(`[Jellystat] Skipped ${parseErrors} malformed records during parsing`);
    }

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);

    if (!server) {
      throw new Error(`Server not found: ${serverId}`);
    }

    if (server.type !== 'jellyfin' && server.type !== 'emby') {
      throw new Error(`Jellystat import only supports Jellyfin/Emby servers, got: ${server.type}`);
    }

    const cutoff = server.createdAt;

    const userMap = await createUserMapping(serverId);
    const thresholds = await getWatchedThresholds();
    const enrichmentMap = new Map<string, MediaEnrichment>();

    if (enrichMedia) {
      progress.status = 'enriching';
      progress.message = 'Fetching media metadata from Jellyfin...';
      publishProgress(progress);

      const uniqueMediaIds = [
        ...new Set(activities.flatMap((a) => chooseJellystatItemKey(a, remapIndex).candidates)),
      ];
      console.log(`[Jellystat] Enriching ${uniqueMediaIds.length} unique media items`);

      const clientConfig = {
        url: server.url,
        token: server.token,
        id: server.id,
        name: server.name,
      };
      const client =
        server.type === 'emby' ? new EmbyClient(clientConfig) : new JellyfinClient(clientConfig);

      for (let i = 0; i < uniqueMediaIds.length; i += ENRICHMENT_BATCH_SIZE) {
        const batch = uniqueMediaIds.slice(i, i + ENRICHMENT_BATCH_SIZE);
        const batchEnrichment = await fetchMediaEnrichment(client, batch);

        for (const [id, data] of batchEnrichment) {
          enrichmentMap.set(id, data);
          progress.enrichedRecords++;
        }

        progress.message = `Enriching media: ${Math.min(i + ENRICHMENT_BATCH_SIZE, uniqueMediaIds.length)}/${uniqueMediaIds.length}`;
        publishProgress(progress);
      }

      console.log(`[Jellystat] Enriched ${enrichmentMap.size} media items`);
    }

    progress.status = 'processing';
    progress.message = 'Processing records...';
    publishProgress(progress);

    const geoCache = new Map<string, ReturnType<typeof geoipService.lookup>>();
    const insertedInThisImport = new Set<string>();
    const updateStreamDetails = options?.updateStreamDetails ?? false;

    // Track date range of imported data for bounded aggregate refresh
    let minImportDate: Date | null = null;
    let maxImportDate: Date | null = null;

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let filtered = 0;
    let errors = 0;
    let unchecked = 0;
    let unlinkedEpisodes = 0;
    let vetoed = 0;
    let pluginUnchecked = 0;
    let overlong = 0;

    const skippedUserTracker = createSkippedUserTracker();

    for (let chunkStart = 0; chunkStart < activities.length; chunkStart += DEDUP_BATCH_SIZE) {
      const chunk = activities.slice(chunkStart, chunkStart + DEDUP_BATCH_SIZE);

      const chunkIds = chunk.map((a) => a.Id).filter(Boolean);

      // Compute time bounds for this chunk to enable TimescaleDB chunk exclusion
      // ActivityDateInserted is the end time; we use it directly for bounds
      const chunkTimestamps = chunk
        .map((a) => new Date(a.ActivityDateInserted).getTime())
        .filter((t) => !isNaN(t));
      const chunkTimeBounds: TimeBounds | undefined =
        chunkTimestamps.length > 0
          ? {
              minTime: new Date(Math.min(...chunkTimestamps)),
              maxTime: new Date(Math.max(...chunkTimestamps)),
            }
          : undefined;

      let existingMap = new Map<string, ExistingSession>();
      if (chunkIds.length > 0) {
        existingMap = await queryExistingByExternalIds(serverId, chunkIds, chunkTimeBounds);
      }

      const chunkRatingKeys = [
        ...new Set(chunk.flatMap((a) => chooseJellystatItemKey(a, remapIndex).candidates)),
      ].filter(Boolean);
      const identityByRatingKey = await batchGetLibraryItemIdentity(serverId, chunkRatingKeys);

      const insertBatch: (typeof sessions.$inferInsert)[] = [];
      const updateBatch: Array<{ id: string; data: Partial<typeof sessions.$inferInsert> }> = [];

      for (const activity of chunk) {
        progress.processedRecords++;

        try {
          const serverUserId = userMap.get(activity.UserId);
          if (!serverUserId) {
            skippedUserTracker.track(activity.UserId, activity.UserName ?? null);
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Check if this is a duplicate we've already handled in this import
          if (insertedInThisImport.has(activity.Id)) {
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Tracearr already tracks anything at or after the server's cutoff.
          // Plugin-origin rows store ActivityDateInserted in the plugin's own database
          // timezone, so their real start is only known to within PLUGIN_ORIGIN_UNCERTAINTY_MS.
          const isPluginOrigin = (activity as Record<string, unknown>).imported === true;
          const cutoffCheckTime = isPluginOrigin
            ? new Date(activity.ActivityDateInserted).getTime() + PLUGIN_ORIGIN_UNCERTAINTY_MS
            : computeActivityStartedAt(activity).getTime();
          if (cutoffCheckTime >= cutoff.getTime()) {
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Check if record exists in database
          const existingSession = existingMap.get(activity.Id);
          if (existingSession) {
            // Record exists - check if we should update stream details
            if (updateStreamDetails && !existingSession.sourceVideoCodec) {
              // Extract stream details from this activity
              const activityRecord = activity as Record<string, unknown>;
              const mediaStreams = Array.isArray(activityRecord.MediaStreams)
                ? (activityRecord.MediaStreams as JellystatMediaStream[])
                : null;
              const transcodingInfoFull =
                (activityRecord.TranscodingInfo as JellystatTranscodingInfoFull | null) ?? null;

              // Only update if backup has stream data
              if (mediaStreams && mediaStreams.length > 0) {
                const streamDetails = extractJellystatStreamDetails(
                  mediaStreams,
                  transcodingInfoFull
                );

                // Only queue update if we got meaningful data
                if (streamDetails.sourceVideoCodec || streamDetails.sourceAudioCodec) {
                  // Calculate bitrate if available
                  const bitrate = transcodingInfoFull?.Bitrate
                    ? Math.floor(transcodingInfoFull.Bitrate / 1000)
                    : streamDetails.sourceVideoDetails?.bitrate
                      ? Math.floor(streamDetails.sourceVideoDetails.bitrate / 1000)
                      : null;

                  updateBatch.push({
                    id: existingSession.id,
                    data: {
                      ...streamDetails,
                      bitrate,
                    },
                  });
                  updated++;
                  continue;
                }
              }
            }
            // No update needed - skip
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          const ipAddress = extractIpFromEndpoint(activity.RemoteEndPoint);
          let geo = geoCache.get(ipAddress);
          if (!geo) {
            const baseGeo = geoipService.lookup(ipAddress);
            const asn = geoasnService.lookup(ipAddress);
            geo = {
              ...baseGeo,
              asnNumber: asn.number,
              asnOrganization: asn.organization,
            };
            geoCache.set(ipAddress, geo);
          }

          const keyChoice = chooseJellystatItemKey(activity, remapIndex);
          const { ratingKey, identity } = resolveJellystatItemKey(keyChoice, identityByRatingKey);
          const rewrittenPluginRow = isImportedEpisodeRowRewritten(activity, keyChoice);
          const isVetoed =
            rewrittenPluginRow ||
            (keyChoice.source === 'native' &&
              keyChoice.checked &&
              isRemapVetoed(activity, ratingKey, Boolean(activity.EpisodeId), remapIndex));
          const enrichment = isVetoed ? undefined : enrichmentMap.get(ratingKey);

          // Skip theme songs, theme videos, trailers, etc.
          if (enrichment?.filtered) {
            filtered++;
            progress.filteredRecords++;
            progress.skippedRecords++;
            skipped++;
            continue;
          }

          const playedMs =
            new Date(activity.ActivityDateInserted).getTime() -
            computeActivityStartedAt(activity).getTime();
          if (exceedsRuntime(playedMs, enrichment?.runtimeMs)) {
            overlong++;
            progress.overlongRecords = overlong;
            progress.skippedRecords++;
            skipped++;
            continue;
          }

          const sessionData = transformActivityToSession(
            activity,
            serverId,
            serverUserId,
            geo,
            enrichment,
            isVetoed ? undefined : identity,
            isVetoed ? null : ratingKey,
            thresholds
          );
          insertBatch.push(sessionData);

          if (rewrittenPluginRow && pluginRows === null) {
            pluginUnchecked++;
            progress.pluginUncheckedRecords = pluginUnchecked;
          } else if (isVetoed) {
            vetoed++;
            progress.vetoedRecords = vetoed;
          } else if (keyChoice.episodeIdDropped && !identity) {
            unlinkedEpisodes++;
            progress.unlinkedEpisodeRecords = unlinkedEpisodes;
          } else if (!keyChoice.checked) {
            unchecked++;
            progress.uncheckedRecords = unchecked;
          }

          // Track date range for bounded aggregate refresh
          if (sessionData.startedAt) {
            if (!minImportDate || sessionData.startedAt < minImportDate)
              minImportDate = sessionData.startedAt;
            if (!maxImportDate || sessionData.startedAt > maxImportDate)
              maxImportDate = sessionData.startedAt;
          }

          insertedInThisImport.add(activity.Id);

          imported++;
          progress.importedRecords++;
        } catch (error) {
          console.error('[Jellystat] Error processing record:', activity.Id, error);
          errors++;
          progress.errorRecords++;
        }

        const now = Date.now();
        if (
          progress.processedRecords % PROGRESS_RECORD_INTERVAL === 0 ||
          now - lastProgressTime > PROGRESS_THROTTLE_MS
        ) {
          progress.message = `Processing: ${progress.processedRecords}/${progress.totalRecords}`;
          publishProgress(progress);
          lastProgressTime = now;
        }
      }

      if (insertBatch.length > 0) {
        await flushInsertBatch(insertBatch, { chunkSize: BATCH_SIZE });
      }

      // Batch update existing records with stream details
      if (updateBatch.length > 0) {
        await db.transaction(async (tx) => {
          // Every UPDATE here shares one transaction, so the decompression cap
          // accumulates across the whole batch, and `WHERE id = ?` matches no
          // segmentby column - each row decompresses its segment. Imports ran
          // uncapped before the cap came back globally; keep that, scoped to
          // this transaction.
          await uncapDecompressionForTx(tx);
          for (const update of updateBatch) {
            await tx.update(sessions).set(update.data).where(eq(sessions.id, update.id));
          }
        });
      }

      geoCache.clear();
    }

    progress.message = 'Refreshing aggregates...';
    publishProgress(progress);
    try {
      // Use bounded refresh based on actual import date range (memory-efficient)
      // Add 1 day buffer on each side for timezone edge cases
      if (minImportDate && maxImportDate) {
        const startTime = new Date(minImportDate.getTime() - 24 * 60 * 60 * 1000);
        const endTime = new Date(maxImportDate.getTime() + 24 * 60 * 60 * 1000);
        console.log(
          `[Jellystat] Refreshing aggregates for date range: ${startTime.toISOString()} to ${endTime.toISOString()}`
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
          `[Jellystat] Fresh install detected - queueing safe aggregate rebuild: ${rebuildStatus.reason}`
        );
        try {
          await enqueueMaintenanceJob('full_aggregate_rebuild', 'system');
          console.log('[Jellystat] Safe aggregate rebuild job queued');
        } catch {
          // Job might already be running/queued - that's fine
          console.log('[Jellystat] Could not queue aggregate rebuild (may already be running)');
        }
      }
    } catch (err) {
      console.warn('[Jellystat] Failed to refresh aggregates after import:', err);
    }

    let message = `Import complete: ${imported} imported, ${updated} updated, ${skipped} skipped, ${errors} errors`;
    if (filtered > 0) {
      message += `, ${filtered} filtered (theme music/trailers)`;
    }
    if (enrichMedia && enrichmentMap.size > 0) {
      message += `, ${enrichmentMap.size} media items enriched`;
    }
    const plays = (count: number) => (count === 1 ? 'play' : 'plays');
    if (unlinkedEpisodes > 0) {
      message += `. ${unlinkedEpisodes} episode ${plays(unlinkedEpisodes)} not linked because the backup left out jf_library_episodes; importing ${unlinkedEpisodes === 1 ? 'it' : 'them'} again will not link ${unlinkedEpisodes === 1 ? 'it' : 'them'}`;
    }
    if (unchecked > 0) {
      message += `. ${unchecked} ${plays(unchecked)} could not be checked for moves to a different title because the backup left out library tables`;
    }
    if (pluginUnchecked > 0) {
      message += `. ${pluginUnchecked} episode ${plays(pluginUnchecked)} from the Playback Reporting plugin not linked because the backup left out jf_playback_reporting_plugin_data`;
    }
    if (vetoed > 0) {
      message += `. ${vetoed} ${plays(vetoed)} not linked because Jellystat may have moved ${vetoed === 1 ? 'it' : 'them'} to a different title`;
    }
    if (overlong > 0) {
      message += `. ${overlong} ${plays(overlong)} skipped because the recorded play time runs past the media runtime`;
    }

    const skippedUsersWarning = skippedUserTracker.formatWarning();
    if (skippedUsersWarning) {
      message += `. Warning: ${skippedUsersWarning}`;
      console.warn(
        `[Jellystat] Import skipped users: ${skippedUserTracker
          .getAll()
          .map((u) => `${u.username}(${u.externalId})`)
          .join(', ')}`
      );
    }

    progress.status = 'complete';
    progress.message = message;
    publishProgress(progress);

    return {
      success: true,
      imported,
      updated,
      skipped,
      filtered,
      errors,
      enriched: enrichmentMap.size,
      unchecked,
      unlinkedEpisodes,
      vetoed,
      pluginUnchecked,
      overlong,
      message,
      skippedUsers:
        skippedUserTracker.size > 0
          ? skippedUserTracker.getAll().map((u) => ({
              jellyfinUserId: u.externalId,
              username: u.username,
              recordCount: u.count,
            }))
          : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Jellystat] Import failed:', error);

    progress.status = 'error';
    progress.message = `Import failed: ${errorMessage}`;
    publishProgress(progress);

    return {
      success: false,
      imported: progress.importedRecords,
      updated: 0,
      skipped: progress.skippedRecords,
      filtered: progress.filteredRecords,
      errors: progress.errorRecords,
      enriched: progress.enrichedRecords,
      unchecked: progress.uncheckedRecords ?? 0,
      unlinkedEpisodes: progress.unlinkedEpisodeRecords ?? 0,
      vetoed: progress.vetoedRecords ?? 0,
      pluginUnchecked: progress.pluginUncheckedRecords ?? 0,
      overlong: progress.overlongRecords ?? 0,
      message: `Import failed: ${errorMessage}`,
    };
  }
}
