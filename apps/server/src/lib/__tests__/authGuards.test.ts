import { describe, it, expect, vi, beforeEach } from 'vitest';

const { oidc, selectResults } = vi.hoisted(() => ({
  oidc: { configured: false },
  selectResults: [] as unknown[][],
}));

vi.mock('../../services/userService.js', () => ({
  getOwnerUser: vi.fn(),
}));
vi.mock('../../services/settings.js', () => ({ getSetting: vi.fn() }));
vi.mock('../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn(),
  validateClaimCode: vi.fn(),
}));
vi.mock('../oidcEnv.js', () => ({
  get oidcConfigured() {
    return oidc.configured;
  },
}));
vi.mock('../../db/client.js', () => ({ db: { select: vi.fn(), update: vi.fn() } }));

import { getOwnerUser } from '../../services/userService.js';
import { getSetting } from '../../services/settings.js';
import { isClaimCodeEnabled, validateClaimCode } from '../../utils/claimCode.js';
import {
  MEMBER_LOGIN_REFUSED,
  MEMBER_NOT_PERMITTED,
  assertSignupAllowed,
  assertClaimCode,
  assertUserCanLogin,
  assertOAuthSignupClaimCode,
  assertOwnerKeepsALoginMethod,
  assertCanBeImpersonated,
  canMemberLogin,
  hasOpenServer,
  nonOwnerMayLogin,
  nonOwnerMayLoginThrough,
  recordSignIn,
  usableLoginMethods,
} from '../authGuards.js';
import { db } from '../../db/client.js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const OWNER = { id: 'owner-1', role: 'owner' };

// Each db.select() resolves the next queued row set, in call order.
function queueSelects(...results: unknown[][]) {
  selectResults.splice(0, selectResults.length, ...results);
  vi.mocked(db.select).mockImplementation(() => {
    const rows = selectResults.shift() ?? [];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return chain as never;
  });
}

