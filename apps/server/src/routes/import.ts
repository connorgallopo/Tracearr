/**
 * Import routes - Data import from external sources
 */

import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import { tautulliImportSchema, jellystatImportBodySchema } from '@tracearr/shared';
import { TautulliService } from '../services/tautulli.js';
import { importJellystatBackup } from '../services/jellystat.js';
import { getPubSubService } from '../services/cache.js';
import { syncServer } from '../services/sync.js';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import {
  enqueueImport,
  enqueueJellystatImport,
  getImportStatus,
  getJellystatImportStatus,
  cancelImport,
  cancelJellystatImport,
  getImportQueueStats,
  getActiveImportForServer,
  getActiveJellystatImportForServer,
} from '../jobs/importQueue.js';

export const importRoutes: FastifyPluginAsync = async (app) => {
  // Register multipart plugin for file uploads (Jellystat backup)
  await app.register(multipart, {
    limits: {
      fileSize: 500 * 1024 * 1024, // 500MB max file size
    },
  });

  // ==========================================================================
  // Tautulli Import Routes (for Plex servers)
  // ==========================================================================

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

    const { serverId, overwriteFriendlyNames = false, includeStreamDetails = false } = body.data;

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
      const jobId = await enqueueImport(
        serverId,
        authUser.userId,
        overwriteFriendlyNames,
        includeStreamDetails
      );

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
      TautulliService.importHistory(serverId, pubSubService ?? undefined, undefined, {
        overwriteFriendlyNames,
        skipRefresh: includeStreamDetails, // Skip refresh if enrichment will follow
      })
        .then(async (result) => {
          console.log(`[Import] Tautulli import completed:`, result);

          // (BETA) Enrich with stream details
          if (includeStreamDetails && result.success) {
            console.log(`[Import] Starting stream details enrichment for server ${serverId}`);
            try {
              const enrichResult = await TautulliService.enrichStreamDetails(
                serverId,
                pubSubService ?? undefined
              );
              console.log(
                `[Import] Stream enrichment complete: ${enrichResult.enriched} enriched, ${enrichResult.failed} failed`
              );
            } catch (enrichError) {
              console.error(`[Import] Stream enrichment failed:`, enrichError);
            }
          }
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

  // ==========================================================================
  // Jellystat Import Routes (for Jellyfin/Emby servers)
  // ==========================================================================

  /**
   * POST /import/jellystat - Start Jellystat import from backup file
   *
   * Accepts multipart form data with:
   * - file: Jellystat backup JSON file
   * - serverId: Target server UUID
   * - enrichMedia: Whether to enrich with metadata (default: true)
   */
  app.post('/jellystat', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can import data
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can import data');
    }

    // Parse multipart form data
    const data = await request.file();
    if (!data) {
      return reply.badRequest('No file uploaded');
    }

    // Get form fields - handle @fastify/multipart field structure
    // Fields can be single values or arrays, and have a 'value' property
    const getFieldValue = (field: unknown): string | undefined => {
      if (!field) return undefined;
      // If it's an array, get the first element
      const f = Array.isArray(field) ? field[0] : field;
      // Check if it's a field (not a file) with a value property
      if (f && typeof f === 'object' && 'value' in f) {
        return String(f.value);
      }
      return undefined;
    };

    const serverId = getFieldValue(data.fields.serverId);
    const enrichMediaStr = getFieldValue(data.fields.enrichMedia) ?? 'true';
    const enrichMedia = enrichMediaStr === 'true';
    const updateStreamDetailsStr = getFieldValue(data.fields.updateStreamDetails) ?? 'false';
    const updateStreamDetails = updateStreamDetailsStr === 'true';

    // Validate server ID
    const parsed = jellystatImportBodySchema.safeParse({
      serverId,
      enrichMedia,
      updateStreamDetails,
    });
    if (!parsed.success) {
      return reply.badRequest('Invalid request: serverId is required');
    }

    // Verify server exists and is Jellyfin/Emby
    const [server] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, parsed.data.serverId))
      .limit(1);
    if (!server) {
      return reply.notFound('Server not found');
    }
    if (server.type !== 'jellyfin' && server.type !== 'emby') {
      return reply.badRequest('Jellystat import only supports Jellyfin/Emby servers');
    }

    // Read file contents
    const chunks: Buffer[] = [];
    for await (const chunk of data.file) {
      chunks.push(chunk);
    }
    const backupJson = Buffer.concat(chunks).toString('utf-8');

    // Sync server users first
    try {
      app.log.info({ serverId }, 'Syncing server before Jellystat import');
      await syncServer(parsed.data.serverId, { syncUsers: true, syncLibraries: false });
      app.log.info({ serverId }, 'Server sync completed');
    } catch (error) {
      app.log.error({ error, serverId }, 'Failed to sync server before import');
      return reply.internalServerError('Failed to sync server users before import');
    }

    // Enqueue import job
    try {
      const jobId = await enqueueJellystatImport(
        parsed.data.serverId,
        authUser.userId,
        backupJson,
        parsed.data.enrichMedia,
        parsed.data.updateStreamDetails
      );

      return {
        status: 'queued',
        jobId,
        message:
          'Import queued. Use jobId to track progress via WebSocket or GET /import/jellystat/:jobId',
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('already in progress')) {
        return reply.conflict(error.message);
      }

      // Fallback to direct execution if queue is not available
      app.log.warn({ error }, 'Import queue unavailable, falling back to direct execution');

      const pubSubService = getPubSubService();

      // Start import in background (non-blocking)
      importJellystatBackup(
        parsed.data.serverId,
        backupJson,
        enrichMedia,
        pubSubService ?? undefined,
        { updateStreamDetails: parsed.data.updateStreamDetails }
      )
        .then((result) => {
          console.log(`[Import] Jellystat import completed:`, result);
        })
        .catch((err: unknown) => {
          console.error(`[Import] Jellystat import failed:`, err);
        });

      return {
        status: 'started',
        message: 'Import started (direct execution). Watch for progress updates via WebSocket.',
      };
    }
  });

  /**
   * GET /import/jellystat/active/:serverId - Get active Jellystat import for a server
   */
  app.get<{ Params: { serverId: string } }>(
    '/jellystat/active/:serverId',
    { preHandler: [app.authenticate] },
    async (request, _reply) => {
      const { serverId } = request.params;

      const jobId = await getActiveJellystatImportForServer(serverId);
      if (!jobId) {
        return { active: false };
      }

      const status = await getJellystatImportStatus(jobId);
      if (!status) {
        return { active: false };
      }

      return { active: true, ...status };
    }
  );

  /**
   * GET /import/jellystat/:jobId - Get Jellystat import job status
   */
  app.get<{ Params: { jobId: string } }>(
    '/jellystat/:jobId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { jobId } = request.params;

      const status = await getJellystatImportStatus(jobId);
      if (!status) {
        return reply.notFound('Import job not found');
      }

      return status;
    }
  );

  /**
   * DELETE /import/jellystat/:jobId - Cancel Jellystat import job
   */
  app.delete<{ Params: { jobId: string } }>(
    '/jellystat/:jobId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can cancel imports');
      }

      const { jobId } = request.params;
      const cancelled = await cancelJellystatImport(jobId);

      if (!cancelled) {
        return reply.badRequest('Cannot cancel job (may be active or not found)');
      }

      return { status: 'cancelled', jobId };
    }
  );
};
