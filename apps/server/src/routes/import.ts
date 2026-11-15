/**
 * Import routes - Data import from external sources
 */

import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import { eq } from 'drizzle-orm';
import {
  SERVER_PROFILES,
  tautulliImportSchema,
  jellystatImportBodySchema,
  playbackReportingImportSchema,
  playbackReportingTestSchema,
  tofaImportSchema,
  type ImportWaitingForLibrarySync,
  type LatestImportStatus,
} from '@tracearr/shared';
import { TautulliService } from '../services/tautulli.js';
import { importJellystatBackup } from '../services/jellystat.js';
import {
  readJellystatUpload,
  removeJellystatUpload,
  saveJellystatUpload,
} from '../services/import/jellystatUpload.js';
import { importPlaybackReporting } from '../services/playbackReporting.js';
import { importTofaHistory } from '../services/import/tofaHistory.js';
import { getPubSubService } from '../services/cache.js';
import { HISTORICAL_IMPORT_MESSAGE } from '../services/liveServers.js';
import { createJellyfinEmbyClient, isJellyfinEmby } from '../services/mediaServer/index.js';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import {
  enqueueImport,
  enqueueJellystatImport,
  enqueuePlaybackReportingImport,
  enqueueTofaImport,
  getImportStatus,
  getJellystatImportStatus,
  cancelImport,
  cancelJellystatImport,
  getImportQueueStats,
  getActiveImportForServer,
  getActiveJellystatImportForServer,
  getActivePlaybackReportingImportForServer,
  getActiveTofaImportForServer,
  getLatestImport,
  publishImportFailed,
  type ImportJobData,
  type ImportJobResult,
  type ImportProgressPayload,
} from '../jobs/importQueue.js';
import { getLibrarySyncStatus } from '../jobs/librarySyncQueue.js';

/**
 * The library sync an import held for it waits on, or null when the import is not held: a
 * delayed import the owner started is waiting out a retry, not a library sync.
 */
async function heldForLibrarySync(
  serverId: string,
  job: { state: string; held: boolean }
): Promise<ImportWaitingForLibrarySync | null> {
  if (job.state !== 'delayed' || !job.held) return null;
  const sync = await getLibrarySyncStatus(serverId);
  return {
    state: 'waitingForLibrarySync',
    librarySync: sync?.jobId
      ? { state: sync.isActive ? 'running' : 'queued', progress: sync.progress ?? null }
      : null,
  };
}

/**
 * Where the server's latest import of this type stands: one held for its first library sync, or
 * one the owner started. Null when it has none still kept.
 */
async function readLatestImport(
  type: ImportJobData['type'],
  serverId: string
): Promise<LatestImportStatus<ImportProgressPayload, ImportJobResult> | null> {
  const latest = await getLatestImport(type, serverId);
  switch (latest?.state) {
    case 'delayed':
      // A delayed import that has failed an attempt is waiting out the backoff before its retry
      if (latest.attemptsMade > 0) {
        return {
          state: 'retrying',
          attempt: latest.attemptsMade,
          attempts: latest.attempts,
          reason: latest.failedReason,
        };
      }
      return (await heldForLibrarySync(serverId, latest)) ?? { state: 'queued' };
    case 'waiting':
    case 'prioritized':
      return { state: 'queued' };
    case 'active':
      return { state: 'running', progress: latest.progress };
    case 'completed':
      return latest.result
        ? { state: 'complete', result: latest.result, finishedAt: latest.finishedAt }
        : { state: 'failed', reason: latest.failedReason };
    case 'failed':
      return { state: 'failed', reason: latest.failedReason };
    default:
      return null;
  }
}

