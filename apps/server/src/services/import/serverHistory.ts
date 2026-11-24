/**
 * Server History Import
 *
 * Pages a server's own record of plays and inserts the plays Tracearr did not capture itself.
 * Each server supplies its history as a ServerHistory: its pages, what the import reads from a
 * row, and the session a row becomes.
 */

import {
  SERVER_PROFILES,
  WS_EVENTS,
  type ServerHistoryImporter,
  type ServerHistoryImportProgress,
  type ServerHistoryImportResult,
} from '@tracearr/shared';
import { UnrecoverableError } from 'bullmq';
import { and, eq, gte, inArray, lte, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { servers, sessions } from '../../db/schema.js';
import { batchGetLibraryItemIdentity, type SessionIdentity } from '../../jobs/poller/database.js';
import { enqueueServerLocationSyncIfBehind } from '../../jobs/maintenanceQueue.js';
import type { PubSubService } from '../cache.js';
import { geoasnService } from '../geoasn.js';
import { geoipService } from '../geoip.js';
import { ServerHistoricalError } from '../liveServers.js';
import { serverWatchedThreshold } from '../mediaServer/byServerType.js';
import {
  profileIdOf,
  profileSightings,
  resolveProfiles,
  storedProfileIds,
  type ProfileNaming,
} from '../profiles.js';
import { markImportedServerLocations } from '../serverLocations.js';
import { refreshImportAggregates } from './aggregates.js';
import { flushInsertBatch } from './batchProcessor.js';
import { createSimpleProgressPublisher } from './progressTracker.js';
import { createSkippedUserTracker, createUserMapping, syncImportUsers } from './userMapping.js';

// A play Tracearr captured starts within moments of the server's record of it
export const CAPTURED_START_SLACK_MS = 24 * 60 * 60 * 1000;

export type ImportGeo = ReturnType<typeof geoipService.lookup> & {
  asnNumber: number | null;
  asnOrganization: string | null;
};

/** What the import reads from one row of a server's own history */
export interface HistoryPlay {
  /** An imported play keeps it as externalSessionId, and a later import skips the row by it */
  historyId: string;
  /** The live session the row records, which a play Tracearr captured keeps as its sessionKey */
  sessionId: string | null;
  accountId: string;
  username: string | null;
  profile: ProfileNaming;
  ratingKey: string | null;
  mediaType: 'movie' | 'episode' | 'unknown';
  startedAt: Date;
  /** Null while the play still runs */
  endedAt: Date | null;
  ipAddress: string;
}

export interface HistoryPlayContext {
  serverId: string;
  serverUserId: string;
  /** Tracearr's or the server's watched threshold for the play's media type */
  threshold: number;
  geo: ImportGeo;
  identity?: SessionIdentity;
  profileId: string | null;
}

/** One server's own watch history as the import reads it */
export interface ServerHistory<Row> {
  server: typeof servers.$inferSelect;
  /** Names the importer in logs and in the aggregate refresh */
  label: string;
  pages(beforeFetch: () => void): AsyncIterable<Row[]>;
  /** Must not throw: it runs on every row before the per-row guard, so a throw fails the import */
  play(row: Row): HistoryPlay;
  toSession(
    row: Row,
    play: HistoryPlay,
    endedAt: Date,
    ctx: HistoryPlayContext
  ): typeof sessions.$inferInsert;
}

/** The server's row, refused when it is gone, historical, or keeps no history this importer reads */
export async function historyServerRow(
  serverId: string,
  importer: ServerHistoryImporter
): Promise<typeof servers.$inferSelect> {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) throw new UnrecoverableError(`Server not found: ${serverId}`);
  if (server.historicalAt) throw new ServerHistoricalError(serverId);
  if (SERVER_PROFILES[server.type].serverHistoryImport !== importer) {
    throw new UnrecoverableError(
      `${server.type} servers keep no watch history of their own to import`
    );
  }
  return server;
}

/** The plays in Tracearr that history rows record: captured ones by session id as sessionKey, imported ones by history id */
export function historyPlaysOf(
  serverId: string,
  plays: readonly Pick<HistoryPlay, 'historyId' | 'sessionId' | 'startedAt'>[]
): SQL | undefined {
  const sessionIds = plays.flatMap((play) => (play.sessionId ? [play.sessionId] : []));
  const starts = plays.map((play) => play.startedAt.getTime());
  return and(
    eq(sessions.serverId, serverId),
    gte(sessions.startedAt, new Date(Math.min(...starts) - CAPTURED_START_SLACK_MS)),
    lte(sessions.startedAt, new Date(Math.max(...starts) + CAPTURED_START_SLACK_MS)),
    or(
      inArray(
        sessions.externalSessionId,
        plays.map((play) => play.historyId)
      ),
      sessionIds.length > 0 ? inArray(sessions.sessionKey, sessionIds) : undefined
    )
  );
}

