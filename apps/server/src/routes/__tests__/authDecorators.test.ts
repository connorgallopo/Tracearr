/**
 * Auth Decorators Dual-Verify Tests
 *
 * Verifies `authenticate` and `requireOwner` resolve a Better Auth session
 * (cookie or bearer) first, falling back to legacy JWT verification.
 *
 * No live Postgres/Redis is available in this environment (see
 * betterAuthMount.test.ts for the same constraint on this branch), so
 * `getAuth()` is mocked rather than exercising a real Better Auth session
 * through the drizzle adapter. The decorators and `resolveBetterAuthUser`
 * under test are real; only the Better Auth session lookup and the server
 * IDs cache's DB query are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { API_BASE_PATH } from '@tracearr/shared';

vi.mock('../../lib/auth.js', () => ({
  getAuth: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../services/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/settings.js')>();
  return { ...actual, getSetting: vi.fn(actual.getSetting) };
});

import { getAuth } from '../../lib/auth.js';
import { db } from '../../db/client.js';
import authPlugin, { loadJwtRevokeSettings } from '../../plugins/auth.js';
import { getSetting } from '../../services/settings.js';
import { sessionRoutes } from '../auth/session.js';
import { registerErrorHandler } from '../../utils/errors.js';
import { users, servers, authAccounts } from '../../db/schema.js';

function mockBetterAuthSession(user: Record<string, unknown> | null) {
  const getSession = vi.fn().mockResolvedValue(user ? { user } : null);
  vi.mocked(getAuth).mockReturnValue({
    api: { getSession },
  } as unknown as ReturnType<typeof getAuth>);
  return getSession;
}

// Builds a chainable stand-in for a drizzle select query that resolves to
// `rows` whether the caller awaits after `.from()` or continues on to
// `.where().limit()`.
function selectResult(rows: unknown[]) {
  const chain: Record<string, unknown> = {
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

// Routes `db.select().from(table)` to canned rows by table identity rather
// than call order, since the authenticate decorator's server-id lookup runs
// before the /me handler's own queries and the order between them isn't
// stable across the suite (module-level cache in sessionResolver.ts).
function tableAwareSelect(rowsByTable: {
  users?: unknown[];
  servers?: unknown[];
  authAccountsSequence?: unknown[][];
}) {
  let authAccountsCallIndex = 0;
  return () => ({
    from: vi.fn((table: unknown) => {
      if (table === users) return selectResult(rowsByTable.users ?? []);
      if (table === servers) return selectResult(rowsByTable.servers ?? []);
      if (table === authAccounts) {
        const rows = rowsByTable.authAccountsSequence?.[authAccountsCallIndex] ?? [];
        authAccountsCallIndex += 1;
        return selectResult(rows);
      }
      return selectResult([]);
    }),
  });
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(cookie, { secret: 'test-cookie-secret' });
  await app.register(authPlugin);
  await app.register(sessionRoutes, { prefix: `${API_BASE_PATH}/auth` });

  app.get('/test/protected', { preHandler: [app.authenticate] }, async (request) => {
    return request.user;
  });

  app.get('/test/owner-only', { preHandler: [app.requireOwner] }, async (request) => {
    return request.user;
  });

  return app;
}

// Simulates a Better Auth owner session backed by a credential account row
// (the shape a real sign-up would leave behind), since no live Postgres is
// available to run an actual sign-up through the drizzle adapter.
async function signUpOwner(_app: FastifyInstance): Promise<string> {
  const userId = 'owner-1';
  mockBetterAuthSession({ id: userId, username: 'owner', name: 'Owner', role: 'owner' });

  vi.mocked(db.select).mockImplementation(
    tableAwareSelect({
      users: [
        {
          id: userId,
          username: 'owner',
          email: 'owner@example.com',
          thumbnail: null,
          role: 'owner',
          aggregateTrustScore: 100,
          passwordHash: null,
          plexAccountId: null,
        },
      ],
      servers: [{ id: 'server-1' }, { id: 'server-2' }],
      authAccountsSequence: [[{ id: 'account-1' }], []],
    }) as never
  );

  return 'better-auth.session_token=abc';
}

describe('auth decorators with better auth sessions', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockResolvedValue([{ id: 'server-1' }, { id: 'server-2' }]),
    } as never);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
    vi.mocked(getAuth).mockReset();
  });

  it('authenticate accepts a better auth session cookie', async () => {
    mockBetterAuthSession({ id: 'user-1', username: 'owner', name: 'Owner', role: 'owner' });
    app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { cookie: 'better-auth.session_token=abc' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('owner');
    expect(Array.isArray(res.json().serverIds)).toBe(true);
  });

  it('authenticate still accepts a legacy JWT', async () => {
    mockBetterAuthSession(null);
    app = await buildTestApp();

    const legacyToken = app.jwt.sign(
      { userId: 'user-1', username: 'owner', role: 'owner', serverIds: [] },
      { expiresIn: '1h' }
    );
    const res = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { authorization: `Bearer ${legacyToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe('owner');
  });

  it('authenticate and requireOwner refuse a legacy JWT issued before jwtRevokedBefore', async () => {
    mockBetterAuthSession(null);
    app = await buildTestApp();
    const legacyToken = app.jwt.sign(
      { userId: 'user-1', username: 'owner', role: 'owner', serverIds: [] },
      { expiresIn: '1h' }
    );
    vi.mocked(getSetting).mockResolvedValueOnce(
      new Date(Date.now() + 60_000).toISOString() as never
    );
    await loadJwtRevokeSettings();

    try {
      for (const url of ['/test/protected', '/test/owner-only']) {
        const res = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${legacyToken}` },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().message).toBe('Session invalidated. Please log in again');
      }
    } finally {
      vi.mocked(getSetting).mockResolvedValueOnce(null as never);
      await loadJwtRevokeSettings();
    }
  });

  it('rejects requests with neither credential', async () => {
    mockBetterAuthSession(null);
    app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/test/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('requireOwner rejects a better auth session for a non-owner', async () => {
    mockBetterAuthSession({ id: 'user-2', username: 'admin', name: 'Admin', role: 'admin' });
    app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test/owner-only',
      headers: { cookie: 'better-auth.session_token=abc' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses to resolve a session for a role outside LOGIN_ROLES', async () => {
    mockBetterAuthSession({ id: 'user-3', username: 'gone', name: 'Gone', role: 'disabled' });
    app = await buildTestApp();

    const res = await app.inject({
      method: 'GET',
      url: '/test/protected',
      headers: { cookie: 'better-auth.session_token=abc' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('requireOwner rejects requests with neither credential', async () => {
    mockBetterAuthSession(null);
    app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/test/owner-only' });
    expect(res.statusCode).toBe(401);
  });

  it('resolveBetterAuthUser lookup errors fail closed to the legacy JWT path', async () => {
    const getSession = vi.fn().mockRejectedValue(new Error('redis down'));
    vi.mocked(getAuth).mockReturnValue({ api: { getSession } } as unknown as ReturnType<
      typeof getAuth
    >);
    app = await buildTestApp();

    const res = await app.inject({ method: 'GET', url: '/test/protected' });
    expect(res.statusCode).toBe(401);
  });

  it('me reports hasPassword from the credential account row', async () => {
    app = await buildTestApp();
    const cookie = await signUpOwner(app);
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      username: expect.any(String),
      role: 'owner',
      hasPassword: true,
      hasPlexLinked: false,
    });
  });
});

describe('auth plugin startup validation', () => {
  const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    if (originalBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    vi.resetModules();
  });

  it('refuses to register when neither BETTER_AUTH_SECRET nor JWT_SECRET is set', async () => {
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.JWT_SECRET;
    const app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(cookie, { secret: 'test-cookie-secret' });
    await expect(app.register(authPlugin).after()).rejects.toThrow('JWT_SECRET');
    await app.close();
  });

  it('registers successfully by deriving the secret when only JWT_SECRET is set', async () => {
    delete process.env.BETTER_AUTH_SECRET;
    process.env.JWT_SECRET = 'test-jwt-secret-must-be-32-chars-min';

    // env.ts memoizes its resolution at module scope, and the top-level
    // `authPlugin` import above already resolved against setup.ts's explicit
    // BETTER_AUTH_SECRET - reusing that import here would pass even if
    // derivation were deleted entirely. Reset the module registry and
    // re-import both the plugin and env.ts so registration actually
    // exercises derivation, then assert the derived path ran.
    vi.resetModules();
    const { default: freshAuthPlugin } = await import('../../plugins/auth.js');
    const { isBetterAuthSecretDerived } = await import('../../lib/env.js');

    const app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(cookie, { secret: 'test-cookie-secret' });
    await expect(app.register(freshAuthPlugin).after()).resolves.not.toThrow();
    expect(isBetterAuthSecretDerived()).toBe(true);
    await app.close();
  });
});
