/**
 * Maintenance routes - Administrative maintenance jobs
 */

import type { FastifyPluginAsync } from 'fastify';
import type { MaintenanceJobType } from '@tracearr/shared';
import {
  enqueueMaintenanceJob,
  getMaintenanceProgress,
  getMaintenanceJobStatus,
  getMaintenanceQueueStats,
  getMaintenanceJobHistory,
} from '../jobs/maintenanceQueue.js';

export const maintenanceRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /maintenance/jobs - List available maintenance jobs
   */
  app.get('/jobs', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access maintenance jobs');
    }

    // Return list of available maintenance jobs with descriptions
    return {
      jobs: [
        {
          type: 'normalize_players',
          name: 'Normalize Player Names',
          description:
            'Run this if you see inconsistent device names like "AndroidTv" and "Android TV", ' +
            'or raw client strings like "Jellyfin Android" instead of clean platform names.',
        },
        {
          type: 'normalize_countries',
          name: 'Normalize Country Codes',
          description:
            'Run this if you see both "US" and "United States" in your history, ' +
            "or if geo restriction rules aren't matching older sessions correctly.",
        },
        {
          type: 'fix_imported_progress',
          name: 'Fix Imported Session Progress',
          description:
            'Run this if imported sessions from Tautulli show "0%" progress despite having watch time. ' +
            'This recalculates progress values for sessions that were imported before this was fixed.',
        },
        {
          type: 'rebuild_timescale_views',
          name: 'Rebuild TimescaleDB Views',
          description:
            'Recreates all TimescaleDB continuous aggregates and engagement views. ' +
            'Run this after upgrading if you see database errors about missing views or columns.',
        },
        {
          type: 'normalize_codecs',
          name: 'Normalize Codec Names',
          description:
            'Converts all codec names to uppercase for consistency. ' +
            'Run this if you see duplicate codecs in the Compatibility Matrix (e.g., "h264" and "H264").',
        },
      ],
    };
  });

  /**
   * POST /maintenance/jobs/:type - Start a maintenance job
   */
  app.post<{ Params: { type: string } }>(
    '/jobs/:type',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can run maintenance jobs');
      }

      const { type } = request.params;

      // Validate job type
      const validTypes: MaintenanceJobType[] = [
        'normalize_players',
        'normalize_countries',
        'fix_imported_progress',
        'rebuild_timescale_views',
        'normalize_codecs',
      ];
      if (!validTypes.includes(type as MaintenanceJobType)) {
        return reply.badRequest(`Invalid job type: ${type}`);
      }

      try {
        const jobId = await enqueueMaintenanceJob(type as MaintenanceJobType, authUser.userId);
        return {
          status: 'queued',
          jobId,
          message: 'Maintenance job queued. Watch for progress updates via WebSocket.',
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes('already in progress')) {
          return reply.conflict(error.message);
        }
        throw error;
      }
    }
  );

  /**
   * GET /maintenance/progress - Get current job progress (if any)
   */
  app.get('/progress', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access maintenance jobs');
    }

    const progress = getMaintenanceProgress();
    return { progress };
  });

  /**
   * GET /maintenance/jobs/:jobId/status - Get specific job status
   */
  app.get<{ Params: { jobId: string } }>(
    '/jobs/:jobId/status',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can access maintenance jobs');
      }

      const { jobId } = request.params;

      // Validate jobId format (alphanumeric with dashes)
      if (!jobId || !/^[\w-]+$/.test(jobId) || jobId.length > 100) {
        return reply.badRequest('Invalid job ID format');
      }

      const status = await getMaintenanceJobStatus(jobId);

      if (!status) {
        return reply.notFound('Job not found');
      }

      return status;
    }
  );

  /**
   * GET /maintenance/stats - Get queue statistics
   */
  app.get('/stats', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access maintenance jobs');
    }

    const stats = await getMaintenanceQueueStats();

    if (!stats) {
      return reply.serviceUnavailable('Maintenance queue not available');
    }

    return stats;
  });

  /**
   * GET /maintenance/history - Get recent job history
   */
  app.get('/history', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access maintenance jobs');
    }

    const history = await getMaintenanceJobHistory(10);
    return { history };
  });
};
