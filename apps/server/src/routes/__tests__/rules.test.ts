/**
 * Rule routes integration tests
 *
 * Tests the API endpoints for rule CRUD operations:
 * - GET /rules - List all rules
 * - POST /rules - Create a new rule
 * - GET /rules/:id - Get a specific rule
 * - PATCH /rules/:id - Update a rule
 * - DELETE /rules/:id - Delete a rule
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, Rule } from '@tracearr/shared';

// Mock the database module before importing routes
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Import the mocked db and the routes
import { db } from '../../db/client.js';
import { ruleRoutes } from '../rules.js';

/**
 * Build a test Fastify instance with mocked auth
 */
async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers (badRequest, notFound, etc.)
  await app.register(sensible);

  // Mock the authenticate decorator
  app.decorate('authenticate', async (request: any) => {
    request.user = authUser;
  });

  // Register routes
  await app.register(ruleRoutes, { prefix: '/rules' });

  return app;
}

/**
 * Create a mock rule object
 */
function createTestRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'Test Rule',
    type: overrides.type ?? 'concurrent_streams',
    params: overrides.params ?? { maxStreams: 3 },
    serverUserId: overrides.serverUserId ?? null,
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
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

describe('Rule Routes', () => {
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

  describe('GET /rules', () => {
    it('should return list of rules for owner', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const serverId = ownerUser.serverIds[0]; // Use owner's server
      const testRules = [
        createTestRule({ name: 'Rule 1' }), // Global rule
        createTestRule({ name: 'Rule 2', serverUserId: randomUUID() }), // User-specific rule
      ];

      // Mock the database chain (2 leftJoins: serverUsers and servers)
      // Rule 1 is global (no serverUserId), Rule 2 is user-specific with serverId
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                { ...testRules[0], username: null, serverId: null, serverName: null },
                { ...testRules[1], username: 'testuser', serverId, serverName: 'Test Server' },
              ]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/rules',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(2);
    });

    it('should filter user-specific rules for non-owners', async () => {
      const guestUser = createViewerUser();
      app = await buildTestApp(guestUser);

      const globalRule = createTestRule({ name: 'Global Rule', serverUserId: null });
      const userRule = createTestRule({ name: 'User Rule', serverUserId: randomUUID() });

      // Mock the database chain (2 leftJoins: serverUsers and servers)
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                { ...globalRule, username: null, serverId: null, serverName: null },
                {
                  ...userRule,
                  username: 'someone',
                  serverId: randomUUID(),
                  serverName: 'Test Server',
                },
              ]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/rules',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Guest should only see global rules
      expect(body.data).toHaveLength(1);
      expect(body.data[0].serverUserId).toBeNull();
    });
  });

  describe('POST /rules', () => {
    it('should create a rule for owner', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const newRule = createTestRule({
        name: 'New Rule',
        type: 'impossible_travel',
        params: { maxSpeedKmh: 500 },
      });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newRule]),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/rules',
        payload: {
          name: 'New Rule',
          type: 'impossible_travel',
          params: { maxSpeedKmh: 500 },
        },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.name).toBe('New Rule');
      expect(body.type).toBe('impossible_travel');
    });

    it('should reject rule creation for non-owner', async () => {
      const guestUser = createViewerUser();
      app = await buildTestApp(guestUser);

      const response = await app.inject({
        method: 'POST',
        url: '/rules',
        payload: {
          name: 'New Rule',
          type: 'concurrent_streams',
          params: { maxStreams: 3 },
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should reject invalid request body', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/rules',
        payload: {
          // Missing required fields
          name: '',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid rule type', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/rules',
        payload: {
          name: 'Test Rule',
          type: 'invalid_type',
          params: {},
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should verify serverUserId exists when provided', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const serverUserId = randomUUID();

      // Server user not found
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/rules',
        payload: {
          name: 'User Rule',
          type: 'concurrent_streams',
          params: { maxStreams: 3 },
          serverUserId,
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should create rule with valid serverUserId', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const serverUserId = randomUUID();
      const newRule = createTestRule({ serverUserId });

      // Server user exists
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: serverUserId }]),
          }),
        }),
      });

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newRule]),
        }),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/rules',
        payload: {
          name: 'User Rule',
          type: 'concurrent_streams',
          params: { maxStreams: 3 },
          serverUserId,
        },
      });

      expect(response.statusCode).toBe(201);
    });
  });

  describe('GET /rules/:id', () => {
    it('should return a specific rule', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const ruleId = randomUUID();
      const testRule = createTestRule({ id: ruleId });

      // Mock rule query (2 leftJoins: serverUsers and servers)
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi
                  .fn()
                  .mockResolvedValue([
                    { ...testRule, username: null, serverId: null, serverName: null },
                  ]),
              }),
            }),
          }),
        }),
      });

      // Mock violation count query
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 5 }]),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/rules/${ruleId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(ruleId);
      expect(body.violationCount).toBe(5);
    });

    it('should return 404 for non-existent rule', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      // Mock rule query (2 leftJoins: serverUsers and servers)
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/rules/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should reject invalid UUID', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/rules/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('PATCH /rules/:id', () => {
    it('should update rule for owner', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const ruleId = randomUUID();
      const existingRule = createTestRule({ id: ruleId, name: 'Old Name' });
      const updatedRule = { ...existingRule, name: 'New Name' };

      // Rule exists check (1 leftJoin to serverUsers)
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ ...existingRule, serverId: null }]),
            }),
          }),
        }),
      });

      // Update
      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedRule]),
          }),
        }),
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/rules/${ruleId}`,
        payload: {
          name: 'New Name',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.name).toBe('New Name');
    });

    it('should reject update for non-owner', async () => {
      const guestUser = createViewerUser();
      app = await buildTestApp(guestUser);

      const response = await app.inject({
        method: 'PATCH',
        url: `/rules/${randomUUID()}`,
        payload: {
          name: 'New Name',
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 404 for non-existent rule', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      // Rule exists check (1 leftJoin to serverUsers)
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/rules/${randomUUID()}`,
        payload: {
          name: 'New Name',
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('should update isActive field', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const ruleId = randomUUID();
      const existingRule = createTestRule({ id: ruleId, isActive: true });
      const updatedRule = { ...existingRule, isActive: false };

      // Rule exists check (1 leftJoin to serverUsers)
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ ...existingRule, serverId: null }]),
            }),
          }),
        }),
      });

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedRule]),
          }),
        }),
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/rules/${ruleId}`,
        payload: {
          isActive: false,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.isActive).toBe(false);
    });

    it('should update params field', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const ruleId = randomUUID();
      const existingRule = createTestRule({ id: ruleId });
      const updatedRule = { ...existingRule, params: { maxStreams: 5 } };

      // Rule exists check (1 leftJoin to serverUsers)
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ ...existingRule, serverId: null }]),
            }),
          }),
        }),
      });

      mockDb.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedRule]),
          }),
        }),
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/rules/${ruleId}`,
        payload: {
          params: { maxStreams: 5 },
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('DELETE /rules/:id', () => {
    it('should delete rule for owner', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const ruleId = randomUUID();
      const existingRule = createTestRule({ id: ruleId });

      // Rule exists check (1 leftJoin to serverUsers)
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ ...existingRule, serverId: null }]),
            }),
          }),
        }),
      });

      // Delete
      mockDb.delete.mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/rules/${ruleId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
    });

    it('should reject delete for non-owner', async () => {
      const guestUser = createViewerUser();
      app = await buildTestApp(guestUser);

      const response = await app.inject({
        method: 'DELETE',
        url: `/rules/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(403);
    });

    it('should return 404 for non-existent rule', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      // Rule exists check (1 leftJoin to serverUsers)
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const response = await app.inject({
        method: 'DELETE',
        url: `/rules/${randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
    });

    it('should reject invalid UUID', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'DELETE',
        url: '/rules/not-a-uuid',
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
