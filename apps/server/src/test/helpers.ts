/**
 * Test helper utilities for creating Fastify instances and mock data
 */

import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { AuthUser } from '@tracearr/shared';

// Mock Redis client for testing
export function createMockRedis() {
  const store = new Map<string, string>();

  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    setex: async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (key: string) => {
      store.delete(key);
      return 1;
    },
    ping: async () => 'PONG',
    keys: async (pattern: string) => {
      const prefix = pattern.replace('*', '');
      return Array.from(store.keys()).filter((k) => k.startsWith(prefix));
    },
    _store: store, // For test inspection
  };
}

// Create a minimal test Fastify instance with auth
export async function createTestApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
  });

  // Register essential plugins
  await app.register(sensible);
  await app.register(cookie, { secret: 'test-cookie-secret' });
  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'test-jwt-secret-must-be-32-chars-min',
    sign: { algorithm: 'HS256' },
  });

  // Add mock Redis (cast as unknown then to Redis to satisfy TypeScript for testing)
  const mockRedis = createMockRedis();
  app.decorate('redis', mockRedis as unknown as Redis);

  // Add authenticate decorator (same as production)
  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });

  // Add requireOwner decorator (same as production)
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

  return app;
}

// Generate a valid test JWT token
export function generateTestToken(
  app: FastifyInstance,
  payload: AuthUser,
  options?: { expiresIn?: string }
): string {
  return app.jwt.sign(payload, {
    expiresIn: options?.expiresIn ?? '1h',
  });
}

// Create a test owner user payload
export function createOwnerPayload(overrides?: Partial<AuthUser>): AuthUser {
  return {
    userId: 'owner-uuid-1234',
    username: 'testowner',
    role: 'owner',
    serverIds: ['server-1', 'server-2'],
    ...overrides,
  };
}

// Create a test viewer user payload (for testing non-owner access)
export function createViewerPayload(overrides?: Partial<AuthUser>): AuthUser {
  return {
    userId: 'viewer-uuid-5678',
    username: 'testviewer',
    role: 'viewer',
    serverIds: [],
    ...overrides,
  };
}

// Create an expired token (already past expiration)
// We manually craft the token with an exp claim in the past since fast-jwt doesn't allow negative expiresIn
export function generateExpiredToken(app: FastifyInstance, payload: AuthUser): string {
  // Create a token that expires in 1 second, then we'll manually modify the exp
  const token = app.jwt.sign(payload, { expiresIn: '1s' });

  // Decode and modify the exp to be in the past
  const parts = token.split('.');
  const decodedPayload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  decodedPayload.exp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
  decodedPayload.iat = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago

  // Re-encode - signature will be invalid but that's fine for testing
  const modifiedPayload = Buffer.from(JSON.stringify(decodedPayload)).toString('base64url');
  return `${parts[0]}.${modifiedPayload}.${parts[2]}`;
}

// Create a tampered token (valid format but modified payload)
export function generateTamperedToken(validToken: string): string {
  const parts = validToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  // Decode payload, modify it, re-encode without valid signature
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  payload.role = 'owner'; // Try to escalate privileges
  const tamperedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

  // Return token with tampered payload but original signature (will fail verification)
  return `${parts[0]}.${tamperedPayload}.${parts[2]}`;
}

// Create a token signed with wrong secret
export function generateWrongSecretToken(payload: AuthUser): string {
  const wrongApp = Fastify({ logger: false });
  wrongApp.register(jwt, { secret: 'wrong-secret-key-totally-different' });

  // Can't use jwt until registered, so we'll manually create a fake token
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const fakeSignature = 'invalid_signature_here';

  return `${header}.${payloadB64}.${fakeSignature}`;
}

// Common injection payloads for security testing
export const INJECTION_PAYLOADS = {
  sqlInjection: [
    "'; DROP TABLE users; --",
    "1' OR '1'='1",
    "admin'--",
    "1; DELETE FROM sessions WHERE '1'='1",
    "' UNION SELECT * FROM users--",
  ],
  xss: [
    '<script>alert("xss")</script>',
    '"><img src=x onerror=alert(1)>',
    "javascript:alert('xss')",
    '<svg onload=alert(1)>',
  ],
  commandInjection: ['; ls -la', '| cat /etc/passwd', '`whoami`', '$(rm -rf /)'],
  pathTraversal: ['../../../etc/passwd', '..\\..\\..\\windows\\system32', '%2e%2e%2f%2e%2e%2f'],
};