function loginMethods(methods: Partial<Record<'local' | 'plex' | 'oidc' | 'member', boolean>>) {
  vi.mocked(getSetting).mockResolvedValue({
    local: true,
    plex: true,
    oidc: true,
    member: true,
    ...methods,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  oidc.configured = false;
});

describe('assertSignupAllowed', () => {
  it('allows signup when no owner exists', async () => {
    vi.mocked(getOwnerUser).mockResolvedValue(null);
    await expect(assertSignupAllowed()).resolves.toBeUndefined();
  });

  it('rejects signup when an owner exists', async () => {
    vi.mocked(getOwnerUser).mockResolvedValue({ id: 'u1', role: 'owner' } as never);
    await expect(assertSignupAllowed()).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });
});

describe('assertClaimCode', () => {
  beforeEach(() => vi.mocked(isClaimCodeEnabled).mockReturnValue(true));

  it('rejects a missing claim code when claim codes are enabled', () => {
    expect(() => assertClaimCode(undefined)).toThrow();
  });

  it('rejects an invalid claim code', () => {
    vi.mocked(validateClaimCode).mockReturnValue(false);
    expect(() => assertClaimCode('bad')).toThrow();
  });

  it('accepts a valid claim code', () => {
    vi.mocked(validateClaimCode).mockReturnValue(true);
    expect(() => assertClaimCode('good')).not.toThrow();
  });

  it('is a no-op when claim codes are disabled', () => {
    vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
    expect(() => assertClaimCode(undefined)).not.toThrow();
  });
});

describe('assertOAuthSignupClaimCode', () => {
  it('is a no-op when an owner already exists, regardless of the code', async () => {
    vi.mocked(getOwnerUser).mockResolvedValue({ id: 'u1', role: 'owner' } as never);
    await expect(assertOAuthSignupClaimCode(undefined)).resolves.toBeUndefined();
    expect(isClaimCodeEnabled).not.toHaveBeenCalled();
  });

  it('rejects an ownerless instance with no claim code when claim codes are enabled', async () => {
    vi.mocked(getOwnerUser).mockResolvedValue(null);
    vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
    await expect(assertOAuthSignupClaimCode(undefined)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('rejects an ownerless instance with an invalid claim code', async () => {
    vi.mocked(getOwnerUser).mockResolvedValue(null);
    vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
    vi.mocked(validateClaimCode).mockReturnValue(false);
    await expect(assertOAuthSignupClaimCode('wrong')).rejects.toMatchObject({
      status: 'FORBIDDEN',
    });
  });

  it('allows an ownerless instance with a valid claim code', async () => {
    vi.mocked(getOwnerUser).mockResolvedValue(null);
    vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
    vi.mocked(validateClaimCode).mockReturnValue(true);
    await expect(assertOAuthSignupClaimCode('right')).resolves.toBeUndefined();
  });

  it('allows an ownerless instance with no code when claim codes are disabled', async () => {
    vi.mocked(getOwnerUser).mockResolvedValue(null);
    vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
    await expect(assertOAuthSignupClaimCode(undefined)).resolves.toBeUndefined();
  });
});

// Every combination of the global switch, a person's own access, their role and the server's
// member switch. allow wins over both switches, block wins over everything, default needs both.
const ACCESS_MATRIX = [true, false].flatMap((memberSwitch) =>
  (['allow', 'block', 'default'] as const).flatMap((loginAccess) =>
    (['admin', 'member'] as const).flatMap((role) =>
      [true, false].map((serverAllows) => ({
        memberSwitch,
        loginAccess,
        role,
        serverAllows,
        identityOk: loginAccess === 'allow' || (loginAccess === 'default' && memberSwitch),
        throughServer:
          loginAccess === 'allow' || (loginAccess === 'default' && memberSwitch && serverAllows),
      }))
    )
  )
);
const IDENTITY_MATRIX = ACCESS_MATRIX.filter((row) => row.serverAllows);

describe('nonOwnerMayLogin', () => {
  it.each(IDENTITY_MATRIX)(
    'switch $memberSwitch, $loginAccess $role: $identityOk',
    ({ memberSwitch, loginAccess, role, identityOk }) => {
      expect(nonOwnerMayLogin({ role, loginAccess }, memberSwitch)).toBe(identityOk);
    }
  );

  it.each(['disabled', 'pending'] as const)('refuses %s even when allowed', (role) => {
    expect(nonOwnerMayLogin({ role, loginAccess: 'allow' }, true)).toBe(false);
  });

  it('refuses an access value it does not know, whatever the switch', () => {
    const unknown = { role: 'member' as const, loginAccess: 'sometimes' as never };
    expect(nonOwnerMayLogin(unknown, true)).toBe(false);
    expect(nonOwnerMayLoginThrough(unknown, true, true)).toBe(false);
  });
});

describe('nonOwnerMayLoginThrough', () => {
  it.each(ACCESS_MATRIX)(
    'switch $memberSwitch, $loginAccess $role, server allows $serverAllows: $throughServer',
    ({ memberSwitch, loginAccess, role, serverAllows, throughServer }) => {
      expect(nonOwnerMayLoginThrough({ role, loginAccess }, memberSwitch, serverAllows)).toBe(
        throughServer
      );
    }
  );
});

describe('assertUserCanLogin', () => {
  it('allows the owner without reading the login methods', async () => {
    queueSelects([{ role: 'owner', loginAccess: 'block' }]);
    await expect(assertUserCanLogin('u1')).resolves.toBeUndefined();
    expect(getSetting).not.toHaveBeenCalled();
  });

  it.each(IDENTITY_MATRIX)(
    'password and SSO: switch $memberSwitch, $loginAccess $role: $identityOk',
    async ({ memberSwitch, loginAccess, role, identityOk }) => {
      loginMethods({ member: memberSwitch });
      queueSelects([{ role, loginAccess }]);
      const result = assertUserCanLogin('u1');
      if (identityOk) await expect(result).resolves.toBeUndefined();
      else {
        await expect(result).rejects.toMatchObject({
          status: 'FORBIDDEN',
          body: { code: 'MEMBER_NOT_PERMITTED', message: MEMBER_NOT_PERMITTED },
        });
      }
    }
  );

  it('tells a disabled identity it is not permitted', async () => {
    loginMethods({});
    queueSelects([{ role: 'disabled', loginAccess: 'allow' }]);
    await expect(assertUserCanLogin('u1')).rejects.toMatchObject({
      body: { message: MEMBER_NOT_PERMITTED },
    });
  });

  it('refuses a missing user row with the plain refusal', async () => {
    queueSelects([]);
    await expect(assertUserCanLogin('deleted-user')).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'MEMBER_LOGIN_REFUSED', message: MEMBER_LOGIN_REFUSED },
    });
  });

  it('propagates a db error (fails closed)', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('connection lost');
    });
    await expect(assertUserCanLogin('u1')).rejects.toThrow('connection lost');
  });
});

