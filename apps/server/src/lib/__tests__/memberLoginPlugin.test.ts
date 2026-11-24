/**
 * Member login plugin tests
 *
 * The endpoints are invoked directly with a mocked Better Auth context, as in plexPlugin.test.ts.
 * The Jellyfin and Emby clients are the real ones over a stubbed fetch, so the outbound requests
 * (body field names, headers, which calls are made at all) are what is asserted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type * as AuthGuards from '../authGuards.js';
import type * as SiloAuth from '../../services/mediaServer/silo/auth.js';

vi.mock('../../db/client.js', () => ({ db: { select: vi.fn(), insert: vi.fn() } }));
vi.mock('../auth.js', () => ({ CLIENT_IP_HEADER: 'x-tracearr-client-ip' }));
vi.mock('../authGuards.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthGuards>()),
  usableLoginMethods: vi.fn(),
  canMemberLogin: vi.fn(),
}));
vi.mock('../../services/userService.js', () => ({ getOwnerUser: vi.fn() }));
vi.mock('../../services/settings.js', () => ({ getSetting: vi.fn() }));
vi.mock('../../services/mediaServer/silo/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SiloAuth>()),
  passwordLogin: vi.fn(),
  logout: vi.fn(),
  pairingOffered: vi.fn(),
  startPairing: vi.fn(),
  pollPairing: vi.fn(),
  cancelPairing: vi.fn(),
}));

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  eval: vi.fn(),
  ttl: vi.fn(),
  expire: vi.fn(),
};
vi.mock('../redisShared.js', () => ({
  getRedis: () => mockRedis,
  INCREMENT_SCRIPT: 'increment',
  GET_AND_DELETE_SCRIPT: 'get-and-delete',
}));

const mockSetSessionCookie = vi.fn(async (ctx: { setCookie: (k: string, v: string) => void }) => {
  ctx.setCookie('better-auth.session_token', 'sess-token');
});
vi.mock('better-auth/cookies', () => ({
  setSessionCookie: (ctx: unknown) => mockSetSessionCookie(ctx as never),
}));

import { MEMBER_LOGIN_REFUSED } from '../authGuards.js';
import { canMemberLogin, usableLoginMethods } from '../authGuards.js';
import { db } from '../../db/client.js';
import { getOwnerUser } from '../../services/userService.js';
import { getSetting } from '../../services/settings.js';
import { memberLoginPlugin } from '../memberLoginPlugin.js';
import { linkOidcMember, memberStillValid } from '../memberLogin.js';
import {
  cancelPairing,
  logout,
  pairingOffered,
  passwordLogin,
  pollPairing,
  startPairing,
} from '../../services/mediaServer/silo/auth.js';

const SERVER_ID = '7b0f3c2e-9a51-4c1d-8e2f-3a4b5c6d7e8f';
const URL = 'http://jellyfin.local:8096';
const HANDLE = 'a'.repeat(64);

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

function makeChain(result: unknown = []) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'orderBy', 'values']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.onConflictDoUpdate = vi.fn(() => Promise.resolve());
  chain.onConflictDoNothing = vi.fn(() => Promise.resolve());
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return chain;
}

function selects(...results: unknown[][]) {
  for (const rows of results) vi.mocked(db.select).mockReturnValueOnce(makeChain(rows) as never);
}

/** Answers each request by the path it hits; an unlisted path fails the test. */
function server(routes: Record<string, () => Response | Promise<Response>>) {
  fetchMock.mockImplementation(async (url) => {
    const path = new globalThis.URL(url).pathname;
    const route = routes[path];
    if (!route) throw new Error(`unexpected request to ${path}`);
    return route();
  });
}

function sentTo(path: string) {
  const call = fetchMock.mock.calls.find(([url]) => new globalThis.URL(url).pathname === path);
  if (!call) throw new Error(`no request to ${path}`);
  return { headers: call[1]?.headers as Record<string, string>, body: call[1]?.body };
}

function makeCtx() {
  const createSession = vi.fn(async (userId: string) => ({ id: 's1', token: 't1', userId }));
  const findUserById = vi.fn(async (userId: string) => ({
    id: userId,
    name: 'Alice',
    username: 'alice',
    role: userId === 'owner-1' ? 'owner' : 'member',
  }));
  return { internalAdapter: { createSession, findUserById }, logger: console };
}

type Endpoints = ReturnType<typeof memberLoginPlugin>['endpoints'];

async function call(name: keyof Endpoints, body: Record<string, unknown>, context = makeCtx()) {
  const endpoint = memberLoginPlugin().endpoints[name] as (input: unknown) => Promise<unknown>;
  const result = (await endpoint({
    body,
    headers: new Headers({ 'x-tracearr-client-ip': '203.0.113.9' }),
    context,
    returnHeaders: true,
  })) as { headers: Headers; response: Record<string, unknown> };
  return { ...result, context };
}

