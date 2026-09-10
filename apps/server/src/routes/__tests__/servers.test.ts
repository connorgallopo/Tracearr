/**
 * Server routes tests
 *
 * Tests the API endpoints for server management:
 * - GET /servers - List connected servers
 * - POST /servers - Add a new server
 * - DELETE /servers/:id - Remove a server
 * - POST /servers/:id/sync - Force sync
 * - GET /servers/:id/image/* - Proxy images
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import { WS_EVENTS, type AuthUser } from '@tracearr/shared';

// Mock dependencies before imports
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../utils/crypto.js', () => ({
  encrypt: vi.fn((token: string) => `encrypted_${token}`),
  decrypt: vi.fn((token: string) => token.replace('encrypted_', '')),
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  PlexClient: {
    verifyServerAdmin: vi.fn(),
    getAccountInfo: vi.fn(),
    AdminVerifyError: {
      CONNECTION_FAILED: 'CONNECTION_FAILED',
      NOT_ADMIN: 'NOT_ADMIN',
    },
  },
  JellyfinClient: {
    verifyServerAdmin: vi.fn(),
    AdminVerifyError: {
      CONNECTION_FAILED: 'CONNECTION_FAILED',
      INVALID_KEY: 'INVALID_KEY',
      NOT_ADMIN: 'NOT_ADMIN',
    },
  },
  EmbyClient: {
    verifyServerAdmin: vi.fn(),
    AdminVerifyError: {
      CONNECTION_FAILED: 'CONNECTION_FAILED',
      INVALID_KEY: 'INVALID_KEY',
      NOT_ADMIN: 'NOT_ADMIN',
    },
  },
}));

vi.mock('../../services/sync.js', () => ({
  syncServer: vi.fn(),
}));

const mockPublish = vi.fn(() => Promise.resolve());
vi.mock('../../services/cache.js', () => ({
  getCacheService: vi.fn().mockReturnValue({
    invalidateServerStats: vi.fn().mockResolvedValue(undefined),
  }),
  getPubSubService: () => ({ publish: mockPublish }),
}));

vi.mock('../../jobs/librarySyncQueue.js', () => ({
  enqueueLibrarySync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/serverLiveStats.js', () => ({
  getServerResourceStats: vi.fn(),
  getServerLiveStats: vi.fn(),
}));

// Import mocked modules
import { db } from '../../db/client.js';
import { PlexClient, JellyfinClient, EmbyClient } from '../../services/mediaServer/index.js';
import { getServerLiveStats, getServerResourceStats } from '../../services/serverLiveStats.js';
import { syncServer } from '../../services/sync.js';
import { serverRoutes } from '../servers.js';

// Mock global fetch for image proxy tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Helper to create DB chain mocks
// For queries that end with .where() (no limit)
function mockDbSelectWhere(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(result),
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

function mockDbDelete() {
  const chain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.delete).mockReturnValue(chain as never);
  return chain;
}

function mockDbUpdate() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

function mockDbUpdateReturning(result: unknown[]) {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
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

  // Mock jwtVerify for image routes
  app.decorateRequest('jwtVerify', async function (this: { user: AuthUser }) {
    this.user = authUser;
  });

  await app.register(serverRoutes, { prefix: '/servers' });
  return app;
}

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'admin',
  role: 'owner',
  serverIds: [],
};

const viewerUser: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'viewer',
  serverIds: [randomUUID()],
};

const mockServer = {
  id: randomUUID(),
  name: 'Test Plex Server',
  type: 'plex' as const,
  url: 'http://localhost:32400',
  token: 'encrypted_test-token',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Server Routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe('GET /servers', () => {
    it('returns all servers for owner', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectWhere([
        {
          id: mockServer.id,
          name: mockServer.name,
          type: mockServer.type,
          url: mockServer.url,
          displayOrder: 0,
          color: '#4B8BFF',
          createdAt: mockServer.createdAt,
          updatedAt: mockServer.updatedAt,
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe('Test Plex Server');
      // Should not include token
      expect(body.data[0].token).toBeUndefined();
    });

    it('carries the installed and latest versions when they are known', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectWhere([
        {
          id: mockServer.id,
          name: mockServer.name,
          type: mockServer.type,
          url: mockServer.url,
          displayOrder: 0,
          color: '#4B8BFF',
          version: '10.11.11',
          latestVersion: '10.11.12',
          createdAt: mockServer.createdAt,
          updatedAt: mockServer.updatedAt,
        },
      ]);

      const response = await app.inject({ method: 'GET', url: '/servers' });

      expect(response.statusCode).toBe(200);
      const selected = vi.mocked(db.select).mock.calls[0]?.[0];
      expect(selected).toHaveProperty('version');
      expect(selected).toHaveProperty('latestVersion');
      const body = response.json();
      expect(body.data[0].version).toBe('10.11.11');
      expect(body.data[0].latestVersion).toBe('10.11.12');
    });

    it('returns only authorized servers for guest', async () => {
      const guestServerId = randomUUID();
      const guestWithServer: AuthUser = {
        ...viewerUser,
        serverIds: [guestServerId],
      };
      app = await buildTestApp(guestWithServer);

      mockDbSelectWhere([
        {
          id: guestServerId,
          name: 'Guest Server',
          type: 'jellyfin',
          url: 'http://localhost:8096',
          displayOrder: 0,
          color: '#9B59B6',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(guestServerId);
    });

    it('returns empty array when guest has no server access', async () => {
      const guestNoAccess: AuthUser = {
        ...viewerUser,
        serverIds: [],
      };
      app = await buildTestApp(guestNoAccess);

      mockDbSelectWhere([]);

      const response = await app.inject({
        method: 'GET',
        url: '/servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(0);
    });
  });

  describe('POST /servers', () => {
    beforeEach(() => {
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true });
      vi.mocked(JellyfinClient.verifyServerAdmin).mockResolvedValue({ success: true });
      vi.mocked(EmbyClient.verifyServerAdmin).mockResolvedValue({ success: true });
      vi.mocked(syncServer).mockResolvedValue({
        usersAdded: 5,
        usersUpdated: 0,
        usersSkipped: 0,
        usersRemoved: 0,
        usersRestored: 0,
        librariesSynced: 3,
        errors: [],
      });
    });

    it('creates a new Plex server for owner', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(PlexClient.getAccountInfo).mockResolvedValue({
        id: 'plex-account-123',
        username: 'admin',
        isAdmin: true,
      });

      const newServer = {
        id: randomUUID(),
        name: 'New Plex',
        type: 'plex',
        url: 'http://plex.local:32400',
        color: '#4B8BFF',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let selectCall = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCall++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        if (selectCall === 3) {
          chain.from = vi.fn().mockResolvedValue([]);
        }
        return chain as never;
      });

      mockDbInsert([newServer]);

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'New Plex',
          type: 'plex',
          url: 'http://plex.local:32400',
          token: 'my-plex-token',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(PlexClient.verifyServerAdmin).toHaveBeenCalledWith(
        'my-plex-token',
        'http://plex.local:32400'
      );
      const body = response.json();
      expect(body.name).toBe('New Plex');
      expect(body.type).toBe('plex');
    });

    it('creates a new Jellyfin server for owner', async () => {
      app = await buildTestApp(ownerUser);

      const newServer = {
        id: randomUUID(),
        name: 'New Jellyfin',
        type: 'jellyfin',
        url: 'http://jellyfin.local:8096',
        color: '#9B59B6',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let selectCall = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCall++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        if (selectCall === 2) {
          chain.from = vi.fn().mockResolvedValue([]);
        }
        return chain as never;
      });

      mockDbInsert([newServer]);

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'New Jellyfin',
          type: 'jellyfin',
          url: 'http://jellyfin.local:8096',
          token: 'my-jellyfin-token',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(JellyfinClient.verifyServerAdmin).toHaveBeenCalledWith(
        'my-jellyfin-token',
        'http://jellyfin.local:8096'
      );
    });

    it('creates a new Emby server for owner', async () => {
      app = await buildTestApp(ownerUser);

      const newServer = {
        id: randomUUID(),
        name: 'New Emby',
        type: 'emby',
        url: 'http://emby.local:8096',
        color: '#2ECC71',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let selectCall = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCall++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        if (selectCall === 2) {
          chain.from = vi.fn().mockResolvedValue([]);
        }
        return chain as never;
      });

      mockDbInsert([newServer]);

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'New Emby',
          type: 'emby',
          url: 'http://emby.local:8096',
          token: 'my-emby-token',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(EmbyClient.verifyServerAdmin).toHaveBeenCalledWith(
        'my-emby-token',
        'http://emby.local:8096'
      );
    });

    it('stores the public address with https prepended on a Jellyfin server and refuses one on Plex', async () => {
      app = await buildTestApp(ownerUser);

      let selectCall = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCall++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        if (selectCall === 2) {
          chain.from = vi.fn().mockResolvedValue([]);
        }
        return chain as never;
      });
      const insert = mockDbInsert([
        {
          id: randomUUID(),
          name: 'Attic',
          type: 'jellyfin',
          url: 'http://192.168.1.20:8096',
          publicUrl: 'https://jellyfin.example.com',
          color: '#9B59B6',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const created = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Attic',
          type: 'jellyfin',
          url: 'http://192.168.1.20:8096',
          token: 'key-1',
          publicUrl: 'jellyfin.example.com',
        },
      });
      expect(created.statusCode).toBe(201);
      expect(insert.values).toHaveBeenCalledWith(
        expect.objectContaining({ publicUrl: 'https://jellyfin.example.com' })
      );
      expect(created.json().publicUrl).toBe('https://jellyfin.example.com');

      const plex = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Basement',
          type: 'plex',
          url: 'http://192.168.1.10:32400',
          token: 'plex-token',
          publicUrl: 'https://plex.example.com',
        },
      });
      expect(plex.statusCode).toBe(400);
      expect(plex.json().message).toBe('Public address applies to Jellyfin and Emby servers only');
    });

    it('rejects guest creating server', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Guest Server',
          type: 'plex',
          url: 'http://guest.local:32400',
          token: 'guest-token',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });

    it('rejects duplicate server URL', async () => {
      app = await buildTestApp(ownerUser);

      // Existing server with same URL
      mockDbSelectLimit([mockServer]);

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Duplicate',
          type: 'plex',
          url: mockServer.url,
          token: 'test-token',
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain('already exists');
    });

    it('rejects non-admin token', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);
      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: 'NOT_ADMIN',
        message: 'You must be an admin on this Plex server',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Non-Admin',
          type: 'plex',
          url: 'http://nonadmin.local:32400',
          token: 'non-admin-token',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('admin');
    });

    it('returns 401 when Jellyfin rejects the API key', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);
      vi.mocked(JellyfinClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: 'INVALID_KEY',
        message: 'Jellyfin rejected this API key (it may be invalid or expired).',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Bad Key',
          type: 'jellyfin',
          url: 'http://jellyfin.local:8096',
          token: 'bad-key',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().message).toContain('rejected');
    });

    it('returns 503 when the Emby server cannot be reached', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);
      vi.mocked(EmbyClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: 'CONNECTION_FAILED',
        message: 'Cannot reach Emby server at http://emby.local:8096. ECONNREFUSED',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Down Emby',
          type: 'emby',
          url: 'http://emby.local:8096',
          token: 'some-token',
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().message).toContain('Cannot reach');
    });

    it('returns 401 when Emby rejects the API key', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);
      vi.mocked(EmbyClient.verifyServerAdmin).mockResolvedValue({
        success: false,
        code: 'INVALID_KEY',
        message: 'Emby rejected this API key (it may be invalid or expired).',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Bad Key',
          type: 'emby',
          url: 'http://emby.local:8096',
          token: 'bad-key',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json().message).toContain('rejected');
    });

    it('handles connection error to media server', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);
      vi.mocked(PlexClient.verifyServerAdmin).mockRejectedValue(new Error('Connection refused'));

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Unreachable',
          type: 'plex',
          url: 'http://unreachable.local:32400',
          token: 'test-token',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Failed to connect');
    });

    it('rejects invalid request body', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: '', // Invalid: empty name
          type: 'invalid-type',
          url: 'not-a-url',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('PATCH /servers/:id', () => {
    it('updates server name only for owner', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockServer]);
      const updatedServer = {
        ...mockServer,
        name: 'Renamed Server',
        updatedAt: new Date(),
      };
      mockDbUpdateReturning([updatedServer]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/servers/${mockServer.id}`,
        payload: { name: 'Renamed Server' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe('Renamed Server');
      expect(body.id).toBe(mockServer.id);
      expect(db.update).toHaveBeenCalled();
    });

    it('saves a public address on a Jellyfin server, clears it on an empty string, and refuses it on Plex', async () => {
      app = await buildTestApp(ownerUser);
      const jellyfin = {
        ...mockServer,
        type: 'jellyfin' as const,
        url: 'http://192.168.1.20:8096',
        publicUrl: null as string | null,
        color: '#9B59B6',
      };

      mockDbSelectLimit([jellyfin]);
      let update = mockDbUpdateReturning([
        { ...jellyfin, publicUrl: 'https://jellyfin.example.com' },
      ]);
      const saved = await app.inject({
        method: 'PATCH',
        url: `/servers/${jellyfin.id}`,
        payload: { publicUrl: 'jellyfin.example.com' },
      });
      expect(saved.statusCode).toBe(200);
      expect(update.set).toHaveBeenCalledWith({
        publicUrl: 'https://jellyfin.example.com',
        updatedAt: expect.any(Date),
      });
      expect(saved.json().publicUrl).toBe('https://jellyfin.example.com');

      mockDbSelectLimit([{ ...jellyfin, publicUrl: 'https://jellyfin.example.com' }]);
      update = mockDbUpdateReturning([jellyfin]);
      const cleared = await app.inject({
        method: 'PATCH',
        url: `/servers/${jellyfin.id}`,
        payload: { publicUrl: '' },
      });
      expect(cleared.statusCode).toBe(200);
      expect(update.set).toHaveBeenCalledWith({ publicUrl: null, updatedAt: expect.any(Date) });

      mockDbSelectLimit([mockServer]);
      const plex = await app.inject({
        method: 'PATCH',
        url: `/servers/${mockServer.id}`,
        payload: { publicUrl: 'https://plex.example.com' },
      });
      expect(plex.statusCode).toBe(400);
      expect(plex.json().message).toBe('Public address applies to Jellyfin and Emby servers only');
    });

    it('rejects when neither name nor url provided', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: `/servers/${mockServer.id}`,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toMatch(/name or url|At least one/);
    });

    it('rejects non-owner with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: `/servers/${mockServer.id}`,
        payload: { name: 'New Name' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });

    it('returns 404 when server not found', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/servers/${mockServer.id}`,
        payload: { name: 'New Name' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().message).toBe('Server not found');
    });
  });

  describe('DELETE /servers/:id', () => {
    it('deletes server for owner', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockServer]);
      mockDbDelete();

      const response = await app.inject({
        method: 'DELETE',
        url: `/servers/${mockServer.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
    });

    it('rejects guest deleting server', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'DELETE',
        url: `/servers/${mockServer.id}`,
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 404 for non-existent server', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);

      const response = await app.inject({
        method: 'DELETE',
        url: `/servers/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for invalid UUID', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'DELETE',
        url: '/servers/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('servers:changed', () => {
    it('announces a created server', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(PlexClient.verifyServerAdmin).mockResolvedValue({ success: true });
      vi.mocked(PlexClient.getAccountInfo).mockResolvedValue({
        id: 'plex-account-123',
        username: 'admin',
        isAdmin: true,
      });
      vi.mocked(syncServer).mockResolvedValue({
        usersAdded: 0,
        usersUpdated: 0,
        usersSkipped: 0,
        usersRemoved: 0,
        usersRestored: 0,
        librariesSynced: 0,
        errors: [],
      });

      let selectCall = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCall++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
        if (selectCall === 3) {
          chain.from = vi.fn().mockResolvedValue([]);
        }
        return chain as never;
      });
      mockDbInsert([{ ...mockServer, id: randomUUID() }]);

      const response = await app.inject({
        method: 'POST',
        url: '/servers',
        payload: {
          name: 'Announced Plex',
          type: 'plex',
          url: 'http://plex.local:32400',
          token: 'my-plex-token',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(mockPublish).toHaveBeenCalledWith(WS_EVENTS.SERVERS_CHANGED, {});
    });

    it('announces an updated server', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockServer]);
      mockDbUpdateReturning([{ ...mockServer, name: 'Renamed Server' }]);

      const response = await app.inject({
        method: 'PATCH',
        url: `/servers/${mockServer.id}`,
        payload: { name: 'Renamed Server' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockPublish).toHaveBeenCalledWith(WS_EVENTS.SERVERS_CHANGED, {});
    });

    it('announces a reordered server list', async () => {
      app = await buildTestApp(ownerUser);

      const ids = [randomUUID(), randomUUID()];
      // The reorder lookup awaits .where() directly, with no orderBy or limit.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))),
      } as never);
      vi.mocked(db.transaction).mockImplementation(async (fn: unknown) =>
        (fn as (tx: unknown) => Promise<void>)({
          update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        })
      );

      const response = await app.inject({
        method: 'PATCH',
        url: '/servers/reorder',
        payload: {
          servers: ids.map((id, index) => ({ id, displayOrder: index })),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockPublish).toHaveBeenCalledWith(WS_EVENTS.SERVERS_CHANGED, {});
    });

    it('announces a deleted server', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockServer]);
      mockDbDelete();

      const response = await app.inject({
        method: 'DELETE',
        url: `/servers/${mockServer.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(mockPublish).toHaveBeenCalledWith(WS_EVENTS.SERVERS_CHANGED, {});
    });
  });

  describe('POST /servers/:id/sync', () => {
    beforeEach(() => {
      vi.mocked(syncServer).mockResolvedValue({
        usersAdded: 3,
        usersUpdated: 2,
        usersSkipped: 0,
        usersRemoved: 0,
        usersRestored: 0,
        librariesSynced: 5,
        errors: [],
      });
    });

    it('syncs server for owner', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockServer]);
      mockDbUpdate();

      const response = await app.inject({
        method: 'POST',
        url: `/servers/${mockServer.id}/sync`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.usersAdded).toBe(3);
      expect(body.usersUpdated).toBe(2);
      expect(body.librariesSynced).toBe(5);
      expect(body.errors).toEqual([]);
      expect(syncServer).toHaveBeenCalledWith(mockServer.id, {
        syncUsers: true,
        syncLibraries: true,
      });
    });

    it('returns errors when sync has issues', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(syncServer).mockResolvedValue({
        usersAdded: 1,
        usersUpdated: 0,
        usersSkipped: 0,
        usersRemoved: 0,
        usersRestored: 0,
        librariesSynced: 0,
        errors: ['Failed to fetch library 1', 'User sync timeout'],
      });

      mockDbSelectLimit([mockServer]);
      mockDbUpdate();

      const response = await app.inject({
        method: 'POST',
        url: `/servers/${mockServer.id}/sync`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(false);
      expect(body.errors).toHaveLength(2);
    });

    it('rejects guest syncing server', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: `/servers/${mockServer.id}/sync`,
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 404 for non-existent server', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);

      const response = await app.inject({
        method: 'POST',
        url: `/servers/${randomUUID()}/sync`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('handles sync service error', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockServer]);
      vi.mocked(syncServer).mockRejectedValue(new Error('Sync failed'));

      const response = await app.inject({
        method: 'POST',
        url: `/servers/${mockServer.id}/sync`,
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('GET /servers/:id/image/*', () => {
    it('proxies Plex image with token in URL', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockServer]);

      const imageBuffer = Buffer.from('fake-image-data');
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'image/jpeg']]),
        arrayBuffer: () => Promise.resolve(imageBuffer),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${mockServer.id}/image/library/metadata/123/thumb/456`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(response.headers['cache-control']).toContain('max-age=86400');

      // Verify fetch was called with correct URL including Plex token
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('X-Plex-Token='),
        expect.any(Object)
      );
    });

    it('proxies Jellyfin image with auth header', async () => {
      const jellyfinServer = {
        ...mockServer,
        type: 'jellyfin' as const,
        url: 'http://localhost:8096',
      };

      app = await buildTestApp(ownerUser);
      mockDbSelectLimit([jellyfinServer]);

      const imageBuffer = Buffer.from('fake-image-data');
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'image/png']]),
        arrayBuffer: () => Promise.resolve(imageBuffer),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${jellyfinServer.id}/image/Items/abc/Images/Primary`,
      });

      expect(response.statusCode).toBe(200);

      // Verify fetch was called with Authorization header
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining('MediaBrowser'),
          }),
        })
      );
    });

    it('accepts auth via query param for img tags', async () => {
      // Create app with custom jwtVerify that reads from query
      const customApp = Fastify({ logger: false });
      await customApp.register(sensible);

      customApp.decorate('authenticate', async (request: unknown) => {
        (request as { user: AuthUser }).user = ownerUser;
      });

      customApp.decorateRequest(
        'jwtVerify',
        async function (this: { user: AuthUser; headers: { authorization?: string } }) {
          // Simulate JWT verification - if header exists, it's valid
          if (this.headers.authorization) {
            this.user = ownerUser;
          } else {
            throw new Error('Missing token');
          }
        }
      );

      await customApp.register(serverRoutes, { prefix: '/servers' });

      mockDbSelectLimit([mockServer]);
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'image/jpeg']]),
        arrayBuffer: () => Promise.resolve(Buffer.from('image')),
      });

      const response = await customApp.inject({
        method: 'GET',
        url: `/servers/${mockServer.id}/image/thumb.jpg?token=valid-jwt-token`,
      });

      expect(response.statusCode).toBe(200);
      await customApp.close();
    });

    it('goes through the shared authenticate guard, not a bare jwtVerify', async () => {
      // The shared guard enforces the post-restore revocation timestamp and the
      // mobile device blacklist; a hand-rolled jwtVerify skips both. Here the
      // guard rejects while jwtVerify would succeed, so a 200 means the route
      // is still bypassing it.
      const customApp = Fastify({ logger: false });
      await customApp.register(sensible);

      customApp.decorate('authenticate', async (_request: unknown, reply: FastifyReply) => {
        await reply.status(401).send({ message: 'Session has been revoked' });
      });

      customApp.decorateRequest('jwtVerify', async function (this: { user: AuthUser }) {
        this.user = ownerUser;
      });

      await customApp.register(serverRoutes, { prefix: '/servers' });

      mockDbSelectLimit([mockServer]);
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'image/jpeg']]),
        arrayBuffer: () => Promise.resolve(Buffer.from('image')),
      });

      const response = await customApp.inject({
        method: 'GET',
        url: `/servers/${mockServer.id}/image/thumb.jpg`,
        headers: { authorization: 'Bearer revoked-but-well-formed' },
      });

      expect(response.statusCode).toBe(401);
      expect(mockFetch).not.toHaveBeenCalled();
      await customApp.close();
    });

    it('returns 404 for non-existent server', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${randomUUID()}/image/thumb.jpg`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 404 when upstream image not found', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockServer]);
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${mockServer.id}/image/nonexistent.jpg`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('handles fetch error gracefully', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([mockServer]);
      mockFetch.mockRejectedValue(new Error('Network error'));

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${mockServer.id}/image/thumb.jpg`,
      });

      expect(response.statusCode).toBe(500);
    });

    it('returns 400 when image path is missing', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${mockServer.id}/image/`,
      });

      // Wildcard route with empty path
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /servers/:id/statistics', () => {
    it('returns 404 for non-existent server', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${randomUUID()}/statistics`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for non-Plex server', async () => {
      const jellyfinServer = {
        ...mockServer,
        type: 'jellyfin' as const,
      };

      app = await buildTestApp(ownerUser);
      mockDbSelectLimit([jellyfinServer]);

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${jellyfinServer.id}/statistics`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('only available for Plex');
    });

    it('returns 400 for invalid server ID', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/servers/not-a-uuid/statistics',
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns cached resource data for a Plex server', async () => {
      const dataPoint = {
        timespan: 6,
        at: 1786145464,
        hostCpuUtilization: 2.757,
        processCpuUtilization: 0.025,
        hostMemoryUtilization: 12.41,
        processMemoryUtilization: 0.371,
      };

      app = await buildTestApp(ownerUser);
      mockDbSelectLimit([mockServer]);
      vi.mocked(getServerResourceStats).mockResolvedValue([dataPoint]);

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${mockServer.id}/statistics`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.serverId).toBe(mockServer.id);
      expect(body.data).toEqual([dataPoint]);
      expect(getServerResourceStats).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ id: mockServer.id, url: mockServer.url, token: mockServer.token })
      );
    });
  });

  describe('GET /servers/:id/live-stats', () => {
    it('returns 404 for non-existent server', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectLimit([]);

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${randomUUID()}/live-stats`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('serves non-Plex servers through the stats service (plugin buffer path)', async () => {
      const jellyfinServer = {
        ...mockServer,
        type: 'jellyfin' as const,
      };
      const point = {
        at: 100,
        timespan: 6,
        hostCpuUtilization: 1,
        processCpuUtilization: 2,
        hostMemoryUtilization: 3,
        processMemoryUtilization: 4,
      };

      app = await buildTestApp(ownerUser);
      mockDbSelectLimit([jellyfinServer]);
      vi.mocked(getServerLiveStats).mockClear();
      vi.mocked(getServerLiveStats).mockResolvedValue({
        statistics: [point],
        bandwidth: [],
        bandwidthSamples: [],
        bandwidthAccounts: [],
        bandwidthDevices: [],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${jellyfinServer.id}/live-stats`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.serverId).toBe(jellyfinServer.id);
      expect(body.statistics).toEqual([point]);
      expect(body.bandwidth).toEqual([]);
      expect(getServerLiveStats).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ id: jellyfinServer.id, type: 'jellyfin' })
      );
    });

    it('returns 400 for invalid server ID', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/servers/not-a-uuid/live-stats',
      });

      expect(response.statusCode).toBe(400);
    });

    it('strips per-account bandwidth detail for non-owner callers', async () => {
      app = await buildTestApp(viewerUser);
      mockDbSelectLimit([mockServer]);
      vi.mocked(getServerLiveStats).mockResolvedValue({
        statistics: [],
        bandwidth: [{ at: 101, timespan: 1, lanBytes: 28, wanBytes: 729 }],
        bandwidthSamples: [{ at: 101, accountId: 1, deviceId: 1, lan: true, bytes: 28 }],
        bandwidthAccounts: [{ id: 1, name: 'Gallapagos', thumb: null }],
        bandwidthDevices: [{ id: 1, name: 'Chromecast', platform: 'Chromecast' }],
      });

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${mockServer.id}/live-stats`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.bandwidth).toEqual([{ at: 101, timespan: 1, lanBytes: 28, wanBytes: 729 }]);
      expect(body.bandwidthSamples).toEqual([]);
      expect(body.bandwidthAccounts).toEqual([]);
      expect(body.bandwidthDevices).toEqual([]);
    });

    it('returns combined statistics and bandwidth with attribution', async () => {
      const liveStats = {
        statistics: [
          {
            timespan: 6,
            at: 1786145464,
            hostCpuUtilization: 2.757,
            processCpuUtilization: 0.025,
            hostMemoryUtilization: 12.41,
            processMemoryUtilization: 0.371,
          },
        ],
        bandwidth: [{ at: 101, timespan: 1, lanBytes: 28, wanBytes: 729 }],
        bandwidthSamples: [
          { at: 101, accountId: 1, deviceId: 1, lan: true, bytes: 28 },
          { at: 101, accountId: 1, deviceId: 382, lan: false, bytes: 729 },
        ],
        bandwidthAccounts: [{ id: 1, name: 'Gallapagos', thumb: null }],
        bandwidthDevices: [{ id: 1, name: 'Chromecast', platform: 'Chromecast' }],
      };

      app = await buildTestApp(ownerUser);
      mockDbSelectLimit([mockServer]);
      vi.mocked(getServerLiveStats).mockResolvedValue(liveStats);

      const response = await app.inject({
        method: 'GET',
        url: `/servers/${mockServer.id}/live-stats`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.serverId).toBe(mockServer.id);
      expect(body.statistics).toEqual(liveStats.statistics);
      expect(body.bandwidth).toEqual(liveStats.bandwidth);
      expect(body.bandwidthSamples).toEqual(liveStats.bandwidthSamples);
      expect(body.bandwidthAccounts).toEqual(liveStats.bandwidthAccounts);
      expect(body.bandwidthDevices).toEqual(liveStats.bandwidthDevices);
      expect(body.fetchedAt).toBeTruthy();
      expect(getServerLiveStats).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ id: mockServer.id, url: mockServer.url, token: mockServer.token })
      );
    });
  });
});
