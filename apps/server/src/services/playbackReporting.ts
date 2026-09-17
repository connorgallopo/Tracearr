/**
 * Playback Reporting Plugin Import Service
 *
 * Pages the Playback Reporting plugin's SQLite table over its admin SQL
 * endpoint, transforms the rows into sessions, and inserts what Tracearr
 * does not already track.
 */

import type {
  PlaybackReportingImportProgress,
  PlaybackReportingImportResult,
} from '@tracearr/shared';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { batchGetLibraryItemIdentity, type SessionIdentity } from '../jobs/poller/database.js';
import { extractIpFromEndpoint } from '../utils/parsing.js';
import { normalizeClient } from '../utils/platformNormalizer.js';
import { parseJellystatPlayMethod } from '../utils/transcodeNormalizer.js';
import { wallTimeToUtc } from '../utils/wallClock.js';
import { servers, sessions } from '../db/schema.js';
import { checkAggregateNeedsRebuild, refreshAggregates } from '../db/timescale.js';
import { enqueueMaintenanceJob } from '../jobs/maintenanceQueue.js';
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
  type TimeBounds,
} from './import/index.js';
import { EmbyClient } from './mediaServer/emby/client.js';
import { JellyfinClient } from './mediaServer/jellyfin/client.js';
import { parseMediaType } from './mediaServer/shared/jellyfinEmbyUtils.js';
import { getWatchedThresholds, watchedThresholdFor, type WatchedThresholds } from './settings.js';

const PAGE_SIZE = 5000;
const BATCH_SIZE = 500;
const ENRICHMENT_BATCH_SIZE = 200;
const PROGRESS_THROTTLE_MS = 2000;
const AGGREGATE_BUFFER_MS = 24 * 60 * 60 * 1000;

export const BASE_COLUMNS = [
  'DateCreated',
  'UserId',
  'ItemId',
  'ItemType',
  'ItemName',
  'PlaybackMethod',
  'ClientName',
  'DeviceName',
  'PlayDuration',
] as const;

// TranscodeReasons exists on Emby's table but is deliberately unused in v1.
export const OPTIONAL_COLUMNS = ['PauseDuration', 'RemoteAddress'] as const;

export interface PlaybackReportingRow {
  rowid: number;
  dateCreated: string;
  userId: string;
  itemId: string;
  itemType: string;
  itemName: string;
  playbackMethod: string | null;
  clientName: string | null;
  deviceName: string | null;
  playDurationSec: number;
  pauseDurationSec: number;
  remoteAddress: string | null;
}

export function buildSelectColumns(availableColumns: string[]): string[] {
  const availableLower = new Set(availableColumns.map((c) => c.toLowerCase()));

  const missing = BASE_COLUMNS.filter((col) => !availableLower.has(col.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`Playback Reporting table is missing required columns: ${missing.join(', ')}`);
  }

  const optional = OPTIONAL_COLUMNS.filter((col) => availableLower.has(col.toLowerCase()));
  return ['rowid', ...BASE_COLUMNS, ...optional];
}

