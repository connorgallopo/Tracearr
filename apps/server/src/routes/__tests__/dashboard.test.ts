/**
 * Dashboard stats route tests
 *
 * Tests the API endpoint for dashboard summary metrics:
 * - GET /dashboard - Dashboard summary metrics (active streams, plays, watch time, alerts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, ActiveSession, DashboardStats } from '@tracearr/shared';
import { REDIS_KEYS } from '@tracearr/shared';

// Mock the prepared statements module
vi.mock('../../db/prepared.js', () => ({
  playsCountSince: {
    execute: vi.fn(),
  },
  watchTimeSince: {
    execute: vi.fn(),
  },
  violationsCountSince: {
    execute: vi.fn(),
  },
  uniqueUsersSince: {
    execute: vi.fn(),
  },
}));

// Mock cache service - need to provide getAllActiveSessions for active stream count
const mockGetAllActiveSessions = vi.fn().mockResolvedValue([]);
vi.mock('../../services/cache.js', () => ({
  getCacheService: vi.fn(() => ({
    getAllActiveSessions: mockGetAllActiveSessions,
  })),
}));

// Mock db.execute for engagement aggregate queries
const mockDbExecute = vi.fn().mockResolvedValue({ rows: [{ count: 0 }] });
vi.mock('../../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

// Import the mocked modules and the routes
import {
  playsCountSince,
  watchTimeSince,
  violationsCountSince,
  uniqueUsersSince,
} from '../../db/prepared.js';
import { dashboardRoutes } from '../stats/dashboard.js';

/**
 * Build a test Fastify instance with mocked auth and redis
 */
async function buildTestApp(
  authUser: AuthUser,
  redisMock?: { get: ReturnType<typeof vi.fn>; setex: ReturnType<typeof vi.fn> }
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(sensible);

  // Mock the authenticate decorator
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });

  // Mock Redis
  app.decorate(
    'redis',
    (redisMock ?? {
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn().mockResolvedValue('OK'),
    }) as never
  );

  await app.register(dashboardRoutes, { prefix: '/stats' });

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

function createActiveSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  const serverId = overrides.serverId ?? randomUUID();
  return {
    id: overrides.id ?? randomUUID(),
    sessionKey: overrides.sessionKey ?? 'session-123',
    serverId,
    serverUserId: overrides.serverUserId ?? randomUUID(),
    state: overrides.state ?? 'playing',
    mediaType: overrides.mediaType ?? 'movie',
    mediaTitle: overrides.mediaTitle ?? 'Test Movie',
    grandparentTitle: overrides.grandparentTitle ?? null,
    seasonNumber: overrides.seasonNumber ?? null,
    episodeNumber: overrides.episodeNumber ?? null,
    year: overrides.year ?? 2024,
    thumbPath: overrides.thumbPath ?? '/library/metadata/123/thumb',
    ratingKey: overrides.ratingKey ?? 'media-123',
    externalSessionId: overrides.externalSessionId ?? null,
    startedAt: overrides.startedAt ?? new Date(),
    stoppedAt: overrides.stoppedAt ?? null,
    durationMs: overrides.durationMs ?? 0,
    progressMs: overrides.progressMs ?? 0,
    totalDurationMs: overrides.totalDurationMs ?? 7200000,
    lastPausedAt: overrides.lastPausedAt ?? null,
    pausedDurationMs: overrides.pausedDurationMs ?? 0,
    referenceId: overrides.referenceId ?? null,
    watched: overrides.watched ?? false,
    ipAddress: overrides.ipAddress ?? '192.168.1.100',
    geoCity: overrides.geoCity ?? 'New York',
    geoRegion: overrides.geoRegion ?? 'NY',
    geoCountry: overrides.geoCountry ?? 'US',
    geoLat: overrides.geoLat ?? 40.7128,
    geoLon: overrides.geoLon ?? -74.006,
    playerName: overrides.playerName ?? 'Chrome',
    deviceId: overrides.deviceId ?? 'device-123',
    product: overrides.product ?? 'Plex Web',
    device: overrides.device ?? 'Chrome',
    platform: overrides.platform ?? 'Chrome',
    quality: overrides.quality ?? '1080p',
    isTranscode: overrides.isTranscode ?? false,
    videoDecision: overrides.videoDecision ?? 'directplay',
    audioDecision: overrides.audioDecision ?? 'directplay',
    bitrate: overrides.bitrate ?? 20000,
    // Live TV specific fields
    channelTitle: overrides.channelTitle ?? null,
    channelIdentifier: overrides.channelIdentifier ?? null,
    channelThumb: overrides.channelThumb ?? null,
    // Music track fields
    artistName: overrides.artistName ?? null,
    albumName: overrides.albumName ?? null,
    trackNumber: overrides.trackNumber ?? null,
    discNumber: overrides.discNumber ?? null,
    user: overrides.user ?? {
      id: randomUUID(),
      username: 'testuser',
      thumbUrl: null,
      identityName: null,
    },
    server: overrides.server ?? {
      id: serverId,
      name: 'Test Server',
      type: 'plex',
    },
  };
}

