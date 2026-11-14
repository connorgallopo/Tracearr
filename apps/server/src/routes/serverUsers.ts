/**
 * Server User Routes
 *
 * POST /:id/split - Detach a server_user into a fresh users identity
 * (undo path for a non-destructive merge). Owner only.
 */

import type { FastifyPluginAsync } from 'fastify';
import { APIError } from 'better-auth/api';
import { splitServerUserParamSchema } from '@tracearr/shared';
import { splitServerUser, MergeValidationError } from '../services/mergeService.js';
import { ServerUserNotFoundError } from '../services/userService.js';

export const serverUserRoutes: FastifyPluginAsync = async (app) => {
  app.post('/:id/split', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const params = splitServerUserParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid server user ID');
    }

    try {
      return await splitServerUser(params.data.id, request.user.userId);
    } catch (error) {
      if (error instanceof ServerUserNotFoundError) {
        return reply.notFound(error.message);
      }
      if (
        error instanceof MergeValidationError ||
        (error instanceof APIError && error.status === 'BAD_REQUEST')
      ) {
        return reply.badRequest(error.message);
      }
      throw error;
    }
  });
};
