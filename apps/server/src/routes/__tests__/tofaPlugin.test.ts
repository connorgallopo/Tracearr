/**
 * tofa Better Auth plugin tests
 *
 * The endpoint handlers run directly with a mocked Better Auth context, as in plexPlugin.test.ts.
 * tofa cloud, the tofa server client, server creation and the db are mocked; Redis is a small
 * in-memory store so a spent temp token and the connect lock behave as they do live.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../services/mediaServer/tofa/cloud.js', async (importOriginal) => ({
  TofaCloudTokenError: (
    await importOriginal<typeof import('../../services/mediaServer/tofa/cloud.js')>()
  ).TofaCloudTokenError,
  requestDeviceCode: vi.fn(),
  pollDeviceToken: vi.fn(),
  verifyCloudToken: vi.fn(),
  getCloudProfile: vi.fn(),
  listOwnedServers: vi.fn(),
  openServerSession: vi.fn(),
}));

const { mockServerIdentity, mockGetUsers } = vi.hoisted(() => ({
  mockServerIdentity: vi.fn(),
  mockGetUsers: vi.fn(),
}));

vi.mock('../../services/mediaServer/tofa/client.js', () => {
  class MockTofaClient {
    getServerIdentity = mockServerIdentity;
    getUsers = mockGetUsers;
  }
  return {
    TofaClient: Object.assign(MockTofaClient, {
      createApiKey: vi.fn(),
      deleteApiKey: vi.fn(),
      logoutSession: vi.fn(),
      probe: vi.fn(),
    }),
  };
});

vi.mock('../../services/mediaServer/byServerType.js', () => ({ readServerFacts: vi.fn() }));
vi.mock('../../services/serverCreate.js', () => ({
  createServer: vi.fn(),
  startAddedServer: vi.fn(),
}));
vi.mock('../../jobs/poller/database.js', () => ({ publishServersChanged: vi.fn() }));
vi.mock('../../services/sseManager.js', () => ({
  sseManager: { refresh: vi.fn(async () => undefined) },
}));
vi.mock('../../lib/revoke.js', () => ({ revokeOtherWebSessions: vi.fn() }));
vi.mock('../../services/mergeService.js', () => ({
  MEDIA_AUTH_PROVIDERS: ['plex', 'jellyfin', 'emby', 'tofa'],
  MergeValidationError: class MergeValidationError extends Error {},
  isLoginCapable: vi.fn(),
  mergeUsers: vi.fn(),
  splitServerUser: vi.fn(),
}));

const store = new Map<string, string>();
const mockRedis = {
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  setex: vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  // Every caller sets with NX
  set: vi.fn(async (key: string, value: string) => {
    if (store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  // The compare-and-delete that releases a lock only for its holder
  eval: vi.fn(async (_script: string, _keys: number, key: string, holder: string) => {
    if (store.get(key) !== holder) return 0;
    store.delete(key);
    return 1;
  }),
};

vi.mock('../../lib/redisShared.js', () => ({
  getRedis: () => mockRedis,
  closeRedis: vi.fn(),
}));

vi.mock('../../services/userService.js', () => ({ getOwnerUser: vi.fn() }));

vi.mock('../../lib/authGuards.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/authGuards.js')>()),
  usableLoginMethods: vi.fn(),
  canMemberLogin: vi.fn(),
  hasOpenServer: vi.fn(async () => false),
  mediaSignInClosed: vi.fn(async () => false),
}));

vi.mock('../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn(() => false),
  validateClaimCode: vi.fn(() => true),
}));

const mockSetSessionCookie = vi.fn(
  async (
    ctx: { setCookie: (k: string, v: string) => void },
    { session }: { session: { token: string } }
  ) => {
    ctx.setCookie('better-auth.session_token', session?.token ?? 'token');
  }
);

vi.mock('better-auth/cookies', () => ({
  setSessionCookie: (ctx: unknown, session: unknown) =>
    mockSetSessionCookie(ctx as never, session as never),
  expireCookie: vi.fn(),
}));

vi.mock('better-auth/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('better-auth/api')>()),
  getSessionFromCtx: vi.fn(),
}));

import { getSessionFromCtx } from 'better-auth/api';
import { db } from '../../db/client.js';
import { servers, users } from '../../db/schema.js';
import {
  getCloudProfile,
  listOwnedServers,
  openServerSession,
  pollDeviceToken,
  requestDeviceCode,
  TofaCloudTokenError,
  verifyCloudToken,
} from '../../services/mediaServer/tofa/cloud.js';
import { TofaClient } from '../../services/mediaServer/tofa/client.js';
import { readServerFacts } from '../../services/mediaServer/byServerType.js';
import { createServer, startAddedServer } from '../../services/serverCreate.js';
import { mergeUsers } from '../../services/mergeService.js';
import { getOwnerUser } from '../../services/userService.js';
import {
  canMemberLogin,
  hasOpenServer,
  mediaSignInClosed,
  MEMBER_LOGIN_REFUSED,
  usableLoginMethods,
} from '../../lib/authGuards.js';
import { isClaimCodeEnabled, validateClaimCode } from '../../utils/claimCode.js';
import { tofaPlugin } from '../../lib/tofaPlugin.js';
import { renderSql } from '../../test/helpers.js';

function makeChain(result: unknown = []) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'from',
    'innerJoin',
    'where',
    'limit',
    'orderBy',
    'values',
    'returning',
    'onConflictDoUpdate',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return chain as Record<string, ReturnType<typeof vi.fn>>;
}

function selects(...results: unknown[][]) {
  const chains = results.map((rows) => makeChain(rows));
  for (const chain of chains) vi.mocked(db.select).mockReturnValueOnce(chain as never);
  return chains;
}

function makeCtx() {
  const createSession = vi.fn(async (userId: string) => ({ id: 'sess-1', token: 'tok', userId }));
  const findUserById = vi.fn(async (userId: string) => ({
    id: userId,
    name: userId,
    username: userId,
    role: userId.startsWith('owner') ? 'owner' : 'member',
  }));
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    context: {
      internalAdapter: { createSession, findUserById },
      logger,
      createAuthCookie: (name: string) => ({ name: `better-auth.${name}`, attributes: {} }),
    },
    createSession,
  };
}

type Endpoints = ReturnType<typeof tofaPlugin>['endpoints'];

const BINDING = 'binding-1';
const HANDLE = 'handle-1';
const DEVICE_COOKIE = `better-auth.tofa_device=${BINDING}`;

async function call(
  name: keyof Endpoints,
  body: Record<string, unknown>,
  ctx = makeCtx(),
  cookie = DEVICE_COOKIE
) {
  const endpoint = tofaPlugin().endpoints[name] as (input: unknown) => Promise<unknown>;
  const result = (await endpoint({
    body,
    headers: new Headers({ cookie }),
    context: ctx.context,
    returnHeaders: true,
  })) as { headers: Headers; response: Record<string, unknown> };
  return { response: result.response, headers: result.headers, ctx };
}

function seedDevice(purpose: 'sign-in' | 'add-server' = 'sign-in') {
  store.set(
    REDIS_KEYS.TOFA_DEVICE(HANDLE),
    JSON.stringify({ deviceCode: 'device-1', binding: BINDING, purpose })
  );
}

const OWNER = { id: 'owner-1', role: 'owner' };
const IDENTITY = 'identity-owner';
const CLOUD_SERVER = {
  id: 'srv-cloud-1',
  name: 'Living room',
  online: true,
  localAddress: 'http://192.168.1.122:33333',
};
const TEMP = 'temp-1';

function seedSignIn(purpose: 'sign-in' | 'add-server' = 'sign-in') {
  store.set(
    REDIS_KEYS.TOFA_TEMP(TEMP),
    JSON.stringify({
      accessToken: 'cloud-token',
      identityId: IDENTITY,
      username: 'morgan',
      email: 'morgan@example.com',
      purpose,
    })
  );
}

function approve(identityId = IDENTITY) {
  vi.mocked(pollDeviceToken).mockResolvedValue({ status: 'approved', accessToken: 'cloud-token' });
  vi.mocked(verifyCloudToken).mockResolvedValue({
    identityId,
    expiresAt: new Date(Date.now() + 900_000),
  });
}

function insertedValues() {
  return vi
    .mocked(db.insert)
    .mock.results.map((r) => (r.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls)
    .flat()
    .map(([values]) => values as Record<string, unknown>);
}

function ownerSession() {
  vi.mocked(getSessionFromCtx).mockResolvedValue({
    session: { impersonatedBy: null },
    user: { id: 'owner-1', role: 'owner' },
  } as never);
}

describe('tofa better auth plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    store.clear();
    vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
    vi.mocked(db.insert).mockImplementation(() => makeChain([{ id: 'owner-new' }]) as never);
    vi.mocked(usableLoginMethods).mockResolvedValue({
      local: true,
      plex: false,
      oidc: false,
      tofa: true,
      member: true,
    });
    vi.mocked(canMemberLogin).mockResolvedValue({ ok: true });
    vi.mocked(getOwnerUser).mockResolvedValue(OWNER as never);
    vi.mocked(getSessionFromCtx).mockResolvedValue(null);
  });

  it('initiate keeps the device code server-side and binds the handle to this browser', async () => {
    vi.mocked(requestDeviceCode).mockResolvedValue({
      deviceCode: 'device-9',
      userCode: 'ABCD-EFGH',
      verificationUriComplete: 'https://app.tofa.tv/link?code=ABCD-EFGH',
      intervalSeconds: 5,
      expiresInSeconds: 600,
    });

    const { response, headers } = await call('tofaInitiate', { purpose: 'sign-in' });

    expect(response).toEqual({
      handle: expect.stringMatching(/^[0-9a-f]{64}$/),
      verificationUri: 'https://app.tofa.tv/link?code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      expiresIn: 600,
      interval: 5,
    });
    expect(JSON.stringify(response)).not.toContain('device-9');
    const [key, ttl, stored] = mockRedis.setex.mock.calls[0] ?? [];
    expect(key).toBe(REDIS_KEYS.TOFA_DEVICE(response.handle as string));
    expect(ttl).toBe(600);
    const state = JSON.parse(String(stored)) as { deviceCode: string; binding: string };
    expect(state.deviceCode).toBe('device-9');
    expect(headers.get('set-cookie')).toContain(`better-auth.tofa_device=${state.binding}`);
  });

  it('check answers expired without the binding cookie', async () => {
    seedDevice();

    const { response } = await call('tofaCheck', { handle: HANDLE }, makeCtx(), '');

    expect(response).toEqual({ status: 'expired' });
    expect(pollDeviceToken).not.toHaveBeenCalled();
  });

  it('check passes pending and slow down through', async () => {
    seedDevice();

    vi.mocked(pollDeviceToken).mockResolvedValueOnce({ status: 'pending' });
    expect((await call('tofaCheck', { handle: HANDLE })).response).toEqual({ status: 'pending' });
    vi.mocked(pollDeviceToken).mockResolvedValueOnce({ status: 'slow_down' });
    expect((await call('tofaCheck', { handle: HANDLE })).response).toEqual({
      status: 'slow_down',
    });
    expect(store.has(REDIS_KEYS.TOFA_DEVICE(HANDLE))).toBe(true);
  });

  it('signs in the owner whose tofa identity is linked', async () => {
    seedDevice();
    approve();
    selects([{ userId: 'owner-1' }]);

    const { response, ctx } = await call('tofaCheck', { handle: HANDLE });

    expect(response).toEqual({
      status: 'signed-in',
      user: { id: 'owner-1', username: 'owner-1', role: 'owner' },
    });
    expect(ctx.createSession).toHaveBeenCalledWith('owner-1');
    expect(store.has(REDIS_KEYS.TOFA_DEVICE(HANDLE))).toBe(false);
  });

  it("signs in the owner only while they hold a live tofa account with the sign-in's identity", async () => {
    seedDevice();
    approve();
    const [linked] = selects([], []);

    await expect(call('tofaCheck', { handle: HANDLE })).rejects.toMatchObject({ statusCode: 403 });
    const where = renderSql(linked?.where?.mock.calls[0]?.[0] as SQL);
    expect(where.sql).toContain('server_users.removed_at is null');
    expect(where.sql).toContain('servers.historical_at is null');
    expect(linked?.innerJoin).toHaveBeenCalledTimes(2);
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it.each([null, 'https://api.tofa.tv/avatars/old.jpg', '/api/v1/profiles/avatars/cat.png'])(
    'owner tofa sign-in refreshes the picture from the synced account over %s',
    async (ownerThumbnail) => {
      seedDevice();
      approve();
      selects(
        [{ userId: 'owner-1' }],
        [{ thumbUrl: '/api/v1/profiles/avatars/robot.png', ownerThumbnail }]
      );
      const set = vi.fn(() => ({ where: vi.fn() }));
      vi.mocked(db.update).mockReturnValue({ set } as never);

      await call('tofaCheck', { handle: HANDLE });

      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnail: '/api/v1/profiles/avatars/robot.png' })
      );
    }
  );

  it('owner tofa sign-in keeps a picture that came from another sign-in', async () => {
    seedDevice();
    approve();
    selects(
      [{ userId: 'owner-1' }],
      [
        {
          thumbUrl: '/api/v1/profiles/avatars/robot.png',
          ownerThumbnail: 'https://plex.tv/users/abc/avatar?c=1',
        },
      ]
    );
    const set = vi.fn(() => ({ where: vi.fn() }));
    vi.mocked(db.update).mockReturnValue({ set } as never);

    const { response } = await call('tofaCheck', { handle: HANDLE });

    expect(response).toMatchObject({ status: 'signed-in' });
    expect(set).not.toHaveBeenCalled();
  });

  it('a token tofa did not sign answers expired', async () => {
    seedDevice();
    vi.mocked(pollDeviceToken).mockResolvedValue({ status: 'approved', accessToken: 'forged' });
    vi.mocked(verifyCloudToken).mockRejectedValueOnce(new TofaCloudTokenError('bad signature'));

    expect((await call('tofaCheck', { handle: HANDLE })).response).toEqual({ status: 'expired' });
    expect(db.select).not.toHaveBeenCalled();
    expect(mockSetSessionCookie).not.toHaveBeenCalled();

    seedDevice();
    vi.mocked(verifyCloudToken).mockRejectedValueOnce(new Error('tofa request failed: 503'));
    await expect(call('tofaCheck', { handle: HANDLE })).rejects.toMatchObject({ statusCode: 500 });
  });

  it('refuses the owner when tofa sign-in is off and another way in exists', async () => {
    vi.mocked(usableLoginMethods).mockResolvedValue({
      local: true,
      plex: false,
      oidc: false,
      tofa: false,
      member: true,
    });
    vi.mocked(hasOpenServer).mockResolvedValue(true);
    seedDevice();
    approve();
    selects([{ userId: 'owner-1' }]);

    await expect(call('tofaCheck', { handle: HANDLE })).rejects.toMatchObject({
      statusCode: 403,
      body: { message: MEMBER_LOGIN_REFUSED },
    });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  describe('member path', () => {
    beforeEach(() => {
      seedDevice();
      approve('identity-member');
    });

    it('signs in a member through a live tofa account with the same cloud identity', async () => {
      selects([], [{ userId: 'member-1', serverId: 'srv-1' }]);

      const { response, ctx } = await call('tofaCheck', { handle: HANDLE });

      expect(response).toEqual({
        status: 'signed-in',
        user: { id: 'member-1', username: 'member-1', role: 'member' },
      });
      expect(canMemberLogin).toHaveBeenCalledWith('member-1', 'srv-1');
      expect(ctx.createSession).toHaveBeenCalledWith('member-1');
      expect(insertedValues()).toEqual([
        expect.objectContaining({
          providerId: 'tofa',
          accountId: 'identity-member',
          userId: 'member-1',
        }),
      ]);
    });

    it('never signs in the owner through the member path', async () => {
      const [, members] = selects([], []);

      await expect(call('tofaCheck', { handle: HANDLE })).rejects.toMatchObject({
        statusCode: 403,
      });
      const where = renderSql(members?.where?.mock.calls[0]?.[0] as SQL);
      expect(where.sql).toContain('users.role <> $');
      expect(where.params).toContain('owner');
      expect(mockSetSessionCookie).not.toHaveBeenCalled();
    });

    it('refuses a member whose cloud access is revoked', async () => {
      // The sync clears the cloud identity of a revoked account, so no account carries it.
      const [, members] = selects([], []);

      await expect(call('tofaCheck', { handle: HANDLE })).rejects.toMatchObject({
        statusCode: 403,
        body: { message: MEMBER_LOGIN_REFUSED },
      });
      const where = renderSql(members?.where?.mock.calls[0]?.[0] as SQL);
      expect(where.sql).toContain('server_users.cloud_identity_id = $');
      expect(where.params).toContain('identity-member');
      expect(db.insert).not.toHaveBeenCalled();
      expect(mockSetSessionCookie).not.toHaveBeenCalled();
    });

    it('refuses members while SSO-only is on', async () => {
      vi.mocked(mediaSignInClosed).mockResolvedValueOnce(true);
      selects([], [{ userId: 'member-1', serverId: 'srv-1' }]);

      await expect(call('tofaCheck', { handle: HANDLE })).rejects.toMatchObject({
        statusCode: 403,
        body: { message: MEMBER_LOGIN_REFUSED },
      });
      expect(canMemberLogin).not.toHaveBeenCalled();
      expect(mockSetSessionCookie).not.toHaveBeenCalled();
    });
  });

  describe('first run', () => {
    beforeEach(() => {
      vi.mocked(getOwnerUser).mockResolvedValue(null);
      seedDevice();
    });

    it('first run checks the claim code before calling tofa', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(false);

      await expect(
        call('tofaCheck', { handle: HANDLE, claimCode: 'WRONG-CODE' })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(pollDeviceToken).not.toHaveBeenCalled();
      expect(getCloudProfile).not.toHaveBeenCalled();
    });

    it('first run with no owned servers creates no account', async () => {
      approve();
      vi.mocked(getCloudProfile).mockResolvedValue({
        identityId: IDENTITY,
        username: 'morgan',
        email: null,
      });
      vi.mocked(listOwnedServers).mockResolvedValue([]);

      const { response } = await call('tofaCheck', { handle: HANDLE });

      expect(response).toEqual({ status: 'no-servers', username: 'morgan' });
      expect(db.insert).not.toHaveBeenCalled();
      expect(mockSetSessionCookie).not.toHaveBeenCalled();
      expect([...store.keys()].some((key) => key.includes('tofa_temp'))).toBe(false);
    });

    it("first run lists the account's servers and keeps its cloud token for the token's lifetime", async () => {
      approve();
      vi.mocked(getCloudProfile).mockResolvedValue({
        identityId: IDENTITY,
        username: 'morgan',
        email: null,
      });
      vi.mocked(listOwnedServers).mockResolvedValue([CLOUD_SERVER]);
      selects([]);

      const { response } = await call('tofaCheck', { handle: HANDLE });

      expect(response).toEqual({
        status: 'select-server',
        tempToken: expect.stringMatching(/^[0-9a-f]{64}$/),
        username: 'morgan',
        servers: [CLOUD_SERVER],
      });
      expect(JSON.stringify(response)).not.toContain('cloud-token');
      const [key, ttl] = mockRedis.setex.mock.calls[0] ?? [];
      expect(key).toBe(REDIS_KEYS.TOFA_TEMP(response.tempToken as string));
      expect(ttl).toBeGreaterThan(890);
      expect(ttl).toBeLessThanOrEqual(900);
    });
  });

  describe('connect', () => {
    const facts = { canStopStreams: true, watchedRulePercent: 90 };

    beforeEach(() => {
      vi.mocked(getOwnerUser).mockResolvedValue(null);
      seedSignIn();
      vi.mocked(db.select).mockImplementation(() => makeChain([]) as never);
      vi.mocked(db.delete).mockImplementation(() => makeChain() as never);
      vi.mocked(listOwnedServers).mockResolvedValue([CLOUD_SERVER]);
      vi.mocked(TofaClient.probe).mockResolvedValue(true);
      vi.mocked(openServerSession).mockResolvedValue('session-token');
      vi.mocked(TofaClient.createApiKey).mockResolvedValue({ id: 'key-1', secret: 'tofa_secret' });
      vi.mocked(TofaClient.deleteApiKey).mockResolvedValue(undefined);
      vi.mocked(TofaClient.logoutSession).mockResolvedValue(true);
      mockServerIdentity.mockResolvedValue(CLOUD_SERVER.id);
      mockGetUsers.mockResolvedValue([
        {
          id: 'local-owner',
          username: 'morgan',
          email: 'morgan@example.com',
          isAdmin: true,
          cloudIdentityId: IDENTITY,
          thumb: '/api/v1/profiles/avatars/astronaut.png',
        },
      ]);
      vi.mocked(readServerFacts).mockResolvedValue(facts);
      vi.mocked(createServer).mockResolvedValue({
        server: { id: 'server-new', name: CLOUD_SERVER.name, type: 'tofa', canStopStreams: true },
        requestServiceIds: ['service-new'],
      } as never);
    });

    const connect = (body: Record<string, unknown> = {}) =>
      call('tofaConnect', { tempToken: TEMP, serverId: CLOUD_SERVER.id, ...body });

    it('connect refuses a server the account does not own', async () => {
      vi.mocked(listOwnedServers).mockResolvedValue([{ ...CLOUD_SERVER, id: 'srv-other' }]);

      await expect(connect()).rejects.toMatchObject({ statusCode: 403 });
      expect(TofaClient.probe).not.toHaveBeenCalled();
      expect(TofaClient.createApiKey).not.toHaveBeenCalled();
    });

    it('connect reports an unreachable address and creates no key', async () => {
      vi.mocked(TofaClient.probe).mockResolvedValue(false);

      const { response } = await connect();

      expect(response).toEqual({ status: 'unreachable', address: CLOUD_SERVER.localAddress });
      expect(openServerSession).not.toHaveBeenCalled();
      expect(TofaClient.createApiKey).not.toHaveBeenCalled();
      expect(store.has(REDIS_KEYS.TOFA_TEMP(TEMP))).toBe(true);
    });

    it('refuses and deletes the key when the address answers as another server', async () => {
      mockServerIdentity.mockResolvedValue('srv-somewhere-else');

      await expect(connect({ url: 'http://10.0.0.9:33333' })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(TofaClient.createApiKey).toHaveBeenCalledWith(
        'http://10.0.0.9:33333',
        'session-token'
      );
      expect(TofaClient.deleteApiKey).toHaveBeenCalledWith(
        'http://10.0.0.9:33333',
        'session-token',
        'key-1'
      );
      expect(db.insert).not.toHaveBeenCalled();
      expect(createServer).not.toHaveBeenCalled();
    });

    it('first run refuses a server with no account for the tofa sign-in and deletes the key', async () => {
      mockGetUsers.mockResolvedValue([
        { id: 'local-other', username: 'sam', isAdmin: true, cloudIdentityId: 'identity-other' },
      ]);

      await expect(connect()).rejects.toMatchObject({
        statusCode: 400,
        body: { message: expect.stringContaining('username and password') },
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(createServer).not.toHaveBeenCalled();
      expect(TofaClient.deleteApiKey).toHaveBeenCalledWith(
        CLOUD_SERVER.localAddress,
        'session-token',
        'key-1'
      );
    });

    it('connect deletes the key when a later step fails', async () => {
      vi.mocked(createServer).mockRejectedValue(
        Object.assign(new Error('insert failed'), { params: ['tofa_secret'] })
      );
      const ctx = makeCtx();

      await expect(
        call('tofaConnect', { tempToken: TEMP, serverId: CLOUD_SERVER.id }, ctx)
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(TofaClient.deleteApiKey).toHaveBeenCalledWith(
        CLOUD_SERVER.localAddress,
        'session-token',
        'key-1'
      );
      expect(vi.mocked(TofaClient.deleteApiKey).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(TofaClient.logoutSession).mock.invocationCallOrder[0] ?? 0
      );
      expect(JSON.stringify(ctx.context.logger.error.mock.calls)).not.toContain('tofa_secret');
      expect(store.has(REDIS_KEYS.TOFA_TEMP(TEMP))).toBe(true);
    });

    it('connect creates the owner with their tofa picture, links the identity, adds the server and its owner account', async () => {
      const { response, ctx } = await connect();

      expect(response).toEqual({
        status: 'signed-in',
        user: { id: 'owner-new', username: 'owner-new', role: 'owner' },
      });
      expect(insertedValues()).toEqual([
        {
          username: 'morgan',
          email: 'morgan@example.com',
          thumbnail: '/api/v1/profiles/avatars/astronaut.png',
          role: 'owner',
        },
        expect.objectContaining({ providerId: 'tofa', accountId: IDENTITY, userId: 'owner-new' }),
      ]);
      expect(createServer).toHaveBeenCalledWith({
        name: CLOUD_SERVER.name,
        type: 'tofa',
        url: CLOUD_SERVER.localAddress,
        token: 'tofa_secret',
        machineIdentifier: CLOUD_SERVER.id,
        facts,
        ownerServerUser: {
          userId: 'owner-new',
          externalId: 'local-owner',
          username: 'morgan',
          email: 'morgan@example.com',
          thumbUrl: '/api/v1/profiles/avatars/astronaut.png',
          cloudIdentityId: IDENTITY,
        },
      });
      expect(startAddedServer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: 'server-new', type: 'tofa' }),
        ['service-new']
      );
      expect(vi.mocked(db.insert).mock.invocationCallOrder.at(-1)).toBeLessThan(
        vi.mocked(startAddedServer).mock.invocationCallOrder[0] ?? 0
      );
      expect(TofaClient.deleteApiKey).not.toHaveBeenCalled();
      expect(TofaClient.logoutSession).toHaveBeenCalledWith(
        CLOUD_SERVER.localAddress,
        'session-token'
      );
      expect(ctx.createSession).toHaveBeenCalledWith('owner-new');
      expect(store.has(REDIS_KEYS.TOFA_TEMP(TEMP))).toBe(false);
    });

    it('refuses a tofa server that is already connected and creates no key', async () => {
      const [existing] = selects([{ id: 'server-old' }]);

      await expect(connect()).rejects.toMatchObject({ statusCode: 409 });
      const where = renderSql(existing?.where?.mock.calls[0]?.[0] as SQL);
      expect(where.params).toEqual(
        expect.arrayContaining([CLOUD_SERVER.id, CLOUD_SERVER.localAddress])
      );
      expect(existing?.from).toHaveBeenCalledWith(servers);
      expect(openServerSession).not.toHaveBeenCalled();
      expect(TofaClient.createApiKey).not.toHaveBeenCalled();
    });

    it('connect checks the claim code before calling tofa', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(false);

      await expect(connect({ claimCode: 'WRONG-CODE' })).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(listOwnedServers).not.toHaveBeenCalled();
      expect(TofaClient.probe).not.toHaveBeenCalled();
    });

    it('a connect that fails after the server row exists removes it with the owner and the key', async () => {
      const failingWrite = makeChain();
      failingWrite.then = vi.fn((_resolve: unknown, reject: (error: Error) => unknown) =>
        reject(new Error('insert failed'))
      );
      vi.mocked(db.insert)
        .mockImplementationOnce(() => makeChain([{ id: 'owner-new' }]) as never)
        .mockImplementationOnce(() => failingWrite as never);

      await expect(connect()).rejects.toMatchObject({ statusCode: 500 });
      expect(vi.mocked(db.delete).mock.calls.map(([table]) => table)).toEqual([servers, users]);
      const removedServer = vi.mocked(db.delete).mock.results[0]?.value as {
        where: ReturnType<typeof vi.fn>;
      };
      expect(renderSql(removedServer.where.mock.calls[0]?.[0] as SQL).params).toEqual([
        'server-new',
      ]);
      expect(TofaClient.deleteApiKey).toHaveBeenCalled();
      expect(startAddedServer).not.toHaveBeenCalled();
    });

    it('a failed first-run connect leaves no owner behind', async () => {
      vi.mocked(createServer).mockRejectedValue(new Error('insert failed'));

      await expect(connect()).rejects.toMatchObject({ statusCode: 500 });
      expect(db.delete).toHaveBeenCalledWith(users);
      const removed = vi.mocked(db.delete).mock.results[0]?.value as {
        where: ReturnType<typeof vi.fn>;
      };
      expect(renderSql(removed.where.mock.calls[0]?.[0] as SQL).params).toEqual(['owner-new']);
      expect(TofaClient.deleteApiKey).toHaveBeenCalled();
    });

    it('connect with an expired temp token creates nothing', async () => {
      store.clear();

      const { response } = await connect();

      expect(response).toEqual({ status: 'expired' });
      expect(listOwnedServers).not.toHaveBeenCalled();
      expect(TofaClient.createApiKey).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('a second connect with the same temp token after success is refused', async () => {
      const [first, second] = await Promise.allSettled([connect(), connect()]);
      expect([first.status, second.status].toSorted()).toEqual(['fulfilled', 'rejected']);
      const rejected = [first, second].find((r) => r.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ statusCode: 409 });

      expect((await connect()).response).toEqual({ status: 'expired' });
      expect(TofaClient.createApiKey).toHaveBeenCalledOnce();
      expect(createServer).toHaveBeenCalledOnce();
    });

    it("add-server requires the owner's session", async () => {
      seedSignIn('add-server');

      await expect(
        call('tofaAddServer', { tempToken: TEMP, serverId: CLOUD_SERVER.id })
      ).rejects.toMatchObject({ statusCode: 403 });

      vi.mocked(getSessionFromCtx).mockResolvedValue({
        session: { impersonatedBy: null },
        user: { id: 'member-1', role: 'member' },
      } as never);
      await expect(
        call('tofaAddServer', { tempToken: TEMP, serverId: CLOUD_SERVER.id })
      ).rejects.toMatchObject({ statusCode: 403 });

      await expect(call('tofaInitiate', { purpose: 'add-server' })).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(requestDeviceCode).not.toHaveBeenCalled();
      expect(TofaClient.createApiKey).not.toHaveBeenCalled();
    });

    it("add-server links the owner's tofa identity", async () => {
      store.clear();
      ownerSession();
      vi.mocked(getOwnerUser).mockResolvedValue(OWNER as never);
      seedDevice('add-server');
      approve();
      vi.mocked(getCloudProfile).mockResolvedValue({
        identityId: IDENTITY,
        username: 'morgan',
        email: null,
      });

      const listed = await call('tofaCheck', { handle: HANDLE });
      expect(listed.response).toMatchObject({ status: 'select-server', servers: [CLOUD_SERVER] });
      expect(listed.ctx.createSession).not.toHaveBeenCalled();

      const { response } = await call('tofaAddServer', {
        tempToken: listed.response.tempToken,
        serverId: CLOUD_SERVER.id,
      });

      expect(response).toEqual({
        status: 'added',
        server: expect.objectContaining({ id: 'server-new' }),
        canStopStreams: true,
      });
      expect(insertedValues()).toEqual([
        expect.objectContaining({ providerId: 'tofa', accountId: IDENTITY, userId: 'owner-1' }),
      ]);
      expect(createServer).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerServerUser: expect.objectContaining({
            userId: 'owner-1',
            externalId: 'local-owner',
          }),
        })
      );
      expect(mockSetSessionCookie).not.toHaveBeenCalled();
    });

    it('add-server leaves the owner no tofa sign-in when the server is not created', async () => {
      store.clear();
      ownerSession();
      seedSignIn('add-server');
      vi.mocked(createServer).mockRejectedValue(new Error('insert failed'));

      await expect(
        call('tofaAddServer', { tempToken: TEMP, serverId: CLOUD_SERVER.id })
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('add-server lists only the tofa servers not connected yet', async () => {
      const den = { ...CLOUD_SERVER, id: 'srv-cloud-2', name: 'Den', localAddress: null };
      store.clear();
      ownerSession();
      seedDevice('add-server');
      approve();
      vi.mocked(getCloudProfile).mockResolvedValue({
        identityId: IDENTITY,
        username: 'morgan',
        email: null,
      });
      vi.mocked(listOwnedServers).mockResolvedValue([CLOUD_SERVER, den]);
      selects([{ machineIdentifier: CLOUD_SERVER.id, url: CLOUD_SERVER.localAddress }]);

      const listed = await call('tofaCheck', { handle: HANDLE });
      expect(listed.response).toMatchObject({ status: 'select-server', servers: [den] });

      seedDevice('add-server');
      selects([
        { machineIdentifier: CLOUD_SERVER.id, url: CLOUD_SERVER.localAddress },
        { machineIdentifier: den.id, url: 'http://10.0.0.4:33333' },
      ]);
      const none = await call('tofaCheck', { handle: HANDLE });
      expect(none.response).toEqual({ status: 'all-connected', username: 'morgan' });
    });

    it('add-server gives an existing owner the picture of their tofa account', async () => {
      store.clear();
      ownerSession();
      seedSignIn('add-server');
      selects([], [{ thumbUrl: '/api/v1/profiles/avatars/astronaut.png', ownerThumbnail: null }]);
      const set = vi.fn(() => ({ where: vi.fn() }));
      vi.mocked(db.update).mockReturnValue({ set } as never);

      const { response } = await call('tofaAddServer', {
        tempToken: TEMP,
        serverId: CLOUD_SERVER.id,
      });

      expect(response).toMatchObject({ status: 'added' });
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ thumbnail: '/api/v1/profiles/avatars/astronaut.png' })
      );
    });
  });

  describe('link', () => {
    const SERVER_ID = '7a4c1d52-3b8e-4f6a-9c2d-1e5f8a9b0c3d';

    function seedLink() {
      store.set(
        REDIS_KEYS.TOFA_DEVICE(HANDLE),
        JSON.stringify({
          deviceCode: 'device-1',
          binding: BINDING,
          purpose: 'link',
          serverId: SERVER_ID,
        })
      );
    }

    it("link needs the owner's session to start and to finish", async () => {
      await expect(
        call('tofaInitiate', { purpose: 'link', serverId: SERVER_ID })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(requestDeviceCode).not.toHaveBeenCalled();

      seedLink();
      approve();
      vi.mocked(getSessionFromCtx).mockResolvedValue({
        session: { impersonatedBy: null },
        user: { id: 'member-1', role: 'member' },
      } as never);
      await expect(call('tofaCheck', { handle: HANDLE })).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(pollDeviceToken).not.toHaveBeenCalled();
    });

    it('link refuses a tofa account with no live account on that server', async () => {
      ownerSession();
      seedLink();
      approve();
      const [account] = selects([]);

      await expect(call('tofaCheck', { handle: HANDLE })).rejects.toMatchObject({
        statusCode: 400,
        body: { message: 'The tofa account you signed in with has no account on this server' },
      });
      const where = renderSql(account?.where?.mock.calls[0]?.[0] as SQL);
      expect(where.params).toEqual(expect.arrayContaining([SERVER_ID, IDENTITY]));
      expect(where.sql).toContain('server_users.removed_at is null');
      expect(where.sql).toContain('servers.historical_at is null');
      expect(db.insert).not.toHaveBeenCalled();
      expect(mergeUsers).not.toHaveBeenCalled();
    });

    it('link merges the account into the owner, bringing its tofa sign-in in the same merge', async () => {
      ownerSession();
      seedLink();
      approve();
      selects(
        [{ userId: 'person-1', serverId: SERVER_ID }],
        [{ personAccounts: 1, ownerAccountsHere: 0 }],
        [],
        []
      );

      const { response, ctx } = await call('tofaCheck', { handle: HANDLE });

      expect(response).toEqual({ status: 'linked' });
      expect(mergeUsers).toHaveBeenCalledWith('person-1', 'owner-1', 'owner-1', {
        bringsTofaSignIn: IDENTITY,
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(ctx.createSession).not.toHaveBeenCalled();
    });
  });
});
