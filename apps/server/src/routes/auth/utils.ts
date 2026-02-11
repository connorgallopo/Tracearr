/**
 * Auth Route Utilities
 *
 * Shared helpers for authentication routes including token generation,
 * hashing, and Redis key management.
 */

import { createHash, randomBytes } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { JWT_CONFIG, REDIS_KEYS, type AuthUser, type UserRole } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';

// Redis TTLs
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
export const PLEX_TEMP_TOKEN_TTL = 10 * 60; // 10 minutes for server selection

/**
 * Generate a random refresh token
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Hash a refresh token for secure storage
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a temporary token for Plex OAuth flow
 */
export function generateTempToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * Get all server IDs for owner tokens
 */
export async function getAllServerIds(): Promise<string[]> {
  const allServers = await db.select({ id: servers.id }).from(servers);
  return allServers.map((s) => s.id);
}

/**
 * Generate access and refresh tokens for a user
 * Note: Caller must verify canLogin(role) before calling this function
 */
export async function generateTokens(
  app: FastifyInstance,
  userId: string,
  username: string,
  role: UserRole
) {
  // Owners get access to ALL servers
  // TODO: Admins should get servers where they're isServerAdmin=true
  const serverIds = role === 'owner' ? await getAllServerIds() : [];

  const accessPayload: AuthUser = {
    userId,
    username,
    role,
    serverIds,
  };

  const accessToken = app.jwt.sign(accessPayload, {
    expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
  });

  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);

  await app.redis.setex(
    REDIS_KEYS.REFRESH_TOKEN(refreshTokenHash),
    REFRESH_TOKEN_TTL,
    JSON.stringify({ userId, serverIds })
  );

  return { accessToken, refreshToken, user: accessPayload };
}
