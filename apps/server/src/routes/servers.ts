/**
 * Server management routes - CRUD for Plex/Jellyfin/Emby servers
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { createServerSchema, serverIdParamSchema, SERVER_STATS_CONFIG } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
// Token encryption removed - tokens now stored in plain text (DB is localhost-only)
import { PlexClient, JellyfinClient, EmbyClient } from '../services/mediaServer/index.js';
import { syncServer } from '../services/sync.js';

export const serverRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /servers - List connected servers
   * Returns all servers (without tokens) for the authenticated user
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = request.user;

    // Owners see all servers, guests only see their authorized servers
    const serverList = await db
      .select({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      })
      .from(servers)
      .where(
        authUser.role === 'owner'
          ? undefined // Owners see all servers
          : authUser.serverIds.length > 0
            ? inArray(servers.id, authUser.serverIds)
            : undefined // No serverIds = no access (will return empty)
      );

    return { data: serverList };
  });

  /**
   * POST /servers - Add a new server
   * Encrypts the token before storage
   */
  app.post('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = createServerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { name, type, url, token } = body.data;
    const authUser = request.user;

    // Only owners can add servers
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can add servers');
    }

    // Check if server already exists
    const existing = await db.select().from(servers).where(eq(servers.url, url)).limit(1);

    if (existing.length > 0) {
      return reply.conflict('A server with this URL already exists');
    }

    // Verify the server connection
    try {
      if (type === 'plex') {
        const adminCheck = await PlexClient.verifyServerAdmin(token, url);
        if (!adminCheck.success) {
          // Provide specific error based on failure type
          if (adminCheck.code === PlexClient.AdminVerifyError.CONNECTION_FAILED) {
            return reply.serviceUnavailable(adminCheck.message);
          }
          return reply.forbidden(adminCheck.message);
        }
      } else if (type === 'jellyfin') {
        const isAdmin = await JellyfinClient.verifyServerAdmin(token, url);
        if (!isAdmin) {
          return reply.forbidden('Token does not have admin access to this Jellyfin server');
        }
      } else if (type === 'emby') {
        const isAdmin = await EmbyClient.verifyServerAdmin(token, url);
        if (!isAdmin) {
          return reply.forbidden('Token does not have admin access to this Emby server');
        }
      }
    } catch (error) {
      app.log.error({ error }, 'Failed to verify server connection');
      return reply.badRequest('Failed to connect to server. Please verify URL and token.');
    }

    // Save server with plain text token (DB is localhost-only)
    const inserted = await db
      .insert(servers)
      .values({
        name,
        type,
        url,
        token,
      })
      .returning({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      });

    const server = inserted[0];
    if (!server) {
      return reply.internalServerError('Failed to create server');
    }

    // Auto-sync users and libraries in background
    syncServer(server.id, { syncUsers: true, syncLibraries: true })
      .then((result) => {
        app.log.info(
          {
            serverId: server.id,
            usersAdded: result.usersAdded,
            librariesSynced: result.librariesSynced,
          },
          'Auto-sync completed for new server'
        );
      })
      .catch((error) => {
        app.log.error({ error, serverId: server.id }, 'Auto-sync failed for new server');
      });

    return reply.status(201).send(server);
  });

  /**
   * DELETE /servers/:id - Remove a server
   * Cascades to delete all related users, sessions, violations
   */
  app.delete('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = serverIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid server ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can delete servers
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can delete servers');
    }

    // Check if server exists and user has access
    const server = await db.select().from(servers).where(eq(servers.id, id)).limit(1);

    if (server.length === 0) {
      return reply.notFound('Server not found');
    }

    // Delete server (cascade will handle related records)
    await db.delete(servers).where(eq(servers.id, id));

    return { success: true };
  });

  /**
   * POST /servers/:id/sync - Force sync users and libraries from server
   * For Plex: Fetches users from Plex.tv including shared users
   * For Jellyfin: Fetches users from the server
   */
  app.post('/:id/sync', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = serverIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid server ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can sync
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can sync servers');
    }

    // Check server exists
    const serverRows = await db.select().from(servers).where(eq(servers.id, id)).limit(1);

    if (serverRows.length === 0) {
      return reply.notFound('Server not found');
    }

    try {
      const result = await syncServer(id, { syncUsers: true, syncLibraries: true });

      // Update server's updatedAt timestamp
      await db.update(servers).set({ updatedAt: new Date() }).where(eq(servers.id, id));

      return {
        success: result.errors.length === 0,
        usersAdded: result.usersAdded,
        usersUpdated: result.usersUpdated,
        librariesSynced: result.librariesSynced,
        errors: result.errors,
        syncedAt: new Date().toISOString(),
      };
    } catch (error) {
      app.log.error({ error, serverId: id }, 'Failed to sync server');
      return reply.internalServerError('Failed to sync server');
    }
  });

  /**
   * GET /servers/:id/statistics - Get server resource statistics (CPU, RAM)
   * On-demand endpoint for dashboard - data is not stored
   * Currently only supported for Plex servers (undocumented /statistics/resources endpoint)
   */
  app.get('/:id/statistics', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = serverIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid server ID');
    }

    const { id } = params.data;

    // Get server with token
    const serverRows = await db.select().from(servers).where(eq(servers.id, id)).limit(1);

    const server = serverRows[0];
    if (!server) {
      return reply.notFound('Server not found');
    }

    // Only Plex is supported for now (Jellyfin/Emby don't have equivalent endpoint)
    if (server.type !== 'plex') {
      return reply.badRequest('Server statistics are only available for Plex servers');
    }

    try {
      const client = new PlexClient({
        url: server.url,
        token: server.token,
      });

      const data = await client.getServerStatistics(SERVER_STATS_CONFIG.TIMESPAN_SECONDS);

      // DEBUG: Log what we got back
      app.log.info(
        { serverId: id, dataLength: data.length, firstItem: data[0] },
        'Server statistics fetched'
      );

      return {
        serverId: id,
        data,
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      app.log.error({ error, serverId: id }, 'Failed to fetch server statistics');
      return reply.internalServerError('Failed to fetch server statistics');
    }
  });

  /**
   * GET /servers/:id/image/* - Proxy images from Plex/Jellyfin servers
   * This endpoint fetches images without exposing server tokens to the client
   *
   * For Plex: /servers/:id/image/library/metadata/123/thumb/456
   * For Jellyfin: /servers/:id/image/Items/123/Images/Primary?tag=abc
   *
   * Note: Accepts auth via header OR query param (?token=xxx) since browser
   * <img> tags don't send Authorization headers
   */
  app.get('/:id/image/*', async (request, reply) => {
    // Custom auth: try header first, fall back to query param for <img> tags
    const queryToken = (request.query as { token?: string }).token;
    if (queryToken) {
      // Manually set authorization header for jwtVerify to work
      request.headers.authorization = `Bearer ${queryToken}`;
    }

    try {
      await request.jwtVerify();
    } catch {
      return reply.unauthorized('Invalid or missing token');
    }

    const { id } = request.params as { id: string; '*': string };
    const imagePath = (request.params as { '*': string })['*'];

    if (!imagePath) {
      return reply.badRequest('Image path is required');
    }

    // Get server with token
    const serverRows = await db.select().from(servers).where(eq(servers.id, id)).limit(1);

    const server = serverRows[0];
    if (!server) {
      return reply.notFound('Server not found');
    }

    const baseUrl = server.url.replace(/\/$/, '');
    const token = server.token;

    try {
      let imageUrl: string;
      let headers: Record<string, string>;

      if (server.type === 'plex') {
        // Plex uses X-Plex-Token query param
        const separator = imagePath.includes('?') ? '&' : '?';
        imageUrl = `${baseUrl}/${imagePath}${separator}X-Plex-Token=${token}`;
        headers = { Accept: 'image/*' };
      } else {
        // Jellyfin and Emby use X-Emby-Authorization header
        imageUrl = `${baseUrl}/${imagePath}`;
        headers = {
          'X-Emby-Authorization': `MediaBrowser Client="Tracearr", Device="Tracearr Server", DeviceId="tracearr-server", Version="1.0.0", Token="${token}"`,
          Accept: 'image/*',
        };
      }

      const response = await fetch(imageUrl, { headers });

      if (!response.ok) {
        return reply.notFound('Image not found');
      }

      const contentType = response.headers.get('content-type') ?? 'image/jpeg';
      const buffer = await response.arrayBuffer();

      reply.header('Content-Type', contentType);
      reply.header('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
      return reply.send(Buffer.from(buffer));
    } catch (error) {
      app.log.error({ error, serverId: id, imagePath }, 'Failed to fetch image from server');
      return reply.internalServerError('Failed to fetch image');
    }
  });
};
