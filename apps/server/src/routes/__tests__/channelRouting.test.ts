/**
 * Channel Routing routes unit tests
 *
 * Tests the API endpoints for notification channel routing:
 * - GET /routing - Get all routing configuration
 * - PATCH /routing/:eventType - Update routing for specific event
 *
 * Also tests internal helper functions:
 * - getChannelRouting() - Get routing for a specific event type
 * - getAllChannelRouting() - Get all routing configuration
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
  },
}));

// Import mocked db and routes
import { db } from '../../db/client.js';
import {
  channelRoutingRoutes,
  getChannelRouting,
  getAllChannelRouting,
} from '../channelRouting.js';

/**
 * Create mock routing row
 */
function createMockRouting(
  eventType: string,
  overrides?: Partial<{
    id: string;
    discordEnabled: boolean;
    webhookEnabled: boolean;
    pushEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>
) {
  return {
    id: overrides?.id ?? randomUUID(),
    eventType,
    discordEnabled: overrides?.discordEnabled ?? true,
    webhookEnabled: overrides?.webhookEnabled ?? true,
    pushEnabled: overrides?.pushEnabled ?? true,
    createdAt: overrides?.createdAt ?? new Date(),
    updatedAt: overrides?.updatedAt ?? new Date(),
  };
}

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

  // Register routes (using settings prefix as per route registration)
  await app.register(channelRoutingRoutes, { prefix: '/settings/notifications' });

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
 * Mock db.select() to return array of items with orderBy
 */
function mockDbSelectAll(items: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockResolvedValue(items),
    }),
  } as never);
}

/**
 * Mock db.select() to return single item with where + limit
 * Note: Currently unused but kept for future tests
 */
function _mockDbSelectOne(item: unknown) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(item ? [item] : []),
      }),
    }),
  } as never);
}

/**
 * Mock db.insert() to return inserted items
 */
function mockDbInsert(items: unknown[]) {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(items),
    }),
  } as never);
}

/**
 * Mock db.update() to return nothing
 */
function mockDbUpdate() {
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  } as never);
}

describe('Channel Routing Routes', () => {
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

  describe('GET /settings/notifications/routing', () => {
    it('returns all routing configuration for owner', async () => {
      app = await buildTestApp(ownerUser);

      const mockRoutings = [
        createMockRouting('violation_detected'),
        createMockRouting('stream_started', { discordEnabled: false }),
        createMockRouting('stream_stopped', { pushEnabled: false }),
      ];

      mockDbSelectAll(mockRoutings);

      const response = await app.inject({
        method: 'GET',
        url: '/settings/notifications/routing',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(3);
      expect(body[0]).toHaveProperty('eventType', 'violation_detected');
      expect(body[0]).toHaveProperty('discordEnabled', true);
      expect(body[1]).toHaveProperty('eventType', 'stream_started');
      expect(body[1]).toHaveProperty('discordEnabled', false);
    });

    it('creates default routing if no rows exist', async () => {
      app = await buildTestApp(ownerUser);

      // First call returns empty, meaning no routing exists
      mockDbSelectAll([]);

      // Mock insert to return defaults
      const defaultRoutings = [
        createMockRouting('violation_detected'),
        createMockRouting('stream_started', {
          discordEnabled: false,
          webhookEnabled: false,
          pushEnabled: false,
        }),
      ];
      mockDbInsert(defaultRoutings);

      const response = await app.inject({
        method: 'GET',
        url: '/settings/notifications/routing',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(2);
      expect(db.insert).toHaveBeenCalled();
    });

    it('rejects non-owner access with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/settings/notifications/routing',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Only server owners can view notification routing');
    });
  });

  describe('PATCH /settings/notifications/routing/:eventType', () => {
    it('updates existing routing for owner', async () => {
      app = await buildTestApp(ownerUser);

      const existingRouting = createMockRouting('violation_detected');

      // First select finds existing
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([existingRouting]),
          }),
        }),
      } as never);

      // Mock update
      mockDbUpdate();

      // Second select returns updated
      const updatedRouting = {
        ...existingRouting,
        discordEnabled: false,
        updatedAt: new Date(),
      };
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([updatedRouting]),
          }),
        }),
      } as never);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings/notifications/routing/violation_detected',
        payload: { discordEnabled: false },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.eventType).toBe('violation_detected');
      expect(body.discordEnabled).toBe(false);
      expect(db.update).toHaveBeenCalled();
    });

    it('creates new routing if none exists', async () => {
      app = await buildTestApp(ownerUser);

      const newRouting = createMockRouting('server_down', {
        discordEnabled: true,
        webhookEnabled: true,
        pushEnabled: false,
      });

      // Track select calls - first returns empty, second returns created routing
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // First call - no existing routing
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          } as never;
        } else {
          // Second call - return newly created routing
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([newRouting]),
              }),
            }),
          } as never;
        }
      });

      // Mock insert for new routing
      mockDbInsert([newRouting]);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings/notifications/routing/server_down',
        payload: { pushEnabled: false },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.eventType).toBe('server_down');
      expect(body.pushEnabled).toBe(false);
      expect(db.insert).toHaveBeenCalled();
    });

    it('rejects invalid event type with 400', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings/notifications/routing/invalid_event_type',
        payload: { discordEnabled: false },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('Invalid event type');
    });

    it('rejects invalid request body with 400', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings/notifications/routing/violation_detected',
        payload: { discordEnabled: 'not-a-boolean' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toBe('Invalid request body');
    });

    it('rejects non-owner access with 403', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings/notifications/routing/violation_detected',
        payload: { discordEnabled: false },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Only server owners can update notification routing');
    });

    it('updates multiple channel settings at once', async () => {
      app = await buildTestApp(ownerUser);

      const existingRouting = createMockRouting('violation_detected');
      const updatedRouting = {
        ...existingRouting,
        discordEnabled: false,
        webhookEnabled: false,
        pushEnabled: true,
      };

      // Track select calls
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const routing = selectCallCount === 1 ? existingRouting : updatedRouting;
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([routing]),
            }),
          }),
        } as never;
      });

      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings/notifications/routing/violation_detected',
        payload: {
          discordEnabled: false,
          webhookEnabled: false,
          pushEnabled: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.discordEnabled).toBe(false);
      expect(body.webhookEnabled).toBe(false);
      expect(body.pushEnabled).toBe(true);
    });

    it('handles partial updates', async () => {
      app = await buildTestApp(ownerUser);

      const existingRouting = createMockRouting('stream_started', {
        discordEnabled: true,
        webhookEnabled: true,
        pushEnabled: true,
      });

      // Only discord changed
      const updatedRouting = { ...existingRouting, discordEnabled: false };

      // Track select calls
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        const routing = selectCallCount === 1 ? existingRouting : updatedRouting;
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([routing]),
            }),
          }),
        } as never;
      });

      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/settings/notifications/routing/stream_started',
        payload: { discordEnabled: false },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.discordEnabled).toBe(false);
      // Others should remain unchanged
      expect(body.webhookEnabled).toBe(true);
      expect(body.pushEnabled).toBe(true);
    });
  });
});

