/**
 * Emby Authentication Routes
 *
 * POST /emby/connect-api-key - Connect an Emby server with API key (requires authentication)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';
import { EmbyClient } from '../../services/mediaServer/index.js';
// Token encryption removed - tokens now stored in plain text (DB is localhost-only)
import { generateTokens } from './utils.js';
import { syncServer } from '../../services/sync.js';

// Schema for API key connection
const embyConnectApiKeySchema = z.object({
  serverUrl: z.url(),
  serverName: z.string().min(1).max(100),
  apiKey: z.string().min(1),
});

export const embyRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /emby/connect-api-key - Connect an Emby server with API key (requires authentication)
   */
  app.post('/emby/connect-api-key', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = embyConnectApiKeySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('serverUrl, serverName, and apiKey are required');
    }

    const authUser = request.user;

    // Only owners can add servers
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only owners can add servers');
    }

    const { serverUrl, serverName, apiKey } = body.data;

    try {
      // Verify the API key has admin access
      const isAdmin = await EmbyClient.verifyServerAdmin(apiKey, serverUrl);

      if (!isAdmin) {
        return reply.forbidden('API key does not have administrator access to this Emby server');
      }

      // Create or update server
      let server = await db
        .select()
        .from(servers)
        .where(and(eq(servers.url, serverUrl), eq(servers.type, 'emby')))
        .limit(1);

      if (server.length === 0) {
        const inserted = await db
          .insert(servers)
          .values({
            name: serverName,
            type: 'emby',
            url: serverUrl,
            token: apiKey,
          })
          .returning();
        server = inserted;
      } else {
        const existingServer = server[0]!;
        await db
          .update(servers)
          .set({
            name: serverName,
            token: apiKey,
            updatedAt: new Date(),
          })
          .where(eq(servers.id, existingServer.id));
      }

      const serverId = server[0]!.id;

      app.log.info({ userId: authUser.userId, serverId }, 'Emby server connected via API key');

      // Auto-sync server users and libraries in background
      syncServer(serverId, { syncUsers: true, syncLibraries: true })
        .then((result) => {
          app.log.info(
            { serverId, usersAdded: result.usersAdded, librariesSynced: result.librariesSynced },
            'Auto-sync completed for Emby server'
          );
        })
        .catch((error) => {
          app.log.error({ error, serverId }, 'Auto-sync failed for Emby server');
        });

      // Return updated tokens with new server access
      return generateTokens(app, authUser.userId, authUser.username, authUser.role);
    } catch (error) {
      app.log.error({ error }, 'Emby connect-api-key failed');
      return reply.internalServerError('Failed to connect Emby server');
    }
  });
};
