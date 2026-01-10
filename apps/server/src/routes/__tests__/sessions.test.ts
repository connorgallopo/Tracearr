/**
 * Session routes tests
 *
 * Tests the API endpoints for session queries:
 * - GET /sessions - List historical sessions with filters
 * - GET /sessions/active - Get currently active streams
 * - GET /sessions/:id - Get a specific session
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import { createMockActiveSession } from '../../test/fixtures.js';

// Mock the database module before importing routes
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    execute: vi.fn(),
  },
}));

// Mock cache service - need to provide getAllActiveSessions for /active endpoint
const mockGetAllActiveSessions = vi.fn().mockResolvedValue([]);
vi.mock('../../services/cache.js', () => ({
  getCacheService: vi.fn(() => ({
    getAllActiveSessions: mockGetAllActiveSessions,
    getSessionById: vi.fn().mockResolvedValue(null),
  })),
}));

// Import the mocked db and the routes
import { db } from '../../db/client.js';
import { sessionRoutes } from '../sessions.js';

/**
 * Build a test Fastify instance with mocked auth and redis
 */
async function buildTestApp(
  authUser: AuthUser,
  redisMock?: { get: ReturnType<typeof vi.fn> }
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(sensible);

  // Mock the authenticate decorator
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });

  // Mock Redis (cast to never for test mock)
  app.decorate('redis', (redisMock ?? { get: vi.fn().mockResolvedValue(null) }) as never);

  await app.register(sessionRoutes, { prefix: '/sessions' });

  return app;
}

function createOwnerUser(serverIds?: string[]): AuthUser {
  return {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: serverIds ?? [randomUUID()],
  };
}

function createViewerUser(serverIds?: string[]): AuthUser {
  return {
    userId: randomUUID(),
    username: 'viewer',
    role: 'viewer',
    serverIds: serverIds ?? [randomUUID()],
  };
}

