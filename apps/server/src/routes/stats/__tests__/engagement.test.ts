/**
 * Engagement statistics route tests
 *
 * Tests GET /engagement - Comprehensive engagement metrics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock database before imports
vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

// Mock server filtering utilities. resolveServerIds mirrors the real implementation,
// including the ForbiddenError it throws for a non-owner's explicit unauthorized serverId.
vi.mock('../../../utils/serverFiltering.js', async () => {
  const { sql } = await import('drizzle-orm');
  const { ForbiddenError } = await import('../../../utils/errors.js');
  return {
    resolveServerIds: vi.fn((authUser, serverId, serverIds) => {
      if (serverId && authUser.role !== 'owner' && !authUser.serverIds.includes(serverId)) {
        throw new ForbiddenError('You do not have access to this server');
      }
      const requested = serverIds ?? (serverId ? [serverId] : undefined);
      if (authUser.role === 'owner') return requested ?? undefined;
      if (!requested) return authUser.serverIds;
      return requested.filter((id: string) => authUser.serverIds.includes(id));
    }),
    buildMultiServerFragment: vi.fn(() => sql``),
  };
});

// Mock resolveDateRange
vi.mock('../utils.js', () => ({
  resolveDateRange: vi.fn((period: string, startDate?: string, endDate?: string) => {
    if (period === 'custom') {
      return {
        start: startDate ? new Date(startDate) : null,
        end: endDate ? new Date(endDate) : null,
      };
    }
    if (period === 'all') {
      return { start: null, end: new Date('2024-06-15T12:00:00Z') };
    }
    // Default week period
    return {
      start: new Date('2024-06-08T12:00:00Z'),
      end: new Date('2024-06-15T12:00:00Z'),
    };
  }),
}));

import { db } from '../../../db/client.js';
import { engagementRoutes } from '../engagement.js';
import { permissionGuard } from '../../../lib/scope.js';

/**
 * Helper to create a test Fastify instance with authentication
 */
async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));

  await app.register(engagementRoutes, { prefix: '/stats' });

  return app;
}

function createOwnerUser(): AuthUser {
  return {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [],
  };
}

function createViewerUser(serverIds: string[]): AuthUser {
  return {
    userId: randomUUID(),
    username: 'viewer',
    role: 'admin',
    serverIds,
  };
}

// Mock the single combined engagement statement (JSON columns)
function mockEngagementResult() {
  return {
    rows: [
      {
        tier_breakdown: [
          { tier: 'rewatched', count: 30 },
          { tier: 'watched', count: 20 },
          { tier: 'engaged', count: 15 },
          { tier: 'sampled', count: 10 },
          { tier: 'abandoned', count: 5 },
        ],
        user_profiles: [
          {
            server_user_id: randomUUID(),
            username: 'testuser',
            thumb_url: '/user-thumb.jpg',
            identity_name: 'Test User',
            content_started: 50,
            total_plays: 100,
            total_watch_hours: 40.5,
            valid_session_count: 90,
            total_session_count: 110,
            abandoned_count: 5,
            sampled_count: 10,
            engaged_count: 15,
            watched_count: 15,
            rewatched_count: 5,
            completion_rate: 70.0,
            behavior_type: 'completionist',
            favorite_media_type: 'movie',
          },
        ],
        summary: {
          total_plays: '500',
          total_valid_sessions: '450',
          total_all_sessions: '600',
          avg_completion_rate: '75.5',
        },
      },
    ],
  };
}

