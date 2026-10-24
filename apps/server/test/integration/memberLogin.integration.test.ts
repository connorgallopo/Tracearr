/**
 * Member sign-in against live Jellyfin and Emby servers (integration)
 *
 * Creates a throwaway tracearr-it-<random> user on each server through its admin API, syncs it
 * into the test database, signs it in through the real Better Auth handler, then disables it on
 * the server and expects memberStillValid to turn false. The users are deleted in afterAll even
 * when a case fails. Skipped unless the server URL and admin API key env vars are set.
 *
 * Run with: TEST_JELLYFIN_URL=... TEST_JELLYFIN_API_KEY=... TEST_EMBY_URL=... TEST_EMBY_API_KEY=...
 *   pnpm --filter @tracearr/server test:integration memberLogin
 */

import { randomBytes } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { and, eq } from 'drizzle-orm';
import { API_BASE_PATH } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import { servers, serverUsers, users } from '../../src/db/schema.js';
import { closeAuth } from '../../src/lib/auth.js';
import { createBetterAuthHandler } from '../../src/lib/betterAuthRequest.js';
import { memberStillValid } from '../../src/lib/memberLogin.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { resetSettingsCache, setSetting } from '../../src/services/settings.js';
import { syncServer } from '../../src/services/sync.js';
import authPlugin from '../../src/plugins/auth.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';

type ServerType = 'jellyfin' | 'emby';

const targets: { type: ServerType; url?: string; key?: string }[] = [
  {
    type: 'jellyfin',
    url: process.env.TEST_JELLYFIN_URL,
    key: process.env.TEST_JELLYFIN_API_KEY,
  },
  { type: 'emby', url: process.env.TEST_EMBY_URL, key: process.env.TEST_EMBY_API_KEY },
];

const created: { url: string; key: string; id: string }[] = [];

async function admin(url: string, key: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'X-Emby-Token': key,
      Authorization: `MediaBrowser Token="${key}"`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return res.status === 204 ? null : ((await res.json().catch(() => null)) as unknown);
}

async function createServerUser(url: string, key: string, name: string, password: string) {
  const made = (await admin(url, key, 'POST', '/Users/New', { Name: name })) as { Id: string };
  created.push({ url, key, id: made.Id });
  await admin(url, key, 'POST', `/Users/${made.Id}/Password`, { NewPw: password });
  return made.Id;
}

async function disableServerUser(url: string, key: string, id: string) {
  const user = (await admin(url, key, 'GET', `/Users/${id}`)) as {
    Policy: Record<string, unknown>;
  };
  await admin(url, key, 'POST', `/Users/${id}/Policy`, { ...user.Policy, IsDisabled: true });
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
  await app.register(sessionRoutes, { prefix: `${API_BASE_PATH}/sessions` });
  return app;
}

afterAll(async () => {
  for (const user of created) {
    await admin(user.url, user.key, 'DELETE', `/Users/${user.id}`).catch((error: unknown) => {
      console.error(`could not delete throwaway user ${user.id}`, String(error));
    });
  }
  const redis = getRedis();
  const keys = await redis.keys(`${process.env.REDIS_PREFIX ?? ''}tracearr:ba:*`);
  if (keys.length > 0) await redis.del(...keys);
  resetSettingsCache();
  await closeAuth();
});

describe.each(targets)('member sign-in through $type (live server)', ({ type, url, key }) => {
  it.skipIf(!url || !key)('signs in, reads sessions, and is revoked when disabled', async () => {
    if (!url || !key) return;
    const name = `tracearr-it-${randomBytes(4).toString('hex')}`;
    const password = `Pw-${randomBytes(8).toString('hex')}`;
    const externalId = await createServerUser(url, key, name, password);

    const [server] = await db
      .insert(servers)
      .values({ name: `it-${type}`, type, url, token: key, allowMemberLogin: true })
      .returning();
    if (!server) throw new Error('server insert returned nothing');
    await setSetting('loginMethods', { local: true, plex: true, oidc: true, member: true });
    await syncServer(server.id, { syncUsers: true, syncLibraries: false });

    const [identity] = await db
      .select({ userId: serverUsers.userId })
      .from(serverUsers)
      .where(and(eq(serverUsers.serverId, server.id), eq(serverUsers.externalId, externalId)))
      .limit(1);
    if (!identity) throw new Error('the throwaway user was not synced');
    await db.update(users).set({ loginAccess: 'allow' }).where(eq(users.id, identity.userId));

    const app = await buildApp();
    try {
      const signIn = await app.inject({
        method: 'POST',
        url: `${API_BASE_PATH}/auth/${type}/sign-in`,
        headers: { origin: 'http://localhost:80', 'content-type': 'application/json' },
        payload: { serverId: server.id, username: name, password },
      });
      expect(signIn.statusCode).toBe(200);
      const body = signIn.json();
      expect(body.authorized).toBe(true);
      expect(Object.keys(body.user).sort()).toEqual(['id', 'role', 'username']);
      expect(body.user.id).toBe(identity.userId);

      const raw = signIn.headers['set-cookie'];
      const cookies = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((c) => c.split(';')[0]);
      expect(cookies.some((c) => c?.includes('session_token='))).toBe(true);

      const sessions = await app.inject({
        method: 'GET',
        url: `${API_BASE_PATH}/sessions`,
        headers: { cookie: cookies.join('; ') },
      });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json().data).toEqual([]);

      expect(await memberStillValid(identity.userId)).toBe(true);
      await disableServerUser(url, key, externalId);
      expect(await memberStillValid(identity.userId)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
