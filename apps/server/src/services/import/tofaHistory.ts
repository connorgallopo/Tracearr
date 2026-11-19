/**
 * tofa Watch History Import Service
 *
 * Pages tofa's own record of finished plays from the newest back to the oldest and inserts
 * the plays Tracearr did not capture itself. The same record links plays stored without a
 * profile to the profile that played them.
 */

import {
  SERVER_PROFILES,
  SESSION_LIMITS,
  type TofaImportProgress,
  type TofaImportResult,
} from '@tracearr/shared';
import { UnrecoverableError } from 'bullmq';
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { serverProfiles, servers, sessions } from '../../db/schema.js';
import { getSessionChunkRanges, uncapDecompressionForTx } from '../../db/timescale.js';
import {
  batchGetLibraryItemIdentity,
  getServerUserIdsByExternalId,
  type SessionIdentity,
} from '../../jobs/poller/database.js';
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
import { profileIdOf, profileSightings, resolveProfiles } from '../profiles.js';
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

/**
 * The plays in Tracearr that history rows record: a play it captured carries tofa's session id
 * as its session key, and a play an earlier import brought in carries the history id.
 */
function playsOf(serverId: string, rows: TofaWatchHistoryRow[]): SQL | undefined {
  const sessionIds = rows.flatMap((row) => (row.session_id ? [row.session_id] : []));
  const starts = rows.map((row) => Date.parse(row.started_at));
  return and(
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
  );
}

/** The keys of the page's plays already in Tracearr */
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

async function historyServer(serverId: string) {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) throw new UnrecoverableError(`Server not found: ${serverId}`);
  if (server.historicalAt) throw new ServerHistoricalError(serverId);
  if (SERVER_PROFILES[server.type].serverHistoryImport !== 'tofa') {
    throw new UnrecoverableError(
      `${server.type} servers keep no watch history of their own to import`
    );
  }
  return {
    server,
    client: new TofaClient({ url: server.url, token: server.token, id: server.id }),
  };
}

/**
 * tofa's history from the newest play back to the oldest, a page at a time, each play once.
 * tofa pages by start time alone and takes no tie-breaker, so each page starts just after the
 * oldest play of the last and leaves out the plays that page already held.
 */
async function* watchHistoryPages(
  client: TofaClient,
  beforeFetch?: () => void
): AsyncGenerator<TofaWatchHistoryRow[]> {
  let before: string | null = null;
  let lastPage = new Set<string>();
  for (;;) {
    beforeFetch?.();
    const page = await client.getWatchHistoryPage(before, PAGE_SIZE);
    const oldest = page.items.at(-1);
    const items = page.items.filter((row) => !lastPage.has(row.id));
    if (!oldest) return;
    if (items.length === 0) {
      // A page of plays that all started in one millisecond cannot be paged past
      console.warn(
        '[TofaHistory] Stopped before the oldest plays: a full page started at',
        oldest.started_at
      );
      return;
    }
    yield items;
    if (!page.has_more) return;
    lastPage = new Set(page.items.map((row) => row.id));
    before = new Date(Date.parse(oldest.started_at) + 1).toISOString();
  }
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
    const profileIds = await resolveProfiles(
      serverId,
      profileSightings(items, userMap),
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
            profileId: profileIdOf(profileIds, row),
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

/**
 * Links a server's plays stored without a profile to the profile that played them: by the
 * history row that records each play, then, for plays tofa no longer lists, by a stored profile
 * name that only one of the account's profiles has. Profiles the history names that tofa no
 * longer lists are added marked removed, so their plays link too. Paging stops at the oldest
 * unlinked play, so a profile named only on history pages older than that is not stored.
 * Returns the plays linked.
 */
export async function linkTofaPlayProfiles(
  serverId: string,
  onBatch: (linked: number) => Promise<void>
): Promise<number> {
  const { client } = await historyServer(serverId);
  const [oldestUnlinked] = await db
    .select({ startedAt: sessions.startedAt })
    .from(sessions)
    .where(and(eq(sessions.serverId, serverId), isNull(sessions.profileId)))
    .orderBy(asc(sessions.startedAt))
    .limit(1);
  if (!oldestUnlinked) return 0;

  let linked = 0;
  for await (const rows of watchHistoryPages(client)) {
    const newest = Math.max(...rows.map((row) => Date.parse(row.started_at)));
    if (newest + CAPTURED_START_SLACK_MS < oldestUnlinked.startedAt.getTime()) break;
    // Through merge aliases too: a folded account's plays sit on the account it was folded into
    const accountOf = await getServerUserIdsByExternalId(
      serverId,
      rows.map((row) => row.user_id)
    );
    const profileIds = await resolveProfiles(
      serverId,
      profileSightings(rows, accountOf),
      'insertRemoved'
    );
    const plays = rows.flatMap((row) => {
      const profileId = profileIdOf(profileIds, row);
      const serverUserId = accountOf.get(row.user_id);
      return profileId && serverUserId ? [{ row, profileId, serverUserId }] : [];
    });
    linked += await db.transaction(async (tx) => {
      await uncapDecompressionForTx(tx);
      let written = 0;
      for (const [profileId, played] of Map.groupBy(plays, (play) => play.profileId)) {
        const { rowCount } = await tx
          .update(sessions)
          .set({ profileId })
          .where(
            and(
              playsOf(
                serverId,
                played.map((play) => play.row)
              ),
              inArray(sessions.serverUserId, [...new Set(played.map((play) => play.serverUserId))]),
              isNull(sessions.profileId)
            )
          );
        written += rowCount ?? 0;
      }
      return written;
    });
    await onBatch(linked);
  }

  const uniqueNames = db
    .select({
      id: sql<string>`(array_agg(${serverProfiles.id}))[1]`.as('named_profile_id'),
      serverUserId: serverProfiles.serverUserId,
      name: serverProfiles.name,
    })
    .from(serverProfiles)
    .where(eq(serverProfiles.serverId, serverId))
    .groupBy(serverProfiles.serverUserId, serverProfiles.name)
    .having(sql`count(*) = 1`)
    .as('unique_names');
  // A chunk at a time, so no statement decompresses more than one chunk of the server's plays
  const chunks = await getSessionChunkRanges();
  const windows =
    chunks.length > 0 ? chunks.filter((chunk) => chunk.end > oldestUnlinked.startedAt) : [null];
  for (const window of windows) {
    linked += await db.transaction(async (tx) => {
      await uncapDecompressionForTx(tx);
      const { rowCount } = await tx
        .update(sessions)
        .set({ profileId: sql`${uniqueNames.id}` })
        .from(uniqueNames)
        .where(
          and(
            eq(sessions.serverId, serverId),
            isNull(sessions.profileId),
            eq(sessions.serverUserId, uniqueNames.serverUserId),
            eq(sessions.profileName, uniqueNames.name),
            ...(window
              ? [gte(sessions.startedAt, window.start), lt(sessions.startedAt, window.end)]
              : [])
          )
        );
      return rowCount ?? 0;
    });
    await onBatch(linked);
  }
  return linked;
}
