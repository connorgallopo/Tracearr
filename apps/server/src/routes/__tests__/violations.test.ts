/**
 * Violation route tests
 *
 * Covers the API endpoints for violation operations:
 * - GET /violations - list with pagination, filters and sorting
 * - GET /violations/:id - a single enriched violation
 * - PATCH /violations/:id - acknowledge
 * - DELETE /violations/:id - dismiss
 * - POST /violations/bulk/acknowledge and DELETE /violations/bulk
 *
 * The db is mocked, so whether the emitted SQL returns the right rows is an
 * integration-tier question. What this tier proves is that every path builds
 * its predicates and ORDER BY from the one shared roster builder: assertions
 * render the WHERE and ORDER BY the handler actually passed rather than
 * counting calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import { and, type SQL } from 'drizzle-orm';
import type { AuthUser, ViolationRosterFilters, ViolationSeverity } from '@tracearr/shared';
import { queryChain, renderCall, renderSql } from '../../test/helpers.js';

// Mock the database module before importing routes
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

const {
  mockGetServerUserDisplayNames,
  mockRecalculateAggregateTrustScore,
  mockDispatchTrustMoves,
} = vi.hoisted(() => ({
  mockGetServerUserDisplayNames: vi.fn(),
  mockRecalculateAggregateTrustScore: vi.fn(),
  mockDispatchTrustMoves: vi.fn().mockResolvedValue(undefined),
}));
// moveTrust stays real: the reversal SQL it builds is what these tests pin.
vi.mock('../../services/userService.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getServerUserDisplayNames: mockGetServerUserDisplayNames,
  recomputeIdentityAggregates: mockRecalculateAggregateTrustScore,
}));

vi.mock('../../services/automations/events/producers.js', () => ({
  dispatchTrustMoves: mockDispatchTrustMoves,
}));

// Import the mocked db and the routes
import { db } from '../../db/client.js';
import { violationRoutes, buildViolationRosterConditions } from '../violations.js';

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** GET / issues the page query, then the count, then enrichment lookups. */
function setupListMocks(rows: unknown[], total: number) {
  const pageChain = queryChain(vi.fn, rows);
  const countChain = queryChain(vi.fn, [{ total }]);
  vi.mocked((db as any).select)
    .mockReturnValueOnce(pageChain)
    .mockReturnValueOnce(countChain)
    .mockReturnValue(queryChain(vi.fn, []));
  return { pageChain, countChain };
}

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
  ruleType: null;
  serverUserId: string;
  username: string;
  userThumb: string | null;
  identityName: string | null;
  serverId: string;
  serverName: string;
  sessionId: string;
  mediaTitle: string;
  mediaType: string | null;
  grandparentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  year: number | null;
  severity: ViolationSeverity;
  data: Record<string, unknown>;
  createdAt: Date;
  acknowledgedAt: Date | null;
  ipAddress: string | null;
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
  geoContinent: string | null;
  geoPostal: string | null;
  geoLat: number | null;
  geoLon: number | null;
  playerName: string | null;
  device: string | null;
  deviceId: string | null;
  platform: string | null;
  product: string | null;
  quality: string | null;
  startedAt: Date | null;
}

