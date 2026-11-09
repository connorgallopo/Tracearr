/**
 * Setup routes unit tests
 *
 * Tests the API endpoint for checking Tracearr configuration status:
 * - GET /status - Check if setup is needed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

// Mock the database module before importing routes
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

// Mock the claim code module
vi.mock('../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn().mockReturnValue(false), // Default to disabled
}));

vi.mock('../../lib/authGuards.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usableLoginMethods: vi.fn(),
  mediaSignInClosed: vi.fn(),
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  JellyfinClient: { quickConnectEnabled: vi.fn().mockResolvedValue(true) },
}));

// Import the mocked modules and the routes
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { isClaimCodeEnabled } from '../../utils/claimCode.js';
import { mediaSignInClosed, usableLoginMethods } from '../../lib/authGuards.js';
import { JellyfinClient } from '../../services/mediaServer/index.js';
import { setupRoutes } from '../setup.js';

/**
 * Helper to mock db.select with multiple chained calls
 * Setup route uses Promise.all with 4 parallel queries:
 * 1. All servers
 * 2. Jellyfin servers (where type = 'jellyfin')
 * 3. Owners (where role = 'owner')
 * 4. Password users (where passwordHash is not null)
 * then, only when member login is usable, the member-login servers (ordered).
 * Returns the where conditions in call order.
 */
function mockDbSelectMultiple(results: unknown[][]): SQL[] {
  let callIndex = 0;
  const conditions: SQL[] = [];
  const next = () => Promise.resolve(results[callIndex++] || []);
  const createChain = () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation((condition: SQL) => {
        conditions.push(condition);
        return chain;
      }),
      limit: vi.fn().mockImplementation(next),
      orderBy: vi.fn().mockImplementation(next),
    };
    return chain;
  };

  vi.mocked(db.select).mockImplementation(() => createChain() as never);
  return conditions;
}

function usable(methods: Partial<Record<'local' | 'plex' | 'oidc' | 'member', boolean>>) {
  vi.mocked(usableLoginMethods).mockResolvedValue({
    local: true,
    plex: true,
    oidc: false,
    member: false,
    ...methods,
  });
}

