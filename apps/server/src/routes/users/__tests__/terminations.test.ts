/**
 * User Terminations routes tests
 *
 * Tests the API endpoint for user termination history:
 * - GET /:id/terminations - Get termination history for a user
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, TerminationTrigger, MediaType } from '@tracearr/shared';

// Mock the database module before importing routes
vi.mock('../../../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

// Import the mocked db and the routes
import { db } from '../../../db/client.js';
import { terminationsRoutes } from '../terminations.js';

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

  // Register routes under /users prefix (matching real app structure)
  await app.register(terminationsRoutes, { prefix: '/users' });

  return app;
}

/**
 * Create a mock termination log with joined data
 */
interface MockTerminationLog {
  id: string;
  sessionId: string;
  serverId: string;
  serverUserId: string;
  trigger: TerminationTrigger;
  triggeredByUserId: string | null;
  triggeredByUsername: string | null;
  ruleId: string | null;
  ruleName: string | null;
  violationId: string | null;
  reason: string | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: Date;
  mediaTitle: string | null;
  mediaType: MediaType | null;
}

function createTestTermination(overrides: Partial<MockTerminationLog> = {}): MockTerminationLog {
  return {
    id: overrides.id ?? randomUUID(),
    sessionId: overrides.sessionId ?? randomUUID(),
    serverId: overrides.serverId ?? randomUUID(),
    serverUserId: overrides.serverUserId ?? randomUUID(),
    trigger: overrides.trigger ?? 'manual',
    // Use 'in' check to allow explicit null values
    triggeredByUserId:
      'triggeredByUserId' in overrides ? overrides.triggeredByUserId! : randomUUID(),
    triggeredByUsername:
      'triggeredByUsername' in overrides ? overrides.triggeredByUsername! : 'admin',
    ruleId: overrides.ruleId ?? null,
    ruleName: overrides.ruleName ?? null,
    violationId: overrides.violationId ?? null,
    reason: overrides.reason ?? 'Test termination',
    success: overrides.success ?? true,
    errorMessage: overrides.errorMessage ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    mediaTitle: overrides.mediaTitle ?? 'Test Movie',
    mediaType: overrides.mediaType ?? 'movie',
  };
}

/**
 * Create a mock server user
 */
interface MockServerUser {
  id: string;
  serverId: string;
  username: string;
}

function createTestServerUser(overrides: Partial<MockServerUser> = {}): MockServerUser {
  return {
    id: overrides.id ?? randomUUID(),
    serverId: overrides.serverId ?? randomUUID(),
    username: overrides.username ?? 'testuser',
  };
}

/**
 * Create a mock owner auth user
 */
function createOwnerUser(serverIds: string[] = [randomUUID()]): AuthUser {
  return {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds,
  };
}

/**
 * Create a mock viewer auth user
 */
function createViewerUser(serverIds: string[] = [randomUUID()]): AuthUser {
  return {
    userId: randomUUID(),
    username: 'viewer',
    role: 'viewer',
    serverIds,
  };
}

/**
 * Helper to create mock chain for server user lookup
 */
function createServerUserSelectMock(resolvedValue: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(resolvedValue),
      }),
    }),
  };
}

/**
 * Helper to create mock chain for terminations query (3 leftJoins)
 */
function createTerminationsSelectMock(resolvedValue: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
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
  };
}

/**
 * Helper to create mock chain for count query
 */
function createCountSelectMock(count: number) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ count }]),
    }),
  };
}

