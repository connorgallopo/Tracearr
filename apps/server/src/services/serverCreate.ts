import { pickServerColor, SERVER_PROFILES, type ServerType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, serverUsers } from '../db/schema.js';
import { publishServersChanged } from '../jobs/poller/database.js';
import { rebuildAutoSyncSchedules } from '../jobs/librarySyncQueue.js';
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
 * The caller has already checked the address and key; the returned row leaves out the token. A
 * throw means nothing was saved.
 */
export async function createServer(input: CreateServerInput) {
  const { type, ownerServerUser } = input;
  const existingColors = await db.select({ color: servers.color }).from(servers);
  const color = pickServerColor(
    type,
    existingColors.map((s) => s.color)
  );

  const created = await db.transaction(async (tx) => {
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
  const { server, requestServiceIds } = created;

  // The row is saved, so a step after it is logged and never undoes it.
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

  const initialSync = syncServer(server.id, { syncUsers: true, syncLibraries: true })
    .then((result) => {
      log.info('Auto-sync completed for new server', {
        serverId: server.id,
        usersAdded: result.usersAdded,
        librariesSynced: result.librariesSynced,
      });
    })
    .catch(failedFor('Auto-sync'));

  // A built-in request's requester resolves to one of the users the first sync brings in
  if (requestServiceIds.length > 0) {
    void initialSync
      .then(scheduleRequestSync)
      .then(() => Promise.all(requestServiceIds.map((id) => enqueueRequestSync(id, 'full'))))
      .catch(failedFor('Request sync'));
  }

  sseManager.refresh().catch(failedFor('SSE refresh'));

  return server;
}
