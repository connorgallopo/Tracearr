/**
 * Auth Security Tests
 *
 * Tests to ensure authentication and authorization cannot be bypassed.
 * Covers: token validation, privilege escalation, injection attacks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createTestApp,
  generateTestToken,
  createOwnerPayload,
  createViewerPayload,
  generateExpiredToken,
  generateTamperedToken,
  generateWrongSecretToken,
  INJECTION_PAYLOADS,
} from '../test/helpers.js';

describe('Auth Security', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();

    // Add a protected test route that requires authentication
    app.get('/test/protected', { preHandler: [app.authenticate] }, async (request) => {
      return { user: request.user, message: 'authenticated' };
    });

    // Add an owner-only test route
    app.get('/test/owner-only', { preHandler: [app.requireOwner] }, async (request) => {
      return { user: request.user, message: 'owner access granted' };
    });

    // Add a route that echoes back user input (for injection testing)
    app.post('/test/echo', async (request) => {
      const body = request.body as { input?: string };
      return { received: body.input };
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Token Validation', () => {
    it('should reject requests with no token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or expired token');
    });

    it('should reject requests with empty Authorization header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: '' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject requests with malformed Authorization header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: 'not-a-bearer-token' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject requests with Bearer but no token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: 'Bearer ' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject expired tokens', async () => {
      const expiredToken = generateExpiredToken(app, createOwnerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${expiredToken}` },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Invalid or expired token');
    });

    it('should reject tampered tokens', async () => {
      const validToken = generateTestToken(app, createViewerPayload());
      const tamperedToken = generateTamperedToken(validToken);

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${tamperedToken}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject tokens signed with wrong secret', async () => {
      const wrongSecretToken = generateWrongSecretToken(createOwnerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${wrongSecretToken}` },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject random garbage tokens', async () => {
      const garbageTokens = [
        'not.a.jwt',
        'aaa.bbb.ccc',
        Buffer.from('garbage').toString('base64'),
        '{"userId":"hack"}',
        'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ1c2VySWQiOiJoYWNrIn0.',
      ];

      for (const garbage of garbageTokens) {
        const res = await app.inject({
          method: 'GET',
          url: '/test/protected',
          headers: { Authorization: `Bearer ${garbage}` },
        });

        expect(res.statusCode).toBe(401);
      }
    });

    it('should accept valid tokens', async () => {
      const validToken = generateTestToken(app, createOwnerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${validToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('authenticated');
    });

    it('should preserve user data from valid token', async () => {
      const payload = createOwnerPayload({ username: 'securitytest' });
      const token = generateTestToken(app, payload);

      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.user.username).toBe('securitytest');
      expect(json.user.role).toBe('owner');
    });
  });

  describe('Authorization - Owner-Only Routes', () => {
    it('should reject guest users on owner-only routes', async () => {
      const guestToken = generateTestToken(app, createViewerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/owner-only',
        headers: { Authorization: `Bearer ${guestToken}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('Owner access required');
    });

    it('should accept owner users on owner-only routes', async () => {
      const ownerToken = generateTestToken(app, createOwnerPayload());

      const res = await app.inject({
        method: 'GET',
        url: '/test/owner-only',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('owner access granted');
    });

    it('should reject unauthenticated users on owner-only routes with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/owner-only',
      });

      // Should return 401, not 403 (auth before authz)
      expect(res.statusCode).toBe(401);
    });

    it('should prevent role escalation via token manipulation', async () => {
      // Create a guest token and try to tamper it to become owner
      const guestToken = generateTestToken(app, createViewerPayload());

      // Try various tampering techniques
      const tamperedTokens = [
        generateTamperedToken(guestToken), // Modify payload, keep sig
        guestToken.replace('guest', 'owner'), // Naive string replace
      ];

      for (const tampered of tamperedTokens) {
        const res = await app.inject({
          method: 'GET',
          url: '/test/owner-only',
          headers: { Authorization: `Bearer ${tampered}` },
        });

        // Should either reject as invalid (401) or as unauthorized (403)
        expect([401, 403]).toContain(res.statusCode);
      }
    });
  });

  describe('Injection Prevention', () => {
    it('should safely handle SQL injection payloads in input', async () => {
      for (const payload of INJECTION_PAYLOADS.sqlInjection) {
        const res = await app.inject({
          method: 'POST',
          url: '/test/echo',
          payload: { input: payload },
        });

        // Server should not crash and should echo back the input safely
        expect(res.statusCode).toBe(200);
        const json = res.json();
        // The payload should be treated as a string, not executed
        expect(json.received).toBe(payload);
      }
    });

    it('should safely handle XSS payloads in input', async () => {
      for (const payload of INJECTION_PAYLOADS.xss) {
        const res = await app.inject({
          method: 'POST',
          url: '/test/echo',
          payload: { input: payload },
        });

        expect(res.statusCode).toBe(200);
        // XSS prevention is mainly a frontend concern, but backend should not crash
        expect(res.json().received).toBe(payload);
      }
    });

    it('should safely handle path traversal payloads', async () => {
      for (const payload of INJECTION_PAYLOADS.pathTraversal) {
        const res = await app.inject({
          method: 'POST',
          url: '/test/echo',
          payload: { input: payload },
        });

        expect(res.statusCode).toBe(200);
      }
    });

    it('should handle extremely long input without crashing', async () => {
      const longInput = 'A'.repeat(100000);

      const res = await app.inject({
        method: 'POST',
        url: '/test/echo',
        payload: { input: longInput },
      });

      // Should either accept or reject, but not crash
      expect([200, 413, 400]).toContain(res.statusCode);
    });

    it('should handle null bytes in input', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/test/echo',
        payload: { input: 'test\x00injection' },
      });

      expect(res.statusCode).toBe(200);
    });

    it('should handle unicode edge cases', async () => {
      const unicodePayloads = [
        '\u202E\u0041\u0042\u0043', // Right-to-left override
        '\uFEFF\uFEFF\uFEFF', // BOM characters
        '𝕳𝖊𝖑𝖑𝖔', // Mathematical symbols
        '❤️💻🔒', // Emoji
      ];

      for (const payload of unicodePayloads) {
        const res = await app.inject({
          method: 'POST',
          url: '/test/echo',
          payload: { input: payload },
        });

        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('Header Security', () => {
    it('should not expose sensitive info in error responses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/test/protected',
      });

      const body = res.json();

      // Error should not leak stack traces or internal paths
      expect(JSON.stringify(body)).not.toContain('node_modules');
      expect(JSON.stringify(body)).not.toContain('at Object');
      expect(JSON.stringify(body)).not.toContain('.ts:');
      expect(JSON.stringify(body)).not.toContain('JWT_SECRET');
    });

    it('should handle missing Content-Type gracefully', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/test/echo',
        payload: '{"input":"test"}',
        // No content-type header
      });

      // Should handle gracefully, not crash
      expect([200, 400, 415]).toContain(res.statusCode);
    });
  });

  describe('Token Expiration Edge Cases', () => {
    it('should handle tokens that expire during request', async () => {
      // Token with 1 second expiry
      const shortLivedToken = generateTestToken(app, createOwnerPayload(), { expiresIn: '1s' });

      // First request should work
      const res1 = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${shortLivedToken}` },
      });
      expect(res1.statusCode).toBe(200);

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Second request should fail
      const res2 = await app.inject({
        method: 'GET',
        url: '/test/protected',
        headers: { Authorization: `Bearer ${shortLivedToken}` },
      });
      expect(res2.statusCode).toBe(401);
    });
  });
});
