/**
 * Plex auth routes tests
 *
 * Tests the API endpoints for Plex server discovery and connection:
 * - GET /plex/available-servers - Discover available Plex servers
 * - POST /plex/add-server - Add an additional Plex server
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock dependencies before imports
vi.mock('../../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../../utils/crypto.js', () => ({
  encrypt: vi.fn((token: string) => `encrypted_${token}`),
  decrypt: vi.fn((token: string) => token.replace('encrypted_', '')),
}));

vi.mock('../../../services/mediaServer/index.js', () => ({
  PlexClient: {
    getServers: vi.fn(),
    verifyServerAdmin: vi.fn(),
    AdminVerifyError: {
      CONNECTION_FAILED: 'CONNECTION_FAILED',
      NOT_ADMIN: 'NOT_ADMIN',
    },
  },
}));

vi.mock('../../../services/sync.js', () => ({
  syncServer: vi.fn(),
}));

// Import mocked modules
import { db } from '../../../db/client.js';
import { PlexClient } from '../../../services/mediaServer/index.js';
import { syncServer } from '../../../services/sync.js';
import { plexRoutes } from '../plex.js';

// Mock global fetch for connection testing
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Helper to create DB chain mocks
function mockDbSelectWhere(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

// For queries that end with .limit()
function mockDbSelectLimit(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

function mockDbInsert(result: unknown[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

function _mockDbUpdate() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
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

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'admin',
  role: 'owner',
  serverIds: [randomUUID()],
};

const viewerUser: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'viewer',
  serverIds: [randomUUID()],
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
    },
    {
      protocol: 'https',
      uri: 'https://plex.example.com:32400',
      local: false,
      address: 'plex.example.com',
      port: 32400,
    },
  ],
};

describe('Plex Auth Routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
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

    it('returns hasPlexToken: false when no Plex servers connected', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectWhere([]);

      const response = await app.inject({
        method: 'GET',
        url: '/plex/available-servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.hasPlexToken).toBe(false);
      expect(body.servers).toEqual([]);
    });

    it('returns empty servers when all owned servers are connected', async () => {
      app = await buildTestApp(ownerUser);

      // First call returns existing servers
      mockDbSelectWhere([mockExistingServer]);

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
      expect(body.servers).toEqual([]);
    });

    it('returns available servers with connection test results', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectWhere([mockExistingServer]);

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

    it('returns 400 when no Plex servers connected', async () => {
      app = await buildTestApp(ownerUser);

      // Mock the DB query with limit() returning empty
      mockDbSelectLimit([]);

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
      expect(body.message).toContain('No Plex servers connected');
    });

    it('returns 409 when server is already connected', async () => {
      app = await buildTestApp(ownerUser);

      // Mock all three limit() calls:
      // 1. Get existing Plex server (has token)
      // 2. Check machineIdentifier duplicate (found - conflict!)
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([{ token: mockExistingServer.token }]) // First - get token
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

      // Mock all three limit() calls:
      // 1. Get existing Plex server (has token)
      // 2. Check machineIdentifier duplicate (not found)
      // 3. Check URL duplicate (not found)
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([{ token: mockExistingServer.token }]) // First - get token
          .mockResolvedValueOnce([]) // Second - no machineIdentifier duplicate
          .mockResolvedValueOnce([]), // Third - no URL duplicate
      };
      vi.mocked(db.select).mockReturnValue(selectMock as never);

      // Mock admin verification
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true });

      // Mock insert
      mockDbInsert([newServer]);

      // Mock sync
      vi.mocked(syncServer).mockResolvedValue({
        usersAdded: 5,
        usersUpdated: 0,
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
    });

    it('returns 403 when not admin on server', async () => {
      app = await buildTestApp(ownerUser);

      // Mock all three limit() calls
      const selectMock = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi
          .fn()
          .mockResolvedValueOnce([{ token: mockExistingServer.token }]) // Get token
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
});
