/**
 * Debug routes unit tests
 *
 * Tests the hidden debug API endpoints (owner-only):
 * - GET /debug/stats - Database statistics
 * - DELETE /debug/sessions - Clear all sessions
 * - DELETE /debug/violations - Clear all violations
 * - DELETE /debug/users - Clear all non-owner users
 * - DELETE /debug/servers - Clear all servers
 * - DELETE /debug/automations - Clear all automations
 * - POST /debug/reset - Full factory reset
 * - POST /debug/refresh-aggregates - Refresh TimescaleDB aggregates
 * - GET /debug/env - Safe environment info
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import type { Redis } from 'ioredis';
import { queryChain, renderCall } from '../../test/helpers.js';

// Mock the database module
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock('../../lib/auth.js', () => ({
  getAuth: vi.fn(),
}));

vi.mock('../mobile.js', () => ({
  revokeMobileDeviceSession: vi.fn(),
}));

vi.mock('../../services/notifications/destinationStore.js', () => ({
  invalidateDestinationsCache: vi.fn(),
  publishDestinationsChanged: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../services/notifications/destinationsMigration.js', () => ({
  seedBuiltinDestinations: vi.fn(),
}));

vi.mock('../../services/import/siloHistory.js', () => ({
  clearHistoryCursor: vi.fn(),
}));

// Import mocked db and routes
import { db } from '../../db/client.js';
import { destinations } from '../../db/schema.js';
import { getAuth } from '../../lib/auth.js';
import { revokeMobileDeviceSession } from '../mobile.js';
import { seedBuiltinDestinations } from '../../services/notifications/destinationsMigration.js';
import { clearHistoryCursor } from '../../services/import/siloHistory.js';
import { debugRoutes } from '../debug.js';
import { permissionGuard } from '../../lib/scope.js';

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
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: unknown, reply: FastifyReply) => {
    (request as { user: AuthUser }).user = authUser;
    if (authUser.role !== 'owner') return reply.forbidden('Owner access required');
  });

  // Mock redis (cast to satisfy ioredis type)
  app.decorate('redis', {
    info: async () => 'redis_version:7.0.0\r\nused_memory:1000000\r\n',
    status: 'ready',
  } as unknown as Redis);

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
    role: 'member',
    serverIds: [randomUUID()],
  };
}

/**
 * Create a mock for db.select() with count queries (Promise.all pattern).
 * Returns the chains in call order so a test can render the WHERE one was handed.
 */
function mockDbSelectCounts(counts: number[]): any[] {
  const chains: any[] = [];
  let callIndex = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const chain = queryChain(vi.fn, [{ count: counts[callIndex++] ?? 0 }]);
    chains.push(chain);
    return chain as never;
  });
  return chains;
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
 * Create a mock for db.select().from() resolving directly (no .where()) -
 * matches the auth_sessions and mobile_sessions reads in debug.ts.
 */
function mockDbSelectFrom(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockResolvedValue(rows),
  } as never);
}

/** Stubs getAuth().$context.internalAdapter.deleteSessions for the reset route. */
function mockDeleteSessions(impl: (tokens: string[]) => Promise<void>) {
  vi.mocked(getAuth).mockReturnValue({
    $context: Promise.resolve({
      internalAdapter: { deleteSessions: vi.fn(impl) },
    }),
  } as unknown as ReturnType<typeof getAuth>);
}

