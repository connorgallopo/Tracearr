/**
 * Silo pairing Better Auth plugin tests
 *
 * The endpoint handlers run directly with a mocked Better Auth context, as in tofaPlugin.test.ts.
 * Silo's sign-in calls, server creation, the server change check and the db are mocked; the
 * pairing state lives in the mock Redis, so a parked login is claimed and put back as it is live.
 */

import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { REDIS_KEYS } from '@tracearr/shared';
import { createMockRedis } from '@tracearr/test-utils';

vi.mock('../../db/client.js', () => ({ db: { select: vi.fn(), update: vi.fn() } }));

vi.mock('../../services/mediaServer/silo/auth.js', () => ({
  siloBinding: vi.fn(() => ({ binding: 'binding-1', secret: 'binding-secret-1' })),
  startPairing: vi.fn(),
  pollPairing: vi.fn(),
  cancelPairing: vi.fn(),
  logout: vi.fn(),
  primaryProfile: vi.fn(),
  verifyPin: vi.fn(),
  createTracearrKey: vi.fn(),
  deleteKey: vi.fn(),
  pairingOffered: vi.fn(),
}));

vi.mock('../../services/mediaServer/byServerType.js', () => ({ readServerFacts: vi.fn() }));
vi.mock('../../services/serverCreate.js', () => ({
  createServer: vi.fn(),
  startAddedServer: vi.fn(),
  connectedServerConflict: vi.fn(),
}));
vi.mock('../../services/serverChange.js', () => ({ verifyServerChange: vi.fn() }));
vi.mock('../../jobs/poller/database.js', () => ({ publishServersChanged: vi.fn() }));
vi.mock('../../services/sseManager.js', () => ({ sseManager: { refresh: vi.fn() } }));

const { logged } = vi.hoisted(() => ({
  logged: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/logger.js')>()),
  createLogger: () => logged,
}));

vi.mock('better-auth/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('better-auth/api')>()),
  getSessionFromCtx: vi.fn(),
}));

import { getSessionFromCtx } from 'better-auth/api';
import { db } from '../../db/client.js';
import { publishServersChanged } from '../../jobs/poller/database.js';
import { setSharedRedis } from '../../lib/redisShared.js';
import type { SiloPairingState } from '../../lib/siloPairing.js';
import { siloPlugin } from '../../lib/siloPlugin.js';
import {
  cancelPairing,
  createTracearrKey,
  deleteKey,
  logout,
  pairingOffered,
  pollPairing,
  primaryProfile,
  startPairing,
  verifyPin,
} from '../../services/mediaServer/silo/auth.js';
import { SiloClient } from '../../services/mediaServer/silo/client.js';
import { readServerFacts } from '../../services/mediaServer/byServerType.js';
import { verifyServerChange } from '../../services/serverChange.js';
import {
  connectedServerConflict,
  createServer,
  startAddedServer,
} from '../../services/serverCreate.js';
import { sseManager } from '../../services/sseManager.js';

const URL = 'http://silo.lan:8090';
const OWNER_ID = 'owner-1';
const ACCESS = 'silo-access-token-1';
const KEY = 'silo-new-key-secret';
const DEVICE_CODE = 'device-code-1';
const BINDING_SECRET = 'binding-secret-1';
const PROFILE_TOKEN = 'profile-token-1';
const PIN = '8642';
const SECRETS = [ACCESS, KEY, DEVICE_CODE, BINDING_SECRET, PROFILE_TOKEN, PIN];

const ADMIN = { id: 'silo-user-1', username: 'connor', email: 'connor@example.com', role: 'admin' };
const SERVER_ID = '7c1e7a52-0a8d-4b0e-9a40-2f6b3e1d5c11';
const SERVER_ROW = { id: SERVER_ID, name: 'Silo', type: 'silo', canStopStreams: true };
const SAVED_SERVER = {
  id: SERVER_ID,
  name: 'Silo',
  type: 'silo' as const,
  url: URL,
  publicUrl: null,
  token: 'old-key',
  apiKeyId: 'old-key-id',
  machineIdentifier: 'silo-server-1',
};

const realCheckSiloServer = SiloClient.checkSiloServer.bind(SiloClient);
let outputs: string[] = [];

