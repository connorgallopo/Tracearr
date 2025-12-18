/**
 * Mobile routes unit tests
 *
 * Tests the API endpoints for mobile app functionality:
 *
 * Settings endpoints (owner only):
 * - GET /mobile - Get mobile config
 * - POST /mobile/enable - Enable mobile access
 * - POST /mobile/pair-token - Generate one-time pairing token
 * - POST /mobile/disable - Disable mobile access
 * - DELETE /mobile/sessions - Revoke all mobile sessions
 * - DELETE /mobile/sessions/:id - Revoke single mobile session
 *
 * Auth endpoints (mobile app):
 * - POST /mobile/pair - Exchange pairing token for JWT
 * - POST /mobile/refresh - Refresh mobile JWT
 * - POST /mobile/push-token - Register push token
 *
 * Stream management (admin/owner via mobile):
 * - POST /mobile/streams/:id/terminate - Terminate a playback session
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
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

// Mock the termination service
vi.mock('../../services/termination.js', () => ({
  terminateSession: vi.fn(),
}));

// Import mocked db, routes, and termination service
import { db } from '../../db/client.js';
import { mobileRoutes } from '../mobile.js';
import { terminateSession } from '../../services/termination.js';

// Mock Redis
const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  setex: vi.fn(),
  del: vi.fn(),
  eval: vi.fn(),
  ttl: vi.fn(),
};

// Mock JWT
const mockJwt = {
  sign: vi.fn(),
  verify: vi.fn(),
};

/**
 * Build a test Fastify instance with mocked auth and redis
 */
