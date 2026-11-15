/**
 * Server management routes - CRUD for Plex/Jellyfin/Emby/tofa servers
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { APIError } from 'better-auth/api';
import { eq, inArray, and, isNull } from 'drizzle-orm';
import {
  createServerSchema,
  serverIdParamSchema,
  reorderServersSchema,
  updateServerSchema,
  pickServerColor,
  setServerHistoricalSchema,
  PUBLIC_URL_PLEX_MESSAGE,
  SERVER_PROFILES,
  assertNever,
  type ServerConnectionStatus,
  type ServerDownReason,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, plexAccounts, serverUsers, users } from '../db/schema.js';
import {
  assertOwnerKeepsALoginAfter,
  nonOwnerMayLoginThrough,
  type ServerAccountChange,
} from '../lib/authGuards.js';
import { revokeUnlessStillIn } from '../lib/revoke.js';
import {
  PlexClient,
  JellyfinClient,
  TofaClient,
  verifyServerAdmin,
} from '../services/mediaServer/index.js';
import { readServerFacts } from '../services/mediaServer/byServerType.js';
import { getServerLiveStats, getServerResourceStats } from '../services/serverLiveStats.js';
import { createServer, startAddedServer } from '../services/serverCreate.js';
import { deleteServer } from '../services/serverDelete.js';
import { syncServer } from '../services/sync.js';
import { sseManager } from '../services/sseManager.js';
import { getCacheService } from '../services/cache.js';
import { markServerHistorical, resumeServer } from '../services/historicalServers.js';
import { liveServerCondition, HISTORICAL_EDIT_MESSAGE } from '../services/liveServers.js';
import { enqueueLibrarySync } from '../jobs/librarySyncQueue.js';
import { installedVersionOf } from '../jobs/serverUpdateChecker.js';
import { publishServersChanged } from '../jobs/poller/database.js';
import { followServerOnBuiltInRequestService } from '../services/requests/store.js';
import { readServerIdentity, sharesKnownUsers } from '../services/serverIdentity.js';
import { getSetting } from '../services/settings.js';
import { buildServerAccessCondition, hasServerAccess } from '../utils/serverFiltering.js';
import { serverOrderBy } from '../utils/serverOrder.js';

async function ownerLockout(change: ServerAccountChange): Promise<string | null> {
  try {
    await assertOwnerKeepsALoginAfter(change);
    return null;
  } catch (err) {
    if (err instanceof APIError) return err.message;
    throw err;
  }
}

// Plex never reports INVALID_KEY, so one mapping serves all three server types.
function replyAdminCheckFailure(reply: FastifyReply, check: { code: string; message: string }) {
  if (check.code === JellyfinClient.AdminVerifyError.CONNECTION_FAILED) {
    return reply.serviceUnavailable(check.message);
  }
  if (check.code === JellyfinClient.AdminVerifyError.INVALID_KEY) {
    return reply.badRequest(check.message);
  }
  return reply.forbidden(check.message);
}

export const serverRoutes: FastifyPluginAsync = async (app) => {
  const readServers = { preHandler: [app.requirePermission('servers', 'read')] };
  const readMedia = { preHandler: [app.requirePermission('media', 'read')] };
  const writeServers = { preHandler: [app.requirePermission('servers', 'write')] };
  /**
   * GET /servers - List connected servers
   * Returns all servers (without tokens) for the authenticated user
   */
  app.get('/', readMedia, async (request) => {
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
        historicalAt: servers.historicalAt,
        allowMemberLogin: servers.allowMemberLogin,
        canStopStreams: servers.canStopStreams,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      })
      .from(servers)
      .where(buildServerAccessCondition(authUser, servers.id))
      .orderBy(...serverOrderBy());

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

    if (request.scope !== 'all') {
      // A member's server selector needs to name and color their servers, nothing about how
      // Tracearr reaches them.
      return {
        data: serverList.map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          publicUrl: s.publicUrl,
          machineIdentifier: s.machineIdentifier,
          displayOrder: s.displayOrder,
          color: s.color,
          historicalAt: s.historicalAt,
        })),
      };
    }

    return { data: serverList };
  });

  /**
   * POST /servers - Add a new server
   * Encrypts the token before storage
   */
  app.post('/', writeServers, async (request, reply) => {
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

    let adminCheck: Awaited<ReturnType<typeof verifyServerAdmin>>;
    try {
      adminCheck = await verifyServerAdmin(type, token, url);
    } catch (error) {
      app.log.error({ err: error }, 'Failed to verify server connection');
      return reply.badRequest('Failed to connect to server. Please verify URL and token.');
    }
    if (!adminCheck.success) return replyAdminCheckFailure(reply, adminCheck);

    let serverFacts: Awaited<ReturnType<typeof readServerFacts>>;
    try {
      serverFacts = await readServerFacts(type, url, token);
    } catch (error) {
      app.log.error({ err: error }, 'Failed to read server settings');
      return reply.badRequest('Could not read the API key scopes from the server.');
    }

    // For Plex servers, find the owning plex account to set plexAccountId
    let plexAccountId: string | undefined;
    let machineIdentifier: string | null = null;
    switch (type) {
      case 'plex':
        try {
          const accountInfo = await PlexClient.getAccountInfo(token);
          const [matchingAccount] = await db
            .select({ id: plexAccounts.id })
            .from(plexAccounts)
            .where(
              and(
                eq(plexAccounts.userId, authUser.userId),
                eq(plexAccounts.plexAccountId, accountInfo.id)
              )
            )
            .limit(1);
          plexAccountId = matchingAccount?.id;
        } catch {
          // Non-fatal: server will be orphaned but auto-repair can fix it later
          app.log.debug('Could not link Plex server to account at creation time');
        }
        break;
      case 'tofa':
        // Stored now, so tofa cloud's Add server already knows the server is connected.
        try {
          machineIdentifier = await new TofaClient({ url, token }).getServerIdentity();
        } catch {
          app.log.debug('Could not read the tofa server identity at creation time');
        }
        // tofa cloud may have connected the same server at another address
        if (machineIdentifier) {
          const [connected] = await db
            .select({ id: servers.id })
            .from(servers)
            .where(and(eq(servers.type, type), eq(servers.machineIdentifier, machineIdentifier)))
            .limit(1);
          if (connected) return reply.conflict('This server is already connected');
        }
        break;
      case 'jellyfin':
      case 'emby':
        break;
      default:
        assertNever(type);
    }

    const { server, requestServiceIds } = await createServer({
      name,
      type,
      url,
      token,
      publicUrl,
      plexAccountId,
      machineIdentifier,
      facts: serverFacts,
    });
    await startAddedServer(server, requestServiceIds);

    return reply.status(201).send(server);
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
  app.patch('/:id', writeServers, async (request, reply) => {
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
      apiKey: newApiKey,
      allowMemberLogin: newAllowMemberLogin,
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

    switch (server.type) {
      case 'plex':
        if (newPublicUrl !== undefined) {
          return reply.badRequest(PUBLIC_URL_PLEX_MESSAGE);
        }
        if (newApiKey !== undefined) {
          return reply.badRequest(
            'Plex servers sign in through plex.tv and have no API key to change'
          );
        }
        break;
      case 'jellyfin':
      case 'emby':
      case 'tofa':
        break;
      default:
        assertNever(server.type);
    }

    const profile = SERVER_PROFILES[server.type];
    if (newAllowMemberLogin === true && profile.memberSignIn === 'unavailable') {
      return reply.badRequest(
        `${profile.displayName} has no sign-in Tracearr can call, so members cannot sign in through it`
      );
    }

    const same = <T>(next: T | undefined, current: T): boolean =>
      next === undefined || next === current;
    if (
      same(newName, server.name) &&
      same(newUrl, server.url) &&
      same(newColor, server.color) &&
      same(newPublicUrl, server.publicUrl) &&
      same(newApiKey, server.token) &&
      same(newAllowMemberLogin, server.allowMemberLogin) &&
      // Off again is how a revoke that failed gets retried.
      newAllowMemberLogin !== false
    ) {
      return {
        id: server.id,
        name: server.name,
        type: server.type,
        url: server.url,
        publicUrl: server.publicUrl,
        color: server.color,
        historicalAt: server.historicalAt,
        allowMemberLogin: server.allowMemberLogin,
        canStopStreams: server.canStopStreams,
        createdAt: server.createdAt,
        updatedAt: server.updatedAt,
      };
    }

    const urlChanging = newUrl !== undefined && server.url !== newUrl;
    const keyChanging = newApiKey !== undefined && server.token !== newApiKey;
    if (server.historicalAt && (urlChanging || keyChanging)) {
      return reply.conflict(HISTORICAL_EDIT_MESSAGE);
    }
    const targetUrl = newUrl ?? server.url;
    const token = newApiKey ?? server.token;

    let backfilledIdentity: string | undefined;
    let serverFacts: Awaited<ReturnType<typeof readServerFacts>> = {};

    if (urlChanging || keyChanging) {
      // For Plex servers: Validate machineIdentifier if provided
      switch (server.type) {
        case 'plex':
          if (
            clientIdentifier &&
            server.machineIdentifier &&
            server.machineIdentifier !== clientIdentifier
          ) {
            return reply.badRequest(
              'Server mismatch: The selected connection belongs to a different server. ' +
                'Please select a connection for the correct server.'
            );
          }
          break;
        case 'jellyfin':
        case 'emby':
        case 'tofa':
          break;
        default:
          assertNever(server.type);
      }

      let adminCheck: Awaited<ReturnType<typeof verifyServerAdmin>>;
      try {
        adminCheck = await verifyServerAdmin(server.type, token, targetUrl);
      } catch (error) {
        app.log.error({ err: error, serverId: id, url: targetUrl }, 'Failed to verify server');
        return reply.badRequest(
          'Failed to connect to the server. Please verify the URL and API key are correct.'
        );
      }
      if (!adminCheck.success) return replyAdminCheckFailure(reply, adminCheck);

      const target = { id, type: server.type, url: targetUrl, token };
      const expectedIdentity =
        server.machineIdentifier ?? (await readServerIdentity(server).catch(() => null));

      const reachedIdentity = await readServerIdentity(target).catch((error: unknown) => {
        app.log.error(
          { err: error, serverId: id, url: targetUrl },
          'Failed to read server identity'
        );
        return null;
      });
      if (reachedIdentity === null) {
        return reply.badRequest('Could not read which server answers at that address.');
      }

      if (expectedIdentity) {
        if (reachedIdentity !== expectedIdentity) {
          return reply.badRequest(
            'That address or API key reaches a different server. A server can only be pointed at itself.'
          );
        }
      } else {
        const sameUsers = await sharesKnownUsers(target).catch((error: unknown) => {
          app.log.error({ err: error, serverId: id, url: targetUrl }, 'Failed to compare users');
          return false;
        });
        if (!sameUsers) {
          return reply.badRequest(
            'Tracearr has no record of which server this is, cannot reach it with the saved address and key, and finds none of its users at the new address, so it cannot confirm the change points at the same server.'
          );
        }
      }
      if (!server.machineIdentifier) backfilledIdentity = reachedIdentity;

      try {
        serverFacts = await readServerFacts(server.type, targetUrl, token);
      } catch (error) {
        app.log.error(
          { err: error, serverId: id, url: targetUrl },
          'Failed to read server settings'
        );
        return reply.badRequest('Could not read the API key scopes from the server.');
      }
    }

    const updatePayload: {
      name?: string;
      url?: string;
      color?: string | null;
      publicUrl?: string | null;
      token?: string;
      machineIdentifier?: string;
      allowMemberLogin?: boolean;
      canStopStreams?: boolean;
      watchedRulePercent?: number | null;
      updatedAt: Date;
    } = { ...serverFacts, updatedAt: new Date() };
    if (backfilledIdentity !== undefined) updatePayload.machineIdentifier = backfilledIdentity;
    if (newName !== undefined) updatePayload.name = newName;
    if (newUrl !== undefined) updatePayload.url = newUrl;
    if (newColor !== undefined) updatePayload.color = newColor;
    if (newPublicUrl !== undefined) updatePayload.publicUrl = newPublicUrl;
    if (newApiKey !== undefined) updatePayload.token = newApiKey;
    if (newAllowMemberLogin !== undefined) updatePayload.allowMemberLogin = newAllowMemberLogin;

    const updated = await db.transaction(async (tx) => {
      const rows = await tx.update(servers).set(updatePayload).where(eq(servers.id, id)).returning({
        id: servers.id,
        name: servers.name,
        type: servers.type,
        url: servers.url,
        publicUrl: servers.publicUrl,
        color: servers.color,
        historicalAt: servers.historicalAt,
        allowMemberLogin: servers.allowMemberLogin,
        canStopStreams: servers.canStopStreams,
        createdAt: servers.createdAt,
        updatedAt: servers.updatedAt,
      });
      if (
        SERVER_PROFILES[server.type].builtInRequests !== null &&
        (newName !== undefined || newUrl !== undefined)
      ) {
        await followServerOnBuiltInRequestService(tx, id);
      }
      return rows;
    });

    const result = updated[0];
    if (!result) {
      return reply.internalServerError('Failed to update server');
    }

    if (newAllowMemberLogin === false) {
      const [accounts, { member }] = await Promise.all([
        db
          .select({ userId: serverUsers.userId, role: users.role, loginAccess: users.loginAccess })
          .from(serverUsers)
          .innerJoin(users, eq(users.id, serverUsers.userId))
          .where(
            and(
              eq(serverUsers.serverId, id),
              isNull(serverUsers.removedAt),
              eq(serverUsers.isDisabled, false)
            )
          ),
        getSetting('loginMethods'),
      ]);
      // Anyone the rule still lets in, through this server or another way, keeps their session.
      await revokeUnlessStillIn(
        accounts
          .filter((account) => !nonOwnerMayLoginThrough(account, member, false))
          .map((account) => account.userId)
      );
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
    if (keyChanging) {
      app.log.info({ serverId: id }, 'Server API key updated');
      if (newUrl === undefined) {
        sseManager.refresh().catch((error: unknown) => {
          app.log.error({ err: error, serverId: id }, 'SSE refresh failed after API key update');
        });
      }
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
  app.patch('/reorder', writeServers, async (request, reply) => {
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
  app.delete('/:id', writeServers, async (request, reply) => {
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

    const lockout = await ownerLockout({ kind: 'deleteServer', serverId: id });
    if (lockout) return reply.badRequest(lockout);

    await deleteServer(id);
    return { success: true };
  });

  /**
   * POST /servers/:id/sync - Force sync users and libraries from server
   * For Plex: Fetches users from Plex.tv including shared users
   * For Jellyfin: Fetches users from the server
   */
  app.post('/:id/sync', writeServers, async (request, reply) => {
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

    const serverRows = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
    const server = serverRows[0];
    if (!server) {
      return reply.notFound('Server not found');
    }
    if (server.historicalAt) {
      return reply.conflict('Resume this server to sync it');
    }

    try {
      const result = await syncServer(id, { syncUsers: true, syncLibraries: true });

      const version = await installedVersionOf(server);
      await db
        .update(servers)
        .set({ updatedAt: new Date(), ...(version ? { version } : {}) })
        .where(eq(servers.id, id));

      // Also trigger full library sync (items/episodes) in background
      let librarySyncJobId: string | null = null;
      try {
        librarySyncJobId = await enqueueLibrarySync(id, 'manual', { userId: authUser.userId });
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
   * POST /servers/:id/historical - Stop contacting a server (historical: true) or resume it.
   * Marking force-stops its streams; history, users and libraries stay.
   */
  app.post('/:id/historical', writeServers, async (request, reply) => {
    const params = serverIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid server ID');
    }

    const body = setServerHistoricalSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest(body.error.issues[0]?.message ?? 'Invalid request body');
    }

    if (request.user.role !== 'owner') {
      return reply.forbidden('Only server owners can change whether a server is historical');
    }

    const [server] = await db.select().from(servers).where(eq(servers.id, params.data.id)).limit(1);
    if (!server) {
      return reply.notFound('Server not found');
    }

    if (body.data.historical) {
      const lockout = await ownerLockout({ kind: 'retireServer', serverId: server.id });
      if (lockout) return reply.badRequest(lockout);
    }

    const updated = body.data.historical
      ? await markServerHistorical(server)
      : await resumeServer(server);

    return {
      id: updated.id,
      name: updated.name,
      type: updated.type,
      url: updated.url,
      publicUrl: updated.publicUrl,
      machineIdentifier: updated.machineIdentifier,
      displayOrder: updated.displayOrder,
      color: updated.color,
      version: updated.version,
      latestVersion: updated.latestVersion,
      historicalAt: updated.historicalAt,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  });

  /**
   * GET /servers/:id/statistics - Get server resource statistics (CPU, RAM)
   * On-demand endpoint for dashboard - data is not stored
   * Plex only (undocumented /statistics/resources endpoint). /live-stats covers every server type.
   */
  app.get('/:id/statistics', readServers, async (request, reply) => {
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
    if (SERVER_PROFILES[server.type].hostStats !== 'plexStatistics') {
      return reply.badRequest('Server statistics are only available for Plex servers');
    }

    if (server.historicalAt) {
      return { serverId: id, data: [], fetchedAt: new Date().toISOString() };
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
  app.get('/:id/live-stats', readServers, async (request, reply) => {
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

    if (server.historicalAt) {
      return {
        serverId: id,
        statistics: [],
        bandwidth: [],
        bandwidthSamples: [],
        bandwidthAccounts: [],
        bandwidthDevices: [],
        fetchedAt: new Date().toISOString(),
      };
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
  app.get('/health', readServers, async (request) => {
    const authUser = request.user;

    // Get all servers the user has access to
    const serverList = await db
      .select({
        id: servers.id,
        name: servers.name,
      })
      .from(servers)
      .where(and(buildServerAccessCondition(authUser, servers.id), liveServerCondition))
      .orderBy(...serverOrderBy());

    const cacheService = getCacheService();
    const unhealthyServers: { serverId: string; serverName: string; reason?: ServerDownReason }[] =
      [];

    if (cacheService) {
      for (const server of serverList) {
        const isHealthy = await cacheService.getServerHealth(server.id);
        // null means unknown (not yet checked), true means healthy
        // Only include servers explicitly marked as unhealthy (false)
        if (isHealthy === false) {
          const reason = await cacheService.getServerDownReason(server.id);
          unhealthyServers.push({
            serverId: server.id,
            serverName: server.name,
            ...(reason && { reason }),
          });
        }
      }
    }

    return { data: unhealthyServers };
  });

  /**
   * GET /servers/connection-status - Live SSE plugin connection state per server
   *
   * Returns per-server realtime/polling mode. Status is ephemeral runtime truth
   * mirrored in Redis with a TTL, not persisted to the database. Servers with
   * no cached status are reported as polling (safe default).
   */
  app.get('/connection-status', readServers, async (request) => {
    const authUser = request.user;

    const serverList = await db
      .select({
        id: servers.id,
        name: servers.name,
        type: servers.type,
      })
      .from(servers)
      .where(and(buildServerAccessCondition(authUser, servers.id), liveServerCondition));

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

      // No cached status yet, so default to polling (safe)
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
