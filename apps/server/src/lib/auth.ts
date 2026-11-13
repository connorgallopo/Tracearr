import { randomUUID } from 'node:crypto';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  username as usernamePlugin,
  admin as adminPlugin,
  bearer,
  genericOAuth,
} from 'better-auth/plugins';
import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context';
import { createAuthMiddleware, APIError, isAPIError } from 'better-auth/api';
import { expireCookie } from 'better-auth/cookies';
import type { Redis } from 'ioredis';
import { STAFF_ROLES } from '@tracearr/shared';
import { db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { fetchJson } from '../utils/http.js';
import { createLogger } from '../utils/logger.js';
import { getOwnerUser } from '../services/userService.js';
import { roles } from './access.js';
import { requireBetterAuthSecret } from './env.js';
import {
  assertSignupAllowed,
  assertClaimCode,
  assertCanBeImpersonated,
  assertUserCanLogin,
  assertOAuthSignupClaimCode,
  assertPasswordSignInRole,
  hasOpenServer,
  notPermitted,
  recordSignIn,
  refused,
  usableLoginMethods,
} from './authGuards.js';
import { oidcConfigured, oidcDiscoveryUrl, oidcEnv } from './oidcEnv.js';
import { getRedis, closeRedis, INCREMENT_SCRIPT } from './redisShared.js';
import { plexPlugin } from './plexPlugin.js';
import { memberLoginPlugin } from './memberLoginPlugin.js';
import { assertOidcSignInAllowed, linkOidcMember, memberStillValid } from './memberLogin.js';
import { logoutMemberTokens, revokeSessionsForUsers } from './revoke.js';
import { betterAuthBasePath } from './basePath.js';
import { configuredOrigins } from './origins.js';

const logger = createLogger('auth');

/**
 * The only header Better Auth reads the client IP from
 * (advanced.ipAddress.ipAddressHeaders below). toWebRequest() in
 * betterAuthRequest.ts stamps it from Fastify's trustProxy-resolved
 * request.ip, overwriting any inbound copy so clients cannot pick their own
 * rate-limit bucket or forge session.ipAddress.
 */
export const CLIENT_IP_HEADER = 'x-tracearr-client-ip';

// Lua instead of GETDEL (6.2+) for the reason INCREMENT_SCRIPT gives.
const GET_AND_DELETE_SCRIPT = `local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value`;

/**
 * Per-request trusted origins for Better Auth's CSRF origin check.
 *
 * With no baseURL configured, Better Auth trusts only the origin it derives
 * from the request URL the shim builds (scheme included). Behind an HTTPS
 * proxy that does not forward x-forwarded-proto that derived origin is
 * http://host while the browser sends Origin: https://host, and every login
 * fails 403 INVALID_ORIGIN. Trusting BOTH schemes of the request's OWN host
 * fixes that without any user-side change. It only relaxes the scheme
 * distinction on the same host: a cross-site attacker page sends an Origin
 * with a different host and still fails the exact-match compare. The Origin
 * header itself must never be added here. Scheme security against an active
 * downgrade is owned by TLS/HSTS and the cookie Secure flag, not by this
 * check.
 *
 * Better Auth also invokes this at construction time with request ===
 * undefined (create-context), so the request guard is load-bearing.
 */
export function trustedOriginsForRequest(request?: Request): string[] {
  // better-auth reads '*' as every origin, which would switch its origin and callbackURL checks off.
  const origins = configuredOrigins();
  if (request) {
    try {
      const { host } = new URL(request.url);
      origins.push(`http://${host}`, `https://${host}`);
    } catch {
      // unparseable request URL: fall back to the static list
    }
  }
  return origins;
}

/** The raw session token in an Authorization header, signed (token.signature) or not. */
function bearerSessionToken(header: string | null | undefined): string | undefined {
  if (!header || header.slice(0, 7).toLowerCase() !== 'bearer ') return undefined;
  const value = header.slice(7).trim();
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // an undecodable header is looked up as sent
  }
  return decoded.split('.')[0] || undefined;
}

/**
 * The username plugin resolves sign-in (and username-taken checks) with an
 * unconstrained findOne on users.username. The users table also holds member
 * rows synced from media servers with arbitrary usernames, so a member whose
 * stored username equals a login username can be the row findOne returns and
 * silently break the real user's username/password login (the member has no
 * credential account, and the session hook rejects non-login roles anyway).
 * A username is only a login identifier for owner and admin, exactly the
 * scope of the users_login_username_unique partial index, so every
 * user-by-username lookup is narrowed to those roles here. Members sign in
 * through their media server, never by Tracearr username. The plugin offers
 * no option for this, hence the adapter wrap. Email is narrowed the same way,
 * but only for password sign-in: OIDC matches members by email too.
 */
