/**
 * tofa Watch History Import Service
 *
 * Pages tofa's own record of finished plays from the newest back to the oldest and inserts
 * the plays Tracearr did not capture itself.
 */

import {
  SERVER_PROFILES,
  SESSION_LIMITS,
  type TofaImportProgress,
  type TofaImportResult,
} from '@tracearr/shared';
import { UnrecoverableError } from 'bullmq';
import { and, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { servers, sessions } from '../../db/schema.js';
import { batchGetLibraryItemIdentity, type SessionIdentity } from '../../jobs/poller/database.js';
import { enqueueServerLocationSyncIfBehind } from '../../jobs/maintenanceQueue.js';
import { normalizeClient } from '../../utils/platformNormalizer.js';
import type { PubSubService } from '../cache.js';
import { geoasnService } from '../geoasn.js';
import { geoipService } from '../geoip.js';
import { ServerHistoricalError } from '../liveServers.js';
import { serverWatchedThreshold } from '../mediaServer/byServerType.js';
import { TofaClient } from '../mediaServer/tofa/client.js';
import { playMethodDecisions, tofaPosterPath } from '../mediaServer/tofa/parser.js';
import type { TofaWatchHistoryRow } from '../mediaServer/tofa/types.js';
import { markImportedServerLocations } from '../serverLocations.js';
import { refreshImportAggregates } from './aggregates.js';
import { flushInsertBatch } from './batchProcessor.js';
import { importIdentityByKey } from './libraryKeyMatch.js';
import { createSimpleProgressPublisher } from './progressTracker.js';
import { createSkippedUserTracker, createUserMapping, syncImportUsers } from './userMapping.js';

const PAGE_SIZE = 200;
// A play Tracearr captured starts within moments of tofa's record of it
const CAPTURED_START_SLACK_MS = 24 * 60 * 60 * 1000;

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

/**
 * The keys of the page's plays already in Tracearr: a play it captured carries tofa's session
 * id as its session key, and a play an earlier import brought in carries the history id.
 */
async function knownPlays(serverId: string, rows: TofaWatchHistoryRow[]): Promise<Set<string>> {
  const sessionIds = rows.flatMap((row) => (row.session_id ? [row.session_id] : []));
  const starts = rows.map((row) => Date.parse(row.started_at));
  const found = await db
    .select({ sessionKey: sessions.sessionKey, externalSessionId: sessions.externalSessionId })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        gte(sessions.startedAt, new Date(Math.min(...starts) - CAPTURED_START_SLACK_MS)),
        lte(sessions.startedAt, new Date(Math.max(...starts) + CAPTURED_START_SLACK_MS)),
        or(
          inArray(
            sessions.externalSessionId,
            rows.map((row) => row.id)
          ),
          sessionIds.length > 0 ? inArray(sessions.sessionKey, sessionIds) : undefined
        )
      )
    );
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

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) throw new UnrecoverableError(`Server not found: ${serverId}`);
  if (server.historicalAt) throw new ServerHistoricalError(serverId);
  if (SERVER_PROFILES[server.type].serverHistoryImport !== 'tofa') {
    throw new UnrecoverableError(
      `${server.type} servers keep no watch history of their own to import`
    );
  }

  await syncImportUsers(serverId);

  const client = new TofaClient({ url: server.url, token: server.token, id: server.id });
  const userMap = await createUserMapping(serverId);
  const thresholds = new Map<string, Promise<number>>();
  const geoCache = new Map<string, ImportGeo>();
  let minImportDate: Date | null = null;
  let maxImportDate: Date | null = null;
  let before: string | null = null;
  let lastPage = new Set<string>();

  for (;;) {
    progress.status = 'fetching';
    progress.message = `Fetching plays: ${progress.fetchedRecords} so far`;
    publishProgress(progress);

    const page = await client.getWatchHistoryPage(before, PAGE_SIZE);
    const oldest = page.items.at(-1);
    const items = page.items.filter((row) => !lastPage.has(row.id));
    if (!oldest) break;
    if (items.length === 0) {
      // tofa pages history by start time alone, so a page of plays that all started in one
      // millisecond cannot be paged past
      console.warn(
        '[TofaHistory] Stopped before the oldest plays: a full page started at',
        oldest.started_at
      );
      break;
    }
    progress.fetchedRecords += items.length;

    progress.status = 'processing';
    const known = await knownPlays(serverId, items);
    const identityByKey = await batchGetLibraryItemIdentity(
      serverId,
      items.flatMap((row) => historyItem(row).ratingKey ?? [])
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

    if (!page.has_more) break;
    // Plays can share a start time, and tofa takes no tie-breaker, so the next page starts just
    // after the oldest play and the plays this page already held are left out of it
    lastPage = new Set(page.items.map((row) => row.id));
    before = new Date(Date.parse(oldest.started_at) + 1).toISOString();
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
