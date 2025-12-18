/**
 * Import routes - Data import from external sources
 */

import type { FastifyPluginAsync } from 'fastify';
import { tautulliImportSchema } from '@tracearr/shared';
import { TautulliService } from '../services/tautulli.js';
import { getPubSubService } from '../services/cache.js';
import { syncServer } from '../services/sync.js';
import {
  enqueueImport,
  getImportStatus,
  cancelImport,
  getImportQueueStats,
  getActiveImportForServer,
} from '../jobs/importQueue.js';

export const importRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /import/tautulli - Start Tautulli import (enqueues job)
   */
  app.post('/tautulli', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = tautulliImportSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body: serverId is required');
    }

    const authUser = request.user;

    // Only owners can import data
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can import data');
    }

    const { serverId } = body.data;

    // Sync server users first to ensure we have all users before importing history
    try {
      app.log.info({ serverId }, 'Syncing server before Tautulli import');
      await syncServer(serverId, { syncUsers: true, syncLibraries: false });
      app.log.info({ serverId }, 'Server sync completed, enqueueing import');
    } catch (error) {
      app.log.error({ error, serverId }, 'Failed to sync server before import');
      return reply.internalServerError('Failed to sync server users before import');
    }

    // Enqueue import job
    try {
      const jobId = await enqueueImport(serverId, authUser.userId);

      return {
        status: 'queued',
        jobId,
        message:
          'Import queued. Use jobId to track progress via WebSocket or GET /import/tautulli/:jobId',
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('already in progress')) {
        return reply.conflict(error.message);
      }

      // Fallback to direct execution if queue is not available
      app.log.warn({ error }, 'Import queue unavailable, falling back to direct execution');

      const pubSubService = getPubSubService();

      // Start import in background (non-blocking)
      TautulliService.importHistory(serverId, pubSubService ?? undefined)
        .then((result) => {
          console.log(`[Import] Tautulli import completed:`, result);
        })
        .catch((err: unknown) => {
          console.error(`[Import] Tautulli import failed:`, err);
        });

      return {
        status: 'started',
        message: 'Import started (direct execution). Watch for progress updates via WebSocket.',
      };
    }
  });

  /**
   * GET /import/tautulli/active/:serverId - Get active import for a server (if any)
   * Use this to recover import status after page refresh
   */
  app.get<{ Params: { serverId: string } }>(
    '/tautulli/active/:serverId',
    { preHandler: [app.authenticate] },
    async (request, _reply) => {
      const { serverId } = request.params;

      const jobId = await getActiveImportForServer(serverId);
      if (!jobId) {
        return { active: false };
      }

      const status = await getImportStatus(jobId);
      if (!status) {
        return { active: false };
      }

      return { active: true, ...status };
    }
  );

  /**
   * GET /import/tautulli/:jobId - Get import job status
   */
  app.get<{ Params: { jobId: string } }>(
    '/tautulli/:jobId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { jobId } = request.params;

      const status = await getImportStatus(jobId);
      if (!status) {
        return reply.notFound('Import job not found');
      }

      return status;
    }
  );

  /**
   * DELETE /import/tautulli/:jobId - Cancel import job
   */
  app.delete<{ Params: { jobId: string } }>(
    '/tautulli/:jobId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can cancel imports');
      }

      const { jobId } = request.params;
      const cancelled = await cancelImport(jobId);

      if (!cancelled) {
        return reply.badRequest('Cannot cancel job (may be active or not found)');
      }

      return { status: 'cancelled', jobId };
    }
  );

  /**
   * GET /import/stats - Get import queue statistics
   */
  app.get('/stats', { preHandler: [app.authenticate] }, async (_request, reply) => {
    const stats = await getImportQueueStats();

    if (!stats) {
      return reply.serviceUnavailable('Import queue not available');
    }

    return stats;
  });

  /**
   * POST /import/tautulli/test - Test Tautulli connection
   */
  app.post('/tautulli/test', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can test connection
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can test Tautulli connection');
    }

    const body = request.body as { url?: string; apiKey?: string } | undefined;

    if (!body?.url || !body?.apiKey) {
      return reply.badRequest('URL and API key are required');
    }

    try {
      const tautulli = new TautulliService(body.url, body.apiKey);
      const connected = await tautulli.testConnection();

      if (connected) {
        // Get user count to verify full access
        const users = await tautulli.getUsers();
        const { total } = await tautulli.getHistory(0, 1);

        return {
          success: true,
          message: 'Connection successful',
          users: users.length,
          historyRecords: total,
        };
      } else {
        return {
          success: false,
          message: 'Connection failed. Please check URL and API key.',
        };
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  });
};