describe('Session Routes', () => {
  let app: FastifyInstance;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = db as any;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('GET /sessions', () => {
    it('should return paginated sessions for owner', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const mockSessionRows = [
        {
          id: randomUUID(),
          started_at: new Date(),
          stopped_at: new Date(),
          duration_ms: '3600000',
          paused_duration_ms: '0',
          progress_ms: 3600000,
          segment_count: '1',
          watched: true,
          state: 'stopped',
          server_id: ownerUser.serverIds[0],
          server_name: 'Test Server',
          server_type: 'plex',
          server_user_id: randomUUID(),
          username: 'testuser',
          user_thumb: null,
          session_key: 'session-1',
          media_type: 'movie',
          media_title: 'Test Movie',
          grandparent_title: null,
          season_number: null,
          episode_number: null,
          year: 2024,
          thumb_path: '/thumb',
          reference_id: null,
          ip_address: '192.168.1.1',
          geo_city: 'NYC',
          geo_region: 'NY',
          geo_country: 'US',
          geo_lat: 40.7,
          geo_lon: -74.0,
          player_name: 'Chrome',
          device_id: 'dev-1',
          product: 'Plex Web',
          device: 'Chrome',
          platform: 'Chrome',
          quality: '1080p',
          is_transcode: false,
          bitrate: 20000,
        },
      ];

      // Mock the main query
      mockDb.execute.mockResolvedValueOnce({ rows: mockSessionRows });
      // Mock the count query
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/sessions',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.page).toBe(1);
      expect(body.total).toBe(1);
    });

    it('should filter by serverUserId', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 0 }] });

      const serverUserId = randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/sessions?serverUserId=${serverUserId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(0);
    });

    it('should filter by mediaType', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 0 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?mediaType=movie',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should filter by date range', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 0 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?startDate=2024-01-01&endDate=2024-12-31',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should handle pagination', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      mockDb.execute.mockResolvedValueOnce({ rows: [] });
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 100 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?page=2&pageSize=25',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.page).toBe(2);
      expect(body.pageSize).toBe(25);
      expect(body.totalPages).toBe(4);
    });

    it('should reject invalid query parameters', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions?page=-1',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /sessions/active', () => {
    it('should return active sessions from cache', async () => {
      const serverId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);
      const activeSessions = [createMockActiveSession({ serverId })];

      // Mock the cache service response
      mockGetAllActiveSessions.mockResolvedValueOnce(activeSessions);

      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions/active',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(mockGetAllActiveSessions).toHaveBeenCalled();
    });

    it('should return empty array when cache is empty', async () => {
      const ownerUser = createOwnerUser();

      // Mock empty cache
      mockGetAllActiveSessions.mockResolvedValueOnce([]);

      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions/active',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(0);
    });

    it('should filter sessions by user serverIds', async () => {
      const serverId1 = randomUUID();
      const serverId2 = randomUUID();
      const viewerUser = createViewerUser([serverId1]);

      const activeSessions = [
        createMockActiveSession({ serverId: serverId1 }),
        createMockActiveSession({ serverId: serverId2 }),
      ];

      // Mock the cache service response
      mockGetAllActiveSessions.mockResolvedValueOnce(activeSessions);

      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions/active',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].serverId).toBe(serverId1);
    });

    it('should handle invalid JSON in cache', async () => {
      const ownerUser = createOwnerUser();

      // getAllActiveSessions handles parsing internally, so this just tests empty
      mockGetAllActiveSessions.mockResolvedValueOnce([]);

      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions/active',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(0);
    });
  });

  describe('GET /sessions/:id', () => {
    it('should return session from cache if active', async () => {
      const serverId = randomUUID();
      const sessionId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);

      const activeSession = createMockActiveSession({ id: sessionId, serverId });

      const redisMock = {
        get: vi.fn().mockResolvedValue(JSON.stringify(activeSession)),
      };

      app = await buildTestApp(ownerUser, redisMock);

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(sessionId);
      expect(body.user.username).toBe(activeSession.user.username);
      expect(body.server.name).toBe(activeSession.server.name);
    });

    it('should return session from database if not in cache', async () => {
      const serverId = randomUUID();
      const sessionId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);

      const redisMock = {
        get: vi.fn().mockResolvedValue(null),
      };

      app = await buildTestApp(ownerUser, redisMock);

      const dbSession = {
        id: sessionId,
        serverId,
        serverName: 'Test Server',
        serverType: 'plex',
        serverUserId: randomUUID(),
        username: 'testuser',
        userThumb: null,
        identityName: null,
        sessionKey: 'session-1',
        state: 'stopped',
        mediaType: 'movie',
        mediaTitle: 'Test Movie',
        grandparentTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        year: 2024,
        thumbPath: '/thumb',
        startedAt: new Date(),
        stoppedAt: new Date(),
        durationMs: 3600000,
        progressMs: 3600000,
        totalDurationMs: 7200000,
        lastPausedAt: null,
        pausedDurationMs: 0,
        referenceId: null,
        watched: true,
        ipAddress: '192.168.1.1',
        geoCity: 'NYC',
        geoRegion: 'NY',
        geoCountry: 'US',
        geoLat: 40.7,
        geoLon: -74.0,
        playerName: 'Chrome',
        deviceId: 'dev-1',
        product: 'Plex Web',
        device: 'Chrome',
        platform: 'Chrome',
        quality: '1080p',
        isTranscode: false,
        videoDecision: 'directplay',
        audioDecision: 'directplay',
        bitrate: 20000,
      };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([dbSession]),
                }),
              }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(sessionId);
    });

    it('should return 404 for non-existent session', async () => {
      const ownerUser = createOwnerUser();
      const redisMock = {
        get: vi.fn().mockResolvedValue(null),
      };

      app = await buildTestApp(ownerUser, redisMock);

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 400 for invalid UUID', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/sessions/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 403 when user lacks access to session server', async () => {
      const serverId = randomUUID();
      const sessionId = randomUUID();
      const differentServerId = randomUUID();
      const viewerUser = createViewerUser([differentServerId]);

      const redisMock = {
        get: vi.fn().mockResolvedValue(null),
      };

      app = await buildTestApp(viewerUser, redisMock);

      const dbSession = {
        id: sessionId,
        serverId,
        serverName: 'Test Server',
        serverType: 'plex',
        serverUserId: randomUUID(),
        username: 'testuser',
        userThumb: null,
        identityName: null,
        sessionKey: 'session-1',
        state: 'stopped',
        mediaType: 'movie',
        mediaTitle: 'Test Movie',
        grandparentTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        year: 2024,
        thumbPath: '/thumb',
        startedAt: new Date(),
        stoppedAt: new Date(),
        durationMs: 3600000,
        progressMs: 3600000,
        totalDurationMs: 7200000,
        lastPausedAt: null,
        pausedDurationMs: 0,
        referenceId: null,
        watched: true,
        ipAddress: '192.168.1.1',
        geoCity: 'NYC',
        geoRegion: 'NY',
        geoCountry: 'US',
        geoLat: 40.7,
        geoLon: -74.0,
        playerName: 'Chrome',
        deviceId: 'dev-1',
        product: 'Plex Web',
        device: 'Chrome',
        platform: 'Chrome',
        quality: '1080p',
        isTranscode: false,
        videoDecision: 'directplay',
        audioDecision: 'directplay',
        bitrate: 20000,
      };

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([dbSession]),
                }),
              }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}`,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should deny access to cached session from wrong server', async () => {
      const serverId = randomUUID();
      const sessionId = randomUUID();
      const differentServerId = randomUUID();
      const viewerUser = createViewerUser([differentServerId]);

      const activeSession = createMockActiveSession({ id: sessionId, serverId });

      const redisMock = {
        get: vi.fn().mockResolvedValue(JSON.stringify(activeSession)),
      };

      app = await buildTestApp(viewerUser, redisMock);

      // Should fall through to DB since server access denied
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/sessions/${sessionId}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
