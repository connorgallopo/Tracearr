/**
 * Mobile routes beta mode tests
 *
 * Tests MOBILE_BETA_MODE=true behavior:
 * - Tokens never expire (100 years)
 * - Tokens can be reused (not single-use)
 * - No device limit enforcement
 *
 * This test file sets MOBILE_BETA_MODE before importing the module
 * to ensure the env var is read correctly at module load time.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Set env var BEFORE any imports that might load mobile.ts
process.env.MOBILE_BETA_MODE = 'true';

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

// Import mocked db and routes
import { db } from '../../db/client.js';
import { mobileRoutes } from '../mobile.js';

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

async function buildTestApp(authUser: AuthUser | null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(sensible);

  app.decorate('redis', mockRedis as never);
  app.decorate('jwt', mockJwt as never);

  app.decorate('authenticate', async (request: unknown) => {
    if (authUser) {
      (request as { user: AuthUser }).user = authUser;
    }
  });

  app.decorate('requireMobile', async (request: unknown) => {
    if (authUser) {
      (request as { user: AuthUser }).user = authUser;
    }
  });

  await app.register(mobileRoutes, { prefix: '/mobile' });

  return app;
}

function createOwnerUser(): AuthUser {
  return {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [randomUUID()],
  };
}

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

describe('Mobile Routes - Beta Mode Enabled', () => {
  let app: FastifyInstance;
  const ownerUser = createOwnerUser();

  beforeAll(() => {
    // Verify env var is set
    expect(process.env.MOBILE_BETA_MODE).toBe('true');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.insert).mockReset();
    vi.mocked(db.update).mockReset();
    vi.mocked(db.delete).mockReset();
    vi.mocked(db.transaction).mockReset();
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

  describe('Token reuse in beta mode', () => {
    it('accepts already-used tokens', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

      // Mock device count check
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

      const mockOwner = { id: randomUUID(), username: 'owner', role: 'owner' };
      const mockServerId = randomUUID();

      // Token has usedAt set - should still be accepted in beta mode
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
                    limit: vi.fn().mockResolvedValue([
                      createMockToken({ usedAt: new Date() }), // Already used!
                    ]),
                  }),
                  limit: vi.fn().mockResolvedValue([mockOwner]),
                }),
              }),
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
        payload: {
          token: 'trr_mob_validtokenvalue12345678901234567890',
          deviceName: 'iPhone 15',
          deviceId: 'device-123',
          platform: 'ios',
        },
      });

      // In beta mode, already-used tokens should be accepted
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.accessToken).toBe('mock.jwt.token');
    });

    it('does not mark token as used after pairing', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

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

      const mockOwner = { id: randomUUID(), username: 'owner', role: 'owner' };
      const mockServerId = randomUUID();

      let tokenUpdateCalled = false;
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
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
          update: vi.fn().mockImplementation((_table) => {
            // Check if this is the mobileTokens update (marking as used)
            // In beta mode, this should NOT be called for mobileTokens
            return {
              set: vi.fn().mockImplementation((setValues) => {
                if (setValues.usedAt) {
                  tokenUpdateCalled = true;
                }
                return {
                  where: vi.fn().mockResolvedValue(undefined),
                };
              }),
            };
          }),
        };
        return callback(tx as never);
      });

      mockJwt.sign.mockReturnValue('mock.jwt.token');
      mockRedis.setex.mockResolvedValue('OK');

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

      expect(response.statusCode).toBe(200);
      // In beta mode, token should NOT be marked as used
      expect(tokenUpdateCalled).toBe(false);
    });
  });

  describe('Device limit in beta mode', () => {
    it('allows pairing when at device limit', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

      // Mock device count at limit (5) - should still allow in beta mode
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockResolvedValue([{ count: 5 }]) } as never;
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
        payload: {
          token: 'trr_mob_validtokenvalue12345678901234567890',
          deviceName: 'iPhone 15',
          deviceId: 'device-new',
          platform: 'ios',
        },
      });

      // In beta mode, should succeed even at device limit
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.accessToken).toBe('mock.jwt.token');
    });

    it('allows pairing when exceeding device limit', async () => {
      app = await buildTestApp(null);

      mockRedis.eval.mockResolvedValue(1);

      // Mock device count OVER limit (10 devices)
      let selectCallCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockResolvedValue([{ count: 10 }]) } as never;
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
        payload: {
          token: 'trr_mob_validtokenvalue12345678901234567890',
          deviceName: 'iPhone 15',
          deviceId: 'device-new',
          platform: 'ios',
        },
      });

      // In beta mode, should succeed even with 10+ devices
      expect(response.statusCode).toBe(200);
    });
  });

  describe('Token expiry in beta mode', () => {
    it('generates tokens with 100 year expiry', async () => {
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

      expect(response.statusCode).toBe(200);
      expect(capturedExpiry).not.toBeNull();

      // Token should expire in ~100 years (with some tolerance)
      const expiryMs = capturedExpiry!.getTime() - beforeRequest;
      const expectedExpiryMs = 100 * 365 * 24 * 60 * 60 * 1000; // 100 years in ms
      // Allow 1 day tolerance for leap year calculations
      const tolerance = 24 * 60 * 60 * 1000;
      expect(expiryMs).toBeGreaterThanOrEqual(expectedExpiryMs - tolerance);
      expect(expiryMs).toBeLessThanOrEqual(expectedExpiryMs + tolerance);
    });
  });

  describe('Token generation in beta mode', () => {
    it('allows generating tokens even at device limit', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ mobileEnabled: true }]),
        }),
      } as never);

      mockRedis.eval.mockResolvedValue(1);

      // Mock transaction with different responses for pending tokens vs device count
      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        let txSelectCallCount = 0;
        const tx = {
          execute: vi.fn().mockResolvedValue(undefined),
          select: vi.fn().mockImplementation(() => {
            txSelectCallCount++;
            if (txSelectCallCount === 1) {
              // First query: pending tokens count - return 0 (below limit)
              return {
                from: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([{ count: 0 }]),
                }),
              };
            } else {
              // Second query: device count - return 5 (at limit)
              return {
                from: vi.fn().mockResolvedValue([{ count: 5 }]),
              };
            }
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

      // In beta mode, should succeed even at device limit
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.token).toMatch(/^trr_mob_/);
    });
  });
});
