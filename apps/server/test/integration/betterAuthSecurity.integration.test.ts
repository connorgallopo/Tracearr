/**
 * Better Auth adversarial security tests (integration)
 *
 * Drives the REAL Better Auth handler, the real dual-verify auth plugin, and
 * the real mobile routes against a real database and a real Redis instance
 * (no mocks for the pieces under test - only media servers/push would be
 * mocked, and none of these flows touch either). Lives under test/integration
 * (not src/**\/*.security.test.ts) because that config's setup file
 * (src/test/setup.ts) never points at the test-stack DATABASE_URL/REDIS_URL -
 * it hardcodes a different DB on the dev Postgres port - and its CI job runs
 * with no DB/Redis services at all. Real-state auth security assertions need
 * the integration setup (src/test/setup.integration.ts), exactly like the
 * existing betterAuthRevocation/betterAuthSignup/mobile integration tests.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { username as usernamePlugin } from 'better-auth/plugins';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { API_BASE_PATH, type LoginAccess, type ServerType } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import {
  users,
  servers,
  serverUsers,
  authAccounts,
  authSessions,
  authVerifications,
  plexAccounts,
  mobileSessions,
} from '../../src/db/schema.js';
import { closeAuth, authUserOptions } from '../../src/lib/auth.js';
import { createBetterAuthHandler } from '../../src/lib/betterAuthRequest.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { resetSettingsCache, setSetting } from '../../src/services/settings.js';
import { hashPassword } from '../../src/utils/password.js';
import authPlugin from '../../src/plugins/auth.js';
import { authRoutes } from '../../src/routes/auth/index.js';
import { mobileRoutes } from '../../src/routes/mobile.js';
import { setupRoutes } from '../../src/routes/setup.js';
import { resolveSocketUser, checkMobileBlacklist } from '../../src/websocket/index.js';
import { enableLocalLoginCommand } from '../../scripts/lib/commands.js';
import { assertSignupAllowed } from '../../src/lib/authGuards.js';
import { JellyfinClient, PlexClient } from '../../src/services/mediaServer/index.js';
import { linkOidcMember } from '../../src/lib/memberLogin.js';
import { userRoutes } from '../../src/routes/users/index.js';
import { settingsRoutes } from '../../src/routes/settings.js';
import { debugRoutes } from '../../src/routes/debug.js';

/** Rebuilds a Cookie header from a set-cookie response array (name=value only). */
function cookieHeader(setCookie: string[]): string {
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

function setCookieArray(res: { headers: { 'set-cookie'?: string | string[] } }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

async function clearRedisPattern(pattern: string): Promise<void> {
  const redis = getRedis();
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(sensible);
  await app.register(fastifyCookie, { secret: 'test-cookie-secret-32-chars-long!' });
  await app.register(rateLimit, { max: 10000, timeWindow: '1 minute' });
  app.decorate('redis', getRedis());
  await app.register(authPlugin);

  // Mirrors index.ts: the Better Auth wildcard (via the shared production
  // handler), then the static legacy auth routes (which win over the wildcard
  // for their exact paths), then mobile.
  app.route({
    method: ['GET', 'POST'],
    url: `${API_BASE_PATH}/auth/*`,
    config: { rateLimit: false },
    handler: createBetterAuthHandler(),
  });
  await app.register(authRoutes, { prefix: `${API_BASE_PATH}/auth` });
  await app.register(mobileRoutes, { prefix: `${API_BASE_PATH}/mobile` });
  await app.register(setupRoutes, { prefix: `${API_BASE_PATH}/setup` });

  app.get('/protected', { preHandler: [app.authenticate] }, async (request) => ({
    userId: request.user.userId,
    role: request.user.role,
  }));

  app.get(
    '/protected-public-api',
    { preHandler: [app.authenticatePublicApi] },
    async (request) => ({
      userId: request.publicApiContext!.userId,
    })
  );

  return app;
}

/** Starts a Plex sign-in the way a browser does and polls it once with the handle it got. */
async function plexCheckPin(app: FastifyInstance) {
  const initiate = vi.spyOn(PlexClient, 'initiateOAuth').mockResolvedValue({
    pinId: 'fake-pin-id',
    authUrl: 'https://app.plex.tv/auth#?code=x',
  });
  try {
    const start = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/plex/initiate`,
      headers: { 'content-type': 'application/json', origin: 'http://localhost:80' },
      payload: {},
    });
    return await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/plex/check-pin`,
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:80',
        cookie: cookieHeader(setCookieArray(start)),
      },
      payload: { handle: start.json().handle },
    });
  } finally {
    initiate.mockRestore();
  }
}

