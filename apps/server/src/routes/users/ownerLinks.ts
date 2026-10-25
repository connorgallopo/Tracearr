/**
 * Owner Account Link Routes
 *
 * GET    /owner-links               - The owner's account on each Jellyfin and Emby server, or the accounts that could be linked
 * POST   /owner-links               - Fold body.serverUserId into the owner
 * DELETE /owner-links/:serverUserId - Split the owner's account back out to a person of its own
 */

import type { FastifyPluginAsync } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { ownerLinkBodySchema, ownerLinkParamSchema } from '@tracearr/shared';
import { resolveBetterAuthSession } from '../../lib/sessionResolver.js';
import { MergeValidationError } from '../../services/mergeService.js';
import {
  getOwnerLinks,
  linkOwnerAccount,
  unlinkOwnerAccount,
} from '../../services/ownerAccountLink.js';
import { ServerUserNotFoundError } from '../../services/userService.js';

export const ownerLinkRoutes: FastifyPluginAsync = async (app) => {
  app.get('/owner-links', { preHandler: [app.requireOwner] }, async (request) => {
    const data = await getOwnerLinks(request.user.userId);
    return { data };
  });

  app.post('/owner-links', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const body = ownerLinkBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    try {
      return await linkOwnerAccount(request.user.userId, body.data.serverUserId);
    } catch (error) {
      if (error instanceof ServerUserNotFoundError) {
        return reply.notFound(error.message);
      }
      if (error instanceof MergeValidationError) {
        return reply.badRequest(error.message);
      }
      throw error;
    }
  });

  app.delete(
    '/owner-links/:serverUserId',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const params = ownerLinkParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid server user ID');
      }

      const current = await resolveBetterAuthSession(fromNodeHeaders(request.headers));
      try {
        return await unlinkOwnerAccount(
          request.user.userId,
          params.data.serverUserId,
          current?.sessionId
        );
      } catch (error) {
        if (error instanceof ServerUserNotFoundError) {
          return reply.notFound(error.message);
        }
        if (error instanceof MergeValidationError) {
          return reply.badRequest(error.message);
        }
        throw error;
      }
    }
  );
};
