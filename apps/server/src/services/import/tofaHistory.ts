/**
 * tofa Watch History Import Service
 *
 * Pages tofa's own record of finished plays from the newest back to the oldest and inserts
 * the plays Tracearr did not capture itself.
 */

import { SESSION_LIMITS, type TofaImportProgress, type TofaImportResult } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import { batchGetLibraryItemIdentity, type SessionIdentity } from '../../jobs/poller/database.js';
import { enqueueServerLocationSyncIfBehind } from '../../jobs/maintenanceQueue.js';
import { normalizeClient } from '../../utils/platformNormalizer.js';
import type { PubSubService } from '../cache.js';
import { geoasnService } from '../geoasn.js';
import { geoipService } from '../geoip.js';
import { serverWatchedThreshold } from '../mediaServer/byServerType.js';
import {
  parseProfileNaming,
  playMethodDecisions,
  tofaPosterPath,
} from '../mediaServer/tofa/parser.js';
import type { TofaWatchHistoryRow } from '../mediaServer/tofa/types.js';
import { profileIdOf, profileSightings, resolveProfiles } from '../profiles.js';
import { markImportedServerLocations } from '../serverLocations.js';
import { refreshImportAggregates } from './aggregates.js';
import { flushInsertBatch } from './batchProcessor.js';
import { importIdentityByKey } from './libraryKeyMatch.js';
import { createSimpleProgressPublisher } from './progressTracker.js';
import { historyServer, playsOf, watchHistoryPages } from './tofaWatchHistory.js';
import { createSkippedUserTracker, createUserMapping, syncImportUsers } from './userMapping.js';

type ImportGeo = ReturnType<typeof geoipService.lookup> & {
  asnNumber: number | null;
  asnOrganization: string | null;
};

interface TofaHistoryContext {
  serverId: string;
  serverUserId: string;
  /** The server's watched threshold for the row's media type */
  threshold: number;
  geo: ImportGeo;
  identity?: SessionIdentity;
  profileName: string | null;
  profileId: string | null;
}

/** An episode plays under the episode's id, everything else under the media's */
function historyItem(row: TofaWatchHistoryRow): {
  ratingKey: string | null;
  mediaType: 'movie' | 'episode' | 'unknown';
} {
  switch (row.media_type) {
    case 'tv':
      return { ratingKey: row.episode_id ?? null, mediaType: 'episode' };
    case 'movie':
      return { ratingKey: row.media_id ?? null, mediaType: 'movie' };
    default:
      return { ratingKey: row.media_id ?? null, mediaType: 'unknown' };
  }
}

/**
 * A finished play as a stopped session. Time watched is the span from start to end: tofa's
 * own seconds_watched undercounts wall time and is not used. tofa keeps no pause total, so that
 * span can hold a long pause, and a play counts as watched by its final position against the
 * server's rule.
 */
function transformTofaHistoryRow(
  row: TofaWatchHistoryRow,
  endedAt: Date,
  ctx: TofaHistoryContext
): typeof sessions.$inferInsert {
  const startedAt = new Date(row.started_at);
  const durationMs = Math.max(endedAt.getTime() - startedAt.getTime(), 0);
  const { ratingKey, mediaType } = historyItem(row);
  const mediaTitle = mediaType === 'episode' ? (row.episode_title ?? row.title) : row.title;
  const identity = importIdentityByKey(ctx.identity, { mediaType, title: mediaTitle, year: null });
  const totalDurationMs = row.duration_ms ?? null;
  const { videoDecision, audioDecision, isTranscode } = playMethodDecisions(row.play_method);
  const clientName = row.client_name ?? '';
  const normalized = normalizeClient(
    clientName || (row.platform ?? ''),
    row.device_model ?? '',
    'tofa'
  );
  const ipAddress = row.client_ip ?? '';

  return {
    serverId: ctx.serverId,
    serverUserId: ctx.serverUserId,
    // The imported form importDuplicateCleanup recognizes; a later import skips it by the history id
    sessionKey: `tofa-${row.id}`,
    externalSessionId: row.id,
    ratingKey,
    parentRatingKey: identity?.parentRatingKey ?? null,
    grandparentRatingKey: identity?.grandparentRatingKey ?? null,
    mediaId: identity?.mediaId ?? null,
    showMediaId: identity?.showMediaId ?? null,
    imdbId: identity?.imdbId ?? null,
    tmdbId: identity?.tmdbId ?? null,
    tvdbId: identity?.tvdbId ?? null,
    state: 'stopped',
    mediaType,
    mediaTitle,
    grandparentTitle: mediaType === 'episode' ? row.title : null,
    seasonNumber: row.season_number ?? null,
    episodeNumber: row.episode_number ?? null,
    year: identity?.itemYear ?? null,
    thumbPath: row.media_id ? tofaPosterPath(row.media_id) : null,
    startedAt,
    lastSeenAt: endedAt,
    stoppedAt: endedAt,
    durationMs,
    totalDurationMs,
    progressMs: row.position_ms,
    pausedDurationMs: 0,
    watched: totalDurationMs !== null && row.position_ms / totalDurationMs >= ctx.threshold,
    shortSession: durationMs < SESSION_LIMITS.MIN_PLAY_TIME_MS,
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
    isLocal: ipAddress ? geoipService.isPrivateIP(ipAddress) : null,
    profileName: ctx.profileName,
    profileId: ctx.profileId,
    playerName: (row.device_name ?? clientName).slice(0, 255) || null,
    device: normalized.device.slice(0, 255),
    deviceId: row.device_id ?? null,
    product: clientName.slice(0, 255) || null,
    platform: normalized.platform.slice(0, 100),
    quality: isTranscode ? 'Transcode' : 'Direct',
    isTranscode,
    videoDecision,
    audioDecision,
    bitrate: null,
  };
}