describe('User Terminations Routes', () => {
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

  describe('GET /users/:id/terminations', () => {
    it('should return termination history for a user', async () => {
      const serverId = randomUUID();
      const serverUserId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);
      app = await buildTestApp(ownerUser);

      const serverUser = createTestServerUser({ id: serverUserId, serverId });
      const terminations = [
        createTestTermination({ serverUserId, serverId, trigger: 'manual' }),
        createTestTermination({ serverUserId, serverId, trigger: 'rule', ruleName: 'Max Streams' }),
      ];

      // Mock server user lookup
      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([serverUser]));
      // Mock terminations query
      mockDb.select.mockReturnValueOnce(createTerminationsSelectMock(terminations));
      // Mock count query
      mockDb.select.mockReturnValueOnce(createCountSelectMock(2));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${serverUserId}/terminations`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      expect(body.totalPages).toBe(1);
    });

    it('should apply pagination parameters', async () => {
      const serverId = randomUUID();
      const serverUserId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);
      app = await buildTestApp(ownerUser);

      const serverUser = createTestServerUser({ id: serverUserId, serverId });
      const terminations = [createTestTermination({ serverUserId, serverId })];

      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([serverUser]));
      mockDb.select.mockReturnValueOnce(createTerminationsSelectMock(terminations));
      mockDb.select.mockReturnValueOnce(createCountSelectMock(50));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${serverUserId}/terminations?page=2&pageSize=10`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.page).toBe(2);
      expect(body.pageSize).toBe(10);
      expect(body.total).toBe(50);
      expect(body.totalPages).toBe(5);
    });

    it('should return 404 for non-existent user', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      // Mock server user lookup returning empty
      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([]));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${randomUUID()}/terminations`,
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('User not found');
    });

    it('should return 403 when user lacks server access', async () => {
      const userServerId = randomUUID();
      const differentServerId = randomUUID();
      const serverUserId = randomUUID();

      // User has access to userServerId but serverUser belongs to differentServerId
      const viewerUser = createViewerUser([userServerId]);
      app = await buildTestApp(viewerUser);

      const serverUser = createTestServerUser({ id: serverUserId, serverId: differentServerId });

      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([serverUser]));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${serverUserId}/terminations`,
      });

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('You do not have access to this user');
    });

    it('should return 400 for invalid user ID', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/users/not-a-uuid/terminations',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Invalid user ID');
    });

    it('should return 400 for invalid pagination parameters', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: `/users/${randomUUID()}/terminations?page=-1`,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Invalid query parameters');
    });

    it('should return empty data when no terminations exist', async () => {
      const serverId = randomUUID();
      const serverUserId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);
      app = await buildTestApp(ownerUser);

      const serverUser = createTestServerUser({ id: serverUserId, serverId });

      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([serverUser]));
      mockDb.select.mockReturnValueOnce(createTerminationsSelectMock([]));
      mockDb.select.mockReturnValueOnce(createCountSelectMock(0));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${serverUserId}/terminations`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
      expect(body.totalPages).toBe(0);
    });

    it('should include manual termination details', async () => {
      const serverId = randomUUID();
      const serverUserId = randomUUID();
      const triggeredByUserId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);
      app = await buildTestApp(ownerUser);

      const serverUser = createTestServerUser({ id: serverUserId, serverId });
      const termination = createTestTermination({
        serverUserId,
        serverId,
        trigger: 'manual',
        triggeredByUserId,
        triggeredByUsername: 'admin_user',
        reason: 'User was streaming inappropriate content',
        ruleId: null,
        ruleName: null,
      });

      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([serverUser]));
      mockDb.select.mockReturnValueOnce(createTerminationsSelectMock([termination]));
      mockDb.select.mockReturnValueOnce(createCountSelectMock(1));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${serverUserId}/terminations`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data[0].trigger).toBe('manual');
      expect(body.data[0].triggeredByUsername).toBe('admin_user');
      expect(body.data[0].reason).toBe('User was streaming inappropriate content');
      expect(body.data[0].ruleId).toBeNull();
      expect(body.data[0].ruleName).toBeNull();
    });

    it('should include rule-triggered termination details', async () => {
      const serverId = randomUUID();
      const serverUserId = randomUUID();
      const ruleId = randomUUID();
      const violationId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);
      app = await buildTestApp(ownerUser);

      const serverUser = createTestServerUser({ id: serverUserId, serverId });
      const termination = createTestTermination({
        serverUserId,
        serverId,
        trigger: 'rule',
        triggeredByUserId: null,
        triggeredByUsername: null,
        ruleId,
        ruleName: 'Concurrent Streams Limit',
        violationId,
        reason: 'Exceeded maximum concurrent streams (3/2)',
      });

      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([serverUser]));
      mockDb.select.mockReturnValueOnce(createTerminationsSelectMock([termination]));
      mockDb.select.mockReturnValueOnce(createCountSelectMock(1));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${serverUserId}/terminations`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data[0].trigger).toBe('rule');
      expect(body.data[0].ruleId).toBe(ruleId);
      expect(body.data[0].ruleName).toBe('Concurrent Streams Limit');
      expect(body.data[0].violationId).toBe(violationId);
      expect(body.data[0].triggeredByUserId).toBeNull();
      expect(body.data[0].triggeredByUsername).toBeNull();
    });

    it('should include session media information', async () => {
      const serverId = randomUUID();
      const serverUserId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);
      app = await buildTestApp(ownerUser);

      const serverUser = createTestServerUser({ id: serverUserId, serverId });
      const termination = createTestTermination({
        serverUserId,
        serverId,
        mediaTitle: 'Breaking Bad S01E01',
        mediaType: 'episode',
      });

      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([serverUser]));
      mockDb.select.mockReturnValueOnce(createTerminationsSelectMock([termination]));
      mockDb.select.mockReturnValueOnce(createCountSelectMock(1));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${serverUserId}/terminations`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data[0].mediaTitle).toBe('Breaking Bad S01E01');
      expect(body.data[0].mediaType).toBe('episode');
    });

    it('should include failed termination details', async () => {
      const serverId = randomUUID();
      const serverUserId = randomUUID();
      const ownerUser = createOwnerUser([serverId]);
      app = await buildTestApp(ownerUser);

      const serverUser = createTestServerUser({ id: serverUserId, serverId });
      const termination = createTestTermination({
        serverUserId,
        serverId,
        success: false,
        errorMessage: 'Session already ended',
      });

      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([serverUser]));
      mockDb.select.mockReturnValueOnce(createTerminationsSelectMock([termination]));
      mockDb.select.mockReturnValueOnce(createCountSelectMock(1));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${serverUserId}/terminations`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data[0].success).toBe(false);
      expect(body.data[0].errorMessage).toBe('Session already ended');
    });

    it('should allow viewer with server access to see terminations', async () => {
      const serverId = randomUUID();
      const serverUserId = randomUUID();
      const viewerUser = createViewerUser([serverId]);
      app = await buildTestApp(viewerUser);

      const serverUser = createTestServerUser({ id: serverUserId, serverId });
      const terminations = [createTestTermination({ serverUserId, serverId })];

      mockDb.select.mockReturnValueOnce(createServerUserSelectMock([serverUser]));
      mockDb.select.mockReturnValueOnce(createTerminationsSelectMock(terminations));
      mockDb.select.mockReturnValueOnce(createCountSelectMock(1));

      const response = await app.inject({
        method: 'GET',
        url: `/users/${serverUserId}/terminations`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(1);
    });
  });
});
