/**
 * Regression test for the admin plugin's `roles` configuration.
 *
 * better-auth's admin plugin validates `adminRoles` against a `roles` map
 * that defaults to `{ admin, user }`; declaring a custom admin role name
 * (e.g. 'owner') without also declaring it in `roles` throws a
 * BetterAuthError at construction time - every other test in this repo
 * mocks getAuth() entirely, so none of them would ever catch this. This
 * test builds the real (unmocked) Better Auth instance to catch it.
 *
 * Also covers the OIDC-configured variant: `oidcConfigured` is read from
 * OIDC_ISSUER_URL/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET at module scope, so that
 * test sets the env vars, resets the module registry, and dynamically
 * imports auth.js to force it to re-evaluate with genericOAuth included -
 * two real plugins together can hit a runtime validator that neither hits
 * alone.
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../memberLogin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memberLogin.js')>()),
  memberStillValid: vi.fn(),
}));
vi.mock('../revoke.js', () => ({ logoutMemberTokens: vi.fn(), revokeSessionsForUsers: vi.fn() }));

import { db } from '../../db/client.js';
import { resetSettingsCache } from '../../services/settings.js';
import { MEMBER_LOGIN_REFUSED, MEMBER_NOT_PERMITTED } from '../authGuards.js';
import { getAuth, closeAuth } from '../auth.js';
import { memberStillValid } from '../memberLogin.js';
import { revokeSessionsForUsers } from '../revoke.js';

// Each db.select() resolves the next queued row set, in call order.
function queueSelects(...results: unknown[][]) {
  return vi.spyOn(db, 'select').mockImplementation((() => {
    const rows = results.shift() ?? [];
    const chain = { from: () => chain, where: () => chain, limit: () => Promise.resolve(rows) };
    return chain;
  }) as never);
}

function sessionHooks() {
  const create = getAuth().options.databaseHooks?.session?.create;
  if (!create?.before || !create.after) throw new Error('session create hooks missing');
  return { before: create.before, after: create.after };
}

const session = (extra: Record<string, unknown> = {}) =>
  ({
    id: 's1',
    userId: 'member-1',
    token: 't',
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  }) as never;

describe('impersonation sessions', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    resetSettingsCache();
    await closeAuth();
  });

  it('skips the login gate for a member the gates would refuse', async () => {
    const { before } = sessionHooks();
    const memberOff = [{ value: { local: true, plex: true, oidc: true, member: false } }];

    queueSelects([{ role: 'member', loginAccess: 'default' }], memberOff);
    await expect(before(session(), null)).rejects.toMatchObject({ message: MEMBER_NOT_PERMITTED });

    queueSelects([{ role: 'member', loginAccess: 'default' }], memberOff);
    await expect(before(session({ impersonatedBy: 'owner-1' }), null)).resolves.toMatchObject({
      data: { userId: 'member-1' },
    });
  });

  it('refuses a pending target', async () => {
    const { before } = sessionHooks();
    queueSelects([{ role: 'pending', loginAccess: 'allow' }]);
    await expect(before(session({ impersonatedBy: 'owner-1' }), null)).rejects.toMatchObject({
      status: 'FORBIDDEN',
      message: MEMBER_LOGIN_REFUSED,
    });
  });

  it('does not count an impersonation as a sign-in', async () => {
    const { after } = sessionHooks();
    const update = vi.spyOn(db, 'update').mockReturnValue({
      set: () => ({ where: () => Promise.resolve() }),
    } as never);

    await after(session({ impersonatedBy: 'owner-1' }));
    expect(update).not.toHaveBeenCalled();

    await after(session());
    expect(update).toHaveBeenCalledOnce();
  });
});

describe('better-auth writes while viewing as another user', () => {
  // A session cookie signed the way better-call verifies it, so the hook reads it for real.
  const signed = (value: string) =>
    encodeURIComponent(`${value}.${createHmac('sha256', 'secret').update(value).digest('base64')}`);

  function post(
    path: string,
    impersonatedBy?: string,
    { role = 'owner', bearer = false, method = 'POST' } = {}
  ) {
    return getAuth().options.hooks?.before?.({
      path,
      body: {},
      headers: new Headers(
        bearer
          ? { authorization: 'Bearer session-token' }
          : { cookie: `session_token=${signed('session-token')}` }
      ),
      request: new Request('http://tracearr.local/api/v1/auth' + path, { method }),
      context: {
        secret: 'secret',
        authCookies: { sessionToken: { name: 'session_token' } },
        internalAdapter: {
          findSession: () =>
            Promise.resolve({ session: { impersonatedBy }, user: { id: 'member-1', role } }),
        },
      },
    } as never);
  }

  it('refuses a write made through the masquerade', async () => {
    await expect(post('/sign-in/social', 'owner-1')).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { message: 'Viewing as another user is read-only' },
    });
    await expect(post('/revoke-sessions', 'owner-1')).rejects.toMatchObject({
      status: 'NOT_FOUND',
    });
  });

  it('refuses every request a masquerade makes with a bearer token, reads included', async () => {
    await expect(
      post('/get-session', 'owner-1', { bearer: true, method: 'GET' })
    ).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { message: 'Viewing as another user needs a browser session.' },
    });
    await expect(post('/get-session', undefined, { bearer: true, method: 'GET' })).resolves.toBe(
      undefined
    );
  });

  it.each([
    ['the bearer token', 'bearer-token'],
    ['the cookie', 'session-token'],
  ])(
    'refuses an owner cookie and a bearer token together when %s is a view-as session',
    async (_label, viewAs) => {
      const find = (token: string) =>
        Promise.resolve({
          session: { impersonatedBy: token === viewAs ? 'owner-1' : undefined },
          user: {
            id: token === viewAs ? 'member-1' : 'owner-1',
            role: token === viewAs ? 'member' : 'owner',
          },
        });
      const run = getAuth().options.hooks?.before?.({
        path: '/get-session',
        body: {},
        headers: new Headers({
          cookie: `session_token=${signed('session-token')}`,
          authorization: 'Bearer bearer-token',
        }),
        request: new Request('http://tracearr.local/api/v1/auth/get-session', { method: 'GET' }),
        context: {
          secret: 'secret',
          authCookies: { sessionToken: { name: 'session_token' } },
          internalAdapter: { findSession: find },
        },
      } as never);
      await expect(run).rejects.toMatchObject({
        status: 'FORBIDDEN',
        body: { message: 'Viewing as another user needs a browser session.' },
      });
    }
  );

  it.each([
    '/list-sessions',
    '/revoke-session',
    '/revoke-sessions',
    '/revoke-other-sessions',
    '/update-user',
    '/change-email',
    '/change-password',
    '/is-username-available',
  ])('keeps %s to the owner', async (path) => {
    for (const role of ['admin', 'member']) {
      await expect(post(path, undefined, { role })).rejects.toMatchObject({
        status: 'NOT_FOUND',
      });
    }
    await expect(post(path, 'owner-1', { role: 'member' })).rejects.toMatchObject({
      status: 'NOT_FOUND',
    });
    await expect(post(path)).resolves.toBeUndefined();
  });

  it('still lets the owner stop viewing as the member', async () => {
    await expect(post('/admin/stop-impersonating', 'owner-1')).resolves.toBeUndefined();
  });

  it('leaves an ordinary session free to write', async () => {
    await expect(post('/update-user')).resolves.toBeUndefined();
  });

  it('lets only the masquerade through the admin plugin', async () => {
    for (const path of ['/admin/ban-user', '/admin/update-user', '/admin/set-role']) {
      await expect(post(path)).rejects.toMatchObject({
        status: 'FORBIDDEN',
        body: { message: 'Manage people from the user page.' },
      });
    }
    await expect(post('/admin/impersonate-user')).resolves.toBeUndefined();
    await expect(post('/admin/stop-impersonating', 'owner-1')).resolves.toBeUndefined();
  });
});

describe('session listings', () => {
  afterEach(async () => {
    await closeAuth();
  });

  it('never hands out a session token', async () => {
    const after = getAuth().options.hooks?.after;
    if (!after) throw new Error('after hook missing');
    const listed = await after({
      path: '/list-sessions',
      json: (value: unknown) => value,
      context: { returned: [{ id: 's1', token: 'live-token', userId: 'owner-1' }] },
    } as never);
    expect(listed).toEqual([{ id: 's1', userId: 'owner-1' }]);
  });
});

describe('daily session refresh', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await closeAuth();
  });

  function refresh(current: Record<string, unknown>) {
    const before = getAuth().options.databaseHooks?.session?.update?.before;
    if (!before) throw new Error('session update hook missing');
    return before({}, { context: { session: { session: current } } } as never);
  }

  it('never extends an impersonated session or revalidates it against the media server', async () => {
    const expiresAt = new Date('2026-10-10T12:00:00Z');
    await expect(
      refresh({ userId: 'member-1', impersonatedBy: 'owner-1', expiresAt })
    ).resolves.toEqual({ data: { expiresAt } });
    expect(memberStillValid).not.toHaveBeenCalled();
  });

  it('keeps a session the media server still vouches for', async () => {
    vi.mocked(memberStillValid).mockResolvedValue(true);
    await expect(refresh({ userId: 'member-1' })).resolves.toBe(undefined);
    expect(revokeSessionsForUsers).not.toHaveBeenCalled();
  });

  it('revokes and refuses the refresh when the member is no longer valid', async () => {
    vi.mocked(memberStillValid).mockResolvedValue(false);
    await expect(refresh({ userId: 'member-1' })).resolves.toBe(false);
    expect(revokeSessionsForUsers).toHaveBeenCalledWith(['member-1']);
  });
});

describe('getAuth construction', () => {
  afterEach(async () => {
    await closeAuth();
  });

  it('constructs the real auth instance without throwing', () => {
    expect(() => getAuth()).not.toThrow();
  });

  it('registers the expected plugins', () => {
    const auth = getAuth();
    const pluginIds = auth.options.plugins?.map((p) => p.id);
    expect(pluginIds).toEqual(['username', 'admin', 'bearer', 'plex', 'member-login']);
  });

  it('counts a sign-in when a session is created, never when one is refreshed', () => {
    const hooks = getAuth().options.databaseHooks?.session;
    expect(hooks?.create?.after).toBeTypeOf('function');
    expect(hooks?.update).not.toHaveProperty('after');
  });

  it('resolves the client ip only from the shim-stamped header', () => {
    const auth = getAuth();
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual(['x-tracearr-client-ip']);
    // Sibling advanced option must survive the ipAddress addition: without a
    // function generateId, Better Auth mints nanoids that the uuid users.id
    // column rejects (22P02).
    expect(auth.options.advanced?.database?.generateId).toBeTypeOf('function');
  });

  it('exposes the atomic secondary storage operations', () => {
    // better-auth 1.6.23 builds an atomic rate-limit consume only when
    // increment exists, and consumes single-use verification values
    // atomically only when getAndDelete exists; without them it warns and
    // falls back to non-atomic paths. Behavior is covered by
    // betterAuthStorageAtomicity.integration.test.ts against real Redis.
    const storage = getAuth().options.secondaryStorage;
    expect(storage?.increment).toBeTypeOf('function');
    expect(storage?.getAndDelete).toBeTypeOf('function');
  });

  it('constructs the real auth instance with OIDC configured, alongside the default plugins', async () => {
    process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
    process.env.OIDC_CLIENT_ID = 'test-client';
    process.env.OIDC_CLIENT_SECRET = 'test-secret';
    vi.resetModules();

    try {
      const { getAuth: getOidcAuth, closeAuth: closeOidcAuth } = await import('../auth.js');

      expect(() => getOidcAuth()).not.toThrow();

      const auth = getOidcAuth();
      const plugins = auth.options.plugins ?? [];
      const pluginIds = plugins.map((p) => p.id);
      expect(pluginIds).toEqual([
        'username',
        'admin',
        'bearer',
        'plex',
        'member-login',
        'generic-oauth',
      ]);
      // Forbidden plugins must never appear, regardless of OIDC config.
      for (const forbidden of ['api-key', 'sso', 'oidc-provider', 'scim']) {
        expect(pluginIds).not.toContain(forbidden);
      }

      const genericOAuthPlugin = plugins.find((p) => p.id === 'generic-oauth') as unknown as {
        options: { config: Array<Record<string, unknown>> };
      };
      expect(genericOAuthPlugin.options.config).toEqual([
        {
          providerId: 'oidc',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          discoveryUrl: 'https://auth.example.com/.well-known/openid-configuration',
          scopes: ['openid', 'email', 'profile'],
          pkce: true,
          disableProviderLogout: true,
          mapProfileToUser: expect.any(Function),
        },
      ]);

      // toEqual pins the whole object: dropping trustedProviders breaks OIDC
      // linking on Authentik and Keycloak, so the value is load-bearing.
      expect(auth.options.account?.accountLinking).toEqual({
        enabled: true,
        trustedProviders: ['oidc'],
      });

      await closeOidcAuth();
    } finally {
      delete process.env.OIDC_ISSUER_URL;
      delete process.env.OIDC_CLIENT_ID;
      delete process.env.OIDC_CLIENT_SECRET;
      vi.resetModules();
    }
  });

  describe('OIDC provider missing after init', () => {
    const discoveryDoc = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      jwks_uri: 'https://auth.example.com/jwks',
      id_token_signing_alg_values_supported: ['RS256'],
    };
    const FIXED_MESSAGE = 'The sign-in provider could not be reached. Try again in a moment.';

    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env.OIDC_ISSUER_URL;
      delete process.env.OIDC_CLIENT_ID;
      delete process.env.OIDC_CLIENT_SECRET;
      vi.resetModules();
    });

    async function setup(fetchImpl: () => Promise<Response>) {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'test-client';
      process.env.OIDC_CLIENT_SECRET = 'test-secret';
      const fetchMock = vi.fn(fetchImpl);
      vi.stubGlobal('fetch', fetchMock);
      vi.resetModules();
      const mod = await import('../auth.js');
      const first = mod.getAuth();
      const trigger = () =>
        first.options.hooks?.before?.({
          path: '/sign-in/social',
          body: { provider: 'oidc' },
          context: { socialProviders: [] },
        } as never);
      const settle = () => new Promise((r) => setTimeout(r, 50));
      return { mod, first, trigger, fetchMock, settle };
    }

    const okResponse = () => Promise.resolve(Response.json(discoveryDoc));

    it('answers 503 and keeps serving the same instance synchronously', async () => {
      const { mod, first, trigger, settle } = await setup(() => Promise.reject(new Error('down')));

      await expect(trigger()).rejects.toMatchObject({
        status: 'SERVICE_UNAVAILABLE',
        body: { message: FIXED_MESSAGE },
      });
      expect(mod.getAuth()).toBe(first);

      await settle();
      await mod.closeAuth();
    });

    it('starts one rebuild for concurrent triggers', async () => {
      const { mod, trigger, fetchMock, settle } = await setup(okResponse);

      await settle();
      const initCalls = fetchMock.mock.calls.length;

      await Promise.allSettled([trigger(), trigger(), trigger()]);
      await settle();

      // one probe plus one discovery fetch inside the candidate's init
      expect(fetchMock.mock.calls.length - initCalls).toBe(2);
      await mod.closeAuth();
    });

    it('swaps to the candidate only when it has the oidc provider', async () => {
      const ok = await setup(okResponse);
      await Promise.allSettled([ok.trigger()]);
      await ok.settle();
      expect(ok.mod.getAuth()).not.toBe(ok.first);
      const swapped = await ok.mod.getAuth().$context;
      expect(swapped.socialProviders.find((p) => p.id === 'oidc')?.callbackPath).toBe(
        '/oauth2/callback/oidc'
      );
      await ok.mod.closeAuth();
      vi.unstubAllGlobals();

      // probe succeeds, the candidate's own discovery fails
      let calls = 0;
      const bad = await setup(() =>
        ++calls === 1 ? okResponse() : Promise.reject(new Error('down'))
      );
      await Promise.allSettled([bad.trigger()]);
      await bad.settle();
      expect(bad.mod.getAuth()).toBe(bad.first);
      await bad.mod.closeAuth();
    });
  });

  describe('OIDC at startup and for new users', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env.OIDC_ISSUER_URL;
      delete process.env.OIDC_CLIENT_ID;
      delete process.env.OIDC_CLIENT_SECRET;
      vi.resetModules();
    });

    it('builds the first instance without the oidc plugin when the startup probe fails', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'test-client';
      process.env.OIDC_CLIENT_SECRET = 'test-secret';
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
      vi.resetModules();
      const mod = await import('../auth.js');

      await mod.probeOidcAtStartup();

      expect(mod.getAuth().options.plugins?.map((p) => p.id)).not.toContain('generic-oauth');
      await mod.closeAuth();
    });

    it('derives a username from preferred_username, then the email local part, then a fixed name', async () => {
      const { oidcUsername } = await import('../auth.js');
      expect(oidcUsername({ preferred_username: 'connor', email: 'c@example.com' })).toBe('connor');
      expect(oidcUsername({ preferred_username: 'verify-owner' })).toBe('verify_owner');
      expect(oidcUsername({ preferred_username: 'a@b+c' })).toBe('a_b_c');
      expect(oidcUsername({ preferred_username: 'ab', email: 'c.g@example.com' })).toBe('c.g');
      expect(oidcUsername({ preferred_username: 'x'.repeat(40) })).toBe('x'.repeat(30));
      expect(oidcUsername({ email: 'first+tag@example.com' })).toBe('first_tag');
      expect(oidcUsername({ preferred_username: 'ab', email: 'x@example.com' })).toBe('owner');
      expect(oidcUsername({})).toBe('owner');
    });
  });
});
