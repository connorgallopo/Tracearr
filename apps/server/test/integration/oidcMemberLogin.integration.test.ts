/**
 * OIDC member sign-in, end to end (integration)
 *
 * Drives /sign-in/social and the /callback/oidc redirect through the real Better Auth handler,
 * database and Redis. Only the IdP is faked, over fetch: discovery without a jwks_uri, so the
 * profile comes from the userinfo endpoint and no ID token has to be signed.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { eq } from 'drizzle-orm';
import { API_BASE_PATH } from '@tracearr/shared';

const { IDP } = vi.hoisted(() => {
  const issuer = 'https://idp.test';
  process.env.OIDC_ISSUER_URL = issuer;
  process.env.OIDC_CLIENT_ID = 'tracearr';
  process.env.OIDC_CLIENT_SECRET = 'idp-secret';
  return { IDP: issuer };
});

import { db } from '../../src/db/client.js';
import { authAccounts, servers, serverUsers, users } from '../../src/db/schema.js';
import { closeAuth } from '../../src/lib/auth.js';
import { createBetterAuthHandler } from '../../src/lib/betterAuthRequest.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { resetSettingsCache, setSetting } from '../../src/services/settings.js';
import authPlugin from '../../src/plugins/auth.js';
import { authRoutes } from '../../src/routes/auth/index.js';

const origin = 'http://localhost:80';
let profile: Record<string, unknown> = {};

const realFetch = globalThis.fetch;
function fakeIdp(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(IDP)) return realFetch(input, init);
  const path = new URL(url).pathname;
  if (path === '/.well-known/openid-configuration') {
    return Promise.resolve(
      Response.json({
        issuer: IDP,
        authorization_endpoint: `${IDP}/authorize`,
        token_endpoint: `${IDP}/token`,
        userinfo_endpoint: `${IDP}/userinfo`,
        end_session_endpoint: `${IDP}/logout`,
        id_token_signing_alg_values_supported: ['RS256'],
      })
    );
  }
  if (path === '/token') {
    return Promise.resolve(
      Response.json({ access_token: 'idp-access', token_type: 'Bearer', expires_in: 3600 })
    );
  }
  if (path === '/userinfo') return Promise.resolve(Response.json(profile));
  return Promise.resolve(new Response(null, { status: 404 }));
}

function setCookies(res: { headers: { 'set-cookie'?: string | string[] } }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

const cookieHeader = (res: { headers: { 'set-cookie'?: string | string[] } }) =>
  setCookies(res)
    .map((c) => c.split(';')[0])
    .join('; ');

async function clearRedis(pattern: string): Promise<void> {
  const keys = await getRedis().keys(`${process.env.REDIS_PREFIX ?? ''}${pattern}`);
  if (keys.length > 0) await getRedis().del(...keys);
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(fastifyCookie, { secret: 'test-cookie-secret-32-chars-long!' });
  await app.register(rateLimit, { max: 10000, timeWindow: '1 minute' });
  app.decorate('redis', getRedis());
  await app.register(authPlugin);
  app.route({
    method: ['GET', 'POST'],
    url: `${API_BASE_PATH}/auth/*`,
    config: { rateLimit: false },
    handler: createBetterAuthHandler(),
  });
  await app.register(authRoutes, { prefix: `${API_BASE_PATH}/auth` });
  return app;
}

describe('oidc member sign-in (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // Sign-up and sign-in rate limits live in Redis, across tests in this file.
    await clearRedis('tracearr:ba:*');
    vi.stubGlobal('fetch', vi.fn(fakeIdp));
    app = await buildApp();
    const owner = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-up/email`,
      headers: { 'content-type': 'application/json' },
      payload: {
        email: 'boss@example.com',
        password: 'OwnerPassword!123',
        name: 'Owner',
        username: 'boss',
      },
    });
    expect(owner.statusCode).toBe(200);
    await setSetting('loginMethods', { local: true, plex: true, oidc: true, member: true });
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
    resetSettingsCache();
  });

  afterAll(async () => {
    await clearRedis('tracearr:ba:*');
    await closeAuth();
  });

  async function startSignIn() {
    await clearRedis('tracearr:ba:*sign-in*');
    const start = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-in/social`,
      headers: { origin, 'content-type': 'application/json' },
      payload: { provider: 'oidc', callbackURL: '/', errorCallbackURL: '/login' },
    });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().url).searchParams.get('state');
    return () =>
      app.inject({
        method: 'GET',
        url: `${API_BASE_PATH}/auth/callback/oidc?code=idp-code&state=${state}`,
        headers: { cookie: cookieHeader(start) },
      });
  }

  async function signIn(as: Record<string, unknown>) {
    profile = as;
    return (await startSignIn())();
  }

  async function memberAlice(serverCount = 1) {
    const [alice] = await db
      .insert(users)
      .values({
        username: 'alice',
        email: 'alice@example.com',
        role: 'member',
        loginAccess: 'allow',
      })
      .returning();
    if (!alice) throw new Error('member insert returned nothing');
    const rows = [];
    for (let i = 0; i < serverCount; i++) {
      const [server] = await db
        .insert(servers)
        .values({
          name: `jf${i}`,
          type: 'jellyfin',
          url: `http://jf${i}.local:8096`,
          token: 'tok',
          allowMemberLogin: i === 0,
        })
        .returning();
      if (!server) throw new Error('server insert returned nothing');
      rows.push(server);
    }
    return { alice, servers: rows };
  }

  const refusedAt = (location: unknown) =>
    String(location).startsWith('/login?error=MEMBER_LOGIN_REFUSED');

  it('tells a blocked member the identity provider vouched for that they are not permitted', async () => {
    const { alice } = await memberAlice();
    await db.update(users).set({ loginAccess: 'block' }).where(eq(users.id, alice.id));

    const known = await signIn({ sub: 'sub-a', email: 'alice@example.com' });
    const unknown = await signIn({ sub: 'sub-b', email: 'nobody@example.com' });

    expect(known.statusCode).toBe(302);
    expect(String(known.headers.location)).toMatch(/^\/login\?error=MEMBER_NOT_PERMITTED/);
    expect(refusedAt(unknown.headers.location)).toBe(true);
  });

  it('links a default member only through a server that lets members sign in', async () => {
    const {
      alice,
      servers: [allowing, closed],
    } = await memberAlice(2);
    if (!allowing || !closed) throw new Error('servers missing');
    await db.update(users).set({ loginAccess: 'default' }).where(eq(users.id, alice.id));
    await db.insert(serverUsers).values([
      { userId: alice.id, serverId: allowing.id, externalId: 'ext-a', username: 'alice-jf' },
      {
        userId: alice.id,
        serverId: closed.id,
        externalId: 'ext-b',
        username: 'alice2',
        email: 'alice.media@example.com',
      },
    ]);

    const viaClosed = await signIn({ sub: 'sub-c', email: 'alice.media@example.com' });
    expect(String(viaClosed.headers.location)).toMatch(/^\/login\?error=MEMBER_NOT_PERMITTED/);

    const viaAllowing = await signIn({
      sub: 'sub-d',
      email: 'other@example.com',
      preferred_username: 'alice-jf',
    });
    expect(viaAllowing.statusCode).toBe(302);
    expect(viaAllowing.headers.location).toBe('/');
    expect(setCookies(viaAllowing).some((c) => c.includes('session_token='))).toBe(true);

    const links = await db
      .select({ accountId: authAccounts.accountId, userId: authAccounts.userId })
      .from(authAccounts)
      .where(eq(authAccounts.providerId, 'oidc'));
    expect(links).toEqual([{ accountId: 'sub-d', userId: alice.id }]);
  });

  it('links an allowed member through a server whose member switch is off', async () => {
    const {
      alice,
      servers: [, closed],
    } = await memberAlice(2);
    if (!closed) throw new Error('servers missing');
    await db.insert(serverUsers).values({
      userId: alice.id,
      serverId: closed.id,
      externalId: 'ext-b',
      username: 'alice2',
      email: 'alice.media@example.com',
    });

    const res = await signIn({ sub: 'sub-e', email: 'alice.media@example.com' });
    expect(res.headers.location).toBe('/');
    expect(setCookies(res).some((c) => c.includes('session_token='))).toBe(true);
  });

  it('refuses a sign-in that completes after OIDC was switched off', async () => {
    const {
      alice,
      servers: [allowing],
    } = await memberAlice();
    if (!allowing) throw new Error('server missing');
    await db
      .insert(serverUsers)
      .values({ userId: alice.id, serverId: allowing.id, externalId: 'ext-a', username: 'alice' });

    profile = { sub: 'sub-e', email: 'alice@example.com' };
    const finish = await startSignIn();
    await setSetting('loginMethods', { local: true, plex: true, oidc: false, member: true });
    const res = await finish();

    expect(refusedAt(res.headers.location)).toBe(true);
    expect(setCookies(res).some((c) => /session_token=[^;]/.test(c) && !/Max-Age=0/i.test(c))).toBe(
      false
    );
  });

  it('signs out without sending the browser to the identity provider', async () => {
    const {
      alice,
      servers: [allowing],
    } = await memberAlice();
    if (!allowing) throw new Error('server missing');
    await db
      .insert(serverUsers)
      .values({ userId: alice.id, serverId: allowing.id, externalId: 'ext-a', username: 'alice' });
    const signedIn = await signIn({ sub: 'sub-f', email: 'alice@example.com' });
    expect(signedIn.headers.location).toBe('/');

    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/auth/sign-out`,
      headers: { origin, 'content-type': 'application/json', cookie: cookieHeader(signedIn) },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(res.headers.location).toBeUndefined();
  });
});