const signIn = { serverId: SERVER_ID, username: 'Alice', password: 'hunter2' };
const loginServer = [{ id: SERVER_ID, url: URL }];
const authenticated = () =>
  Response.json({ User: { Id: 'ext-1' }, AccessToken: 'member-token', SessionInfo: {} });

describe('member login plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.mocked(db.select).mockReset();
    vi.mocked(getSetting).mockReset();
    vi.mocked(db.insert).mockReturnValue(makeChain() as never);
    vi.mocked(usableLoginMethods).mockResolvedValue({
      local: true,
      plex: true,
      oidc: false,
      tofa: false,
      member: true,
    });
    vi.mocked(canMemberLogin).mockResolvedValue({ ok: true });
    mockRedis.get.mockResolvedValue(null);
    mockRedis.eval.mockResolvedValue(1);
  });

  describe('jellyfin password', () => {
    it('signs in and returns only the identity', async () => {
      selects(loginServer, [{ userId: 'member-1' }], [{ userId: 'member-1' }], []);
      server({ '/Users/AuthenticateByName': authenticated });

      const { response, headers, context } = await call('jellyfinSignIn', signIn);

      expect(response).toEqual({
        authorized: true,
        user: { id: 'member-1', username: 'alice', role: 'member' },
      });
      expect(headers.get('set-cookie')).toContain('better-auth.session_token');
      expect(context.internalAdapter.createSession).toHaveBeenCalledWith('member-1');
      const insert = vi.mocked(db.insert).mock.results[0]?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'jellyfin',
          accountId: `${SERVER_ID}:ext-1`,
          userId: 'member-1',
          accessToken: 'member-token',
        })
      );
      const sent = sentTo('/Users/AuthenticateByName');
      expect(JSON.parse(String(sent.body))).toEqual({ Username: 'Alice', Pw: 'hunter2' });
      expect(sent.headers.Authorization).toContain('DeviceId="tracearr-member-1"');
      expect(sent.headers['X-Forwarded-For']).toBe('203.0.113.9');
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining(`${SERVER_ID}:alice`));
    });

    it('refuses a server that does not allow member login without calling it', async () => {
      selects([]);
      await expect(call('jellyfinSignIn', signIn)).rejects.toMatchObject({
        statusCode: 403,
        body: { message: MEMBER_LOGIN_REFUSED },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses while single sign-on only is on, without calling the server', async () => {
      vi.mocked(getSetting).mockImplementation(async (key) => (key === 'memberSsoOnly') as never);
      await expect(call('jellyfinSignIn', signIn)).rejects.toMatchObject({
        statusCode: 403,
        body: { message: MEMBER_LOGIN_REFUSED },
      });
      await expect(call('quickConnectInitiate', { serverId: SERVER_ID })).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(db.select).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a wrong password the same way and counts the failure', async () => {
      selects(loginServer, []);
      server({ '/Users/AuthenticateByName': () => new Response('bad', { status: 401 }) });

      await expect(call('jellyfinSignIn', signIn)).rejects.toMatchObject({
        statusCode: 403,
        body: { message: MEMBER_LOGIN_REFUSED },
      });
      expect(mockRedis.eval).toHaveBeenCalledExactlyOnceWith(
        'increment',
        1,
        expect.stringContaining(`${SERVER_ID}:alice`),
        900
      );
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('stops past the third attempt before calling the server', async () => {
      selects(loginServer);
      mockRedis.eval.mockResolvedValue(4);

      await expect(call('jellyfinSignIn', signIn)).rejects.toMatchObject({ statusCode: 403 });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers a fixed 503 when the server cannot be reached', async () => {
      selects(loginServer, []);
      fetchMock.mockRejectedValue(new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.5'));

      const error = await call('jellyfinSignIn', signIn).catch((e: unknown) => e);
      expect(error).toMatchObject({
        statusCode: 503,
        body: { message: 'The media server could not be reached.' },
      });
      expect(JSON.stringify(error)).not.toContain('ECONNREFUSED');
      expect(mockRedis.eval).toHaveBeenLastCalledWith(
        expect.stringContaining('DECR'),
        1,
        expect.stringContaining(`${SERVER_ID}:alice`)
      );
    });

    it('answers a fixed 500 for any other server failure', async () => {
      selects(loginServer, []);
      server({
        '/Users/AuthenticateByName': () => new Response('stack trace detail', { status: 500 }),
      });

      const error = await call('jellyfinSignIn', signIn).catch((e: unknown) => e);
      expect(error).toMatchObject({
        statusCode: 500,
        body: { message: 'Sign-in failed. Try again later.' },
      });
      expect(JSON.stringify(error)).not.toContain('stack trace detail');
    });

    it("signs the owner in with the owner's own Jellyfin credentials, blocked access aside", async () => {
      const actual = await vi.importActual<typeof AuthGuards>('../authGuards.js');
      vi.mocked(canMemberLogin).mockImplementation(actual.canMemberLogin);
      selects(
        loginServer,
        [{ userId: 'owner-1' }],
        [{ userId: 'owner-1' }],
        [{ role: 'owner', loginAccess: 'block' }],
        []
      );
      server({ '/Users/AuthenticateByName': authenticated });

      const { response, context } = await call('jellyfinSignIn', signIn);

      expect(response).toMatchObject({ authorized: true, user: { id: 'owner-1', role: 'owner' } });
      expect(context.internalAdapter.createSession).toHaveBeenCalledWith('owner-1');
    });

    it('logs out the token Jellyfin issued when the gates refuse the identity', async () => {
      selects(loginServer, [], [{ userId: 'member-1' }]);
      vi.mocked(canMemberLogin).mockResolvedValue({ ok: false, reason: 'refused' });
      server({
        '/Users/AuthenticateByName': authenticated,
        '/Sessions/Logout': () => new Response(null, { status: 204 }),
      });

      await expect(call('jellyfinSignIn', signIn)).rejects.toMatchObject({ statusCode: 403 });
      expect(sentTo('/Sessions/Logout').headers.Authorization).toBe(
        'MediaBrowser Token="member-token"'
      );
    });

    it('logs out the token a new sign-in replaces', async () => {
      selects(loginServer, [], [{ userId: 'member-1' }], [{ token: 'older-token' }]);
      server({
        '/Users/AuthenticateByName': authenticated,
        '/Sessions/Logout': () => new Response(null, { status: 204 }),
      });

      await call('jellyfinSignIn', signIn);
      expect(sentTo('/Sessions/Logout').headers.Authorization).toBe(
        'MediaBrowser Token="older-token"'
      );
    });

    it('skips the logout when Jellyfin already replaced the token for the same device', async () => {
      selects(
        loginServer,
        [{ userId: 'member-1' }],
        [{ userId: 'member-1' }],
        [{ token: 'older-token', deviceId: 'tracearr-member-1' }]
      );
      server({ '/Users/AuthenticateByName': authenticated });

      await call('jellyfinSignIn', signIn);
      expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/Sessions/Logout'))).toBe(false);
    });

    it('fails a sign-in whose account write fails without the token in the error', async () => {
      selects(loginServer, [], [{ userId: 'member-1' }], []);
      const failing = makeChain();
      failing.onConflictDoUpdate = vi.fn(() =>
        Promise.reject(new Error('Failed query: insert ... params: member-token'))
      );
      vi.mocked(db.insert).mockReturnValue(failing as never);
      server({ '/Users/AuthenticateByName': authenticated });

      const error = await call('jellyfinSignIn', signIn).catch((e: unknown) => e);
      expect(error).toMatchObject({ statusCode: 500 });
      expect(JSON.stringify(error)).not.toContain('member-token');
    });
  });

  describe('jellyfin quick connect', () => {
    it('answers 404 when Quick Connect is off', async () => {
      selects(loginServer);
      server({ '/QuickConnect/Enabled': () => Response.json(false) });

      await expect(call('quickConnectInitiate', { serverId: SERVER_ID })).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it('returns the handle and code and keeps the secret in Redis', async () => {
      selects(loginServer);
      server({
        '/QuickConnect/Enabled': () => Response.json(true),
        '/QuickConnect/Initiate': () => Response.json({ Secret: 'qc-secret', Code: '123456' }),
      });

      const { response } = await call('quickConnectInitiate', { serverId: SERVER_ID });

      expect(Object.keys(response).sort()).toEqual(['code', 'handle']);
      expect(response.code).toBe('123456');
      const [key, ttl, value] = mockRedis.setex.mock.calls[0] ?? [];
      expect(key).toContain(String(response.handle));
      expect(ttl).toBe(600);
      expect(JSON.parse(String(value))).toEqual({
        serverId: SERVER_ID,
        secret: 'qc-secret',
        deviceId: `tracearr-qc-${String(response.handle).slice(0, 16)}`,
      });
    });

    it('answers an unknown handle as expired without any outbound call', async () => {
      const { response } = await call('quickConnectCheck', { handle: HANDLE });
      expect(response).toEqual({ authorized: false, expired: true });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('answers expired and drops the handle when Jellyfin no longer knows the request', async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({ serverId: SERVER_ID, secret: 'qc-secret', deviceId: 'tracearr-qc-x' })
      );
      selects(loginServer);
      server({ '/QuickConnect/Connect': () => new Response(null, { status: 404 }) });

      const { response } = await call('quickConnectCheck', { handle: HANDLE });

      expect(response).toEqual({ authorized: false, expired: true });
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining(HANDLE));
    });

    it('waits while pending, then redeems with the initiating device and signs in', async () => {
      mockRedis.get.mockResolvedValue(
        JSON.stringify({ serverId: SERVER_ID, secret: 'qc-secret', deviceId: 'tracearr-qc-x' })
      );
      let approved = false;
      server({
        '/QuickConnect/Connect': () => Response.json({ Authenticated: approved }),
        '/Users/AuthenticateWithQuickConnect': authenticated,
      });

      selects(loginServer);
      expect((await call('quickConnectCheck', { handle: HANDLE })).response).toEqual({
        authorized: false,
      });
      expect(mockRedis.del).not.toHaveBeenCalled();

      approved = true;
      selects(loginServer, [{ userId: 'member-1' }], []);
      const { response, headers } = await call('quickConnectCheck', { handle: HANDLE });

      expect(response).toMatchObject({ authorized: true, user: { id: 'member-1' } });
      expect(headers.get('set-cookie')).toContain('better-auth.session_token');
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining(HANDLE));
      const redeem = sentTo('/Users/AuthenticateWithQuickConnect');
      expect(JSON.parse(String(redeem.body))).toEqual({ Secret: 'qc-secret' });
      expect(redeem.headers.Authorization).toContain('DeviceId="tracearr-qc-x"');
    });
  });

  it('signs in through Emby with Pw and the Emby authorization header', async () => {
    selects(loginServer, [], [{ userId: 'member-1' }], []);
    server({ '/Users/AuthenticateByName': authenticated });

    const { response } = await call('embySignIn', signIn);

    expect(response).toMatchObject({ authorized: true, user: { id: 'member-1' } });
    const sent = sentTo('/Users/AuthenticateByName');
    expect(sent.headers['X-Emby-Authorization']).toMatch(/^Emby /);
    expect(JSON.parse(String(sent.body))).toEqual({ Username: 'Alice', Pw: 'hunter2' });
  });

  describe('silo', () => {
    const SILO_URL = 'http://silo.local:8080';
    const siloServer = [{ id: SERVER_ID, url: SILO_URL, publicUrl: null }];
    const login = {
      accessToken: 'silo-token',
      user: { id: '34', username: 'alice', email: null, role: 'user' },
    };
    const signInState = {
      purpose: 'sign-in',
      serverId: SERVER_ID,
      url: SILO_URL,
      publicUrl: null,
      deviceCode: 'device-code',
      secret: 'binding-secret',
    };
    const stored = (state: object) => mockRedis.get.mockResolvedValue(JSON.stringify(state));
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0] ?? Infinity;

    function storedAccount() {
      const insert = vi.mocked(db.insert).mock.results[0]?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      return insert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    }

    beforeEach(() => {
      vi.mocked(passwordLogin).mockReset();
      vi.mocked(logout).mockReset().mockResolvedValue(undefined);
      vi.mocked(pairingOffered).mockReset().mockResolvedValue(true);
      vi.mocked(startPairing).mockReset();
      vi.mocked(pollPairing).mockReset();
      vi.mocked(cancelPairing).mockReset().mockResolvedValue(undefined);
      mockRedis.ttl.mockResolvedValue(900);
    });

    describe('password', () => {
      it('logs the Silo login out, then signs in through the synced account with no token', async () => {
        selects(siloServer, [{ userId: 'member-1' }], []);
        vi.mocked(passwordLogin).mockResolvedValue(login);

        const { response, context } = await call('siloSignIn', signIn);

        expect(response).toEqual({
          authorized: true,
          user: { id: 'member-1', username: 'alice', role: 'member' },
        });
        expect(passwordLogin).toHaveBeenCalledExactlyOnceWith(SILO_URL, 'Alice', 'hunter2');
        expect(logout).toHaveBeenCalledExactlyOnceWith(SILO_URL, 'silo-token');
        expect(order(vi.mocked(logout))).toBeLessThan(order(context.internalAdapter.createSession));
        expect(order(vi.mocked(logout))).toBeLessThan(order(vi.mocked(db.insert)));
        expect(storedAccount()).toMatchObject({
          providerId: 'silo',
          accountId: `${SERVER_ID}:34`,
          userId: 'member-1',
          accessToken: null,
          scope: null,
        });
        // No DeviceId lookup: the server row, the account, the stored sign-in row
        expect(db.select).toHaveBeenCalledTimes(3);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it('counts a refusal as a failure and stops past the third before calling Silo', async () => {
        selects(siloServer);
        vi.mocked(passwordLogin).mockResolvedValue(null);

        await expect(call('siloSignIn', signIn)).rejects.toMatchObject({
          statusCode: 403,
          body: { message: MEMBER_LOGIN_REFUSED },
        });
        expect(mockRedis.eval).toHaveBeenCalledExactlyOnceWith(
          'increment',
          1,
          expect.stringContaining(`${SERVER_ID}:alice`),
          900
        );
        expect(mockRedis.del).not.toHaveBeenCalled();
        expect(logout).not.toHaveBeenCalled();

        vi.mocked(passwordLogin).mockClear();
        selects(siloServer);
        mockRedis.eval.mockResolvedValue(4);
        await expect(call('siloSignIn', signIn)).rejects.toMatchObject({ statusCode: 403 });
        expect(passwordLogin).not.toHaveBeenCalled();
      });

      it('refuses a server not open to sign-in before any Silo call', async () => {
        selects([]);
        await expect(call('siloSignIn', signIn)).rejects.toMatchObject({ statusCode: 403 });
        expect(passwordLogin).not.toHaveBeenCalled();
        expect(mockRedis.eval).not.toHaveBeenCalled();
      });

      it('logs out once when the gates refuse, with no token left to discard', async () => {
        selects(siloServer, [{ userId: 'member-1' }]);
        vi.mocked(canMemberLogin).mockResolvedValue({ ok: false, reason: 'refused' });
        vi.mocked(passwordLogin).mockResolvedValue(login);

        await expect(call('siloSignIn', signIn)).rejects.toMatchObject({ statusCode: 403 });
        expect(logout).toHaveBeenCalledExactlyOnceWith(SILO_URL, 'silo-token');
        expect(db.insert).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    describe('code', () => {
      it('answers 404 when pairing is off, without starting a request', async () => {
        selects(siloServer);
        vi.mocked(pairingOffered).mockResolvedValue(false);

        await expect(call('siloCodeInitiate', { serverId: SERVER_ID })).rejects.toMatchObject({
          statusCode: 404,
          body: { message: 'Code sign-in is off on this server.' },
        });
        expect(startPairing).not.toHaveBeenCalled();
      });

      it('returns the handle, code, public link and interval, and keeps the device code in Redis', async () => {
        selects([{ id: SERVER_ID, url: SILO_URL, publicUrl: 'https://silo.example.com' }]);
        vi.mocked(startPairing).mockResolvedValue({
          deviceCode: 'device-code',
          userCode: '12345678',
          verificationUriComplete: `${SILO_URL}/activate?code=12345678`,
          expiresIn: 900,
          interval: 3,
        });

        const { response } = await call('siloCodeInitiate', { serverId: SERVER_ID });

        expect(Object.keys(response).sort()).toEqual(['code', 'handle', 'interval', 'link']);
        expect(response).toMatchObject({
          code: '12345678',
          link: 'https://silo.example.com/activate?code=12345678',
          interval: 3,
        });
        expect(JSON.stringify(response)).not.toContain('device-code');
        const [key, value] = mockRedis.set.mock.calls[0] ?? [];
        expect(key).toContain(String(response.handle));
        expect(JSON.parse(String(value))).toMatchObject({
          purpose: 'sign-in',
          serverId: SERVER_ID,
          url: SILO_URL,
          deviceCode: 'device-code',
        });
      });

      it('answers a missing handle as expired without any call', async () => {
        const { response } = await call('siloCodeCheck', { handle: HANDLE });
        expect(response).toEqual({ authorized: false, expired: true });
        expect(db.select).not.toHaveBeenCalled();
        expect(pollPairing).not.toHaveBeenCalled();
      });

      it.each([
        { purpose: 'add-server', ownerId: 'owner-1', name: 'Silo' },
        { purpose: 'rekey', ownerId: 'owner-1', serverId: SERVER_ID },
        { purpose: 'link', ownerId: 'owner-1', serverId: SERVER_ID },
      ])('never finishes an owner $purpose request', async (owner) => {
        stored({ ...signInState, ...owner });

        const { response } = await call('siloCodeCheck', { handle: HANDLE });

        expect(response).toEqual({ authorized: false, expired: true });
        expect(db.select).not.toHaveBeenCalled();
        expect(pollPairing).not.toHaveBeenCalled();
        expect(mockRedis.del).not.toHaveBeenCalled();
      });

      it('waits while pending and answers expired once Silo drops the code', async () => {
        stored(signInState);
        selects(siloServer);
        vi.mocked(pollPairing).mockResolvedValue({
          status: 'pending',
          opened: false,
          expiresAt: null,
        });
        expect((await call('siloCodeCheck', { handle: HANDLE })).response).toEqual({
          authorized: false,
        });
        expect(pollPairing).toHaveBeenCalledWith(SILO_URL, 'device-code', 'binding-secret');

        selects(siloServer);
        vi.mocked(pollPairing).mockResolvedValue({ status: 'gone' });
        expect((await call('siloCodeCheck', { handle: HANDLE })).response).toEqual({
          authorized: false,
          expired: true,
        });
        expect(mockRedis.eval).toHaveBeenCalledWith(
          expect.stringContaining("redis.call('DEL'"),
          1,
          expect.stringContaining(HANDLE)
        );
        expect(logout).not.toHaveBeenCalled();
      });

      it('deletes the state and logs out before signing the approver in', async () => {
        stored(signInState);
        selects(siloServer, [{ userId: 'member-1' }], []);
        vi.mocked(pollPairing).mockResolvedValue({ status: 'approved', login });

        const { response, headers, context } = await call('siloCodeCheck', { handle: HANDLE });

        expect(response).toMatchObject({ authorized: true, user: { id: 'member-1' } });
        expect(headers.get('set-cookie')).toContain('better-auth.session_token');
        expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining(HANDLE));
        expect(logout).toHaveBeenCalledExactlyOnceWith(SILO_URL, 'silo-token');
        expect(order(vi.mocked(logout))).toBeLessThan(order(context.internalAdapter.createSession));
        expect(storedAccount()).toMatchObject({
          providerId: 'silo',
          accountId: `${SERVER_ID}:34`,
          accessToken: null,
          scope: null,
        });
      });

      it('logs out once and stores nothing when the gates refuse the approver', async () => {
        stored(signInState);
        selects(siloServer, [{ userId: 'member-1' }]);
        vi.mocked(canMemberLogin).mockResolvedValue({ ok: false, reason: 'refused' });
        vi.mocked(pollPairing).mockResolvedValue({ status: 'approved', login });

        await expect(call('siloCodeCheck', { handle: HANDLE })).rejects.toMatchObject({
          statusCode: 403,
          body: { message: MEMBER_LOGIN_REFUSED },
        });
        expect(logout).toHaveBeenCalledExactlyOnceWith(SILO_URL, 'silo-token');
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('cancels the code and drops the state when the server closed before the check', async () => {
        stored(signInState);
        mockRedis.eval.mockImplementation(async (script: string) =>
          script === 'get-and-delete' ? JSON.stringify(signInState) : 1
        );
        selects([]);

        await expect(call('siloCodeCheck', { handle: HANDLE })).rejects.toMatchObject({
          statusCode: 403,
        });
        expect(pollPairing).not.toHaveBeenCalled();
        expect(cancelPairing).toHaveBeenCalledExactlyOnceWith(SILO_URL, 'device-code');
        expect(mockRedis.eval).toHaveBeenCalledWith(
          'get-and-delete',
          1,
          expect.stringContaining(HANDLE)
        );
        expect(logout).not.toHaveBeenCalled();
      });
    });
  });
});

describe('memberStillValid', () => {
  const jellyfinAccount = {
    providerId: 'jellyfin',
    accountId: `${SERVER_ID}:ext-1`,
    token: 'member-token',
    password: null,
  };
  const defaultMember = [{ role: 'member', loginAccess: 'default' }];
  const openServer = [{ url: URL, serverAllowsMembers: true }];

  beforeEach(() => {
    fetchMock.mockReset();
    vi.mocked(db.select).mockReset();
    memberSwitch(true);
    usable({});
  });

  function memberSwitch(member: boolean) {
    vi.mocked(getSetting).mockResolvedValue({
      local: true,
      plex: true,
      oidc: true,
      member,
    } as never);
  }

  function usable(methods: Partial<Record<'local' | 'oidc', boolean>>) {
    vi.mocked(usableLoginMethods).mockResolvedValue({
      local: false,
      plex: false,
      oidc: false,
      tofa: false,
      member: true,
      ...methods,
    });
  }

  function revalidate(self: () => Response | Promise<Response>) {
    selects(defaultMember, [jellyfinAccount], openServer);
    server({ '/Users/Me': self });
    return memberStillValid('member-1');
  }

  it('ends the session on a rejected token, another user, or a disabled one', async () => {
    await expect(revalidate(() => new Response(null, { status: 401 }))).resolves.toBe(false);
    await expect(revalidate(() => Response.json({ Id: 'ext-2' }))).resolves.toBe(false);
    await expect(
      revalidate(() => Response.json({ Id: 'ext-1', Policy: { IsDisabled: true } }))
    ).resolves.toBe(false);
    await expect(revalidate(() => Response.json({ Id: 'ext-1', Policy: {} }))).resolves.toBe(true);
  });

  it('keeps the session when the server cannot be reached', async () => {
    await expect(revalidate(() => Promise.reject(new TypeError('fetch failed')))).resolves.toBe(
      true
    );
  });

  it('ends the session for a Plex member whose server account was removed', async () => {
    selects(defaultMember, [{ providerId: 'plex', accountId: 'plex-1', token: 't' }], []);
    await expect(memberStillValid('member-1')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a tofa member with no live account', async () => {
    const tofa = { providerId: 'tofa', accountId: 'identity-1', token: null, password: null };
    selects(defaultMember, [tofa], [{ serverAllowsMembers: true }]);
    await expect(memberStillValid('member-1')).resolves.toBe(true);

    selects(defaultMember, [tofa], []);
    await expect(memberStillValid('member-1')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('a Silo member', () => {
    const silo = {
      providerId: 'silo',
      accountId: `${SERVER_ID}:34`,
      token: null,
      password: null,
    };

    it('stays signed in through a live synced account without asking Silo', async () => {
      selects(defaultMember, [silo], [{ serverAllowsMembers: true }]);
      await expect(memberStillValid('member-1')).resolves.toBe(true);

      const match = vi.mocked(db.select).mock.results[2]?.value as {
        where: ReturnType<typeof vi.fn>;
      };
      const { params } = new PgDialect().sqlToQuery(match.where.mock.calls[0]?.[0] as SQL);
      expect(params).toEqual(expect.arrayContaining(['silo', SERVER_ID, '34']));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(passwordLogin).not.toHaveBeenCalled();
    });

    it('is signed out once the account is gone or the server stops allowing members', async () => {
      selects(defaultMember, [silo], []);
      await expect(memberStillValid('member-1')).resolves.toBe(false);

      selects(defaultMember, [silo], [{ serverAllowsMembers: false }]);
      await expect(memberStillValid('member-1')).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is not a way in with a malformed account id', async () => {
      selects(defaultMember, [{ ...silo, accountId: SERVER_ID }]);
      await expect(memberStillValid('member-1')).resolves.toBe(false);
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  it('never asks a closed server about a stale token, and another open server keeps the session', async () => {
    const closed = { ...jellyfinAccount, accountId: 'closed-server:ext-9', token: 'stale' };
    selects(
      defaultMember,
      [closed, jellyfinAccount],
      [{ url: 'http://closed.local:8096', serverAllowsMembers: false }],
      openServer
    );
    server({ '/Users/Me': () => Response.json({ Id: 'ext-1', Policy: {} }) });

    await expect(memberStillValid('member-1')).resolves.toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => new globalThis.URL(url).host)).toEqual([
      'jellyfin.local:8096',
    ]);
  });

  it('ends a default session once its only server switches member sign-in off', async () => {
    selects(defaultMember, [jellyfinAccount], [{ url: URL, serverAllowsMembers: false }]);
    await expect(memberStillValid('member-1')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps an allowed session on a server whose member switch is off', async () => {
    selects(
      [{ role: 'member', loginAccess: 'allow' }],
      [jellyfinAccount],
      [{ url: URL, serverAllowsMembers: false }]
    );
    server({ '/Users/Me': () => Response.json({ Id: 'ext-1', Policy: {} }) });
    await expect(memberStillValid('member-1')).resolves.toBe(true);
  });

  it.each([
    { loginAccess: 'default', member: false },
    { loginAccess: 'block', member: true },
  ])('ends $loginAccess with the switch $member before asking any server', async (row) => {
    memberSwitch(row.member);
    selects([{ role: 'member', loginAccess: row.loginAccess }], [jellyfinAccount], openServer);
    await expect(memberStillValid('member-1')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('single sign-on only', () => {
    beforeEach(() => {
      vi.mocked(getSetting).mockImplementation(async (key) =>
        key === 'memberSsoOnly'
          ? (true as never)
          : ({ local: true, plex: true, oidc: true, member: true } as never)
      );
    });

    it('ends a session held only through a media server without asking it', async () => {
      selects(defaultMember, [jellyfinAccount]);
      await expect(memberStillValid('member-1')).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps a session the OIDC gate still passes', async () => {
      usable({ oidc: true });
      vi.mocked(canMemberLogin).mockResolvedValue({ ok: true });
      const oidc = { providerId: 'oidc', accountId: 'sub-1', token: null, password: null };
      selects(defaultMember, [oidc, jellyfinAccount], defaultMember, [{ serverId: SERVER_ID }]);
      await expect(memberStillValid('member-1')).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('never ends the owner session', async () => {
    memberSwitch(false);
    selects([{ role: 'owner', loginAccess: 'block' }]);
    await expect(memberStillValid('owner-1')).resolves.toBe(true);
  });

  describe('an admin password', () => {
    const defaultAdmin = [{ role: 'admin', loginAccess: 'default' }];
    const credential = { providerId: 'credential', accountId: 'a', token: null, password: 'h' };
    const closedServer = [{ url: URL, serverAllowsMembers: false }];

    it('keeps the session while local sign-in is on, whatever the media servers say', async () => {
      usable({ local: true });
      selects(defaultAdmin, [credential, jellyfinAccount]);
      await expect(memberStillValid('admin-1')).resolves.toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stops counting once local sign-in is off', async () => {
      usable({ local: false });
      selects(defaultAdmin, [credential, jellyfinAccount], closedServer);
      await expect(memberStillValid('admin-1')).resolves.toBe(false);
    });

    it('never counts for a member holding a leftover credential row', async () => {
      usable({ local: true });
      selects(defaultMember, [credential]);
      await expect(memberStillValid('member-1')).resolves.toBe(false);
    });
  });

  describe('an OIDC link', () => {
    const oidc = { providerId: 'oidc', accountId: 'sub-1', token: null, password: null };

    it('ends a default member whose servers all switched off member sign-in', async () => {
      usable({ oidc: true });
      vi.mocked(canMemberLogin).mockResolvedValue({ ok: false, reason: 'not-permitted' });
      selects(defaultMember, [oidc], defaultMember, [{ serverId: SERVER_ID }]);
      await expect(memberStillValid('member-1')).resolves.toBe(false);
    });

    it('keeps the session while the OIDC gate still passes', async () => {
      usable({ oidc: true });
      vi.mocked(canMemberLogin).mockResolvedValue({ ok: true });
      selects(defaultMember, [oidc], defaultMember, [{ serverId: SERVER_ID }]);
      await expect(memberStillValid('member-1')).resolves.toBe(true);
    });

    it('stops counting once SSO is switched off', async () => {
      usable({ oidc: false });
      vi.mocked(canMemberLogin).mockResolvedValue({ ok: true });
      selects(defaultMember, [oidc]);
      await expect(memberStillValid('member-1')).resolves.toBe(false);
      expect(canMemberLogin).not.toHaveBeenCalled();
    });
  });
});

describe('linkOidcMember', () => {
  const profile = { sub: 'idp-sub-1', email: 'Alice@Example.com', preferred_username: 'alice' };

  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert)
      .mockReset()
      .mockReturnValue(makeChain() as never);
    vi.mocked(getOwnerUser).mockResolvedValue({
      id: 'owner-1',
      email: 'boss@example.com',
    } as never);
    vi.mocked(canMemberLogin).mockResolvedValue({ ok: true });
    vi.mocked(getSetting).mockResolvedValue({
      local: true,
      plex: true,
      oidc: true,
      member: true,
    } as never);
  });

  const allowedMember = [{ role: 'member', loginAccess: 'default' }];

  it('links the oidc account to the one identity the email names, once the gates pass', async () => {
    selects([], [{ userId: 'member-1', serverId: SERVER_ID }], [], allowedMember, [
      { serverId: SERVER_ID },
    ]);
    await expect(linkOidcMember(profile)).resolves.toBe('keep');
    const insert = vi.mocked(db.insert).mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'oidc', accountId: 'idp-sub-1', userId: 'member-1' })
    );
  });

  it('links nobody when the email names two identities', async () => {
    selects([], [{ userId: 'member-1', serverId: SERVER_ID }], [{ userId: 'member-2' }]);
    await expect(linkOidcMember(profile)).resolves.toBe('hide');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('links nobody when the matched identity has no account the gates allow', async () => {
    selects([], [], [], [{ userId: 'owner-1', serverId: SERVER_ID }], []);
    await expect(linkOidcMember(profile)).resolves.toBe('hide');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('tells a matched identity the gates keep out that it is not permitted, and links nothing', async () => {
    vi.mocked(canMemberLogin).mockResolvedValue({ ok: false, reason: 'not-permitted' });
    selects([], [{ userId: 'member-1', serverId: SERVER_ID }], [], allowedMember, [
      { serverId: SERVER_ID },
    ]);
    await expect(linkOidcMember(profile)).resolves.toBe('not-permitted');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('tells a blocked identity it is not permitted before looking at its accounts', async () => {
    selects(
      [],
      [{ userId: 'member-1', serverId: SERVER_ID }],
      [],
      [{ role: 'member', loginAccess: 'block' }]
    );
    await expect(linkOidcMember(profile)).resolves.toBe('not-permitted');
    expect(canMemberLogin).not.toHaveBeenCalled();
  });

  it("leaves the owner's own address for better-auth to link", async () => {
    selects([], [], [{ userId: 'owner-1' }], []);
    await expect(linkOidcMember({ sub: 'idp-sub-2', email: 'Boss@Example.com' })).resolves.toBe(
      'keep'
    );
  });
});