function createTestViolation(
  overrides: Partial<Omit<MockViolationWithJoins, 'ruleType'>> = {}
): MockViolationWithJoins {
  const serverId = overrides.serverId ?? randomUUID();
  return {
    id: overrides.id ?? randomUUID(),
    ruleId: overrides.ruleId ?? randomUUID(),
    ruleName: overrides.ruleName ?? 'Test Rule',
    ruleType: null,
    serverUserId: overrides.serverUserId ?? randomUUID(),
    username: overrides.username ?? 'testuser',
    userThumb: overrides.userThumb ?? null,
    identityName: overrides.identityName ?? null,
    serverId,
    serverName: overrides.serverName ?? 'Test Server',
    sessionId: overrides.sessionId ?? randomUUID(),
    mediaTitle: overrides.mediaTitle ?? 'Test Movie',
    mediaType: overrides.mediaType ?? 'movie',
    grandparentTitle: overrides.grandparentTitle ?? null,
    seasonNumber: overrides.seasonNumber ?? null,
    episodeNumber: overrides.episodeNumber ?? null,
    year: overrides.year ?? 2024,
    severity: overrides.severity ?? 'warning',
    data: overrides.data ?? { maxStreams: 3, actualStreams: 4 },
    createdAt: overrides.createdAt ?? new Date(),
    acknowledgedAt: overrides.acknowledgedAt ?? null,
    ipAddress: overrides.ipAddress ?? '192.168.1.1',
    geoCity: overrides.geoCity ?? 'New York',
    geoRegion: overrides.geoRegion ?? 'NY',
    geoCountry: overrides.geoCountry ?? 'US',
    geoContinent: overrides.geoContinent ?? 'NA',
    geoPostal: overrides.geoPostal ?? '10001',
    geoLat: overrides.geoLat ?? 40.7128,
    geoLon: overrides.geoLon ?? -74.006,
    playerName: overrides.playerName ?? 'Test Player',
    device: overrides.device ?? 'Chrome',
    deviceId: overrides.deviceId ?? 'device-123',
    platform: overrides.platform ?? 'Windows',
    product: overrides.product ?? 'Plex Web',
    quality: overrides.quality ?? '1080p',
    startedAt: overrides.startedAt ?? new Date(),
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
 * Helper to create the mock chain for single violation queries (GET /:id)
 * (rules: innerJoin, serverUsers: innerJoin, users: leftJoin, servers: innerJoin, sessions: leftJoin)
 */
function createSingleViolationSelectMock(resolvedValue: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        // rules
        innerJoin: vi.fn().mockReturnValue({
          // serverUsers
          leftJoin: vi.fn().mockReturnValue({
            // users (leftJoin for inactivity violations without identity)
            innerJoin: vi.fn().mockReturnValue({
              // servers
              leftJoin: vi.fn().mockReturnValue({
                // sessions (leftJoin for inactivity violations without session)
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
 * Helper to create a generic chainable mock that resolves to an empty array.
 * Used for enrichment function's additional DB calls (historical sessions,
 * related sessions, action results). Supports arbitrary method chains like
 * .from().where().limit().orderBy() etc.
 */
function createEmptyChainMock(): any {
  const resolvedPromise = Promise.resolve([]);
  const mock: any = {};
  // All common drizzle chain methods return the same chainable mock
  const methods = [
    'from',
    'where',
    'limit',
    'offset',
    'orderBy',
    'innerJoin',
    'leftJoin',
    'select',
  ];
  for (const method of methods) {
    mock[method] = vi.fn().mockReturnValue(mock);
  }
  // Make it thenable so it resolves as a promise
  mock.then = resolvedPromise.then.bind(resolvedPromise);
  mock.catch = resolvedPromise.catch.bind(resolvedPromise);
  return mock;
}

/**
 * Set up mock for GET /:id which now uses enrichViolations.
 * The first db.select call is the main query, subsequent calls are from enrichment.
 */
function setupSingleViolationMocks(mockDb: any, resolvedValue: unknown) {
  // First call: main violation select query
  mockDb.select.mockReturnValueOnce(createSingleViolationSelectMock(resolvedValue));
  // Subsequent calls from enrichViolations: return empty results
  mockDb.select.mockReturnValue(createEmptyChainMock());
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

      setupListMocks(testViolations, 3);

      const response = await app.inject({
        method: 'GET',
        url: '/violations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toHaveLength(3);
      expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 3 });
    });

    it('should apply default pagination', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      setupListMocks([], 0);

      const response = await app.inject({
        method: 'GET',
        url: '/violations',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 0 });
    });

    it('should accept pagination parameters', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      setupListMocks([], 100);

      const response = await app.inject({
        method: 'GET',
        url: '/violations?page=3&pageSize=25',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.meta).toEqual({ page: 3, pageSize: 25, total: 100 });
      // totalPages is derived client-side from meta, never sent.
      expect(body).not.toHaveProperty('totalPages');
    });

    it('should filter by severity', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const highSeverityViolations = [createTestViolation({ severity: 'high' })];

      setupListMocks(highSeverityViolations, 1);

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

      setupListMocks(unacknowledgedViolations, 1);

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

      setupListMocks(userViolations, 1);

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

      setupListMocks(ruleViolations, 1);

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
      expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 0 });
    });
  });

  describe('GET /violations/:id', () => {
    it('should return an enriched violation with nested shape', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const testViolation = createTestViolation({ id: violationId });

      setupSingleViolationMocks(mockDb, [testViolation]);

      const response = await app.inject({
        method: 'GET',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(violationId);
      // Verify nested shape (not flat)
      expect(body.rule.name).toBe('Test Rule');
      expect(body.rule.type).toBeNull();
      expect(body.user.username).toBe('testuser');
      expect(body.server.name).toBe('Test Server');
      expect(body.session.mediaTitle).toBe('Test Movie');
      expect(body.session.ipAddress).toBe('192.168.1.1');
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

    it('should return violation with full session details', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const testViolation = createTestViolation({
        id: violationId,
        ipAddress: '10.0.0.1',
        geoCity: 'Los Angeles',
        geoRegion: 'CA',
        geoCountry: 'US',
        playerName: 'Plex Player',
        platform: 'macOS',
        device: 'Safari',
        product: 'Plex Web',
        quality: '4K',
      });

      setupSingleViolationMocks(mockDb, [testViolation]);

      const response = await app.inject({
        method: 'GET',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // Session fields are now nested under body.session
      expect(body.session.ipAddress).toBe('10.0.0.1');
      expect(body.session.geoCity).toBe('Los Angeles');
      expect(body.session.geoRegion).toBe('CA');
      expect(body.session.geoCountry).toBe('US');
      expect(body.session.playerName).toBe('Plex Player');
      expect(body.session.platform).toBe('macOS');
      expect(body.session.device).toBe('Safari');
      expect(body.session.product).toBe('Plex Web');
      expect(body.session.quality).toBe('4K');
    });

    it('passes only threshold UUIDs (not actual username) to getServerUserDisplayNames', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const thresholdId1 = randomUUID();
      const thresholdId2 = randomUUID();
      const testViolation = createTestViolation({
        id: violationId,
        data: {
          evidence: [
            {
              groupIndex: 0,
              matched: true,
              conditions: [
                {
                  field: 'user_id',
                  operator: 'not_in',
                  threshold: [thresholdId1, thresholdId2],
                  actual: 'bob',
                  matched: true,
                },
              ],
            },
          ],
        },
      });

      mockGetServerUserDisplayNames.mockResolvedValue({
        [thresholdId1]: 'Alice',
        [thresholdId2]: 'Bob',
      });
      setupSingleViolationMocks(mockDb, [testViolation]);

      const response = await app.inject({ method: 'GET', url: `/violations/${violationId}` });

      expect(response.statusCode).toBe(200);
      expect(mockGetServerUserDisplayNames).toHaveBeenCalledTimes(1);
      const calledWith: string[] = mockGetServerUserDisplayNames.mock.calls[0]![0];
      expect(calledWith).toContain(thresholdId1);
      expect(calledWith).toContain(thresholdId2);
      expect(calledWith).not.toContain('bob');

      const body = response.json();
      expect(body.userNames[thresholdId1]).toBe('Alice');
      expect(body.userNames[thresholdId2]).toBe('Bob');
    });

    it('returns violation without 500 when getServerUserDisplayNames throws', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const testViolation = createTestViolation({
        id: violationId,
        data: {
          evidence: [
            {
              groupIndex: 0,
              matched: true,
              conditions: [
                {
                  field: 'user_id',
                  operator: 'not_in',
                  threshold: [randomUUID()],
                  actual: 'bob',
                  matched: true,
                },
              ],
            },
          ],
        },
      });

      mockGetServerUserDisplayNames.mockRejectedValue(
        new Error('invalid input syntax for type uuid')
      );
      setupSingleViolationMocks(mockDb, [testViolation]);

      const response = await app.inject({ method: 'GET', url: `/violations/${violationId}` });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe(violationId);
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
    it('soft-deletes the violation and recomputes the rollup even without trust actions', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const serverUserId = randomUUID();
      const userId = randomUUID();
      const serverId = ownerUser.serverIds[0];

      // First select: violation exists check with serverUsers join
      // Second select: get rule actions
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Violation exists check
          return createViolationExistsCheckMock([
            {
              id: violationId,
              ruleId: 'rule-1',
              serverUserId,
              serverId,
              userId,
            },
          ]);
        } else {
          // Rule actions query - no trust actions
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: 'rule-1', actions: [] }]),
              }),
            }),
          };
        }
      });

      const deleteMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: violationId }]),
        }),
      });
      const txMock = {
        delete: deleteMock,
        update: vi.fn().mockReturnValue({ set: setMock }),
      };

      mockDb.transaction = vi
        .fn()
        .mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
          return callback(txMock);
        });

      const response = await app.inject({
        method: 'DELETE',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      // Soft delete: the row is stamped, never removed
      expect(deleteMock).not.toHaveBeenCalled();
      expect(setMock).toHaveBeenCalledTimes(1);
      expect(setMock).toHaveBeenCalledWith({ dismissedAt: expect.any(Date) });
      // The rollup recomputes on every dismiss, not only trust-reversing ones
      expect(mockRecalculateAggregateTrustScore).toHaveBeenCalledWith(userId, txMock);
    });

    it('reverses trust score when dismissing a violation with a trust action', async () => {
      // Dismiss reverses any trust changes made by explicit rule actions.
      // This treats dismiss as "false positive, undo everything".
      const action = { type: 'trust', mode: 'adjust', amount: -20 };
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const serverUserId = randomUUID();
      const userId = randomUUID();
      const ruleId = randomUUID();
      const serverId = ownerUser.serverIds[0];

      // First select: violation exists check
      // Second select: the rule's stored trust action, worth -20
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return createViolationExistsCheckMock([
            {
              id: violationId,
              ruleId,
              serverUserId,
              serverId,
              userId,
            },
          ]);
        } else {
          return {
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ id: ruleId, actions: { actions: [action] } }]),
              }),
            }),
          };
        }
      });

      // Track transaction calls to verify trust reversal
      const deleteMock = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const moved = {
        previous: 40,
        row: { id: serverUserId, serverId, userId, trustScore: 60 },
      };
      // The stamp is set().where().returning(); the trust write is set().from().where().returning().
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: violationId }]),
        }),
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([moved]),
          }),
        }),
      });
      const updateMock = vi.fn().mockReturnValue({ set: setMock });
      const txMock = {
        delete: deleteMock,
        update: updateMock,
      };

      mockDb.transaction = vi
        .fn()
        .mockImplementation(async (callback: (tx: unknown) => Promise<void>) => {
          return callback(txMock);
        });

      const response = await app.inject({
        method: 'DELETE',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      // Verify transaction was called
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      // Soft delete plus trust reversal: two updates, no delete
      expect(deleteMock).not.toHaveBeenCalled();
      expect(setMock).toHaveBeenCalledTimes(2);
      expect(setMock.mock.calls[0]?.[0]).toEqual({ dismissedAt: expect.any(Date) });
      // The stored -20 is subtracted, handing the user back 20 points, clamped to 0..100
      const reversal = setMock.mock.calls[1]?.[0] as { trustScore: SQL; updatedAt: unknown };
      expect(reversal.updatedAt).toBeInstanceOf(Date);
      expect(renderSql(reversal.trustScore)).toMatchObject({
        sql: 'LEAST(100, GREATEST(0, server_users.trust_score - $1))',
        params: [-20],
      });
      // Verify the identity's overall trust rollup was recomputed for the reversal
      expect(mockRecalculateAggregateTrustScore).toHaveBeenCalledWith(userId, txMock);
      // The reversal is a trust move like any other, announced once after the commit.
      expect(mockDispatchTrustMoves).toHaveBeenCalledTimes(1);
      expect(mockDispatchTrustMoves).toHaveBeenCalledWith(
        [{ previous: 40, serverUser: moved.row }],
        'a violation was dismissed'
      );
    });

    it('announces nothing when a dismiss reverses no trust', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const violationId = randomUUID();
      const userId = randomUUID();
      let selectCallCount = 0;
      mockDb.select.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return createViolationExistsCheckMock([
            {
              id: violationId,
              ruleId: 'rule-1',
              serverUserId: randomUUID(),
              serverId: ownerUser.serverIds[0],
              userId,
            },
          ]);
        }
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'rule-1', actions: { actions: [] } }]),
            }),
          }),
        };
      });

      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: violationId }]),
        }),
      });
      const txMock = { update: vi.fn().mockReturnValue({ set: setMock }) };
      mockDb.transaction = vi
        .fn()
        .mockImplementation(async (callback: (tx: unknown) => Promise<void>) => callback(txMock));

      const response = await app.inject({
        method: 'DELETE',
        url: `/violations/${violationId}`,
      });

      expect(response.statusCode).toBe(200);
      // No trust action on the rule, so no write and nothing to announce.
      expect(setMock).toHaveBeenCalledTimes(1);
      expect(mockDispatchTrustMoves).toHaveBeenCalledWith([], 'a violation was dismissed');
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

      setupListMocks(testViolations, 2);

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

      setupListMocks(testViolations, 1);

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