async function knownPlays(serverId: string, rows: TofaWatchHistoryRow[]): Promise<Set<string>> {
  const found = await db
    .select({ sessionKey: sessions.sessionKey, externalSessionId: sessions.externalSessionId })
    .from(sessions)
    .where(playsOf(serverId, rows));
  return new Set(
    found.flatMap((s) =>
      s.externalSessionId ? [s.sessionKey, s.externalSessionId] : [s.sessionKey]
    )
  );
}

/** Syncs the server's users first, so the import never relies on a sync that ran before it. */
export async function importTofaHistory(
  serverId: string,
  pubSubService?: PubSubService,
  onProgress?: (progress: TofaImportProgress) => Promise<void>
): Promise<TofaImportResult> {
  const progress: TofaImportProgress = {
    serverId,
    status: 'idle',
    fetchedRecords: 0,
    processedRecords: 0,
    importedRecords: 0,
    skippedRecords: 0,
    duplicateRecords: 0,
    unknownUserRecords: 0,
    activeRecords: 0,
    errorRecords: 0,
    message: 'Starting import...',
  };
  const publishProgress = createSimpleProgressPublisher<TofaImportProgress>(
    pubSubService,
    'import:tofa:progress',
    onProgress
  );
  publishProgress(progress);
  const skippedUserTracker = createSkippedUserTracker();

  const { server, client } = await historyServer(serverId);

  await syncImportUsers(serverId);

  const userMap = await createUserMapping(serverId);
  const thresholds = new Map<string, Promise<number>>();
  const geoCache = new Map<string, ImportGeo>();
  let minImportDate: Date | null = null;
  let maxImportDate: Date | null = null;
  const publishFetching = () => {
    progress.status = 'fetching';
    progress.message = `Fetching plays: ${progress.fetchedRecords} so far`;
    publishProgress(progress);
  };

  for await (const items of watchHistoryPages(client, publishFetching)) {
    progress.fetchedRecords += items.length;

    progress.status = 'processing';
    const known = await knownPlays(serverId, items);
    const identityByKey = await batchGetLibraryItemIdentity(
      serverId,
      items.flatMap((row) => historyItem(row).ratingKey ?? [])
    );
    const profiles = await resolveProfiles(
      serverId,
      profileSightings(items.map(parseProfileNaming), (accountId) => userMap.get(accountId)),
      'insertMissing'
    );
    const insertBatch: (typeof sessions.$inferInsert)[] = [];

    for (const row of items) {
      progress.processedRecords++;
      try {
        const serverUserId = userMap.get(row.user_id);
        if (!serverUserId) {
          skippedUserTracker.track(row.user_id, row.username);
          progress.unknownUserRecords++;
          progress.skippedRecords++;
          continue;
        }
        if (known.has(row.id) || (row.session_id && known.has(row.session_id))) {
          progress.duplicateRecords++;
          progress.skippedRecords++;
          continue;
        }
        if (!row.ended_at) {
          progress.activeRecords++;
          progress.skippedRecords++;
          continue;
        }

        const { ratingKey, mediaType } = historyItem(row);
        const ip = row.client_ip ?? '';
        const geo = geoCache.getOrInsertComputed(ip, () => {
          const asn = geoasnService.lookup(ip);
          return {
            ...geoipService.lookup(ip),
            asnNumber: asn.number,
            asnOrganization: asn.organization,
          };
        });
        const endedAt = new Date(row.ended_at);
        insertBatch.push(
          transformTofaHistoryRow(row, endedAt, {
            serverId,
            serverUserId,
            threshold: await thresholds.getOrInsertComputed(mediaType, (type) =>
              serverWatchedThreshold(server, type)
            ),
            geo,
            identity: ratingKey ? identityByKey.get(ratingKey) : undefined,
            profileName: row.profile_name ?? null,
            profileId: profileIdOf(profiles, row.profile_id),
          })
        );

        const startedAt = new Date(row.started_at);
        if (!minImportDate || startedAt < minImportDate) minImportDate = startedAt;
        if (!maxImportDate || startedAt > maxImportDate) maxImportDate = startedAt;
        progress.importedRecords++;
      } catch (error) {
        console.error('[TofaHistory] Error processing play', row.id, error);
        progress.errorRecords++;
      }
    }

    await flushInsertBatch(insertBatch);
    progress.message = `Processing: ${progress.processedRecords} plays`;
    publishProgress(progress);
  }

  progress.message = 'Refreshing aggregates...';
  publishProgress(progress);
  await refreshImportAggregates('TofaHistory', minImportDate, maxImportDate);
  try {
    await markImportedServerLocations(serverId);
    await enqueueServerLocationSyncIfBehind();
  } catch (err) {
    console.error('[TofaHistory] Could not queue the server location sync:', err);
  }

  let message =
    `Import complete: ${progress.importedRecords} imported, ` +
    `${progress.duplicateRecords} already in Tracearr, ` +
    `${progress.unknownUserRecords} unknown user, ` +
    `${progress.activeRecords} still playing, ${progress.errorRecords} errors`;
  const skippedUsersWarning = skippedUserTracker.formatWarning();
  if (skippedUsersWarning) message += `. Warning: ${skippedUsersWarning}`;

  progress.status = 'complete';
  progress.message = message;
  publishProgress(progress);

  return {
    success: true,
    imported: progress.importedRecords,
    skipped: progress.skippedRecords,
    duplicates: progress.duplicateRecords,
    errors: progress.errorRecords,
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
}