function withLoginScopedUsernameLookup(
  factory: ReturnType<typeof drizzleAdapter>
): ReturnType<typeof drizzleAdapter> {
  return (options) => {
    const adapter = factory(options);
    const findOne: typeof adapter.findOne = (data) => {
      const byEmailForPassword =
        data.where.some((w) => w.field === 'email') &&
        tryGetCurrentAuthEndpointContext()?.path === '/sign-in/email';
      if (
        data.model === 'user' &&
        (data.where.some((w) => w.field === 'username') || byEmailForPassword) &&
        !data.where.some((w) => w.field === 'role')
      ) {
        return adapter.findOne({
          ...data,
          where: [
            ...data.where,
            { field: 'role', operator: 'in', value: [...STAFF_ROLES], connector: 'AND' },
          ],
        });
      }
      return adapter.findOne(data);
    };
    return { ...adapter, findOne };
  };
}

// The only writes a session viewing as another user may make: leaving, either way.
const IMPERSONATION_WRITES = new Set(['/sign-out', '/admin/stop-impersonating']);

// better-auth's own account endpoints. The web uses none of them; an admin or member reaching
// them could rename themselves, read live session tokens or probe the owner's username, so only
// the owner's own session gets through.
const OWNER_ONLY_ACCOUNT_PATHS = new Set([
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/update-user',
  '/change-email',
  '/change-password',
  '/is-username-available',
  '/link-social',
  '/unlink-account',
]);

// The admin plugin is here for the owner's masquerade. Its other endpoints (set-role,
// update-user, ban, create, remove, set-user-password, session revokes, user and session
// listings) would skip the revoke, scope and socket rules PATCH /users/:id applies, and
// nothing in Tracearr calls them.
const ADMIN_PLUGIN_ALLOWED = new Set(['/admin/impersonate-user', '/admin/stop-impersonating']);

// The username plugin rejects anything outside these bounds on the OAuth callback; the plugin
// does not export its defaults, so they are passed to it explicitly below.
const USERNAME_MIN = 3;
const USERNAME_MAX = 30;
const usernameValidator = (username: string) => /^[a-zA-Z0-9_.]+$/.test(username);

const UNMATCHED_OIDC_EMAIL = 'unmatched@member-login.invalid';
const NOT_PERMITTED_OIDC_EMAIL = 'not-permitted@member-login.invalid';

export function oidcUsername(profile: Record<string, unknown>): string {
  const preferred =
    typeof profile.preferred_username === 'string' ? profile.preferred_username : '';
  const email = typeof profile.email === 'string' ? profile.email : '';
  const candidates = [preferred, email.split('@')[0] ?? ''].map((c) =>
    c
      .trim()
      .replace(/[^a-zA-Z0-9_.]/g, '_')
      .slice(0, USERNAME_MAX)
  );
  return candidates.find((c) => c.length >= USERNAME_MIN) ?? 'owner';
}

type OidcPlugin = ReturnType<typeof genericOAuth>;

// The authorize and token requests send redirect_uri from the provider's callbackPath. Pointing it
// at the 1.6 address keeps IdPs that only have that URI registered working; routes/auth/index.ts
// forwards the redirect to the real /callback/oidc handler.
export function oidcAtLegacyCallback(plugin: OidcPlugin): OidcPlugin {
  const init = plugin.init;
  return {
    ...plugin,
    init: async (ctx) => {
      const result = await init(ctx);
      for (const provider of result?.context?.socialProviders ?? []) {
        if (provider.id === 'oidc') provider.callbackPath = '/oauth2/callback/oidc';
      }
      return result;
    },
  };
}

export const authUserOptions = {
  fields: { image: 'thumbnail' },
  additionalFields: {
    role: { type: 'string', required: false, defaultValue: 'member', input: false },
    // Never in a better-auth response: members do not see their trust or violations, and the
    // public API key goes out only through its own owner route.
    aggregateTrustScore: {
      type: 'number',
      required: false,
      defaultValue: 100,
      input: false,
      returned: false,
    },
    totalViolations: {
      type: 'number',
      required: false,
      defaultValue: 0,
      input: false,
      returned: false,
    },
    apiToken: { type: 'string', required: false, input: false, returned: false },
  },
} satisfies BetterAuthOptions['user'];

