/**
 * The owner's own Jellyfin and Emby accounts
 *
 * Neither server reports an email, so the owner's account there syncs in as a separate person,
 * and the owner has no Users row to merge it into. Linking folds that one account into the owner
 * through the ordinary merge; unlinking splits it back out.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import type { OwnerLinkServer, ServerUserSplitResult, UserMergeResult } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, serverUsers, users } from '../db/schema.js';
import { revokeOtherWebSessions } from '../lib/revoke.js';
import {
  isLoginCapable,
  MEDIA_AUTH_PROVIDERS,
  MergeValidationError,
  mergeUsers,
  splitServerUser,
} from './mergeService.js';
import { ServerUserNotFoundError } from './userService.js';

const LINKABLE_TYPES: ('jellyfin' | 'emby')[] = ['jellyfin', 'emby'];

const mediaProviders = sql.join(
  MEDIA_AUTH_PROVIDERS.map((provider) => sql`${provider}`),
  sql`, `
);

export async function getOwnerLinks(ownerId: string): Promise<OwnerLinkServer[]> {
  const [linkable, accounts] = await Promise.all([
    db.select({ id: servers.id }).from(servers).where(inArray(servers.type, LINKABLE_TYPES)),
    db
      .select({
        id: serverUsers.id,
        serverId: serverUsers.serverId,
        userId: serverUsers.userId,
        username: serverUsers.username,
        thumbUrl: serverUsers.thumbUrl,
        isServerAdmin: serverUsers.isServerAdmin,
        lastActivityAt: serverUsers.lastActivityAt,
        removedAt: serverUsers.removedAt,
        role: users.role,
        passwordHash: users.passwordHash,
        plexAccountId: users.plexAccountId,
        // Drizzle leaves columns unqualified in a select list, so these subqueries name their own.
        accountCount: sql<number>`(
          select count(*)::int from server_users su where su.user_id = server_users.user_id
        )`,
        plexAccountCount: sql<number>`(
          select count(*)::int from plex_accounts pa where pa.user_id = server_users.user_id
        )`,
        authAccountCount: sql<number>`(
          select count(*)::int from auth_accounts aa
          where aa.user_id = server_users.user_id and aa.provider_id not in (${mediaProviders})
        )`,
      })
      .from(serverUsers)
      .innerJoin(servers, eq(servers.id, serverUsers.serverId))
      .innerJoin(users, eq(users.id, serverUsers.userId))
      .where(inArray(servers.type, LINKABLE_TYPES))
      .orderBy(sql`lower(${serverUsers.username})`),
  ]);

  return linkable.map((server) => {
    const onServer = accounts.filter((account) => account.serverId === server.id);
    const own = onServer.find((account) => account.userId === ownerId);
    return {
      serverId: server.id,
      linked: own ? { serverUserId: own.id, username: own.username } : null,
      candidates: own
        ? []
        : onServer
            .filter((account) => account.removedAt === null)
            .map((account) => ({
              serverUserId: account.id,
              username: account.username,
              thumbUrl: account.thumbUrl,
              isServerAdmin: account.isServerAdmin,
              lastActivityAt: account.lastActivityAt?.toISOString() ?? null,
              blockedReason: isLoginCapable({
                id: account.userId,
                role: account.role,
                passwordHash: account.passwordHash,
                plexAccountId: account.plexAccountId,
                linkedPlexAccountCount: account.plexAccountCount,
                authAccountCount: account.authAccountCount,
              })
                ? 'signs_in'
                : account.accountCount > 1
                  ? 'other_accounts'
                  : null,
            })),
    };
  });
}

async function loadAccount(serverUserId: string) {
  const [account] = await db
    .select({
      userId: serverUsers.userId,
      serverId: serverUsers.serverId,
      removedAt: serverUsers.removedAt,
      type: servers.type,
    })
    .from(serverUsers)
    .innerJoin(servers, eq(servers.id, serverUsers.serverId))
    .where(eq(serverUsers.id, serverUserId))
    .limit(1);
  if (!account) throw new ServerUserNotFoundError(serverUserId);
  if (!LINKABLE_TYPES.includes(account.type as 'jellyfin' | 'emby')) {
    throw new MergeValidationError('Only Jellyfin and Emby accounts are linked to the owner here');
  }
  return account;
}

/**
 * Only the one account moves: a person holding other accounts too is refused rather than carried
 * in whole, since every account the owner holds becomes a way to sign in as the owner.
 */
export async function linkOwnerAccount(
  ownerId: string,
  serverUserId: string
): Promise<UserMergeResult> {
  const account = await loadAccount(serverUserId);
  if (account.userId === ownerId) {
    throw new MergeValidationError('This account is already linked to you');
  }
  if (account.removedAt) {
    throw new MergeValidationError('This account was removed from its server');
  }

  const [counts] = await db
    .select({
      personAccounts: sql<number>`count(*) filter (where ${serverUsers.userId} = ${account.userId})::int`,
      ownerAccountsHere: sql<number>`count(*) filter (where ${serverUsers.userId} = ${ownerId} and ${serverUsers.serverId} = ${account.serverId})::int`,
    })
    .from(serverUsers)
    .where(inArray(serverUsers.userId, [account.userId, ownerId]));
  if ((counts?.ownerAccountsHere ?? 0) > 0) {
    throw new MergeValidationError('You already have an account linked on this server');
  }
  if ((counts?.personAccounts ?? 0) > 1) {
    throw new MergeValidationError(
      'This person has accounts on other servers too. Split this account off on their page first.'
    );
  }

  return mergeUsers(account.userId, ownerId, ownerId);
}

export async function unlinkOwnerAccount(
  ownerId: string,
  serverUserId: string,
  keepSessionId: string | undefined
): Promise<ServerUserSplitResult> {
  const account = await loadAccount(serverUserId);
  if (account.userId !== ownerId) throw new ServerUserNotFoundError(serverUserId);

  const result = await splitServerUser(serverUserId, ownerId, { allowLastAccount: true });
  // Owner sessions skip every member check, so one started through this account would outlive it.
  await revokeOtherWebSessions(ownerId, keepSessionId);
  return result;
}