describe('recordSignIn', () => {
  it('increments the count and stamps the time in one update per sign-in', async () => {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set } as never);

    await recordSignIn('u1');

    expect(db.update).toHaveBeenCalledOnce();
    const values = set.mock.calls[0]?.[0] as { loginCount: SQL; lastLoginAt: SQL };
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(values.loginCount).sql).toBe('"users"."login_count" + 1');
    expect(dialect.sqlToQuery(values.lastLoginAt).sql).toBe('now()');
  });

  it('does not reject when the write fails', async () => {
    vi.mocked(db.update).mockImplementation(() => {
      throw new Error('connection lost');
    });
    await expect(recordSignIn('u1')).resolves.toBeUndefined();
  });
});

describe('canMemberLogin', () => {
  it('allows the owner with every switch off', async () => {
    loginMethods({ local: false, plex: false, oidc: false, member: false });
    queueSelects([{ role: 'owner', loginAccess: 'block' }]);
    await expect(canMemberLogin('u1', 's1')).resolves.toEqual({ ok: true });
  });

  it.each(ACCESS_MATRIX)(
    'switch $memberSwitch, $loginAccess $role, server allows $serverAllows: $throughServer',
    async ({ memberSwitch, loginAccess, role, serverAllows, throughServer }) => {
      loginMethods({ member: memberSwitch });
      queueSelects([{ role, loginAccess }], [{ serverAllowsMembers: serverAllows }]);
      await expect(canMemberLogin('u1', 's1')).resolves.toEqual(
        throughServer ? { ok: true } : { ok: false, reason: 'not-permitted' }
      );
    }
  );

  it('refuses an allowed person with no live account there (removed, disabled, historical)', async () => {
    loginMethods({});
    queueSelects([{ role: 'member', loginAccess: 'allow' }], []);
    await expect(canMemberLogin('u1', 's1')).resolves.toEqual({ ok: false, reason: 'refused' });
  });

  it('refuses a missing identity plainly', async () => {
    queueSelects([]);
    await expect(canMemberLogin('u1', 's1')).resolves.toEqual({ ok: false, reason: 'refused' });
  });

  it('tells a pending identity it is not permitted', async () => {
    loginMethods({});
    queueSelects([{ role: 'pending', loginAccess: 'allow' }], [{ serverAllowsMembers: true }]);
    await expect(canMemberLogin('u1', 's1')).resolves.toEqual({
      ok: false,
      reason: 'not-permitted',
    });
  });
});

