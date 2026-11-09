import { APIError } from 'better-auth/api';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { SIGN_IN_ERROR_CODES, canLogin, isStaff, type LoginMethods } from '@tracearr/shared';
import { db } from '../db/client.js';
import { authAccounts, servers, serverUsers, users } from '../db/schema.js';
import { getOwnerUser } from '../services/userService.js';
import { getSetting } from '../services/settings.js';
import { isClaimCodeEnabled, validateClaimCode } from '../utils/claimCode.js';
import { createLogger } from '../utils/logger.js';
import { oidcConfigured } from './oidcEnv.js';

const logger = createLogger('auth');

export const MEMBER_LOGIN_REFUSED = 'Sign-in is not available for this account.';
export const MEMBER_NOT_PERMITTED =
  'You are not permitted to sign in. Please contact the server owner.';

// The OAuth callback turns an APIError into its error redirect only when the body has a code;
// without one the browser lands on raw JSON at the callback URL.
export function refused(): APIError {
  return new APIError('FORBIDDEN', {
    code: SIGN_IN_ERROR_CODES.refused,
    message: MEMBER_LOGIN_REFUSED,
  });
}

// Only for a person whose credentials the media server, the identity provider or a Tracearr
// password already accepted, so it tells nobody guessing anything.
export function notPermitted(): APIError {
  return new APIError('FORBIDDEN', {
    code: SIGN_IN_ERROR_CODES.notPermitted,
    message: MEMBER_NOT_PERMITTED,
  });
}

// The same refusal as every gate, so a sign-in by someone with no identity here reads the same
// as one by an identity the gates turn away.
export async function assertSignupAllowed(): Promise<void> {
  if (await getOwnerUser()) throw refused();
}

export function assertClaimCode(claimCode: string | undefined): void {
  if (!isClaimCodeEnabled()) return;
  if (!claimCode || !validateClaimCode(claimCode)) {
    throw new APIError('FORBIDDEN', {
      message: 'Claim code is required for first-time setup',
    });
  }
}

// /sign-in/social handles both first-time signup and returning login, so the
// code is only required while the instance is ownerless.
export async function assertOAuthSignupClaimCode(claimCode: string | undefined): Promise<void> {
  const owner = await getOwnerUser();
  if (owner) return;
  assertClaimCode(claimCode);
}

type Identity = Pick<typeof users.$inferSelect, 'role' | 'loginAccess'>;

/**
 * The one sign-in rule for everyone but the owner, whatever the method: allow lets the person in,
 * default follows the global member switch, and block or any other value keeps them out.
 */
export function nonOwnerMayLogin(identity: Identity, memberSwitch: boolean): boolean {
  if (!canLogin(identity.role) || identity.role === 'owner') return false;
  if (identity.loginAccess === 'allow') return true;
  return identity.loginAccess === 'default' && memberSwitch;
}

/** The same rule through one media server: only allow skips the server's own member switch. */
export function nonOwnerMayLoginThrough(
  identity: Identity,
  memberSwitch: boolean,
  serverAllowsMembers: boolean
): boolean {
  return (
    nonOwnerMayLogin(identity, memberSwitch) &&
    (identity.loginAccess === 'allow' || serverAllowsMembers)
  );
}

