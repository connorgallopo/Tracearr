/**
 * User Requests Route
 *
 * GET /:id/requests - the identity's Seerr request history, paged.
 */

import { userIdParamSchema, userRequestsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { listUserRequests } from '../../services/requests/reads.js';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { resolveIdentityScopedServerUserIds } from './queries.js';
import type { FastifyPluginAsync } from 'fastify';

export const requestsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * scope=identity widens the history to every account under the same person
   * the caller can access, the same rule the devices and locations routes use.
   */
  app.get('/:id/requests', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = userRequestsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const scoped = await resolveIdentityScopedServerUserIds(
      db,
      request.user,
      params.data.id,
      query.data.scope
    );
    if ('error' in scoped) {
      if (scoped.error === 'notFound') {
        return reply.notFound('User not found');
      }
      return reply.forbidden('You do not have access to this user');
    }

    return listUserRequests({
      serverUserIds: scoped.ids,
      serverIds: resolveServerIds(request.user, undefined, undefined),
      page: query.data.page,
      pageSize: query.data.pageSize,
    });
  });
};