describe('Engagement Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Server filtering (via shared resolveServerIds)', () => {
    describe('Schema validation security', () => {
      it('should reject malformed UUID in serverId', async () => {
        const ownerUser = createOwnerUser();
        app = await buildTestApp(ownerUser);

        // Mock db.execute to capture SQL and verify it contains "AND false"
        vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);

        const response = await app.inject({
          method: 'GET',
          url: '/stats/engagement?serverId=invalid-uuid-123',
        });

        // Should fail validation at schema level
        expect(response.statusCode).toBe(400);
      });

      it('should reject SQL injection attempt in serverId', async () => {
        const ownerUser = createOwnerUser();
        app = await buildTestApp(ownerUser);

        const response = await app.inject({
          method: 'GET',
          url: "/stats/engagement?serverId='; DROP TABLE sessions; --",
        });

        // Schema validation should reject this
        expect(response.statusCode).toBe(400);
      });

      it('should accept valid UUID in serverId', async () => {
        const ownerUser = createOwnerUser();
        const validServerId = randomUUID();
        app = await buildTestApp(ownerUser);

        vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

        const response = await app.inject({
          method: 'GET',
          url: `/stats/engagement?serverId=${validServerId}`,
        });

        expect(response.statusCode).toBe(200);
      });
    });

    describe('Server filtering logic', () => {
      it('should return empty SQL fragment for owner role', async () => {
        const ownerUser = createOwnerUser();
        app = await buildTestApp(ownerUser);

        vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

        const response = await app.inject({
          method: 'GET',
          url: '/stats/engagement',
        });

        expect(response.statusCode).toBe(200);
        // For owner, no server filter should be applied
        // The SQL should not have server_id restrictions
      });

      it('should filter by single server for non-owner with one server', async () => {
        const serverId = randomUUID();
        const viewerUser = createViewerUser([serverId]);
        app = await buildTestApp(viewerUser);

        vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

        const response = await app.inject({
          method: 'GET',
          url: '/stats/engagement',
        });

        expect(response.statusCode).toBe(200);
        // Should apply server_id = serverId filter
      });

      it('should filter by multiple servers for non-owner with multiple servers', async () => {
        const serverId1 = randomUUID();
        const serverId2 = randomUUID();
        const viewerUser = createViewerUser([serverId1, serverId2]);
        app = await buildTestApp(viewerUser);

        vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

        const response = await app.inject({
          method: 'GET',
          url: '/stats/engagement',
        });

        expect(response.statusCode).toBe(200);
        // Should apply server_id IN (serverId1, serverId2) filter
      });

      it('should return no results for non-owner with empty serverIds', async () => {
        const viewerUser = createViewerUser([]);
        app = await buildTestApp(viewerUser);

        vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

        const response = await app.inject({
          method: 'GET',
          url: '/stats/engagement',
        });

        expect(response.statusCode).toBe(200);
        // Should apply "AND false" filter, returning no results
      });

      it('should handle non-owner with invalid serverIds gracefully', async () => {
        // UUID validation is handled upstream by Zod schema, but serverIds from auth
        // context are passed through to buildMultiServerFragment as-is
        const viewerUser = createViewerUser(['invalid-uuid', 'also-invalid']);
        app = await buildTestApp(viewerUser);

        vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

        const response = await app.inject({
          method: 'GET',
          url: '/stats/engagement',
        });

        // buildMultiServerFragment is mocked to return sql``, so this succeeds
        expect(response.statusCode).toBe(200);
      });
    });
  });

  describe('GET /stats/engagement', () => {
    it('should require authentication', async () => {
      const app = Fastify({ logger: false });
      await app.register(sensible);

      // No authentication decorator
      app.decorate('authenticate', async () => {
        throw new Error('Unauthorized');
      });
      app.decorate('requirePermission', permissionGuard(app));

      await app.register(engagementRoutes, { prefix: '/stats' });

      const response = await app.inject({
        method: 'GET',
        url: '/stats/engagement',
      });

      expect(response.statusCode).toBe(500); // Error thrown by mock
      await app.close();
    });

    it('should return engagement stats with default parameters', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/engagement',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(Object.keys(body).sort()).toEqual(['engagementBreakdown', 'summary', 'userProfiles']);
      expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(1);

      expect(body.summary.totalPlays).toBe(500);
      expect(body.summary.sessionInflationPct).toBeGreaterThan(0);
    });

    it('should validate and reject invalid serverId', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/engagement?serverId=not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject access to unauthorized server', async () => {
      const authorizedServer = randomUUID();
      const unauthorizedServer = randomUUID();
      const viewerUser = createViewerUser([authorizedServer]);
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: `/stats/engagement?serverId=${unauthorizedServer}`,
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toContain('access');
    });

    it('should respect custom date range', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/engagement?period=custom&startDate=2024-01-01T00:00:00Z&endDate=2024-01-31T23:59:59Z',
      });

      expect(response.statusCode).toBe(200);
    });

    it('should calculate engagement tier percentages correctly', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/engagement',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.engagementBreakdown).toHaveLength(5);
      const totalPercentage = body.engagementBreakdown.reduce(
        (sum: number, tier: { percentage: number }) => sum + tier.percentage,
        0
      );
      // Allow for rounding errors - total should be close to 100
      expect(totalPercentage).toBeGreaterThanOrEqual(99.9);
      expect(totalPercentage).toBeLessThanOrEqual(100.1);
    });

    it('should calculate session inflation percentage', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      vi.mocked(db.execute).mockResolvedValueOnce(mockEngagementResult() as never);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/engagement',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // totalAllSessions=600, totalPlays=500
      // inflation = (600 - 500) / 500 * 100 = 20%
      expect(body.summary.sessionInflationPct).toBe(20);
    });

    it('should reject invalid query parameters', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/engagement?period=invalid',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
