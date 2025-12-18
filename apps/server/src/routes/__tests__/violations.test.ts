/**
 * Violation routes integration tests
 *
 * Tests the API endpoints for violation operations:
 * - GET /violations - List violations with pagination and filters
 * - GET /violations/:id - Get a specific violation
 * - PATCH /violations/:id - Acknowledge a violation
 * - DELETE /violations/:id - Dismiss (delete) a violation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, ViolationSeverity } from '@tracearr/shared';

// Mock the database module before importing routes
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  },
}));

// Import the mocked db and the routes
import { db } from '../../db/client.js';
import { violationRoutes } from '../violations.js';

/**
 * Build a test Fastify instance with mocked auth
 */
async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers
  await app.register(sensible);

  // Mock the authenticate decorator
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });

  // Register routes
  await app.register(violationRoutes, { prefix: '/violations' });

  return app;
}

/**
 * Create a mock violation with joined data (as returned by routes)
 */
interface MockViolationWithJoins {
  id: string;
  ruleId: string;
  ruleName: string;
  ruleType: string;
  serverUserId: string;
  username: string;
  userThumb: string | null;
  identityName: string | null;
  serverId: string;
  serverName: string;
  sessionId: string;
  mediaTitle: string;
  severity: ViolationSeverity;
  data: Record<string, unknown>;
  createdAt: Date;
  acknowledgedAt: Date | null;
  ipAddress?: string;
  geoCity?: string | null;
  geoCountry?: string | null;
  playerName?: string | null;
  platform?: string | null;
}

function createTestViolation(
  overrides: Partial<MockViolationWithJoins> = {}
): MockViolationWithJoins {
  const serverId = overrides.serverId ?? randomUUID();
  return {
    id: overrides.id ?? randomUUID(),
    ruleId: overrides.ruleId ?? randomUUID(),
    ruleName: overrides.ruleName ?? 'Test Rule',
    ruleType: overrides.ruleType ?? 'concurrent_streams',
    serverUserId: overrides.serverUserId ?? randomUUID(),
    username: overrides.username ?? 'testuser',
    userThumb: overrides.userThumb ?? null,
    identityName: overrides.identityName ?? null,
    serverId,
    serverName: overrides.serverName ?? 'Test Server',
    sessionId: overrides.sessionId ?? randomUUID(),
    mediaTitle: overrides.mediaTitle ?? 'Test Movie',
    severity: overrides.severity ?? 'warning',
    data: overrides.data ?? { maxStreams: 3, actualStreams: 4 },
    createdAt: overrides.createdAt ?? new Date(),
    acknowledgedAt: overrides.acknowledgedAt ?? null,
    ipAddress: overrides.ipAddress ?? '192.168.1.1',
    geoCity: overrides.geoCity ?? 'New York',
    geoCountry: overrides.geoCountry ?? 'US',
    playerName: overrides.playerName ?? 'Test Player',
    platform: overrides.platform ?? 'Windows',
  };
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
 * Helper to create the mock chain for violation queries with 5 innerJoins
 * (rules, serverUsers, users, servers, sessions)
 */
function createViolationSelectMock(resolvedValue: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockReturnValue({
                    limit: vi.fn().mockReturnValue({
                      offset: vi.fn().mockResolvedValue(resolvedValue),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

/**
 * Helper to create the mock chain for single violation queries (GET /:id)
 * with 5 innerJoins (rules, serverUsers, users, servers, sessions)
 */
function createSingleViolationSelectMock(resolvedValue: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue(resolvedValue),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

/**
 * Helper to create mock for violation existence check (PATCH/DELETE)
 * Uses serverUsers join for server access check
 */
function createViolationExistsCheckMock(resolvedValue: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(resolvedValue),
        }),
      }),
    }),
  };
}

