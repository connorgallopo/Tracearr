/**
 * Watch Sync routes - Cross-server watch status synchronization
 */

import type { FastifyPluginAsync } from 'fastify';
import { watchSyncService } from '../services/watchSync/index.js';
import {
  enqueueWatchSync,
  getWatchSyncProgress,
  getWatchSyncJobHistory,
  scheduleRecurringWatchSync,
  cancelScheduledSync,
} from '../jobs/watchSyncQueue.js';

export const watchSyncRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /watch-sync/configs - List all sync configurations
   */
  app.get('/configs', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access watch sync settings');
    }

    const configs = await watchSyncService.getConfigs();
    return { configs };
  });

  /**
   * POST /watch-sync/configs - Create a new sync configuration
   */
  app.post<{
    Body: {
      sourceServerId: string;
      targetServerId: string;
      enabled?: boolean;
      dryRun?: boolean;
      syncMovies?: boolean;
      syncShows?: boolean;
      syncInProgress?: boolean;
      intervalMinutes?: number;
    };
  }>('/configs', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can create watch sync configurations');
    }

    const { sourceServerId, targetServerId, ...options } = request.body;

    if (!sourceServerId || !targetServerId) {
      return reply.badRequest('sourceServerId and targetServerId are required');
    }

    if (sourceServerId === targetServerId) {
      return reply.badRequest('Source and target servers must be different');
    }

    try {
      const config = await watchSyncService.createConfig({
        sourceServerId,
        targetServerId,
        ...options,
      });

      // Schedule recurring sync if enabled
      if (config.enabled) {
        await scheduleRecurringWatchSync(config.id, config.intervalMinutes);
      }

      return { config };
    } catch (error) {
      if (error instanceof Error && error.message.includes('unique')) {
        return reply.conflict('A sync configuration between these servers already exists');
      }
      throw error;
    }
  });

  /**
   * GET /watch-sync/configs/:id - Get a specific sync configuration
   */
  app.get<{ Params: { id: string } }>(
    '/configs/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can access watch sync settings');
      }

      const { id } = request.params;

      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.badRequest('Invalid config ID format');
      }

      const config = await watchSyncService.getConfig(id);
      if (!config) {
        return reply.notFound('Configuration not found');
      }

      return { config };
    }
  );

  /**
   * PATCH /watch-sync/configs/:id - Update a sync configuration
   */
  app.patch<{
    Params: { id: string };
    Body: {
      enabled?: boolean;
      dryRun?: boolean;
      syncMovies?: boolean;
      syncShows?: boolean;
      syncInProgress?: boolean;
      intervalMinutes?: number;
    };
  }>('/configs/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update watch sync configurations');
    }

    const { id } = request.params;

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.badRequest('Invalid config ID format');
    }

    const config = await watchSyncService.updateConfig(id, request.body);
    if (!config) {
      return reply.notFound('Configuration not found');
    }

    // Update scheduled sync
    if (config.enabled) {
      await scheduleRecurringWatchSync(config.id, config.intervalMinutes);
    } else {
      await cancelScheduledSync(config.id);
    }

    return { config };
  });

  /**
   * DELETE /watch-sync/configs/:id - Delete a sync configuration
   */
  app.delete<{ Params: { id: string } }>(
    '/configs/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can delete watch sync configurations');
      }

      const { id } = request.params;

      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.badRequest('Invalid config ID format');
      }

      // Cancel scheduled sync first
      await cancelScheduledSync(id);

      const deleted = await watchSyncService.deleteConfig(id);
      if (!deleted) {
        return reply.notFound('Configuration not found');
      }

      return { success: true };
    }
  );

  /**
   * POST /watch-sync/configs/:id/sync - Trigger a manual sync (preview or auto)
   */
  app.post<{ Params: { id: string } }>(
    '/configs/:id/sync',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can trigger watch syncs');
      }

      const { id } = request.params;

      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.badRequest('Invalid config ID format');
      }

      // Verify config exists
      const config = await watchSyncService.getConfig(id);
      if (!config) {
        return reply.notFound('Configuration not found');
      }

      try {
        const jobId = await enqueueWatchSync(id, authUser.userId);
        return {
          status: 'queued',
          jobId,
          dryRun: config.dryRun,
          message: config.dryRun
            ? 'Preview sync queued - review items and approve to sync'
            : 'Auto sync queued. Watch for progress updates via WebSocket.',
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
   * POST /watch-sync/configs/:id/sync-selected - Sync specific approved items
   */
  app.post<{
    Params: { id: string };
    Body: {
      items: Array<{
        targetServerItemId: string;
        targetServerUserId: string;
        action: 'mark_watched' | 'update_progress';
        sourceProgressMs?: number;
        sourceViewedAt?: string;
        sourceTitle: string;
      }>;
    };
  }>('/configs/:id/sync-selected', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can trigger watch syncs');
    }

    const { id } = request.params;
    const { items } = request.body;

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.badRequest('Invalid config ID format');
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return reply.badRequest('items array is required and must not be empty');
    }

    console.log(
      `[WatchSync] Sync-selected request for config ${id}: ` +
        items
          .map((item) => `${item.targetServerItemId}:${item.action}:${item.sourceTitle}`)
          .join(' | ')
    );

    // Verify config exists
    const config = await watchSyncService.getConfig(id);
    if (!config) {
      return reply.notFound('Configuration not found');
    }

    // Map to full WatchSyncPreviewItem format (fill in missing fields with defaults)
    const fullItems = items.map((item) => ({
      title: item.sourceTitle,
      sourceTitle: item.sourceTitle,
      targetTitle: item.sourceTitle, // We don't have target title, use source
      type: 'movie' as const, // Type doesn't matter for sync
      sourceServer: config.sourceServerName ?? 'Unknown',
      targetServer: config.targetServerName ?? 'Unknown',
      sourceServerUserId: '', // Not needed for sync
      targetServerUserId: item.targetServerUserId,
      sourceUsername: '',
      targetUsername: '',
      targetServerItemId: item.targetServerItemId,
      action: item.action,
      sourceProgressMs: item.sourceProgressMs,
      sourceViewedAt: item.sourceViewedAt,
    }));

    try {
      const result = await watchSyncService.syncSelectedItems(id, fullItems);
      return {
        status: 'completed',
        result,
      };
    } catch (error) {
      if (error instanceof Error) {
        return reply.internalServerError(error.message);
      }
      throw error;
    }
  });

  /**
   * GET /watch-sync/configs/:id/users - Get available users for mapping
   */
  app.get<{ Params: { id: string } }>(
    '/configs/:id/users',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can access watch sync settings');
      }

      const { id } = request.params;

      // Validate UUID format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return reply.badRequest('Invalid config ID format');
      }

      // Verify config exists
      const config = await watchSyncService.getConfig(id);
      if (!config) {
        return reply.notFound('Configuration not found');
      }

      const [availableUsers, mappings] = await Promise.all([
        watchSyncService.getAvailableUsers(id),
        watchSyncService.getUserMappings(id),
      ]);

      return {
        sourceUsers: availableUsers.sourceUsers,
        targetUsers: availableUsers.targetUsers,
        mappings,
      };
    }
  );

  /**
   * POST /watch-sync/configs/:id/users - Add a user mapping
   */
  app.post<{
    Params: { id: string };
    Body: {
      sourceServerUserId: string;
      targetServerUserId: string;
      enabled?: boolean;
    };
  }>('/configs/:id/users', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can manage user mappings');
    }

    const { id } = request.params;
    const { sourceServerUserId, targetServerUserId, enabled } = request.body;

    // Validate UUID formats
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.badRequest('Invalid config ID format');
    }

    if (!sourceServerUserId || !targetServerUserId) {
      return reply.badRequest('sourceServerUserId and targetServerUserId are required');
    }

    // Verify config exists
    const config = await watchSyncService.getConfig(id);
    if (!config) {
      return reply.notFound('Configuration not found');
    }

    try {
      const mapping = await watchSyncService.addUserMapping({
        configId: id,
        sourceServerUserId,
        targetServerUserId,
        enabled,
      });

      return { mapping };
    } catch (error) {
      if (error instanceof Error && error.message.includes('unique')) {
        return reply.conflict('This user mapping already exists');
      }
      if (error instanceof Error && error.message.includes('does not match')) {
        return reply.badRequest(error.message);
      }
      throw error;
    }
  });

  /**
   * DELETE /watch-sync/configs/:id/users/:mappingId - Remove a user mapping
   */
  app.delete<{ Params: { id: string; mappingId: string } }>(
    '/configs/:id/users/:mappingId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can manage user mappings');
      }

      const { id, mappingId } = request.params;

      // Validate UUID formats
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id) || !uuidRegex.test(mappingId)) {
        return reply.badRequest('Invalid ID format');
      }

      const deleted = await watchSyncService.removeUserMapping(mappingId);
      if (!deleted) {
        return reply.notFound('Mapping not found');
      }

      return { success: true };
    }
  );

  /**
   * GET /watch-sync/progress - Get current sync progress (if any)
   */
  app.get('/progress', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access watch sync status');
    }

    const progress = await getWatchSyncProgress();
    return { progress };
  });

  /**
   * GET /watch-sync/history - Get recent sync results
   */
  app.get('/history', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can access watch sync history');
    }

    const history = await getWatchSyncJobHistory(20);
    return { history };
  });
};
