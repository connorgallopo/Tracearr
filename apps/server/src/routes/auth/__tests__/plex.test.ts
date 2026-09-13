/**
 * Plex auth routes tests
 *
 * Tests the API endpoints for Plex server discovery and connection:
 * - GET /plex/available-servers - Discover available Plex servers
 * - POST /plex/add-server - Add an additional Plex server
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock dependencies before imports
vi.mock('../../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../../services/plexAccounts.js', () => ({
  reconcilePlexAccountToken: vi.fn(),
}));

vi.mock('../../../services/sseManager.js', () => ({
  sseManager: {
    removeServer: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../utils/crypto.js', () => ({
  encrypt: vi.fn((token: string) => `encrypted_${token}`),
  decrypt: vi.fn((token: string) => token.replace('encrypted_', '')),
}));

// Hoisted so a top-level beforeEach can re-establish defaults after
// vi.resetAllMocks() (which wipes implementations as well as call history).
// vi.hoisted() is required because vi.mock factories run before module-level
// const declarations — without it, the factories would capture `undefined`.
const { mockGetUsers, mockGetAllServerIds } = vi.hoisted(() => ({
  mockGetUsers: vi.fn(),
  mockGetAllServerIds: vi.fn(),
}));

vi.mock('../../../services/mediaServer/index.js', () => {
  class MockPlexClient {
    getUsers = mockGetUsers;
  }

  return {
    PlexClient: Object.assign(MockPlexClient, {
      getServers: vi.fn(),
      verifyServerAdmin: vi.fn(),
      checkOAuthPin: vi.fn(),
      AdminVerifyError: {
        CONNECTION_FAILED: 'CONNECTION_FAILED',
        NOT_ADMIN: 'NOT_ADMIN',
      },
    }),
  };
});

vi.mock('../../../services/sync.js', () => ({
  syncServer: vi.fn(),
}));

vi.mock('../../../services/userService.js', () => ({
  getUserById: vi.fn(),
  getOwnerUser: vi.fn(),
  getUserByPlexAccountId: vi.fn(),
}));

vi.mock('../../../utils/claimCode.js', () => ({
  isClaimCodeEnabled: vi.fn(),
  validateClaimCode: vi.fn(),
}));

vi.mock('../../../services/serverService.js', () => ({
  getAllServerIds: mockGetAllServerIds,
}));

// Import mocked modules
import { db } from '../../../db/client.js';
import { getUserById } from '../../../services/userService.js';
import { PlexClient } from '../../../services/mediaServer/index.js';
import { syncServer } from '../../../services/sync.js';
import { reconcilePlexAccountToken } from '../../../services/plexAccounts.js';
import { sseManager } from '../../../services/sseManager.js';
import { isClaimCodeEnabled, validateClaimCode } from '../../../utils/claimCode.js';
import { plexRoutes } from '../plex.js';

// Mock global fetch for connection testing
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock Redis client for unauthenticated endpoints
const mockRedis = {
  get: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
};

// Helper to create DB chain mocks (prefixed with _ as they're utility functions for future tests)
function _mockDbSelectWhere(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

// For queries that end with .limit()
function _mockDbSelectLimit(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

// Export to prevent unused warnings while keeping them available
void _mockDbSelectWhere;
void _mockDbSelectLimit;

function mockDbInsert(result: unknown[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  // Mock authenticate
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });

  await app.register(plexRoutes);
  return app;
}

async function buildUnauthenticatedTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cookie, { secret: 'test-cookie-secret' });
  await app.register(jwt, {
    secret: 'test-jwt-secret-must-be-32-chars-minimum',
    sign: { algorithm: 'HS256' },
  });

  // Mock authenticate (required even though unauthenticated endpoints don't use it)
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = ownerUser;
  });

  // Decorate app with mock Redis
  app.decorate('redis', mockRedis as any);

  await app.register(plexRoutes);
  return app;
}

const ownerId = randomUUID();

const ownerUser: AuthUser = {
  userId: ownerId,
  username: 'admin',
  role: 'owner',
  serverIds: [randomUUID()],
};

// Mock DB user for getUserById
const mockDbUser = {
  id: ownerId,
  username: 'admin',
  role: 'owner',
  plexAccountId: 'plex-account-123',
};

const viewerUser: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'viewer',
  serverIds: [randomUUID()],
};

const mockLinkedAccount = {
  id: randomUUID(),
  userId: ownerId,
  plexAccountId: 'plex-account-123',
  plexUsername: 'admin',
  plexEmail: 'admin@example.com',
  plexThumbnail: 'https://plex.tv/thumb.png',
  plexToken: 'account-token',
  allowLogin: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const mockExistingServer = {
  id: randomUUID(),
  name: 'Existing Plex Server',
  type: 'plex' as const,
  url: 'http://localhost:32400',
  token: 'encrypted_test-token',
  machineIdentifier: 'existing-machine-id',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPlexServer = {
  name: 'New Plex Server',
  product: 'Plex Media Server',
  platform: 'Linux',
  productVersion: '1.40.0',
  clientIdentifier: 'new-machine-id',
  owned: true,
  accessToken: 'server-access-token',
  publicAddress: '203.0.113.1',
  publicAddressMatches: true, // Same network, all connections reachable
  httpsRequired: false, // HTTP connections allowed
  connections: [
    {
      protocol: 'http',
      uri: 'http://192.168.1.100:32400',
      local: true,
      address: '192.168.1.100',
      port: 32400,
      relay: false,
    },
    {
      protocol: 'https',
      uri: 'https://plex.example.com:32400',
      local: false,
      address: 'plex.example.com',
      port: 32400,
      relay: false,
    },
  ],
};

describe('Plex Auth Routes', () => {
  let app: FastifyInstance;

  // Re-establish default mock implementations after each reset. These are
  // depended on by multiple suites (PlexClient instance method, getAllServerIds
  // lookup, fire-and-forget background sync) — hoisting them here
  // keeps the resetAllMocks pattern free of order-dependent leaks across
  // describes.
  beforeEach(() => {
    mockGetUsers.mockResolvedValue([{ id: '1', username: 'admin', isAdmin: true }]);
    mockGetAllServerIds.mockResolvedValue([]);
    // resetAllMocks wipes the resolved values from the vi.mock factory, and the
    // reauthorize route chains .catch() onto refresh().
    vi.mocked(sseManager.removeServer).mockResolvedValue(undefined);
    vi.mocked(sseManager.refresh).mockResolvedValue(undefined);
    // syncServer is awaited via .then() in the route's fire-and-forget path.
    // Without a resolved value, the chained `.then` blows up.
    vi.mocked(syncServer).mockResolvedValue({
      usersAdded: 0,
      usersUpdated: 0,
      usersSkipped: 0,
      usersRemoved: 0,
      usersRestored: 0,
      librariesSynced: 0,
      errors: [],
    });
  });

  afterEach(async () => {
    await app?.close();
    vi.resetAllMocks();
  });

  describe('GET /plex/available-servers', () => {
    it('returns 403 for non-owner users', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/plex/available-servers',
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns hasPlexToken: false when no Plex accounts linked', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Mock DB queries: no plex_accounts, no servers
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      const response = await app.inject({
        method: 'GET',
        url: '/plex/available-servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasPlexToken).toBe(false);
      expect(body.servers).toEqual([]);
    });

    // TODO: Fix this test - the DB mock chain is complex due to multiple query patterns
    it.skip('returns empty servers when all owned servers are connected', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Create a flexible mock that handles various query chain patterns
      // Route queries: 1) servers for token, 2) servers for connected list
      const makeChain = (result: unknown[]) => ({
        limit: vi.fn().mockResolvedValue(result),
        // For queries that don't use limit (just .where())
        then: vi.fn((resolve: (v: unknown[]) => void) => resolve(result)),
        [Symbol.toStringTag]: 'Promise',
      });

      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          // First call for token, returns existing server token
          // Subsequent calls return connected servers list
          return Object.assign(
            Promise.resolve([
              {
                token: mockExistingServer.token,
                machineIdentifier: mockExistingServer.machineIdentifier,
              },
            ]),
            makeChain([{ token: mockExistingServer.token }])
          );
        }),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      // Mock PlexClient.getServers to return only the existing server
      vi.mocked(PlexClient.getServers).mockResolvedValue([
        {
          ...mockPlexServer,
          clientIdentifier: mockExistingServer.machineIdentifier,
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/plex/available-servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasPlexToken).toBe(true);
      // All servers already connected, so empty list
      expect(body.servers).toEqual([]);
    });

    it('returns available servers with connection test results', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Create a flexible mock
      const makeChain = (result: unknown[]) => {
        const chain: Record<string, unknown> = {
          limit: vi.fn().mockResolvedValue(result),
        };
        chain.orderBy = vi.fn().mockReturnValue(chain);
        return chain;
      };

      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          return Object.assign(
            Promise.resolve([{ machineIdentifier: 'other-machine-id' }]), // Connected server
            makeChain([{ plexToken: mockExistingServer.token }]) // For limit() queries
          );
        }),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      // Return a new server not yet connected
      vi.mocked(PlexClient.getServers).mockResolvedValue([mockPlexServer]);

      // Mock fetch for connection testing - first succeeds, second fails
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // Local connection succeeds
        .mockRejectedValueOnce(new Error('timeout')); // Remote connection fails

      const response = await app.inject({
        method: 'GET',
        url: '/plex/available-servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasPlexToken).toBe(true);
      expect(body.servers).toHaveLength(1);
      expect(body.servers[0].name).toBe('New Plex Server');
      expect(body.servers[0].clientIdentifier).toBe('new-machine-id');
      expect(body.servers[0].connections).toHaveLength(2);
      // First connection should be reachable
      expect(body.servers[0].connections[0].reachable).toBe(true);
      // Second connection should be unreachable
      expect(body.servers[0].connections[1].reachable).toBe(false);
    });
  });

  describe('POST /plex/add-server', () => {
    it('returns 403 for non-owner users', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: 'new-machine-id',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 400 when no Plex accounts linked', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Mock the DB query with limit() returning empty for both plex_accounts and servers
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([]) // No plex accounts
          .mockResolvedValueOnce([]), // No existing plex servers
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: 'new-machine-id',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('No Plex accounts linked');
    });

    it('returns 409 when server is already connected', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Mock all limit() calls:
      // 1. Resolve the token from the user's oldest linked account
      // 2. Check machineIdentifier duplicate (found - conflict!)
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([mockLinkedAccount]) // First - token from linked account
          .mockResolvedValueOnce([{ id: mockExistingServer.id }]), // Second - duplicate found
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: mockExistingServer.machineIdentifier,
        },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.message).toContain('already connected');
    });

    it('successfully adds a new server', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      const newServerId = randomUUID();
      const newServer = {
        id: newServerId,
        name: 'New Server',
        type: 'plex',
        url: 'http://192.168.1.100:32400',
        token: 'encrypted_test-token',
        machineIdentifier: 'new-machine-id',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Mock all limit() calls:
      // 1. Resolve the token from the user's oldest linked account
      // 2. Check machineIdentifier duplicate (not found)
      // 3. Check URL duplicate (not found)
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([mockLinkedAccount]) // First - token from linked account
          .mockResolvedValueOnce([]) // Second - no machineIdentifier duplicate
          .mockResolvedValueOnce([]), // Third - no URL duplicate
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      // Mock admin verification
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true });

      // Mock insert
      const insertChain = mockDbInsert([newServer]);

      // Mock sync
      vi.mocked(syncServer).mockResolvedValue({
        usersAdded: 5,
        usersUpdated: 0,
        usersSkipped: 0,
        usersRemoved: 0,
        usersRestored: 0,
        librariesSynced: 3,
        errors: [],
      });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: 'new-machine-id',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.server.id).toBe(newServerId);
      expect(body.success).toBe(true);

      // The resolved account owns the new row: its token and its id, not a
      // token copied off some other server with no account attribution.
      expect(PlexClient.verifyServerAdmin).toHaveBeenCalledWith(
        mockLinkedAccount.plexToken,
        'http://192.168.1.100:32400'
      );
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          token: mockLinkedAccount.plexToken,
          plexAccountId: mockLinkedAccount.id,
        })
      );
    });

    it('returns 403 when not admin on server', async () => {
      app = await buildTestApp(ownerUser);

      // Mock getUserById to return the user
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // Mock all limit() calls
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([mockLinkedAccount]) // Token from linked account
          .mockResolvedValueOnce([]) // No machineIdentifier duplicate
          .mockResolvedValueOnce([]), // No URL duplicate
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      // Mock admin verification - not admin
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: 'NOT_ADMIN',
        message: 'You must be an admin on this Plex server',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/add-server',
        payload: {
          serverUri: 'http://192.168.1.100:32400',
          serverName: 'New Server',
          clientIdentifier: 'new-machine-id',
        },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toContain('admin');
    });
  });

  describe('POST /plex/test-connection', () => {
    beforeEach(() => {
      mockRedis.get.mockReset();
      mockRedis.del.mockReset();
      mockFetch.mockReset();
    });

    it('returns reachable: true on successful test (tempToken auth)', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok-from-temp' }));
      mockFetch.mockResolvedValueOnce({ ok: true });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.connection.reachable).toBe(true);
      expect(body.connection.custom).toBe(true);
      expect(body.connection.uri).toBe('http://192.168.1.100:32400');
      expect(body.connection.address).toBe('192.168.1.100');
      expect(body.connection.port).toBe(32400);
      // Critical: tempToken must not be consumed by the test endpoint —
      // the user retains it until /plex/connect succeeds.
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('returns 401 when tempToken is invalid/expired', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'expired' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 400 for invalid URL', async () => {
      app = await buildUnauthenticatedTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'not-a-url', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('does NOT consume tempToken even when test fails', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      mockFetch.mockRejectedValueOnce(new Error('network'));

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().connection.reachable).toBe(false);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('categorizes DNS failures (ENOTFOUND) as code: dns', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      const dnsError = new Error('fetch failed');
      (dnsError as Error & { cause?: unknown }).cause = {
        code: 'ENOTFOUND',
        message: 'getaddrinfo ENOTFOUND nope.invalid',
      };
      mockFetch.mockRejectedValueOnce(dnsError);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://nope.invalid:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.connection.reachable).toBe(false);
      expect(body.connection.error.code).toBe('dns');
      expect(body.connection.error.message).toContain('ENOTFOUND');
    });

    it('categorizes ECONNREFUSED as code: refused', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      const refusedError = new Error('fetch failed');
      (refusedError as Error & { cause?: unknown }).cause = {
        code: 'ECONNREFUSED',
        message: 'connect ECONNREFUSED 192.168.1.100:32400',
      };
      mockFetch.mockRejectedValueOnce(refusedError);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().connection.error.code).toBe('refused');
    });

    it('categorizes non-OK responses as code: http with status', async () => {
      app = await buildUnauthenticatedTestApp();
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-123' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.connection.reachable).toBe(false);
      expect(body.connection.error.code).toBe('http');
      expect(body.connection.error.status).toBe(401);
    });

    it('returns 403 for non-owner authenticated user (no tempToken)', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400' },
      });

      expect(response.statusCode).toBe(403);
    });

    it('owner auth path uses fallback Plex token when no accountId provided', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);

      // First select: existing plex servers (returns one with token)
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValueOnce([{ token: 'fallback-tok' }]),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      mockFetch.mockResolvedValueOnce({ ok: true });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().connection.reachable).toBe(true);
    });
  });

  describe('POST /plex/test-connection - Claim Code Guard', () => {
    afterEach(() => {
      mockRedis.get.mockReset();
      mockFetch.mockReset();
    });

    it('returns 403 in tempToken branch when claim code is enabled and missing', async () => {
      app = await buildUnauthenticatedTestApp();
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-abc' },
        // no claimCode
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Claim code required');
      // The outbound probe must not have fired
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns 403 in tempToken branch when claim code is enabled and invalid', async () => {
      app = await buildUnauthenticatedTestApp();
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(false);
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: { uri: 'http://192.168.1.100:32400', tempToken: 'temp-abc', claimCode: 'WRONG' },
      });

      expect(response.statusCode).toBe(403);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('allows tempToken branch when claim code is enabled and valid', async () => {
      app = await buildUnauthenticatedTestApp();
      vi.mocked(isClaimCodeEnabled).mockReturnValue(true);
      vi.mocked(validateClaimCode).mockReturnValue(true);
      mockRedis.get.mockResolvedValue(JSON.stringify({ plexToken: 'plex-tok' }));
      mockFetch.mockResolvedValueOnce({ ok: true });

      const response = await app.inject({
        method: 'POST',
        url: '/plex/test-connection',
        payload: {
          uri: 'http://192.168.1.100:32400',
          tempToken: 'temp-abc',
          claimCode: 'VALID-CODE',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().connection.reachable).toBe(true);
      expect(validateClaimCode).toHaveBeenCalledWith('VALID-CODE');
    });
  });

  describe('GET /plex/server-connections/:serverId', () => {
    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('injects saved URL as custom: true when not in plex.tv connections', async () => {
      app = await buildTestApp(ownerUser);

      const customUrl = 'http://192.168.1.99:9999';
      const serverId = randomUUID();

      // First (and only) select: server row by id
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: serverId,
            token: 'srv-tok',
            name: 'Home',
            url: customUrl, // saved URL not in plex.tv connections
            machineIdentifier: 'mid-abc',
          },
        ]),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      vi.mocked(PlexClient.getServers).mockResolvedValue([
        {
          ...mockPlexServer,
          clientIdentifier: 'mid-abc',
          // None of these connections match the saved customUrl
        },
      ]);

      // Order: testServerConnections first (2 plex.tv connections), then the custom URL test
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // local plex.tv conn
        .mockResolvedValueOnce({ ok: true }) // remote plex.tv conn
        .mockResolvedValueOnce({ ok: true }); // custom URL test

      const response = await app.inject({
        method: 'GET',
        url: `/plex/server-connections/${serverId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.server).not.toBeNull();
      // Custom URL row is prepended (unshift), so it's first
      expect(body.server.connections[0].uri).toBe(customUrl);
      expect(body.server.connections[0].custom).toBe(true);
      expect(body.server.connections[0].address).toBe('192.168.1.99');
      expect(body.server.connections[0].port).toBe(9999);
    });

    it('does NOT inject when saved URL matches a plex.tv connection', async () => {
      app = await buildTestApp(ownerUser);

      const matchingUrl = 'http://192.168.1.100:32400'; // matches mockPlexServer.connections[0].uri
      const serverId = randomUUID();

      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([
          {
            id: serverId,
            token: 'srv-tok',
            name: 'Home',
            url: matchingUrl,
            machineIdentifier: 'mid-abc',
          },
        ]),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      vi.mocked(PlexClient.getServers).mockResolvedValue([
        { ...mockPlexServer, clientIdentifier: 'mid-abc' },
      ]);

      mockFetch.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true });

      const response = await app.inject({
        method: 'GET',
        url: `/plex/server-connections/${serverId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.server.connections).toHaveLength(2);
      expect(body.server.connections.every((c: { custom?: boolean }) => !c.custom)).toBe(true);
    });
  });

  describe('POST /plex/accounts/:id/reauthorize', () => {
    const freshPin = {
      id: mockLinkedAccount.plexAccountId,
      username: 'admin',
      email: 'admin@example.com',
      thumb: 'https://plex.tv/new-thumb.png',
      token: 'fresh-token',
      tokenKind: 'legacy' as const,
      refreshToken: null,
      expiresAt: null,
    };

    const linkedServer = {
      id: randomUUID(),
      name: 'Linked Server',
      url: 'http://192.168.1.100:32400',
      status: 'refreshed' as const,
    };

    /** Account lookup ends at .limit(); the trailing server count ends at .where(). */
    function mockAccountLookup(account: typeof mockLinkedAccount | null = mockLinkedAccount) {
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() =>
          Object.assign(Promise.resolve([{ count: 1 }]), {
            limit: vi.fn().mockResolvedValue(account ? [account] : []),
          })
        ),
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);
    }

    it('returns 403 for non-owner users', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: `/plex/accounts/${mockLinkedAccount.id}/reauthorize`,
        payload: { pin: '12345' },
      });

      expect(response.statusCode).toBe(403);
      expect(reconcilePlexAccountToken).not.toHaveBeenCalled();
    });

    it('returns 404 when the account is not the caller\u2019s', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);
      mockAccountLookup(null);

      const response = await app.inject({
        method: 'POST',
        url: `/plex/accounts/${randomUUID()}/reauthorize`,
        payload: { pin: '12345' },
      });

      expect(response.statusCode).toBe(404);
      expect(PlexClient.checkOAuthPin).not.toHaveBeenCalled();
    });

    it('returns 400 when the PIN is not authorized yet', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);
      mockAccountLookup();
      vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(null);

      const response = await app.inject({
        method: 'POST',
        url: `/plex/accounts/${mockLinkedAccount.id}/reauthorize`,
        payload: { pin: '12345' },
      });

      expect(response.statusCode).toBe(400);
      expect(reconcilePlexAccountToken).not.toHaveBeenCalled();
    });

    it('returns 409 and reconciles nothing when the PIN belongs to another Plex account', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);
      mockAccountLookup();
      vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue({
        ...freshPin,
        id: 'someone-elses-plex-account',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/plex/accounts/${mockLinkedAccount.id}/reauthorize`,
        payload: { pin: '12345' },
      });

      expect(response.statusCode).toBe(409);
      expect(reconcilePlexAccountToken).not.toHaveBeenCalled();
      expect(sseManager.refresh).not.toHaveBeenCalled();
    });

    it('hands the redeemed identity to the reconciler and verifies with the new token', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);
      mockAccountLookup();
      vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(freshPin);
      vi.mocked(reconcilePlexAccountToken).mockResolvedValue({
        reconciled: [linkedServer],
        unmatched: [],
      });
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true });

      const response = await app.inject({
        method: 'POST',
        url: `/plex/accounts/${mockLinkedAccount.id}/reauthorize`,
        payload: { pin: '12345' },
      });

      expect(response.statusCode).toBe(200);
      expect(reconcilePlexAccountToken).toHaveBeenCalledWith(
        expect.objectContaining({ id: mockLinkedAccount.id }),
        expect.objectContaining({ token: 'fresh-token', id: mockLinkedAccount.plexAccountId }),
        expect.anything()
      );
      expect(PlexClient.verifyServerAdmin).toHaveBeenCalledWith('fresh-token', linkedServer.url);
      expect(sseManager.refresh).toHaveBeenCalled();
      expect(response.json().servers).toEqual([
        { id: linkedServer.id, name: linkedServer.name, status: 'refreshed', ok: true },
      ]);
    });

    it('reports a server that still refuses the new token', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);
      mockAccountLookup();
      vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(freshPin);
      vi.mocked(reconcilePlexAccountToken).mockResolvedValue({
        reconciled: [linkedServer],
        unmatched: [],
      });
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: 'NOT_ADMIN',
        message: 'not admin',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/plex/accounts/${mockLinkedAccount.id}/reauthorize`,
        payload: { pin: '12345' },
      });

      expect(response.json().servers[0].ok).toBe(false);
    });

    it('surfaces servers the reconciler could not attribute instead of reporting success', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getUserById).mockResolvedValue(mockDbUser as never);
      mockAccountLookup();
      vi.mocked(PlexClient.checkOAuthPin).mockResolvedValue(freshPin);
      const stranded = { id: randomUUID(), name: 'Stranded Server' };
      vi.mocked(reconcilePlexAccountToken).mockResolvedValue({
        reconciled: [],
        unmatched: [stranded],
      });

      const response = await app.inject({
        method: 'POST',
        url: `/plex/accounts/${mockLinkedAccount.id}/reauthorize`,
        payload: { pin: '12345' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().servers).toEqual([
        { id: stranded.id, name: stranded.name, status: 'unmatched', ok: false },
      ]);
      // Nothing was written, so there is no stale connection to rebuild
      expect(sseManager.refresh).not.toHaveBeenCalled();
    });
  });
});
