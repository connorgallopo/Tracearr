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
import type { AuthUser, DashboardStats } from '@tracearr/shared';
import { REDIS_KEYS } from '@tracearr/shared';
import type { SQL } from 'drizzle-orm';
import { createMockActiveSession } from '../../test/fixtures.js';
import { renderSql } from '../../test/helpers.js';

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
const mockSelectWhere = vi.fn().mockResolvedValue([]);
vi.mock('../../db/client.js', () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        // The server-filtered active-users query joins server_users to count
        // distinct identities, other server-filtered queries stay unjoined.
        where: (...args: unknown[]) => mockSelectWhere(...args),
        innerJoin: vi.fn().mockReturnValue({
          where: (...args: unknown[]) => mockSelectWhere(...args),
        }),
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
import { permissionGuard } from '../../lib/scope.js';

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
  app.decorate('requirePermission', permissionGuard(app));

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
        listenTimeHours: 1.5,
        watchTimeMs: 45_000_000,
        listenTimeMs: 5_400_000,
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
      // Cache key includes server segment ('all' for owner with no filter) and timezone
      expect(redisMock.get).toHaveBeenCalledWith(`${REDIS_KEYS.DASHBOARD_STATS}:all:UTC`);
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
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 18000000, listenMs: 0 }]); // 5 hours
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

      // Should cache the results (cache key includes server segment and timezone)
      expect(redisMock.setex).toHaveBeenCalledWith(
        `${REDIS_KEYS.DASHBOARD_STATS}:all:UTC`,
        60,
        expect.any(String)
      );
    });

    it('should count active sessions from cache', async () => {
      const ownerUser = createOwnerUser();
      const activeSessions = [
        createMockActiveSession(),
        createMockActiveSession(),
        createMockActiveSession(),
      ];

      // Mock the cache service to return active sessions
      mockGetAllActiveSessions.mockResolvedValueOnce(activeSessions);

      const redisMock = {
        get: vi.fn().mockResolvedValueOnce(null), // No dashboard cache
        setex: vi.fn().mockResolvedValue('OK'),
      };

      vi.mocked(playsCountSince.execute).mockResolvedValue([{ count: 10 }]);
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 7200000, listenMs: 0 }]); // 2 hours
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
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 3600000, listenMs: 0 }]);
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
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 0, listenMs: 0 }]);
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
      vi.mocked(watchTimeSince.execute).mockResolvedValue([{ totalMs: 20000000, listenMs: 0 }]);
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
      expect(body.watchTimeMs).toBe(20000000);
    });

    it('reports listen time apart from watch time and counts music in todayPlays', async () => {
      app = await buildTestApp(createOwnerUser());
      vi.mocked(playsCountSince.execute).mockResolvedValue([{ count: 4 }]);
      vi.mocked(watchTimeSince.execute).mockResolvedValue([
        { totalMs: 18000000, listenMs: 5400000 },
      ]);
      vi.mocked(violationsCountSince.execute).mockResolvedValue([{ count: 0 }]);
      vi.mocked(uniqueUsersSince.execute).mockResolvedValue([{ count: 1 }]);
      mockDbExecute.mockResolvedValueOnce({ rows: [{ count: 4 }] });

      const response = await app.inject({ method: 'GET', url: '/stats/dashboard' });

      const body = JSON.parse(response.body);
      expect(body.watchTimeHours).toBe(5);
      expect(body.listenTimeHours).toBe(1.5);
      const { sql: query } = renderSql(mockDbExecute.mock.calls[0]?.[0] as SQL);
      expect(query).toContain("AND media_type IN ('movie', 'episode', 'track')");
    });

    it('counts music in todayPlays, todaySessions and activeUsersToday on the server-filtered path', async () => {
      app = await buildTestApp(createOwnerUser());

      const response = await app.inject({
        method: 'GET',
        url: `/stats/dashboard?serverId=${randomUUID()}`,
      });

      expect(JSON.parse(response.body).listenTimeHours).toBe(0);
      const queries = mockDbExecute.mock.calls.map((call) => renderSql(call[0] as SQL).sql);
      const todayPlaysQuery = queries.find((query) => query.includes('FROM sessions'));
      expect(todayPlaysQuery).toContain("AND media_type IN ('movie', 'episode', 'track')");
      const selectFilters = mockSelectWhere.mock.calls.map((call) => renderSql(call[0] as SQL));
      expect(selectFilters).toHaveLength(3);
      for (const { params } of selectFilters) {
        expect(params).toEqual(expect.arrayContaining(['movie', 'episode', 'track']));
      }
    });

    it('should return empty stats when non-owner requests server not in access list', async () => {
      const serverId1 = randomUUID();
      const serverId2 = randomUUID();
      // Non-owner user only has access to serverId1
      const adminUser: AuthUser = {
        userId: randomUUID(),
        username: 'admin',
        role: 'admin',
        serverIds: [serverId1],
      };

      const redisMock = {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
      };

      app = await buildTestApp(adminUser, redisMock);

      // Request stats for serverId2 (not in user's serverIds)
      // resolveServerIds intersects requested IDs with user's access, yielding empty set
      const response = await app.inject({
        method: 'GET',
        url: `/stats/dashboard?serverId=${serverId2}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Empty intersection means queries return zero results
      expect(body.activeStreams).toBe(0);
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
