/**
 * Tasks routes - Unified running tasks API
 *
 * Aggregates status from all background job queues into a single endpoint
 * for UI display (navbar dropdown showing running operations).
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  assertNever,
  SERVER_PROFILES,
  type RunningTask,
  type RunningTaskType,
} from '@tracearr/shared';
import {
  getAllActiveImports,
  getActiveImportProgress,
  type ImportJobData,
} from '../jobs/importQueue.js';
import { getAllActiveImagePrecacheJobs } from '../jobs/imagePrecacheQueue.js';
import { getAllActiveLibrarySyncs } from '../jobs/librarySyncQueue.js';
import { getMaintenanceProgress, getAllActiveMaintenanceJobs } from '../jobs/maintenanceQueue.js';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Get server name by ID (for context in task display)
 */
async function getServerName(serverId: string): Promise<string> {
  const [server] = await db
    .select({ name: servers.name })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return server?.name ?? 'Unknown Server';
}

function importTaskKind(type: ImportJobData['type']): { type: RunningTaskType; label: string } {
  switch (type) {
    case 'tautulli':
      return { type: 'tautulli_import', label: 'Tautulli' };
    case 'jellystat':
      return { type: 'jellystat_import', label: 'Jellystat' };
    case 'playback-reporting':
      return { type: 'playback_reporting_import', label: 'Playback Reporting' };
    case 'tofa':
      return { type: 'tofa_import', label: SERVER_PROFILES.tofa.displayName };
    default:
      return assertNever(type);
  }
}

function librarySyncMessage(isRunning: boolean, attemptsMade: number, serverName: string) {
  if (isRunning) return `Syncing ${serverName}...`;
  return attemptsMade > 0 ? 'Retrying after an error' : 'Waiting to start';
}