function makeCtx() {
  return {
    context: { logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  };
}

type Endpoints = ReturnType<typeof siloPlugin>['endpoints'];

async function call(name: keyof Endpoints, body: Record<string, unknown>, ctx = makeCtx()) {
  const endpoint = siloPlugin().endpoints[name] as (input: unknown) => Promise<unknown>;
  const logCalls = () =>
    JSON.stringify(Object.values(ctx.context.logger).map((fn) => fn.mock.calls));
  try {
    const response = (await endpoint({
      body,
      headers: new Headers(),
      context: ctx.context,
    })) as Record<string, unknown>;
    outputs.push(JSON.stringify(response), logCalls());
    return response;
  } catch (error) {
    const { statusCode, body: errorBody } = error as { statusCode?: number; body?: unknown };
    outputs.push(JSON.stringify({ statusCode, errorBody }), logCalls());
    throw error;
  }
}

function session(id = OWNER_ID, role = 'owner') {
  vi.mocked(getSessionFromCtx).mockResolvedValue({
    session: { impersonatedBy: null },
    user: { id, role },
  } as never);
}

async function seed(state: Partial<SiloPairingState> = {}): Promise<string> {
  const handle = randomBytes(32).toString('hex');
  await redis.set(
    REDIS_KEYS.SILO_PAIRING(handle),
    JSON.stringify({
      purpose: 'add-server',
      ownerId: OWNER_ID,
      name: 'Silo',
      url: URL,
      publicUrl: null,
      deviceCode: DEVICE_CODE,
      secret: BINDING_SECRET,
      ...state,
    }),
    'EX',
    900
  );
  return handle;
}

function approve(user = ADMIN) {
  vi.mocked(pollPairing).mockResolvedValue({
    status: 'approved',
    login: { accessToken: ACCESS, user: { ...user, email: user.email } },
  });
}

function savedServer(row: Record<string, unknown> = SAVED_SERVER) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(row ? [row] : []),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
}