function recordImpersonation(ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]) {
  const ip = ctx.headers?.get(CLIENT_IP_HEADER) ?? null;
  if (ctx.path === '/admin/impersonate-user') {
    const started = ctx.context.newSession;
    logger.info('impersonation started', {
      ownerId: started?.session.impersonatedBy,
      targetId: started?.user.id,
      ip,
    });
    return;
  }
  // stop-impersonating restores the owner's cookie but leaves dont_remember set, so the
  // owner's session stops being refreshed after the next cycle (#10734).
  expireCookie(ctx, ctx.context.authCookies.dontRememberToken);
  logger.info('impersonation stopped', {
    ownerId: ctx.context.newSession?.user.id,
    targetId: ctx.context.session?.user.id,
    ip,
  });
}

function buildAuth(redis: Redis, withOidc: boolean) {
  const prefix = process.env.REDIS_PREFIX ?? '';
  const rkey = (k: string) => `${prefix}tracearr:ba:${k}`;

  return betterAuth({
    // Better Auth builds its baseURL, and from it the OIDC redirect_uri, as
    // request origin plus this path, so it must include BASE_PATH.
    basePath: betterAuthBasePath(),
    secret: requireBetterAuthSecret(),
    trustedOrigins: trustedOriginsForRequest,
    database: withLoginScopedUsernameLookup(
      drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: schema.users,
          session: schema.authSessions,
          account: schema.authAccounts,
          verification: schema.authVerifications,
        },
      })
    ),
    advanced: {
      // Better Auth decides the cookie Secure flag (and the __Secure- name
      // prefix) once at init from NODE_ENV, so in production every cookie
      // would be Secure and browsers would drop it on plain-http LAN
      // deployments. Pin it off; createBetterAuthHandler appends Secure per
      // request when the derived scheme is https, so HTTPS deployments still
      // get the flag. http gets a cookie without Secure, same as the legacy
      // cookie system.
      useSecureCookies: false,
      ipAddress: {
        ipAddressHeaders: [CLIENT_IP_HEADER],
      },
      database: {
        // users.id is a uuid column; the default id generator mints a nanoid
        // that Postgres rejects (22P02). A function generateId keeps Better
        // Auth minting the id in app code (unlike the "uuid" literal, which on
        // pg defers to a DB default the text-id auth_ tables don't have) and
        // emits a UUID valid for both the uuid and text id columns.
        generateId: () => randomUUID(),
      },
    },
    emailAndPassword: {
      enabled: true,
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    user: authUserOptions,
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      storeSessionInDatabase: true,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    account: {
      accountLinking: {
        enabled: true,
        // Kept deliberately. Authentik hardcodes email_verified:false since
        // 2025.10 and Keycloak defaults it false for admin-created users, so
        // requiring the claim breaks OIDC linking on the IdPs self-hosters
        // actually run. The operator owns both ends here; a shared or
        // self-registration IdP is the case this does not defend against.
        trustedProviders: ['oidc'],
      },
    },
    secondaryStorage: {
      get: async (key) => redis.get(rkey(key)),
      set: async (key, value, ttl) => {
        if (ttl) await redis.set(rkey(key), value, 'EX', ttl);
        else await redis.set(rkey(key), value);
      },
      delete: async (key) => {
        await redis.del(rkey(key));
      },
      increment: async (key, ttl) => {
        const value = await redis.eval(INCREMENT_SCRIPT, 1, rkey(key), ttl);
        return Number(value);
      },
      getAndDelete: async (key) =>
        (await redis.eval(GET_AND_DELETE_SCRIPT, 1, rkey(key))) as string | null,
    },
    rateLimit: {
      enabled: true,
      storage: 'secondary-storage',
      customRules: {
        '/jellyfin/sign-in': { window: 60, max: 10 },
        '/emby/sign-in': { window: 60, max: 10 },
        '/jellyfin/quick-connect/initiate': { window: 60, max: 10 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            // Set only by mapProfileToUser after the identity provider verified the profile.
            if (ctx?.path === '/callback/:id' && user.email === NOT_PERMITTED_OIDC_EMAIL) {
              throw notPermitted();
            }
            await assertSignupAllowed();
            return { data: { ...user, role: 'owner', emailVerified: true } };
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            if (session.impersonatedBy) {
              await assertCanBeImpersonated(session.userId);
            } else {
              if (ctx?.path === '/sign-in/email' || ctx?.path === '/sign-in/username') {
                await assertPasswordSignInRole(session.userId);
              }
              await assertUserCanLogin(session.userId);
              // OIDC is the only social provider, so a session minted on these paths is an OIDC
              // sign-in, and the per-server gates the link checked must still hold.
              if (ctx?.path === '/callback/:id' || ctx?.path === '/sign-in/social') {
                await assertOidcSignInAllowed(session.userId);
              }
            }
            return { data: session };
          },
          after: async (session) => {
            if (session.impersonatedBy) return;
            await recordSignIn(session.userId);
          },
        },
        // The daily refresh. getSession sets context.session before it calls updateSession, and
        // returning false makes it clear the cookie and answer 401.
        update: {
          before: async (data, ctx) => {
            const current = ctx?.context.session?.session;
            if (!current) return;
            // A view-as session ends when it was set to, however it is presented.
            if (current.impersonatedBy) return { data: { ...data, expiresAt: current.expiresAt } };
            if (await memberStillValid(current.userId)) return;
            await revokeSessionsForUsers([current.userId]);
            return false;
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // bearer() replaces the session cookie with the Authorization token only after this hook,
        // so the endpoint runs as the bearer session when there is one. Both are looked up: a
        // view-as session must not ride along on either side of the pair.
        const bearerToken = bearerSessionToken(ctx.headers?.get('authorization'));
        const findSessions = async () => {
          const cookieToken = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret
          );
          const [byBearer, byCookie] = await Promise.all([
            bearerToken ? ctx.context.internalAdapter.findSession(bearerToken) : null,
            cookieToken && cookieToken !== bearerToken
              ? ctx.context.internalAdapter.findSession(cookieToken)
              : null,
          ]);
          return { current: byBearer ?? byCookie, presented: [byBearer, byCookie] };
        };
        let sessions: ReturnType<typeof findSessions> | undefined;
        const currentSession = async () => (await (sessions ??= findSessions())).current;
        const presented = async () => (await (sessions ??= findSessions())).presented;
        if (bearerToken && (await presented()).some((found) => found?.session.impersonatedBy)) {
          throw new APIError('FORBIDDEN', {
            message: 'Viewing as another user needs a browser session.',
          });
        }
        if (OWNER_ONLY_ACCOUNT_PATHS.has(ctx.path)) {
          const current = await currentSession();
          const role = (current?.user as { role?: string } | undefined)?.role;
          if (current?.session.impersonatedBy || role !== 'owner') {
            throw new APIError('NOT_FOUND', { message: 'Not found' });
          }
        }
        if (ctx.path.startsWith('/admin/') && !ADMIN_PLUGIN_ALLOWED.has(ctx.path)) {
          throw new APIError('FORBIDDEN', { message: 'Manage people from the user page.' });
        }
        if (
          ctx.request &&
          ctx.request.method !== 'GET' &&
          !IMPERSONATION_WRITES.has(ctx.path) &&
          (await currentSession())?.session.impersonatedBy
        ) {
          throw new APIError('FORBIDDEN', { message: 'Viewing as another user is read-only' });
        }
        if (ctx.path === '/sign-up/email') {
          assertClaimCode((ctx.body as { claimCode?: string } | undefined)?.claimCode);
        }
        if (ctx.path === '/sign-in/social') {
          const body = ctx.body as
            { provider?: string; additionalData?: { claimCode?: string } } | undefined;
          if (body?.provider === 'oidc') {
            if (oidcConfigured && !ctx.context.socialProviders.some((p) => p.id === 'oidc')) {
              void rebuildAuthForOidc();
              throw new APIError('SERVICE_UNAVAILABLE', {
                message: 'The sign-in provider could not be reached. Try again in a moment.',
              });
            }
            if (!(await usableLoginMethods()).oidc) throw refused();
            await assertOAuthSignupClaimCode(body.additionalData?.claimCode);
          }
        }
        if (ctx.path === '/sign-in/email' || ctx.path === '/sign-in/username') {
          if (!(await usableLoginMethods()).local) throw refused();
        }
        // A member signs in through a Plex server open to them, which an Allow person can make one
        // whose member switch is off.
        if (ctx.path === '/plex/check-pin') {
          if (!(await usableLoginMethods()).plex && !(await hasOpenServer('plex'))) {
            if (await getOwnerUser()) throw refused();
          }
        }
        if (ctx.path === '/sign-out') {
          const current = await currentSession();
          // A masquerade holds the member's session, not the member's device.
          if (current && !current.session.impersonatedBy) {
            const userId = current.user.id;
            await logoutMemberTokens(userId).catch(() => {
              logger.warn('sign-out could not post the server-side logout', { userId });
            });
          }
        }
        // bearer() rebuilds the session cookie from this header on every request, so a bearer
        // client would mint an impersonation session and keep acting as the owner (#10819).
        if (ctx.path === '/admin/impersonate-user' && ctx.headers?.get('authorization')) {
          throw new APIError('BAD_REQUEST', {
            message: 'Viewing as another user needs a browser session.',
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // A listed token is a live session; nothing that reads this list needs one.
        if (ctx.path === '/list-sessions' && Array.isArray(ctx.context.returned)) {
          return ctx.json(
            (ctx.context.returned as Record<string, unknown>[]).map(
              ({ token: _token, ...session }) => session
            )
          );
        }
        if (
          (ctx.path === '/admin/impersonate-user' || ctx.path === '/admin/stop-impersonating') &&
          !isAPIError(ctx.context.returned)
        ) {
          recordImpersonation(ctx);
        }
        return undefined;
      }),
    },
    plugins: [
      usernamePlugin({
        minUsernameLength: USERNAME_MIN,
        maxUsernameLength: USERNAME_MAX,
        usernameValidator,
      }),
      adminPlugin({ roles, adminRoles: ['owner'] }),
      bearer(),
      plexPlugin(),
      memberLoginPlugin(),
      ...(oidcConfigured && withOidc
        ? [
            oidcAtLegacyCallback(
              genericOAuth({
                config: [
                  {
                    providerId: 'oidc',
                    clientId: oidcEnv.clientId!,
                    clientSecret: oidcEnv.clientSecret!,
                    discoveryUrl: oidcDiscoveryUrl,
                    scopes: ['openid', 'email', 'profile'],
                    pkce: true,
                    // Without a post-logout redirect URI registered at the IdP, its logout
                    // endpoint strands the browser on the IdP's own page.
                    disableProviderLogout: true,
                    mapProfileToUser: async (profile) => {
                      const outcome = await linkOidcMember(profile);
                      // Either address matches no user, so better-auth goes on to user creation,
                      // which the create hook refuses: not permitted for a person the rule keeps
                      // out, otherwise the same answer as every other gate.
                      const email = {
                        keep: {},
                        hide: { email: UNMATCHED_OIDC_EMAIL },
                        'not-permitted': { email: NOT_PERMITTED_OIDC_EMAIL },
                      }[outcome];
                      return { username: oidcUsername(profile), ...email };
                    },
                  },
                ],
              })
            ),
          ]
        : []),
    ],
  });
}