describe('Debug Routes', () => {
  let app: FastifyInstance;
  const ownerUser = createOwnerUser();
  const viewerUser = createViewerUser();

  beforeEach(() => {
    vi.resetAllMocks();
    // Default execute mock — /debug/env calls db.execute(...).then() so it needs a promise
    vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
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
        { method: 'DELETE' as const, url: '/debug/automations' },
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

      // Mock count queries (sessions, violations, users, servers, rules, terminationLogs, libraryItems, plexAccounts)
      mockDbSelectCounts([100, 25, 50, 3, 10, 5, 1000, 2]);

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
        terminationLogs: 5,
        libraryItems: 1000,
        plexAccounts: 2,
      });
      expect(body.database.size).toBe('256 MB');
      expect(body.database.tables).toHaveLength(2);
    });

    it('counts only completed policy runs under violations', async () => {
      app = await buildTestApp(ownerUser);

      const chains = mockDbSelectCounts([0, 0, 0, 0, 0, 0, 0, 0]);
      mockDbExecute([{ rows: [{ size: '8 KB' }] }, { rows: [] }]);

      await app.inject({ method: 'GET', url: '/debug/stats' });

      const where = renderCall(chains[1]);
      expect(where.text).toContain('automation_runs.kind =');
      expect(where.text).toContain('automation_runs.outcome =');
      expect(where.params).toContain('policy');
      expect(where.params).toContain('completed');
    });

    it('handles empty database', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectCounts([0, 0, 0, 0, 0, 0, 0, 0]);
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
      vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, []) as never);

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
      expect(body.counts.terminationLogs).toBe(0);
      expect(body.counts.libraryItems).toBe(0);
      expect(body.counts.plexAccounts).toBe(0);
    });

    it('handles missing database size', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectCounts([100, 25, 50, 3, 10, 5, 1000, 2]);

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
      expect(clearHistoryCursor).toHaveBeenCalledExactlyOnceWith(app.redis);
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
      expect(clearHistoryCursor).toHaveBeenCalledExactlyOnceWith(app.redis);
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
      expect(clearHistoryCursor).toHaveBeenCalledExactlyOnceWith(app.redis);
    });
  });

  describe('DELETE /debug/automations', () => {
    it('deletes all automations and their runs first', async () => {
      app = await buildTestApp(ownerUser);

      // Runs first (no returning), then automations (with returning), then the
      // non-builtin templates (where clause, no returning).
      let deleteCallIndex = 0;
      vi.mocked(db.delete).mockImplementation(() => {
        deleteCallIndex++;
        if (deleteCallIndex === 1) return Promise.resolve() as never;
        if (deleteCallIndex === 2) {
          return {
            returning: vi.fn().mockResolvedValue([{ id: 'automation-1' }, { id: 'automation-2' }]),
          } as never;
        }
        return { where: vi.fn().mockResolvedValue(undefined) } as never;
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/automations',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.deleted).toBe(2);
      expect(db.delete).toHaveBeenCalledTimes(3);
    });
  });

  describe('DELETE /debug/mobile', () => {
    it('revokes each paired device before deleting sessions and tokens', async () => {
      app = await buildTestApp(ownerUser);

      const sessionRows = [
        { id: 's1', deviceId: 'device-aaa' },
        { id: 's2', deviceId: 'device-bbb' },
      ];
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockResolvedValue(sessionRows),
      } as never);
      vi.mocked(db.delete).mockReturnValue({
        returning: vi.fn().mockResolvedValue(sessionRows),
      } as never);
      vi.mocked(revokeMobileDeviceSession).mockResolvedValue(undefined);

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/mobile',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(revokeMobileDeviceSession).toHaveBeenCalledTimes(2);
      expect(revokeMobileDeviceSession).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        sessionRows[0]
      );
      expect(revokeMobileDeviceSession).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        sessionRows[1]
      );
    });

    it('handles no paired devices', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockResolvedValue([]),
      } as never);
      vi.mocked(db.delete).mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      } as never);

      const response = await app.inject({
        method: 'DELETE',
        url: '/debug/mobile',
      });

      expect(response.statusCode).toBe(200);
      expect(revokeMobileDeviceSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /debug/reset', () => {
    it('performs full factory reset when there are no existing sessions', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectFrom([]);
      vi.mocked(db.delete).mockReturnValue(Promise.resolve() as never);

      const response = await app.inject({
        method: 'POST',
        url: '/debug/reset',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain('Factory reset complete');
      expect(getAuth).not.toHaveBeenCalled();

      // Verify delete was called 15 times (violations, terminationLogs, sessions, rules,
      // destinations, notificationPreferences, mobileSessions, mobileTokens,
      // librarySnapshots, libraryItems, serverUsers, servers, plexAccounts, users, settings)
      expect(db.delete).toHaveBeenCalledTimes(15);
      expect(db.delete).toHaveBeenCalledWith(destinations);
      expect(seedBuiltinDestinations).toHaveBeenCalledTimes(1);
      expect(clearHistoryCursor).toHaveBeenCalledExactlyOnceWith(app.redis);
    });

    it('revokes every Better Auth session before deleting any row (ghost cookie rejected after reset)', async () => {
      app = await buildTestApp(ownerUser);

      const tokens = ['session-token-1', 'session-token-2', 'session-token-3'];
      mockDbSelectFrom(tokens.map((token) => ({ token })));

      const callOrder: string[] = [];
      let revokedTokens: string[] = [];
      mockDeleteSessions(async (t) => {
        revokedTokens = t;
        callOrder.push('deleteSessions');
      });
      vi.mocked(db.delete).mockImplementation(() => {
        callOrder.push('delete');
        return Promise.resolve() as never;
      });

      const response = await app.inject({
        method: 'POST',
        url: '/debug/reset',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);
      expect(revokedTokens).toEqual(tokens);
      expect(callOrder[0]).toBe('deleteSessions');
      expect(callOrder.slice(1).every((step) => step === 'delete')).toBe(true);
    });

    it('fails closed and deletes nothing when session revocation cannot reach Redis', async () => {
      app = await buildTestApp(ownerUser);

      mockDbSelectFrom([{ token: 'session-token-1' }]);
      mockDeleteSessions(async () => {
        throw new Error('Redis is unreachable');
      });
      vi.mocked(db.delete).mockReturnValue(Promise.resolve() as never);

      const response = await app.inject({
        method: 'POST',
        url: '/debug/reset',
      });

      expect(response.statusCode).toBe(500);
      expect(db.delete).not.toHaveBeenCalled();
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
      expect(body.message).toBe('Aggregates refreshed (last 7 days)');

      // One refresh per continuous aggregate defined in timescale.ts
      expect(db.execute).toHaveBeenCalledTimes(5);
    });

    it('handles individual aggregate refresh failure gracefully', async () => {
      app = await buildTestApp(ownerUser);

      // Individual aggregate failures are caught silently, allowing other aggregates to proceed
      vi.mocked(db.execute).mockRejectedValue(new Error('Aggregate not found'));

      const response = await app.inject({
        method: 'POST',
        url: '/debug/refresh-aggregates',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Still returns success because individual failures are handled gracefully
      expect(body.success).toBe(true);
      expect(body.message).toBe('Aggregates refreshed (last 7 days)');
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

      // Check memory usage format (formatBytes output e.g. "123.4 MB")
      expect(body.memoryUsage.heapUsed).toMatch(/^[\d.]+ \w+$/);
      expect(body.memoryUsage.rss).toMatch(/^[\d.]+ \w+$/);
    });

    it('masks sensitive environment variables', async () => {
      app = await buildTestApp(ownerUser);

      // Set env var temporarily
      process.env.CLAIM_CODE = 'secret-code';

      const response = await app.inject({
        method: 'GET',
        url: '/debug/env',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Should show [set] not the actual value
      expect(body.env.CLAIM_CODE).toBe('[set]');

      // Clean up
      delete process.env.CLAIM_CODE;
    });

    it('returns empty string for unset optional environment variables', async () => {
      app = await buildTestApp(ownerUser);

      // Ensure env vars are NOT set
      const origClaimCode = process.env.CLAIM_CODE;
      const origBasePath = process.env.BASE_PATH;
      delete process.env.CLAIM_CODE;
      delete process.env.BASE_PATH;

      const response = await app.inject({
        method: 'GET',
        url: '/debug/env',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Should return empty string for unset optional vars
      expect(body.env.CLAIM_CODE).toBe('');
      expect(body.env.BASE_PATH).toBe('');

      // Restore original values
      if (origClaimCode) process.env.CLAIM_CODE = origClaimCode;
      if (origBasePath) process.env.BASE_PATH = origBasePath;
    });
  });
});
