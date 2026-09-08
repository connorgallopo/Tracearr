/**
 * Server management routes - CRUD for Plex/Jellyfin/Emby servers
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, inArray, and, asc } from 'drizzle-orm';
import {
  createServerSchema,
  serverIdParamSchema,
  reorderServersSchema,
  updateServerSchema,
  pickServerColor,
  PUBLIC_URL_PLEX_MESSAGE,
  type ServerConnectionStatus,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, plexAccounts } from '../db/schema.js';
// Token encryption removed - tokens now stored in plain text (DB is localhost-only)
import { PlexClient, JellyfinClient, EmbyClient } from '../services/mediaServer/index.js';
import { getServerLiveStats, getServerResourceStats } from '../services/serverLiveStats.js';
import { syncServer } from '../services/sync.js';
import { sseManager } from '../services/sseManager.js';
import { getCacheService } from '../services/cache.js';
import { enqueueLibrarySync } from '../jobs/librarySyncQueue.js';
import { publishServersChanged } from '../jobs/poller/database.js';
import { buildServerAccessCondition } from '../utils/serverFiltering.js';

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
        publicUrl: servers.publicUrl,
        machineIdentifier: servers.machineIdentifier,
        displayOrder: servers.displayOrder,
        color: servers.color,
        version: servers.version,
        latestVersion: servers.latestVersion,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      })
      .from(servers)
      .where(buildServerAccessCondition(authUser, servers.id))
      .orderBy(asc(servers.displayOrder));

    // Backfill colors for any servers missing them
    const uncolored = serverList.filter((s) => !s.color);
    if (uncolored.length > 0) {
      const usedColors = serverList.map((s) => s.color);
      for (const server of uncolored) {
        const newColor = pickServerColor(server.type, usedColors);
        server.color = newColor;
        usedColors.push(newColor);
        db.update(servers)
          .set({ color: newColor })
          .where(eq(servers.id, server.id))
          .execute()
          .catch((err) =>
            app.log.warn({ err, serverId: server.id }, 'Failed to backfill server color')
          );
      }
    }

    return { data: serverList };
  });

  /**
   * POST /servers - Add a new server
   * Encrypts the token before storage
   */
  app.post('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = createServerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest(body.error.issues[0]?.message ?? 'Invalid request body');
    }

    const { name, type, url, token, publicUrl } = body.data;
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

    // For Plex servers, find the owning plex account to set plexAccountId
    let plexAccountId: string | undefined;

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

        // Get the Plex account ID from the token and link to user's plex_accounts
        try {
          const accountInfo = await PlexClient.getAccountInfo(token);
          const matchingAccount = await db
            .select({ id: plexAccounts.id })
            .from(plexAccounts)
            .where(
              and(
                eq(plexAccounts.userId, authUser.userId),
                eq(plexAccounts.plexAccountId, accountInfo.id)
              )
            )
            .limit(1);

          if (matchingAccount.length > 0) {
            plexAccountId = matchingAccount[0]!.id;
          }
        } catch {
          // Non-fatal: server will be orphaned but auto-repair can fix it later
          app.log.debug('Could not link Plex server to account at creation time');
        }
      } else if (type === 'jellyfin') {
        const adminCheck = await JellyfinClient.verifyServerAdmin(token, url);
        if (!adminCheck.success) {
          // Provide specific error based on failure type
          if (adminCheck.code === JellyfinClient.AdminVerifyError.CONNECTION_FAILED) {
            return reply.serviceUnavailable(adminCheck.message);
          }
          if (adminCheck.code === JellyfinClient.AdminVerifyError.INVALID_KEY) {
            return reply.unauthorized(adminCheck.message);
          }
          return reply.forbidden(adminCheck.message);
        }
      } else if (type === 'emby') {
        const isAdmin = await EmbyClient.verifyServerAdmin(token, url);
        if (!isAdmin) {
          return reply.forbidden('Token does not have admin access to this Emby server');
        }
      }
    } catch (error) {
      app.log.error({ err: error }, 'Failed to verify server connection');
      return reply.badRequest('Failed to connect to server. Please verify URL and token.');
    }

    // Auto-assign a color based on server type and already-used colors
    const existingColors = await db.select({ color: servers.color }).from(servers);
    const color = pickServerColor(
      type,
      existingColors.map((s) => s.color)
    );

    // Save server with plain text token (DB is localhost-only)
    const inserted = await db
      .insert(servers)
      .values({
        name,
        type,
        url,
        publicUrl: publicUrl ?? null,
        token,
        color,
        plexAccountId, // Links Plex servers to their owning account (undefined for non-Plex)
      })
      .returning({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        publicUrl: servers.publicUrl,
        color: servers.color,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      });

    const server = inserted[0];
    if (!server) {
      return reply.internalServerError('Failed to create server');
    }

    await publishServersChanged();

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
        app.log.error({ err: error, serverId: server.id }, 'Auto-sync failed for new server');
      });

    // Start realtime (SSE) connection in background
    sseManager.refresh().catch((error: unknown) => {
      app.log.error({ err: error, serverId: server.id }, 'SSE refresh failed for new server');
    });

    return reply.status(201).send(server);
  });

  /**
   * PATCH /servers/:id - Update server name and/or URL
   * Accepts optional name and/or url; at least one is required.
   * When url is provided, verifies the new URL is reachable with existing token before updating.
   *
   * For Plex servers with clientIdentifier:
   * - Validates that the clientIdentifier matches the server's machineIdentifier
   * - This prevents accidentally connecting Server A's config to Server B's URL
   */
  app.patch('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = serverIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid server ID');
    }

    const body = updateServerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest(body.error.issues[0]?.message ?? 'Invalid request body');
    }

    const { id } = params.data;
    const {
      name: newName,
      url: bodyUrl,
      clientIdentifier,
      color: newColor,
      publicUrl: newPublicUrl,
    } = body.data;
    const newUrl = bodyUrl !== undefined ? bodyUrl.replace(/\/$/, '') : undefined;
    const authUser = request.user;

    // Only owners can update servers
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update servers');
    }

    // Get existing server with token
    const serverRows = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
    const server = serverRows[0];

    if (!server) {
      return reply.notFound('Server not found');
    }

    if (server.type === 'plex' && newPublicUrl !== undefined) {
      return reply.badRequest(PUBLIC_URL_PLEX_MESSAGE);
    }

    const same = <T>(next: T | undefined, current: T): boolean =>
      next === undefined || next === current;
    if (
      same(newName, server.name) &&
      same(newUrl, server.url) &&
      same(newColor, server.color) &&
      same(newPublicUrl, server.publicUrl)
    ) {
      return {
        id: server.id,
        name: server.name,
        type: server.type,
        url: server.url,
        publicUrl: server.publicUrl,
        color: server.color,
        createdAt: server.createdAt,
        updatedAt: server.updatedAt,
      };
    }

    // Only verify when the URL is actually changing
    if (newUrl !== undefined && server.url !== newUrl) {
      // For Plex servers: Validate machineIdentifier if provided
      if (server.type === 'plex' && clientIdentifier) {
        if (server.machineIdentifier && server.machineIdentifier !== clientIdentifier) {
          return reply.badRequest(
            'Server mismatch: The selected connection belongs to a different server. ' +
              'Please select a connection for the correct server.'
          );
        }
      }

      // Verify the new URL works with the existing token
      try {
        if (server.type === 'plex') {
          const adminCheck = await PlexClient.verifyServerAdmin(server.token, newUrl);
          if (!adminCheck.success) {
            if (adminCheck.code === PlexClient.AdminVerifyError.CONNECTION_FAILED) {
              return reply.serviceUnavailable(adminCheck.message);
            }
            return reply.forbidden(adminCheck.message);
          }
        } else if (server.type === 'jellyfin') {
          const adminCheck = await JellyfinClient.verifyServerAdmin(server.token, newUrl);
          if (!adminCheck.success) {
            if (adminCheck.code === JellyfinClient.AdminVerifyError.CONNECTION_FAILED) {
              return reply.serviceUnavailable(adminCheck.message);
            }
            if (adminCheck.code === JellyfinClient.AdminVerifyError.INVALID_KEY) {
              return reply.unauthorized(adminCheck.message);
            }
            return reply.forbidden(adminCheck.message);
          }
        } else if (server.type === 'emby') {
          const isAdmin = await EmbyClient.verifyServerAdmin(server.token, newUrl);
          if (!isAdmin) {
            return reply.forbidden('Token does not have admin access at this URL');
          }
        }
      } catch (error) {
        app.log.error({ err: error, serverId: id, newUrl }, 'Failed to verify new server URL');
        return reply.badRequest(
          'Failed to connect to server at new URL. Please verify the URL is correct.'
        );
      }
    }

    const updatePayload: {
      name?: string;
      url?: string;
      color?: string | null;
      publicUrl?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (newName !== undefined) updatePayload.name = newName;
    if (newUrl !== undefined) updatePayload.url = newUrl;
    if (newColor !== undefined) updatePayload.color = newColor;
    if (newPublicUrl !== undefined) updatePayload.publicUrl = newPublicUrl;

    const updated = await db
      .update(servers)
      .set(updatePayload)
      .where(eq(servers.id, id))
      .returning({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        publicUrl: servers.publicUrl,
        color: servers.color,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      });

    const result = updated[0];
    if (!result) {
      return reply.internalServerError('Failed to update server');
    }

    await publishServersChanged();

    if (newUrl !== undefined) {
      app.log.info({ serverId: id, oldUrl: server.url, newUrl }, 'Server URL updated');
      // Existing SSE connection holds the old URL; drop it and let refresh re-add
      sseManager
        .removeServer(id)
        .then(() => sseManager.refresh())
        .catch((error: unknown) => {
          app.log.error({ err: error, serverId: id }, 'SSE refresh failed after URL update');
        });
    }
    if (newName !== undefined) {
      app.log.info({ serverId: id, oldName: server.name, newName }, 'Server name updated');
    }

    return result;
  });

  /**
   * PATCH /servers/reorder - Update server display order
   * Accepts array of { id, displayOrder } and updates all servers in a transaction
   */
  app.patch('/reorder', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = reorderServersSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { servers: serverUpdates } = body.data;
    const authUser = request.user;

    // Only owners can reorder servers (guests can't manage server settings)
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can reorder servers');
    }

    // Validate that all server IDs belong to accessible servers
    const serverIds = serverUpdates.map((s: { id: string; displayOrder: number }) => s.id);
    const existingServers = await db
      .select({ id: servers.id })
      .from(servers)
      .where(
        authUser.role === 'owner'
          ? inArray(servers.id, serverIds)
          : and(
              inArray(servers.id, serverIds),
              inArray(servers.id, authUser.serverIds.length > 0 ? authUser.serverIds : [''])
            )
      );

    if (existingServers.length !== serverIds.length) {
      return reply.badRequest('One or more server IDs are invalid or inaccessible');
    }

    // Perform batch update in a transaction
    try {
      await db.transaction(async (tx) => {
        for (const update of serverUpdates) {
          await tx
            .update(servers)
            .set({ displayOrder: update.displayOrder, updatedAt: new Date() })
            .where(eq(servers.id, update.id));
        }
      });

      await publishServersChanged();

      app.log.info(
        { serverCount: serverUpdates.length },
        'Server display order updated successfully'
      );

      return { success: true };
    } catch (error) {
      app.log.error({ err: error }, 'Failed to update server display order');
      return reply.internalServerError('Failed to update server order');
    }
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
    await publishServersChanged();

    // Tear down the server's SSE connection in background
    sseManager.refresh().catch((error: unknown) => {
      app.log.error({ err: error, serverId: id }, 'SSE refresh failed after server delete');
    });

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

      // Also trigger full library sync (items/episodes) in background
      let librarySyncJobId: string | null = null;
      try {
        librarySyncJobId = await enqueueLibrarySync(id, authUser.userId);
        app.log.info({ serverId: id, jobId: librarySyncJobId }, 'Library sync job enqueued');
      } catch (err) {
        // Don't fail the whole sync if library sync can't be queued
        const message = err instanceof Error ? err.message : 'Unknown error';
        app.log.warn({ serverId: id, error: message }, 'Could not enqueue library sync');
      }

      return {
        success: result.errors.length === 0,
        usersAdded: result.usersAdded,
        usersUpdated: result.usersUpdated,
        usersRemoved: result.usersRemoved,
        usersRestored: result.usersRestored,
        librariesSynced: result.librariesSynced,
        librarySyncJobId,
        errors: result.errors,
        syncedAt: new Date().toISOString(),
      };
    } catch (error) {
      app.log.error({ err: error, serverId: id }, 'Failed to sync server');
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

    const data = await getServerResourceStats(app.redis, server);

    return {
      serverId: id,
      data,
      fetchedAt: new Date().toISOString(),
    };
  });

  /**
   * GET /servers/:id/live-stats - Combined resource and bandwidth statistics
   * One request per dashboard tick, for any server type: Plex serves its
   * statistics endpoints behind a short Redis cache, Jellyfin/Emby serve the
   * rolling buffer the SSE plugin's server.stats events fill (empty until
   * the plugin reports), so multi-server dashboards fan out without
   * special-casing type.
   */
  app.get('/:id/live-stats', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = serverIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid server ID');
    }

    const { id } = params.data;

    const serverRows = await db.select().from(servers).where(eq(servers.id, id)).limit(1);

    const server = serverRows[0];
    if (!server) {
      return reply.notFound('Server not found');
    }

    const stats = await getServerLiveStats(app.redis, server);

    // Per-account/device attribution names other users' accounts; the charts
    // only need the aggregated series, so the detail is owner-only
    const includeDetail = request.user?.role === 'owner';

    return {
      serverId: id,
      ...stats,
      ...(includeDetail
        ? {}
        : { bandwidthSamples: [], bandwidthAccounts: [], bandwidthDevices: [] }),
      fetchedAt: new Date().toISOString(),
    };
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

    // Shared guard rather than a bare jwtVerify: it also enforces the
    // post-restore revocation timestamp and the mobile device blacklist.
    await app.authenticate(request, reply);
    if (reply.sent) return;

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
        imageUrl = `${baseUrl}/${imagePath}`;
        const authValue = `MediaBrowser Client="Tracearr", Device="Tracearr Server", DeviceId="tracearr-server", Version="1.0.0", Token="${token}"`;
        const authHeaderName =
          server.type === 'jellyfin' ? 'Authorization' : 'X-Emby-Authorization';
        headers = {
          [authHeaderName]: authValue,
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
      app.log.error({ err: error, serverId: id, imagePath }, 'Failed to fetch image from server');
      return reply.internalServerError('Failed to fetch image');
    }
  });

  /**
   * GET /servers/health - Get health status for all servers
   * Returns which servers are currently unreachable based on cached health state
   */
  app.get('/health', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = request.user;

    // Get all servers the user has access to
    const serverList = await db
      .select({
        id: servers.id,
        name: servers.name,
      })
      .from(servers)
      .where(buildServerAccessCondition(authUser, servers.id));

    const cacheService = getCacheService();
    const unhealthyServers: { serverId: string; serverName: string }[] = [];

    if (cacheService) {
      for (const server of serverList) {
        const isHealthy = await cacheService.getServerHealth(server.id);
        // null means unknown (not yet checked), true means healthy
        // Only include servers explicitly marked as unhealthy (false)
        if (isHealthy === false) {
          unhealthyServers.push({ serverId: server.id, serverName: server.name });
        }
      }
    }

    return { data: unhealthyServers };
  });

  /**
   * GET /servers/connection-status - Live SSE plugin connection state per server
   *
   * Returns per-server realtime/polling mode. Status is ephemeral runtime truth
   * mirrored in Redis with a TTL — not persisted to the database. Servers with
   * no cached status are reported as polling (safe default).
   */
  app.get('/connection-status', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = request.user;

    const serverList = await db
      .select({
        id: servers.id,
        name: servers.name,
        type: servers.type,
      })
      .from(servers)
      .where(buildServerAccessCondition(authUser, servers.id));

    const cacheService = getCacheService();
    const result: ServerConnectionStatus[] = [];

    for (const server of serverList) {
      if (cacheService) {
        const cached = await cacheService.getServerConnectionStatus(server.id);
        if (cached) {
          result.push(cached);
          continue;
        }
      }

      // No cached status yet — default to polling (safe)
      result.push({
        serverId: server.id,
        serverName: server.name,
        serverType: server.type,
        mode: 'polling',
        state: 'fallback',
        lastEventAt: null,
        since: null,
        error: null,
        pluginVersion: null,
        pluginUpdateAvailable: false,
        pluginIssue: null,
      });
    }

    return { data: result };
  });
};