function serverUpdate() {
  const chain = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

const order = (fn: unknown, index = 0) =>
  vi.mocked(fn as () => unknown).mock.invocationCallOrder[index] ?? Infinity;

let redis: ReturnType<typeof createMockRedis>;

describe('silo pairing plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    outputs = [];
    redis = createMockRedis();
    setSharedRedis(redis);
    session();
    vi.spyOn(SiloClient, 'checkSiloServer').mockResolvedValue(null);
    vi.spyOn(SiloClient, 'verifyServerAdmin').mockResolvedValue({ success: true });
    vi.spyOn(SiloClient.prototype, 'getServerIdentity').mockResolvedValue('silo-server-1');
    vi.mocked(connectedServerConflict).mockResolvedValue(null);
    vi.mocked(pairingOffered).mockResolvedValue(true);
    vi.mocked(startPairing).mockResolvedValue({
      deviceCode: DEVICE_CODE,
      userCode: '48217730',
      verificationUriComplete: `${URL}/activate?code=48217730`,
      expiresIn: 900,
      interval: 5,
    });
    vi.mocked(logout).mockResolvedValue();
    vi.mocked(cancelPairing).mockResolvedValue();
    vi.mocked(primaryProfile).mockResolvedValue({ id: 'p-1', hasPin: false });
    vi.mocked(createTracearrKey).mockResolvedValue({ id: 'key-1', key: KEY });
    vi.mocked(deleteKey).mockResolvedValue('deleted');
    vi.mocked(readServerFacts).mockResolvedValue({});
    vi.mocked(createServer).mockResolvedValue({
      server: SERVER_ROW,
      requestServiceIds: [],
    } as never);
    vi.mocked(startAddedServer).mockResolvedValue();
    vi.mocked(verifyServerChange).mockResolvedValue({ ok: true, facts: {} });
    vi.mocked(publishServersChanged).mockResolvedValue();
    vi.mocked(sseManager.refresh).mockResolvedValue();
  });

  afterEach(() => {
    const seen = [...outputs, ...Object.values(logged).map((fn) => JSON.stringify(fn.mock.calls))];
    for (const text of seen) {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
  });

  describe('start', () => {
    const addBody = { purpose: 'add-server', url: URL, name: 'Silo' };

    it('refuses without an owner session', async () => {
      vi.mocked(getSessionFromCtx).mockResolvedValue(null);
      await expect(call('siloPairStart', addBody)).rejects.toMatchObject({ statusCode: 403 });

      session('member-1', 'member');
      await expect(call('siloPairStart', addBody)).rejects.toMatchObject({ statusCode: 403 });
      expect(startPairing).not.toHaveBeenCalled();
    });

    it('checks the address answers as Silo before any pairing call', async () => {
      vi.mocked(SiloClient.checkSiloServer).mockResolvedValueOnce(
        `${URL} does not answer as a Silo server with API version 2.`
      );

      await expect(call('siloPairStart', addBody)).rejects.toMatchObject({
        statusCode: 400,
        body: { message: `${URL} does not answer as a Silo server with API version 2.` },
      });
      expect(SiloClient.checkSiloServer).toHaveBeenCalledWith(URL);
      expect(connectedServerConflict).not.toHaveBeenCalled();
      expect(pairingOffered).not.toHaveBeenCalled();
      expect(startPairing).not.toHaveBeenCalled();
    });

    it('refuses a link-local address', async () => {
      vi.mocked(SiloClient.checkSiloServer).mockImplementationOnce(realCheckSiloServer);

      await expect(
        call('siloPairStart', { ...addBody, url: 'http://169.254.169.254:8090' })
      ).rejects.toMatchObject({
        statusCode: 400,
        body: { message: expect.stringContaining('link-local') },
      });
      expect(startPairing).not.toHaveBeenCalled();
    });

    it.each(['url', 'identity'] as const)(
      'refuses a server already connected by its %s before any sign-in call',
      async (kind) => {
        vi.mocked(connectedServerConflict).mockResolvedValueOnce(kind);

        await expect(call('siloPairStart', addBody)).rejects.toMatchObject({ statusCode: 409 });
        expect(connectedServerConflict).toHaveBeenCalledWith('silo', URL, 'silo-server-1');
        expect(pairingOffered).not.toHaveBeenCalled();
        expect(startPairing).not.toHaveBeenCalled();
      }
    );

    it('refuses when Silo has pairing off', async () => {
      vi.mocked(pairingOffered).mockResolvedValueOnce(false);

      await expect(call('siloPairStart', addBody)).rejects.toMatchObject({
        statusCode: 400,
        body: { message: 'Pairing is off on this Silo server. Use an API key instead.' },
      });
      expect(startPairing).not.toHaveBeenCalled();
    });

    it('returns the code and a link on the public address, never the device code', async () => {
      const response = await call('siloPairStart', {
        ...addBody,
        publicUrl: 'https://silo.example.com',
      });

      expect(response).toEqual({
        handle: expect.stringMatching(/^[0-9a-f]{64}$/),
        userCode: '48217730',
        link: 'https://silo.example.com/activate?code=48217730',
        expiresIn: 900,
        interval: 5,
      });
      expect(
        JSON.parse((await redis.get(REDIS_KEYS.SILO_PAIRING(String(response.handle))))!)
      ).toMatchObject({ purpose: 'add-server', ownerId: OWNER_ID, name: 'Silo', url: URL });
    });

    it('starts a re-key on the saved server, linking to its public address', async () => {
      savedServer({ ...SAVED_SERVER, publicUrl: 'https://silo.example.com' });

      const response = await call('siloPairStart', { purpose: 'rekey', serverId: SERVER_ID });

      expect(response.link).toBe('https://silo.example.com/activate?code=48217730');
      expect(startPairing).toHaveBeenCalledWith(URL, 'binding-1');
    });

    it('refuses a re-key for a server it does not have', async () => {
      savedServer(null as never);

      await expect(
        call('siloPairStart', { purpose: 'rekey', serverId: SERVER_ID })
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(startPairing).not.toHaveBeenCalled();
    });
  });

  describe('check', () => {
    it("answers expired to another owner's request and polls nothing", async () => {
      const handle = await seed();
      session('owner-2');

      expect(await call('siloPairCheck', { handle })).toEqual({ status: 'expired' });
      expect(pollPairing).not.toHaveBeenCalled();
    });

    it("answers expired to a member's sign-in request and polls nothing", async () => {
      const handle = await seed({ purpose: 'sign-in', serverId: SERVER_ID } as never);

      expect(await call('siloPairCheck', { handle })).toEqual({ status: 'expired' });
      expect(pollPairing).not.toHaveBeenCalled();
    });

    it('answers expired and drops the state when Silo says the request is gone', async () => {
      const handle = await seed();
      vi.mocked(pollPairing).mockResolvedValue({ status: 'gone' });

      expect(await call('siloPairCheck', { handle })).toEqual({ status: 'expired' });
      expect(pollPairing).toHaveBeenCalledWith(URL, DEVICE_CODE, BINDING_SECRET);
      expect(await redis.get(REDIS_KEYS.SILO_PAIRING(handle))).toBeNull();
      expect(logout).not.toHaveBeenCalled();
    });

    it('passes pending and opened through', async () => {
      const handle = await seed();
      vi.mocked(pollPairing).mockResolvedValue({
        status: 'pending',
        opened: true,
        expiresAt: null,
        pollAfter: 5,
      });

      expect(await call('siloPairCheck', { handle })).toEqual({ status: 'pending', opened: true });
    });

    it('answers not-admin to an approver who is not a Silo admin and logs them out', async () => {
      const handle = await seed();
      approve({ ...ADMIN, role: 'user' });

      expect(await call('siloPairCheck', { handle })).toEqual({ status: 'not-admin' });
      expect(logout).toHaveBeenCalledExactlyOnceWith(URL, ACCESS);
      expect(createTracearrKey).not.toHaveBeenCalled();
    });

    it("adds the server with the approver as the owner's account, then logs out", async () => {
      const handle = await seed({ publicUrl: 'https://silo.example.com' });
      approve();

      const response = await call('siloPairCheck', { handle });

      expect(response).toEqual({ status: 'added', server: SERVER_ROW, canStopStreams: true });
      expect(createTracearrKey).toHaveBeenCalledWith(URL, ACCESS, {
        profileId: 'p-1',
        profileToken: null,
      });
      expect(SiloClient.verifyServerAdmin).toHaveBeenCalledWith(KEY, URL);
      expect(readServerFacts).toHaveBeenCalledWith('silo', URL, KEY);
      expect(createServer).toHaveBeenCalledWith({
        name: 'Silo',
        type: 'silo',
        url: URL,
        token: KEY,
        publicUrl: 'https://silo.example.com',
        machineIdentifier: 'silo-server-1',
        apiKeyId: 'key-1',
        facts: {},
        ownerServerUser: {
          userId: OWNER_ID,
          externalId: ADMIN.id,
          username: ADMIN.username,
          email: ADMIN.email,
          cloudIdentityId: null,
        },
      });
      expect(startAddedServer).toHaveBeenCalledWith(SERVER_ROW, []);
      expect(logout).toHaveBeenCalledExactlyOnceWith(URL, ACCESS);
      expect(order(logout)).toBeGreaterThan(order(createServer));
      expect(await redis.get(REDIS_KEYS.SILO_PAIRING(handle))).toBeNull();
    });

    it('sends no profile headers for an admin with no profile', async () => {
      const handle = await seed();
      approve();
      vi.mocked(primaryProfile).mockResolvedValue(null);

      await call('siloPairCheck', { handle });

      expect(createTracearrKey).toHaveBeenCalledWith(URL, ACCESS, {
        profileId: null,
        profileToken: null,
      });
    });

    it('refuses a server connected meanwhile before making a key', async () => {
      const handle = await seed();
      approve();
      vi.mocked(connectedServerConflict).mockResolvedValueOnce('identity');

      await expect(call('siloPairCheck', { handle })).rejects.toMatchObject({
        statusCode: 400,
        body: { message: 'This server is already connected' },
      });
      expect(createTracearrKey).not.toHaveBeenCalled();
      expect(logout).toHaveBeenCalledOnce();
    });

    it('deletes the key a failed verify made before logging out', async () => {
      const handle = await seed();
      approve();
      vi.mocked(SiloClient.verifyServerAdmin).mockResolvedValueOnce({
        success: false,
        code: 'MISSING_SCOPES',
        message: 'This Silo API key lacks a scope Tracearr needs.',
      });

      await expect(call('siloPairCheck', { handle })).rejects.toMatchObject({
        statusCode: 400,
        body: { message: 'This Silo API key lacks a scope Tracearr needs.' },
      });
      expect(deleteKey).toHaveBeenCalledWith(
        URL,
        ACCESS,
        { profileId: 'p-1', profileToken: null },
        'key-1'
      );
      expect(order(deleteKey)).toBeLessThan(order(logout));
      expect(logout).toHaveBeenCalledOnce();
      expect(createServer).not.toHaveBeenCalled();
    });

    it('deletes the key when the server cannot be saved', async () => {
      const handle = await seed();
      approve();
      vi.mocked(createServer).mockRejectedValueOnce(
        Object.assign(new Error('insert failed'), { params: [KEY] })
      );

      await expect(call('siloPairCheck', { handle })).rejects.toMatchObject({ statusCode: 400 });
      expect(deleteKey).toHaveBeenCalledWith(URL, ACCESS, expect.anything(), 'key-1');
      expect(order(deleteKey)).toBeLessThan(order(logout));
      expect(logout).toHaveBeenCalledOnce();
      expect(startAddedServer).not.toHaveBeenCalled();
    });

    describe('profile PIN', () => {
      async function parked(): Promise<string> {
        const handle = await seed();
        approve();
        vi.mocked(primaryProfile).mockResolvedValue({ id: 'p-1', hasPin: true });
        expect(await call('siloPairCheck', { handle })).toEqual({
          status: 'needs-pin',
          wrongPin: false,
        });
        vi.mocked(pollPairing).mockClear();
        return handle;
      }

      it('parks the login without a key or a logout', async () => {
        await parked();

        expect(createTracearrKey).not.toHaveBeenCalled();
        expect(logout).not.toHaveBeenCalled();
      });

      it('asks again for the PIN on a check without one, polling nothing', async () => {
        const handle = await parked();

        expect(await call('siloPairCheck', { handle })).toEqual({
          status: 'needs-pin',
          wrongPin: false,
        });
        expect(pollPairing).not.toHaveBeenCalled();
        expect(logout).not.toHaveBeenCalled();
      });

      it('puts the login back after a wrong PIN and ends it at the third', async () => {
        const handle = await parked();
        vi.mocked(verifyPin).mockResolvedValue('wrong');

        for (let attempt = 1; attempt < 3; attempt++) {
          expect(await call('siloPairCheck', { handle, pin: PIN })).toEqual({
            status: 'needs-pin',
            wrongPin: true,
          });
          expect(logout).not.toHaveBeenCalled();
        }
        expect(await call('siloPairCheck', { handle, pin: PIN })).toEqual({ status: 'expired' });
        expect(logout).toHaveBeenCalledExactlyOnceWith(URL, ACCESS);
        expect(createTracearrKey).not.toHaveBeenCalled();
      });

      it('answers pin-locked and logs out when Silo locked the profile', async () => {
        const handle = await parked();
        vi.mocked(verifyPin).mockResolvedValue('locked');

        expect(await call('siloPairCheck', { handle, pin: PIN })).toEqual({
          status: 'pin-locked',
        });
        expect(logout).toHaveBeenCalledOnce();
      });

      it('logs out when the PIN check fails', async () => {
        const handle = await parked();
        vi.mocked(verifyPin).mockRejectedValue(new Error('silo request failed: 503'));

        await expect(call('siloPairCheck', { handle, pin: PIN })).rejects.toMatchObject({
          statusCode: 500,
        });
        expect(logout).toHaveBeenCalledOnce();
      });

      it('logs out when the key cannot be made after a right PIN', async () => {
        const handle = await parked();
        vi.mocked(verifyPin).mockResolvedValue({ profileToken: PROFILE_TOKEN });
        vi.mocked(createTracearrKey).mockRejectedValue(new Error('silo request failed: 500'));

        await expect(call('siloPairCheck', { handle, pin: PIN })).rejects.toMatchObject({
          statusCode: 500,
        });
        expect(logout).toHaveBeenCalledOnce();
      });

      it('sends the profile token with the key calls after a right PIN', async () => {
        const handle = await parked();
        vi.mocked(verifyPin).mockResolvedValue({ profileToken: PROFILE_TOKEN });
        vi.mocked(SiloClient.verifyServerAdmin).mockResolvedValueOnce({
          success: false,
          code: 'INVALID_KEY',
          message: 'Silo rejected this API key.',
        });

        await expect(call('siloPairCheck', { handle, pin: PIN })).rejects.toMatchObject({
          statusCode: 400,
        });
        const proof = { profileId: 'p-1', profileToken: PROFILE_TOKEN };
        expect(verifyPin).toHaveBeenCalledWith(URL, ACCESS, 'p-1', PIN);
        expect(createTracearrKey).toHaveBeenCalledWith(URL, ACCESS, proof);
        expect(deleteKey).toHaveBeenCalledWith(URL, ACCESS, proof, 'key-1');
        expect(logout).toHaveBeenCalledOnce();
      });
    });

    describe('rekey', () => {
      const rekeyState = { purpose: 'rekey', serverId: SERVER_ID } as never;

      it('deletes the new key when the server change check refuses it', async () => {
        const handle = await seed(rekeyState);
        approve();
        savedServer();
        vi.mocked(verifyServerChange).mockResolvedValueOnce({
          ok: false,
          message: 'That address or API key reaches a different server.',
        });

        await expect(call('siloPairCheck', { handle })).rejects.toMatchObject({
          statusCode: 400,
          body: { message: 'That address or API key reaches a different server.' },
        });
        expect(verifyServerChange).toHaveBeenCalledWith(SAVED_SERVER, { url: URL, token: KEY });
        expect(deleteKey).toHaveBeenCalledExactlyOnceWith(URL, ACCESS, expect.anything(), 'key-1');
        expect(db.update).not.toHaveBeenCalled();
        expect(logout).toHaveBeenCalledOnce();
      });

      it('saves the new key, moves the socket, then deletes the old key', async () => {
        const handle = await seed(rekeyState);
        approve();
        savedServer();
        const update = serverUpdate();
        vi.mocked(verifyServerChange).mockResolvedValueOnce({
          ok: true,
          facts: { canStopStreams: true, watchedRulePercent: 85 },
          backfilledIdentity: 'silo-server-1',
        });
        const events: string[] = [];
        vi.mocked(sseManager.refresh).mockImplementation(async () => {
          await Promise.resolve();
          events.push('refreshed');
        });
        vi.mocked(deleteKey).mockImplementation(async (_url, _token, _proof, id) => {
          events.push(`deleted ${id}`);
          return 'deleted';
        });

        expect(await call('siloPairCheck', { handle })).toEqual({
          status: 'rekeyed',
          oldKeyLeft: false,
        });
        expect(update.set).toHaveBeenCalledWith({
          canStopStreams: true,
          watchedRulePercent: 85,
          token: KEY,
          apiKeyId: 'key-1',
          machineIdentifier: 'silo-server-1',
          updatedAt: expect.any(Date),
        });
        expect(publishServersChanged).toHaveBeenCalledOnce();
        expect(events).toEqual(['refreshed', 'deleted old-key-id']);
        expect(logout).toHaveBeenCalledOnce();
        expect(order(logout)).toBeGreaterThan(order(deleteKey));
      });

      it('reports the old key left when Silo no longer lists it', async () => {
        const handle = await seed(rekeyState);
        approve();
        savedServer();
        serverUpdate();
        vi.mocked(deleteKey).mockResolvedValueOnce('not-found');

        expect(await call('siloPairCheck', { handle })).toEqual({
          status: 'rekeyed',
          oldKeyLeft: true,
        });
        expect(logout).toHaveBeenCalledOnce();
      });

      it('reports the old key left when the old delete fails', async () => {
        const handle = await seed(rekeyState);
        approve();
        savedServer();
        serverUpdate();
        vi.mocked(deleteKey).mockRejectedValueOnce(new Error('silo request failed: 503'));

        expect(await call('siloPairCheck', { handle })).toEqual({
          status: 'rekeyed',
          oldKeyLeft: true,
        });
        expect(logout).toHaveBeenCalledOnce();
      });

      it('deletes nothing for a key Tracearr did not make', async () => {
        const handle = await seed(rekeyState);
        approve();
        savedServer({ ...SAVED_SERVER, apiKeyId: null });
        serverUpdate();

        expect(await call('siloPairCheck', { handle })).toEqual({
          status: 'rekeyed',
          oldKeyLeft: true,
        });
        expect(deleteKey).not.toHaveBeenCalled();
        expect(logout).toHaveBeenCalledOnce();
      });
    });
  });

  describe('cancel', () => {
    it("ends the session's own request", async () => {
      const handle = await seed();

      expect(await call('siloPairCancel', { handle })).toEqual({ status: 'canceled' });
      expect(cancelPairing).toHaveBeenCalledWith(URL, DEVICE_CODE);
      expect(await redis.get(REDIS_KEYS.SILO_PAIRING(handle))).toBeNull();
    });

    it("changes nothing for another owner's or a member's request", async () => {
      const own = await seed();
      const member = await seed({ purpose: 'sign-in', serverId: SERVER_ID } as never);
      session('owner-2');

      expect(await call('siloPairCancel', { handle: own })).toEqual({ status: 'canceled' });
      session();
      expect(await call('siloPairCancel', { handle: member })).toEqual({ status: 'canceled' });
      expect(cancelPairing).not.toHaveBeenCalled();
      expect(await redis.get(REDIS_KEYS.SILO_PAIRING(own))).not.toBeNull();
      expect(await redis.get(REDIS_KEYS.SILO_PAIRING(member))).not.toBeNull();
    });
  });
});
