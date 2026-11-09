/**
 * Member login security tests
 *
 * Credentials stay out of request logs, every refusal is one indistinguishable answer, and a
 * disabled login method is refused server-side even for a well-formed request. That no users,
 * settings or debug route returns a member token is asserted against real rows in
 * test/integration/betterAuthSecurity.integration.test.ts, since those routes select named columns and a
 * mocked database could only echo back what the test fed it.
 */

import { Writable } from 'node:stream';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import type * as AuthGuards from '../lib/authGuards.js';
import type * as Settings from '../services/settings.js';

vi.mock('../db/client.js', () => ({ db: { select: vi.fn(), insert: vi.fn() } }));
vi.mock('../lib/authGuards.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthGuards>()),
  usableLoginMethods: vi.fn(),
  canMemberLogin: vi.fn(),
}));
vi.mock('../services/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Settings>();
  return {
    ...actual,
    getSetting: vi.fn((key: Parameters<typeof actual.getSetting>[0]) =>
      key === 'memberSsoOnly' ? Promise.resolve(false) : actual.getSetting(key)
    ),
  };
});
vi.mock('../services/userService.js', () => ({ getOwnerUser: vi.fn() }));

const mockRedis = { get: vi.fn(), setex: vi.fn(), del: vi.fn(), eval: vi.fn() };
vi.mock('../lib/redisShared.js', () => ({
  getRedis: () => mockRedis,
  closeRedis: vi.fn(),
  INCREMENT_SCRIPT: 'increment',
}));

import { db } from '../db/client.js';
import { canMemberLogin, notPermitted, refused, usableLoginMethods } from '../lib/authGuards.js';
import { closeAuth, getAuth } from '../lib/auth.js';
import { createBetterAuthHandler } from '../lib/betterAuthRequest.js';
import { memberLoginPlugin } from '../lib/memberLoginPlugin.js';
import { getSetting } from '../services/settings.js';
import { getOwnerUser } from '../services/userService.js';
import { REQUEST_LOG_REDACT } from '../utils/logger.js';

const SERVER_ID = '7b0f3c2e-9a51-4c1d-8e2f-3a4b5c6d7e8f';
const PASSWORD = 'correct horse battery staple';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

function makeChain(result: unknown = []) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'values']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.onConflictDoUpdate = vi.fn(() => Promise.resolve());
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return chain;
}

function selects(...results: unknown[][]) {
  for (const rows of results) vi.mocked(db.select).mockReturnValueOnce(makeChain(rows) as never);
}

function methods(overrides: Partial<Record<'local' | 'plex' | 'oidc' | 'member', boolean>>) {
  vi.mocked(usableLoginMethods).mockResolvedValue({
    local: true,
    plex: true,
    oidc: true,
    member: true,
    ...overrides,
  });
}

type Endpoints = ReturnType<typeof memberLoginPlugin>['endpoints'];

function refusal(name: keyof Endpoints, body: Record<string, unknown>): Promise<string> {
  const endpoint = memberLoginPlugin().endpoints[name] as (input: unknown) => Promise<unknown>;
  const context = {
    internalAdapter: { createSession: vi.fn(), findUserById: vi.fn() },
    logger: console,
  };
  return endpoint({ body, headers: new Headers(), context }).then(
    () => 'signed in',
    (e: { statusCode: number; body: unknown }) =>
      JSON.stringify({ status: e.statusCode, body: e.body })
  );
}

function hookRefusal(path: string, body: Record<string, unknown> = {}): Promise<string> {
  const before = getAuth().options.hooks?.before;
  if (!before) throw new Error('before hook missing');
  return before({ path, body, context: { socialProviders: [] } } as never).then(
    () => 'allowed',
    (e: { statusCode: number; body: unknown }) =>
      JSON.stringify({ status: e.statusCode, body: e.body })
  );
}

const signIn = { serverId: SERVER_ID, username: 'alice', password: PASSWORD };
const loginServer = [{ id: SERVER_ID, url: 'http://jellyfin.local:8096' }];
const authenticated = () => Response.json({ User: { Id: 'ext-1' }, AccessToken: 'member-token' });

