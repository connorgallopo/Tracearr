/**
 * Import routes unit tests
 *
 * Tests the API endpoints for data import from external sources:
 * - POST /import/tautulli - Start Tautulli history import
 * - POST /import/tautulli/test - Test Tautulli connection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock class for TautulliService
let mockTautulliInstance: {
  testConnection: ReturnType<typeof vi.fn>;
  getUsers: ReturnType<typeof vi.fn>;
  getHistory: ReturnType<typeof vi.fn>;
};

// Mock external services
vi.mock('../../services/tautulli.js', () => {
  const MockTautulliService = vi.fn().mockImplementation(function (
    this: typeof mockTautulliInstance
  ) {
    // Copy mock instance methods to this
    this.testConnection = mockTautulliInstance.testConnection;
    this.getUsers = mockTautulliInstance.getUsers;
    this.getHistory = mockTautulliInstance.getHistory;
  });
  // Add static method
  (MockTautulliService as unknown as { importHistory: ReturnType<typeof vi.fn> }).importHistory =
    vi.fn();
  return { TautulliService: MockTautulliService };
});

vi.mock('../../services/cache.js', () => ({
  getPubSubService: vi.fn().mockReturnValue(null),
}));

vi.mock('../../services/sync.js', () => ({
  syncServer: vi.fn().mockResolvedValue(undefined),
}));

// Mock import queue functions
vi.mock('../../jobs/importQueue.js', () => ({
  enqueueImport: vi.fn().mockRejectedValue(new Error('Queue not available')),
  getImportStatus: vi.fn().mockResolvedValue(null),
  cancelImport: vi.fn().mockResolvedValue(false),
  getImportQueueStats: vi.fn().mockResolvedValue(null),
  getActiveImportForServer: vi.fn().mockResolvedValue(null),
}));

// Import mocked services and routes
import { TautulliService } from '../../services/tautulli.js';
import { syncServer } from '../../services/sync.js';
import {
  enqueueImport,
  getImportStatus,
  cancelImport,
  getImportQueueStats,
  getActiveImportForServer,
} from '../../jobs/importQueue.js';
import { importRoutes } from '../import.js';

/**
 * Build a test Fastify instance with mocked auth
 */
async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers
  await app.register(sensible);

  // Mock the authenticate decorator
  app.decorate('authenticate', async (request: unknown) => {
    (request as { user: AuthUser }).user = authUser;
  });

  // Register routes
  await app.register(importRoutes, { prefix: '/import' });

  return app;
}

/**
 * Create a mock owner auth user
 */
function createOwnerUser(): AuthUser {
  return {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [randomUUID()],
  };
}

/**
 * Create a mock viewer auth user (non-owner)
 */
function createViewerUser(): AuthUser {
  return {
    userId: randomUUID(),
    username: 'viewer',
    role: 'viewer',
    serverIds: [randomUUID()],
  };
}

