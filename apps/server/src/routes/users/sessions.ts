/**
 * User Sessions Route
 *
 * GET /:id/sessions - Get user's session history (grouped by play)
 */

import type { FastifyPluginAsync } from 'fastify';
import { userIdParamSchema, userSessionsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import {
  resolveIdentityScopedServerUserIds,
  userHistoryWindow,
  userPlayTotals,
  userRecentPlays,
} from './queries/index.js';

export const sessionsRoutes: FastifyPluginAsync = async (app) => {
  const readSessions = { preHandler: [app.requirePermission('sessions', 'read')] };
  /**
   * GET /:id/sessions - Get user's session history (grouped by play)
   *
   * scope=identity expands the result to every account under the same
   * person that the caller can access. profileIds keeps only those profiles' plays.
   */
  app.get('/:id/sessions', readSessions, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = userSessionsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const { page, pageSize, scope, profileIds } = query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    const scoped = await resolveIdentityScopedServerUserIds(db, authUser, id, scope, request.scope);
    if ('error' in scoped) {
      if (scoped.error === 'notFound') {
        return reply.notFound('User not found');
      }
      return reply.forbidden('You do not have access to this user');
    }

    const window = userHistoryWindow();
    const { totalSessions: total } = await userPlayTotals(db, scoped.ids, window, profileIds);
    const sessionData = await userRecentPlays(
      db,
      scoped.ids,
      window,
      { limit: pageSize, offset },
      profileIds
    );

    return {
      data: sessionData,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });
};