describe('member login security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReturnValue(makeChain() as never);
    fetchMock.mockReset();
    methods({});
    vi.mocked(canMemberLogin).mockResolvedValue({ ok: true });
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue(1);
  });

  afterAll(async () => {
    await closeAuth();
  });

  it('keeps passwords, tokens and auth headers out of request logs', async () => {
    let captured = '';
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        captured += chunk.toString();
        done();
      },
    });
    // Fastify's default serializer already drops headers and bodies. This one keeps them, as a
    // debugging serializer would, so the redaction is what is under test.
    const app = Fastify({
      logger: {
        level: 'info',
        stream,
        redact: REQUEST_LOG_REDACT,
        serializers: {
          req: (req: { headers: unknown; body?: unknown }) => ({
            headers: req.headers,
            body: req.body,
          }),
        },
      },
    });
    app.route({
      method: 'POST',
      url: '/api/v1/auth/*',
      handler: createBetterAuthHandler(() => ({
        handler: async () => Response.json(refused().body, { status: 403 }),
      })),
    });
    app.post('/api/v1/anything', async (request) => {
      request.log.info({ req: request }, 'handled');
      return { ok: true };
    });
    app.addHook('preHandler', async (request) => {
      request.log.info({ req: request }, 'parsed');
    });

    const secrets = {
      password: PASSWORD,
      Pw: 'pw-value',
      token: 'token-value',
      secret: 'qc-secret-value',
      accessToken: 'access-token-value',
    };
    const headers = {
      authorization: 'Bearer auth-header-value',
      cookie: 'better-auth.session_token=cookie-value',
      'x-emby-authorization': 'Emby Token="emby-auth-value"',
      'x-emby-token': 'emby-token-value',
    };
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/jellyfin/sign-in',
      headers,
      payload: { serverId: SERVER_ID, username: 'alice', ...secrets },
    });
    await app.inject({ method: 'POST', url: '/api/v1/anything', headers, payload: secrets });
    await app.close();

    expect(captured).toContain('[redacted]');
    for (const value of [...Object.values(secrets), 'auth-header-value', 'cookie-value']) {
      expect(captured).not.toContain(value);
    }
    expect(captured).not.toContain('emby-auth-value');
    expect(captured).not.toContain('emby-token-value');
  });

  it('answers every refusal with the same status and body', async () => {
    const answers: string[] = [];

    selects([]);
    answers.push(await refusal('jellyfinSignIn', signIn));

    selects(loginServer);
    mockRedis.eval.mockResolvedValueOnce(4);
    answers.push(await refusal('jellyfinSignIn', signIn));

    selects(loginServer, []);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    answers.push(await refusal('jellyfinSignIn', signIn));

    selects(loginServer, []);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    answers.push(await refusal('embySignIn', signIn));

    selects(loginServer, [], []);
    fetchMock.mockResolvedValueOnce(authenticated());
    answers.push(await refusal('jellyfinSignIn', signIn));

    selects(loginServer, [], [{ userId: 'member-1' }]);
    vi.mocked(canMemberLogin).mockResolvedValueOnce({ ok: false, reason: 'refused' });
    fetchMock.mockResolvedValueOnce(authenticated());
    answers.push(await refusal('jellyfinSignIn', signIn));

    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ serverId: SERVER_ID, secret: 's', deviceId: 'd' })
    );
    selects(loginServer);
    fetchMock
      .mockResolvedValueOnce(Response.json({ Authenticated: true }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    answers.push(await refusal('quickConnectCheck', { handle: 'b'.repeat(64) }));

    vi.mocked(getSetting).mockResolvedValueOnce(true as never);
    answers.push(await refusal('jellyfinSignIn', signIn));

    // The code is what makes the OIDC callback redirect to the login page instead of raw JSON.
    expect(refused().body).toMatchObject({ code: 'MEMBER_LOGIN_REFUSED' });
    expect(answers).toHaveLength(8);
    expect(new Set(answers)).toEqual(
      new Set([JSON.stringify({ status: 403, body: refused().body })])
    );
  });

  it('refuses a disabled login method on a well-formed request', async () => {
    const expected = JSON.stringify({ status: 403, body: refused().body });
    vi.mocked(getOwnerUser).mockResolvedValue({ id: 'owner-1' } as never);

    methods({ local: false });
    expect(await hookRefusal('/sign-in/email', { email: 'a@b.c', password: PASSWORD })).toBe(
      expected
    );
    expect(await hookRefusal('/sign-in/username', { username: 'a', password: PASSWORD })).toBe(
      expected
    );

    methods({ plex: false, member: false });
    selects([]);
    expect(await hookRefusal('/plex/check-pin', { handle: 'handle' })).toBe(expected);

    methods({ oidc: false });
    expect(await hookRefusal('/sign-in/social', { provider: 'oidc' })).toBe(expected);

    // No live server of that type, which is also how a historical one looks
    methods({ member: false });
    selects([], [], []);
    expect(await refusal('jellyfinSignIn', signIn)).toBe(expected);
    expect(await refusal('embySignIn', signIn)).toBe(expected);
    expect(await refusal('quickConnectInitiate', { serverId: SERVER_ID })).toBe(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says not permitted only after the media server accepted the password', async () => {
    const notPermittedBody = JSON.stringify({ status: 403, body: notPermitted().body });
    vi.mocked(canMemberLogin).mockResolvedValue({ ok: false, reason: 'not-permitted' });
    methods({ member: false });

    selects(loginServer, []);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await refusal('jellyfinSignIn', signIn)).toBe(
      JSON.stringify({ status: 403, body: refused().body })
    );

    selects(loginServer, [], [{ userId: 'member-1' }]);
    fetchMock
      .mockResolvedValueOnce(authenticated())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await refusal('jellyfinSignIn', signIn)).toBe(notPermittedBody);
    expect(notPermitted().body).toMatchObject({
      code: 'MEMBER_NOT_PERMITTED',
      message: 'You are not permitted to sign in. Please contact the server owner.',
    });
  });
});
