/**
 * User Range Stats Route
 *
 * GET /:id/stats - One person's plays, finishes, quality, devices and locations over a range,
 * with the prior window of equal length for comparison
 */

import type { FastifyPluginAsync } from 'fastify';
import { userIdParamSchema, userRangeStatsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import {
  queryIdentityRangeStats,
  resolveIdentityWindow,
} from '../../services/stats/peopleStats.js';
import { resolveIdentityScopedServerUserIds } from './queries/index.js';

export const statsRoutes: FastifyPluginAsync = async (app) => {
  const readUsers = { preHandler: [app.requirePermission('users', 'read')] };

  app.get('/:id/stats', readUsers, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = userRangeStatsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const authUser = request.user;
    const scoped = await resolveIdentityScopedServerUserIds(
      db,
      authUser,
      params.data.id,
      query.data.scope,
      request.scope
    );
    if ('error' in scoped) {
      if (scoped.error === 'notFound') {
        return reply.notFound('User not found');
      }
      return reply.forbidden();
    }

    return queryIdentityRangeStats({
      serverUserIds: scoped.ids,
      resolvedServerIds: resolveServerIds(authUser, query.data.serverId, query.data.serverIds),
      window: resolveIdentityWindow(query.data),
    });
  });
};
