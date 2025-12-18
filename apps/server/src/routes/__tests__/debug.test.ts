/**
 * Debug routes unit tests
 *
 * Tests the hidden debug API endpoints (owner-only):
 * - GET /debug/stats - Database statistics
 * - DELETE /debug/sessions - Clear all sessions
 * - DELETE /debug/violations - Clear all violations
 * - DELETE /debug/users - Clear all non-owner users
 * - DELETE /debug/servers - Clear all servers
 * - DELETE /debug/rules - Clear all rules
 * - POST /debug/reset - Full factory reset
 * - POST /debug/refresh-aggregates - Refresh TimescaleDB aggregates
 * - GET /debug/env - Safe environment info
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock the database module
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

// Import mocked db and routes
import { db } from '../../db/client.js';
import { debugRoutes } from '../debug.js';

/**
 * Build a test Fastify instance with mocked auth
 */
async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers
  await app.register(sensible);

  // Mock the authenticate decorator
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });

  // Register routes
  await app.register(debugRoutes, { prefix: '/debug' });

  return app;
}

/**
 * Create a mock owner auth user
 */
function createOwnerUser(): AuthUser {
  return {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [randomUUID()],
  };
}

/**
 * Create a mock viewer auth user (non-owner)
 */
function createViewerUser(): AuthUser {
  return {
    userId: randomUUID(),
    username: 'viewer',
    role: 'viewer',
    serverIds: [randomUUID()],
  };
}

/**
 * Create a mock for db.select() with count queries (Promise.all pattern)
 */
function mockDbSelectCounts(counts: number[]) {
  let callIndex = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const count = counts[callIndex++] ?? 0;
    return {
      from: vi.fn().mockReturnValue(Promise.resolve([{ count }])),
    } as never;
  });
}

/**
 * Create a mock for db.execute() for database size/table queries
 */
function mockDbExecute(results: unknown[]) {
  let callIndex = 0;
  vi.mocked(db.execute).mockImplementation(() => {
    const result = results[callIndex++] ?? { rows: [] };
    return Promise.resolve(result) as never;
  });
}

/**
 * Create a mock for db.delete()
 */
function mockDbDelete(deletedItems: { id: string }[]) {
  vi.mocked(db.delete).mockReturnValue({
    returning: vi.fn().mockResolvedValue(deletedItems),
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(deletedItems),
    }),
  } as never);
}

/**
 * Create a mock for db.select() for user queries
 */
function mockDbSelectUsers(users: { id: string }[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(users),
    }),
  } as never);
}

/**
 * Create a mock for db.update()
 */
function mockDbUpdate() {
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  } as never);
}