async function loadIdentity(userId: string): Promise<Identity | undefined> {
  const [row] = await db
    .select({ role: users.role, loginAccess: users.loginAccess })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

export type IdentityVerdict = 'owner' | 'allowed' | 'not-permitted' | 'unknown';

export async function identityGate(userId: string): Promise<IdentityVerdict> {
  const identity = await loadIdentity(userId);
  if (!identity) return 'unknown';
  if (identity.role === 'owner') return 'owner';
  const { member } = await getSetting('loginMethods');
  return nonOwnerMayLogin(identity, member) ? 'allowed' : 'not-permitted';
}

/** Passwords are an owner and admin sign-in; anyone else's leftover credential opens nothing. */
export async function assertPasswordSignInRole(userId: string): Promise<void> {
  const identity = await loadIdentity(userId);
  if (!identity || !isStaff(identity.role)) throw refused();
}

/** Runs as a session is created, which every method does only after the credentials checked out. */
export async function assertUserCanLogin(userId: string): Promise<void> {
  const verdict = await identityGate(userId);
  if (verdict === 'unknown') throw refused();
  if (verdict === 'not-permitted') throw notPermitted();
}

// The owner previews what an admin or member sees; no member credential is used, so the login
// gates do not apply. disabled and pending identities resolve to no session, so they are refused.
export async function assertCanBeImpersonated(userId: string): Promise<void> {
  const identity = await loadIdentity(userId);
  if (identity?.role !== 'admin' && identity?.role !== 'member') throw refused();
}

// The session already exists, so a failed counter write must not undo the sign-in.
export async function recordSignIn(userId: string): Promise<void> {
  try {
    await db
      .update(users)
      .set({ loginCount: sql`${users.loginCount} + 1`, lastLoginAt: sql`now()` })
      .where(eq(users.id, userId));
  } catch {
    logger.warn('sign-in count write failed', { userId });
  }
}

export type MemberGate = { ok: true } | { ok: false; reason: 'refused' | 'not-permitted' };

/**
 * A server account that can still sign its person in: not removed, not disabled, and on a server
 * that is not historical. The query has to join servers.
 */
export const liveServerAccount = and(
  isNull(serverUsers.removedAt),
  eq(serverUsers.isDisabled, false),
  isNull(servers.historicalAt)
);

/**
 * Called once the media server accepted the person. An account that is gone, disabled or on a
 * historical server is refused like a wrong password; a proven person the rule keeps out is told so.
 */
export async function canMemberLogin(userId: string, serverId: string): Promise<MemberGate> {
  const identity = await loadIdentity(userId);
  if (!identity) return { ok: false, reason: 'refused' };
  if (identity.role === 'owner') return { ok: true };
  const [account] = await db
    .select({ serverAllowsMembers: servers.allowMemberLogin })
    .from(serverUsers)
    .innerJoin(servers, eq(servers.id, serverUsers.serverId))
    .where(
      and(eq(serverUsers.userId, userId), eq(serverUsers.serverId, serverId), liveServerAccount)
    )
    .limit(1);
  if (!account) return { ok: false, reason: 'refused' };
  const { member } = await getSetting('loginMethods');
  return nonOwnerMayLoginThrough(identity, member, account.serverAllowsMembers)
    ? { ok: true }
    : { ok: false, reason: 'not-permitted' };
}

/** The refusal a failed MemberGate turns into. */
export function memberGateError(gate: { ok: false; reason: 'refused' | 'not-permitted' }) {
  return gate.reason === 'not-permitted' ? notPermitted() : refused();
}

interface OwnerCredentials {
  password: boolean;
  plex: boolean;
  oidc: boolean;
}

const NO_CREDENTIALS: OwnerCredentials = { password: false, plex: false, oidc: false };

// Drizzle leaves columns unqualified in a select list, so these subqueries name their own.
const hasPassword = sql<boolean>`exists (
  select 1 from auth_accounts aa
  where aa.user_id = users.id and aa.provider_id = 'credential' and aa.password is not null
)`;

// Mirrors the owner lookups in plexPlugin's /plex/check-pin, which run the other way (a
// presented plex.tv id to a user): an allowLogin plex_accounts row, users.plex_account_id, or a
// Plex server_users row whose external_id is a plex.tv id. A synced row carries plex_account_id,
// and external_id equals it except on the server owner's own row, which is '1'. A row the poller
// created and no sync has reached has no plex_account_id; its external_id is the session user id,
// a plex.tv id for everyone but the server owner, who is again '1'.
const hasPlexLogin = sql<boolean>`(
  users.plex_account_id is not null
  or exists (
    select 1 from plex_accounts pa where pa.user_id = users.id and pa.allow_login
  )
  or exists (
    select 1 from server_users su join servers s on s.id = su.server_id
    where su.user_id = users.id and s.type = 'plex'
      and (
        su.external_id = su.plex_account_id
        or (su.plex_account_id is null and su.external_id <> '1')
      )
  )
)`;

const hasOidcLogin = sql<boolean>`exists (
  select 1 from auth_accounts aa where aa.user_id = users.id and aa.provider_id = 'oidc'
)`;

// better-auth verifies passwords against the credential auth_accounts row; users.password_hash
// is a legacy copy that owners created through better-auth sign-up never get.
async function ownerCredentials(ownerId: string): Promise<OwnerCredentials> {
  const [row] = await db
    .select({ password: hasPassword, plex: hasPlexLogin, oidc: hasOidcLogin })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  return row ?? NO_CREDENTIALS;
}

function ownerCanSignIn(
  methods: Pick<LoginMethods, 'local' | 'plex' | 'oidc'>,
  credentials: OwnerCredentials
): boolean {
  return (
    (methods.local && credentials.password) ||
    (methods.plex && credentials.plex) ||
    (methods.oidc && oidcConfigured && credentials.oidc)
  );
}

/**
 * A live server someone could sign in through: its member switch is on, or a person set to Allow
 * has a live, enabled account on it. Any other server answers every member endpoint with the
 * plain refusal before a credential is passed on to it, so it cannot be used to relay guesses.
 */
export const openToMemberSignIn = sql`(
  ${servers.historicalAt} is null and (
    ${servers.allowMemberLogin}
    or exists (
      select 1 from ${serverUsers} join ${users} on ${users.id} = ${serverUsers.userId}
      where ${serverUsers.serverId} = ${servers.id}
        and ${liveServerAccount}
        and ${users.role} in ('admin', 'member')
        and ${users.loginAccess} = 'allow'
    )
  )
)`;

/** SSO-only closes every Plex, Jellyfin and Emby sign-in except the owner's own Plex account. */
export async function mediaSignInClosed(): Promise<boolean> {
  return (await getSetting('memberSsoOnly')) === true;
}

export async function hasOpenServer(type: 'plex' | 'jellyfin' | 'emby'): Promise<boolean> {
  if (await mediaSignInClosed()) return false;
  const [server] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.type, type), openToMemberSignIn))
    .limit(1);
  return !!server;
}

