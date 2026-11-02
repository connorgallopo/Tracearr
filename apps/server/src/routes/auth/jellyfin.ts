/**
 * Jellyfin Authentication Routes
 *
 * POST /jellyfin/connect-api-key - Connect a Jellyfin server with API key (requires authentication)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { apiKeyConnectSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';
import { invalidateServersCache } from '../../jobs/poller/database.js';
import { JellyfinClient } from '../../services/mediaServer/index.js';
import { syncServer } from '../../services/sync.js';
import { HISTORICAL_EDIT_MESSAGE } from '../../services/liveServers.js';
import { rebuildAutoSyncSchedules } from '../../jobs/librarySyncQueue.js';

export const jellyfinRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /jellyfin/connect-api-key - Connect a Jellyfin server with API key (requires authentication)
   */
  app.post(
    '/jellyfin/connect-api-key',
    { preHandler: [app.requireOwner] },
    async (request, reply) => {
      const body = apiKeyConnectSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('serverUrl, serverName, and apiKey are required');
      }

      const authUser = request.user;

      const { serverUrl, serverName, apiKey, publicUrl } = body.data;

      try {
        let server = await db
          .select()
          .from(servers)
          .where(and(eq(servers.url, serverUrl), eq(servers.type, 'jellyfin')))
          .limit(1);

        if (server[0]?.historicalAt) {
          return reply.conflict(HISTORICAL_EDIT_MESSAGE);
        }

        // Verify the API key has admin access
        const adminCheck = await JellyfinClient.verifyServerAdmin(apiKey, serverUrl);

        if (!adminCheck.success) {
          // Provide specific error based on failure type
          if (adminCheck.code === JellyfinClient.AdminVerifyError.CONNECTION_FAILED) {
            return reply.serviceUnavailable(adminCheck.message);
          }
          if (adminCheck.code === JellyfinClient.AdminVerifyError.INVALID_KEY) {
            return reply.badRequest(adminCheck.message);
          }
          return reply.forbidden(adminCheck.message);
        }

        if (server.length === 0) {
          const inserted = await db
            .insert(servers)
            .values({
              name: serverName,
              type: 'jellyfin',
              url: serverUrl,
              token: apiKey,
              publicUrl: publicUrl ?? null,
            })
            .returning();
          server = inserted;
          rebuildAutoSyncSchedules().catch((error: unknown) => {
            app.log.error(
              { err: error, serverId: inserted[0]?.id },
              'Auto-sync schedule failed for new server'
            );
          });
        } else {
          const existingServer = server[0]!;
          await db
            .update(servers)
            .set({
              name: serverName,
              token: apiKey,
              ...(publicUrl !== undefined ? { publicUrl } : {}),
              updatedAt: new Date(),
            })
            .where(eq(servers.id, existingServer.id));
        }
        invalidateServersCache();

        const serverId = server[0]!.id;

        app.log.info(
          { userId: authUser.userId, serverId },
          'Jellyfin server connected via API key'
        );

        // Auto-sync server users and libraries in background
        syncServer(serverId, { syncUsers: true, syncLibraries: true })
          .then((result) => {
            app.log.info(
              { serverId, usersAdded: result.usersAdded, librariesSynced: result.librariesSynced },
              'Auto-sync completed for Jellyfin server'
            );
          })
          .catch((error: unknown) => {
            app.log.error({ err: error, serverId }, 'Auto-sync failed for Jellyfin server');
          });

        return { serverId };
      } catch (error) {
        app.log.error({ err: error }, 'Jellyfin connect-api-key failed');
        return reply.internalServerError('Failed to connect Jellyfin server');
      }
    }
  );
};
