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

import { eq } from 'drizzle-orm';
import type {
  JellystatPlaybackActivity,
  JellystatImportProgress,
  JellystatImportResult,
  SourceVideoDetails,
  SourceAudioDetails,
  StreamVideoDetails,
  StreamAudioDetails,
  TranscodeInfo,
  SubtitleInfo,
} from '@tracearr/shared';
import { jellystatBackupSchema } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, sessions } from '../db/schema.js';
import { refreshAggregates } from '../db/timescale.js';
import { geoipService } from './geoip.js';
import type { PubSubService } from './cache.js';
import { JellyfinClient } from './mediaServer/jellyfin/client.js';
import { EmbyClient } from './mediaServer/emby/client.js';
import { normalizeClient } from '../utils/platformNormalizer.js';
import { parseJellystatPlayMethod } from '../utils/transcodeNormalizer.js';
import {
  createUserMapping,
  createSkippedUserTracker,
  queryExistingByExternalIds,
  flushInsertBatch,
  createSimpleProgressPublisher,
} from './import/index.js';

const BATCH_SIZE = 500;
const DEDUP_BATCH_SIZE = 5000;
const ENRICHMENT_BATCH_SIZE = 200;
const PROGRESS_THROTTLE_MS = 2000;
const PROGRESS_RECORD_INTERVAL = 500;
const TICKS_TO_MS = 10000; // 100ns ticks to ms

// parsePlayMethod moved to utils/transcodeNormalizer.ts as parseJellystatPlayMethod

/**
 * Media enrichment data from Jellyfin/Emby API
 */
interface MediaEnrichment {
  seasonNumber?: number;
  episodeNumber?: number;
  year?: number;
  thumbPath?: string;
}

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
      result.sourceVideoCodec = videoStream.Codec?.toUpperCase() ?? null;
      result.sourceVideoWidth = videoStream.Width ?? null;
      result.sourceVideoHeight = videoStream.Height ?? null;

      // Build source video details JSONB
      const videoDetails: SourceVideoDetails = {};
      if (videoStream.BitRate) videoDetails.bitrate = videoStream.BitRate;
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
      result.sourceAudioCodec = audioStream.Codec?.toUpperCase() ?? null;
      result.sourceAudioChannels = audioStream.Channels ?? null;

      // Build source audio details JSONB
      const audioDetails: SourceAudioDetails = {};
      if (audioStream.BitRate) audioDetails.bitrate = audioStream.BitRate;
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
    if (transcodingInfo.VideoCodec) {
      result.streamVideoCodec = transcodingInfo.VideoCodec.toUpperCase();
    }
    if (transcodingInfo.AudioCodec) {
      result.streamAudioCodec = transcodingInfo.AudioCodec.toUpperCase();
    }

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

/**
 * Interface for clients that support getItems (both Jellyfin and Emby)
 */
interface MediaServerClientWithItems {
  getItems(ids: string[]): Promise<
    {
      Id: string;
      ParentIndexNumber?: number;
      IndexNumber?: number;
      ProductionYear?: number;
      ImageTags?: { Primary?: string };
      // Episode series info for poster lookup
      SeriesId?: string;
      SeriesPrimaryImageTag?: string;
    }[]
  >;
}

/**
 * Parse and validate Jellystat backup file
 */