// ============================================================================
// Roster conditions: the one builder GET /, its count and both bulk paths share
// ============================================================================

function rosterFilters(overrides: Partial<ViolationRosterFilters> = {}): ViolationRosterFilters {
  return { ...overrides };
}

async function rosterSql(filters: ViolationRosterFilters, authUser: AuthUser) {
  const roster = await buildViolationRosterConditions(filters, authUser);
  if (roster.empty) {
    return { empty: true as const, text: '', params: [] as unknown[] };
  }
  const rendered = renderSql(and(...roster.conditions)!);
  return { empty: false as const, text: normalize(rendered.sql), params: rendered.params };
}

describe('violation roster conditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('always excludes dismissed rows', async () => {
    const { text } = await rosterSql(rosterFilters(), createOwnerUser());

    expect(text).toContain('automation_runs.dismissed_at is null');
  });

  it('narrows on acknowledged === true, not just false', async () => {
    const acknowledged = await rosterSql(rosterFilters({ acknowledged: true }), createOwnerUser());
    const pending = await rosterSql(rosterFilters({ acknowledged: false }), createOwnerUser());

    expect(acknowledged.text).toContain('automation_runs.acknowledged_at is not null');
    expect(pending.text).toContain('automation_runs.acknowledged_at is null');
    expect(pending.text).not.toContain('automation_runs.acknowledged_at is not null');
  });

  it('leaves acknowledgement unfiltered when the filter is absent', async () => {
    const { text } = await rosterSql(rosterFilters(), createOwnerUser());

    expect(text).not.toContain('automation_runs.acknowledged_at');
  });

  it('carries ruleId and serverUserId, which the bulk body used to drop', async () => {
    const ruleId = randomUUID();
    const serverUserId = randomUUID();
    const { text, params } = await rosterSql(
      rosterFilters({ ruleId, serverUserId }),
      createOwnerUser()
    );

    expect(text).toContain('automation_runs.rule_id =');
    expect(text).toContain('automation_runs.server_user_id =');
    expect(params).toContain(ruleId);
    expect(params).toContain(serverUserId);
  });

  it('bounds startDate at the start of that UTC day', async () => {
    const { text, params } = await rosterSql(
      rosterFilters({ startDate: '2024-03-15' }),
      createOwnerUser()
    );

    expect(text).toContain('automation_runs.created_at >=');
    expect(params).toContain('2024-03-15T00:00:00.000Z');
  });

  it('bounds endDate half-open, so the whole named day is included', async () => {
    const { text, params } = await rosterSql(
      rosterFilters({ endDate: '2024-03-15' }),
      createOwnerUser()
    );

    // An inclusive <= against midnight would drop everything on 2024-03-15.
    expect(text).toContain('automation_runs.created_at <');
    expect(text).not.toContain('automation_runs.created_at <=');
    expect(params).toContain('2024-03-16T00:00:00.000Z');
  });

  it('reports empty rather than a predicate when no requested server is visible', async () => {
    const viewer: AuthUser = {
      userId: randomUUID(),
      username: 'viewer',
      role: 'viewer',
      serverIds: [randomUUID()],
    };
    const result = await buildViolationRosterConditions(
      rosterFilters({ serverIds: [randomUUID()] }),
      viewer
    );

    expect(result).toEqual({ empty: true, conditions: [] });
  });

  it('reports empty when an identity resolves to no accessible account', async () => {
    vi.mocked((db as any).select).mockReturnValue(queryChain(vi.fn, []));

    const result = await buildViolationRosterConditions(
      rosterFilters({ userIds: [randomUUID()] }),
      createOwnerUser()
    );

    expect(result).toEqual({ empty: true, conditions: [] });
  });
});