async function knownPlays(serverId: string, plays: readonly HistoryPlay[]): Promise<Set<string>> {
  const found = await db
    .select({ sessionKey: sessions.sessionKey, externalSessionId: sessions.externalSessionId })
    .from(sessions)
    .where(historyPlaysOf(serverId, plays));
  return new Set(
    found.flatMap((s) =>
      s.externalSessionId ? [s.sessionKey, s.externalSessionId] : [s.sessionKey]
    )
  );
}

/** Syncs the server's users first, so the import never relies on a sync that ran before it. */
export async function importServerHistory<Row>(
  serverId: string,
  open: () => Promise<ServerHistory<Row>>,
  pubSubService?: PubSubService,
  onProgress?: (progress: ServerHistoryImportProgress) => Promise<void>
): Promise<ServerHistoryImportResult> {
  const progress: ServerHistoryImportProgress = {
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
  const publishProgress = createSimpleProgressPublisher<ServerHistoryImportProgress>(
    pubSubService,
    WS_EVENTS.IMPORT_SERVER_HISTORY_PROGRESS,
    onProgress
  );
  publishProgress(progress);
  const skippedUserTracker = createSkippedUserTracker();

  const history = await open();
  const { server } = history;

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

  for await (const items of history.pages(publishFetching)) {
    progress.fetchedRecords += items.length;

    progress.status = 'processing';
    const entries = items.map((row) => ({ row, play: history.play(row) }));
    const plays = entries.map((entry) => entry.play);
    const known = await knownPlays(serverId, plays);
    const identityByKey = await batchGetLibraryItemIdentity(
      serverId,
      plays.flatMap((play) => play.ratingKey ?? [])
    );
    const profiles = await resolveProfiles(
      serverId,
      profileSightings(
        plays.map((play) => play.profile),
        (accountId) => userMap.get(accountId)
      ),
      'insertMissing'
    );
    // A profile the row names by id alone is linked to the profile stored under that id, never inserted under it
    const stored = await storedProfileIds(serverId, [
      ...new Set(
        plays.flatMap(({ profile }) =>
          profile.profileExternalId &&
          !profile.profileName &&
          !profiles.has(profile.profileExternalId)
            ? [profile.profileExternalId]
            : []
        )
      ),
    ]);
    const insertBatch: (typeof sessions.$inferInsert)[] = [];

    for (const { row, play } of entries) {
      progress.processedRecords++;
      try {
        const serverUserId = userMap.get(play.accountId);
        if (!serverUserId) {
          skippedUserTracker.track(play.accountId, play.username);
          progress.unknownUserRecords++;
          progress.skippedRecords++;
          continue;
        }
        if (known.has(play.historyId) || (play.sessionId !== null && known.has(play.sessionId))) {
          progress.duplicateRecords++;
          progress.skippedRecords++;
          continue;
        }
        if (play.endedAt === null) {
          progress.activeRecords++;
          progress.skippedRecords++;
          continue;
        }

        const ip = play.ipAddress;
        const geo = geoCache.getOrInsertComputed(ip, () => {
          const asn = geoasnService.lookup(ip);
          return {
            ...geoipService.lookup(ip),
            asnNumber: asn.number,
            asnOrganization: asn.organization,
          };
        });
        const endedAt = play.endedAt;
        insertBatch.push(
          history.toSession(row, play, endedAt, {
            serverId,
            serverUserId,
            threshold: await thresholds.getOrInsertComputed(play.mediaType, (type) =>
              serverWatchedThreshold(server, type)
            ),
            geo,
            identity: play.ratingKey ? identityByKey.get(play.ratingKey) : undefined,
            profileId:
              profileIdOf(profiles, play.profile.profileExternalId) ??
              (play.profile.profileExternalId
                ? (stored.get(play.profile.profileExternalId) ?? null)
                : null),
          })
        );

        const startedAt = play.startedAt;
        if (!minImportDate || startedAt < minImportDate) minImportDate = startedAt;
        if (!maxImportDate || startedAt > maxImportDate) maxImportDate = startedAt;
        progress.importedRecords++;
      } catch (error) {
        console.error(`[${history.label}] Error processing play`, play.historyId, error);
        progress.errorRecords++;
      }
    }

    await flushInsertBatch(insertBatch);
    progress.message = `Processing: ${progress.processedRecords} plays`;
    publishProgress(progress);
  }

  progress.message = 'Refreshing aggregates...';
  publishProgress(progress);
  await refreshImportAggregates(history.label, minImportDate, maxImportDate);
  try {
    await markImportedServerLocations(serverId);
    await enqueueServerLocationSyncIfBehind();
  } catch (err) {
    console.error(`[${history.label}] Could not queue the server location sync:`, err);
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
