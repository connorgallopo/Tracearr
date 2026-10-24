/**
 * User Downloads Route
 *
 * GET /:id/downloads - Get a page of the user's media downloads
 */

import type { FastifyPluginAsync } from 'fastify';
import { userIdParamSchema, identityScopedPaginationSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { queryUserDownloads, resolveIdentityScopedServerUserIds } from './queries/index.js';

export const downloadsRoutes: FastifyPluginAsync = async (app) => {
  const readUsers = { preHandler: [app.requirePermission('users', 'read')] };

  /**
   * scope=identity expands the result to every account under the same
   * person that the caller can access.
   */
  app.get('/:id/downloads', readUsers, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = identityScopedPaginationSchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page, pageSize, scope } = query.data;
    const scoped = await resolveIdentityScopedServerUserIds(
      db,
      request.user,
      params.data.id,
      scope,
      request.scope
    );
    if ('error' in scoped) {
      if (scoped.error === 'notFound') {
        return reply.notFound('User not found');
      }
      return reply.forbidden('You do not have access to this user');
    }

    return queryUserDownloads(db, scoped.ids, page, pageSize);
  });
};