export function parseJellystatBackup(jsonString: string): JellystatPlaybackActivity[] {
  const data: unknown = JSON.parse(jsonString);
  const parsed = jellystatBackupSchema.safeParse(data);

  if (!parsed.success) {
    throw new Error(`Invalid Jellystat backup format: ${parsed.error.message}`);
  }

  // Find the section containing playback activity (position varies in backup files)
  const playbackSection = parsed.data.find(
    (section): section is { jf_playback_activity: JellystatPlaybackActivity[] } =>
      'jf_playback_activity' in section
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
  enrichment?: MediaEnrichment
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
  const totalDurationMs =
    activity.PlayState?.RuntimeTicks != null
      ? Math.floor(activity.PlayState.RuntimeTicks / TICKS_TO_MS)
      : null;

  const mediaType: 'movie' | 'episode' | 'track' = activity.SeriesName ? 'episode' : 'movie';
  const { videoDecision, audioDecision, isTranscode } = parseJellystatPlayMethod(
    activity.PlayMethod
  );

  // Extract stream details from MediaStreams and TranscodingInfo
  // These fields exist in JellyStat backups but aren't typed in the schema (looseObject allows them)
  const activityAny = activity as Record<string, unknown>;
  const mediaStreams = activityAny.MediaStreams as JellystatMediaStream[] | null | undefined;
  const transcodingInfoFull = activityAny.TranscodingInfo as
    | JellystatTranscodingInfoFull
    | null
    | undefined;
  const streamDetails = extractJellystatStreamDetails(mediaStreams, transcodingInfoFull);

  // Bitrate: prefer TranscodingInfo bitrate (in bps), convert to kbps
  // Fall back to source video bitrate if no transcode bitrate
  const bitrate = transcodingInfoFull?.Bitrate
    ? Math.floor(transcodingInfoFull.Bitrate / 1000)
    : streamDetails.sourceVideoDetails?.bitrate
      ? Math.floor(streamDetails.sourceVideoDetails.bitrate / 1000)
      : null;

  return {
    serverId,
    serverUserId,
    sessionKey: activity.Id,
    plexSessionId: null,
    ratingKey: activity.NowPlayingItemId,
    externalSessionId: activity.Id,
    referenceId: null,
    state: 'stopped',
    mediaType,
    mediaTitle: activity.NowPlayingItemName,
    grandparentTitle: activity.SeriesName ?? null,
    seasonNumber: enrichment?.seasonNumber ?? null,
    episodeNumber: enrichment?.episodeNumber ?? null,
    year: enrichment?.year ?? null,
    thumbPath: enrichment?.thumbPath ?? null,
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
    ipAddress: activity.RemoteEndPoint ?? '0.0.0.0',
    geoCity: geo.city,
    geoRegion: geo.region,
    geoCountry: geo.countryCode ?? geo.country,
    geoLat: geo.lat,
    geoLon: geo.lon,
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
 * Batch fetch media enrichment data from Jellyfin/Emby
 */
async function fetchMediaEnrichment(
  client: MediaServerClientWithItems,
  mediaIds: string[]
): Promise<Map<string, MediaEnrichment>> {
  const enrichmentMap = new Map<string, MediaEnrichment>();

  if (mediaIds.length === 0) return enrichmentMap;

  try {
    const items = await client.getItems(mediaIds);

    for (const item of items) {
      if (!item.Id) continue;

      const enrichment: MediaEnrichment = {};

      if (item.ParentIndexNumber != null) {
        enrichment.seasonNumber = item.ParentIndexNumber;
      }
      if (item.IndexNumber != null) {
        enrichment.episodeNumber = item.IndexNumber;
      }
      if (item.ProductionYear != null) {
        enrichment.year = item.ProductionYear;
      }

      // For episodes, use series poster if available (preferred for consistency with live sessions)
      // Fall back to episode's own image if series info is missing
      if (item.SeriesId && item.SeriesPrimaryImageTag) {
        enrichment.thumbPath = `/Items/${item.SeriesId}/Images/Primary`;
      } else if (item.ImageTags?.Primary) {
        enrichment.thumbPath = `/Items/${item.Id}/Images/Primary`;
      }

      if (Object.keys(enrichment).length > 0) {
        enrichmentMap.set(item.Id, enrichment);
      }
    }
  } catch (error) {
    console.warn('[Jellystat] Media enrichment batch failed:', error);
  }

  return enrichmentMap;
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

    const activities = parseJellystatBackup(backupJson);
    progress.totalRecords = activities.length;
    progress.message = `Parsed ${activities.length} records from backup`;
    publishProgress(progress);

    if (activities.length === 0) {
      progress.status = 'complete';
      progress.message = 'No playback activity records found in backup';
      publishProgress(progress);
      return {
        success: true,
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        enriched: 0,
        message: 'No playback activity records found in backup',
      };
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

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    const skippedUserTracker = createSkippedUserTracker();

    for (let chunkStart = 0; chunkStart < activities.length; chunkStart += DEDUP_BATCH_SIZE) {
      const chunk = activities.slice(chunkStart, chunkStart + DEDUP_BATCH_SIZE);

      const chunkIds = chunk.map((a) => a.Id).filter(Boolean);
      const existingMap =
        chunkIds.length > 0 ? await queryExistingByExternalIds(serverId, chunkIds) : new Map();

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

          const ipAddress = activity.RemoteEndPoint ?? '0.0.0.0';
          let geo = geoCache.get(ipAddress);
          if (!geo) {
            geo = geoipService.lookup(ipAddress);
            geoCache.set(ipAddress, geo);
          }

          const enrichment = enrichmentMap.get(activity.NowPlayingItemId);
          const sessionData = transformActivityToSession(
            activity,
            serverId,
            serverUserId,
            geo,
            enrichment
          );
          insertBatch.push(sessionData);

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
      await refreshAggregates();
    } catch (err) {
      console.warn('[Jellystat] Failed to refresh aggregates after import:', err);
    }

    let message = `Import complete: ${imported} imported, ${updated} updated, ${skipped} skipped, ${errors} errors`;
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
      errors: progress.errorRecords,
      enriched: progress.enrichedRecords,
      message: `Import failed: ${errorMessage}`,
    };
  }
}
