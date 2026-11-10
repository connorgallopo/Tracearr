import { randomUUID } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  assertNever,
  isServerType,
  type LoginAccess,
  type UserRole,
  type JellyfinEmbyServerType,
  type ServerType,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { authAccounts, servers, serverUsers, users } from '../db/schema.js';
import { EmbyClient, JellyfinClient, logoutUserToken } from '../services/mediaServer/index.js';
import { getOwnerUser } from '../services/userService.js';
import { getSetting } from '../services/settings.js';
import { createLogger } from '../utils/logger.js';
import {
  canMemberLogin,
  identityGate,
  liveServerAccount,
  mediaSignInClosed,
  memberGateError,
  nonOwnerMayLogin,
  nonOwnerMayLoginThrough,
  refused,
  usableLoginMethods,
} from './authGuards.js';

const log = createLogger('member-login');

type Ctx = Parameters<typeof setSessionCookie>[0];

export interface MemberLoginInput {
  serverId: string;
  serverUrl: string;
  externalId: string;
  token: string;
  providerId: JellyfinEmbyServerType;
  deviceId: string;
}

export const memberDeviceId = (userId: string): string => `tracearr-${userId}`;

/** The session create hook still runs assertUserCanLogin inside createSession. */
export async function createSignedInSession(ctx: Ctx, userId: string) {
  const session = await ctx.context.internalAdapter.createSession(userId);
  const user = await ctx.context.internalAdapter.findUserById(userId);
  if (!user) throw new APIError('UNAUTHORIZED', { message: 'User not found' });
  await setSessionCookie(ctx, { session, user });
  const { role, username } = user as { role?: string; username?: string | null };
  return { id: user.id, username: username ?? user.name, role: role ?? 'member' };
}

// The token is already a device on the media server; one Tracearr will not use is logged out
// there rather than left behind.
async function discardToken(input: MemberLoginInput, token: string): Promise<void> {
  await logoutUserToken(input.providerId, input.serverUrl, token).catch(() => {
    log.warn('could not log out an unused member token', { serverId: input.serverId });
  });
}

/** Query errors carry their bound parameters, tokens included, into whatever logs them. */
export async function writeWithoutParams<T>(
  write: () => Promise<T>,
  ids: Record<string, string>
): Promise<T> {
  try {
    return await write();
  } catch {
    log.error('could not store a sign-in account', ids);
    throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Sign-in failed. Try again later.' });
  }
}

export async function finishMemberLogin(ctx: Ctx, input: MemberLoginInput) {
  const [account] = await db
    .select({ userId: serverUsers.userId })
    .from(serverUsers)
    .where(
      and(
        eq(serverUsers.serverId, input.serverId),
        eq(serverUsers.externalId, input.externalId),
        isNull(serverUsers.removedAt)
      )
    )
    .limit(1);
  const gate = account
    ? await canMemberLogin(account.userId, input.serverId)
    : ({ ok: false, reason: 'refused' } as const);
  if (!account || !gate.ok) {
    await discardToken(input, input.token);
    throw gate.ok ? refused() : memberGateError(gate);
  }

  const accountId = `${input.serverId}:${input.externalId}`;
  const [stored] = await db
    .select({ token: authAccounts.accessToken, deviceId: authAccounts.scope })
    .from(authAccounts)
    .where(
      and(eq(authAccounts.providerId, input.providerId), eq(authAccounts.accountId, accountId))
    )
    .limit(1);
  await writeWithoutParams(
    () =>
      db
        .insert(authAccounts)
        .values({
          id: randomUUID(),
          providerId: input.providerId,
          accountId,
          userId: account.userId,
          accessToken: input.token,
          scope: input.deviceId,
        })
        .onConflictDoUpdate({
          target: [authAccounts.providerId, authAccounts.accountId],
          set: {
            userId: account.userId,
            accessToken: input.token,
            scope: input.deviceId,
            updatedAt: new Date(),
          },
        }),
    { userId: account.userId, serverId: input.serverId }
  );
  // scope holds the DeviceId the stored token was issued to.
  const replacedOnServer =
    revokesTokenOnSameDeviceSignIn(input.providerId) && stored?.deviceId === input.deviceId;
  if (stored?.token && stored.token !== input.token && !replacedOnServer) {
    await discardToken(input, stored.token);
  }

  const user = await createSignedInSession(ctx, account.userId);
  return ctx.json({ authorized: true, user });
}

/** Jellyfin revokes the old token when the same DeviceId signs in again; Emby keeps both. */
function revokesTokenOnSameDeviceSignIn(type: JellyfinEmbyServerType): boolean {
  switch (type) {
    case 'jellyfin':
      return true;
    case 'emby':
      return false;
    default:
      return assertNever(type);
  }
}

