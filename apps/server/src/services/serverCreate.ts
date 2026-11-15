import { assertNever, pickServerColor, SERVER_PROFILES, type ServerType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, serverUsers } from '../db/schema.js';
import { holdTofaImport } from '../jobs/importQueue.js';
import { publishServersChanged } from '../jobs/poller/database.js';
import {
  enqueueLibrarySync,
  markFirstSyncOwed,
  rebuildAutoSyncSchedules,
} from '../jobs/librarySyncQueue.js';
import { enqueueRequestSync, scheduleRequestSync } from '../jobs/requestSyncQueue.js';
import { createLogger } from '../utils/logger.js';
import type { readServerFacts } from './mediaServer/byServerType.js';
import { addBuiltInRequestServices } from './requests/store.js';
import { rearmImportedHistoryLink } from './settings.js';
import { sseManager } from './sseManager.js';
import { syncServer } from './sync.js';

const log = createLogger('servers');

export interface CreateServerInput {
  name: string;
  type: ServerType;
  url: string;
  token: string;
  publicUrl?: string | null;
  machineIdentifier?: string | null;
  plexAccountId?: string | null;
  facts: Awaited<ReturnType<typeof readServerFacts>>;
  /** The owner's own account on the server, so the first sync finds it instead of adding a person */
  ownerServerUser?: {
    userId: string;
    externalId: string;
    username: string;
    email: string | null;
    thumbUrl?: string | null;
    cloudIdentityId: string | null;
  };
}

/**
 * The caller has already checked the address and key, and starts the server with
 * startAddedServer once nothing else it does can undo the add. The returned row leaves out the
 * token. A throw means nothing was saved.
 */
export async function createServer(input: CreateServerInput) {
  const { type, ownerServerUser } = input;
  const existingColors = await db.select({ color: servers.color }).from(servers);
  const color = pickServerColor(
    type,
    existingColors.map((s) => s.color)
  );

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(servers)
      .values({
        name: input.name,
        type,
        url: input.url,
        publicUrl: input.publicUrl ?? null,
        token: input.token,
        color,
        machineIdentifier: input.machineIdentifier ?? null,
        plexAccountId: input.plexAccountId ?? null,
        ...input.facts,
      })
      .returning({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        publicUrl: servers.publicUrl,
        color: servers.color,
        historicalAt: servers.historicalAt,
        canStopStreams: servers.canStopStreams,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      });
    if (!row) throw new Error('Failed to create server');
    if (ownerServerUser) {
      await tx
        .insert(serverUsers)
        .values({ ...ownerServerUser, serverId: row.id, isServerAdmin: true });
    }
    return { server: row, requestServiceIds: await addBuiltInRequestServices(tx, [row.type]) };
  });
}

/** The history the server keeps itself, held behind its first library sync. */
async function holdServerHistoryImport(server: { id: string; type: ServerType }): Promise<void> {
  const importer = SERVER_PROFILES[server.type].serverHistoryImport;
  switch (importer) {
    case 'tofa':
      return holdTofaImport(server.id);
    case null:
      return;
    default:
      return assertNever(importer);
  }
}

/**
 * Everything a server needs once its row is saved, for every way a server is added. A step that
 * fails is logged and never undoes the add; the steps that need it do not run.
 */
export async function startAddedServer(
  server: { id: string; type: ServerType },
  requestServiceIds: readonly string[]
): Promise<void> {
  const failedFor = (step: string) => (error: unknown) => {
    log.error(`${step} failed for new server`, { err: error, serverId: server.id });
  };

  await publishServersChanged().catch(failedFor('Announcing the change'));
  rebuildAutoSyncSchedules().catch(failedFor('Auto-sync schedule'));
  if (SERVER_PROFILES[server.type].linksImportedHistory) {
    await rearmImportedHistoryLink({ keepProviderPass: false }).catch(
      failedFor('Re-arming imported history linking')
    );
  }
  // Held before the add answers, so an import the owner starts meanwhile finds it and is refused
  await holdServerHistoryImport(server).catch(failedFor('Holding the history import'));
  // Before the add answers too: a Tautulli, Jellystat or Playback Reporting import started
  // meanwhile waits
  await markFirstSyncOwed(server.id).catch(failedFor('Marking the first sync owed'));
  sseManager.refresh().catch(failedFor('SSE refresh'));

  void syncAddedServer(server.id, true, requestServiceIds, failedFor);
}

/** A server re-added at its saved address keeps its start; only its users and libraries sync. */
export function syncReconnectedServer(serverId: string): void {
  void syncAddedServer(serverId, false, [], (step) => (error) => {
    log.error(`${step} failed for reconnected server`, { err: error, serverId });
  });
}

/**
 * Users first: built-in requests are attributed to them. The library sync needs no users, and is
 * queued after them only so the two do not read the server at once. The held history import
 * needs neither: it syncs users itself and runs when a library sync completes or its delay ends.
 */
async function syncAddedServer(
  serverId: string,
  firstSync: boolean,
  requestServiceIds: readonly string[],
  failedFor: (step: string) => (error: unknown) => void
): Promise<void> {
  const usersRead = await syncServer(serverId, { syncUsers: true, syncLibraries: false }).then(
    (result) => {
      if (result.errors.length > 0) {
        failedFor('User sync')(result.errors);
      } else {
        log.info('User sync completed', { serverId, usersAdded: result.usersAdded });
      }
      return result.usersRead;
    },
    (error: unknown) => {
      failedFor('User sync')(error);
      return false;
    }
  );

  await enqueueLibrarySync(serverId, 'event', { firstSync }).catch(
    failedFor('Queuing the library sync')
  );

  if (requestServiceIds.length > 0) {
    await scheduleRequestSync().catch(failedFor('Request sync schedule'));
    if (usersRead) {
      await Promise.all(requestServiceIds.map((id) => enqueueRequestSync(id, 'full'))).catch(
        failedFor('Request sync')
      );
    }
  }
}
