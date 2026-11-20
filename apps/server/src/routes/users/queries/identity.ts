/** Which server_users an identity-wide User page reads, under the caller's server access. */

import type { AuthUser, ServerType } from '@tracearr/shared';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { db as defaultDb } from '../../../db/client.js';
import { serverUsers } from '../../../db/schema.js';
import { getCachedServers } from '../../../jobs/poller/database.js';
import { buildServerAccessCondition, hasServerAccess } from '../../../utils/serverFiltering.js';
import { assertInScope, type Scope } from '../../../lib/scope.js';

// Accept either the default db or a transaction context
type DbOrTx = typeof defaultDb;

/**
 * The union of every accessible server_user id across all given identities in
 * a single query. Always scoped by the caller's accessible servers (owners see
 * every sibling account, everyone else only their own accessible servers), so
 * an identity with no accessible account contributes nothing (fail-closed).
 */
export async function resolveAccessibleServerUserIdsForIdentities(
  dbOrTx: DbOrTx,
  authUser: AuthUser,
  identityUserIds: string[]
): Promise<string[]> {
  if (identityUserIds.length === 0) return [];

  const rows = await dbOrTx
    .select({ id: serverUsers.id })
    .from(serverUsers)
    .where(identityAccountsWhere(authUser, identityUserIds));
  return rows.map((row) => row.id);
}

/** The server_users of these identities on servers the caller can access (owners: all). */
export function identityAccountsWhere(authUser: AuthUser, identityUserIds: string[]): SQL {
  const identities = inArray(serverUsers.userId, identityUserIds);
  return and(identities, buildServerAccessCondition(authUser, serverUsers.serverId)) ?? identities;
}

/**
 * Resolve the set of server_user ids a per-account endpoint (anchored on
 * `:id`) should query against: just `[id]` by default, or every accessible
 * sibling account under the same identity when `scope=identity` is set, with
 * the server each account is on.
 */
export async function resolveIdentityScopedServerUserIds(
  dbOrTx: DbOrTx,
  authUser: AuthUser,
  id: string,
  scope: 'identity' | undefined,
  rowScope: Scope
): Promise<
  | { error: 'notFound' }
  | { error: 'forbidden' }
  | {
      serverUser: { id: string; serverId: string; userId: string };
      ids: string[];
      serverIds: string[];
    }
> {
  const rows = await dbOrTx
    .select({ id: serverUsers.id, serverId: serverUsers.serverId, userId: serverUsers.userId })
    .from(serverUsers)
    .where(eq(serverUsers.id, id))
    .limit(1);

  const serverUser = rows[0];
  if (!serverUser || !assertInScope(rowScope, serverUser.id)) {
    return { error: 'notFound' };
  }
  if (!hasServerAccess(authUser, serverUser.serverId)) {
    return { error: 'forbidden' };
  }
  if (scope !== 'identity') {
    return { serverUser, ids: [id], serverIds: [serverUser.serverId] };
  }

  const accounts = (
    await dbOrTx
      .select({ id: serverUsers.id, serverId: serverUsers.serverId })
      .from(serverUsers)
      .where(identityAccountsWhere(authUser, [serverUser.userId]))
  ).filter((account) => assertInScope(rowScope, account.id));
  // The anchor account is always part of its own identity and already passed
  // the access check above, so this can't come back empty in practice.
  return accounts.length > 0
    ? {
        serverUser,
        ids: accounts.map((account) => account.id),
        serverIds: accounts.map((account) => account.serverId),
      }
    : { serverUser, ids: [id], serverIds: [serverUser.serverId] };
}

/** The type of each server, from the servers cache; a server no longer there drops out */
export async function serverTypesOf(serverIds: string[]): Promise<ServerType[]> {
  const typeOf = new Map((await getCachedServers()).map((row) => [row.id, row.type]));
  return serverIds.flatMap((serverId) => typeOf.get(serverId) ?? []);
}