/**
 * Build a test Fastify instance
 * Note: Setup routes are public (no auth required)
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers
  await app.register(sensible);

  // Register routes
  await app.register(setupRoutes, { prefix: '/setup' });

  return app;
}

describe('Setup Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset isClaimCodeEnabled to default (false)
    vi.mocked(isClaimCodeEnabled).mockReturnValue(false);
    vi.mocked(mediaSignInClosed).mockResolvedValue(false);
    usable({});
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('GET /setup/status', () => {
    it('returns needsSetup true when no owners exist', async () => {
      app = await buildTestApp();

      // Mock: servers exist, no jellyfin servers, no owners, no password users
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [], // jellyfin servers query
        [], // owners query (empty = needs setup)
        [], // password users query
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        requiresClaimCode: false, // Claim code disabled by default in tests
        hasServers: true,
        hasJellyfinServers: false,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: true,
          oidc: false,
          oidcProviderName: null,
          member: false,
          ssoOnly: false,
        },
        memberLoginServers: [],
      });
    });

    it('returns requiresClaimCode true when claim code enabled and setup needed', async () => {
      app = await buildTestApp();

      // Enable claim code for this test
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);

      // Mock: no owners (needs setup)
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [], // jellyfin servers query
        [], // owners query (empty = needs setup)
        [], // password users query
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        requiresClaimCode: true, // Claim code enabled and setup needed
        hasServers: true,
        hasJellyfinServers: false,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: true,
          oidc: false,
          oidcProviderName: null,
          member: false,
          ssoOnly: false,
        },
        memberLoginServers: [],
      });
    });

    it('returns needsSetup false when owner exists', async () => {
      app = await buildTestApp();

      // Mock: servers exist, jellyfin servers exist, owner exists, password user exists
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [{ id: 'server-1' }], // jellyfin servers query
        [{ id: 'user-1' }], // owners query (has owner)
        [{ id: 'user-1' }], // password users query
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        requiresClaimCode: false,
        hasServers: true,
        hasJellyfinServers: true,
        hasPasswordAuth: true,
        authMethods: {
          local: true,
          plex: true,
          oidc: false,
          oidcProviderName: null,
          member: false,
          ssoOnly: false,
        },
        memberLoginServers: [],
      });
    });

    it('returns hasServers false when no servers configured', async () => {
      app = await buildTestApp();

      // Mock: no servers, no jellyfin servers, no owners, no password users
      mockDbSelectMultiple([
        [], // servers query (empty)
        [], // jellyfin servers query
        [], // owners query
        [], // password users query
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        requiresClaimCode: false, // Claim code disabled by default in tests
        hasServers: false,
        hasJellyfinServers: false,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: true,
          oidc: false,
          oidcProviderName: null,
          member: false,
          ssoOnly: false,
        },
        memberLoginServers: [],
      });
    });

    it('returns hasPasswordAuth true when user has password set', async () => {
      app = await buildTestApp();

      // Mock: no servers, no jellyfin servers, owner exists, password user exists
      mockDbSelectMultiple([
        [], // servers query
        [], // jellyfin servers query
        [{ id: 'user-1' }], // owners query
        [{ id: 'user-1' }], // password users query (has password)
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        requiresClaimCode: false,
        hasServers: false,
        hasJellyfinServers: false,
        hasPasswordAuth: true,
        authMethods: {
          local: true,
          plex: true,
          oidc: false,
          oidcProviderName: null,
          member: false,
          ssoOnly: false,
        },
        memberLoginServers: [],
      });
    });

    it('returns hasPasswordAuth false when no users have passwords', async () => {
      app = await buildTestApp();

      // Mock: servers exist, jellyfin servers exist, owner exists, no password users
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [{ id: 'server-1' }], // jellyfin servers query
        [{ id: 'user-1' }], // owners query
        [], // password users query (empty)
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        requiresClaimCode: false,
        hasServers: true,
        hasJellyfinServers: true,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: true,
          oidc: false,
          oidcProviderName: null,
          member: false,
          ssoOnly: false,
        },
        memberLoginServers: [],
      });
    });

    it('handles fresh installation state correctly', async () => {
      app = await buildTestApp();

      // Mock: completely empty database
      mockDbSelectMultiple([
        [], // no servers
        [], // no jellyfin servers
        [], // no owners
        [], // no password users
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        requiresClaimCode: false, // Claim code disabled by default in tests
        hasServers: false,
        hasJellyfinServers: false,
        hasPasswordAuth: false,
        authMethods: {
          local: true,
          plex: true,
          oidc: false,
          oidcProviderName: null,
          member: false,
          ssoOnly: false,
        },
        memberLoginServers: [],
      });
    });

    it('handles fully configured state correctly', async () => {
      app = await buildTestApp();

      // Mock: fully configured installation
      mockDbSelectMultiple([
        [{ id: 'server-1' }, { id: 'server-2' }], // multiple servers
        [{ id: 'server-1' }], // jellyfin servers
        [{ id: 'owner-1' }], // owner exists
        [{ id: 'owner-1' }, { id: 'user-2' }], // multiple password users
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        requiresClaimCode: false,
        hasServers: true,
        hasJellyfinServers: true,
        hasPasswordAuth: true,
        authMethods: {
          local: true,
          plex: true,
          oidc: false,
          oidcProviderName: null,
          member: false,
          ssoOnly: false,
        },
        memberLoginServers: [],
      });
    });

    it('reports only the usable methods once an owner exists', async () => {
      app = await buildTestApp();
      usable({ local: false, plex: true, oidc: true, member: false });
      mockDbSelectMultiple([[{ id: 'server-1' }], [], [{ id: 'owner-1' }], []]);

      const response = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(response.json().authMethods).toEqual({
        local: false,
        plex: true,
        oidc: true,
        oidcProviderName: 'SSO',
        member: false,
        ssoOnly: false,
      });
      expect(db.select).toHaveBeenCalledTimes(4);
    });

    it('offers only SSO while single sign-on only is on, and everything usable with ?all', async () => {
      app = await buildTestApp();
      vi.mocked(mediaSignInClosed).mockResolvedValue(true);
      usable({ local: true, plex: true, oidc: true, member: false });
      const owner = [[{ id: 'server-1' }], [], [{ id: 'owner-1' }], []];
      mockDbSelectMultiple(owner);

      const hidden = await app.inject({ method: 'GET', url: '/setup/status' });
      expect(hidden.json().authMethods).toMatchObject({
        local: false,
        plex: false,
        oidc: true,
        member: false,
        ssoOnly: true,
      });
      expect(hidden.json().memberLoginServers).toEqual([]);

      mockDbSelectMultiple(owner);
      const all = await app.inject({ method: 'GET', url: '/setup/status?all' });
      expect(all.json().authMethods).toMatchObject({
        local: true,
        plex: true,
        oidc: true,
        member: false,
        ssoOnly: false,
      });
      expect(all.json().memberLoginServers).toEqual([]);
      expect(db.select).toHaveBeenCalledTimes(8);
    });

    it('hides nothing behind single sign-on only while SSO is not usable', async () => {
      app = await buildTestApp();
      vi.mocked(mediaSignInClosed).mockResolvedValue(true);
      usable({ local: true, plex: true, oidc: false, member: false });
      mockDbSelectMultiple([[{ id: 'server-1' }], [], [{ id: 'owner-1' }], []]);

      const response = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(response.json().authMethods).toMatchObject({
        local: true,
        plex: true,
        ssoOnly: false,
      });
    });

    it('keeps local and plex open before an owner exists', async () => {
      app = await buildTestApp();
      usable({ local: false, plex: false });
      mockDbSelectMultiple([[], [], [], []]);

      const response = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(response.json().authMethods).toMatchObject({ local: true, plex: true });
    });

    it('lists member-login servers that have the flag on and are not historical', async () => {
      app = await buildTestApp();
      usable({ member: true });
      const servers = [
        { id: 'server-1', name: 'Home', type: 'jellyfin', url: 'http://home:8096' },
        { id: 'server-2', name: 'Cabin', type: 'plex', url: 'http://cabin:32400' },
      ];
      const conditions = mockDbSelectMultiple([
        [{ id: 'server-1' }],
        [],
        [{ id: 'owner-1' }],
        [],
        servers,
      ]);

      const response = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(response.json().authMethods.member).toBe(true);
      expect(response.json().memberLoginServers).toEqual([
        { id: 'server-1', name: 'Home', type: 'jellyfin', quickConnect: true },
        { id: 'server-2', name: 'Cabin', type: 'plex', quickConnect: false },
      ]);
      expect(JellyfinClient.quickConnectEnabled).toHaveBeenCalledExactlyOnceWith(
        'http://home:8096'
      );
      const memberCondition = conditions.at(-1);
      if (!memberCondition) throw new Error('member-login server query was not issued');
      const { sql } = new PgDialect().sqlToQuery(memberCondition);
      expect(sql).toContain('"servers"."allow_member_login" = $1');
      expect(sql).toContain('"servers"."historical_at" is null');
    });

    it.each(['?all', '?all=1', '?all=true'])(
      'lists every server someone could sign in through with %s',
      async (query) => {
        app = await buildTestApp();
        usable({ member: false });
        const servers = [
          { id: 'server-1', name: 'Home', type: 'jellyfin', url: 'http://home:8096' },
          { id: 'server-3', name: 'Attic', type: 'emby', url: 'http://attic:8096' },
        ];
        const conditions = mockDbSelectMultiple([
          [{ id: 'server-1' }],
          [],
          [{ id: 'owner-1' }],
          [],
          servers,
        ]);

        const response = await app.inject({ method: 'GET', url: `/setup/status${query}` });

        expect(response.statusCode).toBe(200);
        expect(response.json().authMethods.member).toBe(true);
        expect(response.json().memberLoginServers).toEqual([
          { id: 'server-1', name: 'Home', type: 'jellyfin', quickConnect: true },
          { id: 'server-3', name: 'Attic', type: 'emby', quickConnect: false },
        ]);
        const memberCondition = conditions.at(-1);
        if (!memberCondition) throw new Error('member-login server query was not issued');
        const { sql } = new PgDialect().sqlToQuery(memberCondition);
        expect(sql).toContain('"servers"."historical_at" is null');
        expect(sql).toContain('"servers"."allow_member_login"');
        expect(sql).toContain(`"users"."login_access" = 'allow'`);
        expect(sql).toContain('"server_users"."is_disabled" = $');
      }
    );

    it('lists no member servers without ?all while member sign-in is not usable', async () => {
      app = await buildTestApp();
      usable({ member: false });
      mockDbSelectMultiple([[{ id: 'server-1' }], [], [{ id: 'owner-1' }], []]);

      const response = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(response.json().authMethods.member).toBe(false);
      expect(response.json().memberLoginServers).toEqual([]);
      expect(db.select).toHaveBeenCalledTimes(4);
    });

    it('refuses an all value it does not know', async () => {
      app = await buildTestApp();
      mockDbSelectMultiple([]);

      const response = await app.inject({ method: 'GET', url: '/setup/status?all=maybe' });

      expect(response.statusCode).toBe(400);
    });

    it('asks each Jellyfin server about Quick Connect at most once a minute', async () => {
      app = await buildTestApp();
      usable({ member: true });
      const status = [[{ id: 'server-1' }], [], [{ id: 'owner-1' }], []];
      const servers = [{ id: 'server-9', name: 'Den', type: 'jellyfin', url: 'http://den:8096' }];
      mockDbSelectMultiple([...status, servers, ...status, servers]);

      await app.inject({ method: 'GET', url: '/setup/status' });
      const second = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(second.json().memberLoginServers).toEqual([
        { id: 'server-9', name: 'Den', type: 'jellyfin', quickConnect: true },
      ]);
      expect(JellyfinClient.quickConnectEnabled).toHaveBeenCalledExactlyOnceWith('http://den:8096');
    });
  });
});
