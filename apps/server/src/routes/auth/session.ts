/**
 * Session Management Routes
 *
 * POST /refresh - Refresh access token
 * POST /logout - Revoke refresh token
 * GET /me - Get current user info
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { JWT_CONFIG, REDIS_KEYS, canLogin, type AuthUser } from '@tracearr/shared';
import {
  generateRefreshToken,
  hashRefreshToken,
  getAllServerIds,
  REFRESH_TOKEN_TTL,
} from './utils.js';
import { getUserById } from '../../services/userService.js';

// Schema
const refreshSchema = z.object({
  refreshToken: z.string(),
});

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /refresh - Refresh access token
   */
  app.post('/refresh', async (request, reply) => {
    const body = refreshSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { refreshToken } = body.data;
    const refreshTokenHash = hashRefreshToken(refreshToken);

    const stored = await app.redis.get(REDIS_KEYS.REFRESH_TOKEN(refreshTokenHash));
    if (!stored) {
      return reply.unauthorized('Invalid or expired refresh token');
    }

    const { userId } = JSON.parse(stored) as { userId: string; serverIds: string[] };

    const user = await getUserById(userId);

    if (!user) {
      await app.redis.del(REDIS_KEYS.REFRESH_TOKEN(refreshTokenHash));
      return reply.unauthorized('User not found');
    }

    // Check if user can still log in
    if (!canLogin(user.role)) {
      await app.redis.del(REDIS_KEYS.REFRESH_TOKEN(refreshTokenHash));
      return reply.unauthorized('Account is not active');
    }

    // Get fresh server IDs (in case servers were added/removed)
    // TODO: Admins should get servers where they're isServerAdmin=true
    const serverIds = user.role === 'owner' ? await getAllServerIds() : [];

    const accessPayload: AuthUser = {
      userId,
      username: user.username,
      role: user.role,
      serverIds,
    };

    const accessToken = app.jwt.sign(accessPayload, {
      expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
    });

    // Rotate refresh token
    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);

    await app.redis.del(REDIS_KEYS.REFRESH_TOKEN(refreshTokenHash));
    await app.redis.setex(
      REDIS_KEYS.REFRESH_TOKEN(newRefreshTokenHash),
      REFRESH_TOKEN_TTL,
      JSON.stringify({ userId, serverIds })
    );

    return { accessToken, refreshToken: newRefreshToken };
  });

  /**
   * POST /logout - Revoke refresh token
   */
  app.post('/logout', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = refreshSchema.safeParse(request.body);

    if (body.success) {
      const { refreshToken } = body.data;
      await app.redis.del(REDIS_KEYS.REFRESH_TOKEN(hashRefreshToken(refreshToken)));
    }

    reply.clearCookie('token');
    return { success: true };
  });

  /**
   * GET /me - Get current user info
   */
  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = request.user;

    const user = await getUserById(authUser.userId);

    if (!user) {
      // User in JWT doesn't exist in database - token is invalid
      throw app.httpErrors.unauthorized('User no longer exists');
    }

    // Get fresh server IDs
    // TODO: Admins should get servers where they're isServerAdmin=true
    const serverIds = user.role === 'owner' ? await getAllServerIds() : [];

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      thumbnail: user.thumbnail,
      role: user.role,
      aggregateTrustScore: user.aggregateTrustScore,
      serverIds,
      hasPassword: !!user.passwordHash,
      hasPlexLinked: !!user.plexAccountId,
    };
  });
};
