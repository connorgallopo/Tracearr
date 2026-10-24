/** Which server_users an identity-wide User page reads, under the caller's server access. */

import type { AuthUser } from '@tracearr/shared';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { db as defaultDb } from '../../../db/client.js';
import { serverUsers } from '../../../db/schema.js';
import { buildServerAccessCondition, hasServerAccess } from '../../../utils/serverFiltering.js';
import { assertInScope, type Scope } from '../../../lib/scope.js';

// Accept either the default db or a transaction context
type DbOrTx = typeof defaultDb;

/**
 * All server_user ids belonging to a person's identity that the caller can
 * access. Always scoped by the caller's accessible servers (owners see every
 * sibling account, everyone else only their own accessible servers) so an
 * identity-wide query can never surface accounts on servers the caller
 * doesn't have access to.
 */
export async function resolveAccessibleServerUserIdsForIdentity(
  dbOrTx: DbOrTx,
  authUser: AuthUser,
  identityUserId: string
): Promise<string[]> {
  return resolveAccessibleServerUserIdsForIdentities(dbOrTx, authUser, [identityUserId]);
}

/**
 * Batched version of resolveAccessibleServerUserIdsForIdentity - the union of
 * every accessible server_user id across all given identities in a single
 * query. An identity with no accessible account under the caller's server
 * access contributes nothing to the union (fail-closed), same as the
 * singular resolver.
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
 * sibling account under the same identity when `scope=identity` is set.
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
  | { serverUser: { id: string; serverId: string; userId: string }; ids: string[] }
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
    return { serverUser, ids: [id] };
  }

  const ids = (
    await resolveAccessibleServerUserIdsForIdentity(dbOrTx, authUser, serverUser.userId)
  ).filter((accountId) => assertInScope(rowScope, accountId));
  // The anchor account is always part of its own identity and already passed
  // the access check above, so this can't come back empty in practice.
  return { serverUser, ids: ids.length > 0 ? ids : [id] };
}