describe('Import Routes', () => {
  let app: FastifyInstance;
  const ownerUser = createOwnerUser();
  const viewerUser = createViewerUser();

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock instance with default behavior
    mockTautulliInstance = {
      testConnection: vi.fn().mockResolvedValue(false),
      getUsers: vi.fn().mockResolvedValue([]),
      getHistory: vi.fn().mockResolvedValue({ total: 0 }),
    };
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('POST /import/tautulli', () => {
    const validServerId = randomUUID();

    it('starts import for owner user', async () => {
      app = await buildTestApp(ownerUser);

      // Mock TautulliService.importHistory static method
      const mockImportHistory = vi.fn().mockResolvedValue({ imported: 100 });
      (TautulliService as unknown as { importHistory: ReturnType<typeof vi.fn> }).importHistory =
        mockImportHistory;

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli',
        payload: { serverId: validServerId },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // When queue is not available (no Redis in tests), falls back to direct execution
      expect(body.status).toBe('started');
      expect(body.message).toContain('Import started');

      // Verify server sync was called
      expect(syncServer).toHaveBeenCalledWith(validServerId, {
        syncUsers: true,
        syncLibraries: false,
      });
    });

    it('rejects non-owner users', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli',
        payload: { serverId: validServerId },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Only server owners can import data');
    });

    it('rejects missing serverId', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('serverId is required');
    });

    it('rejects invalid request body', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli',
        payload: { serverId: 123 }, // Should be string
      });

      expect(response.statusCode).toBe(400);
    });

    it('handles sync failure gracefully', async () => {
      app = await buildTestApp(ownerUser);

      // Mock sync failure
      vi.mocked(syncServer).mockRejectedValueOnce(new Error('Sync failed'));

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli',
        payload: { serverId: validServerId },
      });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expect(body.message).toContain('Failed to sync server');
    });
  });

  describe('POST /import/tautulli/test', () => {
    const validUrl = 'http://localhost:8181';
    const validApiKey = 'test-api-key-12345';

    it('returns success when connection works', async () => {
      // Configure mock instance for successful connection
      mockTautulliInstance.testConnection.mockResolvedValue(true);
      mockTautulliInstance.getUsers.mockResolvedValue([{ user_id: 1 }, { user_id: 2 }]);
      mockTautulliInstance.getHistory.mockResolvedValue({ total: 1500 });

      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli/test',
        payload: { url: validUrl, apiKey: validApiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        success: true,
        message: 'Connection successful',
        users: 2,
        historyRecords: 1500,
      });
    });

    it('returns failure when connection fails', async () => {
      // Configure mock instance for failed connection
      mockTautulliInstance.testConnection.mockResolvedValue(false);

      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli/test',
        payload: { url: validUrl, apiKey: validApiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        success: false,
        message: 'Connection failed. Please check URL and API key.',
      });
    });

    it('handles connection error gracefully', async () => {
      // Configure mock instance for connection error
      mockTautulliInstance.testConnection.mockRejectedValue(new Error('Network unreachable'));

      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli/test',
        payload: { url: validUrl, apiKey: validApiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        success: false,
        message: 'Network unreachable',
      });
    });

    it('handles non-Error exceptions', async () => {
      // Configure mock instance for non-Error exception
      mockTautulliInstance.testConnection.mockRejectedValue('String error');

      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli/test',
        payload: { url: validUrl, apiKey: validApiKey },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        success: false,
        message: 'Connection failed',
      });
    });

    it('rejects non-owner users', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli/test',
        payload: { url: validUrl, apiKey: validApiKey },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Only server owners can test Tautulli connection');
    });

    it('rejects missing URL', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli/test',
        payload: { apiKey: validApiKey },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('URL and API key are required');
    });

    it('rejects missing API key', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli/test',
        payload: { url: validUrl },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('URL and API key are required');
    });

    it('rejects empty request body', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli/test',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /import/tautulli/active/:serverId', () => {
    const serverId = randomUUID();

    it('returns active: false when no import is active', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: `/import/tautulli/active/${serverId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({ active: false });
    });

    it('returns active: true with status when import is active', async () => {
      app = await buildTestApp(ownerUser);

      const mockStatus = {
        jobId: 'job-123',
        state: 'active',
        progress: { processed: 50, total: 100 },
      };

      vi.mocked(getActiveImportForServer).mockResolvedValueOnce('job-123');
      vi.mocked(getImportStatus).mockResolvedValueOnce(mockStatus);

      const response = await app.inject({
        method: 'GET',
        url: `/import/tautulli/active/${serverId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.active).toBe(true);
      expect(body.jobId).toBe('job-123');
    });

    it('returns active: false when job exists but status is null', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(getActiveImportForServer).mockResolvedValueOnce('job-123');
      vi.mocked(getImportStatus).mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'GET',
        url: `/import/tautulli/active/${serverId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({ active: false });
    });
  });

  describe('GET /import/tautulli/:jobId', () => {
    it('returns job status when found', async () => {
      app = await buildTestApp(ownerUser);

      const mockStatus = {
        jobId: 'job-456',
        state: 'completed',
        progress: { processed: 100, total: 100 },
      };

      vi.mocked(getImportStatus).mockResolvedValueOnce(mockStatus);

      const response = await app.inject({
        method: 'GET',
        url: '/import/tautulli/job-456',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.jobId).toBe('job-456');
      expect(body.state).toBe('completed');
    });

    it('returns 404 when job not found', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(getImportStatus).mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'GET',
        url: '/import/tautulli/nonexistent-job',
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.message).toBe('Import job not found');
    });
  });

  describe('DELETE /import/tautulli/:jobId', () => {
    it('cancels job successfully for owner', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(cancelImport).mockResolvedValueOnce(true);

      const response = await app.inject({
        method: 'DELETE',
        url: '/import/tautulli/job-789',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({ status: 'cancelled', jobId: 'job-789' });
    });

    it('returns 400 when cancel fails', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(cancelImport).mockResolvedValueOnce(false);

      const response = await app.inject({
        method: 'DELETE',
        url: '/import/tautulli/job-789',
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.message).toContain('Cannot cancel job');
    });

    it('rejects non-owner users', async () => {
      app = await buildTestApp(viewerUser);

      const response = await app.inject({
        method: 'DELETE',
        url: '/import/tautulli/job-789',
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.message).toBe('Only server owners can cancel imports');
    });
  });

  describe('GET /import/stats', () => {
    it('returns queue stats when available', async () => {
      app = await buildTestApp(ownerUser);

      const mockStats = {
        waiting: 2,
        active: 1,
        completed: 10,
        failed: 0,
        delayed: 0,
        dlqSize: 0,
      };

      vi.mocked(getImportQueueStats).mockResolvedValueOnce(mockStats);

      const response = await app.inject({
        method: 'GET',
        url: '/import/stats',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual(mockStats);
    });

    it('returns 503 when queue is unavailable', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(getImportQueueStats).mockResolvedValueOnce(null);

      const response = await app.inject({
        method: 'GET',
        url: '/import/stats',
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.message).toBe('Import queue not available');
    });
  });

  describe('POST /import/tautulli with queue', () => {
    const validServerId = randomUUID();

    it('returns queued status when queue is available', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(enqueueImport).mockResolvedValueOnce('job-queue-123');

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli',
        payload: { serverId: validServerId },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('queued');
      expect(body.jobId).toBe('job-queue-123');
    });

    it('returns conflict when import already in progress', async () => {
      app = await buildTestApp(ownerUser);

      vi.mocked(enqueueImport).mockRejectedValueOnce(
        new Error('Import already in progress for this server')
      );

      const response = await app.inject({
        method: 'POST',
        url: '/import/tautulli',
        payload: { serverId: validServerId },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json();
      expect(body.message).toContain('already in progress');
    });
  });
});
