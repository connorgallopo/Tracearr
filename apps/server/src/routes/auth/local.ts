/**
 * Local Authentication Routes
 *
 * POST /signup - Create a local account
 * POST /login - Login with local credentials or initiate Plex OAuth
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { PlexClient } from '../../services/mediaServer/index.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { generateTokens } from './utils.js';
import { getUserByEmail, getOwnerUser } from '../../services/userService.js';

// Schemas
const signupSchema = z.object({
  username: z.string().min(3).max(50), // Display name
  email: z.email(),
  password: z.string().min(8).max(100),
});

const localLoginSchema = z.object({
  type: z.literal('local'),
  email: z.email(),
  password: z.string().min(1),
});

const plexLoginSchema = z.object({
  type: z.literal('plex'),
  forwardUrl: z.url().optional(),
});

// Note: Jellyfin login is handled at /auth/jellyfin/login, not here
const loginSchema = z.discriminatedUnion('type', [localLoginSchema, plexLoginSchema]);

export const localRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /signup - Create a local account
   */
  app.post('/signup', async (request, reply) => {
    const body = signupSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest(
        'Invalid signup data: email, username (3-50 chars), password (8+ chars) required'
      );
    }

    const { username, password } = body.data;
    const email = body.data.email.toLowerCase();

    // Check if email already exists
    const existing = await getUserByEmail(email);
    if (existing) {
      return reply.conflict('Email already registered');
    }

    // Check if this is the first user (will be owner)
    const owner = await getOwnerUser();
    const isFirstUser = !owner;

    // Create user with password hash
    // First user becomes owner, subsequent users are viewers
    const passwordHashValue = await hashPassword(password);
    const role = isFirstUser ? 'owner' : 'viewer';

    const [newUser] = await db
      .insert(users)
      .values({
        username,
        email,
        passwordHash: passwordHashValue,
        role,
      })
      .returning();

    if (!newUser) {
      return reply.internalServerError('Failed to create user');
    }

    app.log.info({ userId: newUser.id, role }, 'Local account created');

    return generateTokens(app, newUser.id, newUser.username, newUser.role);
  });

  /**
   * POST /login - Login with local credentials or initiate Plex OAuth
   */
  app.post('/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid login request');
    }

    const { type } = body.data;

    if (type === 'local') {
      const { password } = body.data;
      const email = body.data.email.toLowerCase();

      // Find user by email with password hash
      const userRows = await db
        .select()
        .from(users)
        .where(and(eq(users.email, email), isNotNull(users.passwordHash)))
        .limit(1);

      const user = userRows[0];
      if (!user?.passwordHash) {
        return reply.unauthorized('Invalid email or password');
      }

      // Verify password
      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return reply.unauthorized('Invalid email or password');
      }

      app.log.info({ userId: user.id }, 'Local login successful');

      return generateTokens(app, user.id, user.username, user.role);
    }

    if (type === 'plex') {
      // Plex OAuth - initiate flow
      try {
        const forwardUrl = body.data.forwardUrl;
        const { pinId, authUrl } = await PlexClient.initiateOAuth(forwardUrl);
        return { pinId, authUrl };
      } catch (error) {
        app.log.error({ error }, 'Failed to initiate Plex OAuth');
        return reply.internalServerError('Failed to initiate Plex authentication');
      }
    }

    // This should not be reached due to discriminated union, but handle gracefully
    return reply.badRequest('Invalid login type');
  });
};