// ============================================================================
// Sorting
// ============================================================================

describe('GET /violations ORDER BY', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  async function orderClause(query: string): Promise<string> {
    app = await buildTestApp(createOwnerUser());
    const { pageChain } = setupListMocks([], 0);
    const response = await app.inject({ method: 'GET', url: `/violations?${query}` });
    expect(response.statusCode).toBe(200);
    return renderCall(pageChain, 'orderBy').text;
  }

  it('defaults to newest first, tiebroken on the violation id', async () => {
    expect(await orderClause('')).toBe('automation_runs.created_at DESC, automation_runs.id ASC');
  });

  it('tiebreaks the createdAt branch in both directions', async () => {
    expect(await orderClause('orderBy=createdAt&orderDir=asc')).toBe(
      'automation_runs.created_at ASC, automation_runs.id ASC'
    );
  });

  it('ranks severity high-first on desc and tiebreaks on the id', async () => {
    expect(await orderClause('orderBy=severity&orderDir=desc')).toBe(
      "CASE automation_runs.severity WHEN 'high' THEN 3 WHEN 'warning' THEN 2 WHEN 'low' THEN 1 END DESC, automation_runs.id ASC"
    );
  });

  it('ranks severity low-first on asc', async () => {
    expect(await orderClause('orderBy=severity&orderDir=asc')).toBe(
      "CASE automation_runs.severity WHEN 'high' THEN 3 WHEN 'warning' THEN 2 WHEN 'low' THEN 1 END ASC, automation_runs.id ASC"
    );
  });

  it('tiebreaks the user branch on the id, not on created_at', async () => {
    expect(await orderClause('orderBy=user&orderDir=asc')).toBe(
      'server_users.username ASC, automation_runs.id ASC'
    );
  });

  it('tiebreaks the rule branch on the id, not on created_at', async () => {
    expect(await orderClause('orderBy=rule&orderDir=asc')).toBe(
      'automations.name ASC, automation_runs.id ASC'
    );
  });
});

