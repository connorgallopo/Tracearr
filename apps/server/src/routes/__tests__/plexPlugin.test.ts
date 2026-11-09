/**
 * Plex Better Auth plugin tests
 *
 * The plugin endpoints run inside Better Auth, which normally needs a live
 * Postgres/Redis to exercise end-to-end (session creation, cookie signing).
 * None is available in this environment, so these tests invoke the plugin's
 * Better Auth endpoint handlers directly with a mocked adapter/context and
 * mock the collaborators (PlexClient, db by table identity, Redis, user
 * lookups, setSessionCookie) following the precedent in
 * src/routes/auth/__tests__/plex.test.ts. The owner-only / allowLogin /
 * first-run branching (the security-critical logic) is what is verified here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

const { mockGetUsers } = vi.hoisted(() => ({ mockGetUsers: vi.fn() }));

vi.mock('../../services/mediaServer/index.js', () => {
  class MockPlexClient {
    getUsers = mockGetUsers;
  }
  return {
    PlexClient: Object.assign(MockPlexClient, {
      initiateOAuth: vi.fn(),
      checkOAuthPin: vi.fn(),
      getServers: vi.fn(),
      verifyServerAdmin: vi.fn(),
      AdminVerifyError: {
        CONNECTION_FAILED: 'CONNECTION_FAILED',
        NOT_ADMIN: 'NOT_ADMIN',
      },
    }),
  };
});

const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../lib/redisShared.js', () => ({
  getRedis: () => mockRedis,
  closeRedis: vi.fn(),
}));

vi.mock('../../services/userService.js', () => ({
  getUserById: vi.fn(),
  getOwnerUser: vi.fn(),
}));

vi.mock('../../lib/authGuards.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/authGuards.js')>()),
  usableLoginMethods: vi.fn(),
  canMemberLogin: vi.fn(),
  mediaSignInClosed: vi.fn(async () => false),
}));

vi.mock('../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn(() => false),
  validateClaimCode: vi.fn(() => true),
}));

vi.mock('../../services/sync.js', () => ({ syncServer: vi.fn(() => Promise.resolve()) }));

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

import { db } from '../../db/client.js';
import { PlexClient } from '../../services/mediaServer/index.js';
import { getUserById, getOwnerUser } from '../../services/userService.js';
import {
  canMemberLogin,
  mediaSignInClosed,
  MEMBER_LOGIN_REFUSED,
  MEMBER_NOT_PERMITTED,
  usableLoginMethods,
} from '../../lib/authGuards.js';
import { isClaimCodeEnabled, validateClaimCode } from '../../utils/claimCode.js';
import { plexPlugin } from '../../lib/plexPlugin.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Thenable chain mock: every builder method returns the chain, awaiting it
// resolves to the configured rows. Covers select/insert/update terminals.
function makeChain(result: unknown = []) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'from',
    'innerJoin',
    'where',
    'limit',
    'orderBy',
    'set',
    'values',
    'returning',
    'onConflictDoUpdate',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return chain;
}

function makeCtx() {
  const session = { id: 'sess-1', token: 'sess-token-1', userId: 'user-1' };
  const createSession = vi.fn(async (userId: string) => ({ ...session, userId }));
  const findUserById = vi.fn(async (userId: string) => ({
    id: userId,
    name: 'plexuser',
    email: 'plex@example.com',
  }));
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    context: {
      internalAdapter: { createSession, findUserById },
      logger,
      createAuthCookie: (name: string) => ({ name: `better-auth.${name}`, attributes: {} }),
    },
    createSession,
    findUserById,
  };
}

type PluginEndpoints = ReturnType<typeof plexPlugin>['endpoints'];

const PIN = { pinId: 'pin-1', binding: 'binding-1' };

async function callEndpoint(
  name: keyof PluginEndpoints,
  body: Record<string, unknown>,
  ctx = makeCtx(),
  cookie = `better-auth.plex_pin=${PIN.binding}`
) {
  const endpoint = plexPlugin().endpoints[name] as (input: unknown) => Promise<unknown>;
  const result = (await endpoint({
    body,
    headers: new Headers({ cookie }),
    context: ctx.context,
    returnHeaders: true,
  })) as { headers: Headers; response: Record<string, unknown> };
  return { result, ctx };
}

const authResult = {
  id: 'plex-tv-1',
  username: 'plexuser',
  email: 'plex@example.com',
  thumb: 'https://plex.tv/thumb.png',
  token: 'plex-token-abc',
  tokenKind: 'legacy' as const,
  refreshToken: null,
  expiresAt: null,
};

describe('plex better auth plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
    vi.mocked(db.update).mockReturnValue(makeChain([]) as never);
    vi.mocked(db.insert).mockReturnValue(makeChain([]) as never);
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.mocked(usableLoginMethods).mockResolvedValue({
      local: true,
      plex: true,
      oidc: false,
      member: false,
    });
    vi.mocked(canMemberLogin).mockResolvedValue({ ok: true });
    mockRedis.get.mockImplementation(async (key: string) =>
      key.includes('plex_pin') ? JSON.stringify(PIN) : null
    );
  });

  it('hands out a handle for the pin, never the pin id, bound to this browser', async () => {
    vi.mocked(PlexClient.initiateOAuth).mockResolvedValue({
      pinId: 'pin-9',
      authUrl: 'https://app.plex.tv/auth#?code=x',
    });

    const { result } = await callEndpoint('plexInitiate', {});

    expect(result.response).toEqual({
      handle: expect.stringMatching(/^[0-9a-f]{64}$/),
      authUrl: 'https://app.plex.tv/auth#?code=x',
    });
    expect(JSON.stringify(result.response)).not.toContain('pin-9');
    const [key, , stored] = mockRedis.setex.mock.calls[0] ?? [];
    expect(key).toContain(result.response.handle as string);
    const { binding } = JSON.parse(stored as string) as { binding: string };
    expect(result.headers.get('set-cookie')).toContain(`better-auth.plex_pin=${binding}`);
  });

  it.each([
    ['a guessed handle', null, `better-auth.plex_pin=${PIN.binding}`],
    ['a handle from another browser', JSON.stringify(PIN), 'better-auth.plex_pin=someone-else'],
    ['a handle with no browser cookie', JSON.stringify(PIN), ''],
  ])('answers %s as expired without asking plex.tv', async (_label, stored, cookie) => {
    mockRedis.get.mockResolvedValue(stored);

    const { result } = await callEndpoint('plexCheckPin', { handle: 'guess' }, makeCtx(), cookie);

    expect(result.response).toEqual({ authorized: false, expired: true });
    expect(PlexClient.checkOAuthPin).not.toHaveBeenCalled();
  });

  it('spends the handle once plex.tv authorizes the pin', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 'pa-1', userId: 'owner-1', allowLogin: true }]) as never
    );
    vi.mocked(getUserById).mockResolvedValue({ id: 'owner-1', role: 'owner' } as never);

    await callEndpoint('plexCheckPin', { handle: 'handle-1' });

    expect(PlexClient.checkOAuthPin).toHaveBeenCalledWith(PIN.pinId);
    expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining('plex_pin:handle-1'));
  });

  it('returns authorized false while the pin is unclaimed', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(null);

    const { result } = await callEndpoint('plexCheckPin', { handle: 'handle-1' });

    expect(result.response).toEqual({ authorized: false, message: 'PIN not yet authorized' });
  });

  it("never logs a failed query's parameters, the plex token among them", async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    const leak = Object.assign(new Error('query failed'), { params: [authResult.token] });
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw leak;
    });
    const ctx = makeCtx();

    await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' }, ctx)).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(ctx.context.logger.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(ctx.context.logger.error.mock.calls)).not.toContain(authResult.token);
  });

  it('logs in an existing owner by plex account and sets a session cookie', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 'pa-1', userId: 'owner-1', allowLogin: true }]) as never
    );
    vi.mocked(getUserById).mockResolvedValue({
      id: 'owner-1',
      role: 'owner',
      username: 'plexuser',
    } as never);

    const { result, ctx } = await callEndpoint('plexCheckPin', { handle: 'handle-1' });

    expect(result.response.authorized).toBe(true);
    expect((result.response.user as { id: string }).id).toBe('owner-1');
    expect(ctx.createSession).toHaveBeenCalledWith('owner-1');
    expect(mockSetSessionCookie).toHaveBeenCalledTimes(1);
    expect(String(result.headers.get('set-cookie'))).toContain('better-auth');
  });

  it('refuses the owner when Plex login is not usable', async () => {
    vi.mocked(usableLoginMethods).mockResolvedValue({
      local: true,
      plex: false,
      oidc: false,
      member: true,
    });
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 'pa-1', userId: 'owner-1', allowLogin: true }]) as never
    );
    vi.mocked(getUserById).mockResolvedValue({ id: 'owner-1', role: 'owner' } as never);

    await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' })).rejects.toMatchObject({
      statusCode: 403,
      body: { message: MEMBER_LOGIN_REFUSED },
    });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('refuses a non-owner plex login with no live Plex server account', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select)
      .mockReturnValueOnce(
        makeChain([{ id: 'pa-2', userId: 'viewer-1', allowLogin: true }]) as never
      )
      .mockReturnValueOnce(makeChain([]) as never);
    vi.mocked(getUserById).mockResolvedValue({
      id: 'viewer-1',
      role: 'member',
      username: 'viewer',
    } as never);

    await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' })).rejects.toMatchObject({
      statusCode: 403,
      body: { message: MEMBER_LOGIN_REFUSED },
    });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('starts server selection for a brand new first user with servers', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    // plex_accounts lookup empty, then the legacy identity lookup empty
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([]) as never)
      .mockReturnValueOnce(makeChain([]) as never);
    vi.mocked(getOwnerUser).mockResolvedValue(null);
    vi.mocked(PlexClient.getServers).mockResolvedValue([
      {
        name: 'My Plex',
        platform: 'Linux',
        productVersion: '1.40',
        clientIdentifier: 'machine-1',
        publicAddressMatches: true,
        httpsRequired: false,
        connections: [
          {
            protocol: 'http',
            uri: 'http://192.168.1.10:32400',
            local: true,
            address: '192.168.1.10',
            port: 32400,
            relay: false,
          },
        ],
      },
    ] as never);

    const { result } = await callEndpoint('plexCheckPin', { handle: 'handle-1' });

    expect(result.response.authorized).toBe(true);
    expect(result.response.needsServerSelection).toBe(true);
    expect(result.response.tempToken).toBeTruthy();
    expect((result.response.servers as unknown[]).length).toBe(1);
    expect(mockRedis.setex).toHaveBeenCalledTimes(1);
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('rejects a new plex user when an owner already exists', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([]) as never)
      .mockReturnValueOnce(makeChain([]) as never)
      .mockReturnValueOnce(makeChain([]) as never);
    vi.mocked(getOwnerUser).mockResolvedValue({ id: 'owner-x', role: 'owner' } as never);

    await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('signs in the owner the legacy lookup resolves (Priority 2 and 3)', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([]) as never)
      .mockReturnValueOnce(makeChain([{ id: 'owner-1', role: 'owner' }]) as never)
      .mockReturnValueOnce(makeChain([]) as never);

    await callEndpoint('plexCheckPin', { handle: 'handle-1' });

    expect(mockSetSessionCookie).toHaveBeenCalled();
  });

  it('refuses a non-owner the legacy lookup resolves with no live Plex server account', async () => {
    vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([]) as never)
      .mockReturnValueOnce(makeChain([{ id: 'legacy-viewer-1', role: 'member' }]) as never)
      .mockReturnValueOnce(makeChain([]) as never);

    await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  describe('member path', () => {
    beforeEach(() => {
      vi.mocked(usableLoginMethods).mockResolvedValue({
        local: true,
        plex: false,
        oidc: false,
        member: true,
      });
      vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(authResult);
      vi.mocked(db.select)
        .mockReturnValueOnce(makeChain([]) as never)
        .mockReturnValueOnce(makeChain([{ id: 'member-1', role: 'member' }]) as never)
        .mockReturnValueOnce(makeChain([{ userId: 'member-1', serverId: 'srv-1' }]) as never);
    });

    it('signs in a synced member that passes the gates and keeps no plex.tv token', async () => {
      const { result, ctx } = await callEndpoint('plexCheckPin', { handle: 'handle-1' });

      expect(result.response).toEqual({
        authorized: true,
        user: { id: 'member-1', username: 'plexuser', role: 'member' },
      });
      expect(canMemberLogin).toHaveBeenCalledWith('member-1', 'srv-1');
      expect(ctx.createSession).toHaveBeenCalledWith('member-1');
      const insert = vi.mocked(db.insert).mock.results[0]?.value as {
        values: ReturnType<typeof vi.fn>;
      };
      expect(insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'plex',
          accountId: 'plex-tv-1',
          userId: 'member-1',
          accessToken: null,
          refreshToken: null,
        })
      );
    });

    it('tells a member plex.tv vouched for that they are not permitted', async () => {
      vi.mocked(canMemberLogin).mockResolvedValue({ ok: false, reason: 'not-permitted' });

      await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' })).rejects.toMatchObject({
        statusCode: 403,
        body: { code: 'MEMBER_NOT_PERMITTED', message: MEMBER_NOT_PERMITTED },
      });
      expect(mockSetSessionCookie).not.toHaveBeenCalled();
    });

    it('refuses every member while single sign-on only is on', async () => {
      vi.mocked(mediaSignInClosed).mockResolvedValueOnce(true);

      await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' })).rejects.toMatchObject({
        statusCode: 403,
        body: { message: MEMBER_LOGIN_REFUSED },
      });
      expect(canMemberLogin).not.toHaveBeenCalled();
      expect(mockSetSessionCookie).not.toHaveBeenCalled();
    });

    it('refuses a synced member the gates turn away', async () => {
      vi.mocked(canMemberLogin).mockResolvedValue({ ok: false, reason: 'refused' });

      await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' })).rejects.toMatchObject({
        statusCode: 403,
        body: { message: MEMBER_LOGIN_REFUSED },
      });
      expect(mockSetSessionCookie).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('first-run (no servers) claim code enforcement', () => {
    const newAuthResult = {
      id: 'plex-tv-new',
      username: 'newuser',
      email: 'newuser@example.com',
      thumb: 'https://plex.tv/thumb3.png',
      token: 'plex-token-new',
      tokenKind: 'legacy' as const,
      refreshToken: null,
      expiresAt: null,
    };

    beforeEach(() => {
      vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(newAuthResult);
      // priority 1 (plex_accounts) empty, then the legacy identity lookup empty
      vi.mocked(db.select)
        .mockReturnValueOnce(makeChain([]) as never)
        .mockReturnValueOnce(makeChain([]) as never);
      vi.mocked(getOwnerUser).mockResolvedValue(null);
      vi.mocked(PlexClient.getServers).mockResolvedValue([]);
    });

    it('rejects when a claim code is required and missing', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);

      await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' })).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects when the claim code is required and invalid', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(false);

      await expect(
        callEndpoint('plexCheckPin', { handle: 'handle-1', claimCode: 'WRONG-CODE' })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(validateClaimCode).toHaveBeenCalledWith('WRONG-CODE');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('does not probe the caller-supplied plex servers before the claim gate', async () => {
      // The gate has to run BEFORE getServers/testServerConnections: those
      // reach hosts named by the caller's own plex.tv account, which turns an
      // ownerless instance into a LAN scanner for anyone with a plex account.
      // Asserting only that the guard throws would pass with the gate below
      // the probe, which is the actual bug.
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(false);

      await expect(
        callEndpoint('plexCheckPin', { handle: 'handle-1', claimCode: 'WRONG-CODE' })
      ).rejects.toMatchObject({ statusCode: 403 });

      expect(PlexClient.getServers).not.toHaveBeenCalled();
    });

    it('does not probe when a required claim code is missing entirely', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);

      await expect(callEndpoint('plexCheckPin', { handle: 'handle-1' })).rejects.toMatchObject({
        statusCode: 403,
      });

      expect(PlexClient.getServers).not.toHaveBeenCalled();
    });

    it('proceeds to create the owner when the claim code is valid', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(true);
      mockRedis.del.mockResolvedValue(1);
      vi.mocked(db.insert)
        .mockReturnValueOnce(
          makeChain([{ id: 'user-new', username: 'newuser', role: 'owner' }]) as never
        )
        .mockReturnValueOnce(makeChain([{ id: 'plexacct-new' }]) as never);

      const { result, ctx } = await callEndpoint('plexCheckPin', {
        handle: 'handle-1',
        claimCode: 'ABCD-EFGH-JKLM',
      });

      expect(result.response.authorized).toBe(true);
      expect((result.response.user as { id: string }).id).toBe('user-new');
      expect(ctx.createSession).toHaveBeenCalledWith('user-new');
      expect(mockSetSessionCookie).toHaveBeenCalledTimes(1);
    });
  });

  describe('plexConnect', () => {
    const storedTempData = {
      plexAccountId: 'plex-tv-9',
      plexUsername: 'newowner',
      plexEmail: 'newowner@example.com',
      plexThumb: 'https://plex.tv/thumb2.png',
      plexToken: 'plex-token-9',
    };
    const connectPayload = {
      tempToken: 'temp-abc',
      serverUri: 'http://192.168.1.10:32400',
      serverName: 'My Plex',
    };

    it('rejects connect when an owner already exists (re-checked at connect time)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      vi.mocked(getOwnerUser).mockResolvedValue({ id: 'owner-x', role: 'owner' } as never);

      await expect(callEndpoint('plexConnect', connectPayload)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(db.insert).not.toHaveBeenCalled();
      expect(PlexClient.verifyServerAdmin).not.toHaveBeenCalled();
    });

    it('rejects connect when a claim code is required and missing, before verifyServerAdmin', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      vi.mocked(getOwnerUser).mockResolvedValue(null);

      await expect(callEndpoint('plexConnect', connectPayload)).rejects.toMatchObject({
        statusCode: 403,
      });
      expect(PlexClient.verifyServerAdmin).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects connect when the claim code is required and invalid, before verifyServerAdmin', async () => {
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(false);
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      vi.mocked(getOwnerUser).mockResolvedValue(null);

      await expect(
        callEndpoint('plexConnect', { ...connectPayload, claimCode: 'WRONG-CODE' })
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(validateClaimCode).toHaveBeenCalledWith('WRONG-CODE');
      expect(PlexClient.verifyServerAdmin).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('does not delete the temp token when verifyServerAdmin fails (allows retry)', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      vi.mocked(getOwnerUser).mockResolvedValue(null);
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: PlexClient.AdminVerifyError.CONNECTION_FAILED,
        message: 'Cannot reach Plex server',
      });

      await expect(callEndpoint('plexConnect', connectPayload)).rejects.toMatchObject({
        statusCode: 503,
      });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it("never logs a failed write's parameters, the plex token among them", async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      vi.mocked(getOwnerUser).mockResolvedValue(null);
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true } as never);
      mockGetUsers.mockResolvedValue([{ id: 'plex-local-1', isAdmin: true }]);
      vi.mocked(db.select).mockReturnValueOnce(makeChain([]) as never);
      vi.mocked(db.insert).mockImplementationOnce(() => {
        throw Object.assign(new Error('insert failed'), { params: [storedTempData.plexToken] });
      });
      const ctx = makeCtx();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(callEndpoint('plexConnect', connectPayload, ctx)).rejects.toMatchObject({
        statusCode: 500,
      });
      const logged = JSON.stringify([
        ...ctx.context.logger.error.mock.calls,
        ...consoleError.mock.calls,
      ]);
      consoleError.mockRestore();
      expect(logged).not.toContain(storedTempData.plexToken);
    });

    it('creates the user and server, deletes the temp token, and returns a session on success', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(storedTempData));
      mockRedis.del.mockResolvedValue(1);
      vi.mocked(getOwnerUser).mockResolvedValue(null);
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true } as never);
      mockGetUsers.mockResolvedValue([{ id: 'plex-local-1', isAdmin: true }]);

      vi.mocked(db.select).mockReturnValueOnce(makeChain([]) as never); // no existing server
      vi.mocked(db.insert)
        .mockReturnValueOnce(makeChain([{ id: 'server-1' }]) as never)
        .mockReturnValueOnce(
          makeChain([{ id: 'user-1', username: 'newowner', role: 'owner' }]) as never
        )
        .mockReturnValueOnce(makeChain([{ id: 'plexacct-1' }]) as never);

      const { result, ctx } = await callEndpoint('plexConnect', connectPayload);

      expect(result.response.authorized).toBe(true);
      expect((result.response.user as { id: string }).id).toBe('user-1');
      expect(ctx.createSession).toHaveBeenCalledWith('user-1');
      expect(mockSetSessionCookie).toHaveBeenCalledTimes(1);
      expect(mockRedis.del).toHaveBeenCalledWith(expect.stringContaining('temp-abc'));
    });
  });
});
