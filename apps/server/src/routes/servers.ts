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
import {
  PlexClient,
  JellyfinClient,
  EmbyClient,
  DispatcharrClient,
} from '../services/mediaServer/index.js';
import { getServerLiveStats, getServerResourceStats } from '../services/serverLiveStats.js';
import { syncServer } from '../services/sync.js';
import { sseManager } from '../services/sseManager.js';
import { getCacheService } from '../services/cache.js';
import { enqueueLibrarySync } from '../jobs/librarySyncQueue.js';
import { supportsMediaLibrary } from '@tracearr/shared';
import { publishServersChanged } from '../jobs/poller/database.js';
import { readServerIdentity } from '../services/serverIdentity.js';
import { rearmImportedHistoryLink } from '../services/settings.js';
import { buildServerAccessCondition, hasServerAccess } from '../utils/serverFiltering.js';

function getDispatcharrAuthMode(token?: string | null): 'token' | 'credentials' {
  return token && DispatcharrClient.isCredentialToken(token) ? 'credentials' : 'token';
}

function normalizeDispatcharrAuth(input: {
  type: string;
  token?: string;
  username?: string;
  password?: string;
}): string | undefined {
  const { type, token, username, password } = input;
  if (type !== 'dispatcharr') return token;
  return !token && username && password
    ? DispatcharrClient.encodeCredentialToken(username, password)
    : token;
}

function getFirstRow<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

async function verifyServerAccess(params: {
  type: 'plex' | 'jellyfin' | 'emby' | 'dispatcharr';
  token: string;
  url: string;
}): Promise<
  | { ok: true }
  | {
      ok: false;
      statusCode: number;
      message: string;
    }