// ============================================================================
// The count and the page agree
// ============================================================================

describe('GET /violations count', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it('builds the count from the same conditions as the page', async () => {
    app = await buildTestApp(createOwnerUser());
    const { pageChain, countChain } = setupListMocks([], 7);
    const ruleId = randomUUID();

    const response = await app.inject({
      method: 'GET',
      url: `/violations?ruleId=${ruleId}&severity=high&acknowledged=true&startDate=2024-03-01&endDate=2024-03-15`,
    });

    expect(response.statusCode).toBe(200);
    const page = renderCall(pageChain, 'where');
    const countWhere = renderCall(countChain, 'where');

    // The regression guard for the hand-written raw-SQL count: if it comes
    // back, these drift apart and the pager lies about how many rows exist.
    expect(countWhere.text).toBe(page.text);
    expect(countWhere.params).toEqual(page.params);
    expect(page.params).toContain(ruleId);
    expect(page.params).toContain('2024-03-16T00:00:00.000Z');
    expect(response.json().meta.total).toBe(7);
  });

  it('applies the page window without touching the conditions', async () => {
    app = await buildTestApp(createOwnerUser());
    const { pageChain } = setupListMocks([], 0);

    const response = await app.inject({ method: 'GET', url: '/violations?page=3&pageSize=25' });

    expect(response.statusCode).toBe(200);
    expect(pageChain.limit).toHaveBeenCalledWith(25);
    expect(pageChain.offset).toHaveBeenCalledWith(50);
  });
});