describe('usableLoginMethods', () => {
  // Select order: member-login server, any credential password, then the owner's credential row.
  const creds = (password: boolean, plex: boolean, oidc: boolean) => [{ password, plex, oidc }];

  beforeEach(() => {
    vi.mocked(getOwnerUser).mockResolvedValue(OWNER as never);
  });

  it('reports local unusable when nobody has a credential password', async () => {
    loginMethods({});
    queueSelects([], [], creds(false, true, false));
    expect((await usableLoginMethods()).local).toBe(false);
  });

  it('reports local usable for a Plex-only owner when an admin has a credential password', async () => {
    loginMethods({});
    queueSelects([], [{ id: 'admin-cred' }], creds(false, true, false));
    const usable = await usableLoginMethods();
    expect(usable.local).toBe(true);
    expect(usable.plex).toBe(true);
  });

  it('reports plex unusable when the owner has no Plex login', async () => {
    loginMethods({});
    queueSelects([], [{ id: 'cred' }], creds(true, false, false));
    const usable = await usableLoginMethods();
    expect(usable.plex).toBe(false);
    expect(usable.local).toBe(true);
  });

  it.each([
    { serverAllows: true, memberSwitch: false, member: true },
    { serverAllows: true, memberSwitch: true, member: true },
    { serverAllows: false, memberSwitch: true, member: false },
  ])(
    'member is usable whenever a server allows it: server $serverAllows, switch $memberSwitch',
    async ({ serverAllows, memberSwitch, member }) => {
      loginMethods({ member: memberSwitch });
      queueSelects(
        serverAllows ? [{ id: 'server' }] : [],
        [{ id: 'cred' }],
        creds(true, false, false)
      );
      expect((await usableLoginMethods()).member).toBe(member);
    }
  );

  it('closes media sign-in while single sign-on only is on, whatever the servers allow', async () => {
    vi.mocked(getSetting).mockImplementation(async (key) =>
      key === 'memberSsoOnly'
        ? (true as never)
        : ({ local: true, plex: true, oidc: true, member: true } as never)
    );
    queueSelects([{ id: 'server' }], [{ id: 'cred' }], creds(true, true, false));
    expect(await usableLoginMethods()).toMatchObject({ member: false, local: true, plex: true });

    queueSelects([{ id: 'server' }]);
    await expect(hasOpenServer('plex')).resolves.toBe(false);
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it("ignores the switches for the owner's password and plex when they leave the owner no way in", async () => {
    oidc.configured = false;
    loginMethods({ local: false, plex: false, oidc: true });
    queueSelects([], [{ id: 'cred' }], creds(true, true, true));
    expect(await usableLoginMethods()).toEqual({
      local: true,
      plex: true,
      oidc: false,
      member: false,
    });
  });

  it("the fallback only opens the owner's own password, not another user's", async () => {
    loginMethods({ local: false, plex: false, oidc: false });
    queueSelects([], [{ id: 'admin-cred' }], creds(false, true, false));
    const usable = await usableLoginMethods();
    expect(usable.local).toBe(false);
    expect(usable.plex).toBe(true);
  });

  it('keeps a switch off while another method still lets the owner in', async () => {
    loginMethods({ local: false });
    queueSelects([], [{ id: 'cred' }], creds(true, true, false));
    const usable = await usableLoginMethods();
    expect(usable.local).toBe(false);
    expect(usable.plex).toBe(true);
  });
});

describe('assertOwnerKeepsALoginMethod', () => {
  // One select: the owner's credential row.
  beforeEach(() => {
    vi.mocked(getOwnerUser).mockResolvedValue(OWNER as never);
    loginMethods({});
  });

  it('refuses turning local off when the owner only has a password', async () => {
    queueSelects([{ password: true, plex: false, oidc: false }]);
    await expect(assertOwnerKeepsALoginMethod({ local: false })).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      message: 'That would leave the owner with no way to sign in.',
    });
  });

  it('allows turning local off while plex stays usable', async () => {
    queueSelects([{ password: true, plex: true, oidc: false }]);
    await expect(assertOwnerKeepsALoginMethod({ local: false })).resolves.toBeUndefined();
  });

  it('allows oidc as the only method once the owner has an oidc account', async () => {
    oidc.configured = true;
    queueSelects([{ password: true, plex: true, oidc: true }]);
    await expect(
      assertOwnerKeepsALoginMethod({ local: false, plex: false })
    ).resolves.toBeUndefined();
  });

  it('refuses oidc as the only method before the owner has signed in through it', async () => {
    oidc.configured = true;
    queueSelects([{ password: true, plex: true, oidc: false }]);
    await expect(assertOwnerKeepsALoginMethod({ local: false, plex: false })).rejects.toMatchObject(
      { status: 'BAD_REQUEST' }
    );
  });

  it('never blocks a change that turns nothing off', async () => {
    loginMethods({ local: false, plex: false, oidc: false });
    queueSelects([{ password: false, plex: false, oidc: false }]);
    await expect(assertOwnerKeepsALoginMethod({ local: true })).resolves.toBeUndefined();
  });
});

describe('assertCanBeImpersonated', () => {
  it('allows a member whatever the login gates say', async () => {
    loginMethods({ member: false });
    queueSelects([{ role: 'member', loginAccess: 'default' }]);
    await expect(assertCanBeImpersonated('u1')).resolves.toBeUndefined();
    expect(getSetting).not.toHaveBeenCalled();
  });

  it('refuses a pending identity with the fixed message', async () => {
    queueSelects([{ role: 'pending', loginAccess: 'allow' }]);
    await expect(assertCanBeImpersonated('u1')).rejects.toMatchObject({
      status: 'FORBIDDEN',
      message: MEMBER_LOGIN_REFUSED,
    });
  });

  it('refuses the owner', async () => {
    queueSelects([{ role: 'owner', loginAccess: 'default' }]);
    await expect(assertCanBeImpersonated('u1')).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });
});
