/**
 * Test helper utilities for creating Fastify instances and mock data
 */

import Fastify, { type FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { AuthUser } from '@tracearr/shared';
import type { SQL } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import { permissionGuard } from '../lib/scope.js';

const sqlCasingCache = new CasingCache();

// Renders a Drizzle sql`` fragment to SQL text + bound params for test assertions
export function renderSql(
  fragment: SQL,
  escapeParam: (index: number) => string = (num) => `$${num + 1}`
): { sql: string; params: unknown[] } {
  return fragment.toQuery({
    casing: sqlCasingCache,
    escapeName: (n) => n,
    escapeParam,
    escapeString: (s) => `'${s}'`,
    inlineParams: false,
  });
}

// The union of every mocked query shape: an extra method on a chain is inert.
const QUERY_CHAIN_METHODS = [
  'from',
  '$dynamic',
  'innerJoin',
  'leftJoin',
  'leftJoinLateral',
  'where',
  'orderBy',
  'groupBy',
  'limit',
  'offset',
  'set',
  'values',
  'returning',
];

// Chainable Drizzle stub that records every builder argument and resolves to `result`.
// `createMock` is the caller's `vi.fn`: this module compiles into dist, so it cannot import vitest.
export function queryChain(createMock: (impl: () => unknown) => any, result: unknown): any {
  const chain: Record<string, unknown> = {};
  for (const method of QUERY_CHAIN_METHODS) {
    chain[method] = createMock(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

// Renders an argument a queryChain recorded as normalized SQL text plus its bound params.
export function renderCall(
  chain: any,
  method: 'where' | 'orderBy' = 'where',
  index = 0
): { text: string; params: unknown[] } {
  const arg = chain[method].mock.calls[index]?.[0] as SQL | undefined;
  if (!arg) throw new Error(`${method} was never called`);
  const rendered = renderSql(arg);
  return { text: rendered.sql.replace(/\s+/g, ' ').trim(), params: rendered.params };
}

// The ON condition of every join of one kind a chain recorded, in join order.
export function renderedJoins(
  chain: any,
  method: 'innerJoin' | 'leftJoin' = 'innerJoin'
): string[] {
  return chain[method].mock.calls.map((call: unknown[]) =>
    renderSql(call[1] as SQL)
      .sql.replace(/\s+/g, ' ')
      .trim()
  );
}

// Every WHERE the given chains recorded, in call order.
export function renderedWheres(chains: any[]): string[] {
  return chains.flatMap((chain: any) =>
    chain.where.mock.calls.map(
      (_call: unknown, index: number) => renderCall(chain, 'where', index).text
    )
  );
}

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
    info: async () => 'redis_version:7.0.0',
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

  // Test stub, NOT the production dual-verify decorator (see plugins/auth.ts):
  // verifies a legacy JWT only, with no Better Auth session resolution.
  app.decorate('authenticate', async function (request: any, reply: any) {
    try {
      await request.jwtVerify();
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
  });
  app.decorate('requirePermission', permissionGuard(app));

  // Test stub, NOT the production dual-verify decorator (see plugins/auth.ts).
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

// Create a test member user payload (for testing non-owner access)
export function createMemberPayload(overrides?: Partial<AuthUser>): AuthUser {
  return {
    userId: 'member-uuid-5678',
    username: 'testmember',
    role: 'member',
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
