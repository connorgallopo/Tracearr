/**
 * What's-new routes (owner only)
 */

import type { FastifyPluginAsync } from 'fastify';
import { dismissWhatsNew, getWhatsNewState } from '../services/whatsNew.js';

export const whatsNewRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'owner') {
      return reply.forbidden('Only the owner sees release notes');
    }
    return getWhatsNewState();
  });

  app.post('/dismiss', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'owner') {
      return reply.forbidden('Only the owner sees release notes');
    }
    await dismissWhatsNew();
    return reply.code(204).send();
  });
};
