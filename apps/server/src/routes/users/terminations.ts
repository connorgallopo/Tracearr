/**
 * User Terminations Route
 *
 * GET /:id/terminations - Get termination history for a user
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, inArray } from 'drizzle-orm';
import { userIdParamSchema, identityScopedPaginationSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { terminationLogs } from '../../db/schema.js';
import { queryTerminationHistory, resolveIdentityScopedServerUserIds } from './queries/index.js';

export const terminationsRoutes: FastifyPluginAsync = async (app) => {
  const readUsers = { preHandler: [app.requirePermission('users', 'read')] };
  /**
   * GET /:id/terminations - Get termination history for a user
   *
   * Returns all stream terminations where this user's streams were killed,
   * including who triggered it (manual) or which rule (automated).
   * scope=identity expands the result to every account under the same
   * person that the caller can access.
   */
  app.get('/:id/terminations', readUsers, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = identityScopedPaginationSchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const { page, pageSize, scope } = query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    const scoped = await resolveIdentityScopedServerUserIds(db, authUser, id, scope, request.scope);
    if ('error' in scoped) {
      if (scoped.error === 'notFound') {
        return reply.notFound('User not found');
      }
      return reply.forbidden('You do not have access to this user');
    }

    const ids = scoped.ids;

    const terminations = await queryTerminationHistory(
      db,
      inArray(terminationLogs.serverUserId, ids),
      { limit: pageSize, offset }
    );

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(terminationLogs)
      .where(inArray(terminationLogs.serverUserId, ids));

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
