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
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock dependencies before imports
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../utils/crypto.js', () => ({
  encrypt: vi.fn((token: string) => `encrypted_${token}`),
  decrypt: vi.fn((token: string) => token.replace('encrypted_', '')),
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  PlexClient: {
    verifyServerAdmin: vi.fn(),
    AdminVerifyError: {
      CONNECTION_FAILED: 'CONNECTION_FAILED',
      NOT_ADMIN: 'NOT_ADMIN',
    },
  },
  JellyfinClient: {
    verifyServerAdmin: vi.fn(),
  },
  EmbyClient: {
    verifyServerAdmin: vi.fn(),
  },
}));

vi.mock('../../services/sync.js', () => ({
  syncServer: vi.fn(),
}));

// Import mocked modules
import { db } from '../../db/client.js';
import { PlexClient, JellyfinClient, EmbyClient } from '../../services/mediaServer/index.js';
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
      vi.mocked(JellyfinClient.verifyServerAdmin).mockResolvedValue(true);
      vi.mocked(EmbyClient.verifyServerAdmin).mockResolvedValue(true);
      vi.mocked(syncServer).mockResolvedValue({
        usersAdded: 5,
        usersUpdated: 0,
        librariesSynced: 3,
        errors: [],
      });
    });

    it('creates a new Plex server for owner', async () => {
      app = await buildTestApp(ownerUser);

      // No existing server
      mockDbSelectLimit([]);

      const newServer = {
        id: randomUUID(),
        name: 'New Plex',
        type: 'plex',
        url: 'http://plex.local:32400',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
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

      mockDbSelectLimit([]);

      const newServer = {
        id: randomUUID(),
        name: 'New Jellyfin',
        type: 'jellyfin',
        url: 'http://jellyfin.local:8096',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
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

      mockDbSelectLimit([]);

      const newServer = {
        id: randomUUID(),
        name: 'New Emby',
        type: 'emby',
        url: 'http://emby.local:8096',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
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

  describe('POST /servers/:id/sync', () => {
    beforeEach(() => {
      vi.mocked(syncServer).mockResolvedValue({
        usersAdded: 3,
        usersUpdated: 2,
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

      // Verify fetch was called with X-Emby-Authorization header
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Emby-Authorization': expect.stringContaining('MediaBrowser'),
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
  });
});