export async function usableLoginMethods(): Promise<LoginMethods> {
  const [methods, owner, [memberServer], [anyPassword], mediaClosed] = await Promise.all([
    getSetting('loginMethods'),
    getOwnerUser(),
    db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.allowMemberLogin, true), isNull(servers.historicalAt)))
      .limit(1),
    db
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(and(eq(authAccounts.providerId, 'credential'), isNotNull(authAccounts.password)))
      .limit(1),
    mediaSignInClosed(),
  ]);
  const credentials = owner ? await ownerCredentials(owner.id) : NO_CREDENTIALS;
  // The save-time guard cannot see an OIDC env var removed or a Plex row lost later. When the
  // switches leave the owner no way in, the owner's own password, Plex and OIDC logins still work.
  const ownerLockedOut = !!owner && !ownerCanSignIn(methods, credentials);
  return {
    local: (methods.local && !!anyPassword) || (ownerLockedOut && credentials.password),
    plex: (methods.plex || ownerLockedOut) && credentials.plex,
    oidc: oidcConfigured && (methods.oidc || (ownerLockedOut && credentials.oidc)),
    // The login page offers every switched-on server whatever the global switch says; the rule,
    // once the media server accepted the person, decides who gets in and who is told no.
    member: !!memberServer && !mediaClosed,
  };
}

export async function assertOwnerKeepsALoginMethod(
  next: Partial<Pick<LoginMethods, 'local' | 'plex' | 'oidc'>>
): Promise<void> {
  const owner = await getOwnerUser();
  if (!owner) return;
  const current = await getSetting('loginMethods');
  const turnsSomethingOff = (['local', 'plex', 'oidc'] as const).some(
    (method) => next[method] === false && current[method]
  );
  if (!turnsSomethingOff) return;
  if (!ownerCanSignIn({ ...current, ...next }, await ownerCredentials(owner.id))) {
    throw new APIError('BAD_REQUEST', {
      message: 'That would leave the owner with no way to sign in.',
    });
  }
}