describe('Debug Routes', () => {
  let app: FastifyInstance;
  const ownerUser = createOwnerUser();
  const viewerUser = createViewerUser();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('Authorization', () => {
    it('allows owner access to debug routes', async () => {
      app = await buildTestApp(ownerUser);

      // Mock for GET /env (simplest endpoint)
      const response = await app.inject({
        method: 'GET',
        url: '/debug/env',
      });

      expect(response.statusCode).toBe(200);
    });

    it('rejects non-owner access with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/debug/env',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Owner access required');
    });

    it('rejects viewer from all debug endpoints', async () => {
      app = await buildTestApp(viewerUser);

      const endpoints = [
        { method: 'GET' as const, url: '/debug/stats' },
        { method: 'DELETE' as const, url: '/debug/sessions' },
        { method: 'DELETE' as const, url: '/debug/violations' },
        { method: 'DELETE' as const, url: '/debug/users' },
        { method: 'DELETE' as const, url: '/debug/servers' },
        { method: 'DELETE' as const, url: '/debug/rules' },
        { method: 'POST' as const, url: '/debug/reset' },
        { method: 'POST' as const, url: '/debug/refresh-aggregates' },
        { method: 'GET' as const, url: '/debug/env' },
      ];

      for (const { method, url } of endpoints) {
        const response = await app.inject({ method, url });
        expect(response.statusCode).toBe(403);
      }
    });
  });

  describe('GET /debug/stats', () => {
    it('returns database statistics', async () => {
      app = await buildTestApp(ownerUser);

      // Mock count queries
      mockDbSelectCounts([100, 25, 50, 3, 10]);

      // Mock execute for database size and table sizes
      mockDbExecute([
        { rows: [{ size: '256 MB' }] },
        {
          rows: [
            { table_name: 'sessions', total_size: '128 MB' },
            { table_name: 'users', total_size: '64 MB' },
          ],
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/debug/stats',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.counts).toEqual({
        sessions: 100,
        violations: 25,
        users: 50,
        servers: 3,
        rules: 10,
      });
      expect(body.database.size).toBe('256 MB');
      expect(body.database.tables).toHaveLength(2);
    });

    it('handles empty database', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectCounts([0, 0, 0, 0, 0]);
      mockDbExecute([{ rows: [{ size: '8 KB' }] }, { rows: [] }]);

      const response = await app.inject({
        method: 'GET',
        url: '/debug/stats',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.counts.sessions).toBe(0);
      expect(body.counts.violations).toBe(0);
      expect(body.counts.users).toBe(0);
      expect(body.counts.servers).toBe(0);
      expect(body.counts.rules).toBe(0);
    });

    it('handles missing count values (undefined)', async () => {
      app = await buildTestApp(ownerUser);

      // Mock count queries returning empty arrays (undefined count)
      vi.mocked(db.select).mockImplementation(() => {
        return {
          from: vi.fn().mockReturnValue(Promise.resolve([])), // Empty array, no count property
        } as never;
      });

      mockDbExecute([{ rows: [{ size: '8 KB' }] }, { rows: [] }]);

      const response = await app.inject({
        method: 'GET',
        url: '/debug/stats',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Should fallback to 0 for all counts
      expect(body.counts.sessions).toBe(0);
      expect(body.counts.violations).toBe(0);
      expect(body.counts.users).toBe(0);
      expect(body.counts.servers).toBe(0);
      expect(body.counts.rules).toBe(0);
    });

    it('handles missing database size', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectCounts([100, 25, 50, 3, 10]);

      // Mock execute with empty rows for database size
      mockDbExecute([
        { rows: [] }, // No size row
        { rows: [] },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/debug/stats',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.database.size).toBe('unknown');
    });
  });

  describe('DELETE /debug/sessions', () => {
    it('deletes all sessions and violations', async () => {
      app = await buildTestApp(ownerUser);

      // Mock delete for violations first, then sessions
      let deleteCallIndex = 0;
      vi.mocked(db.delete).mockImplementation(() => {
        const items =
          deleteCallIndex === 0
            ? [{ id: 'v1' }, { id: 'v2' }] // violations
            : [{ id: 's1' }, { id: 's2' }, { id: 's3' }]; // sessions
        deleteCallIndex++;
        return {
          returning: vi.fn().mockResolvedValue(items),
        } as never;
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/sessions',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.deleted.sessions).toBe(3);
      expect(body.deleted.violations).toBe(2);
    });

    it('handles no sessions to delete', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.delete).mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      } as never);

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/sessions',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.deleted.sessions).toBe(0);
      expect(body.deleted.violations).toBe(0);
    });
  });

  describe('DELETE /debug/violations', () => {
    it('deletes all violations', async () => {
      app = await buildTestApp(ownerUser);

      mockDbDelete([{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }]);

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/violations',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(3);
    });

    it('handles no violations to delete', async () => {
      app = await buildTestApp(ownerUser);

      mockDbDelete([]);

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/violations',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(0);
    });
  });

  describe('DELETE /debug/users', () => {
    it('deletes non-owner users', async () => {
      app = await buildTestApp(ownerUser);

      // Mock select to find non-owner users
      mockDbSelectUsers([{ id: 'user-1' }, { id: 'user-2' }]);

      // Mock delete operations
      let deleteCallIndex = 0;
      vi.mocked(db.delete).mockImplementation(() => {
        const result =
          deleteCallIndex < 2
            ? { where: vi.fn().mockResolvedValue(undefined) }
            : {
                where: vi.fn().mockReturnValue({
                  returning: vi.fn().mockResolvedValue([{ id: 'user-1' }, { id: 'user-2' }]),
                }),
              };
        deleteCallIndex++;
        return result as never;
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/users',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(2);
    });

    it('handles no non-owner users', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectUsers([]);

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/users',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(0);
    });
  });

  describe('DELETE /debug/servers', () => {
    it('deletes all servers', async () => {
      app = await buildTestApp(ownerUser);

      mockDbDelete([{ id: 'server-1' }, { id: 'server-2' }]);

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/servers',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(2);
    });
  });

  describe('DELETE /debug/rules', () => {
    it('deletes all rules and violations first', async () => {
      app = await buildTestApp(ownerUser);

      // Mock delete - first for violations (no returning), then for rules (with returning)
      let deleteCallIndex = 0;
      vi.mocked(db.delete).mockImplementation(() => {
        deleteCallIndex++;
        if (deleteCallIndex === 1) {
          // violations - just resolves
          return Promise.resolve() as never;
        } else {
          // rules - returns deleted items
          return {
            returning: vi.fn().mockResolvedValue([{ id: 'rule-1' }, { id: 'rule-2' }]),
          } as never;
        }
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/rules',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(2);
    });
  });

  describe('POST /debug/reset', () => {
    it('performs full factory reset', async () => {
      app = await buildTestApp(ownerUser);

      // Mock all delete operations
      vi.mocked(db.delete).mockReturnValue(Promise.resolve() as never);

      // Mock update for settings reset
      mockDbUpdate();

      const response = await app.inject({
        method: 'POST',
        url: '/debug/reset',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('Factory reset complete');

      // Verify delete was called 11 times (violations, terminationLogs, sessions, rules,
      // notificationChannelRouting, notificationPreferences, mobileSessions, mobileTokens,
      // serverUsers, users, servers)
      expect(db.delete).toHaveBeenCalledTimes(11);

      // Verify settings update was called
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('POST /debug/refresh-aggregates', () => {
    it('refreshes continuous aggregates successfully', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/debug/refresh-aggregates',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe('Aggregates refreshed');

      // Should call execute twice (hourly_stats and daily_stats)
      expect(db.execute).toHaveBeenCalledTimes(2);
    });

    it('handles aggregate refresh failure gracefully', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.execute).mockRejectedValue(new Error('Aggregates not configured'));

      const response = await app.inject({
        method: 'POST',
        url: '/debug/refresh-aggregates',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(false);
      expect(body.message).toContain('not configured or refresh failed');
    });
  });

  describe('GET /debug/env', () => {
    it('returns safe environment info', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/debug/env',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Check structure
      expect(body).toHaveProperty('nodeVersion');
      expect(body).toHaveProperty('platform');
      expect(body).toHaveProperty('arch');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('memoryUsage');
      expect(body).toHaveProperty('env');

      // Check memory usage format
      expect(body.memoryUsage.heapUsed).toMatch(/^\d+ MB$/);
      expect(body.memoryUsage.heapTotal).toMatch(/^\d+ MB$/);
      expect(body.memoryUsage.rss).toMatch(/^\d+ MB$/);

      // Check env does not expose secrets
      expect(body.env.DATABASE_URL).toMatch(/^\[(set|not set)\]$/);
      expect(body.env.REDIS_URL).toMatch(/^\[(set|not set)\]$/);
      expect(body.env.ENCRYPTION_KEY).toMatch(/^\[(set|not set)\]$/);
    });

    it('masks sensitive environment variables', async () => {
      app = await buildTestApp(ownerUser);

      // Set env vars temporarily
      process.env.DATABASE_URL = 'postgres://secret:password@localhost/db';
      process.env.REDIS_URL = 'redis://secret@localhost:6379';

      const response = await app.inject({
        method: 'GET',
        url: '/debug/env',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Should show [set] not the actual values
      expect(body.env.DATABASE_URL).toBe('[set]');
      expect(body.env.REDIS_URL).toBe('[set]');

      // Clean up
      delete process.env.DATABASE_URL;
      delete process.env.REDIS_URL;
    });

    it('shows [not set] for unset environment variables', async () => {
      app = await buildTestApp(ownerUser);

      // Ensure env vars are NOT set
      const origDbUrl = process.env.DATABASE_URL;
      const origRedisUrl = process.env.REDIS_URL;
      const origEncKey = process.env.ENCRYPTION_KEY;
      delete process.env.DATABASE_URL;
      delete process.env.REDIS_URL;
      delete process.env.ENCRYPTION_KEY;

      const response = await app.inject({
        method: 'GET',
        url: '/debug/env',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Should show [not set] for unset env vars
      expect(body.env.DATABASE_URL).toBe('[not set]');
      expect(body.env.REDIS_URL).toBe('[not set]');
      expect(body.env.ENCRYPTION_KEY).toBe('[not set]');

      // Restore original values
      if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
      if (origRedisUrl) process.env.REDIS_URL = origRedisUrl;
      if (origEncKey) process.env.ENCRYPTION_KEY = origEncKey;
    });
  });
});