describe('Channel Routing Helper Functions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all mock implementations
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
  });

  describe('getChannelRouting', () => {
    it('returns routing for existing event type', async () => {
      vi.mocked(db.select).mockImplementation(
        () =>
          ({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    discordEnabled: true,
                    webhookEnabled: false,
                    pushEnabled: true,
                  },
                ]),
              }),
            }),
          }) as never
      );

      const routing = await getChannelRouting('violation_detected');

      expect(routing.discordEnabled).toBe(true);
      expect(routing.webhookEnabled).toBe(false);
      expect(routing.pushEnabled).toBe(true);
    });

    it('returns defaults for high-priority events with no routing', async () => {
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

      const routing = await getChannelRouting('violation_detected');

      // High-priority events default to enabled
      expect(routing.discordEnabled).toBe(true);
      expect(routing.webhookEnabled).toBe(true);
      expect(routing.pushEnabled).toBe(true);
    });

    it('returns defaults for low-priority events with no routing', async () => {
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

      const routing = await getChannelRouting('stream_started');

      // Low-priority events default to disabled
      expect(routing.discordEnabled).toBe(false);
      expect(routing.webhookEnabled).toBe(false);
      expect(routing.pushEnabled).toBe(false);
    });

    it('returns defaults for trust_score_changed (low-priority)', async () => {
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

      const routing = await getChannelRouting('trust_score_changed');

      expect(routing.discordEnabled).toBe(false);
      expect(routing.webhookEnabled).toBe(false);
      expect(routing.pushEnabled).toBe(false);
    });
  });

  describe('getAllChannelRouting', () => {
    it('returns map of all routing configuration', async () => {
      vi.mocked(db.select).mockImplementation(
        () =>
          ({
            from: vi.fn().mockResolvedValue([
              {
                eventType: 'violation_detected',
                discordEnabled: true,
                webhookEnabled: true,
                pushEnabled: true,
              },
              {
                eventType: 'stream_started',
                discordEnabled: false,
                webhookEnabled: false,
                pushEnabled: false,
              },
              {
                eventType: 'server_down',
                discordEnabled: true,
                webhookEnabled: true,
                pushEnabled: false,
              },
            ]),
          }) as never
      );

      const routingMap = await getAllChannelRouting();

      expect(routingMap.size).toBe(3);
      expect(routingMap.get('violation_detected')).toEqual({
        discordEnabled: true,
        webhookEnabled: true,
        pushEnabled: true,
      });
      expect(routingMap.get('stream_started')).toEqual({
        discordEnabled: false,
        webhookEnabled: false,
        pushEnabled: false,
      });
      expect(routingMap.get('server_down')).toEqual({
        discordEnabled: true,
        webhookEnabled: true,
        pushEnabled: false,
      });
    });

    it('returns empty map when no routing exists', async () => {
      vi.mocked(db.select).mockImplementation(
        () =>
          ({
            from: vi.fn().mockResolvedValue([]),
          }) as never
      );

      const routingMap = await getAllChannelRouting();

      expect(routingMap.size).toBe(0);
    });
  });
});