type Auth = ReturnType<typeof buildAuth>;

let authInstance: Auth | null = null;

let oidcRebuild: Promise<void> | null = null;
let oidcReachable = true;

async function probeOidc(): Promise<boolean> {
  try {
    await fetchJson(oidcDiscoveryUrl, { service: 'oidc', timeout: 5000 });
    return true;
  } catch (error) {
    logger.warn(
      `OIDC discovery at ${oidcDiscoveryUrl} is unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Run once at startup, before the first getAuth(). Discovery in plugin init has no timeout, so
 * an IdP that accepts the connection but never answers would hang every auth request; with the
 * probe failing, the first instance is built without OIDC and rebuildAuthForOidc adds it later.
 */
export async function probeOidcAtStartup(): Promise<void> {
  if (oidcConfigured) oidcReachable = await probeOidc();
}

// better-auth 1.7 runs OIDC discovery once in plugin init with no timeout, so the rebuild
// happens off to the side and the live instance keeps serving until the candidate has 'oidc'.
function rebuildAuthForOidc(): Promise<void> {
  oidcRebuild ??= (async () => {
    const live = authInstance;
    try {
      if (!(await probeOidc())) return;
      const candidate = buildAuth(getRedis(), true);
      const context = await candidate.$context;
      if (context.socialProviders.some((p) => p.id === 'oidc')) {
        oidcReachable = true;
        if (authInstance === live) authInstance = candidate;
      }
    } catch {
      // the next oidc sign-in attempt retries
    } finally {
      oidcRebuild = null;
    }
  })();
  return oidcRebuild;
}

/**
 * Returns the singleton Better Auth instance, constructing it on first call.
 * Must not run at module load time - Phase 1 startup (building the Fastify app)
 * has to succeed without DB/Redis.
 */
export function getAuth(): Auth {
  if (authInstance) return authInstance;

  authInstance = buildAuth(getRedis(), oidcReachable);
  return authInstance;
}

/**
 * Drops the auth instance so the next getAuth() rebuilds it, and quits the
 * fallback Redis client if one was created. The Fastify plugin's client is left
 * alone - its own onClose hook owns it.
 */
export async function closeAuth(): Promise<void> {
  await closeRedis();
  authInstance = null;
}
