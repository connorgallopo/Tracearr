/**
 * Authentication plugin for Fastify
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { eq } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import {
  REDIS_KEYS,
  CACHE_TTL,
  MIN_MOBILE_CLIENT_VERSION,
  MOBILE_CLIENT_HEADER,
  compareVersions,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, mobileSessions } from '../db/schema.js';
import { getSetting } from '../services/settings.js';
import { resolveBetterAuthUser, resolveBetterAuthUserStrict } from '../lib/sessionResolver.js';
import { permissionGuard, type Scope } from '../lib/scope.js';
import { requireBetterAuthSecret, isBetterAuthSecretDerived } from '../lib/env.js';
import { ErrorCodes, MobileAuthError } from '../utils/errors.js';
import { hashSha256 } from '../utils/hash.js';

// Module-level cache - populated at startup and refreshed after restore
let _jwtRevokedBefore: number | null = null; // Unix timestamp (seconds)

export async function loadJwtRevokeSettings(): Promise<void> {
  const val = await getSetting('jwtRevokedBefore');
  _jwtRevokedBefore = val ? Math.floor(new Date(val).getTime() / 1000) : null;
}

export function isTokenRevoked(iat: number | undefined): boolean {
  return _jwtRevokedBefore !== null && iat !== undefined && iat < _jwtRevokedBefore;
}

// Public API token prefix
const PUBLIC_API_TOKEN_PREFIX = 'trr_pub_';

// Context attached to public API requests
export interface PublicApiContext {
  userId: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwner: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: ReturnType<typeof permissionGuard>;
    requireMobile: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticatePublicApi: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    publicApiContext?: PublicApiContext;
    /** Set by requirePermission; routes behind authenticate or requireOwner alone never read it. */
    scope: Scope;
  }
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Viewing as another user is read-only. better-auth's own endpoints, stop-impersonating and
// sign-out among them, are mounted on the wildcard handler and never pass through here.
function isImpersonatedWrite(request: FastifyRequest, user: AuthUser): boolean {
  return user.impersonatedBy !== undefined && !READ_METHODS.has(request.method);
}

// Revocation blacklists a deviceId in Redis. Every decorator that accepts a
// legacy JWT has to honour it, not just requireMobile - otherwise a revoked
// device keeps owner access and can re-pair itself. Returns false once answered.
async function assertMobileNotRevoked(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const user = request.user as AuthUser & { deviceId?: string };
  if (!user?.mobile || !user.deviceId) return true;

  const blacklisted = await app.redis.get(REDIS_KEYS.MOBILE_BLACKLISTED_TOKEN(user.deviceId));
  if (blacklisted) {
    reply.unauthorized('Session has been revoked');
    return false;
  }
  return true;
}

// Requests without the header come from apps older than the header itself,
// which cannot show the update screen, so they are never refused on version.
export function assertMobileClientSupported(
  request: FastifyRequest,
  floor: string | null = MIN_MOBILE_CLIENT_VERSION
): void {
  if (floor === null) return;
  const header = request.headers[MOBILE_CLIENT_HEADER];
  const version = typeof header === 'string' ? /^mobile\/(\d+\.\d+\.\d+)/.exec(header)?.[1] : null;
  if (!version) return;
  if (compareVersions(version, floor) < 0) {
    throw new MobileAuthError(
      'Update the Tracearr app to continue',
      426,
      ErrorCodes.CLIENT_TOO_OLD
    );
  }
}

// A failed Redis or DB lookup is not a verdict on the token: answer 503 so the
// app keeps its session, instead of a 401 that signs it out.
export async function failClosed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MobileAuthError) throw err;
    throw Object.assign(
      new MobileAuthError('Auth store unavailable', 503, ErrorCodes.SERVICE_UNAVAILABLE),
      { cause: err }
    );
  }
}

// Throttled lastSeenAt update - at most once per CACHE_TTL.MOBILE_LAST_SEEN
async function touchLastSeen(app: FastifyInstance, deviceId: string): Promise<void> {
  const throttleKey = REDIS_KEYS.MOBILE_LAST_SEEN(deviceId);
  if (await app.redis.get(throttleKey)) return;
  await app.redis.set(throttleKey, '1', 'EX', CACHE_TTL.MOBILE_LAST_SEEN);
  db.update(mobileSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(mobileSessions.deviceId, deviceId))
    .catch(() => undefined);
}