async function signUpOwner(
  app: FastifyInstance,
  overrides: { email?: string; username?: string; password?: string } = {}
) {
  const email = overrides.email ?? `owner-${randomUUID()}@example.com`;
  const password = overrides.password ?? 'OwnerPassword!123';
  const username = overrides.username ?? `owner${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const res = await app.inject({
    method: 'POST',
    url: `${API_BASE_PATH}/auth/sign-up/email`,
    headers: { 'content-type': 'application/json' },
    payload: { email, password, name: 'Security Owner', username },
  });
  expect(res.statusCode).toBe(200);
  return { email, password, username, userId: res.json().user.id as string, res };
}

describe('better auth security (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    // Rate-limit counters live in Redis and are NOT reset by the per-test DB
    // truncation, so clear anything from a previous test that could bleed
    // into this one (the sign-in/sign-up special rule is shared per path).
    await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-in*`);
    await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-up*`);
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    // Pairing/rate-limit calls in these tests leave Redis keys behind
    // (tracearr:ba:*, tracearr:mobile:*, tracearr:mobile_refresh:*,
    // mobile_token_gen:*, tracearr:ratelimit:mobile:*) that would otherwise
    // survive long enough for the redis-prefix canary test to flag them as
    // unprefixed leaks. The mobile_refresh keys carry a 90-day TTL, so
    // without this cleanup they poison the shared test Redis across runs.
    const redis = getRedis();
    const prefix = process.env.REDIS_PREFIX ?? '';
    const patterns = [
      `${prefix}tracearr:ba:*`,
      `${prefix}tracearr:mobile:*`,
      `${prefix}tracearr:mobile_refresh:*`,
      `${prefix}mobile_token_gen:*`,
      `${prefix}tracearr:ratelimit:mobile:*`,
    ];
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
    await closeAuth();
  });

  it('session cookie is httpOnly and sameSite', async () => {
    const { res } = await signUpOwner(app);
    const cookies = setCookieArray(res);
    const sessionCookie = cookies.find((c) => c.includes('session_token'));

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
  });

  it('sign-in rotates the session token (no fixation)', async () => {
    const { email, password } = await signUpOwner(app);

    const firstSignIn = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });
    expect(firstSignIn.statusCode).toBe(200);
    const tokenA = firstSignIn.json().token as string;

    const secondSignIn = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });
    expect(secondSignIn.statusCode).toBe(200);
    const tokenB = secondSignIn.json().token as string;

    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    expect(tokenA).not.toBe(tokenB);
  });

  it('username sign-in and sign-up ignore member rows sharing the username', async () => {
    // Synced member rows live in the same users table and can carry any
    // username, including one equal to a login username. They must never
    // shadow the login-capable account: the owner can still claim the
    // username at sign-up and always wins the sign-in lookup.
    const username = `shadow${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await db.insert(users).values({ username, role: 'member' });

    const { password, userId } = await signUpOwner(app, { username });

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/username`,
      headers: { 'content-type': 'application/json' },
      payload: { username, password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(userId);
  });

  it('rate limits repeated failed sign-ins', async () => {
    // Default better-auth special rule for /sign-in* is window 10s, max 3.
    // The account doesn't need to exist - the rate limiter fires purely on
    // path, before credential lookup.
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/sign-in/email`,
        headers: { 'content-type': 'application/json' },
        payload: { email: 'nobody@example.com', password: 'WrongPassword!123' },
      });

    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await attempt();
      codes.push(res.statusCode);
    }

    expect(codes).toContain(429);
    // Everything before the limit trips should be a normal auth failure, not
    // a crash or an accidental pass-through.
    expect(codes.slice(0, codes.indexOf(429))).not.toContain(500);
  });

  it('a disabled-role user cannot obtain a session', async () => {
    const password = 'DisabledUser!123';
    const email = `disabled-${randomUUID()}@example.com`;

    const [user] = await db
      .insert(users)
      .values({
        username: `disabled${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        email,
        emailVerified: true,
        role: 'disabled',
      })
      .returning();
    expect(user).toBeDefined();

    await db.insert(authAccounts).values({
      id: randomUUID(),
      accountId: user!.id,
      providerId: 'credential',
      userId: user!.id,
      password: await hashPassword(password),
    });

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });

    // An email is a password sign-in identifier only for owner and admin.
    expect(res.statusCode).toBe(401);

    const rows = await db.select().from(users).where(eq(users.id, user!.id));
    expect(rows).toHaveLength(1); // sanity: user still exists, just can't log in
  });

  it('jellyfin login endpoint stays gone', async () => {
    const removed = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/jellyfin/login`,
      payload: { username: 'x', password: 'y' },
    });
    expect(removed.statusCode).toBe(404);

    // The legacy static route it used to share a file with must still win
    // over the Better Auth wildcard for its own exact path.
    const stillThere = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/jellyfin/connect-api-key`,
      payload: {},
    });
    expect(stillThere.statusCode).not.toBe(404);
  });

  it('cli enable-local-login recovers from local login disabled', async () => {
    const { email, password, userId } = await signUpOwner(app);
    await db.insert(plexAccounts).values({
      userId,
      plexAccountId: `plex-${randomUUID()}`,
      plexUsername: 'owner',
      plexToken: 'fake-plex-token',
      allowLogin: true,
    });

    await setSetting('loginMethods', { local: false, plex: true, oidc: true, member: false });
    const blocked = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });
    expect(blocked.statusCode).toBe(403);

    await enableLocalLoginCommand();

    const recovered = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });
    expect(recovered.statusCode).toBe(200);
  });

  it('still lets the owner sign in with a password when the switches leave no other way in', async () => {
    const { email, password, userId } = await signUpOwner(app);
    const [owner] = await db.select().from(users).where(eq(users.id, userId));
    // better-auth keeps the password on the credential account, never on users.password_hash.
    expect(owner?.passwordHash).toBeNull();

    await setSetting('loginMethods', { local: false, plex: false, oidc: true, member: false });
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    { role: 'member', refusal: 401 },
    { role: 'admin', refusal: null },
  ] as const)(
    'a $role with a Tracearr password signs in only as an admin',
    async ({ role, refusal }) => {
      await signUpOwner(app);
      await setSetting('loginMethods', { local: true, plex: true, oidc: true, member: true });
      const email = `${role}-${randomUUID()}@example.com`;
      const [person] = await db
        .insert(users)
        .values({
          username: `${role}${randomUUID().slice(0, 8)}`,
          email,
          role,
          loginAccess: 'allow',
        })
        .returning();
      if (!person) throw new Error('user insert returned nothing');
      await db.insert(authAccounts).values({
        id: randomUUID(),
        accountId: person.id,
        providerId: 'credential',
        userId: person.id,
        password: await hashPassword('LeftoverPassword!123'),
      });

      const res = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/sign-in/email`,
        headers: { 'content-type': 'application/json' },
        payload: { email, password: 'LeftoverPassword!123' },
      });
      const sessions = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, person.id));
      if (refusal) {
        expect(res.statusCode).toBe(refusal);
        expect(sessions).toHaveLength(0);
      } else {
        expect(res.statusCode).toBe(200);
        expect(sessions).toHaveLength(1);
      }
    }
  );

  it('rejects a forged/garbage session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: 'better-auth.session_token=not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('revoked mobile device is denied on http and rejected at socket auth', async () => {
    const owner = await signUpOwner(app);
    const ownerCookie = cookieHeader(setCookieArray(owner.res));
    await setSetting('mobileEnabled', true);

    const tokenRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mobile/pair-token`,
      headers: { cookie: ownerCookie },
    });
    expect(tokenRes.statusCode).toBe(200);
    const pairingToken = tokenRes.json().token as string;

    const pairRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mobile/pair`,
      payload: {
        token: pairingToken,
        deviceName: 'Security Test Device',
        deviceId: `device-${randomUUID()}`,
        platform: 'ios',
      },
    });
    expect(pairRes.statusCode).toBe(200);
    const { accessToken } = pairRes.json();

    const [sessionRow] = await db
      .select()
      .from(mobileSessions)
      .where(eq(mobileSessions.userId, owner.userId));
    expect(sessionRow).toBeDefined();

    // Sanity: the freshly paired device works over HTTP and resolves at the
    // socket auth layer, and isn't blacklisted yet.
    const meBefore = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/mobile/me`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meBefore.statusCode).toBe(200);

    const socketUserBefore = await resolveSocketUser({ token: accessToken, headers: {} });
    expect(socketUserBefore).toMatchObject({ mobile: true, deviceId: sessionRow!.deviceId });

    // checkMobileBlacklist returns "allowed" (true = allowed, not blacklisted).
    const allowedBefore = await checkMobileBlacklist(getRedis(), sessionRow!.deviceId);
    expect(allowedBefore).toBe(true);

    const revokeRes = await app.inject({
      method: 'DELETE',
      url: `${API_BASE_PATH}/mobile/sessions/${sessionRow!.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(revokeRes.statusCode).toBe(200);

    const meAfter = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/mobile/me`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meAfter.statusCode).toBe(401);

    const socketUserAfter = await resolveSocketUser({ token: accessToken, headers: {} });
    expect(socketUserAfter).toBeNull();

    const allowedAfter = await checkMobileBlacklist(getRedis(), sessionRow!.deviceId);
    expect(allowedAfter).toBe(false);
  });

  // The second-sign-up-over-the-endpoint case lives in
  // betterAuthSignup.integration.test.ts ('rejects a second sign-up once an
  // owner exists'); this file only covers the shared guard below.
  it('single-owner gate: assertSignupAllowed (shared by every creation path) rejects once an owner exists', async () => {
    // Every user-creation entry point funnels through this same guard:
    // email/password sign-up via the databaseHooks.user.create.before hook
    // (lib/auth.ts), and the Plex first-run flow via a direct call in
    // plexPlugin.ts (plex/check-pin and plex/connect, before creating the
    // temp token / user row). OIDC's first-user path is covered by the very
    // same databaseHooks.user.create.before hook that gates email/password
    // sign-up above, since Better Auth's adapter create path is shared across
    // credential and OAuth providers - there's no separate hook to bypass.
    // Driving that path live would require a real IdP redirect round-trip,
    // which isn't available in this environment, so this test exercises the
    // guard function directly against the live database instead.
    await expect(assertSignupAllowed()).resolves.toBeUndefined();

    await signUpOwner(app);

    await expect(assertSignupAllowed()).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('sign-up payload cannot inject role/trust score/violations/apiToken via additionalFields', async () => {
    // additionalFields in lib/auth.ts all declare input: false, but Better
    // Auth enforces that two different ways depending on the field:
    // - 'role' collides with a name the admin plugin itself guards, and gets
    //   hard-rejected before a row is ever created (400 FIELD_NOT_ALLOWED).
    // - the others are silently stripped from the input and the row is
    //   created with their defaultValue instead.
    // Either outcome is safe; what matters is the attacker-supplied value
    // never lands in the database, so both are asserted per field below.
    const maliciousFields: Record<string, unknown> = {
      role: 'admin',
      aggregateTrustScore: 999999,
      totalViolations: 999,
      apiToken: `trr_pub_${randomUUID().replace(/-/g, '')}`,
    };

    for (const [field, value] of Object.entries(maliciousFields)) {
      // Better Auth's own sign-up rate limit is tight enough that the four
      // rapid-fire attempts in this loop would otherwise trip it.
      await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-up*`);

      const email = `escalate-${field}-${randomUUID()}@example.com`;
      const username = `esc${randomUUID().replace(/-/g, '').slice(0, 12)}`;

      const res = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/sign-up/email`,
        headers: { 'content-type': 'application/json' },
        payload: {
          email,
          password: 'Escalate!12345',
          name: 'Escalate Test',
          username,
          [field]: value,
        },
      });

      const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase()));

      if (res.statusCode === 200) {
        expect(rows).toHaveLength(1);
        expect((rows[0] as unknown as Record<string, unknown>)[field]).not.toBe(value);
        // A successful iteration becomes the instance owner, which would
        // block every later iteration's sign-up on the unrelated
        // single-owner gate rather than the field-injection guard this test
        // targets - remove it so each field is tested against a clean slate.
        await db.delete(users).where(eq(users.email, email.toLowerCase()));
      } else {
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('FIELD_NOT_ALLOWED');
        expect(rows).toHaveLength(0);
      }
    }

    // Sanity: the same shape signs up fine, with safe defaults, once the
    // attacker-controlled fields are removed.
    await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*sign-up*`);
    const email = `legit-${randomUUID()}@example.com`;
    const username = `legit${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email, password: 'Escalate!12345', name: 'Escalate Test', username },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(users).where(eq(users.email, email));
    expect(row).toBeDefined();
    expect(row!.role).toBe('owner'); // forced by the create hook for the first user
    expect(row!.aggregateTrustScore).toBe(100);
    expect(row!.totalViolations).toBe(0);
    expect(row!.apiToken).toBeNull();
  });

  it('a public API token cannot be used as a Better Auth session/bearer, and vice versa', async () => {
    const owner = await signUpOwner(app);

    const signIn = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: { email: owner.email, password: owner.password },
    });
    expect(signIn.statusCode).toBe(200);
    const baBearerToken = signIn.json().token as string;
    expect(baBearerToken).toBeTruthy();

    const publicApiToken = `trr_pub_${randomUUID().replace(/-/g, '')}`;
    await db.update(users).set({ apiToken: publicApiToken }).where(eq(users.id, owner.userId));

    // The public API token authenticates the public API path...
    const publicApiWithPublicToken = await app.inject({
      method: 'GET',
      url: '/protected-public-api',
      headers: { authorization: `Bearer ${publicApiToken}` },
    });
    expect(publicApiWithPublicToken.statusCode).toBe(200);
    expect(publicApiWithPublicToken.json().userId).toBe(owner.userId);

    // ...but is NOT accepted as a Better Auth session/bearer on a protected route.
    const protectedWithPublicToken = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${publicApiToken}` },
    });
    expect(protectedWithPublicToken.statusCode).toBe(401);

    // And a real Better Auth bearer session token is NOT accepted as a public API key.
    const publicApiWithBaBearer = await app.inject({
      method: 'GET',
      url: '/protected-public-api',
      headers: { authorization: `Bearer ${baBearerToken}` },
    });
    expect(publicApiWithBaBearer.statusCode).toBe(401);
  });

  it('a tampered mobile bearer token is rejected', async () => {
    const owner = await signUpOwner(app);
    const ownerCookie = cookieHeader(setCookieArray(owner.res));
    await setSetting('mobileEnabled', true);

    const tokenRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mobile/pair-token`,
      headers: { cookie: ownerCookie },
    });
    expect(tokenRes.statusCode).toBe(200);
    const pairingToken = tokenRes.json().token as string;

    const pairRes = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mobile/pair`,
      payload: {
        token: pairingToken,
        deviceName: 'Tamper Test Device',
        deviceId: `device-${randomUUID()}`,
        platform: 'ios',
      },
    });
    expect(pairRes.statusCode).toBe(200);
    const { accessToken } = pairRes.json() as { accessToken: string };

    const mid = Math.floor(accessToken.length / 2);
    const flippedChar = accessToken[mid] === 'a' ? 'b' : 'a';
    const tampered = accessToken.slice(0, mid) + flippedChar + accessToken.slice(mid + 1);
    expect(tampered).not.toBe(accessToken);

    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/mobile/me`,
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('plex login guard rejects a non-owner even with an allowLogin=true plex_accounts row (only plex.tv mocked)', async () => {
    await signUpOwner(app);

    const [nonOwner] = await db
      .insert(users)
      .values({
        username: `nonowner${randomUUID().replace(/-/g, '').slice(0, 10)}`,
        email: `nonowner-${randomUUID()}@example.com`,
        emailVerified: true,
        role: 'member',
      })
      .returning();
    expect(nonOwner).toBeDefined();

    const plexAccountId = `plex-${randomUUID()}`;
    await db.insert(plexAccounts).values({
      userId: nonOwner!.id,
      plexAccountId,
      plexUsername: 'nonowner',
      plexEmail: nonOwner!.email!,
      plexThumbnail: '',
      plexToken: 'fake-plex-token',
      // allowLogin: true on its own must not be enough to authorize login -
      // the plexPlugin's role !== 'owner' check is the actual gate.
      allowLogin: true,
    });

    // Only the plex.tv client is mocked (per contract); db and the plugin's
    // own guard logic run for real against the live database.
    const spy = vi.spyOn(PlexClient, 'checkOAuthPin').mockResolvedValue({
      id: plexAccountId,
      username: 'nonowner',
      email: nonOwner!.email!,
      thumb: '',
      token: 'fake-plex-token',
      tokenKind: 'legacy',
      refreshToken: null,
      expiresAt: null,
    });

    try {
      const res = await plexCheckPin(app);
      expect(res.statusCode).toBe(403);
    } finally {
      spy.mockRestore();
    }
  });

  describe('owner with only a legacy Plex link', () => {
    function mockPin(plexAccountId: string) {
      return vi.spyOn(PlexClient, 'checkOAuthPin').mockResolvedValue({
        id: plexAccountId,
        username: 'owner',
        email: `plex-${randomUUID()}@example.com`,
        thumb: '',
        token: 'fake-plex-token',
        tokenKind: 'legacy',
        refreshToken: null,
        expiresAt: null,
      });
    }

    async function expectPlexOpen(plexAccountId: string) {
      const status = await app.inject({ method: 'GET', url: `${API_BASE_PATH}/setup/status` });
      expect(status.json().authMethods.plex).toBe(true);

      const spy = mockPin(plexAccountId);
      try {
        const res = await plexCheckPin(app);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ authorized: true, user: { role: 'owner' } });
      } finally {
        spy.mockRestore();
      }
    }

    it('signs in through users.plexAccountId with no plex_accounts row', async () => {
      const { userId } = await signUpOwner(app);
      const plexAccountId = `plex-${randomUUID()}`;
      await db.update(users).set({ plexAccountId }).where(eq(users.id, userId));

      await expectPlexOpen(plexAccountId);
    });

    async function plexServerAccount(row: {
      userId: string;
      externalId: string;
      plexAccountId: string | null;
    }) {
      const [server] = await db
        .insert(servers)
        .values({ name: 'Plex', type: 'plex', url: 'http://plex.local:32400', token: 'tok' })
        .returning();
      if (!server) throw new Error('server insert returned nothing');
      await db.insert(serverUsers).values({ ...row, serverId: server.id, username: 'owner' });
    }

    it('signs in through a Plex server account whose external id is the plex.tv id', async () => {
      const { userId } = await signUpOwner(app);
      const plexAccountId = `plex-${randomUUID()}`;
      await plexServerAccount({ userId, externalId: plexAccountId, plexAccountId });

      await expectPlexOpen(plexAccountId);
    });

    it('signs in through a poller-created Plex account no sync has reached', async () => {
      const { userId } = await signUpOwner(app);
      const plexAccountId = `plex-${randomUUID()}`;
      await plexServerAccount({ userId, externalId: plexAccountId, plexAccountId: null });

      await expectPlexOpen(plexAccountId);
    });

    it("does not count the server owner's own '1' row as a Plex login", async () => {
      const { userId } = await signUpOwner(app);
      await plexServerAccount({ userId, externalId: '1', plexAccountId: null });

      const status = await app.inject({ method: 'GET', url: `${API_BASE_PATH}/setup/status` });
      expect(status.json().authMethods.plex).toBe(false);
    });
  });

  describe('impersonation', () => {
    const origin = 'http://localhost:80';

    // impersonate-user expires the owner's cookies and sets the member's in one response.
    function liveCookies(res: { headers: { 'set-cookie'?: string | string[] } }): string {
      return cookieHeader(setCookieArray(res).filter((c) => !/Max-Age=0/i.test(c)));
    }

    async function ownerAndMember() {
      const owner = await signUpOwner(app);
      const [member] = await db
        .insert(users)
        .values({
          username: `member${randomUUID().slice(0, 8)}`,
          role: 'member',
          loginAccess: 'block',
        })
        .returning();
      return { ownerCookie: cookieHeader(setCookieArray(owner.res)), owner, memberId: member!.id };
    }

    it('lets the owner view as a member the login gates refuse, without counting a sign-in', async () => {
      const { ownerCookie, owner, memberId } = await ownerAndMember();
      const info = vi.spyOn(console, 'info');

      const start = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/admin/impersonate-user`,
        headers: { cookie: ownerCookie, origin, 'content-type': 'application/json' },
        payload: { userId: memberId },
      });
      expect(start.statusCode).toBe(200);
      expect(info).toHaveBeenCalledWith(
        '[auth] impersonation started',
        expect.objectContaining({ ownerId: owner.userId, targetId: memberId })
      );

      const viewing = await app.inject({
        method: 'GET',
        url: '/protected',
        headers: { cookie: liveCookies(start) },
      });
      expect(viewing.json()).toMatchObject({ userId: memberId, role: 'member' });
      const [member] = await db.select().from(users).where(eq(users.id, memberId));
      expect(member?.loginCount).toBe(0);

      const stop = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/admin/stop-impersonating`,
        headers: { cookie: liveCookies(start), origin },
      });
      expect(stop.statusCode).toBe(200);
      const dontRemember = setCookieArray(stop).filter((c) => c.includes('dont_remember='));
      expect(dontRemember.length).toBeGreaterThan(0);
      expect(dontRemember.every((c) => /Max-Age=0/i.test(c))).toBe(true);
      expect(info).toHaveBeenCalledWith(
        '[auth] impersonation stopped',
        expect.objectContaining({ ownerId: owner.userId, targetId: memberId })
      );
    });

    it('a view-as session presented as a bearer token can neither stretch itself nor write', async () => {
      const { ownerCookie, memberId } = await ownerAndMember();
      const start = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/admin/impersonate-user`,
        headers: { cookie: ownerCookie, origin, 'content-type': 'application/json' },
        payload: { userId: memberId },
      });
      expect(start.statusCode).toBe(200);
      const [masquerade] = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, memberId));
      if (!masquerade) throw new Error('impersonation session missing');
      const bearer = { authorization: `Bearer ${masquerade.token}` };

      const read = await app.inject({
        method: 'GET',
        url: `${API_BASE_PATH}/auth/get-session`,
        headers: bearer,
      });
      expect(read.statusCode).toBe(403);
      const write = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/update-user`,
        headers: { ...bearer, 'content-type': 'application/json' },
        payload: { name: 'x' },
      });
      expect(write.statusCode).toBe(403);
      const protectedRead = await app.inject({ method: 'GET', url: '/protected', headers: bearer });
      expect(protectedRead.statusCode).toBe(401);

      const [after] = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.id, masquerade.id));
      expect(after?.expiresAt.getTime()).toBe(masquerade.expiresAt.getTime());
      const [member] = await db.select().from(users).where(eq(users.id, memberId));
      expect(member?.name).not.toBe('x');

      const viaCookie = await app.inject({
        method: 'GET',
        url: `${API_BASE_PATH}/auth/get-session`,
        headers: { cookie: liveCookies(start) },
      });
      expect(viaCookie.statusCode).toBe(200);
      const expires = new Date(viaCookie.json().session.expiresAt).getTime();
      expect(expires).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 5000);
    });

    it('refuses impersonation over a bearer token', async () => {
      const { owner, memberId } = await ownerAndMember();
      const [row] = await db
        .select({ token: authSessions.token })
        .from(authSessions)
        .where(eq(authSessions.userId, owner.userId));

      const res = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/admin/impersonate-user`,
        headers: { authorization: `Bearer ${row!.token}`, 'content-type': 'application/json' },
        payload: { userId: memberId },
      });
      expect(res.statusCode).toBe(400);
      const sessions = await db
        .select()
        .from(authSessions)
        .where(eq(authSessions.userId, memberId));
      expect(sessions).toHaveLength(0);
    });
  });

  describe('member login', () => {
    const origin = 'http://localhost:80';
    const MEMBER_TOKEN = 'member-secret-token';

    afterEach(async () => {
      resetSettingsCache();
      await clearRedisPattern(`${process.env.REDIS_PREFIX ?? ''}tracearr:login_failures:*`);
    });

    function liveCookies(res: { headers: { 'set-cookie'?: string | string[] } }): string {
      return cookieHeader(setCookieArray(res).filter((c) => !/Max-Age=0/i.test(c)));
    }

    async function loginServer(
      type: Extract<ServerType, 'jellyfin' | 'plex'> = 'jellyfin',
      allowMemberLogin = true
    ) {
      const [server] = await db
        .insert(servers)
        .values({
          name: type,
          type,
          url: type === 'plex' ? 'http://plex.local:32400' : 'http://jellyfin.local:8096',
          token: 'tok',
          allowMemberLogin,
        })
        .returning();
      if (!server) throw new Error('server insert returned nothing');
      return server;
    }

    async function member(username = 'alice', loginAccess: LoginAccess = 'allow') {
      const [row] = await db
        .insert(users)
        .values({ username, role: 'member', loginAccess })
        .returning();
      if (!row) throw new Error('member insert returned nothing');
      return row;
    }

    async function memberOnJellyfin(
      {
        memberSwitch,
        loginAccess,
        serverAllows = true,
      }: { memberSwitch: boolean; loginAccess: LoginAccess; serverAllows?: boolean } = {
        memberSwitch: true,
        loginAccess: 'allow',
      }
    ) {
      await setSetting('loginMethods', {
        local: true,
        plex: true,
        oidc: true,
        member: memberSwitch,
      });
      const server = await loginServer('jellyfin', serverAllows);
      const alice = await member('alice', loginAccess);
      await db
        .insert(serverUsers)
        .values({ userId: alice.id, serverId: server.id, externalId: 'ext-1', username: 'alice' });
      return { server, alice };
    }

    function jellyfinSignIn(serverId: string, username = 'alice') {
      return app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/jellyfin/sign-in`,
        headers: { origin, 'content-type': 'application/json' },
        payload: { serverId, username, password: 'pw' },
      });
    }

    it("keeps better-auth's account endpoints and trust fields away from a member", async () => {
      const owner = await signUpOwner(app);
      const { server } = await memberOnJellyfin();
      const auth = vi
        .spyOn(JellyfinClient, 'authenticateByName')
        .mockResolvedValue({ externalId: 'ext-1', token: MEMBER_TOKEN });

      try {
        const signedIn = await jellyfinSignIn(server.id);
        expect(signedIn.statusCode).toBe(200);
        const memberCookie = cookieHeader(setCookieArray(signedIn));
        const json = { cookie: memberCookie, origin, 'content-type': 'application/json' };

        for (const [method, path, payload] of [
          ['POST', '/update-user', { name: 'Not Alice' }],
          ['POST', '/change-email', { newEmail: 'x@example.com' }],
          ['POST', '/change-password', { currentPassword: 'a', newPassword: 'bbbbbbbb' }],
          ['POST', '/is-username-available', { username: owner.username }],
          ['POST', '/revoke-sessions', {}],
          ['POST', '/unlink-account', { providerId: 'jellyfin' }],
          ['GET', '/list-sessions', undefined],
        ] as const) {
          const res = await app.inject({
            method,
            url: `${API_BASE_PATH}/auth${path}`,
            headers: json,
            ...(payload ? { payload } : {}),
          });
          expect(res.statusCode, path).toBe(404);
        }

        const session = await app.inject({
          method: 'GET',
          url: `${API_BASE_PATH}/auth/get-session`,
          headers: { cookie: memberCookie },
        });
        expect(session.json().user).not.toHaveProperty('aggregateTrustScore');
        expect(session.json().user).not.toHaveProperty('totalViolations');
        expect(session.json().user).not.toHaveProperty('apiToken');

        const ownerList = await app.inject({
          method: 'GET',
          url: `${API_BASE_PATH}/auth/list-sessions`,
          headers: { cookie: cookieHeader(setCookieArray(owner.res)) },
        });
        expect(ownerList.statusCode).toBe(200);
        expect(ownerList.json().length).toBeGreaterThan(0);
        for (const listed of ownerList.json()) expect(listed).not.toHaveProperty('token');
      } finally {
        auth.mockRestore();
      }
    });

    it('signs a member in through Jellyfin and posts the server-side logout at sign-out', async () => {
      await signUpOwner(app);
      const { server, alice } = await memberOnJellyfin();
      const auth = vi
        .spyOn(JellyfinClient, 'authenticateByName')
        .mockResolvedValue({ externalId: 'ext-1', token: MEMBER_TOKEN });
      const logout = vi.spyOn(JellyfinClient, 'logoutUserToken').mockResolvedValue();

      try {
        const res = await jellyfinSignIn(server.id);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          authorized: true,
          user: { id: alice.id, username: 'alice', role: 'member' },
        });
        expect(res.body).not.toContain(MEMBER_TOKEN);
        const [account] = await db
          .select()
          .from(authAccounts)
          .where(eq(authAccounts.userId, alice.id));
        expect(account).toMatchObject({
          providerId: 'jellyfin',
          accountId: `${server.id}:ext-1`,
          accessToken: MEMBER_TOKEN,
        });

        const cookie = cookieHeader(setCookieArray(res));
        const viewing = await app.inject({ method: 'GET', url: '/protected', headers: { cookie } });
        expect(viewing.json()).toMatchObject({ userId: alice.id, role: 'member' });

        const out = await app.inject({
          method: 'POST',
          url: `${API_BASE_PATH}/auth/sign-out`,
          headers: { cookie, origin },
        });
        expect(out.statusCode).toBe(200);
        expect(logout).toHaveBeenCalledExactlyOnceWith(server.url, MEMBER_TOKEN);
      } finally {
        auth.mockRestore();
        logout.mockRestore();
      }
    });

    it.each([
      { memberSwitch: false, loginAccess: 'allow', serverAllows: true, status: 200 },
      { memberSwitch: false, loginAccess: 'allow', serverAllows: false, status: 200 },
      { memberSwitch: true, loginAccess: 'block', serverAllows: true, status: 403 },
      { memberSwitch: false, loginAccess: 'default', serverAllows: true, status: 403 },
      // Nobody can sign in through this server, so it is closed before the password goes out
      {
        memberSwitch: true,
        loginAccess: 'default',
        serverAllows: false,
        status: 403,
        code: 'MEMBER_LOGIN_REFUSED',
      },
      { memberSwitch: true, loginAccess: 'default', serverAllows: true, status: 200 },
    ] as const)(
      'switch $memberSwitch, $loginAccess, server allows $serverAllows: Jellyfin answers $status',
      async ({ memberSwitch, loginAccess, serverAllows, status, ...row }) => {
        await signUpOwner(app);
        const { server, alice } = await memberOnJellyfin({
          memberSwitch,
          loginAccess,
          serverAllows,
        });
        const auth = vi
          .spyOn(JellyfinClient, 'authenticateByName')
          .mockResolvedValue({ externalId: 'ext-1', token: MEMBER_TOKEN });

        try {
          const res = await jellyfinSignIn(server.id);
          expect(res.statusCode).toBe(status);
          if (status === 403 && 'code' in row) {
            expect(res.json()).toMatchObject({ code: row.code });
          } else if (status === 403) {
            expect(res.json()).toMatchObject({
              code: 'MEMBER_NOT_PERMITTED',
              message: 'You are not permitted to sign in. Please contact the server owner.',
            });
          }
          const sessions = await db
            .select()
            .from(authSessions)
            .where(eq(authSessions.userId, alice.id));
          expect(sessions).toHaveLength(status === 200 ? 1 : 0);
        } finally {
          auth.mockRestore();
        }
      }
    );

    it('passes no credential to a switched-off server nobody is allowed on, nor lists it', async () => {
      await signUpOwner(app);
      const { server } = await memberOnJellyfin({
        memberSwitch: true,
        loginAccess: 'default',
        serverAllows: false,
      });
      const auth = vi.spyOn(JellyfinClient, 'authenticateByName');
      const qc = vi.spyOn(JellyfinClient, 'quickConnectEnabled');

      try {
        const res = await jellyfinSignIn(server.id);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'MEMBER_LOGIN_REFUSED' });
        const initiate = await app.inject({
          method: 'POST',
          url: `${API_BASE_PATH}/auth/jellyfin/quick-connect/initiate`,
          headers: { origin, 'content-type': 'application/json' },
          payload: { serverId: server.id },
        });
        expect(initiate.statusCode).toBe(403);
        expect(auth).not.toHaveBeenCalled();
        expect(qc).not.toHaveBeenCalled();

        const status = await app.inject({
          method: 'GET',
          url: `${API_BASE_PATH}/setup/status?all`,
        });
        expect(status.json().memberLoginServers).toEqual([]);
      } finally {
        auth.mockRestore();
        qc.mockRestore();
      }
    });

    it('opens a switched-off server to sign-in while an allowed person has a live account on it', async () => {
      await signUpOwner(app);
      const { server, alice } = await memberOnJellyfin({
        memberSwitch: false,
        loginAccess: 'allow',
        serverAllows: false,
      });
      const auth = vi
        .spyOn(JellyfinClient, 'authenticateByName')
        .mockResolvedValue({ externalId: 'ext-1', token: MEMBER_TOKEN });
      vi.spyOn(JellyfinClient, 'quickConnectEnabled').mockResolvedValue(false);

      try {
        const status = await app.inject({
          method: 'GET',
          url: `${API_BASE_PATH}/setup/status?all`,
        });
        expect(status.json().memberLoginServers).toMatchObject([{ id: server.id }]);

        expect((await jellyfinSignIn(server.id)).statusCode).toBe(200);
        expect(auth).toHaveBeenCalledOnce();

        await db
          .update(serverUsers)
          .set({ removedAt: new Date() })
          .where(eq(serverUsers.userId, alice.id));
        auth.mockClear();
        expect((await jellyfinSignIn(server.id)).statusCode).toBe(403);
        expect(auth).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('never says not permitted to a wrong password', async () => {
      await signUpOwner(app);
      const { server } = await memberOnJellyfin({
        memberSwitch: false,
        loginAccess: 'block',
        serverAllows: false,
      });
      const auth = vi.spyOn(JellyfinClient, 'authenticateByName').mockResolvedValue(null);

      try {
        const res = await jellyfinSignIn(server.id);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'MEMBER_LOGIN_REFUSED' });
      } finally {
        auth.mockRestore();
      }
    });

    it("leaves the member's media server device alone when an owner ends a masquerade by signing out", async () => {
      const owner = await signUpOwner(app);
      const { server, alice } = await memberOnJellyfin();
      await db.insert(authAccounts).values({
        id: randomUUID(),
        providerId: 'jellyfin',
        accountId: `${server.id}:ext-1`,
        userId: alice.id,
        accessToken: MEMBER_TOKEN,
      });
      const logout = vi.spyOn(JellyfinClient, 'logoutUserToken').mockResolvedValue();

      try {
        const start = await app.inject({
          method: 'POST',
          url: `${API_BASE_PATH}/auth/admin/impersonate-user`,
          headers: {
            cookie: cookieHeader(setCookieArray(owner.res)),
            origin,
            'content-type': 'application/json',
          },
          payload: { userId: alice.id },
        });
        expect(start.statusCode).toBe(200);

        const out = await app.inject({
          method: 'POST',
          url: `${API_BASE_PATH}/auth/sign-out`,
          headers: { cookie: liveCookies(start), origin },
        });
        expect(out.statusCode).toBe(200);
        expect(logout).not.toHaveBeenCalled();
      } finally {
        logout.mockRestore();
      }
    });

    it('rate limits password sign-in per address before the media server is called', async () => {
      await signUpOwner(app);
      const { server } = await memberOnJellyfin();
      const auth = vi.spyOn(JellyfinClient, 'authenticateByName').mockResolvedValue(null);

      try {
        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) {
          statuses.push((await jellyfinSignIn(server.id, `user${i}`)).statusCode);
        }
        expect(statuses.slice(0, 10)).toEqual(Array(10).fill(403));
        expect(statuses[10]).toBe(429);
        expect(auth).toHaveBeenCalledTimes(10);
      } finally {
        auth.mockRestore();
      }
    });

    it('lets at most three parallel wrong guesses for one account reach the media server', async () => {
      await signUpOwner(app);
      const { server } = await memberOnJellyfin();
      const auth = vi
        .spyOn(JellyfinClient, 'authenticateByName')
        .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 50)));

      try {
        const results = await Promise.all(
          Array.from({ length: 8 }, () => jellyfinSignIn(server.id))
        );
        expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(403));
        expect(auth).toHaveBeenCalledTimes(3);
      } finally {
        auth.mockRestore();
      }
    });

    function pinFor(plexAccountId: string) {
      return vi.spyOn(PlexClient, 'checkOAuthPin').mockResolvedValue({
        id: plexAccountId,
        username: 'shared',
        email: `plex-${randomUUID()}@example.com`,
        thumb: '',
        token: 'fake-plex-token',
        tokenKind: 'legacy',
        refreshToken: null,
        expiresAt: null,
      });
    }

    function checkPin() {
      return plexCheckPin(app);
    }

    it('signs in the owner when one plex.tv id sits on the owner and on a member', async () => {
      await setSetting('loginMethods', { local: true, plex: true, oidc: true, member: true });
      const plexAccountId = `plex-${randomUUID()}`;
      const shared = await member('shared');
      const memberServer = await loginServer('plex');
      await db.insert(serverUsers).values({
        userId: shared.id,
        serverId: memberServer.id,
        externalId: plexAccountId,
        plexAccountId,
        username: 'shared',
      });
      const owner = await signUpOwner(app);
      const ownerServer = await loginServer('plex');
      await db.insert(serverUsers).values({
        userId: owner.userId,
        serverId: ownerServer.id,
        externalId: plexAccountId,
        plexAccountId,
        username: 'shared',
      });

      const spy = pinFor(plexAccountId);
      try {
        const res = await checkPin();
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ user: { id: owner.userId, role: 'owner' } });
      } finally {
        spy.mockRestore();
      }
    });

    it("does not sign the owner in through a member's path while Plex login is off", async () => {
      const owner = await signUpOwner(app);
      await setSetting('loginMethods', { local: true, plex: false, oidc: true, member: true });
      const plexAccountId = `plex-${randomUUID()}`;
      const server = await loginServer('plex');
      await db.insert(serverUsers).values({
        userId: owner.userId,
        serverId: server.id,
        externalId: '1',
        plexAccountId,
        username: 'owner',
      });

      const spy = pinFor(plexAccountId);
      try {
        expect((await checkPin()).statusCode).toBe(403);
      } finally {
        spy.mockRestore();
      }
    });

    it('ignores a Jellyfin account whose external id is the presented plex.tv id', async () => {
      const owner = await signUpOwner(app);
      const plexAccountId = `plex-${randomUUID()}`;
      const jellyfin = await loginServer('jellyfin');
      await db.insert(serverUsers).values({
        userId: owner.userId,
        serverId: jellyfin.id,
        externalId: plexAccountId,
        username: 'owner',
      });

      const spy = pinFor(plexAccountId);
      try {
        expect((await checkPin()).statusCode).toBe(403);
      } finally {
        spy.mockRestore();
      }
    });

    it('links an OIDC profile to a member by username and never to the owner', async () => {
      const owner = await signUpOwner(app);
      const { server, alice } = await memberOnJellyfin();
      await db.insert(serverUsers).values({
        userId: owner.userId,
        serverId: server.id,
        externalId: 'ext-owner',
        username: 'boss',
      });

      await linkOidcMember({ sub: 'sub-owner', preferred_username: 'boss' });
      await linkOidcMember({ sub: 'sub-alice', preferred_username: 'Alice' });

      const links = await db
        .select({ userId: authAccounts.userId, accountId: authAccounts.accountId })
        .from(authAccounts)
        .where(eq(authAccounts.providerId, 'oidc'));
      expect(links).toEqual([{ userId: alice.id, accountId: 'sub-alice' }]);
    });

    it('never returns a member token from the users, settings or debug routes', async () => {
      const owner = await signUpOwner(app);
      const { server, alice } = await memberOnJellyfin();
      await db.insert(authAccounts).values({
        id: randomUUID(),
        providerId: 'jellyfin',
        accountId: `${server.id}:ext-1`,
        userId: alice.id,
        accessToken: MEMBER_TOKEN,
      });
      const [account] = await db
        .select({ id: serverUsers.id })
        .from(serverUsers)
        .where(eq(serverUsers.userId, alice.id));
      const routesApp = await buildApp();
      await routesApp.register(userRoutes, { prefix: `${API_BASE_PATH}/users` });
      await routesApp.register(settingsRoutes, { prefix: `${API_BASE_PATH}/settings` });
      await routesApp.register(debugRoutes, { prefix: `${API_BASE_PATH}/debug` });
      const cookie = cookieHeader(setCookieArray(owner.res));

      try {
        for (const url of [
          `${API_BASE_PATH}/users`,
          `${API_BASE_PATH}/users/${account?.id}`,
          `${API_BASE_PATH}/users/${account?.id}/full`,
          `${API_BASE_PATH}/settings`,
          `${API_BASE_PATH}/debug/stats`,
        ]) {
          const res = await routesApp.inject({ method: 'GET', url, headers: { cookie } });
          expect(res.statusCode, url).toBe(200);
          expect(res.body, url).not.toContain(MEMBER_TOKEN);
          expect(res.body, url).not.toContain('accessToken');
        }
      } finally {
        await routesApp.close();
      }
    });
  });

  it('an expired session is rejected', async () => {
    const owner = await signUpOwner(app);
    const ownerCookie = cookieHeader(setCookieArray(owner.res));

    const before = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: ownerCookie },
    });
    expect(before.statusCode).toBe(200);

    const [sessionRow] = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.userId, owner.userId));
    expect(sessionRow).toBeDefined();

    // The session cookie itself is HMAC-signed (better-auth/cookies), so a
    // fresh row can't be forged with a valid cookie from scratch - instead,
    // age out the *real* session this cookie already points at. The session
    // is also cached in the secondaryStorage Redis (lib/auth.ts), which is
    // consulted ahead of the database, so - exactly like the
    // revocation-is-immediate test - both the DB row and its Redis cache
    // entry have to reflect the expiry for the change to actually take
    // effect on the next request.
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(authSessions.userId, owner.userId));
    const prefix = process.env.REDIS_PREFIX ?? '';
    await getRedis().del(`${prefix}tracearr:ba:${sessionRow!.token}`);

    const after = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { cookie: ownerCookie },
    });
    expect(after.statusCode).toBe(401);
  });

  describe('cross-origin / CSRF origin check', () => {
    // NODE_ENV=test makes Better Auth's own createContext default
    // advanced.disableOriginCheck to true (see its isTest() check), so the
    // getAuth() singleton used everywhere else in this file - and in the
    // running app in general under this test harness - never enforces the
    // origin check at all. That default is Better Auth's, not this app's;
    // outside of NODE_ENV=test it defaults to enabled. To observe the real
    // code path this app relies on in production, this test builds a second,
    // disposable auth instance against the same live database with the
    // check explicitly forced on (advanced.disableOriginCheck: false) and a
    // known trustedOrigins list, otherwise matching lib/auth.ts.
    const trustedOrigin = 'https://trusted.example.com';
    const originCheckAuth = betterAuth({
      basePath: '/api/v1/auth',
      secret: 'test-better-auth-secret-32-chars!!',
      trustedOrigins: [trustedOrigin],
      database: drizzleAdapter(db, {
        provider: 'pg',
        schema: {
          user: users,
          session: authSessions,
          account: authAccounts,
          verification: authVerifications,
        },
      }),
      advanced: {
        database: { generateId: () => randomUUID() },
        disableOriginCheck: false,
      },
      user: authUserOptions,
      emailAndPassword: { enabled: true },
      plugins: [usernamePlugin()],
    });

    async function signInWithOrigin(origin: string | undefined, withCookie: boolean) {
      const url = `http://localhost${API_BASE_PATH}/auth/sign-in/email`;
      const headers = new Headers({ 'content-type': 'application/json' });
      if (origin) headers.set('origin', origin);
      if (withCookie) headers.set('cookie', 'session-probe=1');
      const req = new Request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'nobody@example.com', password: 'WrongPassword!123' }),
      });
      return originCheckAuth.handler(req);
    }

    it('rejects a cookie-bearing request from a disallowed origin', async () => {
      const res = await signInWithOrigin('https://evil.example.com', true);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('INVALID_ORIGIN');
    });

    it('rejects a request with an Origin header from a disallowed origin even without a cookie', async () => {
      // Better Auth's form-CSRF middleware force-validates whenever an
      // Origin header is present at all, cookie or not.
      const res = await signInWithOrigin('https://evil.example.com', false);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('INVALID_ORIGIN');
    });

    it('accepts a cookie-bearing request from a trusted origin (reaches real credential check)', async () => {
      const res = await signInWithOrigin(trustedOrigin, true);
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('INVALID_EMAIL_OR_PASSWORD');
    });

    it('rejects a cookie-bearing request with no Origin/Referer at all', async () => {
      const res = await signInWithOrigin(undefined, true);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('MISSING_OR_NULL_ORIGIN');
    });
  });
});