export const tasksRoutes: FastifyPluginAsync = async (app) => {
  const readTasks = { preHandler: [app.requirePermission('tasks', 'read')] };
  /**
   * GET /tasks/running - Get all currently running background tasks
   *
   * Returns unified list of running tasks from:
   * - Library sync queue
   * - Import queue (Tautulli, Jellystat)
   * - Maintenance queue
   */
  app.get('/running', readTasks, async () => {
    const tasks: RunningTask[] = [];

    const librarySyncs = await getAllActiveLibrarySyncs();
    for (const sync of librarySyncs) {
      const isRunning = sync.state === 'active';

      // Queued cron and change-event syncs stay hidden until they run; a first sync shows
      if (sync.triggeredBy === 'scheduled' && !sync.firstSync && !isRunning) {
        continue;
      }

      const serverName = await getServerName(sync.serverId);
      tasks.push({
        id: sync.jobId,
        type: 'library_sync',
        name: 'Library Sync',
        status: isRunning ? 'running' : 'pending',
        progress: sync.progress,
        message: librarySyncMessage(isRunning, sync.attemptsMade, serverName),
        startedAt: new Date(sync.createdAt).toISOString(),
        context: serverName,
      });
    }

    // Get import tasks
    const imports = await getAllActiveImports();
    const cachedImportProgress = getActiveImportProgress();

    for (const imp of imports) {
      const serverName = await getServerName(imp.serverId);
      const { type: taskType, label } = importTaskKind(imp.type);

      // Use cached progress if available for this job (has more detail than BullMQ progress)
      const isCachedJob = cachedImportProgress?.jobId === imp.jobId;

      // Extract progress percentage and status
      let progressPct: number | null = null;
      let message = 'Starting import...';
      let importStatus: RunningTask['status'] = imp.state === 'active' ? 'running' : 'pending';
      let waitingFor: RunningTask['waitingFor'] = undefined;

      if (imp.held && imp.state === 'delayed') {
        importStatus = 'waiting';
        message = 'Waiting for the first library sync';
      }

      const retrying = imp.state === 'delayed' && !imp.held && imp.attemptsMade > 0;
      if (retrying) message = 'Retrying after an error';

      if (isCachedJob && !retrying) {
        // Use cached progress which has waiting status
        importStatus = cachedImportProgress.status === 'waiting' ? 'waiting' : importStatus;
        if (cachedImportProgress.status === 'waiting' && cachedImportProgress.waitingFor) {
          waitingFor = {
            jobType: cachedImportProgress.waitingFor.jobType,
            description: cachedImportProgress.waitingFor.description,
            startedAt: cachedImportProgress.waitingFor.startedAt,
          };
          message = `Waiting for ${cachedImportProgress.waitingFor.description}...`;
        } else if (cachedImportProgress.status === 'fetching') {
          message = 'Fetching records...';
        } else if (cachedImportProgress.status === 'processing') {
          message = 'Processing records...';
        }
      }

      // Get progress percentage from BullMQ job progress
      // A retry backoff keeps the failed attempt's progress, which no longer applies
      const jobProgress = retrying ? null : imp.progress;
      if (typeof jobProgress === 'number' && jobProgress > 0) {
        progressPct = jobProgress;
        if (!isCachedJob || cachedImportProgress?.status !== 'waiting') {
          message = `Importing... ${jobProgress}%`;
        }
      } else if (jobProgress && typeof jobProgress === 'object') {
        const p = jobProgress as {
          processedRecords?: number;
          totalRecords?: number;
          message?: string;
        };
        if (p.totalRecords && p.totalRecords > 0 && p.processedRecords !== undefined) {
          progressPct = Math.round((p.processedRecords / p.totalRecords) * 100);
        }
        if (p.message && !isCachedJob) {
          message = p.message;
        }
      }

      tasks.push({
        id: imp.jobId,
        type: taskType,
        name: `${label} Import`,
        status: importStatus,
        progress: progressPct,
        message,
        startedAt: isCachedJob
          ? cachedImportProgress.startedAt
          : new Date(imp.createdAt).toISOString(),
        context: serverName,
        waitingFor,
      });
    }

    // Image precache passes - one chained job per server carries cumulative
    // pass progress in its data
    const precacheJobs = await getAllActiveImagePrecacheJobs();
    for (const precache of precacheJobs) {
      const serverName = await getServerName(precache.serverId);
      const progress =
        precache.totalItems && precache.totalItems > 0
          ? Math.min(100, Math.round((precache.processedItems / precache.totalItems) * 100))
          : null;
      tasks.push({
        id: precache.jobId,
        type: 'image_precache',
        name: 'Image Precache',
        status: precache.state === 'active' ? 'running' : 'pending',
        progress,
        message:
          precache.totalItems && precache.totalItems > 0
            ? `Caching posters ${precache.processedItems}/${precache.totalItems}${precache.diskLimited ? ' (disk-limited)' : ''}...`
            : 'Preparing poster cache...',
        startedAt: precache.passStartedAt ?? new Date(precache.createdAt).toISOString(),
        context: serverName,
      });
    }

    // Get maintenance tasks - query BullMQ directly, then merge with in-memory progress
    const maintenanceJobs = await getAllActiveMaintenanceJobs();
    const cachedMaintenanceProgress = getMaintenanceProgress();

    // Format maintenance job type for display
    const typeNames: Record<string, string> = {
      normalize_players: 'Normalize Players',
      normalize_countries: 'Normalize Countries',
      fix_imported_progress: 'Fix Import Progress',
      rebuild_timescale_views: 'Rebuild Analytics',
      normalize_codecs: 'Normalize Codecs',
      normalize_resolutions: 'Normalize Resolutions',
      backfill_user_dates: 'Backfill User Dates',
      backfill_library_snapshots: 'Generate Library History',
      sync_server_locations: 'Apply Server Locations',
    };

    for (const job of maintenanceJobs) {
      // Check if we have in-memory progress for this job (has waiting/running status)
      const hasCachedProgress = cachedMaintenanceProgress?.type === job.type;

      let taskStatus: RunningTask['status'] = job.state === 'active' ? 'running' : 'pending';
      let message = 'Starting...';
      let progressPct: number | null = null;
      let waitingFor: RunningTask['waitingFor'] = undefined;
      let startedAt = new Date(job.createdAt).toISOString();

      if (hasCachedProgress) {
        // Use cached progress which has detailed status
        if (cachedMaintenanceProgress.status === 'running') {
          taskStatus = 'running';
        } else if (cachedMaintenanceProgress.status === 'waiting') {
          taskStatus = 'waiting';
        }

        message = cachedMaintenanceProgress.message;
        waitingFor = cachedMaintenanceProgress.waitingFor;
        startedAt = cachedMaintenanceProgress.startedAt ?? startedAt;

        if (cachedMaintenanceProgress.totalRecords > 0) {
          progressPct = Math.round(
            (cachedMaintenanceProgress.processedRecords / cachedMaintenanceProgress.totalRecords) *
              100
          );
        }
      }

      tasks.push({
        id: job.jobId,
        type: 'maintenance',
        name: typeNames[job.type] ?? 'Maintenance',
        status: taskStatus,
        progress: progressPct,
        message,
        startedAt,
        context: job.type,
        waitingFor,
      });
    }

    return { tasks };
  });
};
