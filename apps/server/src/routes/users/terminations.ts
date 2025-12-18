/**
 * User Terminations Route
 *
 * GET /:id/terminations - Get termination history for a user
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, sql } from 'drizzle-orm';
import { userIdParamSchema, paginationSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { serverUsers, terminationLogs, users, rules, sessions } from '../../db/schema.js';

export const terminationsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /:id/terminations - Get termination history for a user
   *
   * Returns all stream terminations where this user's streams were killed,
   * including who triggered it (manual) or which rule (automated).
   */
  app.get('/:id/terminations', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = paginationSchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const { page = 1, pageSize = 20 } = query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    // Verify server user exists and access
    const serverUserRows = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    if (!authUser.serverIds.includes(serverUser.serverId)) {
      return reply.forbidden('You do not have access to this user');
    }

    // Get termination logs with joined data
    const terminations = await db
      .select({
        id: terminationLogs.id,
        sessionId: terminationLogs.sessionId,
        serverId: terminationLogs.serverId,
        serverUserId: terminationLogs.serverUserId,
        trigger: terminationLogs.trigger,
        triggeredByUserId: terminationLogs.triggeredByUserId,
        triggeredByUsername: users.username,
        ruleId: terminationLogs.ruleId,
        ruleName: rules.name,
        violationId: terminationLogs.violationId,
        reason: terminationLogs.reason,
        success: terminationLogs.success,
        errorMessage: terminationLogs.errorMessage,
        createdAt: terminationLogs.createdAt,
        // Session info
        mediaTitle: sessions.mediaTitle,
        mediaType: sessions.mediaType,
      })
      .from(terminationLogs)
      .leftJoin(users, eq(terminationLogs.triggeredByUserId, users.id))
      .leftJoin(rules, eq(terminationLogs.ruleId, rules.id))
      .leftJoin(sessions, eq(terminationLogs.sessionId, sessions.id))
      .where(eq(terminationLogs.serverUserId, id))
      .orderBy(desc(terminationLogs.createdAt))
      .limit(pageSize)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(terminationLogs)
      .where(eq(terminationLogs.serverUserId, id));

    const total = countResult[0]?.count ?? 0;

    return {
      data: terminations,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });
};
