/**
 * Mobile Authentication Integration Tests
 *
 * Tests mobile pairing, token exchange, refresh, and session management
 * against a real database.
 *
 * Run with: pnpm test:integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import { createHash, randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AuthUser } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import {
  users,
  servers,
  serverUsers,
  settings,
  mobileTokens,
  mobileSessions,
} from '../../src/db/schema.js';
import { mobileRoutes } from '../../src/routes/mobile.js';

// Constants (matching mobile.ts)
const TOKEN_EXPIRY_MINUTES = 15;
const MOBILE_TOKEN_PREFIX = 'trr_mob_';
const MOBILE_REFRESH_TTL = 90 * 24 * 60 * 60; // 90 days

// Test helpers
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateTestMobileToken(): string {
  const randomPart = randomBytes(32).toString('base64url');
  return `${MOBILE_TOKEN_PREFIX}${randomPart}`;
}

// Create mock Redis for rate limiting
function createMockRedis() {
  const store = new Map<string, string>();
  const counters = new Map<string, number>();

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    incr: vi.fn(async (key: string) => {
      const current = counters.get(key) ?? 0;
      counters.set(key, current + 1);
      return current + 1;
    }),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 300),
    ping: vi.fn(async () => 'PONG'),
    keys: vi.fn(async (pattern: string) => {
      const prefix = pattern.replace('*', '');
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    }),
    eval: vi.fn(async () => 1), // Default: first attempt (not rate limited)
    _store: store,
    _counters: counters,
    _reset: () => {
      store.clear();
      counters.clear();
    },
  };
}

// Test data holder
interface TestData {
  ownerId: string;
  serverId: string;
  serverUserId: string;
}

// Create test Fastify app with mobile routes
async function createMobileTestApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  // Register essential plugins
  await app.register(sensible);
  await app.register(cookie, { secret: 'test-cookie-secret-32-chars-long!' });
  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'test-jwt-secret-must-be-32-chars-min',
    sign: { algorithm: 'HS256' },
  });

  // Add mock Redis
  const mockRedis = createMockRedis();
  app.decorate('redis', mockRedis as unknown as Redis);

  // Add authenticate decorator
  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Add requireOwner decorator
  app.decorate('requireOwner', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
      if (request.user.role !== 'owner') {
        reply.forbidden('Owner access required');
      }
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Add requireMobile decorator - validates token was issued for mobile app
  app.decorate('requireMobile', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
      if (!request.user.mobile) {
        reply.forbidden('Mobile access token required');
      }
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Register mobile routes (same prefix as server)
  await app.register(mobileRoutes, { prefix: '/api/v1/mobile' });

  return app;
}

// Seed test data
async function seedTestData(): Promise<TestData> {
  // Create owner user
  const [user] = await db
    .insert(users)
    .values({
      username: 'testowner',
      name: 'Test Owner',
      role: 'owner',
      aggregateTrustScore: 100,
    })
    .returning();

  // Create server
  const [server] = await db
    .insert(servers)
    .values({
      name: 'Test Plex Server',
      type: 'plex',
      url: 'http://localhost:32400',
      token: 'test-token-encrypted',
    })
    .returning();

  // Create server_user
  const [serverUser] = await db
    .insert(serverUsers)
    .values({
      userId: user.id,
      serverId: server.id,
      externalId: 'plex-user-1',
      username: 'testowner',
      isServerAdmin: true,
      trustScore: 100,
    })
    .returning();

  // Ensure settings row exists with mobile enabled
  await db
    .insert(settings)
    .values({ id: 1, mobileEnabled: true })
    .onConflictDoUpdate({
      target: settings.id,
      set: { mobileEnabled: true },
    });

  return {
    ownerId: user.id,
    serverId: server.id,
    serverUserId: serverUser.id,
  };
}

// Clean up test data
async function cleanupTestData(): Promise<void> {
  // Clean in reverse order of dependencies
  await db.delete(mobileSessions);
  await db.delete(mobileTokens);
  await db.delete(serverUsers);
  await db.delete(servers);
  await db.delete(users);
}

// Generate owner JWT token
function generateOwnerToken(app: FastifyInstance, testData: TestData): string {
  return app.jwt.sign(
    {
      userId: testData.ownerId,
      username: 'testowner',
      role: 'owner',
      serverIds: [testData.serverId],
    } as AuthUser,
    { expiresIn: '1h' }
  );
}

describe('Mobile Authentication Integration Tests', () => {
  let app: FastifyInstance;
  let testData: TestData;

  beforeAll(async () => {
    app = await createMobileTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupTestData();
    testData = await seedTestData();
    // Reset mock Redis
    (app.redis as any)._reset();
  });

  describe('POST /api/v1/mobile/pair-token - Generate Pairing Token', () => {
    it('should generate a valid pairing token for owner', async () => {
      const ownerToken = generateOwnerToken(app, testData);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair-token',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toBeDefined();
      expect(body.token).toMatch(/^trr_mob_/);
      expect(body.expiresAt).toBeDefined();

      // Verify token was stored in database
      const tokenHash = hashToken(body.token);
      const [storedToken] = await db
        .select()
        .from(mobileTokens)
        .where(eq(mobileTokens.tokenHash, tokenHash));

      expect(storedToken).toBeDefined();
      expect(storedToken.createdBy).toBe(testData.ownerId);
      expect(storedToken.usedAt).toBeNull();
    });

    it('should reject non-owner users', async () => {
      // Create a viewer token
      const viewerToken = app.jwt.sign(
        {
          userId: testData.ownerId,
          username: 'testviewer',
          role: 'viewer',
          serverIds: [],
        } as AuthUser,
        { expiresIn: '1h' }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair-token',
        headers: { Authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should reject unauthenticated requests', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair-token',
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject when mobile is disabled', async () => {
      // Disable mobile
      await db.update(settings).set({ mobileEnabled: false }).where(eq(settings.id, 1));

      const ownerToken = generateOwnerToken(app, testData);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair-token',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Mobile access is not enabled');
    });

    it('should not count expired tokens toward pending limit', async () => {
      const ownerToken = generateOwnerToken(app, testData);

      // Insert an expired token - should not count toward limit
      await db.insert(mobileTokens).values({
        tokenHash: 'expired-token-hash-1234567890abcdef1234567890abcdef',
        expiresAt: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
        createdBy: testData.ownerId,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair-token',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);

      // Both tokens exist (expired tokens are not automatically cleaned up)
      const tokens = await db.select().from(mobileTokens);
      expect(tokens.length).toBe(2);
    });

    it('should enforce max pending tokens limit', async () => {
      const ownerToken = generateOwnerToken(app, testData);

      // Create 3 pending tokens (MAX_PENDING_TOKENS)
      for (let i = 0; i < 3; i++) {
        await db.insert(mobileTokens).values({
          tokenHash: `pending-token-hash-${i}-abcdef1234567890abcdef1234567890`,
          expiresAt: new Date(Date.now() + 1000 * 60 * 15), // 15 min from now
          createdBy: testData.ownerId,
        });
      }

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair-token',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Maximum of 3 pending tokens');
    });
  });

  describe('POST /api/v1/mobile/pair - Exchange Token for JWT', () => {
    let validPairingToken: string;

    beforeEach(async () => {
      // Generate a valid pairing token in the database
      validPairingToken = generateTestMobileToken();
      await db.insert(mobileTokens).values({
        tokenHash: hashToken(validPairingToken),
        expiresAt: new Date(Date.now() + 1000 * 60 * TOKEN_EXPIRY_MINUTES),
        createdBy: testData.ownerId,
      });
    });

    it('should exchange valid token for JWT and refresh token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair',
        payload: {
          token: validPairingToken,
          deviceName: 'Test iPhone',
          deviceId: 'device-12345',
          platform: 'ios',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();
      expect(body.server).toBeDefined();
      expect(body.user).toBeDefined();
      expect(body.user.username).toBe('testowner');

      // Verify mobile session was created
      const [session] = await db
        .select()
        .from(mobileSessions)
        .where(eq(mobileSessions.deviceId, 'device-12345'));

      expect(session).toBeDefined();
      expect(session.deviceName).toBe('Test iPhone');
      expect(session.platform).toBe('ios');

      // Verify pairing token was marked as used
      const [usedToken] = await db
        .select()
        .from(mobileTokens)
        .where(eq(mobileTokens.tokenHash, hashToken(validPairingToken)));

      expect(usedToken.usedAt).not.toBeNull();
    });

    it('should reject expired pairing token', async () => {
      // Create an expired token
      const expiredToken = generateTestMobileToken();
      await db.insert(mobileTokens).values({
        tokenHash: hashToken(expiredToken),
        expiresAt: new Date(Date.now() - 1000 * 60), // 1 minute ago
        createdBy: testData.ownerId,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair',
        payload: {
          token: expiredToken,
          deviceName: 'Test iPhone',
          deviceId: 'device-12345',
          platform: 'ios',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('expired');
    });

    it('should reject already-used pairing token', async () => {
      // First, use the token
      await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair',
        payload: {
          token: validPairingToken,
          deviceName: 'First Device',
          deviceId: 'device-first',
          platform: 'ios',
        },
      });

      // Try to use it again
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair',
        payload: {
          token: validPairingToken,
          deviceName: 'Second Device',
          deviceId: 'device-second',
          platform: 'android',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('already been used');
    });

    it('should reject invalid token format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair',
        payload: {
          token: 'invalid-token',
          deviceName: 'Test iPhone',
          deviceId: 'device-12345',
          platform: 'ios',
        },
      });

      // Token without correct prefix returns 401 unauthorized
      expect(res.statusCode).toBe(401);
    });

    it('should allow pairing even when mobile is disabled (token was pre-generated)', async () => {
      // Note: /pair doesn't check mobileEnabled - tokens can be used if they were
      // generated before mobile was disabled. Disabling mobile only prevents NEW tokens.
      await db.update(settings).set({ mobileEnabled: false }).where(eq(settings.id, 1));

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair',
        payload: {
          token: validPairingToken,
          deviceName: 'Test iPhone',
          deviceId: 'device-12345',
          platform: 'ios',
        },
      });

      // Pairing succeeds because the token was valid
      expect(res.statusCode).toBe(200);
      expect(res.json().accessToken).toBeDefined();
    });

    it('should enforce max paired devices limit', async () => {
      // Create 5 existing sessions (MAX_PAIRED_DEVICES)
      for (let i = 0; i < 5; i++) {
        await db.insert(mobileSessions).values({
          userId: testData.ownerId,
          refreshTokenHash: `existing-refresh-hash-${i}-abcdef1234567890abc`,
          deviceName: `Existing Device ${i}`,
          deviceId: `existing-device-${i}`,
          platform: 'ios',
        });
      }

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair',
        payload: {
          token: validPairingToken,
          deviceName: 'New Device',
          deviceId: 'device-new',
          platform: 'android',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Maximum of 5 devices');
    });

    it('should accept device secret for push encryption', async () => {
      const deviceSecret = randomBytes(32).toString('base64');

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair',
        payload: {
          token: validPairingToken,
          deviceName: 'Test iPhone',
          deviceId: 'device-12345',
          platform: 'ios',
          deviceSecret,
        },
      });

      expect(res.statusCode).toBe(200);

      // Verify device secret was stored
      const [session] = await db
        .select()
        .from(mobileSessions)
        .where(eq(mobileSessions.deviceId, 'device-12345'));

      expect(session.deviceSecret).toBe(deviceSecret);
    });
  });

  describe('POST /api/v1/mobile/refresh - Refresh JWT Token', () => {
    let validRefreshToken: string;
    let mobileJwt: string;

    beforeEach(async () => {
      // Generate a pairing token and pair a device
      const pairingToken = generateTestMobileToken();
      await db.insert(mobileTokens).values({
        tokenHash: hashToken(pairingToken),
        expiresAt: new Date(Date.now() + 1000 * 60 * TOKEN_EXPIRY_MINUTES),
        createdBy: testData.ownerId,
      });

      const pairRes = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/pair',
        payload: {
          token: pairingToken,
          deviceName: 'Test Device',
          deviceId: 'device-refresh-test',
          platform: 'ios',
        },
      });

      const pairBody = pairRes.json();
      validRefreshToken = pairBody.refreshToken;
      mobileJwt = pairBody.accessToken;
    });

    it('should refresh token and rotate refresh token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/refresh',
        payload: {
          refreshToken: validRefreshToken,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.accessToken).toBeDefined();
      expect(body.refreshToken).toBeDefined();

      // New refresh token should be different (rotation)
      expect(body.refreshToken).not.toBe(validRefreshToken);

      // Old refresh token should no longer work
      const secondRes = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/refresh',
        payload: {
          refreshToken: validRefreshToken,
        },
      });

      expect(secondRes.statusCode).toBe(401);
    });

    it('should reject invalid refresh token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/refresh',
        payload: {
          refreshToken: 'invalid-refresh-token',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or expired refresh token');
    });

    it('should allow refresh even when mobile is disabled', async () => {
      // Note: /refresh doesn't check mobileEnabled - existing sessions continue working.
      // Disabling mobile only prevents NEW tokens and revokes sessions when explicitly disabled.
      await db.update(settings).set({ mobileEnabled: false }).where(eq(settings.id, 1));

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/refresh',
        payload: {
          refreshToken: validRefreshToken,
        },
      });

      // Refresh succeeds because the session is still valid
      expect(res.statusCode).toBe(200);
      expect(res.json().accessToken).toBeDefined();
    });

    it('should update lastSeenAt on refresh', async () => {
      // Get the session before refresh
      const [sessionBefore] = await db
        .select()
        .from(mobileSessions)
        .where(eq(mobileSessions.deviceId, 'device-refresh-test'));

      const lastSeenBefore = sessionBefore.lastSeenAt;

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/refresh',
        payload: {
          refreshToken: validRefreshToken,
        },
      });

      // Get the session after refresh
      const [sessionAfter] = await db
        .select()
        .from(mobileSessions)
        .where(eq(mobileSessions.deviceId, 'device-refresh-test'));

      expect(sessionAfter.lastSeenAt.getTime()).toBeGreaterThan(lastSeenBefore.getTime());
    });
  });

  describe('DELETE /api/v1/mobile/sessions/:id - Revoke Session', () => {
    let sessionId: string;

    beforeEach(async () => {
      // Create a mobile session
      const [session] = await db
        .insert(mobileSessions)
        .values({
          userId: testData.ownerId,
          refreshTokenHash: 'test-refresh-hash-for-deletion-1234567890abcdef',
          deviceName: 'Device to Delete',
          deviceId: 'device-to-delete',
          platform: 'ios',
        })
        .returning();

      sessionId = session.id;
    });

    it('should revoke session as owner', async () => {
      const ownerToken = generateOwnerToken(app, testData);

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/mobile/sessions/${sessionId}`,
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // Verify session was deleted
      const sessions = await db
        .select()
        .from(mobileSessions)
        .where(eq(mobileSessions.id, sessionId));

      expect(sessions.length).toBe(0);
    });

    it('should reject non-owner users', async () => {
      const viewerToken = app.jwt.sign(
        {
          userId: testData.ownerId,
          username: 'testviewer',
          role: 'viewer',
          serverIds: [],
        } as AuthUser,
        { expiresIn: '1h' }
      );

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/mobile/sessions/${sessionId}`,
        headers: { Authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should return 404 for non-existent session', async () => {
      const ownerToken = generateOwnerToken(app, testData);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/mobile/sessions/00000000-0000-0000-0000-000000000000',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should reject unauthenticated requests', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/mobile/sessions/${sessionId}`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /api/v1/mobile/sessions - Revoke All Sessions', () => {
    beforeEach(async () => {
      // Create multiple mobile sessions
      for (let i = 0; i < 3; i++) {
        await db.insert(mobileSessions).values({
          userId: testData.ownerId,
          refreshTokenHash: `bulk-delete-refresh-hash-${i}-abcdef1234567890`,
          deviceName: `Device ${i}`,
          deviceId: `device-bulk-${i}`,
          platform: i % 2 === 0 ? 'ios' : 'android',
        });
      }
    });

    it('should revoke all sessions as owner', async () => {
      const ownerToken = generateOwnerToken(app, testData);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/mobile/sessions',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.revokedCount).toBe(3);

      // Verify all sessions were deleted
      const sessions = await db.select().from(mobileSessions);
      expect(sessions.length).toBe(0);
    });

    it('should return success even with no sessions to revoke', async () => {
      // Clean up all sessions first
      await db.delete(mobileSessions);

      const ownerToken = generateOwnerToken(app, testData);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/mobile/sessions',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().revokedCount).toBe(0);
    });

    it('should reject non-owner users', async () => {
      const viewerToken = app.jwt.sign(
        {
          userId: testData.ownerId,
          username: 'testviewer',
          role: 'viewer',
          serverIds: [],
        } as AuthUser,
        { expiresIn: '1h' }
      );

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/mobile/sessions',
        headers: { Authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/mobile - Get Mobile Config', () => {
    it('should return mobile config for owner', async () => {
      // Create a session to verify it appears in config
      await db.insert(mobileSessions).values({
        userId: testData.ownerId,
        refreshTokenHash: 'config-test-refresh-hash-abcdef1234567890abcd',
        deviceName: 'Config Test Device',
        deviceId: 'device-config-test',
        platform: 'ios',
        expoPushToken: 'ExponentPushToken[test123]',
      });

      const ownerToken = generateOwnerToken(app, testData);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/mobile',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.isEnabled).toBe(true);
      expect(body.sessions).toBeDefined();
      expect(body.sessions.length).toBe(1);
      expect(body.sessions[0].deviceName).toBe('Config Test Device');
      expect(body.sessions[0].platform).toBe('ios');
      expect(body.serverName).toBeDefined();
      expect(body.maxDevices).toBe(5);
    });

    it('should reject non-owner users', async () => {
      const viewerToken = app.jwt.sign(
        {
          userId: testData.ownerId,
          username: 'testviewer',
          role: 'viewer',
          serverIds: [],
        } as AuthUser,
        { expiresIn: '1h' }
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/mobile',
        headers: { Authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/v1/mobile/enable - Enable Mobile Access', () => {
    beforeEach(async () => {
      // Ensure mobile is disabled
      await db.update(settings).set({ mobileEnabled: false }).where(eq(settings.id, 1));
    });

    it('should enable mobile access as owner', async () => {
      const ownerToken = generateOwnerToken(app, testData);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/enable',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().isEnabled).toBe(true);

      // Verify in database
      const [settingsRow] = await db.select().from(settings).where(eq(settings.id, 1));
      expect(settingsRow.mobileEnabled).toBe(true);
    });

    it('should reject non-owner users', async () => {
      const viewerToken = app.jwt.sign(
        {
          userId: testData.ownerId,
          username: 'testviewer',
          role: 'viewer',
          serverIds: [],
        } as AuthUser,
        { expiresIn: '1h' }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/enable',
        headers: { Authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/v1/mobile/disable - Disable Mobile Access', () => {
    it('should disable mobile access and revoke all sessions', async () => {
      // Create some sessions
      for (let i = 0; i < 2; i++) {
        await db.insert(mobileSessions).values({
          userId: testData.ownerId,
          refreshTokenHash: `disable-test-refresh-hash-${i}-abcdef1234567`,
          deviceName: `Device ${i}`,
          deviceId: `device-disable-${i}`,
          platform: 'ios',
        });
      }

      const ownerToken = generateOwnerToken(app, testData);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/disable',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // Verify mobile is disabled
      const [settingsRow] = await db.select().from(settings).where(eq(settings.id, 1));
      expect(settingsRow.mobileEnabled).toBe(false);

      // Verify all sessions were revoked
      const sessions = await db.select().from(mobileSessions);
      expect(sessions.length).toBe(0);
    });

    it('should reject non-owner users', async () => {
      const viewerToken = app.jwt.sign(
        {
          userId: testData.ownerId,
          username: 'testviewer',
          role: 'viewer',
          serverIds: [],
        } as AuthUser,
        { expiresIn: '1h' }
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/mobile/disable',
        headers: { Authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