describe('Violation Routes', () => {
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

  describe('GET /violations', () => {
    it('should return list of violations for owner', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const testViolations = [
        createTestViolation({ severity: 'high' }),
        createTestViolation({ severity: 'warning' }),
        createTestViolation({ severity: 'low' }),
      ];

      // Mock the violations query (4 innerJoins)
      mockDb.select.mockReturnValueOnce(createViolationSelectMock(testViolations));

      // Mock the count query (uses db.execute with raw SQL)
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 3 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/violations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(3);
      expect(body.total).toBe(3);
      expect(body.page).toBe(1);
    });

    it('should apply default pagination', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      mockDb.select.mockReturnValueOnce(createViolationSelectMock([]));
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 0 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/violations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20); // Schema default is 20
    });

    it('should accept pagination parameters', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      mockDb.select.mockReturnValueOnce(createViolationSelectMock([]));
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 100 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/violations?page=3&pageSize=25',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.page).toBe(3);
      expect(body.pageSize).toBe(25);
      expect(body.totalPages).toBe(4);
    });

    it('should filter by severity', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const highSeverityViolations = [createTestViolation({ severity: 'high' })];

      mockDb.select.mockReturnValueOnce(createViolationSelectMock(highSeverityViolations));
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/violations?severity=high',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].severity).toBe('high');
    });

    it('should filter by acknowledged status', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const unacknowledgedViolations = [createTestViolation({ acknowledgedAt: null })];

      mockDb.select.mockReturnValueOnce(createViolationSelectMock(unacknowledgedViolations));
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/violations?acknowledged=false',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].acknowledgedAt).toBeNull();
    });

    it('should filter by serverUserId', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const serverUserId = randomUUID();
      const userViolations = [createTestViolation({ serverUserId })];

      mockDb.select.mockReturnValueOnce(createViolationSelectMock(userViolations));
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const response = await app.inject({
        method: 'GET',
        url: `/violations?serverUserId=${serverUserId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
    });

    it('should filter by ruleId', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const ruleId = randomUUID();
      const ruleViolations = [createTestViolation({ ruleId })];

      mockDb.select.mockReturnValueOnce(createViolationSelectMock(ruleViolations));
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const response = await app.inject({
        method: 'GET',
        url: `/violations?ruleId=${ruleId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
    });

    it('should reject invalid severity filter', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/violations?severity=critical',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject pageSize over 100', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/violations?pageSize=101',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return empty data for viewers with no server access', async () => {
      // Viewer with empty serverIds returns empty result without querying
      const viewerUser: AuthUser = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [],
      };
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/violations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  describe('GET /violations/:id', () => {
    it('should return a specific violation', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const testViolation = createTestViolation({ id: violationId });

      mockDb.select.mockReturnValue(createSingleViolationSelectMock([testViolation]));

      const response = await app.inject({
        method: 'GET',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(violationId);
      expect(body.ruleName).toBe('Test Rule');
      expect(body.username).toBe('testuser');
      expect(body.serverName).toBe('Test Server');
    });

    it('should return 404 for non-existent violation', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      mockDb.select.mockReturnValue(createSingleViolationSelectMock([]));

      const response = await app.inject({
        method: 'GET',
        url: `/violations/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should reject invalid UUID', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/violations/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return violation with session details', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const testViolation = createTestViolation({
        id: violationId,
        ipAddress: '10.0.0.1',
        geoCity: 'Los Angeles',
        geoCountry: 'US',
        playerName: 'Plex Player',
        platform: 'macOS',
      });

      mockDb.select.mockReturnValue(createSingleViolationSelectMock([testViolation]));

      const response = await app.inject({
        method: 'GET',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ipAddress).toBe('10.0.0.1');
      expect(body.geoCity).toBe('Los Angeles');
      expect(body.geoCountry).toBe('US');
      expect(body.playerName).toBe('Plex Player');
      expect(body.platform).toBe('macOS');
    });
  });

  describe('PATCH /violations/:id', () => {
    it('should acknowledge violation for owner', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const serverId = ownerUser.serverIds[0];
      const acknowledgedAt = new Date();

      // Violation exists check with serverUsers join
      mockDb.select.mockReturnValue(
        createViolationExistsCheckMock([{ id: violationId, serverId }])
      );

      // Update
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: violationId, acknowledgedAt }]),
          }),
        }),
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.acknowledgedAt).toBeDefined();
    });

    it('should reject acknowledgment for non-owner', async () => {
      const guestUser = createViewerUser();
      app = await buildTestApp(guestUser);

      const response = await app.inject({
        method: 'PATCH',
        url: `/violations/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 404 for non-existent violation', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      mockDb.select.mockReturnValue(createViolationExistsCheckMock([]));

      const response = await app.inject({
        method: 'PATCH',
        url: `/violations/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should reject invalid UUID', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/violations/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });

    it('should handle update failure gracefully', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const serverId = ownerUser.serverIds[0];

      // Violation exists check
      mockDb.select.mockReturnValue(
        createViolationExistsCheckMock([{ id: violationId, serverId }])
      );

      // Update returns empty (failure)
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('DELETE /violations/:id', () => {
    it('should delete violation for owner', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const serverUserId = randomUUID();
      const serverId = ownerUser.serverIds[0];

      // Violation exists check with serverUsers join - now includes severity and serverUserId
      mockDb.select.mockReturnValue(
        createViolationExistsCheckMock([
          {
            id: violationId,
            severity: 'warning',
            serverUserId,
            serverId,
          },
        ])
      );

      // Mock transaction for delete + trust score restore
      mockDb.transaction = vi
        .fn()
        .mockImplementation(async (callback: (tx: any) => Promise<void>) => {
          const txMock = {
            delete: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
            update: vi.fn().mockReturnValue({
              set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
              }),
            }),
          };
          return callback(txMock);
        });

      const response = await app.inject({
        method: 'DELETE',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('should restore trust score when deleting violation', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const serverUserId = randomUUID();
      const serverId = ownerUser.serverIds[0];

      // Test with high severity (penalty: 20)
      mockDb.select.mockReturnValue(
        createViolationExistsCheckMock([
          {
            id: violationId,
            severity: 'high',
            serverUserId,
            serverId,
          },
        ])
      );

      // Track transaction calls
      const deleteMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const updateMock = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      mockDb.transaction = vi
        .fn()
        .mockImplementation(async (callback: (tx: any) => Promise<void>) => {
          const txMock = {
            delete: deleteMock,
            update: updateMock,
          };
          return callback(txMock);
        });

      const response = await app.inject({
        method: 'DELETE',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      // Verify transaction was called
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      // Verify delete and update were called in transaction
      expect(deleteMock).toHaveBeenCalled();
      expect(updateMock).toHaveBeenCalled();
    });

    it('should reject delete for non-owner', async () => {
      const guestUser = createViewerUser();
      app = await buildTestApp(guestUser);

      const response = await app.inject({
        method: 'DELETE',
        url: `/violations/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 404 for non-existent violation', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      mockDb.select.mockReturnValue(createViolationExistsCheckMock([]));

      const response = await app.inject({
        method: 'DELETE',
        url: `/violations/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should reject invalid UUID', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'DELETE',
        url: '/violations/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Authorization', () => {
    it('should allow owner to see all violations', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const testViolations = [
        createTestViolation({ serverUserId: randomUUID() }),
        createTestViolation({ serverUserId: randomUUID() }),
      ];

      mockDb.select.mockReturnValueOnce(createViolationSelectMock(testViolations));
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 2 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/violations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(2);
    });

    it('should filter violations by server access for viewers', async () => {
      const viewerServerId = randomUUID();
      const viewerUser: AuthUser = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [viewerServerId],
      };
      app = await buildTestApp(viewerUser);

      // Return violations from the viewer's accessible server
      const testViolations = [createTestViolation({ serverId: viewerServerId })];

      mockDb.select.mockReturnValueOnce(createViolationSelectMock(testViolations));
      mockDb.execute.mockResolvedValueOnce({ rows: [{ count: 1 }] });

      const response = await app.inject({
        method: 'GET',
        url: '/violations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].user.serverId).toBe(viewerServerId);
    });
  });
});
