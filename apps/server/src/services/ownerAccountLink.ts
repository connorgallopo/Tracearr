/**
 * The owner's own Jellyfin, Emby and tofa accounts
 *
 * Jellyfin and Emby report no email, and a tofa server added by its key arrives without the owner's
 * account, so the owner's account there syncs in as a separate person, and the owner has no Users
 * row to merge it into. Linking folds that one account into the owner through the ordinary merge; unlinking splits
 * it back out. A tofa account also brings the owner's tofa sign-in, so it is proved by signing in to
 * tofa as it rather than by typing its name.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  SERVER_TYPES,
  ownerLinkProof,
  type OwnerLinkProof,
  type OwnerLinkServer,
  type ServerType,
  type ServerUserSplitResult,
  type UserMergeResult,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { authAccounts, servers, serverUsers, users } from '../db/schema.js';
import { liveServerAccount } from '../lib/authGuards.js';
import { upsertTofaAccount } from '../lib/memberLogin.js';
import { revokeOtherWebSessions } from '../lib/revoke.js';
import {
  isLoginCapable,
  keepsOwnerTofaSignIn,
  MEDIA_AUTH_PROVIDERS,
  MergeValidationError,
  mergeUsers,
  splitServerUser,
} from './mergeService.js';
import { ServerUserNotFoundError } from './userService.js';

const typesProvedBy = (...proofs: OwnerLinkProof[]) =>
  SERVER_TYPES.filter((type) => proofs.includes(ownerLinkProof(type)));

const LINKABLE_TYPES = typesProvedBy('typedUsername', 'tofaSignIn');
const TYPED_USERNAME_TYPES = typesProvedBy('typedUsername');
const TOFA_SIGN_IN_TYPES = typesProvedBy('tofaSignIn');

const mediaProviders = sql.join(
  MEDIA_AUTH_PROVIDERS.map((provider) => sql`${provider}`),
  sql`, `
);

export async function getOwnerLinks(ownerId: string): Promise<OwnerLinkServer[]> {
  const [linkable, accounts] = await Promise.all([
    db
      .select({ id: servers.id, type: servers.type })
      .from(servers)
      .where(inArray(servers.type, LINKABLE_TYPES)),
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
        carriesTofaSignIn: sql<boolean>`exists (
          select 1 from auth_accounts aa
          where aa.user_id = server_users.user_id and aa.provider_id = 'tofa'
            and aa.account_id = server_users.cloud_identity_id
        )`,
        keepsOwnerSignIn: keepsOwnerTofaSignIn({
          id: sql`server_users.id`,
          userId: sql`server_users.user_id`,
          cloudIdentityId: sql`server_users.cloud_identity_id`,
        }),
      })
      .from(serverUsers)
      .innerJoin(servers, eq(servers.id, serverUsers.serverId))
      .innerJoin(users, eq(users.id, serverUsers.userId))
      .where(
        and(
          inArray(servers.type, LINKABLE_TYPES),
          // Only typed-username servers list someone else's accounts to pick from.
          or(inArray(servers.type, TYPED_USERNAME_TYPES), eq(serverUsers.userId, ownerId))
        )
      )
      .orderBy(sql`lower(${serverUsers.username})`),
  ]);

  return linkable.map((server) => {
    const proof = ownerLinkProof(server.type);
    const onServer = accounts.filter((account) => account.serverId === server.id);
    // A tofa account the owner holds without its sign-in, attached by email, is linked only once
    // the owner signs in to tofa as it.
    const own = onServer.find(
      (account) =>
        account.userId === ownerId && (proof !== 'tofaSignIn' || account.carriesTofaSignIn)
    );
    return {
      serverId: server.id,
      linked: own
        ? { serverUserId: own.id, username: own.username, canUnlink: !own.keepsOwnerSignIn }
        : null,
      candidates:
        own || proof !== 'typedUsername'
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

async function loadAccount(serverUserId: string, types: readonly ServerType[], refusal: string) {
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
  if (!types.includes(account.type)) throw new MergeValidationError(refusal);
  return account;
}

/**
 * Only the one account moves: a person holding other accounts too is refused rather than carried
 * in whole, since every account the owner holds becomes a way to sign in as the owner.
 */
async function assertFoldsIntoOwner(
  ownerId: string,
  account: { userId: string; serverId: string }
): Promise<void> {
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
}

export async function linkOwnerAccount(
  ownerId: string,
  serverUserId: string
): Promise<UserMergeResult> {
  const account = await loadAccount(
    serverUserId,
    TYPED_USERNAME_TYPES,
    'Only Jellyfin and Emby accounts are linked to the owner by username'
  );
  if (account.userId === ownerId) {
    throw new MergeValidationError('This account is already linked to you');
  }
  if (account.removedAt) {
    throw new MergeValidationError('This account was removed from its server');
  }
  await assertFoldsIntoOwner(ownerId, account);
  return mergeUsers(account.userId, ownerId, ownerId);
}

/**
 * The live account on the tofa server that carries the cloud identity the owner just signed in to
 * tofa as joins the owner, and the owner signs in to Tracearr with that identity from then on.
 */
export async function linkOwnerTofaAccount(
  ownerId: string,
  serverId: string,
  identityId: string
): Promise<void> {
  const [account] = await db
    .select({ userId: serverUsers.userId, serverId: serverUsers.serverId })
    .from(serverUsers)
    .innerJoin(servers, eq(servers.id, serverUsers.serverId))
    .where(
      and(
        eq(serverUsers.serverId, serverId),
        eq(serverUsers.cloudIdentityId, identityId),
        inArray(servers.type, TOFA_SIGN_IN_TYPES),
        liveServerAccount
      )
    )
    .limit(1);
  if (!account) {
    throw new MergeValidationError(
      'The tofa account you signed in with has no account on this server'
    );
  }
  if (account.userId === ownerId) {
    await upsertTofaAccount(ownerId, identityId);
    return;
  }
  await assertFoldsIntoOwner(ownerId, account);
  const [ownerSignIn] = await db
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, 'tofa'),
        eq(authAccounts.accountId, identityId),
        eq(authAccounts.userId, ownerId)
      )
    )
    .limit(1);
  // A sign-in the owner already holds stays theirs and never passes through the person. Any other
  // is brought by the merge itself, so an unlink hands it back with the account.
  await mergeUsers(
    account.userId,
    ownerId,
    ownerId,
    ownerSignIn ? {} : { bringsTofaSignIn: identityId }
  );
}

export async function unlinkOwnerAccount(
  ownerId: string,
  serverUserId: string,
  keepSessionId: string | undefined
): Promise<ServerUserSplitResult> {
  const account = await loadAccount(
    serverUserId,
    LINKABLE_TYPES,
    'Only Jellyfin, Emby and tofa accounts are unlinked from the owner here'
  );
  if (account.userId !== ownerId) throw new ServerUserNotFoundError(serverUserId);

  const result = await splitServerUser(serverUserId, ownerId, { allowLastAccount: true });
  // Owner sessions skip every member check, so one started through this account would outlive it.
  await revokeOtherWebSessions(ownerId, keepSessionId);
  return result;
}