async function buildTestApp(authUser: AuthUser | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers
  await app.register(sensible);

  // Mock Redis decorator (cast to never for test mock)
  app.decorate('redis', mockRedis as never);

  // Mock JWT decorator (cast to never for test mock)
  app.decorate('jwt', mockJwt as never);

  // Mock the authenticate decorator
  app.decorate('authenticate', async (request: unknown) => {
    if (authUser) {
      (request as { user: AuthUser }).user = authUser;
    }
  });

  // Mock the requireMobile decorator (validates mobile JWT)
  app.decorate('requireMobile', async (request: unknown) => {
    if (authUser) {
      (request as { user: AuthUser }).user = authUser;
    }
  });

  // Register routes
  await app.register(mobileRoutes, { prefix: '/mobile' });

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
 * Create a mock mobile auth user (with deviceId)
 */
function createMobileUser(): AuthUser {
  return {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [randomUUID()],
    deviceId: 'device-123',
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
 * Create a mock mobile admin user (with deviceId)
 */
function createMobileAdminUser(serverId?: string): AuthUser {
  return {
    userId: randomUUID(),
    username: 'admin',
    role: 'admin',
    serverIds: serverId ? [serverId] : [randomUUID()],
    mobile: true,
    deviceId: 'device-admin-123',
  };
}

/**
 * Create a mock mobile viewer user (with deviceId)
 */
function createMobileViewerUser(serverId?: string): AuthUser {
  return {
    userId: randomUUID(),
    username: 'viewer',
    role: 'viewer',
    serverIds: serverId ? [serverId] : [randomUUID()],
    mobile: true,
    deviceId: 'device-viewer-123',
  };
}

/**
 * Create a mock mobile session
 */
function createMockSession(
  overrides?: Partial<{
    id: string;
    deviceName: string;
    deviceId: string;
    platform: 'ios' | 'android';
    refreshTokenHash: string;
    expoPushToken: string | null;
    deviceSecret: string | null;
    lastSeenAt: Date;
    createdAt: Date;
  }>
) {
  return {
    id: overrides?.id ?? randomUUID(),
    deviceName: overrides?.deviceName ?? 'iPhone 15',
    deviceId: overrides?.deviceId ?? 'device-123',
    platform: overrides?.platform ?? 'ios',
    refreshTokenHash: overrides?.refreshTokenHash ?? 'hash123',
    expoPushToken: overrides?.expoPushToken ?? null,
    deviceSecret: overrides?.deviceSecret ?? null,
    lastSeenAt: overrides?.lastSeenAt ?? new Date(),
    createdAt: overrides?.createdAt ?? new Date(),
  };
}

/**
 * Create a mock mobile token
 */
function createMockToken(
  overrides?: Partial<{
    id: string;
    tokenHash: string;
    expiresAt: Date;
    usedAt: Date | null;
    createdBy: string;
    createdAt: Date;
  }>
) {
  return {
    id: overrides?.id ?? randomUUID(),
    tokenHash: overrides?.tokenHash ?? 'tokenhash123',
    expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
    usedAt: overrides?.usedAt ?? null,
    createdBy: overrides?.createdBy ?? randomUUID(),
    createdAt: overrides?.createdAt ?? new Date(),
  };
}

describe('Mobile Routes', () => {
  let app: FastifyInstance;
  const ownerUser = createOwnerUser();
  const viewerUser = createViewerUser();
  const mobileUser = createMobileUser();

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.delete).mockReset();
    vi.mocked(db.transaction).mockReset();
    vi.mocked(terminateSession).mockReset();
    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.setex.mockReset();
    mockRedis.del.mockReset();
    mockRedis.eval.mockReset();
    mockRedis.ttl.mockReset();
    mockJwt.sign.mockReset();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  // ============================================
  // Settings endpoints (owner only)
  // ============================================

  describe('GET /mobile', () => {
    it('returns mobile config for owner', async () => {
      app = await buildTestApp(ownerUser);

      const mockSessions = [
        createMockSession(),
        createMockSession({ id: randomUUID(), deviceName: 'Pixel 8', platform: 'android' }),
      ];

      // Mock db.select chains
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Settings query
          return {
            from: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ mobileEnabled: true }]),
            }),
          } as never;
        } else if (selectCallCount === 2) {
          // Sessions query
          return {
            from: vi.fn().mockResolvedValue(mockSessions),
          } as never;
        } else if (selectCallCount === 3) {
          // Pending tokens count
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 1 }]),
            }),
          } as never;
        } else {
          // Server name query
          return {
            from: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ name: 'MyServer' }]),
            }),
          } as never;
        }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/mobile',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isEnabled).toBe(true);
      expect(body.sessions).toHaveLength(2);
      expect(body.serverName).toBe('MyServer');
      expect(body.pendingTokens).toBe(1);
      expect(body.maxDevices).toBe(5);
    });

    it('rejects non-owner access with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/mobile',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Only server owners can access mobile settings');
    });

    it('returns empty sessions when none exist', async () => {
      app = await buildTestApp(ownerUser);

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ mobileEnabled: false }]),
            }),
          } as never;
        } else if (selectCallCount === 2) {
          return { from: vi.fn().mockResolvedValue([]) } as never;
        } else if (selectCallCount === 3) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 0 }]),
            }),
          } as never;
        } else {
          return {
            from: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ name: 'Tracearr' }]),
            }),
          } as never;
        }
      });

      const response = await app.inject({
        method: 'GET',
        url: '/mobile',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isEnabled).toBe(false);
      expect(body.sessions).toHaveLength(0);
    });
  });

  describe('POST /mobile/enable', () => {
    it('enables mobile access for owner', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as never);

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockResolvedValue([]) } as never;
        } else {
          return {
            from: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ name: 'MyServer' }]),
            }),
          } as never;
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/enable',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isEnabled).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });

    it('rejects non-owner access with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/enable',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Only server owners can enable mobile access');
    });
  });

  describe('POST /mobile/pair-token', () => {
    it('generates pairing token for owner', async () => {
      app = await buildTestApp(ownerUser);

      // Mock settings check
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ mobileEnabled: true }]),
        }),
      } as never);

      // Mock rate limit check (Redis eval)
      mockRedis.eval.mockResolvedValue(1);

      // Mock transaction
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 0 }]),
            }),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
        };
        return callback(tx as never);
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair-token',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.token).toMatch(/^trr_mob_/);
      expect(body.expiresAt).toBeDefined();
    });

    it('rejects when mobile not enabled', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ mobileEnabled: false }]),
        }),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair-token',
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toBe('Mobile access is not enabled');
    });

    it('rejects when rate limited', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ mobileEnabled: true }]),
        }),
      } as never);

      mockRedis.eval.mockResolvedValue(4); // Exceeds limit of 3
      mockRedis.ttl.mockResolvedValue(120);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair-token',
      });

      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('120');
    });

    it('rejects non-owner access with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair-token',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Only server owners can generate pairing tokens');
    });

    it('rejects when max pending tokens reached', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ mobileEnabled: true }]),
        }),
      } as never);

      mockRedis.eval.mockResolvedValue(1);

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 3 }]), // Max pending tokens
            }),
          }),
        };
        return callback(tx as never);
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair-token',
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('Maximum of 3 pending tokens allowed');
    });
  });

  describe('POST /mobile/disable', () => {
    it('disables mobile access for owner', async () => {
      app = await buildTestApp(ownerUser);

      const mockSessions = [createMockSession()];

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as never);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockResolvedValue(mockSessions),
      } as never);

      vi.mocked(db.delete).mockReturnValue(Promise.resolve() as never);

      mockRedis.del.mockResolvedValue(1);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/disable',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(db.update).toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalled();
    });

    it('rejects non-owner access with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/disable',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Only server owners can disable mobile access');
    });
  });

  describe('DELETE /mobile/sessions', () => {
    it('revokes all mobile sessions for owner', async () => {
      app = await buildTestApp(ownerUser);

      const mockSessions = [
        createMockSession(),
        createMockSession({ id: randomUUID(), refreshTokenHash: 'hash456' }),
      ];

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockResolvedValue(mockSessions),
      } as never);

      vi.mocked(db.delete).mockReturnValue(Promise.resolve() as never);

      mockRedis.del.mockResolvedValue(1);

      const response = await app.inject({
        method: 'DELETE',
        url: '/mobile/sessions',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.revokedCount).toBe(2);
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });

    it('handles empty sessions gracefully', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockResolvedValue([]),
      } as never);

      vi.mocked(db.delete).mockReturnValue(Promise.resolve() as never);

      const response = await app.inject({
        method: 'DELETE',
        url: '/mobile/sessions',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.revokedCount).toBe(0);
    });

    it('rejects non-owner access with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'DELETE',
        url: '/mobile/sessions',
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('DELETE /mobile/sessions/:id', () => {
    it('revokes single mobile session for owner', async () => {
      app = await buildTestApp(ownerUser);

      const sessionId = randomUUID();
      const mockSession = createMockSession({ id: sessionId });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([mockSession]),
          }),
        }),
      } as never);

      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as never);

      mockRedis.del.mockResolvedValue(1);

      const response = await app.inject({
        method: 'DELETE',
        url: `/mobile/sessions/${sessionId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(mockRedis.del).toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns 404 for non-existent session', async () => {
      app = await buildTestApp(ownerUser);

      const sessionId = randomUUID();

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as never);

      const response = await app.inject({
        method: 'DELETE',
        url: `/mobile/sessions/${sessionId}`,
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.message).toBe('Mobile session not found');
    });

    it('rejects invalid session ID format', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'DELETE',
        url: '/mobile/sessions/invalid-id',
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toBe('Invalid session ID format');
    });

    it('rejects non-owner access with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'DELETE',
        url: `/mobile/sessions/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  // ============================================
  // Auth endpoints (mobile app)
  // ============================================

  describe('POST /mobile/pair', () => {
    const validPairPayload = {
      token: 'trr_mob_validtokenvalue12345678901234567890',
      deviceName: 'iPhone 15',
      deviceId: 'device-123',
      platform: 'ios',
    };

    it('exchanges valid pairing token for JWT', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1); // Rate limit OK

      // Mock device count check
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Sessions count
          return {
            from: vi.fn().mockResolvedValue([{ count: 0 }]),
          } as never;
        } else {
          // Existing session check
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          } as never;
        }
      });

      // Mock transaction with call tracking for different query patterns
      const mockOwner = { id: randomUUID(), username: 'owner', role: 'owner' };
      const mockServerId = randomUUID();
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        let txSelectCallCount = 0;
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockImplementation(() => {
            txSelectCallCount++;
            // Call 1: mobileTokens lookup with .where().for().limit()
            // Call 2: users lookup with .where().limit()
            // Call 3: servers lookup (id, name, type) - awaited directly, no .where() or .limit()
            if (txSelectCallCount === 3) {
              // tx.select({ id, name, type }).from(servers) - awaited directly
              return {
                from: vi
                  .fn()
                  .mockResolvedValue([{ id: mockServerId, name: 'MyServer', type: 'plex' }]),
              };
            }
            return {
              from: vi.fn().mockImplementation(() => ({
                where: vi.fn().mockImplementation(() => ({
                  for: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([createMockToken()]),
                  }),
                  limit: vi.fn().mockResolvedValue([mockOwner]),
                })),
                limit: vi.fn().mockResolvedValue([{ name: 'MyServer' }]),
              })),
            };
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return callback(tx as never);
      });

      mockJwt.sign.mockReturnValue('mock.jwt.token');
      mockRedis.setex.mockResolvedValue('OK');

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: validPairPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.accessToken).toBe('mock.jwt.token');
      expect(body.refreshToken).toBeDefined();
      expect(body.server.id).toBe(mockServerId);
      expect(body.server.name).toBe('MyServer');
      expect(body.server.type).toBe('plex');
      expect(body.user.role).toBe('owner');
    });

    it('rejects when rate limited', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(6); // Exceeds limit of 5
      mockRedis.ttl.mockResolvedValue(300);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: validPairPayload,
      });

      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('300');
    });

    it('rejects invalid token prefix', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: {
          ...validPairPayload,
          token: 'invalid_prefix_token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.message).toBe('Invalid mobile token');
    });

    it('rejects invalid request body', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: {
          token: 'trr_mob_valid',
          // Missing required fields
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toBe('Invalid pairing request');
    });

    it('rejects when max devices reached', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

      // Mock device count check - 5 devices (at limit)
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockResolvedValue([{ count: 5 }]),
          } as never;
        } else {
          // No existing session for this device
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          } as never;
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: validPairPayload,
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('Maximum of 5 devices allowed');
    });

    it('rejects expired token', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

      vi.mocked(db.select).mockImplementation(
        () =>
          ({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }) as never
      );

      // Mock transaction that throws TOKEN_EXPIRED
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockImplementation(() => ({
                for: vi.fn().mockReturnValue({
                  limit: vi
                    .fn()
                    .mockResolvedValue([
                      createMockToken({ expiresAt: new Date(Date.now() - 1000) }),
                    ]),
                }),
              })),
            })),
          })),
        };
        return callback(tx as never);
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: validPairPayload,
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.message).toBe('This pairing token has expired');
    });

    it('rejects already used token', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

      vi.mocked(db.select).mockImplementation(
        () =>
          ({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }) as never
      );

      // Mock transaction that throws TOKEN_ALREADY_USED
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockImplementation(() => ({
                for: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([createMockToken({ usedAt: new Date() })]),
                }),
              })),
            })),
          })),
        };
        return callback(tx as never);
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: validPairPayload,
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.message).toBe('This pairing token has already been used');
    });

    it('returns error when no owner account exists', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1); // Rate limit OK

      // Mock db.select() outside transaction:
      // Call 1: count sessions (db.select().from())
      // Call 2: existing session check (db.select().from().where().limit())
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Sessions count - returns { count: 0 }
          return {
            from: vi.fn().mockResolvedValue([{ count: 0 }]),
          } as never;
        } else {
          // Existing session check - no existing session
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          } as never;
        }
      });

      // Mock transaction that returns NO_OWNER error
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        let txSelectCallCount = 0;
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockImplementation(() => {
            txSelectCallCount++;
            if (txSelectCallCount === 1) {
              // Token lookup - valid token
              return {
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockReturnValue({
                    for: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue([createMockToken()]),
                    }),
                  }),
                }),
              };
            } else if (txSelectCallCount === 2) {
              // Owner lookup - no owner found
              return {
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([]),
                  }),
                }),
              };
            }
            return { from: vi.fn().mockResolvedValue([]) };
          }),
        };
        return callback(tx as never);
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: validPairPayload,
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.message).toBe('No owner account found');
    });

    it('returns error when token is invalid', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1); // Rate limit OK

      // Mock db.select() outside transaction
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockResolvedValue([{ count: 0 }]) } as never;
        } else {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          } as never;
        }
      });

      // Mock transaction that throws INVALID_TOKEN error (no token found)
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockImplementation(() => {
            // Token lookup returns empty array
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  for: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([]),
                  }),
                }),
              }),
            };
          }),
        };
        return callback(tx as never);
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: validPairPayload,
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.message).toBe('Invalid mobile token');
    });

    it('returns generic error for unexpected transaction failures', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1); // Rate limit OK

      // Mock db.select() outside transaction
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockResolvedValue([{ count: 0 }]) } as never;
        } else {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          } as never;
        }
      });

      // Mock transaction that throws an unexpected error
      vi.mocked(db.transaction).mockRejectedValue(new Error('Database connection lost'));

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: validPairPayload,
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.message).toBe('Pairing failed. Please try again.');
    });

    it('cleans up old refresh token when updating existing session', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1); // Rate limit OK

      const existingSessionId = randomUUID();
      const oldRefreshHash = 'old-refresh-token-hash-1234567890';

      // First select: device count
      // Second select: existing session check
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockResolvedValue([{ count: 1 }]) } as never;
        }
        // Existing session found
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: existingSessionId,
                  refreshTokenHash: oldRefreshHash,
                  deviceName: 'Old Device',
                  platform: 'ios',
                },
              ]),
            }),
          }),
        } as never;
      });

      const mockOwner = { id: randomUUID(), username: 'owner', role: 'owner' };
      const mockServerId = randomUUID();
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        let txSelectCallCount = 0;
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockImplementation(() => {
            txSelectCallCount++;
            if (txSelectCallCount === 3) {
              return {
                from: vi
                  .fn()
                  .mockResolvedValue([{ id: mockServerId, name: 'Server', type: 'plex' }]),
              };
            }
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  for: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([createMockToken()]),
                  }),
                  limit: vi.fn().mockResolvedValue([mockOwner]),
                }),
              }),
            };
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return callback(tx as never);
      });

      mockJwt.sign.mockReturnValue('mock.jwt.token');
      mockRedis.setex.mockResolvedValue('OK');
      mockRedis.del.mockResolvedValue(1);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/pair',
        payload: validPairPayload,
      });

      expect(response.statusCode).toBe(200);
      // Verify old refresh token was deleted from Redis
      expect(mockRedis.del).toHaveBeenCalledWith(`tracearr:mobile_refresh:${oldRefreshHash}`);
    });
  });

  describe('POST /mobile/refresh', () => {
    it('refreshes mobile JWT with valid refresh token', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1); // Rate limit OK
      mockRedis.get.mockResolvedValue(
        JSON.stringify({ userId: randomUUID(), deviceId: 'device-123' })
      );

      const mockUser = { id: randomUUID(), username: 'owner', role: 'owner' };
      const mockSession = createMockSession();

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // User query
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([mockUser]),
              }),
            }),
          } as never;
        } else if (selectCallCount === 2) {
          // Session query
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([mockSession]),
              }),
            }),
          } as never;
        } else {
          // Servers query
          return {
            from: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
          } as never;
        }
      });

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as never);

      mockJwt.sign.mockReturnValue('new.jwt.token');
      mockRedis.del.mockResolvedValue(1);
      mockRedis.setex.mockResolvedValue('OK');

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/refresh',
        payload: { refreshToken: 'valid-refresh-token' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.accessToken).toBe('new.jwt.token');
      expect(body.refreshToken).toBeDefined();
    });

    it('rejects when rate limited', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(31); // Exceeds limit of 30
      mockRedis.ttl.mockResolvedValue(600);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/refresh',
        payload: { refreshToken: 'any-token' },
      });

      expect(response.statusCode).toBe(429);
    });

    it('rejects invalid refresh token', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);
      mockRedis.get.mockResolvedValue(null); // Token not found in Redis

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/refresh',
        payload: { refreshToken: 'invalid-token' },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.message).toBe('Invalid or expired refresh token');
    });

    it('rejects when user no longer valid', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);
      mockRedis.get.mockResolvedValue(
        JSON.stringify({ userId: randomUUID(), deviceId: 'device-123' })
      );
      mockRedis.del.mockResolvedValue(1);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]), // User not found
          }),
        }),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/refresh',
        payload: { refreshToken: 'valid-token' },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.message).toBe('User no longer valid');
    });

    it('rejects when session has been revoked', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);
      mockRedis.get.mockResolvedValue(
        JSON.stringify({ userId: randomUUID(), deviceId: 'device-123' })
      );
      mockRedis.del.mockResolvedValue(1);

      const mockUser = { id: randomUUID(), username: 'owner', role: 'owner' };

      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([mockUser]),
              }),
            }),
          } as never;
        } else {
          // Session not found (revoked)
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          } as never;
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/refresh',
        payload: { refreshToken: 'valid-token' },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.message).toBe('Session has been revoked');
    });

    it('rejects invalid request body', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/refresh',
        payload: {}, // Missing refreshToken
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toBe('Invalid refresh request');
    });
  });

  describe('POST /mobile/push-token', () => {
    it('registers push token for mobile user', async () => {
      app = await buildTestApp(mobileUser);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
          }),
        }),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/push-token',
        payload: {
          expoPushToken: 'ExponentPushToken[abc123]',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.updatedSessions).toBe(1);
    });

    it('accepts device secret with push token', async () => {
      app = await buildTestApp(mobileUser);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
          }),
        }),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/push-token',
        payload: {
          expoPushToken: 'ExponentPushToken[abc123]',
          deviceSecret: 'a'.repeat(32), // 32 character secret
        },
      });

      expect(response.statusCode).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('rejects invalid push token format', async () => {
      app = await buildTestApp(mobileUser);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/push-token',
        payload: {
          expoPushToken: 'invalid-token-format',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('Invalid push token format');
    });

    it('rejects when deviceId missing from JWT', async () => {
      // Create user without deviceId
      const userWithoutDevice: AuthUser = {
        userId: randomUUID(),
        username: 'owner',
        role: 'owner',
        serverIds: [randomUUID()],
        // No deviceId
      };
      app = await buildTestApp(userWithoutDevice);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/push-token',
        payload: {
          expoPushToken: 'ExponentPushToken[abc123]',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('missing deviceId');
    });

    it('returns 404 when session not found', async () => {
      app = await buildTestApp(mobileUser);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]), // No session found
          }),
        }),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/push-token',
        payload: {
          expoPushToken: 'ExponentPushToken[abc123]',
        },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.message).toContain('No mobile session found');
    });
  });

  // ============================================================================
  // Stream Termination Tests
  // ============================================================================

  // ============================================
  // Beta Mode Tests
  // ============================================

  describe('MOBILE_BETA_MODE', () => {
    // Note: MOBILE_BETA_MODE is read at module load time from process.env
    // These tests verify the behavior differences are properly implemented
    // by testing the conditional paths in the code

    describe('when disabled (default)', () => {
      it('rejects already used token', async () => {
        app = await buildTestApp(null);

        mockRedis.eval.mockResolvedValue(1);

        vi.mocked(db.select).mockImplementation(
          () =>
            ({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }) as never
        );

        // Token with usedAt set should be rejected in normal mode
        vi.mocked(db.transaction).mockImplementation(async (callback) => {
          const tx = {
            execute: vi.fn().mockResolvedValue(undefined),
            select: vi.fn().mockImplementation(() => ({
              from: vi.fn().mockImplementation(() => ({
                where: vi.fn().mockImplementation(() => ({
                  for: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([createMockToken({ usedAt: new Date() })]),
                  }),
                })),
              })),
            })),
          };
          return callback(tx as never);
        });

        const response = await app.inject({
          method: 'POST',
          url: '/mobile/pair',
          payload: {
            token: 'trr_mob_validtokenvalue12345678901234567890',
            deviceName: 'iPhone 15',
            deviceId: 'device-123',
            platform: 'ios',
          },
        });

        expect(response.statusCode).toBe(401);
        const body = response.json();
        expect(body.message).toBe('This pairing token has already been used');
      });

      it('enforces max device limit', async () => {
        app = await buildTestApp(null);

        mockRedis.eval.mockResolvedValue(1);

        // Mock device count at limit (5)
        let selectCallCount = 0;
        vi.mocked(db.select).mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) {
            return {
              from: vi.fn().mockResolvedValue([{ count: 5 }]),
            } as never;
          } else {
            // No existing session for this device
            return {
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            } as never;
          }
        });

        const response = await app.inject({
          method: 'POST',
          url: '/mobile/pair',
          payload: {
            token: 'trr_mob_validtokenvalue12345678901234567890',
            deviceName: 'iPhone 15',
            deviceId: 'device-123',
            platform: 'ios',
          },
        });

        expect(response.statusCode).toBe(400);
        const body = response.json();
        expect(body.message).toContain('Maximum of 5 devices allowed');
      });

      it('token generation uses 15 minute expiry', async () => {
        app = await buildTestApp(ownerUser);

        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ mobileEnabled: true }]),
          }),
        } as never);

        mockRedis.eval.mockResolvedValue(1);

        let capturedExpiry: Date | null = null;
        vi.mocked(db.transaction).mockImplementation(async (callback) => {
          const tx = {
            execute: vi.fn().mockResolvedValue(undefined),
            select: vi.fn().mockReturnValue({
              from: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ count: 0 }]),
              }),
            }),
            insert: vi.fn().mockImplementation(() => ({
              values: vi.fn().mockImplementation((values: { expiresAt: Date }) => {
                capturedExpiry = values.expiresAt;
                return Promise.resolve(undefined);
              }),
            })),
          };
          return callback(tx as never);
        });

        const beforeRequest = Date.now();
        const response = await app.inject({
          method: 'POST',
          url: '/mobile/pair-token',
        });
        const afterRequest = Date.now();

        expect(response.statusCode).toBe(200);
        expect(capturedExpiry).not.toBeNull();

        // Token should expire in ~15 minutes (with some tolerance)
        const expiryMs = capturedExpiry!.getTime() - beforeRequest;
        const expectedExpiryMs = 15 * 60 * 1000;
        expect(expiryMs).toBeGreaterThanOrEqual(expectedExpiryMs - 1000);
        expect(expiryMs).toBeLessThanOrEqual(
          expectedExpiryMs + (afterRequest - beforeRequest) + 1000
        );
      });
    });

    // Integration tests for beta mode would require module reset with env var set
    // These are documented here for reference when running with MOBILE_BETA_MODE=true:
    //
    // describe('when enabled', () => {
    //   - Token expiry should be ~100 years (BETA_TOKEN_EXPIRY_YEARS)
    //   - Already-used tokens should still be accepted
    //   - Device limit should not be enforced (>5 devices allowed)
    //   - Server startup log should show beta mode warning
    // });
  });

  describe('POST /mobile/streams/:id/terminate', () => {
    const serverId = randomUUID();
    const sessionId = randomUUID();

    it('successfully terminates a session as owner', async () => {
      const ownerMobileUser = {
        ...createMobileUser(),
        serverIds: [serverId],
      };
      app = await buildTestApp(ownerMobileUser);

      // Mock session lookup
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: sessionId,
                serverId,
                serverUserId: randomUUID(),
                state: 'playing',
              },
            ]),
          }),
        }),
      } as never);

      // Mock termination service success
      vi.mocked(terminateSession).mockResolvedValue({
        success: true,
        terminationLogId: randomUUID(),
      });

      const response = await app.inject({
        method: 'POST',
        url: `/mobile/streams/${sessionId}/terminate`,
        payload: {
          reason: 'Testing termination',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
      expect(body.terminationLogId).toBeDefined();
      expect(body.message).toBe('Stream termination command sent successfully');

      // Verify terminateSession was called with correct args
      expect(terminateSession).toHaveBeenCalledWith({
        sessionId,
        trigger: 'manual',
        triggeredByUserId: ownerMobileUser.userId,
        reason: 'Testing termination',
      });
    });

    it('successfully terminates a session as admin', async () => {
      const adminMobileUser = createMobileAdminUser(serverId);
      app = await buildTestApp(adminMobileUser);

      // Mock session lookup
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: sessionId,
                serverId,
                serverUserId: randomUUID(),
                state: 'playing',
              },
            ]),
          }),
        }),
      } as never);

      // Mock termination service success
      vi.mocked(terminateSession).mockResolvedValue({
        success: true,
        terminationLogId: randomUUID(),
      });

      const response = await app.inject({
        method: 'POST',
        url: `/mobile/streams/${sessionId}/terminate`,
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.success).toBe(true);
    });

    it('returns 403 for viewer trying to terminate', async () => {
      const viewerMobileUser = createMobileViewerUser(serverId);
      app = await buildTestApp(viewerMobileUser);

      const response = await app.inject({
        method: 'POST',
        url: `/mobile/streams/${sessionId}/terminate`,
        payload: {},
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toContain('Only administrators can terminate');
    });

    it('returns 404 when session not found', async () => {
      const ownerMobileUser = {
        ...createMobileUser(),
        serverIds: [serverId],
      };
      app = await buildTestApp(ownerMobileUser);

      // Mock session lookup - no session found
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: `/mobile/streams/${sessionId}/terminate`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.message).toContain('Session not found');
    });

    it('returns 403 when user lacks server access', async () => {
      const otherServerId = randomUUID();
      // Use admin user (not owner) so server access is checked
      const adminMobileUser = createMobileAdminUser(otherServerId); // User has access to a different server
      app = await buildTestApp(adminMobileUser);

      // Mock session lookup - session exists but on different server
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: sessionId,
                serverId, // Session is on serverId, user has access to otherServerId
                serverUserId: randomUUID(),
                state: 'playing',
              },
            ]),
          }),
        }),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: `/mobile/streams/${sessionId}/terminate`,
        payload: {},
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toContain('do not have access to this server');
    });

    it('returns 409 when session already stopped', async () => {
      const ownerMobileUser = {
        ...createMobileUser(),
        serverIds: [serverId],
      };
      app = await buildTestApp(ownerMobileUser);

      // Mock session lookup - session already stopped
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: sessionId,
                serverId,
                serverUserId: randomUUID(),
                state: 'stopped',
              },
            ]),
          }),
        }),
      } as never);

      const response = await app.inject({
        method: 'POST',
        url: `/mobile/streams/${sessionId}/terminate`,
        payload: {},
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.message).toContain('already ended');
    });

    it('returns 500 when termination service fails', async () => {
      const ownerMobileUser = {
        ...createMobileUser(),
        serverIds: [serverId],
      };
      app = await buildTestApp(ownerMobileUser);

      // Mock session lookup
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: sessionId,
                serverId,
                serverUserId: randomUUID(),
                state: 'playing',
              },
            ]),
          }),
        }),
      } as never);

      // Mock termination service failure
      vi.mocked(terminateSession).mockResolvedValue({
        success: false,
        terminationLogId: randomUUID(),
        error: 'Media server connection failed',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/mobile/streams/${sessionId}/terminate`,
        payload: {},
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Media server connection failed');
      expect(body.terminationLogId).toBeDefined();
    });

    it('returns 400 for invalid session ID format', async () => {
      const ownerMobileUser = {
        ...createMobileUser(),
        serverIds: [serverId],
      };
      app = await buildTestApp(ownerMobileUser);

      const response = await app.inject({
        method: 'POST',
        url: '/mobile/streams/not-a-uuid/terminate',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('Invalid session ID');
    });

    it('returns 400 for reason exceeding max length', async () => {
      const ownerMobileUser = {
        ...createMobileUser(),
        serverIds: [serverId],
      };
      app = await buildTestApp(ownerMobileUser);

      const response = await app.inject({
        method: 'POST',
        url: `/mobile/streams/${sessionId}/terminate`,
        payload: {
          reason: 'a'.repeat(501), // Exceeds 500 char limit
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('Invalid request body');
    });
  });
});