function fetchSelf(type: JellyfinEmbyServerType, url: string, token: string, userId: string) {
  switch (type) {
    case 'jellyfin':
      return JellyfinClient.fetchSelf(url, token);
    case 'emby':
      return EmbyClient.fetchSelf(url, token, userId);
    default:
      return assertNever(type);
  }
}

type MediaAccount = { providerId: string; accountId: string; token: string | null };

async function mediaAccountIsAWayIn(
  userId: string,
  identity: { role: UserRole; loginAccess: LoginAccess },
  memberSwitch: boolean,
  type: ServerType,
  account: MediaAccount
): Promise<boolean> {
  const live = and(eq(serverUsers.userId, userId), liveServerAccount);
  switch (type) {
    case 'plex': {
      const rows = await db
        .select({ serverAllowsMembers: servers.allowMemberLogin })
        .from(serverUsers)
        .innerJoin(servers, eq(servers.id, serverUsers.serverId))
        .where(
          and(live, eq(servers.type, 'plex'), eq(serverUsers.plexAccountId, account.accountId))
        );
      return rows.some((row) =>
        nonOwnerMayLoginThrough(identity, memberSwitch, row.serverAllowsMembers)
      );
    }
    case 'jellyfin':
    case 'emby':
      break;
    default:
      return assertNever(type);
  }

  const [serverId, externalId] = account.accountId.split(':');
  if (!serverId || !externalId || !account.token) return false;
  const [row] = await db
    .select({ url: servers.url, serverAllowsMembers: servers.allowMemberLogin })
    .from(serverUsers)
    .innerJoin(servers, eq(servers.id, serverUsers.serverId))
    .where(and(live, eq(serverUsers.serverId, serverId), eq(serverUsers.externalId, externalId)))
    .limit(1);
  // A server this person may not sign in through is never asked about the token.
  if (!row || !nonOwnerMayLoginThrough(identity, memberSwitch, row.serverAllowsMembers)) {
    return false;
  }
  try {
    const self = await fetchSelf(type, row.url, account.token, externalId);
    return !!self && self.id === externalId && !self.isDisabled;
  } catch {
    log.warn('member revalidation could not reach the server', { userId, serverId });
    return true;
  }
}

/**
 * The daily refresh keeps a session while the person has at least one way in that a fresh sign-in
 * would accept right now: an admin password, SSO, or a media account on a server open to them
 * whose token still works. A server that cannot be reached counts as a way in.
 */
export async function memberStillValid(userId: string): Promise<boolean> {
  const [identity] = await db
    .select({ role: users.role, loginAccess: users.loginAccess })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!identity || identity.role === 'owner') return true;

  const [{ member }, usable, mediaClosed, accounts] = await Promise.all([
    getSetting('loginMethods'),
    usableLoginMethods(),
    mediaSignInClosed(),
    db
      .select({
        providerId: authAccounts.providerId,
        accountId: authAccounts.accountId,
        token: authAccounts.accessToken,
        password: authAccounts.password,
      })
      .from(authAccounts)
      .where(eq(authAccounts.userId, userId)),
  ]);

  const stillIn =
    nonOwnerMayLogin(identity, member) &&
    ((usable.local &&
      identity.role === 'admin' &&
      accounts.some((a) => a.providerId === 'credential' && a.password)) ||
      (usable.oidc &&
        accounts.some((a) => a.providerId === 'oidc') &&
        (await oidcMemberGate(userId, null)).ok) ||
      (!mediaClosed && (await someMediaAccountIsAWayIn(userId, identity, member, accounts))));
  if (!stillIn) log.info('member revalidation ended a session', { userId });
  return stillIn;
}

async function someMediaAccountIsAWayIn(
  userId: string,
  identity: { role: UserRole; loginAccess: LoginAccess },
  memberSwitch: boolean,
  accounts: MediaAccount[]
): Promise<boolean> {
  for (const account of accounts) {
    const type = account.providerId;
    if (!isServerType(type)) continue;
    if (await mediaAccountIsAWayIn(userId, identity, memberSwitch, type, account)) return true;
  }
  return false;
}

interface OidcMatch {
  userId: string;
  /** The servers whose accounts matched; null when users.email did, which names no server. */
  serverIds: string[] | null;
}

function uniqueMatch(
  rows: { userId: string; serverId?: string }[],
  matched: string
): OidcMatch | null {
  const ids = [...new Set(rows.map((r) => r.userId))];
  if (ids.length > 1) log.warn('OIDC profile matches more than one identity', { matched });
  const [userId] = ids;
  if (ids.length !== 1 || !userId) return null;
  const serverIds = rows.map((r) => r.serverId);
  return {
    userId,
    serverIds: serverIds.some((id) => id === undefined)
      ? null
      : serverIds.filter((id): id is string => id !== undefined),
  };
}