function clampDuration(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parsePlaybackReportingRows(
  selectColumns: string[],
  results: string[][]
): PlaybackReportingRow[] {
  const indexOf = new Map(selectColumns.map((col, i) => [col.toLowerCase(), i] as const));
  const idx = {
    rowid: indexOf.get('rowid'),
    dateCreated: indexOf.get('datecreated'),
    userId: indexOf.get('userid'),
    itemId: indexOf.get('itemid'),
    itemType: indexOf.get('itemtype'),
    itemName: indexOf.get('itemname'),
    playbackMethod: indexOf.get('playbackmethod'),
    clientName: indexOf.get('clientname'),
    deviceName: indexOf.get('devicename'),
    playDuration: indexOf.get('playduration'),
    pauseDuration: indexOf.get('pauseduration'),
    remoteAddress: indexOf.get('remoteaddress'),
  };

  const rows: PlaybackReportingRow[] = [];
  for (const result of results) {
    const rowid = idx.rowid != null ? Number(result[idx.rowid]) : NaN;
    if (!Number.isFinite(rowid)) continue;

    rows.push({
      rowid,
      dateCreated: (idx.dateCreated != null ? result[idx.dateCreated] : undefined) ?? '',
      userId: (idx.userId != null ? result[idx.userId] : undefined) ?? '',
      itemId: (idx.itemId != null ? result[idx.itemId] : undefined) ?? '',
      itemType: (idx.itemType != null ? result[idx.itemType] : undefined) ?? '',
      itemName: (idx.itemName != null ? result[idx.itemName] : undefined) ?? '',
      playbackMethod: (idx.playbackMethod != null ? result[idx.playbackMethod] : undefined) ?? null,
      clientName: (idx.clientName != null ? result[idx.clientName] : undefined) ?? null,
      deviceName: (idx.deviceName != null ? result[idx.deviceName] : undefined) ?? null,
      playDurationSec: clampDuration(
        idx.playDuration != null ? result[idx.playDuration] : undefined
      ),
      pauseDurationSec: clampDuration(
        idx.pauseDuration != null ? result[idx.pauseDuration] : undefined
      ),
      remoteAddress: (idx.remoteAddress != null ? result[idx.remoteAddress] : undefined) ?? null,
    });
  }

  return rows;
}

const EPISODE_NAME_RE = /^(.+?) - s(\d{1,3})e(\d{1,4}) - (.+)$/i;

export function parseEpisodeItemName(
  name: string
): { series: string; season: number; episode: number; title: string } | null {
  const match = EPISODE_NAME_RE.exec(name);
  if (!match) return null;
  return {
    series: match[1] ?? '',
    season: Number(match[2]),
    episode: Number(match[3]),
    title: match[4] ?? '',
  };
}

export interface TransformContext {
  serverId: string;
  serverType: 'jellyfin' | 'emby';
  serverUserId: string;
  timezone: string;
  geo: ReturnType<typeof geoipService.lookup> & {
    asnNumber?: number | null;
    asnOrganization?: string | null;
  };
  thresholds: WatchedThresholds;
  enrichment?: MediaEnrichment;
  identity?: SessionIdentity;
}

export function transformPlaybackReportingRow(
  row: PlaybackReportingRow,
  ctx: TransformContext
): typeof sessions.$inferInsert {
  const startedAt = wallTimeToUtc(row.dateCreated, ctx.timezone);
  const durationMs = row.playDurationSec * 1000;
  const stoppedAt = new Date(startedAt.getTime() + durationMs);

  const rawType = ctx.enrichment?.itemType ?? row.itemType;
  const mediaType = parseMediaType(rawType);

  let grandparentTitle: string | null = null;
  let mediaTitle = row.itemName;
  let seasonNumber = ctx.enrichment?.seasonNumber ?? null;
  let episodeNumber = ctx.enrichment?.episodeNumber ?? null;
  const parsedEpisode = parseEpisodeItemName(row.itemName);
  if (mediaType === 'episode' && parsedEpisode) {
    grandparentTitle = parsedEpisode.series;
    mediaTitle = parsedEpisode.title;
    seasonNumber ??= parsedEpisode.season;
    episodeNumber ??= parsedEpisode.episode;
  }

  const totalDurationMs = ctx.enrichment?.runtimeMs ?? null;
  const threshold = watchedThresholdFor(ctx.thresholds, mediaType);
  const watched = totalDurationMs != null && durationMs >= totalDurationMs * threshold;

  const { videoDecision, audioDecision, isTranscode } = parseJellystatPlayMethod(
    row.playbackMethod
  );

  const clientName = row.clientName ?? '';
  const deviceName = row.deviceName ?? '';
  const normalized = normalizeClient(clientName, deviceName, ctx.serverType);
  const ipAddress = extractIpFromEndpoint(row.remoteAddress);

  return {
    serverId: ctx.serverId,
    serverUserId: ctx.serverUserId,
    sessionKey: `pr-${row.rowid}`,
    externalSessionId: `pr-${row.rowid}`,
    ratingKey: row.itemId,
    parentRatingKey: ctx.identity?.parentRatingKey ?? null,
    grandparentRatingKey: ctx.identity?.grandparentRatingKey ?? null,
    mediaId: ctx.identity?.mediaId ?? null,
    showMediaId: ctx.identity?.showMediaId ?? null,
    imdbId: ctx.identity?.imdbId ?? null,
    tmdbId: ctx.identity?.tmdbId ?? null,
    tvdbId: ctx.identity?.tvdbId ?? null,
    state: 'stopped',
    mediaType,
    mediaTitle,
    grandparentTitle,
    seasonNumber,
    episodeNumber,
    year: ctx.enrichment?.year ?? null,
    thumbPath: ctx.enrichment?.thumbPath ?? null,
    artistName: mediaType === 'track' ? (ctx.enrichment?.artistName ?? null) : null,
    albumName: mediaType === 'track' ? (ctx.enrichment?.albumName ?? null) : null,
    trackNumber: mediaType === 'track' ? (ctx.enrichment?.trackNumber ?? null) : null,
    discNumber: mediaType === 'track' ? (ctx.enrichment?.discNumber ?? null) : null,
    startedAt,
    lastSeenAt: stoppedAt,
    stoppedAt,
    durationMs,
    totalDurationMs,
    progressMs: totalDurationMs != null ? Math.min(durationMs, totalDurationMs) : durationMs,
    pausedDurationMs: row.pauseDurationSec * 1000,
    watched,
    shortSession: durationMs < 120000,
    ipAddress,
    geoCity: ctx.geo.city,
    geoRegion: ctx.geo.region,
    geoCountry: ctx.geo.countryCode ?? ctx.geo.country,
    geoContinent: ctx.geo.continent,
    geoPostal: ctx.geo.postal,
    geoLat: ctx.geo.lat,
    geoLon: ctx.geo.lon,
    geoAsnNumber: ctx.geo.asnNumber,
    geoAsnOrganization: ctx.geo.asnOrganization,
    playerName: (deviceName || clientName || 'Unknown').slice(0, 255),
    device: normalized.device.slice(0, 255),
    deviceId: null,
    product: clientName.slice(0, 255) || null,
    platform: normalized.platform.slice(0, 100),
    quality: isTranscode ? 'Transcode' : 'Direct',
    isTranscode,
    videoDecision,
    audioDecision,
    bitrate: null,
  };
}

type ImportGeo = TransformContext['geo'];
type PluginClient = JellyfinClient | EmbyClient;

function buildPageQuery(selectColumns: string[], lastRowid: number): string {
  // lastRowid only ever comes from our own Number() parse of a rowid cell, so there is no injection surface.
  return `SELECT ${selectColumns.join(', ')} FROM PlaybackActivity WHERE rowid > ${lastRowid} ORDER BY rowid LIMIT ${PAGE_SIZE}`;
}

/**
 * Earliest session this server tracks outside the Playback Reporting namespaces.
 * Rows at or after it are already covered by live tracking or a Jellystat import.
 */
async function loadTrackedHistoryWatermark(serverId: string): Promise<Date | null> {
  const [row] = await db
    .select({ min: sql<Date | null>`MIN(${sessions.startedAt})` })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        sql`(${sessions.externalSessionId} IS NULL OR ${sessions.externalSessionId} !~ '^(pr-)?[0-9]+$')`
      )
    );

  return row?.min ? new Date(row.min) : null;
}