export const importRoutes: FastifyPluginAsync = async (app) => {
  const writeImport = { preHandler: [app.requirePermission('import', 'write')] };
  const readImport = { preHandler: [app.requirePermission('import', 'read')] };
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
  app.post('/tautulli', writeImport, async (request, reply) => {
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

    const [server] = await db
      .select({ historicalAt: servers.historicalAt })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!server) {
      return reply.notFound('Server not found');
    }
    if (server.historicalAt) {
      return reply.conflict(HISTORICAL_IMPORT_MESSAGE);
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
      app.log.warn({ err: error }, 'Import queue unavailable, falling back to direct execution');

      const pubSubService = getPubSubService();

      // Start import in background (non-blocking)
      TautulliService.importHistory(serverId, pubSubService ?? undefined, undefined, {
        overwriteFriendlyNames,
      })
        .then(async (result) => {
          console.log(`[Import] Tautulli import completed:`, result);

          // (BETA) Enrich with stream details
          if (includeStreamDetails) {
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
          publishImportFailed('tautulli', serverId, err);
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
    { preHandler: [app.requirePermission('import', 'read')] },
    async (request, _reply) => {
      const { serverId } = request.params;

      const [jobId, latest] = await Promise.all([
        getActiveImportForServer(serverId),
        readLatestImport('tautulli', serverId),
      ]);
      const status = jobId ? await getImportStatus(jobId) : null;
      if (!status) {
        return { active: false, latest };
      }

      return {
        active: true,
        ...status,
        waiting: await heldForLibrarySync(serverId, status),
        latest,
      };
    }
  );

  /**
   * GET /import/tautulli/:jobId - Get import job status
   */
  app.get<{ Params: { jobId: string } }>(
    '/tautulli/:jobId',
    { preHandler: [app.requirePermission('import', 'read')] },
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
    { preHandler: [app.requirePermission('import', 'write')] },
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
  app.get('/stats', readImport, async (_request, reply) => {
    const stats = await getImportQueueStats();

    if (!stats) {
      return reply.serviceUnavailable('Import queue not available');
    }

    return stats;
  });

  /**
   * POST /import/tautulli/test - Test Tautulli connection
   */
  app.post('/tautulli/test', writeImport, async (request, reply) => {
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
  app.post('/jellystat', writeImport, async (request, reply) => {
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
    if (!isJellyfinEmby(server.type)) {
      return reply.badRequest('Jellystat import only supports Jellyfin/Emby servers');
    }
    if (server.historicalAt) {
      return reply.conflict(HISTORICAL_IMPORT_MESSAGE);
    }

    const backupPath = await saveJellystatUpload(data.file);
    if (data.file.truncated) {
      await removeJellystatUpload(backupPath);
      return reply.payloadTooLarge('Backup file is larger than 500 MB');
    }

    // Enqueue import job
    try {
      const jobId = await enqueueJellystatImport(
        parsed.data.serverId,
        authUser.userId,
        backupPath,
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
        await removeJellystatUpload(backupPath);
        return reply.conflict(error.message);
      }

      // Fallback to direct execution if queue is not available
      app.log.warn({ err: error }, 'Import queue unavailable, falling back to direct execution');

      const pubSubService = getPubSubService();

      // Start import in background (non-blocking)
      readJellystatUpload(backupPath)
        .then((backupJson) =>
          importJellystatBackup(
            parsed.data.serverId,
            backupJson,
            enrichMedia,
            pubSubService ?? undefined,
            { updateStreamDetails: parsed.data.updateStreamDetails }
          )
        )
        .then((result) => {
          console.log(`[Import] Jellystat import completed:`, result);
        })
        .catch((err: unknown) => {
          console.error(`[Import] Jellystat import failed:`, err);
          publishImportFailed('jellystat', parsed.data.serverId, err);
        })
        .finally(() => {
          void removeJellystatUpload(backupPath);
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
    { preHandler: [app.requirePermission('import', 'read')] },
    async (request, _reply) => {
      const { serverId } = request.params;

      const [jobId, latest] = await Promise.all([
        getActiveJellystatImportForServer(serverId),
        readLatestImport('jellystat', serverId),
      ]);
      const status = jobId ? await getJellystatImportStatus(jobId) : null;
      if (!status) {
        return { active: false, latest };
      }

      return {
        active: true,
        ...status,
        waiting: await heldForLibrarySync(serverId, status),
        latest,
      };
    }
  );

  /**
   * GET /import/jellystat/:jobId - Get Jellystat import job status
   */
  app.get<{ Params: { jobId: string } }>(
    '/jellystat/:jobId',
    { preHandler: [app.requirePermission('import', 'read')] },
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
    { preHandler: [app.requirePermission('import', 'write')] },
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

  // ==========================================================================
  // Playback Reporting Import Routes (for Jellyfin/Emby servers)
  // ==========================================================================

  /**
   * POST /import/playback-reporting - Start Playback Reporting import (enqueues job)
   */
  app.post('/playback-reporting', writeImport, async (request, reply) => {
    const authUser = request.user;

    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can import data');
    }

    const parsed = playbackReportingImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest('Invalid request body');
    }

    const { serverId, timezone, enrichMedia, importFullRange } = parsed.data;

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!server) {
      return reply.notFound('Server not found');
    }
    if (!isJellyfinEmby(server.type)) {
      return reply.badRequest('Playback Reporting import only supports Jellyfin/Emby servers');
    }
    if (server.historicalAt) {
      return reply.conflict(HISTORICAL_IMPORT_MESSAGE);
    }

    try {
      const jobId = await enqueuePlaybackReportingImport(
        serverId,
        authUser.userId,
        timezone,
        enrichMedia,
        importFullRange
      );

      return {
        status: 'queued',
        jobId,
        message:
          'Import queued. Use jobId to track progress via WebSocket or GET /import/playback-reporting/:jobId',
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('already in progress')) {
        return reply.conflict(error.message);
      }

      // Fallback to direct execution if queue is not available
      app.log.warn({ err: error }, 'Import queue unavailable, falling back to direct execution');

      const pubSubService = getPubSubService();

      importPlaybackReporting(
        serverId,
        { timezone, enrichMedia, importFullRange },
        pubSubService ?? undefined
      )
        .then((result) => {
          console.log(`[Import] Playback Reporting import completed:`, result);
        })
        .catch((err: unknown) => {
          console.error(`[Import] Playback Reporting import failed:`, err);
          publishImportFailed('playback-reporting', serverId, err);
        });

      return {
        status: 'started',
        message: 'Import started (direct execution). Watch for progress updates via WebSocket.',
      };
    }
  });

  /**
   * POST /import/playback-reporting/test - Check Playback Reporting plugin availability
   */
  app.post(
    '/playback-reporting/test',
    { preHandler: [app.requirePermission('import', 'write')] },
    async (request, reply) => {
      const authUser = request.user;

      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can test the Playback Reporting connection');
      }

      const parsed = playbackReportingTestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.badRequest('Invalid request body: serverId is required');
      }

      const [server] = await db
        .select()
        .from(servers)
        .where(eq(servers.id, parsed.data.serverId))
        .limit(1);
      if (!server) {
        return reply.notFound('Server not found');
      }
      if (!isJellyfinEmby(server.type)) {
        return reply.badRequest('Playback Reporting import only supports Jellyfin/Emby servers');
      }
      if (server.historicalAt) {
        return reply.conflict(HISTORICAL_IMPORT_MESSAGE);
      }

      const clientConfig = {
        url: server.url,
        token: server.token,
        id: server.id,
        name: server.name,
      };
      const client = createJellyfinEmbyClient(server.type, clientConfig);

      try {
        const info = await client.getPlaybackReportingInfo();
        if (!info.installed) {
          return {
            success: true,
            installed: false,
            message: 'Playback Reporting plugin is not installed on this server',
          };
        }

        return {
          success: true,
          installed: true,
          message: 'Playback Reporting plugin detected',
          records: info.totalRecords,
          oldestDate: info.oldestDate,
          newestDate: info.newestDate,
        };
      } catch (error) {
        return {
          success: false,
          installed: false,
          message: error instanceof Error ? error.message : 'Connection failed',
        };
      }
    }
  );

  /**
   * GET /import/playback-reporting/active/:serverId - Get active Playback Reporting import for a server
   */
  app.get<{ Params: { serverId: string } }>(
    '/playback-reporting/active/:serverId',
    { preHandler: [app.requirePermission('import', 'read')] },
    async (request, _reply) => {
      const { serverId } = request.params;

      const [jobId, latest] = await Promise.all([
        getActivePlaybackReportingImportForServer(serverId),
        readLatestImport('playback-reporting', serverId),
      ]);
      const status = jobId ? await getImportStatus(jobId) : null;
      if (!status) {
        return { active: false, latest };
      }

      return {
        active: true,
        ...status,
        waiting: await heldForLibrarySync(serverId, status),
        latest,
      };
    }
  );

  /**
   * GET /import/playback-reporting/:jobId - Get Playback Reporting import job status
   */
  app.get<{ Params: { jobId: string } }>(
    '/playback-reporting/:jobId',
    { preHandler: [app.requirePermission('import', 'read')] },
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
   * DELETE /import/playback-reporting/:jobId - Cancel Playback Reporting import job
   */
  app.delete<{ Params: { jobId: string } }>(
    '/playback-reporting/:jobId',
    { preHandler: [app.requirePermission('import', 'write')] },
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

  // ==========================================================================
  // tofa Import Routes (the server's own watch history)
  // ==========================================================================

  /**
   * POST /import/tofa - Start a tofa watch history import (enqueues job)
   */
  app.post('/tofa', writeImport, async (request, reply) => {
    const authUser = request.user;

    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can import data');
    }

    const parsed = tofaImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest('Invalid request body');
    }

    const { serverId } = parsed.data;

    const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!server) {
      return reply.notFound('Server not found');
    }
    if (SERVER_PROFILES[server.type].serverHistoryImport !== 'tofa') {
      return reply.badRequest('Watch history import only supports tofa servers');
    }
    if (server.historicalAt) {
      return reply.conflict(HISTORICAL_IMPORT_MESSAGE);
    }

    try {
      const jobId = await enqueueTofaImport(serverId, authUser.userId);
      return {
        status: 'queued',
        jobId,
        message:
          'Import queued. Use jobId to track progress via WebSocket or GET /import/tofa/:jobId',
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('already in progress')) {
        return reply.conflict(error.message);
      }

      app.log.warn({ err: error }, 'Import queue unavailable, falling back to direct execution');
      importTofaHistory(serverId, getPubSubService() ?? undefined)
        .then((result) => {
          console.log(`[Import] tofa history import completed:`, result);
        })
        .catch((err: unknown) => {
          console.error(`[Import] tofa history import failed:`, err);
          publishImportFailed('tofa', serverId, err);
        });

      return {
        status: 'started',
        message: 'Import started (direct execution). Watch for progress updates via WebSocket.',
      };
    }
  });

  /**
   * GET /import/tofa/active/:serverId - Get the active tofa history import for a server
   */
  app.get<{ Params: { serverId: string } }>(
    '/tofa/active/:serverId',
    readImport,
    async (request) => {
      const { serverId } = request.params;
      const [jobId, latest] = await Promise.all([
        getActiveTofaImportForServer(serverId),
        readLatestImport('tofa', serverId),
      ]);
      const status = jobId ? await getImportStatus(jobId) : null;
      return status ? { active: true, ...status, latest } : { active: false, latest };
    }
  );

  /**
   * GET /import/tofa/:jobId - Get tofa history import job status
   */
  app.get<{ Params: { jobId: string } }>('/tofa/:jobId', readImport, async (request, reply) => {
    const status = await getImportStatus(request.params.jobId);
    if (!status) {
      return reply.notFound('Import job not found');
    }
    return status;
  });

  /**
   * DELETE /import/tofa/:jobId - Cancel tofa history import job
   */
  app.delete<{ Params: { jobId: string } }>('/tofa/:jobId', writeImport, async (request, reply) => {
    if (request.user.role !== 'owner') {
      return reply.forbidden('Only server owners can cancel imports');
    }

    const { jobId } = request.params;
    if (!(await cancelImport(jobId))) {
      return reply.badRequest('Cannot cancel job (may be active or not found)');
    }
    return { status: 'cancelled', jobId };
  });
};