// ============================================================================
// Bulk select-all reaches exactly the rows the table showed
// ============================================================================

describe('bulk selectAll scope', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  const narrowingFilters = (ruleId: string) => ({
    ruleId,
    startDate: '2024-03-01',
    endDate: '2024-03-15',
  });

  it('POST /bulk/acknowledge seeds only the filtered rows', async () => {
    app = await buildTestApp(createOwnerUser());
    const ruleId = randomUUID();
    const violationId = randomUUID();
    const serverId = randomUUID();

    const seedChain = queryChain(vi.fn, [{ id: violationId }]);
    vi.mocked((db as any).select)
      .mockReturnValueOnce(seedChain)
      .mockReturnValueOnce(queryChain(vi.fn, [{ id: violationId, serverId }]));
    vi.mocked((db as any).update).mockReturnValue(queryChain(vi.fn, [{ id: violationId }]));

    const response = await app.inject({
      method: 'POST',
      url: '/violations/bulk/acknowledge',
      payload: { selectAll: true, filters: narrowingFilters(ruleId) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, acknowledged: 1 });

    // Without ruleId and the date bounds in the seed query, "select all" would
    // acknowledge every violation on the server instead of the filtered set.
    const seed = renderCall(seedChain, 'where');
    expect(seed.text).toContain('automation_runs.rule_id =');
    expect(seed.text).toContain('automation_runs.created_at >=');
    expect(seed.text).toContain('automation_runs.created_at <');
    expect(seed.params).toContain(ruleId);
    expect(seed.params).toContain('2024-03-01T00:00:00.000Z');
    expect(seed.params).toContain('2024-03-16T00:00:00.000Z');
  });

  it.each([
    ['selectAll with no acknowledged filter', { selectAll: true }],
    ['an explicit id list', { ids: [randomUUID(), randomUUID()] }],
  ])(
    'POST /bulk/acknowledge leaves acknowledged rows alone for %s and counts the rest',
    async (_label, payload) => {
      app = await buildTestApp(createOwnerUser());
      const pendingId = randomUUID();
      const acknowledgedId = randomUUID();
      const serverId = randomUUID();
      const matched = [
        { id: pendingId, serverId },
        { id: acknowledgedId, serverId },
      ];

      vi.mocked((db as any).select).mockReturnValue(queryChain(vi.fn, matched));
      const updateChain = queryChain(vi.fn, [{ id: pendingId }]);
      vi.mocked((db as any).update).mockReturnValue(updateChain);

      const response = await app.inject({
        method: 'POST',
        url: '/violations/bulk/acknowledge',
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, acknowledged: 1 });
      expect(renderCall(updateChain, 'where').text).toContain(
        'automation_runs.acknowledged_at is null'
      );
    }
  );

  it('DELETE /bulk seeds only the filtered rows, so trust is not reversed wholesale', async () => {
    app = await buildTestApp(createOwnerUser());
    const ruleId = randomUUID();
    const violationId = randomUUID();
    const serverId = randomUUID();
    const userId = randomUUID();
    const serverUserId = randomUUID();

    const seedChain = queryChain(vi.fn, [{ id: violationId }]);
    vi.mocked((db as any).select)
      .mockReturnValueOnce(seedChain)
      .mockReturnValueOnce(
        queryChain(vi.fn, [{ id: violationId, ruleId, serverUserId, serverId, userId }])
      )
      .mockReturnValueOnce(queryChain(vi.fn, [{ id: ruleId, actions: { actions: [] } }]));
    vi.mocked((db as any).transaction).mockImplementation(async (callback: any) =>
      callback({ update: () => queryChain(vi.fn, [{ id: violationId }]) })
    );

    const response = await app.inject({
      method: 'DELETE',
      url: '/violations/bulk',
      payload: { selectAll: true, filters: narrowingFilters(ruleId) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, dismissed: 1 });

    const seed = renderCall(seedChain, 'where');
    expect(seed.text).toContain('automation_runs.rule_id =');
    expect(seed.text).toContain('automation_runs.created_at >=');
    expect(seed.text).toContain('automation_runs.created_at <');
    expect(seed.params).toContain(ruleId);
    expect(seed.params).toContain('2024-03-16T00:00:00.000Z');
  });

  it.each([
    ['POST', '/violations/bulk/acknowledge'],
    ['DELETE', '/violations/bulk'],
  ])('%s %s narrows on acknowledged === true', async (method, url) => {
    app = await buildTestApp(createOwnerUser());
    const seedChain = queryChain(vi.fn, []);
    vi.mocked((db as any).select).mockReturnValue(seedChain);

    const response = await app.inject({
      method: method as 'POST' | 'DELETE',
      url,
      payload: { selectAll: true, filters: { acknowledged: true } },
    });

    expect(response.statusCode).toBe(200);
    const seed = renderCall(seedChain, 'where');
    expect(seed.text).toContain('automation_runs.acknowledged_at is not null');
  });

  it.each([
    ['POST', '/violations/bulk/acknowledge'],
    ['DELETE', '/violations/bulk'],
  ])('%s %s narrows on acknowledged === false', async (method, url) => {
    app = await buildTestApp(createOwnerUser());
    const seedChain = queryChain(vi.fn, []);
    vi.mocked((db as any).select).mockReturnValue(seedChain);

    const response = await app.inject({
      method: method as 'POST' | 'DELETE',
      url,
      payload: { selectAll: true, filters: { acknowledged: false } },
    });

    expect(response.statusCode).toBe(200);
    const seed = renderCall(seedChain, 'where');
    expect(seed.text).toContain('automation_runs.acknowledged_at is null');
    expect(seed.text).not.toContain('automation_runs.acknowledged_at is not null');
  });

  it('resolves both bulk paths through the same conditions as the list', async () => {
    const ruleId = randomUUID();
    const authUser = createOwnerUser();
    const filters = rosterFilters({
      ruleId,
      severity: 'high',
      acknowledged: false,
      startDate: '2024-03-01',
      endDate: '2024-03-15',
    });

    app = await buildTestApp(authUser);
    const { pageChain } = setupListMocks([], 0);
    await app.inject({
      method: 'GET',
      url: `/violations?ruleId=${ruleId}&severity=high&acknowledged=false&startDate=2024-03-01&endDate=2024-03-15`,
    });

    const listWhere = renderCall(pageChain, 'where');
    const shared = await rosterSql(filters, authUser);

    expect(shared.text).toBe(listWhere.text);
    expect(shared.params).toEqual(listWhere.params);
  });
});

// ============================================================================
// The alias: /violations serves completed policy runs that have a user.
// automation_runs also holds notification runs, runs stopped by a condition,
// runs that errored, and policy runs with no server_user_id. Every route below
// has to reject all four.
// ============================================================================

/** The predicates that leave only the run flavor this surface calls a violation. */
function expectAliasFilter(where: { text: string; params: unknown[] }) {
  // notification runs
  expect(where.text).toContain('automation_runs.kind =');
  expect(where.params).toContain('policy');
  // stopped_by_condition and error runs
  expect(where.text).toContain('automation_runs.outcome =');
  expect(where.params).toContain('completed');
  // runs with no account behind them
  expect(where.text).toContain('automation_runs.server_user_id is not null');
}

describe('violations alias filter', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('the roster carries it, so the list, its count and both bulk paths inherit', async () => {
    const roster = await rosterSql(rosterFilters(), createOwnerUser());

    expect(roster.empty).toBe(false);
    expectAliasFilter(roster);
  });

  it('GET /:id looks the run up under it and 404s a run outside', async () => {
    app = await buildTestApp(createOwnerUser());
    const chain = queryChain(vi.fn, []);
    vi.mocked((db as any).select).mockReturnValue(chain);

    const response = await app.inject({ method: 'GET', url: `/violations/${randomUUID()}` });

    expect(response.statusCode).toBe(404);
    expectAliasFilter(renderCall(chain, 'where'));
  });

  it('PATCH /:id looks the run up under it and 404s a run outside', async () => {
    app = await buildTestApp(createOwnerUser());
    const chain = queryChain(vi.fn, []);
    vi.mocked((db as any).select).mockReturnValue(chain);

    const response = await app.inject({ method: 'PATCH', url: `/violations/${randomUUID()}` });

    expect(response.statusCode).toBe(404);
    expectAliasFilter(renderCall(chain, 'where'));
  });

  it('DELETE /:id looks the run up under it and 404s a run outside', async () => {
    app = await buildTestApp(createOwnerUser());
    const chain = queryChain(vi.fn, []);
    vi.mocked((db as any).select).mockReturnValue(chain);

    const response = await app.inject({ method: 'DELETE', url: `/violations/${randomUUID()}` });

    expect(response.statusCode).toBe(404);
    expectAliasFilter(renderCall(chain, 'where'));
  });

  it.each([
    ['POST', '/violations/bulk/acknowledge', { acknowledged: 0 }],
    ['DELETE', '/violations/bulk', { dismissed: 0 }],
  ])('%s %s drops explicitly named ids that are outside it', async (method, url, tally) => {
    app = await buildTestApp(createOwnerUser());
    const chain = queryChain(vi.fn, []);
    vi.mocked((db as any).select).mockReturnValue(chain);

    const response = await app.inject({
      method: method as 'POST' | 'DELETE',
      url,
      payload: { ids: [randomUUID()] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, ...tally });
    expectAliasFilter(renderCall(chain, 'where'));
  });
});