async function enrichPage(
  client: PluginClient,
  itemIds: string[]
): Promise<Map<string, MediaEnrichment>> {
  const enrichmentMap = new Map<string, MediaEnrichment>();

  for (let i = 0; i < itemIds.length; i += ENRICHMENT_BATCH_SIZE) {
    const batch = await fetchMediaEnrichment(client, itemIds.slice(i, i + ENRICHMENT_BATCH_SIZE));
    for (const [id, data] of batch) {
      enrichmentMap.set(id, data);
    }
  }

  return enrichmentMap;
}

async function refreshImportAggregates(minDate: Date | null, maxDate: Date | null): Promise<void> {
  try {
    if (minDate && maxDate) {
      const startTime = new Date(minDate.getTime() - AGGREGATE_BUFFER_MS);
      const endTime = new Date(maxDate.getTime() + AGGREGATE_BUFFER_MS);
      console.log(
        `[PlaybackReporting] Refreshing aggregates for date range: ${startTime.toISOString()} to ${endTime.toISOString()}`
      );
      await refreshAggregates({ startTime, endTime });
    } else {
      await refreshAggregates();
    }

    const rebuildStatus = await checkAggregateNeedsRebuild();
    if (rebuildStatus.needsRebuild) {
      console.log(
        `[PlaybackReporting] Fresh install detected - queueing safe aggregate rebuild: ${rebuildStatus.reason}`
      );
      try {
        await enqueueMaintenanceJob('full_aggregate_rebuild', 'system');
      } catch {
        console.log(
          '[PlaybackReporting] Could not queue aggregate rebuild (may already be running)'
        );
      }
    }
  } catch (err) {
    console.warn('[PlaybackReporting] Failed to refresh aggregates after import:', err);
  }
}