const authPlugin: FastifyPluginAsync = async (app) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  // getAuth() builds the Better Auth instance lazily, so a missing secret
  // would otherwise surface as a 500 on every /api/v1/auth/* request instead
  // of a clear startup failure.
  requireBetterAuthSecret();

  if (isBetterAuthSecretDerived()) {
    app.log.info(
      'BETTER_AUTH_SECRET is not set; deriving it from JWT_SECRET. Set BETTER_AUTH_SECRET explicitly to avoid relying on this derivation.'
    );
  }

  await app.register(jwt, {
    secret,
    sign: {
      algorithm: 'HS256',
    },
    cookie: {
      cookieName: 'token',
      signed: false,
    },
  });

  // Authenticate decorator - resolves a Better Auth session first, falling
  // back to legacy JWT verification (the mobile shim)
  app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    const baUser = await resolveBetterAuthUser(request);
    if (baUser) {
      request.user = baUser;
      if (isImpersonatedWrite(request, baUser)) {
        return reply.forbidden('Viewing as another user is read-only');
      }
      return;
    }
    let revoked = false;
    try {
      await request.jwtVerify();
      revoked = isTokenRevoked((request.user as AuthUser & { iat?: number }).iat);
      if (!revoked) await assertMobileNotRevoked(app, request, reply);
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
    if (revoked) return reply.unauthorized('Session invalidated. Please log in again');
  });

  app.decorate('requirePermission', permissionGuard(app));

  // Require owner role decorator - same dual-verify as authenticate, plus role check
  app.decorate('requireOwner', async function (request: FastifyRequest, reply: FastifyReply) {
    const baUser = await resolveBetterAuthUser(request);
    if (baUser) {
      request.user = baUser;
      if (isImpersonatedWrite(request, baUser)) {
        return reply.forbidden('Viewing as another user is read-only');
      }
      if (baUser.role === 'member') return reply.notFound();
      if (baUser.role !== 'owner') {
        return reply.forbidden('Owner access required');
      }
      return;
    }
    let revoked = false;
    try {
      await request.jwtVerify();
      revoked = isTokenRevoked((request.user as AuthUser & { iat?: number }).iat);
      if (!revoked && (await assertMobileNotRevoked(app, request, reply))) {
        if (request.user.role === 'member') {
          reply.notFound();
        } else if (request.user.role !== 'owner') {
          reply.forbidden('Owner access required');
        }
      }
    } catch {
      reply.unauthorized('Invalid or expired token');
    }
    if (revoked) return reply.unauthorized('Session invalidated. Please log in again');
  });

  // Require mobile token decorator - dual-verify: legacy mobile JWTs first,
  // then Better Auth bearer tokens mapped to a paired device via
  // mobileSessions.refreshTokenHash. Both paths enforce the device blacklist
  // and the throttled lastSeenAt update, and both fail closed.
  app.decorate('requireMobile', async function (request: FastifyRequest) {
    assertMobileClientSupported(request);

    let legacyVerified = false;
    try {
      await request.jwtVerify();
      legacyVerified = true;
    } catch {
      // Not a legacy JWT - fall through to the Better Auth bearer path
    }

    if (legacyVerified) {
      if (isTokenRevoked((request.user as AuthUser & { iat?: number }).iat)) {
        throw new MobileAuthError(
          'Session invalidated. Please log in again',
          401,
          ErrorCodes.SESSION_INVALIDATED
        );
      }
      if (!request.user.mobile) {
        throw new MobileAuthError(
          'Mobile access token required',
          403,
          ErrorCodes.MOBILE_TOKEN_REQUIRED
        );
      }
      const deviceId = request.user.deviceId;
      if (deviceId) {
        await failClosed(async () => {
          if (await app.redis.get(REDIS_KEYS.MOBILE_BLACKLISTED_TOKEN(deviceId))) {
            throw new MobileAuthError('Session has been revoked', 401, ErrorCodes.DEVICE_REVOKED);
          }
          await touchLastSeen(app, deviceId);
        });
      }
      return;
    }

    // Better Auth bearer path: the pair endpoint hands the app a Better Auth
    // session token and stores its sha256 hash on the mobileSessions row, so
    // a resolved session plus a matching row identifies the paired device.
    const authHeader = request.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    await failClosed(async () => {
      const baUser = await resolveBetterAuthUserStrict(request);
      if (!token) {
        // A web cookie session without a bearer is a valid login on the wrong client.
        if (baUser) {
          throw new MobileAuthError(
            'Mobile access token required',
            403,
            ErrorCodes.MOBILE_TOKEN_REQUIRED
          );
        }
        throw new MobileAuthError('Invalid or expired token', 401, ErrorCodes.INVALID_TOKEN);
      }

      const tokenHash = hashSha256(token);
      const [row] = await db
        .select()
        .from(mobileSessions)
        .where(eq(mobileSessions.refreshTokenHash, tokenHash))
        .limit(1);

      if (!baUser) {
        if (row) {
          throw new MobileAuthError('Invalid or expired token', 401, ErrorCodes.TOKEN_EXPIRED);
        }
        if (await app.redis.get(REDIS_KEYS.MOBILE_REVOKED_TOKEN(tokenHash))) {
          throw new MobileAuthError('Invalid or expired token', 401, ErrorCodes.DEVICE_REVOKED);
        }
        throw new MobileAuthError('Invalid or expired token', 401, ErrorCodes.INVALID_TOKEN);
      }
      if (!row) {
        throw new MobileAuthError(
          'Mobile access token required',
          403,
          ErrorCodes.MOBILE_TOKEN_REQUIRED
        );
      }

      if (await app.redis.get(REDIS_KEYS.MOBILE_BLACKLISTED_TOKEN(row.deviceId))) {
        throw new MobileAuthError('Session has been revoked', 401, ErrorCodes.DEVICE_REVOKED);
      }
      await touchLastSeen(app, row.deviceId);

      request.user = { ...baUser, mobile: true, deviceId: row.deviceId };
    });
  });

  // Public API authentication - validates bearer token from Authorization header
  app.decorate(
    'authenticatePublicApi',
    async function (request: FastifyRequest, reply: FastifyReply) {
      const authHeader = request.headers.authorization;

      if (!authHeader?.startsWith('Bearer ')) {
        return reply.unauthorized('Missing or invalid Authorization header');
      }

      const token = authHeader.slice(7); // Remove "Bearer "

      if (!token.startsWith(PUBLIC_API_TOKEN_PREFIX)) {
        return reply.unauthorized('Invalid API key format');
      }

      // Find user with matching token
      const [user] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.apiToken, token))
        .limit(1);

      if (!user) {
        return reply.unauthorized('Invalid API key');
      }

      if (user.role !== 'owner') {
        return reply.forbidden('API key is not associated with an owner account');
      }

      // Attach context for use in route handlers
      request.publicApiContext = { userId: user.id };
    }
  );
};

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['@fastify/cookie'],
});
