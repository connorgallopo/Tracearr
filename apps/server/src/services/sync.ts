/**
 * Server sync service - imports users and libraries from Plex/Jellyfin
 *
 * Uses generic syncServerUsers function for both Plex and Jellyfin,
 * delegating user operations to userService.
 */

import { eq, and, isNull, isNotNull, inArray, notInArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { createRawPgClient, db, type Executor } from '../db/client.js';
import * as schema from '../db/schema.js';
import { servers, serverUsers } from '../db/schema.js';
import { revokeSessionsForServerUsers } from '../lib/revoke.js';
import { clearScope } from '../lib/scope.js';
import { createMediaServerClient, PlexClient, type MediaUser } from './mediaServer/index.js';
import {
  loadServerAccounts,
  recomputeIdentityAggregates,
  syncUserFromMediaServer,
  type ServerSyncBatch,
  type SyncUserOptions,
} from './userService.js';
import { ensureServerIdentifier } from './serverIdentity.js';
import { ServerHistoricalError } from './liveServers.js';

export interface SyncResult {
  usersAdded: number;
  usersUpdated: number;
  usersSkipped: number;
  usersRemoved: number;
  usersRestored: number;
  librariesSynced: number;
  errors: string[];
}

export interface SyncOptions {
  syncUsers?: boolean;
  syncLibraries?: boolean;
}

const SYNC_COMMIT_EVERY = 250;
// A sync queued behind a wedged one gives up rather than waiting forever.
const SYNC_LOCK_WAIT = '120s';

/**
 * One user sync per server at a time, across processes. The lock is a session advisory lock on a
 * connection of its own, so it holds across the batch commits and Postgres drops it if the
 * process dies. The same connection carries the sync's writes.
 */
async function withServerSyncLock<T>(
  serverId: string,
  run: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = createRawPgClient('server user sync');
  await client.connect();
  try {
    await client.query(`SET lock_timeout = '${SYNC_LOCK_WAIT}'`);
    await client.query(`SELECT pg_advisory_lock(hashtext('server_user_sync'), hashtext($1))`, [
      serverId,
    ]);
    return await run(client);
  } finally {
    await client.end().catch(() => {
      /* closing releases the lock and rolls back an open batch */
    });
  }
}

/**
 * Savepointed writes on the sync's connection. The transaction opens at the first write, so a
 * server with nothing to change opens none, and `commit` closes it between batches so changed
 * rows stay locked for one batch, not the whole sync.
 */
function batchWriter(client: pg.Client) {
  const conn = drizzle(client, { schema });
  let open = false;
  return {
    write: async <T>(run: (tx: Executor) => Promise<T>): Promise<T> => {
      if (!open) {
        await client.query('BEGIN');
        open = true;
      }
      await client.query('SAVEPOINT account');
      try {
        const result = await run(conn);
        await client.query('RELEASE SAVEPOINT account');
        return result;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT account');
        throw err;
      }
    },
    commit: async (): Promise<void> => {
      if (!open) return;
      await client.query('COMMIT');
      open = false;
    },
  };
}

/**
 * Generic user sync - works for both Plex and Jellyfin
 *
 * For Plex servers (isPlexServer=true):
 * - Matches by plexAccountId, then externalId (same for shared users), then username
 * - Creates new users with dual IDs: externalId (local PMS) + plexAccountId (plex.tv)
 * - For shared users: plex.tv ID = local PMS ID
 * - For owner: plex.tv ID ≠ local PMS ID (owner is always "1" locally)
 *
 * For Jellyfin/Emby servers:
 * - Creates new users if not found
 * - Uses externalId for matching
 */
export async function syncServerUsers(
  serverId: string,
  mediaUsers: MediaUser[],
  options: SyncUserOptions = {}
): Promise<{
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  restored: number;
  errors: string[];
}> {
  return withServerSyncLock(serverId, async (client) => {
    const errors: string[] = [];
    let added = 0;
    let updated = 0;
    let skipped = 0;

    // Track which external IDs we see from the media server
    const syncedExternalIds: string[] = [];

    const accounts = await loadServerAccounts(serverId);
    const recompute = new Set<string>();
    const clearScopes = new Set<string>();
    const disabledIds: string[] = [];
    const writer = batchWriter(client);
    const batch: ServerSyncBatch = { accounts, write: writer.write, recompute, clearScopes };
    // A batch's follow-ups run as soon as its writes commit: once committed, the next sync sees
    // those accounts as unchanged and would never redo them.
    const commitBatch = async () => {
      await writer.commit();
      try {
        // Outside the batch, so the users rows it locks are never held alongside server_users rows.
        await recomputeIdentityAggregates([...recompute]);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to recount ${recompute.size} identities: ${message}`);
      }
      if (disabledIds.length > 0) await revokeSessionsForServerUsers([...disabledIds]);
      // After commit, so a scope rebuilt meanwhile reads the new library access.
      for (const userId of clearScopes) await clearScope(userId);
      recompute.clear();
      clearScopes.clear();
      disabledIds.length = 0;
    };
    for (const [index, mediaUser] of mediaUsers.entries()) {
      syncedExternalIds.push(mediaUser.id);
      try {
        const result = await syncUserFromMediaServer(serverId, mediaUser, options, batch);
        if (result === null) {
          // Plex sync skipped new user (will be created by poller)
          skipped++;
        } else if (result.created) {
          added++;
        } else {
          updated++;
          if (result.newlyDisabled) disabledIds.push(result.serverUser.id);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push(`Failed to sync user ${mediaUser.username}: ${message}`);
      }
      if ((index + 1) % SYNC_COMMIT_EVERY === 0) await commitBatch();
    }
    await commitBatch();

    // For Plex, mediaUser.id is plex.tv account ID (stored as plexAccountId)
    // For Jellyfin/Emby, mediaUser.id is the server-local ID (stored as externalId)
    const matchColumn = options.isPlexServer ? serverUsers.plexAccountId : serverUsers.externalId;

    // Mark users not in the server response as removed
    let removed = 0;
    if (syncedExternalIds.length > 0) {
      const removedResult = await db
        .update(serverUsers)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(serverUsers.serverId, serverId),
            isNull(serverUsers.removedAt),
            notInArray(matchColumn, syncedExternalIds)
          )
        )
        .returning({ id: serverUsers.id });
      removed = removedResult.length;
      if (removed > 0) await revokeSessionsForServerUsers(removedResult.map((r) => r.id));
      if (removed > 0) {
        console.log(`[Sync] Marked ${removed} users as removed from server ${serverId}`);
      }
    }

    // Restore any previously-removed users that reappeared in this sync
    let restored = 0;
    if (syncedExternalIds.length > 0) {
      const restoredResult = await db
        .update(serverUsers)
        .set({ removedAt: null })
        .where(
          and(
            eq(serverUsers.serverId, serverId),
            isNotNull(serverUsers.removedAt),
            inArray(matchColumn, syncedExternalIds)
          )
        )
        .returning({ userId: serverUsers.userId });
      restored = restoredResult.length;
      // A restored account widens its person's scope without revoking anything.
      for (const userId of new Set(restoredResult.map((r) => r.userId))) await clearScope(userId);
      if (restored > 0) {
        console.log(`[Sync] Restored ${restored} previously removed users on server ${serverId}`);
      }
    }

    return { added, updated, skipped, removed, restored, errors };
  });
}

/**
 * Fetch Plex users from server (Plex has special API via Plex.tv)
 */
async function fetchPlexUsers(token: string, serverUrl: string): Promise<MediaUser[]> {
  // Get server machine identifier for shared_servers API
  const response = await fetch(serverUrl, {
    headers: {
      'X-Plex-Token': token,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to connect to Plex server: ${response.status}`);
  }

  const serverInfo = (await response.json()) as {
    MediaContainer?: { machineIdentifier?: string };
  };
  const machineIdentifier = serverInfo.MediaContainer?.machineIdentifier;

  if (!machineIdentifier) {
    throw new Error('Could not get server machine identifier');
  }

  return PlexClient.getAllUsersWithLibraries(token, machineIdentifier);
}

/**
 * Sync users from Plex server to local database
 *
 * Uses isPlexServer=true to:
 * - Match by plexAccountId, externalId, then username
 * - Create new users with dual IDs (externalId + plexAccountId)
 * - For shared users: plex.tv ID = local PMS ID (same)
 */
async function syncPlexUsers(
  serverId: string,
  token: string,
  serverUrl: string
): Promise<{
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  restored: number;
  errors: string[];
}> {
  try {
    const plexUsers = await fetchPlexUsers(token, serverUrl);
    return syncServerUsers(serverId, plexUsers, { isPlexServer: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      added: 0,
      updated: 0,
      skipped: 0,
      removed: 0,
      restored: 0,
      errors: [`Plex user sync failed: ${message}`],
    };
  }
}

/**
 * Sync users from Jellyfin or Emby server to local database
 * Both use the same IMediaServerClient interface via createMediaServerClient
 */
async function syncMediaServerUsers(
  serverId: string,
  serverType: 'jellyfin' | 'emby',
  serverUrl: string,
  token: string
): Promise<{
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  restored: number;
  errors: string[];
}> {
  const serverName = serverType.charAt(0).toUpperCase() + serverType.slice(1);
  try {
    const client = createMediaServerClient({
      type: serverType,
      url: serverUrl,
      token,
    });
    const [users, libraries] = await Promise.all([
      client.getUsers(),
      // Users still sync without the library list. Limited accounts then map to no libraries
      // until the next sync, never to every library.
      client.getLibraries().catch((err: unknown) => {
        console.warn(`[Sync] ${serverName} library list failed, library limits map to none:`, err);
        return [];
      }),
    ]);
    // Jellyfin's policy names a folder by its ItemId. Emby's names it by Guid and grants nothing
    // for an ItemId (checked on Emby 4.10), so a folder with a Guid only matches by it.
    const libraryIdOf = new Map(libraries.map((l) => [l.guid ?? l.id, l.id]));
    const withLibraryIds = users.map((user) => ({
      ...user,
      sharedLibraries: user.sharedLibraries?.flatMap((id) => libraryIdOf.get(id) ?? []),
    }));
    return syncServerUsers(serverId, withLibraryIds); // isPlexServer defaults to false
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      added: 0,
      updated: 0,
      skipped: 0,
      removed: 0,
      restored: 0,
      errors: [`${serverName} user sync failed: ${message}`],
    };
  }
}

/**
 * Sync a single server (users and libraries)
 */
export async function syncServer(
  serverId: string,
  options: SyncOptions = { syncUsers: true, syncLibraries: true }
): Promise<SyncResult> {
  const result: SyncResult = {
    usersAdded: 0,
    usersUpdated: 0,
    usersSkipped: 0,
    usersRemoved: 0,
    usersRestored: 0,
    librariesSynced: 0,
    errors: [],
  };

  // Get server details
  const serverRows = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  const server = serverRows[0];

  if (!server) {
    result.errors.push(`Server not found: ${serverId}`);
    return result;
  }

  if (server.historicalAt) {
    throw new ServerHistoricalError(serverId);
  }

  const token = server.token;
  const serverUrl = server.url.replace(/\/$/, '');

  await ensureServerIdentifier(server, {
    debug: (obj, msg) => console.log(`[Sync] ${msg}`, obj),
  });

  // Sync users
  if (options.syncUsers) {
    if (server.type === 'plex') {
      const userResult = await syncPlexUsers(serverId, token, serverUrl);
      result.usersAdded = userResult.added;
      result.usersUpdated = userResult.updated;
      result.usersSkipped = userResult.skipped;
      result.usersRemoved = userResult.removed;
      result.usersRestored = userResult.restored;
      result.errors.push(...userResult.errors);
    } else if (server.type === 'jellyfin' || server.type === 'emby') {
      const userResult = await syncMediaServerUsers(serverId, server.type, serverUrl, server.token);
      result.usersAdded = userResult.added;
      result.usersUpdated = userResult.updated;
      result.usersSkipped = userResult.skipped;
      result.usersRemoved = userResult.removed;
      result.usersRestored = userResult.restored;
      result.errors.push(...userResult.errors);
    }
  }

  // Sync libraries (just count for now - libraries stored on server)
  if (options.syncLibraries) {
    try {
      const client = createMediaServerClient({
        type: server.type,
        url: serverUrl,
        token: server.token,
      });
      const libraries = await client.getLibraries();
      result.librariesSynced = libraries.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      result.errors.push(`Library sync failed: ${message}`);
    }
  }

  return result;
}