export async function findMemberForOidc(profile: {
  email?: string | null;
  preferred_username?: string | null;
}): Promise<OidcMatch | null> {
  if (profile.email) {
    const email = profile.email.toLowerCase();
    const [fromServers, fromUsers] = await Promise.all([
      db
        .select({ userId: serverUsers.userId, serverId: serverUsers.serverId })
        .from(serverUsers)
        .where(eq(sql`lower(${serverUsers.email})`, email)),
      db
        .select({ userId: users.id })
        .from(users)
        .where(eq(sql`lower(${users.email})`, email)),
    ]);
    const rows = [...fromServers, ...fromUsers];
    if (rows.length > 0) return uniqueMatch(rows, 'email');
  }
  if (profile.preferred_username) {
    const rows = await db
      .select({ userId: serverUsers.userId, serverId: serverUsers.serverId })
      .from(serverUsers)
      .where(
        and(
          eq(sql`lower(${serverUsers.username})`, profile.preferred_username.toLowerCase()),
          isNull(serverUsers.removedAt)
        )
      );
    if (rows.length > 0) return uniqueMatch(rows, 'username');
  }
  return null;
}

// Spec step 3 for OIDC: the matched account passes canMemberLogin on its own server, or, for a
// match with no server, some live account of the identity does. The owner is never matched here,
// since a username match would hand the owner account to whoever holds that name on the IdP;
// better-auth links the owner itself, by users.email.
async function oidcMemberGate(userId: string, serverIds: string[] | null) {
  if (serverIds?.length === 0) return { ok: false, reason: 'refused' } as const;
  // The identity provider already proved who this is, so the person's own access answers first.
  const verdict = await identityGate(userId);
  if (verdict === 'unknown') return { ok: false, reason: 'refused' } as const;
  if (verdict === 'not-permitted') return { ok: false, reason: 'not-permitted' } as const;
  const rows = await db
    .select({ serverId: serverUsers.serverId })
    .from(serverUsers)
    .innerJoin(users, eq(users.id, serverUsers.userId))
    .where(
      and(
        eq(serverUsers.userId, userId),
        isNull(serverUsers.removedAt),
        ne(users.role, 'owner'),
        serverIds ? inArray(serverUsers.serverId, serverIds) : undefined
      )
    );
  let notPermittedSomewhere = false;
  for (const row of rows) {
    const gate = await canMemberLogin(userId, row.serverId);
    if (gate.ok) return gate;
    if (gate.reason === 'not-permitted') notPermittedSomewhere = true;
  }
  return { ok: false, reason: notPermittedSomewhere ? 'not-permitted' : 'refused' } as const;
}

/**
 * Every OIDC sign-in, including one whose flow began before the owner switched OIDC off. A linked
 * member also needs a server the gates still allow.
 */
export async function assertOidcSignInAllowed(userId: string): Promise<void> {
  if (!(await usableLoginMethods()).oidc) throw refused();
  const owner = await getOwnerUser();
  if (owner?.id === userId) return;
  const gate = await oidcMemberGate(userId, null);
  if (!gate.ok) throw memberGateError(gate);
}

/**
 * Runs from the OIDC provider's mapProfileToUser, which better-auth awaits after verifying the ID
 * token and before it looks the account up by (oidc, sub). A row written here is the account
 * better-auth then finds and signs in, through the session create hook like any other login.
 *
 * 'hide' when better-auth must not be given the profile email: unlinked, it would look the email
 * up in users and answer account_not_linked for a member's address, which tells the browser the
 * address belongs to someone here. 'not-permitted' when the profile matched a person the rule
 * keeps out. 'keep' leaves the email alone, so the owner's own address is linked by better-auth.
 */
export async function linkOidcMember(
  profile: Record<string, unknown>
): Promise<'keep' | 'hide' | 'not-permitted'> {
  const sub = typeof profile.sub === 'string' ? profile.sub : '';
  if (!sub) return 'keep';
  const [linked] = await db
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(and(eq(authAccounts.providerId, 'oidc'), eq(authAccounts.accountId, sub)))
    .limit(1);
  const owner = linked ? null : await getOwnerUser();
  if (!owner) return 'keep';

  const email = typeof profile.email === 'string' ? profile.email : null;
  const match = await findMemberForOidc({
    email,
    preferred_username:
      typeof profile.preferred_username === 'string' ? profile.preferred_username : null,
  });
  const gate = match ? await oidcMemberGate(match.userId, match.serverIds) : null;
  if (gate && !gate.ok && gate.reason === 'not-permitted') return 'not-permitted';
  if (!match || !gate?.ok) {
    return email && email.toLowerCase() !== owner.email?.toLowerCase() ? 'hide' : 'keep';
  }

  await db
    .insert(authAccounts)
    .values({ id: randomUUID(), providerId: 'oidc', accountId: sub, userId: match.userId })
    .onConflictDoNothing({ target: [authAccounts.providerId, authAccounts.accountId] });
  log.info('OIDC account linked to a member', { userId: match.userId });
  return 'keep';
}