export async function importPlaybackReporting(
  serverId: string,
  options: { timezone: string; enrichMedia: boolean; importFullRange: boolean },
  pubSubService?: PubSubService
): Promise<PlaybackReportingImportResult> {
  const progress: PlaybackReportingImportProgress = {
    status: 'idle',
    totalRecords: 0,
    fetchedRecords: 0,
    processedRecords: 0,
    importedRecords: 0,
    skippedRecords: 0,
    duplicateRecords: 0,
    unknownUserRecords: 0,
    overlapRecords: 0,
    filteredRecords: 0,
    overlongRecords: 0,
    errorRecords: 0,
    enrichedRecords: 0,
    message: 'Starting import...',
  };

  const publishProgress = createSimpleProgressPublisher<PlaybackReportingImportProgress>(
    pubSubService,
    'import:playbackreporting:progress'
  );
  publishProgress(progress);

  const skippedUserTracker = createSkippedUserTracker();

  try {
    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);

    if (!server) {
      throw new Error(`Server not found: ${serverId}`);
    }

    if (server.type !== 'jellyfin' && server.type !== 'emby') {
      throw new Error(
        `Playback Reporting import only supports Jellyfin/Emby servers, got: ${server.type}`
      );
    }

    const cutoff = server.createdAt;

    const clientConfig = {
      url: server.url,
      token: server.token,
      id: server.id,
      name: server.name,
    };
    const client: PluginClient =
      server.type === 'emby' ? new EmbyClient(clientConfig) : new JellyfinClient(clientConfig);

    progress.status = 'detecting';
    progress.message = 'Checking for the Playback Reporting plugin...';
    publishProgress(progress);

    const info = await client.getPlaybackReportingInfo();
    if (!info.installed) {
      const message = 'Playback Reporting plugin is not installed on this server';
      progress.status = 'error';
      progress.message = message;
      publishProgress(progress);

      return {
        success: false,
        imported: 0,
        skipped: 0,
        duplicates: 0,
        overlap: 0,
        filtered: 0,
        overlong: 0,
        errors: 0,
        enriched: 0,
        message,
      };
    }

    const selectColumns = buildSelectColumns(info.columns);
    progress.totalRecords = info.totalRecords;
    progress.message = `Found ${info.totalRecords} records in the plugin database`;
    publishProgress(progress);

    const userMap = await createUserMapping(serverId);
    const thresholds = await getWatchedThresholds();
    // importFullRange only disables the tracked-history watermark; tracking starts
    // at the server's created_at, so the cutoff still applies.
    const trackedWatermark = options.importFullRange
      ? null
      : await loadTrackedHistoryWatermark(serverId);
    const watermark =
      trackedWatermark && trackedWatermark.getTime() < cutoff.getTime() ? trackedWatermark : cutoff;

    let minImportDate: Date | null = null;
    let maxImportDate: Date | null = null;
    let lastProgressTime = Date.now();
    let lastRowid = 0;

    for (;;) {
      progress.status = 'fetching';
      progress.message = `Fetching records: ${progress.fetchedRecords}/${progress.totalRecords}`;
      publishProgress(progress);

      const results = await client.queryPlaybackReporting(buildPageQuery(selectColumns, lastRowid));
      if (results.length === 0) break;

      const rows = parsePlaybackReportingRows(selectColumns, results);
      const lastRow = rows.at(-1);
      if (!lastRow) break;
      lastRowid = lastRow.rowid;
      progress.fetchedRecords += rows.length;

      const pageRows: { row: PlaybackReportingRow; startedAt: Date }[] = [];
      for (const row of rows) {
        const startedAt = wallTimeToUtc(row.dateCreated, options.timezone);
        if (Number.isNaN(startedAt.getTime())) {
          console.warn(
            `[PlaybackReporting] Unparseable DateCreated on rowid ${row.rowid}: ${row.dateCreated}`
          );
          progress.processedRecords++;
          progress.errorRecords++;
          continue;
        }
        pageRows.push({ row, startedAt });
      }

      if (pageRows.length > 0) {
        const itemIds = [...new Set(pageRows.map(({ row }) => row.itemId))];

        let enrichmentMap = new Map<string, MediaEnrichment>();
        if (options.enrichMedia) {
          progress.status = 'enriching';
          progress.message = `Enriching ${itemIds.length} media items...`;
          publishProgress(progress);

          enrichmentMap = await enrichPage(client, itemIds);
          progress.enrichedRecords += enrichmentMap.size;
        }

        const identityByItemId = await batchGetLibraryItemIdentity(serverId, itemIds);

        const dedupIds = pageRows.flatMap(({ row }) => [`pr-${row.rowid}`, String(row.rowid)]);
        const startTimes = pageRows.map(({ startedAt }) => startedAt.getTime());
        const maxDurationMs = Math.max(...pageRows.map(({ row }) => row.playDurationSec)) * 1000;
        // Rows that reached us through Jellystat are stamped at playback start minus their
        // duration, so the lower bound has to clear the page's longest play.
        const timeBounds: TimeBounds = {
          minTime: new Date(Math.min(...startTimes) - maxDurationMs),
          maxTime: new Date(Math.max(...startTimes)),
        };
        const existing = await queryExistingByExternalIds(serverId, dedupIds, timeBounds);

        progress.status = 'processing';
        const insertBatch: (typeof sessions.$inferInsert)[] = [];
        const geoCache = new Map<string, ImportGeo>();

        for (const { row, startedAt } of pageRows) {
          progress.processedRecords++;

          try {
            const serverUserId = userMap.get(row.userId);
            if (!serverUserId) {
              skippedUserTracker.track(row.userId, null);
              progress.unknownUserRecords++;
              progress.skippedRecords++;
              continue;
            }

            if (existing.has(`pr-${row.rowid}`) || existing.has(String(row.rowid))) {
              progress.duplicateRecords++;
              progress.skippedRecords++;
              continue;
            }

            if (startedAt >= watermark) {
              progress.overlapRecords++;
              progress.skippedRecords++;
              continue;
            }

            const enrichment = enrichmentMap.get(row.itemId);
            if (enrichment?.filtered) {
              progress.filteredRecords++;
              progress.skippedRecords++;
              continue;
            }

            if (exceedsRuntime(row.playDurationSec * 1000, enrichment?.runtimeMs)) {
              progress.overlongRecords++;
              progress.skippedRecords++;
              continue;
            }

            const ipAddress = extractIpFromEndpoint(row.remoteAddress);
            let geo = geoCache.get(ipAddress);
            if (!geo) {
              const baseGeo = geoipService.lookup(ipAddress);
              const asn = geoasnService.lookup(ipAddress);
              geo = { ...baseGeo, asnNumber: asn.number, asnOrganization: asn.organization };
              geoCache.set(ipAddress, geo);
            }

            insertBatch.push(
              transformPlaybackReportingRow(row, {
                serverId,
                serverType: server.type,
                serverUserId,
                timezone: options.timezone,
                geo,
                thresholds,
                enrichment,
                identity: identityByItemId.get(row.itemId),
              })
            );

            if (!minImportDate || startedAt < minImportDate) minImportDate = startedAt;
            if (!maxImportDate || startedAt > maxImportDate) maxImportDate = startedAt;

            progress.importedRecords++;
          } catch (error) {
            console.error('[PlaybackReporting] Error processing rowid', row.rowid, error);
            progress.errorRecords++;
          }

          const now = Date.now();
          if (now - lastProgressTime > PROGRESS_THROTTLE_MS) {
            progress.message = `Processing: ${progress.processedRecords}/${progress.totalRecords}`;
            publishProgress(progress);
            lastProgressTime = now;
          }
        }

        if (insertBatch.length > 0) {
          await flushInsertBatch(insertBatch, { chunkSize: BATCH_SIZE });
        }
      }

      if (results.length < PAGE_SIZE) break;
    }

    progress.status = 'processing';
    progress.message = 'Refreshing aggregates...';
    publishProgress(progress);
    await refreshImportAggregates(minImportDate, maxImportDate);

    let message =
      `Import complete: ${progress.importedRecords} imported, ` +
      `${progress.duplicateRecords} duplicates skipped, ` +
      `${progress.overlapRecords} overlapping tracked history, ` +
      `${progress.unknownUserRecords} unknown user, ` +
      `${progress.filteredRecords} filtered, ` +
      `${progress.overlongRecords} longer than the media runtime, ${progress.errorRecords} errors`;

    const skippedUsersWarning = skippedUserTracker.formatWarning();
    if (skippedUsersWarning) {
      message += `. Warning: ${skippedUsersWarning}`;
      console.warn(
        `[PlaybackReporting] Import skipped users: ${skippedUserTracker
          .getAll()
          .map((u) => `${u.username ?? 'Unknown'}(${u.externalId})`)
          .join(', ')}`
      );
    }

    progress.status = 'complete';
    progress.message = message;
    publishProgress(progress);

    return {
      success: true,
      imported: progress.importedRecords,
      skipped: progress.skippedRecords,
      duplicates: progress.duplicateRecords,
      overlap: progress.overlapRecords,
      filtered: progress.filteredRecords,
      overlong: progress.overlongRecords,
      errors: progress.errorRecords,
      enriched: progress.enrichedRecords,
      message,
      skippedUsers:
        skippedUserTracker.size > 0
          ? skippedUserTracker.getAll().map((u) => ({
              userId: u.externalId,
              username: u.username,
              recordCount: u.count,
            }))
          : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[PlaybackReporting] Import failed:', error);

    progress.status = 'error';
    progress.message = `Import failed: ${errorMessage}`;
    publishProgress(progress);

    return {
      success: false,
      imported: progress.importedRecords,
      skipped: progress.skippedRecords,
      duplicates: progress.duplicateRecords,
      overlap: progress.overlapRecords,
      filtered: progress.filteredRecords,
      overlong: progress.overlongRecords,
      errors: progress.errorRecords,
      enriched: progress.enrichedRecords,
      message: `Import failed: ${errorMessage}`,
    };
  }
}
