/**
 * Server User List and CRUD Routes
 *
 * These routes manage server users (accounts on Plex/Jellyfin/Emby servers),
 * not the identity users. Server users have per-server trust scores and session counts.
 *
 * GET / - List all server users with pagination
 * GET /:id - Get server user details
 * PATCH /:id - Update server user (trustScore, etc.)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, sql, inArray } from 'drizzle-orm';
import {
  updateUserSchema,
  updateUserIdentitySchema,
  userIdParamSchema,
  paginationSchema,
  serverIdFilterSchema,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { serverUsers, sessions, servers, users } from '../../db/schema.js';
import { hasServerAccess } from '../../utils/serverFiltering.js';
import { updateUser } from '../../services/userService.js';

export const listRoutes: FastifyPluginAsync = async (app) => {
  // Combined schema for pagination and server filter
  const userListQuerySchema = paginationSchema.extend(serverIdFilterSchema.shape);

  /**
   * GET / - List all server users with pagination
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = userListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page = 1, pageSize = 50, serverId } = query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    // If specific server requested, validate access
    if (serverId && !hasServerAccess(authUser, serverId)) {
      return reply.forbidden('You do not have access to this server');
    }

    // Build conditions for filtering
    const conditions = [];

    // If specific server requested, filter to that server
    if (serverId) {
      conditions.push(eq(serverUsers.serverId, serverId));
    } else if (authUser.role !== 'owner') {
      // No specific server - filter by user's accessible servers (non-owners only)
      if (authUser.serverIds.length === 0) {
        // No server access - return empty result
        return {
          data: [],
          page,
          pageSize,
          total: 0,
          totalPages: 0,
        };
      } else if (authUser.serverIds.length === 1) {
        conditions.push(eq(serverUsers.serverId, authUser.serverIds[0]!));
      } else {
        conditions.push(inArray(serverUsers.serverId, authUser.serverIds));
      }
    }

    const serverUserList = await db
      .select({
        id: serverUsers.id,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        userId: serverUsers.userId,
        externalId: serverUsers.externalId,
        username: serverUsers.username,
        email: serverUsers.email,
        thumbUrl: serverUsers.thumbUrl,
        isServerAdmin: serverUsers.isServerAdmin,
        trustScore: serverUsers.trustScore,
        sessionCount: serverUsers.sessionCount,
        createdAt: serverUsers.createdAt,
        updatedAt: serverUsers.updatedAt,
        // Include identity info
        identityName: users.name,
        role: users.role,
      })
      .from(serverUsers)
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(serverUsers.username)
      .limit(pageSize)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(serverUsers)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const total = countResult[0]?.count ?? 0;

    return {
      data: serverUserList,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });

  /**
   * GET /:id - Get server user details
   */
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    const serverUserRows = await db
      .select({
        id: serverUsers.id,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        userId: serverUsers.userId,
        externalId: serverUsers.externalId,
        username: serverUsers.username,
        email: serverUsers.email,
        thumbUrl: serverUsers.thumbUrl,
        isServerAdmin: serverUsers.isServerAdmin,
        trustScore: serverUsers.trustScore,
        sessionCount: serverUsers.sessionCount,
        createdAt: serverUsers.createdAt,
        updatedAt: serverUsers.updatedAt,
        // Include identity info
        identityName: users.name,
        role: users.role,
      })
      .from(serverUsers)
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    // Verify access (owners can see all servers)
    if (!hasServerAccess(authUser, serverUser.serverId)) {
      return reply.forbidden('You do not have access to this user');
    }

    // Get session stats for this server user
    const statsResult = await db
      .select({
        totalSessions: sql<number>`count(*)::int`,
        totalWatchTime: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
      })
      .from(sessions)
      .where(eq(sessions.serverUserId, id));

    const stats = statsResult[0];

    return {
      ...serverUser,
      stats: {
        totalSessions: stats?.totalSessions ?? 0,
        totalWatchTime: Number(stats?.totalWatchTime ?? 0),
      },
    };
  });

  /**
   * PATCH /:id - Update server user (trustScore, etc.)
   */
  app.patch('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const body = updateUserSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can update users
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update users');
    }

    // Get existing server user
    const serverUserRows = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    // Verify access (owners can see all servers)
    if (!hasServerAccess(authUser, serverUser.serverId)) {
      return reply.forbidden('You do not have access to this user');
    }

    // Build update object
    const updateData: Partial<{
      trustScore: number;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (body.data.trustScore !== undefined) {
      updateData.trustScore = body.data.trustScore;
    }

    // Update server user
    const updated = await db
      .update(serverUsers)
      .set(updateData)
      .where(eq(serverUsers.id, id))
      .returning({
        id: serverUsers.id,
        serverId: serverUsers.serverId,
        userId: serverUsers.userId,
        externalId: serverUsers.externalId,
        username: serverUsers.username,
        email: serverUsers.email,
        thumbUrl: serverUsers.thumbUrl,
        isServerAdmin: serverUsers.isServerAdmin,
        trustScore: serverUsers.trustScore,
        sessionCount: serverUsers.sessionCount,
        createdAt: serverUsers.createdAt,
        updatedAt: serverUsers.updatedAt,
      });

    const updatedServerUser = updated[0];
    if (!updatedServerUser) {
      return reply.internalServerError('Failed to update user');
    }

    return updatedServerUser;
  });

  /**
   * PATCH /:id/identity - Update user identity (display name)
   * Owner-only. Updates the users table (identity), not server_users.
   */
  app.patch('/:id/identity', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const body = updateUserIdentitySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can update user identity
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only owners can update user identity');
    }

    // Get serverUser to find userId (the identity)
    const serverUserRows = await db
      .select({ userId: serverUsers.userId, serverId: serverUsers.serverId })
      .from(serverUsers)
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    // Verify access
    if (!hasServerAccess(authUser, serverUser.serverId)) {
      return reply.forbidden('Access denied');
    }

    // Update the identity record (users table)
    const updated = await updateUser(serverUser.userId, { name: body.data.name });

    return { success: true, name: updated.name };
  });
};
