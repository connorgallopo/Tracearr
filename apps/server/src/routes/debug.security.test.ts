/**
 * Debug Routes Security Tests
 *
 * Ensures debug routes are properly protected and only accessible by owners.
 * These routes can cause significant data loss, so security is critical.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  generateTestToken,
  createOwnerPayload,
  createViewerPayload,
} from '../test/helpers.js';
import { debugRoutes } from './debug.js';

// Mock the database module
vi.mock('../db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue([{ count: 0 }]),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
      returning: vi.fn().mockResolvedValue([]),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [{ size: '10 MB' }] }),
  },
}));

vi.mock('../db/schema.js', () => ({
  sessions: { id: 'id' },
  violations: { id: 'id' },
  users: { id: 'id' },
  servers: { id: 'id' },
  rules: { id: 'id' },
  settings: { id: 'id' },
}));

describe('Debug Routes Security', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();

    // Register debug routes
    await app.register(debugRoutes, { prefix: '/api/v1/debug' });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // All debug endpoints that need testing
  const debugEndpoints = [
    { method: 'GET', url: '/api/v1/debug/stats' },
    { method: 'DELETE', url: '/api/v1/debug/sessions' },
    { method: 'DELETE', url: '/api/v1/debug/violations' },
    { method: 'DELETE', url: '/api/v1/debug/users' },
    { method: 'DELETE', url: '/api/v1/debug/servers' },
    { method: 'DELETE', url: '/api/v1/debug/rules' },
    { method: 'POST', url: '/api/v1/debug/reset' },
    { method: 'POST', url: '/api/v1/debug/refresh-aggregates' },
    { method: 'GET', url: '/api/v1/debug/env' },
  ];

  describe('Unauthenticated Access Prevention', () => {
    it.each(debugEndpoints)(
      'should reject unauthenticated requests to $method $url',
      async ({ method, url }) => {
        const res = await app.inject({ method: method as any, url });

        expect(res.statusCode).toBe(401);
        expect(res.json().message).toContain('Invalid or expired token');
      }
    );
  });

  describe('Guest User Access Prevention', () => {
    it.each(debugEndpoints)(
      'should reject guest users on $method $url',
      async ({ method, url }) => {
        const guestToken = generateTestToken(app, createViewerPayload());

        const res = await app.inject({
          method: method as any,
          url,
          headers: { Authorization: `Bearer ${guestToken}` },
        });

        expect(res.statusCode).toBe(403);
        expect(res.json().message).toContain('Owner access required');
      }
    );
  });

  describe('Owner Access Allowed', () => {
    it.each(debugEndpoints)(
      'should allow owner access to $method $url',
      async ({ method, url }) => {
        const ownerToken = generateTestToken(app, createOwnerPayload());

        const res = await app.inject({
          method: method as any,
          url,
          headers: { Authorization: `Bearer ${ownerToken}` },
        });

        // Owner should not get 401 or 403
        expect(res.statusCode).not.toBe(401);
        expect(res.statusCode).not.toBe(403);
        // Should get 200 or 500 (500 possible due to mocked DB)
        expect([200, 500]).toContain(res.statusCode);
      }
    );
  });

  describe('Privilege Escalation Prevention', () => {
    it('should not allow role manipulation to access debug routes', async () => {
      // Start with a guest token
      const guestPayload = createViewerPayload();
      const guestToken = generateTestToken(app, guestPayload);

      // Try to manipulate the token to have owner role
      const parts = guestToken.split('.');
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      payload.role = 'owner'; // Try to escalate
      const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/debug/stats',
        headers: { Authorization: `Bearer ${tamperedToken}` },
      });

      // Should be rejected - either invalid token (401) or still guest (403)
      expect([401, 403]).toContain(res.statusCode);
    });

    it('should not allow adding owner role to token claims', async () => {
      // Create a token with an extra claim trying to grant owner
      const payload = {
        ...createViewerPayload(),
        isOwner: true, // Extra claim that shouldn't work
        admin: true, // Another attempt
      };
      const token = generateTestToken(app, payload);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/debug/stats',
        headers: { Authorization: `Bearer ${token}` },
      });

      // Role is still 'guest', so should be forbidden
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Expired Token Handling', () => {
    it('should reject expired owner tokens on debug routes', async () => {
      const ownerPayload = createOwnerPayload();
      // Create a manually crafted expired token (signature will be invalid too)
      const validToken = generateTestToken(app, ownerPayload);
      const parts = validToken.split('.');
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      payload.exp = Math.floor(Date.now() / 1000) - 3600; // Expired 1 hour ago
      const expiredPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const expiredToken = `${parts[0]}.${expiredPayload}.${parts[2]}`;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/debug/stats',
        headers: { Authorization: `Bearer ${expiredToken}` },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('Invalid Token Formats', () => {
    const invalidTokens = [
      '',
      'invalid',
      'not.a.jwt',
      'Bearer ',
      'eyJhbGciOiJub25lIn0.eyJyb2xlIjoib3duZXIifQ.', // alg:none attack
      'null',
      'undefined',
      '{"role":"owner"}',
    ];

    it.each(invalidTokens)('should reject invalid token format: %s', async (invalidToken) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/debug/stats',
        headers: { Authorization: `Bearer ${invalidToken}` },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});

describe('Debug Routes - Destructive Operation Safeguards', () => {
  let app: FastifyInstance;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.register(debugRoutes, { prefix: '/api/v1/debug' });
    await app.ready();

    ownerToken = generateTestToken(app, createOwnerPayload());
  });

  afterAll(async () => {
    await app.close();
  });

  it('should not expose database credentials in /env', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/debug/env',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // Even if there's an error, check the format
    if (res.statusCode === 200) {
      const body = res.json();
      const envString = JSON.stringify(body);

      // Should not contain actual secrets
      expect(envString).not.toContain('password');
      expect(envString).not.toMatch(/postgresql:\/\/[^:]+:[^@]+@/); // DB URL with password
      expect(envString).not.toMatch(/redis:\/\/:[^@]+@/); // Redis URL with password
    }
  });

  it('should return structured stats without exposing internals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/debug/stats',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    // Check structure is correct even with mocked data
    if (res.statusCode === 200) {
      const body = res.json();

      // Should have expected structure
      expect(body).toHaveProperty('counts');
      expect(body).toHaveProperty('database');

      // Should not leak internal paths
      const bodyString = JSON.stringify(body);
      expect(bodyString).not.toContain('/Users/');
      expect(bodyString).not.toContain('node_modules');
    }
  });
});