> {
  const { type, token, url } = params;

  if (type === 'plex') {
    const adminCheck = await PlexClient.verifyServerAdmin(token, url);
    if (!adminCheck.success) {
      return {
        ok: false,
        statusCode: adminCheck.code === PlexClient.AdminVerifyError.CONNECTION_FAILED ? 503 : 403,
        message: adminCheck.message,
      };
    }
    return { ok: true };
  }

  if (type === 'jellyfin') {
    const adminCheck = await JellyfinClient.verifyServerAdmin(token, url);
    if (!adminCheck.success) {
      return {
        ok: false,
        statusCode:
          adminCheck.code === JellyfinClient.AdminVerifyError.CONNECTION_FAILED
            ? 503
            : adminCheck.code === JellyfinClient.AdminVerifyError.INVALID_KEY
              ? 400
              : 403,
        message: adminCheck.message,
      };
    }
    return { ok: true };
  }

  if (type === 'emby') {
    const adminCheck = await EmbyClient.verifyServerAdmin(token, url);
    return adminCheck.success
      ? { ok: true }
      : {
          ok: false,
          statusCode:
            adminCheck.code === EmbyClient.AdminVerifyError.CONNECTION_FAILED
              ? 503
              : adminCheck.code === EmbyClient.AdminVerifyError.INVALID_KEY
                ? 400
                : 403,
          message: adminCheck.message,
        };
  }

  const adminCheck = await DispatcharrClient.verifyServerAdmin(token, url);
  return adminCheck.success
    ? { ok: true }
    : {
        ok: false,
        statusCode: 503,
        message: adminCheck.message,
      };
}

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
        token: servers.token,
        publicUrl: servers.publicUrl,
        machineIdentifier: servers.machineIdentifier,
        ignoreAnonymousStreams: servers.ignoreAnonymousStreams,
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
          .catch((err: unknown) =>
            app.log.warn({ err, serverId: server.id }, 'Failed to backfill server color')
          );
      }
    }

    return {
      data: serverList.map((server) => ({
        ...server,
        dispatcharrAuthMode:
          server.type === 'dispatcharr' ? getDispatcharrAuthMode(server.token) : undefined,
        token: undefined,
      })),
    };
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

    const { name, type, url, token, username, password, ignoreAnonymousStreams, publicUrl } =
      body.data;
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

    // Normalize auth payload (Dispatcharr can use API key/JWT token OR username+password)
    const normalizedToken = normalizeDispatcharrAuth({ type, token, username, password });

    if (!normalizedToken) {
      return reply.badRequest('Missing authentication credentials');
    }

    // For Plex servers, find the owning plex account to set plexAccountId
    let plexAccountId: string | undefined;

    // Verify the server connection
    try {
      const accessCheck = await verifyServerAccess({ type, token: normalizedToken, url });
      if (!accessCheck.ok) {
        if (accessCheck.statusCode === 503)
          return await reply.serviceUnavailable(accessCheck.message);
        if (accessCheck.statusCode === 400) return await reply.badRequest(accessCheck.message);
        return await reply.forbidden(accessCheck.message);
      }

      if (type === 'plex') {
        // Get the Plex account ID from the token and link to user's plex_accounts
        try {
          const accountInfo = await PlexClient.getAccountInfo(normalizedToken);
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

          const matchingAccountRow = getFirstRow(matchingAccount);
          if (matchingAccountRow) {
            plexAccountId = matchingAccountRow.id;
          }
        } catch {
          // Non-fatal: server will be orphaned but auto-repair can fix it later
          app.log.debug('Could not link Plex server to account at creation time');
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
        token: normalizedToken,
        ignoreAnonymousStreams,
        publicUrl: publicUrl ?? null,
        color,
        plexAccountId, // Links Plex servers to their owning account (undefined for non-Plex)
      })
      .returning({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        token: servers.token,
        publicUrl: servers.publicUrl,
        ignoreAnonymousStreams: servers.ignoreAnonymousStreams,
        color: servers.color,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      });

    const server = inserted[0];
    if (!server) {
      return reply.internalServerError('Failed to create server');
    }

    await publishServersChanged();

    if (server.type === 'plex') {
      await rearmImportedHistoryLink({ keepProviderPass: false });
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
      .catch((error: unknown) => {
        app.log.error({ err: error, serverId: server.id }, 'Auto-sync failed for new server');
      });

    // Start realtime (SSE) connection in background
    sseManager.refresh().catch((error: unknown) => {
      app.log.error({ err: error, serverId: server.id }, 'SSE refresh failed for new server');
    });

    return reply.status(201).send({
      ...server,
      dispatcharrAuthMode:
        server.type === 'dispatcharr' ? getDispatcharrAuthMode(server.token) : undefined,
      token: undefined,
    });
  });

  /**
   * PATCH /servers/:id - Update a server's name, URL, color, public address or API key
   * At least one is required. A URL or API key change is verified against the server, and
   * refused when it reaches a different server than the one the row belongs to.
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
      token: newToken,
      username: newUsername,
      password: newPassword,
      ignoreAnonymousStreams: newIgnoreAnonymousStreams,
      color: newColor,
      publicUrl: newPublicUrl,
      apiKey: newApiKey,
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

    const authChanged =
      newToken !== undefined || newUsername !== undefined || newPassword !== undefined;
    if (authChanged && server.type !== 'dispatcharr') {
      return reply.badRequest('Authentication updates are only supported for Dispatcharr servers');
    }
    const effectiveUrl = newUrl ?? server.url;
    const normalizedToken =
      authChanged && server.type === 'dispatcharr'
        ? normalizeDispatcharrAuth({
            type: server.type,
            token: newToken,
            username: newUsername,
            password: newPassword,
          })
        : (newApiKey ?? server.token);

    if (authChanged && !normalizedToken) {
      return reply.badRequest('Dispatcharr update requires a complete token or username+password');
    }
    const verifiedToken = normalizedToken ?? undefined;
    if (server.type === 'dispatcharr' && newApiKey !== undefined) {
      return reply.badRequest(
        'Dispatcharr authentication uses token or username+password, not apiKey'
      );
    }

    if (server.type === 'plex' && newPublicUrl !== undefined) {
      return reply.badRequest(PUBLIC_URL_PLEX_MESSAGE);
    }

    if (server.type === 'plex' && newApiKey !== undefined) {
      return reply.badRequest('Plex servers sign in through plex.tv and have no API key to change');
    }

    const same = <T>(next: T | undefined, current: T): boolean =>
      next === undefined || next === current;
    if (
      !authChanged &&
      same(newName, server.name) &&
      same(newUrl, server.url) &&
      same(newColor, server.color) &&
      same(newPublicUrl, server.publicUrl) &&
      same(newIgnoreAnonymousStreams, server.ignoreAnonymousStreams) &&
      same(newApiKey, server.token)
    ) {
      return {
        id: server.id,
        name: server.name,
        type: server.type,
        url: server.url,
        publicUrl: server.publicUrl,
        color: server.color,
        dispatcharrAuthMode:
          server.type === 'dispatcharr' ? getDispatcharrAuthMode(server.token) : undefined,
        ignoreAnonymousStreams: server.ignoreAnonymousStreams,
        createdAt: server.createdAt,
        updatedAt: server.updatedAt,
      };
    }

    const urlChanging = newUrl !== undefined && server.url !== newUrl;
    const keyChanging = newApiKey !== undefined && server.token !== newApiKey;
    let backfilledIdentity: string | undefined;

    if (urlChanging || keyChanging || authChanged) {
      if (
        server.type === 'plex' &&
        clientIdentifier &&
        server.machineIdentifier &&
        server.machineIdentifier !== clientIdentifier
      ) {
        return reply.badRequest(
          'Server mismatch: The selected connection belongs to a different server. ' +
            'Please select a connection for the correct server.'
        );
      }
      try {
        const accessCheck = await verifyServerAccess({
          type: server.type,
          token: verifiedToken as string,
          url: effectiveUrl,
        });
        if (!accessCheck.ok) {
          if (accessCheck.statusCode === 503)
            return await reply.serviceUnavailable(accessCheck.message);
          if (accessCheck.statusCode === 400) return await reply.badRequest(accessCheck.message);
          return await reply.forbidden(accessCheck.message);
        }
      } catch (error) {
        app.log.error(
          { err: error, serverId: id, newUrl: effectiveUrl },
          'Failed to verify updated server configuration'
        );
        return reply.badRequest(
          'Failed to connect to server with updated configuration. Please verify the settings.'
        );
      }

      // Dispatcharr does not expose a stable server identity; retain its verified auth flow.
      if (server.type !== 'dispatcharr') {
        const expectedIdentity =
          server.machineIdentifier ?? (await readServerIdentity(server).catch(() => null));
        if (!expectedIdentity) {
          return reply.badRequest(
            'Tracearr has no record of which server this is and cannot reach it with the saved address and key, so it cannot confirm the change points at the same server.'
          );
        }

        const reachedIdentity = await readServerIdentity({
          id,
          type: server.type,
          url: effectiveUrl,
          token: verifiedToken as string,
        }).catch((error: unknown) => {
          app.log.error(
            { err: error, serverId: id, url: effectiveUrl },
            'Failed to read server identity'
          );
          return null;
        });
        if (reachedIdentity === null) {
          return reply.badRequest('Could not read which server answers at that address.');
        }
        if (reachedIdentity !== expectedIdentity) {
          return reply.badRequest(
            'That address or API key reaches a different server. A server can only be pointed at itself.'
          );
        }
        if (!server.machineIdentifier) backfilledIdentity = expectedIdentity;
      }
    }

    // Build update object
    const updatePayload: {
      name?: string;
      url?: string;
      token?: string;
      ignoreAnonymousStreams?: boolean;
      color?: string | null;
      publicUrl?: string | null;
      machineIdentifier?: string;
      updatedAt: Date;
    } = { updatedAt: new Date() };
    if (backfilledIdentity !== undefined) updatePayload.machineIdentifier = backfilledIdentity;
    if (newName !== undefined) updatePayload.name = newName;
    if (newUrl !== undefined) updatePayload.url = newUrl;
    if (authChanged) updatePayload.token = normalizedToken;
    if (newIgnoreAnonymousStreams !== undefined) {
      updatePayload.ignoreAnonymousStreams = newIgnoreAnonymousStreams;
    }
    if (newColor !== undefined) updatePayload.color = newColor;
    if (newPublicUrl !== undefined) updatePayload.publicUrl = newPublicUrl;
    if (newApiKey !== undefined) updatePayload.token = newApiKey;

    const updated = await db
      .update(servers)
      .set(updatePayload)
      .where(eq(servers.id, id))
      .returning({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        token: servers.token,
        publicUrl: servers.publicUrl,
        ignoreAnonymousStreams: servers.ignoreAnonymousStreams,
        color: servers.color,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      });

    const result = updated[0];
    if (!result) {
      return reply.internalServerError('Failed to update server');
    }

    const connectorConfigChanged =
      (newName !== undefined && newName !== server.name) ||
      (newUrl !== undefined && newUrl !== server.url) ||
      authChanged ||
      keyChanging ||
      (newIgnoreAnonymousStreams !== undefined &&
        newIgnoreAnonymousStreams !== server.ignoreAnonymousStreams);
    await publishServersChanged();

    if (connectorConfigChanged) {
      if (newUrl !== undefined) {
        app.log.info({ serverId: id, oldUrl: server.url, newUrl }, 'Server URL updated');
      }
      if (authChanged || keyChanging) {
        app.log.info({ serverId: id }, 'Server authentication updated');
      }
      // The leader compares connector-owned fields with the database row and
      // replaces stale connections. Followers safely no-op here and converge
      // on the leader's next reconciliation tick.
      sseManager.refresh().catch((error: unknown) => {
        app.log.error(
          { err: error, serverId: id },
          'SSE refresh failed after server configuration update'
        );
      });
    }
    if (newName !== undefined) {
      app.log.info({ serverId: id, oldName: server.name, newName }, 'Server name updated');
    }

    return {
      ...result,
      dispatcharrAuthMode:
        result.type === 'dispatcharr' ? getDispatcharrAuthMode(result.token) : undefined,
      token: undefined,
    };
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
    const serverRow = serverRows[0]!;

    try {
      const result = await syncServer(id, { syncUsers: true, syncLibraries: true });

      // Update server's updatedAt timestamp
      await db.update(servers).set({ updatedAt: new Date() }).where(eq(servers.id, id));

      // Also trigger full library sync (items/episodes) in background
      let librarySyncJobId: string | null = null;
      try {
        if (!supportsMediaLibrary(serverRow.type)) {
          return {
            success: result.errors.length === 0,
            usersAdded: result.usersAdded,
            usersUpdated: result.usersUpdated,
            usersRemoved: result.usersRemoved,
            usersRestored: result.usersRestored,
            librariesSynced: 0,
            librarySyncJobId: null,
            errors: result.errors,
            syncedAt: new Date().toISOString(),
          };
        }
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
   * Plex only (undocumented /statistics/resources endpoint). /live-stats covers every server type.
   */
  app.get('/:id/statistics', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = serverIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid server ID');
    }

    const { id } = params.data;

    if (!hasServerAccess(request.user, id)) {
      return reply.forbidden('You do not have access to this server');
    }

    // Get server with token
    const serverRows = await db.select().from(servers).where(eq(servers.id, id)).limit(1);

    const server = serverRows[0];
    if (!server) {
      return reply.notFound('Server not found');
    }

    // Reads Plex's own statistics endpoint; Jellyfin and Emby are served by /live-stats
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

    if (!hasServerAccess(request.user, id)) {
      return reply.forbidden('You do not have access to this server');
    }

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
