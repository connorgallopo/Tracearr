/**
 * Jellystat Backup Import Service
 *
 * Parses Jellystat backup JSON files and imports historical watch data
 * into Tracearr's sessions table.
 *
 * Key features:
 * - File-based import (JSON upload from Jellystat backup)
 * - Optional media enrichment via Jellyfin /Items API
 * - GeoIP lookup for IP addresses
 * - Progress tracking via WebSocket
 */

import type {
  JellystatImportProgress,
  JellystatImportResult,
  JellystatPlaybackActivity,
  SourceAudioDetails,
  SourceVideoDetails,
  StreamAudioDetails,
  StreamVideoDetails,
  SubtitleInfo,
  TranscodeInfo,
} from '@tracearr/shared';
import { jellystatBackupSchema } from '@tracearr/shared';
import { eq } from 'drizzle-orm';
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
import { extractIpFromEndpoint, parseString } from '../utils/parsing.js';
import { normalizeClient } from '../utils/platformNormalizer.js';
import { parseJellystatPlayMethod } from '../utils/transcodeNormalizer.js';
import type { PubSubService } from './cache.js';
import { geoasnService } from './geoasn.js';
import { geoipService } from './geoip.js';
import {
  createSimpleProgressPublisher,
  createSkippedUserTracker,
  createUserMapping,
  fetchMediaEnrichment,
  flushInsertBatch,
  type MediaEnrichment,
  queryExistingByExternalIds,
  type TimeBounds,
} from './import/index.js';
import { EmbyClient } from './mediaServer/emby/client.js';
import { JellyfinClient } from './mediaServer/jellyfin/client.js';
import { parseMediaType } from './mediaServer/shared/jellyfinEmbyUtils.js';

const BATCH_SIZE = 500;
const DEDUP_BATCH_SIZE = 5000;
const ENRICHMENT_BATCH_SIZE = 200;
const PROGRESS_THROTTLE_MS = 2000;
const PROGRESS_RECORD_INTERVAL = 500;
const TICKS_TO_MS = 10000; // 100ns ticks to ms

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

    // Transcode reasons (e.g. ContainerBitrateExceedsLimit, VideoCodecNotSupported)
    // Coerce elements defensively, trim, and dedupe so the stored list is clean.
    if (transcodingInfo.TranscodeReasons?.length) {
      const reasons = Array.from(
        new Set(
          transcodingInfo.TranscodeReasons.map((reason) => parseString(reason).trim()).filter(
            (reason) => reason.length > 0
          )
        )
      );
      if (reasons.length > 0) {
        transcodeDetails.reasons = reasons;
      }
    }

    if (Object.keys(transcodeDetails).length > 0) {
      result.transcodeInfo = transcodeDetails;
    }
  }

  return result;
}

/**
 * Parse and validate Jellystat backup file structure
 * Returns raw activity records - individual records are validated during import
 */
export function parseJellystatBackup(jsonString: string): unknown[] {
  const data: unknown = JSON.parse(jsonString);
  const parsed = jellystatBackupSchema.safeParse(data);

  if (!parsed.success) {
    throw new Error(`Invalid Jellystat backup format: ${parsed.error.message}`);
  }

  // Find the section containing playback activity (position varies in backup files)
  const playbackSection = parsed.data.find(
    (section): section is { jf_playback_activity: unknown[] } => 'jf_playback_activity' in section
  );
  const activities = playbackSection?.jf_playback_activity ?? [];
  return activities;
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
  identity?: SessionIdentity
): typeof sessions.$inferInsert {
  const durationSeconds =
    typeof activity.PlaybackDuration === 'string'
      ? parseInt(activity.PlaybackDuration, 10)
      : activity.PlaybackDuration;
  const durationMs = isNaN(durationSeconds) ? 0 : durationSeconds * 1000;

  const stoppedAt = new Date(activity.ActivityDateInserted);
  const startedAt = new Date(stoppedAt.getTime() - durationMs);

  // != null handles 0 correctly
  const positionMs =
    activity.PlayState?.PositionTicks != null
      ? Math.floor(activity.PlayState.PositionTicks / TICKS_TO_MS)
      : null;

  // Get PercentComplete from PlayState (available via looseObject but not typed)
  const playStateAny = activity.PlayState;
  const percentComplete =
    typeof playStateAny?.PercentComplete === 'number' ? playStateAny.PercentComplete : null;

  // Calculate totalDurationMs, preferring RuntimeTicks but falling back to PercentComplete
  // When RuntimeTicks is missing/zero, derive total from: durationMs * 100 / percentComplete
  let totalDurationMs: number | null = null;
  if (activity.PlayState?.RuntimeTicks != null && activity.PlayState.RuntimeTicks > 0) {
    // Primary: use RuntimeTicks directly
    totalDurationMs = Math.floor(activity.PlayState.RuntimeTicks / TICKS_TO_MS);
  } else if (percentComplete != null && percentComplete > 0 && durationMs > 0) {
    // Fallback: derive from PercentComplete (like Tautulli import does)
    // e.g., if 50% watched and watched 1000ms, total = 2000ms
    totalDurationMs = Math.round((durationMs * 100) / percentComplete);
  }
  // If both are unavailable, totalDurationMs stays null

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
    ratingKey: activity.NowPlayingItemId,
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
    progressMs: positionMs,
    pausedDurationMs: 0,
    watched: activity.PlayState?.Completed ?? false,
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

    const rawActivities = parseJellystatBackup(backupJson);
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

    const userMap = await createUserMapping(serverId);
    const enrichmentMap = new Map<string, MediaEnrichment>();

    if (enrichMedia) {
      progress.status = 'enriching';
      progress.message = 'Fetching media metadata from Jellyfin...';
      publishProgress(progress);

      const uniqueMediaIds = [...new Set(activities.map((a) => a.NowPlayingItemId))];
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

      const existingMap =
        chunkIds.length > 0
          ? await queryExistingByExternalIds(serverId, chunkIds, chunkTimeBounds)
          : new Map();

      const chunkRatingKeys = [...new Set(chunk.map((a) => a.NowPlayingItemId).filter(Boolean))];
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

          // Check if record exists in database
          const existingSession = existingMap.get(activity.Id);
          if (existingSession) {
            // Record exists - check if we should update stream details
            if (updateStreamDetails && !existingSession.sourceVideoCodec) {
              // Extract stream details from this activity
              const activityAny = activity as Record<string, unknown>;
              const mediaStreams = activityAny.MediaStreams as JellystatMediaStream[] | null;
              const transcodingInfoFull =
                activityAny.TranscodingInfo as JellystatTranscodingInfoFull | null;

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

          const enrichment = enrichmentMap.get(activity.NowPlayingItemId);

          // Skip theme songs, theme videos, trailers, etc.
          if (enrichment?.filtered) {
            filtered++;
            progress.filteredRecords++;
            progress.skippedRecords++;
            skipped++;
            continue;
          }

          const identity = identityByRatingKey.get(activity.NowPlayingItemId);
          const sessionData = transformActivityToSession(
            activity,
            serverId,
            serverUserId,
            geo,
            enrichment,
            identity
          );
          insertBatch.push(sessionData);

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
      message: `Import failed: ${errorMessage}`,
    };
  }
}
