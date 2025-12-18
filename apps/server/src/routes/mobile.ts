/**
 * Mobile routes - Mobile app pairing, authentication, and session management
 *
 * Settings endpoints (owner only):
 * - GET /mobile - Get mobile config (enabled status, sessions)
 * - POST /mobile/enable - Enable mobile access
 * - POST /mobile/disable - Disable mobile access
 * - POST /mobile/pair-token - Generate one-time pairing token
 * - DELETE /mobile/sessions - Revoke all mobile sessions
 * - DELETE /mobile/sessions/:id - Revoke single mobile session
 *
 * Auth endpoints (mobile app):
 * - POST /mobile/pair - Exchange pairing token for JWT
 * - POST /mobile/refresh - Refresh mobile JWT
 * - POST /mobile/push-token - Register push token
 *
 * Stream management (admin/owner via mobile):
 * - POST /mobile/streams/:id/terminate - Terminate a playback session
 */

import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomBytes } from 'crypto';
import { eq, and, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  MobileConfig,
  MobileSession,
  MobilePairResponse,
  MobilePairTokenResponse,
} from '@tracearr/shared';
import {
  REDIS_KEYS,
  CACHE_TTL,
  sessionIdParamSchema,
  terminateSessionBodySchema,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { mobileTokens, mobileSessions, servers, users, settings, sessions } from '../db/schema.js';
import { terminateSession } from '../services/termination.js';
import { hasServerAccess } from '../utils/serverFiltering.js';

// Rate limits for mobile auth endpoints
const MOBILE_PAIR_MAX_ATTEMPTS = 5; // 5 attempts per 15 minutes
const MOBILE_REFRESH_MAX_ATTEMPTS = 30; // 30 attempts per 15 minutes

// Beta mode: allows reusable tokens, no expiry, unlimited devices
// Useful for TestFlight/beta testing where you need to share a single token
// Using a function to allow dynamic checking (useful for testing)
function isBetaMode(): boolean {
  return process.env.MOBILE_BETA_MODE === 'true';
}

// Limits
const MAX_PAIRED_DEVICES = 5;
const MAX_PENDING_TOKENS = 3;
const TOKEN_EXPIRY_MINUTES = 15;
const BETA_TOKEN_EXPIRY_YEARS = 100; // Effectively never expires
const TOKEN_GEN_RATE_LIMIT = 3; // Max tokens per 5 minutes
const TOKEN_GEN_RATE_WINDOW = 5 * 60; // 5 minutes in seconds

// Token format: trr_mob_<32 random bytes as base64url>
const MOBILE_TOKEN_PREFIX = 'trr_mob_';

// Redis key prefixes for mobile refresh tokens
const MOBILE_REFRESH_PREFIX = 'tracearr:mobile_refresh:';
const MOBILE_REFRESH_TTL = 90 * 24 * 60 * 60; // 90 days

// Mobile JWT expiry (longer than web)
const MOBILE_ACCESS_EXPIRY = '7d';

// Schemas
const mobilePairSchema = z.object({
  token: z.string().min(1),
  deviceName: z.string().min(1).max(100),
  deviceId: z.string().min(1).max(100),
  platform: z.enum(['ios', 'android']),
  deviceSecret: z.string().min(32).max(64).optional(), // Base64-encoded device secret for push encryption
});

const mobileRefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const pushTokenSchema = z.object({
  expoPushToken: z
    .string()
    .min(1)
    .regex(/^ExponentPushToken\[.+\]$/, 'Invalid Expo push token format'),
  deviceSecret: z.string().min(32).max(64).optional(), // Update device secret for push encryption
});

/**
 * Generate a new mobile access token
 */
function generateMobileToken(): string {
  const randomPart = randomBytes(32).toString('base64url');
  return `${MOBILE_TOKEN_PREFIX}${randomPart}`;
}

/**
 * Hash a token using SHA-256
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a refresh token
 */
function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

export const mobileRoutes: FastifyPluginAsync = async (app) => {
  // Log beta mode status on startup
  if (isBetaMode()) {
    app.log.warn(
      'MOBILE_BETA_MODE enabled: tokens are reusable, never expire, unlimited devices allowed'
    );
  }

  // ============================================
  // Settings endpoints (owner only)
  // ============================================

  /**
   * GET /mobile - Get mobile config
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access mobile settings');
    }

    // Get mobile enabled status from settings
    const settingsRow = await db
      .select({ mobileEnabled: settings.mobileEnabled })
      .from(settings)
      .limit(1);
    const isEnabled = settingsRow[0]?.mobileEnabled ?? false;

    // Get mobile sessions
    const sessionsRows = await db.select().from(mobileSessions);

    // Count pending tokens (unexpired and unused)
    const pendingTokensResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mobileTokens)
      .where(and(gt(mobileTokens.expiresAt, new Date()), isNull(mobileTokens.usedAt)));
    const pendingTokens = pendingTokensResult[0]?.count ?? 0;

    // Get server name
    const serverRow = await db.select({ name: servers.name }).from(servers).limit(1);
    const serverName = serverRow[0]?.name || 'Tracearr';

    const sessions: MobileSession[] = sessionsRows.map((s) => ({
      id: s.id,
      deviceName: s.deviceName,
      deviceId: s.deviceId,
      platform: s.platform,
      expoPushToken: s.expoPushToken,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
    }));

    const config: MobileConfig = {
      isEnabled,
      sessions,
      serverName,
      pendingTokens,
      maxDevices: MAX_PAIRED_DEVICES,
    };

    return config;
  });

  /**
   * POST /mobile/enable - Enable mobile access (no token generated)
   */
  app.post('/enable', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can enable mobile access');
    }

    // Update settings to enable mobile
    await db
      .update(settings)
      .set({ mobileEnabled: true, updatedAt: new Date() })
      .where(eq(settings.id, 1));

    // Get current state for response
    const sessionsRows = await db.select().from(mobileSessions);
    const serverRow = await db.select({ name: servers.name }).from(servers).limit(1);
    const serverName = serverRow[0]?.name || 'Tracearr';

    const sessions: MobileSession[] = sessionsRows.map((s) => ({
      id: s.id,
      deviceName: s.deviceName,
      deviceId: s.deviceId,
      platform: s.platform,
      expoPushToken: s.expoPushToken,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
    }));

    const config: MobileConfig = {
      isEnabled: true,
      sessions,
      serverName,
      pendingTokens: 0,
      maxDevices: MAX_PAIRED_DEVICES,
    };

    app.log.info({ userId: authUser.userId }, 'Mobile access enabled');

    return config;
  });

  /**
   * POST /mobile/pair-token - Generate a one-time pairing token
   *
   * Rate limited: 3 tokens per 5 minutes per user
   * Max pending tokens: 3
   * Max paired devices: 5
   */
  app.post('/pair-token', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can generate pairing tokens');
    }

    // Check if mobile is enabled
    const settingsRow = await db
      .select({ mobileEnabled: settings.mobileEnabled })
      .from(settings)
      .limit(1);
    if (!settingsRow[0]?.mobileEnabled) {
      return reply.badRequest('Mobile access is not enabled');
    }

    // Rate limiting: max 3 tokens per 5 minutes
    // Use Lua script for atomic INCR + EXPIRE operation
    const rateLimitKey = `mobile_token_gen:${authUser.userId}`;
    const luaScript = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return current
    `;
    const currentCount = (await app.redis.eval(
      luaScript,
      1,
      rateLimitKey,
      TOKEN_GEN_RATE_WINDOW
    )) as number;

    if (currentCount > TOKEN_GEN_RATE_LIMIT) {
      const ttl = await app.redis.ttl(rateLimitKey);
      reply.header('Retry-After', String(ttl > 0 ? ttl : TOKEN_GEN_RATE_WINDOW));
      return reply.tooManyRequests('Too many token generation attempts. Please try again later.');
    }

    // Use transaction to prevent race conditions on device and token limit checks
    let plainToken: string;
    let expiresAt: Date;

    try {
      const result = await db.transaction(async (tx) => {
        // Set serializable isolation level to prevent phantom reads
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);

        // Check max pending tokens (within transaction for consistency)
        const pendingTokensResult = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(mobileTokens)
          .where(and(gt(mobileTokens.expiresAt, new Date()), isNull(mobileTokens.usedAt)));
        const pendingCount = pendingTokensResult[0]?.count ?? 0;

        if (pendingCount >= MAX_PENDING_TOKENS) {
          throw new Error('MAX_PENDING_TOKENS');
        }

        // Check max paired devices (within transaction to prevent race condition)
        const sessionsCount = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(mobileSessions);
        const deviceCount = sessionsCount[0]?.count ?? 0;

        // In beta mode, allow unlimited devices
        if (!isBetaMode() && deviceCount >= MAX_PAIRED_DEVICES) {
          throw new Error('MAX_PAIRED_DEVICES');
        }

        // Generate token
        const token = generateMobileToken();
        const tokenHash = hashToken(token);
        // In beta mode, tokens effectively never expire
        const expiryMs = isBetaMode()
          ? BETA_TOKEN_EXPIRY_YEARS * 365 * 24 * 60 * 60 * 1000
          : TOKEN_EXPIRY_MINUTES * 60 * 1000;
        const expires = new Date(Date.now() + expiryMs);

        await tx.insert(mobileTokens).values({
          tokenHash,
          expiresAt: expires,
          createdBy: authUser.userId,
        });

        return { token, expires };
      });

      plainToken = result.token;
      expiresAt = result.expires;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      if (message === 'MAX_PENDING_TOKENS') {
        return reply.badRequest(
          `Maximum of ${MAX_PENDING_TOKENS} pending tokens allowed. Wait for expiry or use an existing token.`
        );
      }
      if (message === 'MAX_PAIRED_DEVICES') {
        return reply.badRequest(
          `Maximum of ${MAX_PAIRED_DEVICES} devices allowed. Remove a device first.`
        );
      }

      app.log.error({ err }, 'Token generation transaction failed');
      return reply.internalServerError('Failed to generate token. Please try again.');
    }

    app.log.info({ userId: authUser.userId }, 'Mobile pairing token generated');

    const response: MobilePairTokenResponse = {
      token: plainToken,
      expiresAt,
    };

    return response;
  });

  /**
   * POST /mobile/disable - Disable mobile access
   */
  app.post('/disable', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can disable mobile access');
    }

    // Disable in settings
    await db
      .update(settings)
      .set({ mobileEnabled: false, updatedAt: new Date() })
      .where(eq(settings.id, 1));

    // Revoke all mobile sessions (delete from DB and Redis)
    const sessionsRows = await db.select().from(mobileSessions);
    for (const session of sessionsRows) {
      await app.redis.del(`${MOBILE_REFRESH_PREFIX}${session.refreshTokenHash}`);
    }
    await db.delete(mobileSessions);

    // Delete all pending tokens
    await db.delete(mobileTokens);

    app.log.info({ userId: authUser.userId }, 'Mobile access disabled');

    return { success: true };
  });

  /**
   * DELETE /mobile/sessions - Revoke all mobile sessions
   */
  app.delete('/sessions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can revoke mobile sessions');
    }

    // Delete all sessions from Redis and DB
    const sessionsRows = await db.select().from(mobileSessions);
    for (const session of sessionsRows) {
      await app.redis.del(`${MOBILE_REFRESH_PREFIX}${session.refreshTokenHash}`);
    }
    await db.delete(mobileSessions);

    app.log.info(
      { userId: authUser.userId, count: sessionsRows.length },
      'All mobile sessions revoked'
    );

    return { success: true, revokedCount: sessionsRows.length };
  });

  /**
   * DELETE /mobile/sessions/:id - Revoke a single mobile session
   */
  app.delete('/sessions/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can revoke mobile sessions');
    }

    const { id } = request.params as { id: string };

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return reply.badRequest('Invalid session ID format');
    }

    // Find the session
    const sessionRow = await db
      .select()
      .from(mobileSessions)
      .where(eq(mobileSessions.id, id))
      .limit(1);

    if (sessionRow.length === 0) {
      return reply.notFound('Mobile session not found');
    }

    const session = sessionRow[0]!;

    // Delete refresh token from Redis
    await app.redis.del(`${MOBILE_REFRESH_PREFIX}${session.refreshTokenHash}`);

    // Delete session from DB (notification_preferences cascade-deleted via FK)
    await db.delete(mobileSessions).where(eq(mobileSessions.id, id));

    app.log.info(
      { userId: authUser.userId, sessionId: id, deviceName: session.deviceName },
      'Mobile session revoked'
    );

    return { success: true };
  });

  // ============================================
  // Auth endpoints (mobile app)
  // ============================================

  /**
   * POST /mobile/pair - Exchange pairing token for JWT
   *
   * Rate limited: 5 attempts per IP per 15 minutes to prevent brute force
   */
  app.post('/pair', async (request, reply) => {
    // Rate limiting check - use Lua script for atomic INCR + EXPIRE
    const clientIp = request.ip;
    const rateLimitKey = REDIS_KEYS.RATE_LIMIT_MOBILE_PAIR(clientIp);
    const luaScript = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return current
    `;
    const currentCount = (await app.redis.eval(
      luaScript,
      1,
      rateLimitKey,
      CACHE_TTL.RATE_LIMIT
    )) as number;

    if (currentCount > MOBILE_PAIR_MAX_ATTEMPTS) {
      const ttl = await app.redis.ttl(rateLimitKey);
      app.log.warn({ ip: clientIp, count: currentCount }, 'Mobile pair rate limit exceeded');
      reply.header('Retry-After', String(ttl > 0 ? ttl : CACHE_TTL.RATE_LIMIT));
      return reply.tooManyRequests('Too many pairing attempts. Please try again later.');
    }

    const body = mobilePairSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid pairing request');
    }

    const { token, deviceName, deviceId, platform, deviceSecret } = body.data;

    // Verify token starts with correct prefix
    if (!token.startsWith(MOBILE_TOKEN_PREFIX)) {
      return reply.unauthorized('Invalid mobile token');
    }

    const tokenHash = hashToken(token);

    // Check max devices before attempting pair
    const sessionsCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mobileSessions);
    const deviceCount = sessionsCount[0]?.count ?? 0;

    // Check if this device is already paired (would be an update, not new)
    const existingSession = await db
      .select()
      .from(mobileSessions)
      .where(eq(mobileSessions.deviceId, deviceId))
      .limit(1);

    // In beta mode, allow unlimited devices
    if (!isBetaMode() && existingSession.length === 0 && deviceCount >= MAX_PAIRED_DEVICES) {
      return reply.badRequest(
        `Maximum of ${MAX_PAIRED_DEVICES} devices allowed. Remove a device first.`
      );
    }

    // Use transaction with row-level locking to prevent race conditions
    let result: {
      accessToken: string;
      refreshToken: string;
      owner: { id: string; username: string };
      serverName: string;
      serverId: string;
      serverType: 'plex' | 'jellyfin' | 'emby';
      serverIds: string[];
      oldRefreshTokenHash?: string; // Track old hash for cleanup outside transaction
    };

    try {
      result = await db.transaction(async (tx) => {
        // Set serializable isolation level to prevent phantom reads
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);

        // Lock and validate token
        const tokenRows = await tx
          .select()
          .from(mobileTokens)
          .where(eq(mobileTokens.tokenHash, tokenHash))
          .for('update')
          .limit(1);

        if (tokenRows.length === 0) {
          throw new Error('INVALID_TOKEN');
        }

        const tokenRow = tokenRows[0]!;

        // In beta mode, allow tokens to be reused
        if (tokenRow.usedAt && !isBetaMode()) {
          throw new Error('TOKEN_ALREADY_USED');
        }

        if (tokenRow.expiresAt < new Date()) {
          throw new Error('TOKEN_EXPIRED');
        }

        // Get the owner user
        const ownerRow = await tx.select().from(users).where(eq(users.role, 'owner')).limit(1);

        if (ownerRow.length === 0) {
          throw new Error('NO_OWNER');
        }

        const owner = ownerRow[0]!;

        // Get all server IDs for the JWT
        const allServers = await tx
          .select({ id: servers.id, name: servers.name, type: servers.type })
          .from(servers);
        const serverIds = allServers.map((s) => s.id);

        // Get primary server info for the response (first server)
        const primaryServer = allServers[0];
        const serverName = primaryServer?.name || 'Tracearr';
        const serverId = primaryServer?.id || '';
        const serverType = primaryServer?.type || 'plex';

        // Generate refresh token
        const newRefreshToken = generateRefreshToken();
        const refreshTokenHash = hashToken(newRefreshToken);

        // Track old refresh token hash for cleanup (if updating existing session)
        let oldHash: string | undefined;

        // Create or update session
        if (existingSession.length > 0) {
          // Update existing session - save old hash for cleanup outside transaction
          oldHash = existingSession[0]!.refreshTokenHash;

          await tx
            .update(mobileSessions)
            .set({
              refreshTokenHash,
              deviceName,
              platform,
              deviceSecret: deviceSecret ?? null,
              lastSeenAt: new Date(),
              // Update userId in case the token creator changed
              userId: owner.id,
            })
            .where(eq(mobileSessions.id, existingSession[0]!.id));
        } else {
          // Create new session - link to the owner user who generated the pairing token
          await tx.insert(mobileSessions).values({
            refreshTokenHash,
            deviceName,
            deviceId,
            platform,
            deviceSecret: deviceSecret ?? null,
            userId: owner.id,
          });
        }

        // Mark token as used (not deleted - for audit trail)
        // In beta mode, don't mark as used so token can be reused
        if (!isBetaMode()) {
          await tx
            .update(mobileTokens)
            .set({ usedAt: new Date() })
            .where(eq(mobileTokens.id, tokenRow.id));
        }

        // Generate access token
        const accessToken = app.jwt.sign(
          {
            userId: owner.id,
            username: owner.username,
            role: 'owner',
            serverIds,
            mobile: true,
            deviceId,
          },
          { expiresIn: MOBILE_ACCESS_EXPIRY }
        );

        return {
          accessToken,
          refreshToken: newRefreshToken,
          owner: { id: owner.id, username: owner.username },
          serverName,
          serverId,
          serverType,
          serverIds,
          oldRefreshTokenHash: oldHash,
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      if (message === 'INVALID_TOKEN') {
        return reply.unauthorized('Invalid mobile token');
      }
      if (message === 'TOKEN_ALREADY_USED') {
        return reply.unauthorized('This pairing token has already been used');
      }
      if (message === 'TOKEN_EXPIRED') {
        return reply.unauthorized('This pairing token has expired');
      }
      if (message === 'NO_OWNER') {
        return reply.internalServerError('No owner account found');
      }

      app.log.error({ err }, 'Mobile pairing transaction failed');
      return reply.internalServerError('Pairing failed. Please try again.');
    }

    // Redis operations AFTER transaction commits (to prevent inconsistency on rollback)
    // Delete old refresh token from Redis if we updated an existing session
    if (result.oldRefreshTokenHash) {
      await app.redis.del(`${MOBILE_REFRESH_PREFIX}${result.oldRefreshTokenHash}`);
    }

    // Store new refresh token in Redis
    await app.redis.setex(
      `${MOBILE_REFRESH_PREFIX}${hashToken(result.refreshToken)}`,
      MOBILE_REFRESH_TTL,
      JSON.stringify({ userId: result.owner.id, deviceId })
    );

    app.log.info({ deviceName, platform, deviceId }, 'Mobile device paired');

    const response: MobilePairResponse = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      server: {
        id: result.serverId,
        name: result.serverName,
        type: result.serverType,
      },
      user: {
        userId: result.owner.id,
        username: result.owner.username,
        role: 'owner',
      },
    };

    return response;
  });

  /**
   * POST /mobile/refresh - Refresh mobile JWT
   *
   * Rate limited: 30 attempts per IP per 15 minutes to prevent abuse
   */
  app.post('/refresh', async (request, reply) => {
    // Rate limiting check - use Lua script for atomic INCR + EXPIRE
    const clientIp = request.ip;
    const rateLimitKey = REDIS_KEYS.RATE_LIMIT_MOBILE_REFRESH(clientIp);
    const luaScript = `
      local current = redis.call('INCR', KEYS[1])
      if current == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      return current
    `;
    const currentCount = (await app.redis.eval(
      luaScript,
      1,
      rateLimitKey,
      CACHE_TTL.RATE_LIMIT
    )) as number;

    if (currentCount > MOBILE_REFRESH_MAX_ATTEMPTS) {
      const ttl = await app.redis.ttl(rateLimitKey);
      app.log.warn({ ip: clientIp, count: currentCount }, 'Mobile refresh rate limit exceeded');
      reply.header('Retry-After', String(ttl > 0 ? ttl : CACHE_TTL.RATE_LIMIT));
      return reply.tooManyRequests('Too many refresh attempts. Please try again later.');
    }

    const body = mobileRefreshSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid refresh request');
    }

    const { refreshToken } = body.data;
    const refreshTokenHash = hashToken(refreshToken);

    // Check Redis for valid refresh token
    const stored = await app.redis.get(`${MOBILE_REFRESH_PREFIX}${refreshTokenHash}`);
    if (!stored) {
      return reply.unauthorized('Invalid or expired refresh token');
    }

    const { userId, deviceId } = JSON.parse(stored) as { userId: string; deviceId: string };

    // Verify user still exists and is owner
    const userRow = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (userRow.length === 0 || userRow[0]!.role !== 'owner') {
      await app.redis.del(`${MOBILE_REFRESH_PREFIX}${refreshTokenHash}`);
      return reply.unauthorized('User no longer valid');
    }

    const user = userRow[0]!;

    // Verify mobile session still exists
    const sessionRow = await db
      .select()
      .from(mobileSessions)
      .where(eq(mobileSessions.refreshTokenHash, refreshTokenHash))
      .limit(1);

    if (sessionRow.length === 0) {
      await app.redis.del(`${MOBILE_REFRESH_PREFIX}${refreshTokenHash}`);
      return reply.unauthorized('Session has been revoked');
    }

    // Get all server IDs
    const allServers = await db.select({ id: servers.id }).from(servers);
    const serverIds = allServers.map((s) => s.id);

    // Generate new access token
    const accessToken = app.jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: 'owner',
        serverIds,
        mobile: true,
        deviceId, // Device identifier for session targeting
      },
      { expiresIn: MOBILE_ACCESS_EXPIRY }
    );

    // Rotate refresh token
    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashToken(newRefreshToken);

    // Update session with new refresh token
    await db
      .update(mobileSessions)
      .set({
        refreshTokenHash: newRefreshTokenHash,
        lastSeenAt: new Date(),
      })
      .where(eq(mobileSessions.id, sessionRow[0]!.id));

    // Update Redis
    await app.redis.del(`${MOBILE_REFRESH_PREFIX}${refreshTokenHash}`);
    await app.redis.setex(
      `${MOBILE_REFRESH_PREFIX}${newRefreshTokenHash}`,
      MOBILE_REFRESH_TTL,
      JSON.stringify({ userId, deviceId })
    );

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  });

  /**
   * POST /mobile/push-token - Register/update Expo push token for notifications
   */
  app.post('/push-token', { preHandler: [app.requireMobile] }, async (request, reply) => {
    const body = pushTokenSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid push token format. Expected ExponentPushToken[...]');
    }

    const { expoPushToken, deviceSecret } = body.data;
    const authUser = request.user;

    // Ensure we have deviceId from JWT (required for mobile tokens)
    if (!authUser.deviceId) {
      return reply.badRequest('Invalid mobile token: missing deviceId. Please re-pair the device.');
    }

    // Build update object (only include deviceSecret if provided)
    const updateData: { expoPushToken: string; lastSeenAt: Date; deviceSecret?: string } = {
      expoPushToken,
      lastSeenAt: new Date(),
    };
    if (deviceSecret) {
      updateData.deviceSecret = deviceSecret;
    }

    // Update only the specific device session identified by deviceId
    const updated = await db
      .update(mobileSessions)
      .set(updateData)
      .where(eq(mobileSessions.deviceId, authUser.deviceId))
      .returning({ id: mobileSessions.id });

    if (updated.length === 0) {
      return reply.notFound(
        'No mobile session found for this device. Please pair the device first.'
      );
    }

    app.log.info(
      { userId: authUser.userId, deviceId: authUser.deviceId },
      'Push token registered for mobile session'
    );

    return { success: true, updatedSessions: updated.length };
  });

  // ============================================================================
  // Stream Management Endpoints (admin/owner via mobile)
  // ============================================================================

  /**
   * POST /mobile/streams/:id/terminate - Terminate a playback session
   *
   * Requires mobile authentication with admin/owner role.
   * Sends a stop command to the media server and logs the termination.
   */
  app.post(
    '/streams/:id/terminate',
    { preHandler: [app.requireMobile] },
    async (request, reply) => {
      const params = sessionIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid session ID');
      }

      const body = terminateSessionBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }

      const { id } = params.data;
      const { reason } = body.data;
      const authUser = request.user;

      // Only admins and owners can terminate sessions
      if (authUser.role !== 'owner' && authUser.role !== 'admin') {
        return reply.forbidden('Only administrators can terminate sessions');
      }

      // Verify the session exists and user has access to its server
      const session = await db
        .select({
          id: sessions.id,
          serverId: sessions.serverId,
          serverUserId: sessions.serverUserId,
          state: sessions.state,
        })
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1);

      const sessionData = session[0];
      if (!sessionData) {
        return reply.notFound('Session not found');
      }

      if (!hasServerAccess(authUser, sessionData.serverId)) {
        return reply.forbidden('You do not have access to this server');
      }

      // Check if session is already stopped
      if (sessionData.state === 'stopped') {
        return reply.conflict('Session has already ended');
      }

      // Attempt termination
      const result = await terminateSession({
        sessionId: id,
        trigger: 'manual',
        triggeredByUserId: authUser.userId,
        reason,
      });

      if (!result.success) {
        app.log.error(
          { sessionId: id, error: result.error, terminationLogId: result.terminationLogId },
          'Failed to terminate session from mobile'
        );
        return reply.code(500).send({
          success: false,
          error: result.error,
          terminationLogId: result.terminationLogId,
        });
      }

      app.log.info(
        { sessionId: id, userId: authUser.userId, deviceId: authUser.deviceId },
        'Session terminated from mobile app'
      );

      return {
        success: true,
        terminationLogId: result.terminationLogId,
        message: 'Stream termination command sent successfully',
      };
    }
  );
};
