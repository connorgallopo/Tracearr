/**
 * Maintenance routes tests
 *
 * Tests the API endpoints for maintenance job management:
 * - GET /maintenance/jobs - List available maintenance jobs
 * - POST /maintenance/jobs/:type - Start a maintenance job
 * - GET /maintenance/progress - Get current job progress
 * - GET /maintenance/jobs/:jobId/status - Get specific job status
 * - GET /maintenance/stats - Get queue statistics
 * - GET /maintenance/history - Get recent job history
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock the maintenance queue module before importing routes
vi.mock('../../jobs/maintenanceQueue.js', () => ({
  enqueueMaintenanceJob: vi.fn(),
  getMaintenanceProgress: vi.fn(),
  getMaintenanceJobStatus: vi.fn(),
  getMaintenanceQueueStats: vi.fn(),
  getMaintenanceJobHistory: vi.fn(),
}));

// Import mocked modules
import {
  enqueueMaintenanceJob,
  getMaintenanceProgress,
  getMaintenanceJobStatus,
  getMaintenanceQueueStats,
  getMaintenanceJobHistory,
} from '../../jobs/maintenanceQueue.js';
import { maintenanceRoutes } from '../maintenance.js';

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });

  await app.register(maintenanceRoutes, { prefix: '/maintenance' });
  return app;
}

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'admin',
  role: 'owner',
  serverIds: [],
};

const viewerUser: AuthUser = {
  userId: randomUUID(),
  username: 'viewer',
  role: 'viewer',
  serverIds: [],
};

describe('Maintenance Routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe('GET /maintenance/jobs', () => {
    it('returns list of available maintenance jobs for owner', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.jobs).toBeDefined();
      expect(Array.isArray(body.jobs)).toBe(true);
      expect(body.jobs.length).toBeGreaterThan(0);

      // Verify structure of job entries
      const job = body.jobs[0];
      expect(job.type).toBeDefined();
      expect(job.name).toBeDefined();
      expect(job.description).toBeDefined();
    });

    it('includes normalize_players job', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs',
      });

      const body = response.json();
      const normalizeJob = body.jobs.find((j: { type: string }) => j.type === 'normalize_players');
      expect(normalizeJob).toBeDefined();
      expect(normalizeJob.name).toBe('Normalize Player Names');
    });

    it('includes normalize_countries job', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs',
      });

      const body = response.json();
      const normalizeJob = body.jobs.find(
        (j: { type: string }) => j.type === 'normalize_countries'
      );
      expect(normalizeJob).toBeDefined();
      expect(normalizeJob.name).toBe('Normalize Country Codes');
    });

    it('includes fix_imported_progress job', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs',
      });

      const body = response.json();
      const fixJob = body.jobs.find((j: { type: string }) => j.type === 'fix_imported_progress');
      expect(fixJob).toBeDefined();
      expect(fixJob.name).toBe('Fix Imported Session Progress');
      expect(fixJob.description).toMatch(/^Run this if .*before Tracearr 1\.3\.9/);
    });

    it('includes rebuild_timescale_views job', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs',
      });

      const body = response.json();
      const rebuildJob = body.jobs.find(
        (j: { type: string }) => j.type === 'rebuild_timescale_views'
      );
      expect(rebuildJob).toBeDefined();
      expect(rebuildJob.name).toBe('Rebuild TimescaleDB Views');
    });

    it('rejects non-owner accessing jobs list', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });

    it('marks remove_import_duplicates, cleanup_old_chunks and repair_corrupted_chunks as destructive', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs',
      });

      const body = response.json();
      for (const type of [
        'remove_import_duplicates',
        'cleanup_old_chunks',
        'repair_corrupted_chunks',
      ]) {
        const job = body.jobs.find((j: { type: string }) => j.type === type);
        expect(job.destructive, type).toBe(true);
      }
    });

    it('leaves destructive unset on jobs that do not delete data', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs',
      });

      const body = response.json();
      const normalizeJob = body.jobs.find((j: { type: string }) => j.type === 'normalize_players');
      expect(normalizeJob.destructive).toBeUndefined();
    });
  });

  describe('POST /maintenance/jobs/:type', () => {
    it('starts normalize_players job for owner', async () => {
      app = await buildTestApp(ownerUser);

      const jobId = 'job-123';
      vi.mocked(enqueueMaintenanceJob).mockResolvedValue(jobId);

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/normalize_players',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('queued');
      expect(body.jobId).toBe(jobId);
      expect(body.message).toContain('queued');
      expect(enqueueMaintenanceJob).toHaveBeenCalledWith('normalize_players', ownerUser.userId);
    });

    it('starts normalize_countries job for owner', async () => {
      app = await buildTestApp(ownerUser);

      const jobId = 'job-456';
      vi.mocked(enqueueMaintenanceJob).mockResolvedValue(jobId);

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/normalize_countries',
      });

      expect(response.statusCode).toBe(200);
      expect(enqueueMaintenanceJob).toHaveBeenCalledWith('normalize_countries', ownerUser.userId);
    });

    it('starts fix_imported_progress job for owner', async () => {
      app = await buildTestApp(ownerUser);

      const jobId = 'job-789';
      vi.mocked(enqueueMaintenanceJob).mockResolvedValue(jobId);

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/fix_imported_progress',
      });

      expect(response.statusCode).toBe(200);
      expect(enqueueMaintenanceJob).toHaveBeenCalledWith('fix_imported_progress', ownerUser.userId);
    });

    it('starts rebuild_timescale_views job for owner', async () => {
      app = await buildTestApp(ownerUser);

      const jobId = 'job-abc';
      vi.mocked(enqueueMaintenanceJob).mockResolvedValue(jobId);

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/rebuild_timescale_views',
      });

      expect(response.statusCode).toBe(200);
      expect(enqueueMaintenanceJob).toHaveBeenCalledWith(
        'rebuild_timescale_views',
        ownerUser.userId
      );
    });

    it('queues full_aggregate_rebuild job for safe historical refresh', async () => {
      app = await buildTestApp(ownerUser);

      const jobId = 'job-full-aggregate-rebuild';
      vi.mocked(enqueueMaintenanceJob).mockResolvedValue(jobId);

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/full_aggregate_rebuild',
      });

      expect(response.statusCode).toBe(200);
      expect(enqueueMaintenanceJob).toHaveBeenCalledWith(
        'full_aggregate_rebuild',
        ownerUser.userId
      );
    });

    it('rejects invalid job type', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/invalid_job_type',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Invalid job type');
    });

    it('rejects job type with special characters', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/normalize_players;DROP%20TABLE',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Invalid job type');
    });

    it('rejects non-owner starting jobs', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/normalize_players',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });

    it('returns conflict when job already in progress', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(enqueueMaintenanceJob).mockRejectedValue(
        new Error('Another maintenance job is already in progress')
      );

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/normalize_players',
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain('already in progress');
    });

    it('handles general errors during job enqueue', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(enqueueMaintenanceJob).mockRejectedValue(new Error('Redis connection failed'));

      const response = await app.inject({
        method: 'POST',
        url: '/maintenance/jobs/normalize_players',
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('GET /maintenance/progress', () => {
    it('returns current job progress for owner', async () => {
      app = await buildTestApp(ownerUser);

      const mockProgress = {
        type: 'normalize_players' as const,
        status: 'running' as const,
        totalRecords: 1000,
        processedRecords: 500,
        updatedRecords: 400,
        skippedRecords: 50,
        errorRecords: 50,
        message: 'Normalizing players...',
      };
      vi.mocked(getMaintenanceProgress).mockReturnValue(mockProgress);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/progress',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.progress).toEqual(mockProgress);
    });

    it('returns null progress when no job running', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(getMaintenanceProgress).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/progress',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.progress).toBeNull();
    });

    it('rejects non-owner accessing progress', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/progress',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });
  });

  describe('GET /maintenance/jobs/:jobId/status', () => {
    it('returns job status for valid jobId', async () => {
      app = await buildTestApp(ownerUser);

      const mockStatus = {
        jobId: 'job-123',
        state: 'completed' as const,
        progress: 100,
        result: {
          success: true,
          type: 'normalize_players' as const,
          processed: 1000,
          updated: 500,
          skipped: 400,
          errors: 100,
          durationMs: 5000,
          message: 'Completed',
        },
      };
      vi.mocked(getMaintenanceJobStatus).mockResolvedValue(mockStatus);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs/job-123/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.jobId).toBe('job-123');
      expect(body.state).toBe('completed');
    });

    it('accepts jobId with alphanumeric and dashes', async () => {
      app = await buildTestApp(ownerUser);

      const mockStatus = {
        jobId: 'job-abc-123-def',
        state: 'active' as const,
        progress: 50,
      };
      vi.mocked(getMaintenanceJobStatus).mockResolvedValue(mockStatus);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs/job-abc-123-def/status',
      });

      expect(response.statusCode).toBe(200);
    });

    it('accepts jobId with underscores', async () => {
      app = await buildTestApp(ownerUser);

      const mockStatus = {
        jobId: 'job_123_abc',
        state: 'waiting' as const,
        progress: 0,
      };
      vi.mocked(getMaintenanceJobStatus).mockResolvedValue(mockStatus);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs/job_123_abc/status',
      });

      expect(response.statusCode).toBe(200);
    });

    it('rejects jobId with special characters', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs/job-123;DROP/status',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Invalid job ID format');
    });

    it('rejects jobId with spaces', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs/job%20123/status',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Invalid job ID format');
    });

    it('validates jobId length constraint', async () => {
      app = await buildTestApp(ownerUser);

      // Test a jobId that's exactly at the boundary (100 chars is valid)
      const validJobId = 'a'.repeat(100);
      vi.mocked(getMaintenanceJobStatus).mockResolvedValue({
        jobId: validJobId,
        state: 'active' as const,
        progress: 50,
      });

      const validResponse = await app.inject({
        method: 'GET',
        url: `/maintenance/jobs/${validJobId}/status`,
      });

      expect(validResponse.statusCode).toBe(200);
    });

    it('rejects empty jobId', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs//status',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Invalid job ID format');
    });

    it('returns 404 when job not found', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(getMaintenanceJobStatus).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs/nonexistent-job/status',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().message).toContain('Job not found');
    });

    it('rejects non-owner accessing job status', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/jobs/job-123/status',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });
  });

  describe('GET /maintenance/stats', () => {
    it('returns queue statistics for owner', async () => {
      app = await buildTestApp(ownerUser);

      const mockStats = {
        waiting: 2,
        active: 1,
        completed: 10,
        failed: 0,
        delayed: 0,
      };
      vi.mocked(getMaintenanceQueueStats).mockResolvedValue(mockStats);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/stats',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.waiting).toBe(2);
      expect(body.active).toBe(1);
      expect(body.completed).toBe(10);
      expect(body.failed).toBe(0);
    });

    it('returns 503 when queue not available', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(getMaintenanceQueueStats).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/stats',
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().message).toContain('not available');
    });

    it('rejects non-owner accessing stats', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/stats',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });
  });

  describe('GET /maintenance/history', () => {
    it('returns recent job history for owner', async () => {
      app = await buildTestApp(ownerUser);

      const mockHistory = [
        {
          jobId: 'job-1',
          type: 'normalize_players' as const,
          state: 'completed' as const,
          createdAt: new Date('2024-01-01T10:00:00Z').getTime(),
          trigger: 'manual' as const,
          result: {
            success: true,
            type: 'normalize_players' as const,
            processed: 1000,
            updated: 500,
            skipped: 400,
            errors: 100,
            durationMs: 5000,
            message: 'Completed',
          },
        },
        {
          jobId: 'job-2',
          type: 'normalize_countries' as const,
          state: 'failed' as const,
          createdAt: new Date('2024-01-01T09:00:00Z').getTime(),
          trigger: 'auto' as const,
        },
      ];
      vi.mocked(getMaintenanceJobHistory).mockResolvedValue(mockHistory);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/history',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.history).toHaveLength(2);
      expect(body.history[0].jobId).toBe('job-1');
      expect(body.history[1].jobId).toBe('job-2');
      expect(getMaintenanceJobHistory).toHaveBeenCalledWith(10);
    });

    it('returns empty array when no history', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(getMaintenanceJobHistory).mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/history',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.history).toEqual([]);
    });

    it('rejects non-owner accessing history', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/history',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toContain('Only server owners');
    });

    it('passes through the trigger field on each history item', async () => {
      app = await buildTestApp(ownerUser);

      const mockHistory = [
        {
          jobId: 'job-1',
          type: 'link_imported_history' as const,
          state: 'completed' as const,
          createdAt: new Date('2024-01-01T10:00:00Z').getTime(),
          trigger: 'auto' as const,
        },
        {
          jobId: 'job-2',
          type: 'normalize_players' as const,
          state: 'completed' as const,
          createdAt: new Date('2024-01-01T09:00:00Z').getTime(),
          trigger: 'manual' as const,
        },
      ];
      vi.mocked(getMaintenanceJobHistory).mockResolvedValue(mockHistory);

      const response = await app.inject({
        method: 'GET',
        url: '/maintenance/history',
      });

      const body = response.json();
      expect(body.history[0].trigger).toBe('auto');
      expect(body.history[1].trigger).toBe('manual');
    });
  });
});