describe('Dashboard Stats Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('GET /stats/dashboard', () => {
    it('should return cached stats when available', async () => {
      const ownerUser = createOwnerUser();
      const cachedStats: DashboardStats = {
        activeStreams: 5,
        todayPlays: 25,
        todaySessions: 30,
        watchTimeHours: 12.5,
        alertsLast24h: 3,
        activeUsersToday: 8,
      };

      const redisMock = {
        get: vi.fn().mockResolvedValue(JSON.stringify(cachedStats)),
        setex: vi.fn().mockResolvedValue('OK'),
      };

      app = await buildTestApp(ownerUser, redisMock);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/dashboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual(cachedStats);
      // Cache key now includes timezone (defaults to UTC)
      expect(redisMock.get).toHaveBeenCalledWith(`${REDIS_KEYS.DASHBOARD_STATS}:UTC`);
      // Should not call database when cache hit
      expect(playsCountSince.execute).not.toHaveBeenCalled();
    });

    it('should compute stats when cache is empty', async () => {
      const ownerUser = createOwnerUser();

      const redisMock = {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
      };

      // Mock prepared statement results
      vi.mocked(playsCountSince.execute).mockResolvedValue([{ count: 15 }]);
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 18000000 }]); // 5 hours
      vi.mocked(violationsCountSince.execute).mockResolvedValue([{ count: 2 }]);
      vi.mocked(uniqueUsersSince.execute).mockResolvedValue([{ count: 6 }]);
      mockDbExecute.mockResolvedValueOnce({ rows: [{ count: 15 }] }); // Engagement validated plays

      app = await buildTestApp(ownerUser, redisMock);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/dashboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.todayPlays).toBe(15);
      expect(body.watchTimeHours).toBe(5);
      expect(body.alertsLast24h).toBe(2);
      expect(body.activeUsersToday).toBe(6);
      expect(body.activeStreams).toBe(0);

      // Should cache the results (cache key includes timezone)
      expect(redisMock.setex).toHaveBeenCalledWith(
        `${REDIS_KEYS.DASHBOARD_STATS}:UTC`,
        60,
        expect.any(String)
      );
    });

    it('should count active sessions from cache', async () => {
      const ownerUser = createOwnerUser();
      const activeSessions = [createActiveSession(), createActiveSession(), createActiveSession()];

      // Mock the cache service to return active sessions
      mockGetAllActiveSessions.mockResolvedValueOnce(activeSessions);

      const redisMock = {
        get: vi.fn().mockResolvedValueOnce(null), // No dashboard cache
        setex: vi.fn().mockResolvedValue('OK'),
      };

      vi.mocked(playsCountSince.execute).mockResolvedValue([{ count: 10 }]);
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 7200000 }]); // 2 hours
      vi.mocked(violationsCountSince.execute).mockResolvedValue([{ count: 0 }]);
      vi.mocked(uniqueUsersSince.execute).mockResolvedValue([{ count: 3 }]);
      mockDbExecute.mockResolvedValueOnce({ rows: [{ count: 10 }] }); // Engagement validated plays

      app = await buildTestApp(ownerUser, redisMock);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/dashboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.activeStreams).toBe(3);
      expect(body.todayPlays).toBe(10);
      expect(body.watchTimeHours).toBe(2);
    });

    it('should handle invalid JSON in dashboard cache gracefully', async () => {
      const ownerUser = createOwnerUser();

      const redisMock = {
        get: vi
          .fn()
          .mockResolvedValueOnce('invalid json') // Invalid dashboard cache
          .mockResolvedValueOnce(null), // No active sessions
        setex: vi.fn().mockResolvedValue('OK'),
      };

      vi.mocked(playsCountSince.execute).mockResolvedValue([{ count: 5 }]);
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 3600000 }]);
      vi.mocked(violationsCountSince.execute).mockResolvedValue([{ count: 1 }]);
      vi.mocked(uniqueUsersSince.execute).mockResolvedValue([{ count: 2 }]);
      mockDbExecute.mockResolvedValueOnce({ rows: [{ count: 5 }] }); // Engagement validated plays

      app = await buildTestApp(ownerUser, redisMock);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/dashboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.todayPlays).toBe(5);
    });

    it('should handle invalid JSON in active sessions cache gracefully', async () => {
      const ownerUser = createOwnerUser();

      // Cache service handles invalid JSON internally and returns empty array
      mockGetAllActiveSessions.mockResolvedValueOnce([]);

      const redisMock = {
        get: vi.fn().mockResolvedValueOnce(null), // No dashboard cache
        setex: vi.fn().mockResolvedValue('OK'),
      };

      vi.mocked(playsCountSince.execute).mockResolvedValue([{ count: 8 }]);
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 0 }]);
      vi.mocked(violationsCountSince.execute).mockResolvedValue([{ count: 0 }]);
      vi.mocked(uniqueUsersSince.execute).mockResolvedValue([{ count: 4 }]);
      mockDbExecute.mockResolvedValueOnce({ rows: [{ count: 8 }] }); // Engagement validated plays

      app = await buildTestApp(ownerUser, redisMock);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/dashboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.activeStreams).toBe(0);
      expect(body.todayPlays).toBe(8);
    });

    it('should handle null results from prepared statements', async () => {
      const ownerUser = createOwnerUser();

      const redisMock = {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
      };

      vi.mocked(playsCountSince.execute).mockResolvedValue([]);
      vi.mocked(watchTimeSince.execute).mockResolvedValue([]);
      vi.mocked(violationsCountSince.execute).mockResolvedValue([]);
      vi.mocked(uniqueUsersSince.execute).mockResolvedValue([]);
      mockDbExecute.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // Engagement validated plays

      app = await buildTestApp(ownerUser, redisMock);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/dashboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.todayPlays).toBe(0);
      expect(body.watchTimeHours).toBe(0);
      expect(body.alertsLast24h).toBe(0);
      expect(body.activeUsersToday).toBe(0);
    });

    it('should round watch time to one decimal place', async () => {
      const ownerUser = createOwnerUser();

      const redisMock = {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
      };

      // 5.555... hours = 20000000 ms
      vi.mocked(playsCountSince.execute).mockResolvedValue([{ count: 0 }]);
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 20000000 }]);
      vi.mocked(violationsCountSince.execute).mockResolvedValue([{ count: 0 }]);
      vi.mocked(uniqueUsersSince.execute).mockResolvedValue([{ count: 0 }]);
      mockDbExecute.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // Engagement validated plays

      app = await buildTestApp(ownerUser, redisMock);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/dashboard',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.watchTimeHours).toBe(5.6);
    });

    it('should reject access to server not in user access list', async () => {
      const serverId1 = randomUUID();
      const serverId2 = randomUUID();
      // Non-owner user only has access to serverId1
      const viewerUser: AuthUser = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [serverId1],
      };

      app = await buildTestApp(viewerUser);

      // Try to access stats for serverId2 (not in user's serverIds)
      const response = await app.inject({
        method: 'GET',
        url: `/stats/dashboard?serverId=${serverId2}`,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should reject invalid serverId format', async () => {
      const ownerUser = createOwnerUser();

      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/dashboard?serverId=not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
