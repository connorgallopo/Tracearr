/**
 * Library routes - Library sync trigger, status, and analytics endpoints
 *
 * Sync endpoints:
 * - POST /sync/:serverId - Trigger manual library sync
 * - GET /sync/:serverId/status - Get sync status
 *
 * Analytics endpoints (via libraryStatsRoutes):
 * - GET /stats - Current library statistics
 * - GET /growth - Library growth over time
 * - GET /quality - Quality evolution tracking
 * - GET /storage - Storage analytics with predictions
 * - GET /duplicates - Cross-server duplicate detection
 * - GET /stale - Unwatched/stale content detection
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { enqueueLibrarySync, getLibrarySyncStatus } from '../jobs/librarySyncQueue.js';
import { libraryStatsRoutes } from './library/index.js';

// Validation schemas
const serverIdParamSchema = z.object({
  serverId: z.uuid(),
});

export const libraryRoutes: FastifyPluginAsync = async (app) => {
  // Register analytics sub-routes (stats, growth, quality, storage, duplicates, stale)
  await app.register(libraryStatsRoutes);
  /**
   * POST /library/sync/:serverId - Trigger manual library sync
   */
  app.post<{ Params: { serverId: string } }>(
    '/sync/:serverId',
    { preHandler: [app.requirePermission('servers', 'write')] },
    async (request, reply) => {
      const authUser = request.user;

      // Validate serverId is UUID
      const parseResult = serverIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.badRequest('Invalid server ID format');
      }

      const { serverId } = parseResult.data;

      const [server] = await db
        .select({ historicalAt: servers.historicalAt })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);
      if (server?.historicalAt) {
        return reply.conflict('Resume this server to sync it');
      }

      try {
        const jobId = await enqueueLibrarySync(serverId, 'manual', authUser.userId);
        return {
          jobId,
          message: 'Sync job queued',
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes('already in progress')) {
          return reply.conflict(error.message);
        }
        if (error instanceof Error && error.message.includes('Library sync is disabled')) {
          return reply.badRequest(error.message);
        }
        throw error;
      }
    }
  );

  /**
   * GET /library/sync/:serverId/status - Get sync status for a server
   */
  app.get<{ Params: { serverId: string } }>(
    '/sync/:serverId/status',
    { preHandler: [app.requirePermission('servers', 'read')] },
    async (request, reply) => {
      // Validate serverId is UUID
      const parseResult = serverIdParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        return reply.badRequest('Invalid server ID format');
      }

      const { serverId } = parseResult.data;

      const status = await getLibrarySyncStatus(serverId);

      if (status === null) {
        return reply.serviceUnavailable('Library sync queue not available');
      }

      return status;
    }
  );
};
