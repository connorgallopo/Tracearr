/**
 * Plex Authentication Routes
 *
 * POST /plex/check-pin - Check Plex PIN status
 * POST /plex/connect - Complete Plex signup and connect a server
 * GET /plex/available-servers - Discover available Plex servers for adding
 * POST /plex/add-server - Add an additional Plex server
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import type {
  PlexAvailableServersResponse,
  PlexDiscoveredServer,
  PlexDiscoveredConnection,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers, users, serverUsers } from '../../db/schema.js';
import { PlexClient } from '../../services/mediaServer/index.js';
// Token encryption removed - tokens now stored in plain text (DB is localhost-only)
import { plexHeaders } from '../../utils/http.js';
import {
  generateTokens,
  generateTempToken,
  PLEX_TEMP_TOKEN_PREFIX,
  PLEX_TEMP_TOKEN_TTL,
} from './utils.js';
import { syncServer } from '../../services/sync.js';
import { getUserByPlexAccountId, getOwnerUser, getUserById } from '../../services/userService.js';

// Schemas
const plexCheckPinSchema = z.object({
  pinId: z.string(),
});

const plexConnectSchema = z.object({
  tempToken: z.string(),
  serverUri: z.url(),
  serverName: z.string().min(1).max(100),
  clientIdentifier: z.string().optional(), // For storing machineIdentifier
});

const plexAddServerSchema = z.object({
  serverUri: z.url(),
  serverName: z.string().min(1).max(100),
  clientIdentifier: z.string().min(1), // Required for dedup
});

// Connection testing timeout in milliseconds
const CONNECTION_TEST_TIMEOUT = 3000;

export const plexRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /plex/check-pin - Check Plex PIN status
   *
   * Returns:
   * - { authorized: false } if PIN not yet claimed
   * - { authorized: true, accessToken, refreshToken, user } if user found by plexAccountId
   * - { authorized: true, needsServerSelection: true, servers, tempToken } if new Plex user
   */
  app.post('/plex/check-pin', async (request, reply) => {
    const body = plexCheckPinSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('pinId is required');
    }

    const { pinId } = body.data;

    try {
      const authResult = await PlexClient.checkOAuthPin(pinId);

      if (!authResult) {
        return { authorized: false, message: 'PIN not yet authorized' };
      }

      // Check if user exists by Plex account ID (global Plex.tv ID)
      let existingUser = await getUserByPlexAccountId(authResult.id);

      // Fallback: Check by externalId in server_users (server-synced users may have Plex ID there)
      if (!existingUser) {
        const fallbackServerUsers = await db
          .select({ userId: serverUsers.userId })
          .from(serverUsers)
          .where(eq(serverUsers.externalId, authResult.id))
          .limit(1);
        if (fallbackServerUsers[0]) {
          existingUser = await getUserById(fallbackServerUsers[0].userId);
        }
      }

      if (existingUser) {
        // Returning Plex user - update their info and link plex_account_id
        const user = existingUser;

        await db
          .update(users)
          .set({
            username: authResult.username,
            email: authResult.email,
            thumbnail: authResult.thumb,
            plexAccountId: authResult.id, // Link the Plex account ID
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));

        app.log.info({ userId: user.id }, 'Returning Plex user login');

        return {
          authorized: true,
          ...(await generateTokens(app, user.id, authResult.username, user.role)),
        };
      }

      // New Plex user - check if they own any servers
      const plexServers = await PlexClient.getServers(authResult.token);

      // Check if this is the first owner
      const owner = await getOwnerUser();
      const isFirstUser = !owner;

      // Store temp token for completing registration
      const tempToken = generateTempToken();
      await app.redis.setex(
        `${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`,
        PLEX_TEMP_TOKEN_TTL,
        JSON.stringify({
          plexAccountId: authResult.id,
          plexUsername: authResult.username,
          plexEmail: authResult.email,
          plexThumb: authResult.thumb,
          plexToken: authResult.token,
          isFirstUser,
        })
      );

      // If they have servers, let them select one to connect
      if (plexServers.length > 0) {
        const formattedServers = plexServers.map((s) => ({
          name: s.name,
          platform: s.platform,
          version: s.productVersion,
          clientIdentifier: s.clientIdentifier, // For storing machineIdentifier
          publicAddressMatches: s.publicAddressMatches, // Used to indicate if local connections were filtered
          httpsRequired: s.httpsRequired, // True if server requires HTTPS (HTTP connections rejected)
          connections: s.connections.map((c) => ({
            uri: c.uri,
            local: c.local,
            address: c.address,
            port: c.port,
          })),
        }));

        return {
          authorized: true,
          needsServerSelection: true,
          servers: formattedServers,
          tempToken,
        };
      }

      // No servers - create account without server connection
      // First user becomes owner, subsequent users are viewers
      const role = isFirstUser ? 'owner' : 'viewer';

      const [newUser] = await db
        .insert(users)
        .values({
          username: authResult.username,
          email: authResult.email,
          thumbnail: authResult.thumb,
          plexAccountId: authResult.id,
          role,
        })
        .returning();

      if (!newUser) {
        return reply.internalServerError('Failed to create user');
      }

      // Clean up temp token
      await app.redis.del(`${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`);

      app.log.info({ userId: newUser.id, role }, 'New Plex user created (no servers)');

      return {
        authorized: true,
        ...(await generateTokens(app, newUser.id, newUser.username, newUser.role)),
      };
    } catch (error) {
      app.log.error({ error }, 'Plex check-pin failed');
      return reply.internalServerError('Failed to check Plex authorization');
    }
  });

  /**
   * POST /plex/connect - Complete Plex signup and connect a server
   */
  app.post('/plex/connect', async (request, reply) => {
    const body = plexConnectSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('tempToken, serverUri, and serverName are required');
    }

    const { tempToken, serverUri, serverName, clientIdentifier } = body.data;

    // Get stored Plex auth from temp token
    const stored = await app.redis.get(`${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`);
    if (!stored) {
      return reply.unauthorized('Invalid or expired temp token. Please restart login.');
    }

    // Delete temp token (one-time use)
    await app.redis.del(`${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`);

    const { plexAccountId, plexUsername, plexEmail, plexThumb, plexToken, isFirstUser } =
      JSON.parse(stored) as {
        plexAccountId: string;
        plexUsername: string;
        plexEmail: string;
        plexThumb: string;
        plexToken: string;
        isFirstUser: boolean;
      };

    try {
      // Verify user is admin on the selected server
      const adminCheck = await PlexClient.verifyServerAdmin(plexToken, serverUri);
      if (!adminCheck.success) {
        // Provide specific error based on failure type
        if (adminCheck.code === PlexClient.AdminVerifyError.CONNECTION_FAILED) {
          return reply.serviceUnavailable(adminCheck.message);
        }
        return reply.forbidden(adminCheck.message);
      }

      // Create or update server
      let server = await db
        .select()
        .from(servers)
        .where(and(eq(servers.url, serverUri), eq(servers.type, 'plex')))
        .limit(1);

      if (server.length === 0) {
        const inserted = await db
          .insert(servers)
          .values({
            name: serverName,
            type: 'plex',
            url: serverUri,
            token: plexToken,
            machineIdentifier: clientIdentifier,
          })
          .returning();
        server = inserted;
      } else {
        const existingServer = server[0]!;
        await db
          .update(servers)
          .set({
            token: plexToken,
            updatedAt: new Date(),
            // Update machineIdentifier if not already set
            ...(clientIdentifier && !existingServer.machineIdentifier
              ? { machineIdentifier: clientIdentifier }
              : {}),
          })
          .where(eq(servers.id, existingServer.id));
      }

      const serverId = server[0]!.id;

      // Create user identity (no serverId on users table)
      // First user becomes owner, subsequent users are viewers
      const role = isFirstUser ? 'owner' : 'viewer';

      const [newUser] = await db
        .insert(users)
        .values({
          username: plexUsername,
          email: plexEmail,
          thumbnail: plexThumb,
          plexAccountId: plexAccountId,
          role,
        })
        .returning();

      if (!newUser) {
        return reply.internalServerError('Failed to create user');
      }

      // Create server_user linking the identity to this server
      await db.insert(serverUsers).values({
        userId: newUser.id,
        serverId,
        externalId: plexAccountId,
        username: plexUsername,
        email: plexEmail,
        thumbUrl: plexThumb,
        isServerAdmin: true, // They verified as admin
      });

      app.log.info({ userId: newUser.id, serverId, role }, 'New Plex user with server created');

      // Auto-sync server users and libraries in background
      syncServer(serverId, { syncUsers: true, syncLibraries: true })
        .then((result) => {
          app.log.info(
            { serverId, usersAdded: result.usersAdded, librariesSynced: result.librariesSynced },
            'Auto-sync completed for Plex server'
          );
        })
        .catch((error) => {
          app.log.error({ error, serverId }, 'Auto-sync failed for Plex server');
        });

      return generateTokens(app, newUser.id, newUser.username, newUser.role);
    } catch (error) {
      app.log.error({ error }, 'Plex connect failed');
      return reply.internalServerError('Failed to connect to Plex server');
    }
  });

  /**
   * GET /plex/available-servers - Discover available Plex servers for adding
   *
   * Requires authentication and owner role.
   * Returns list of user's owned Plex servers that aren't already connected,
   * with connection testing results.
   */
  app.get(
    '/plex/available-servers',
    { preHandler: [app.authenticate] },
    async (request, reply): Promise<PlexAvailableServersResponse> => {
      const authUser = request.user;

      // Only owners can add servers
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can add servers');
      }

      // Get existing Plex servers to find a token
      const existingPlexServers = await db
        .select({
          id: servers.id,
          token: servers.token,
          machineIdentifier: servers.machineIdentifier,
        })
        .from(servers)
        .where(eq(servers.type, 'plex'));

      if (existingPlexServers.length === 0) {
        // No Plex servers connected - user needs to link their Plex account
        return { servers: [], hasPlexToken: false };
      }

      // Use the first server's token to query plex.tv
      const plexToken = existingPlexServers[0]!.token;

      // Get all servers the user owns from plex.tv
      let allServers;
      try {
        allServers = await PlexClient.getServers(plexToken);
      } catch (error) {
        app.log.error({ error }, 'Failed to fetch servers from plex.tv');
        return reply.internalServerError('Failed to fetch servers from Plex');
      }

      // Get list of already-connected machine identifiers
      const connectedMachineIds = new Set(
        existingPlexServers
          .map((s) => s.machineIdentifier)
          .filter((id): id is string => id !== null)
      );

      // Filter out already-connected servers
      const availableServers = allServers.filter(
        (s) => !connectedMachineIds.has(s.clientIdentifier)
      );

      if (availableServers.length === 0) {
        return { servers: [], hasPlexToken: true };
      }

      // Test connections for each server in parallel
      const testedServers: PlexDiscoveredServer[] = await Promise.all(
        availableServers.map(async (server) => {
          // Test all connections in parallel
          const connectionResults = await Promise.all(
            server.connections.map(async (conn): Promise<PlexDiscoveredConnection> => {
              const start = Date.now();
              try {
                const response = await fetch(`${conn.uri}/`, {
                  headers: plexHeaders(plexToken),
                  signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT),
                });
                if (response.ok) {
                  return {
                    uri: conn.uri,
                    local: conn.local,
                    address: conn.address,
                    port: conn.port,
                    reachable: true,
                    latencyMs: Date.now() - start,
                  };
                }
              } catch {
                // Connection failed or timed out
              }
              return {
                uri: conn.uri,
                local: conn.local,
                address: conn.address,
                port: conn.port,
                reachable: false,
                latencyMs: null,
              };
            })
          );

          // Sort connections: reachable first, then HTTPS, then local preference, then by latency
          const sortedConnections = connectionResults.sort((a, b) => {
            // Reachable first
            if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
            // Then HTTPS preference (many Plex servers require secure connections)
            const aHttps = a.uri.startsWith('https://');
            const bHttps = b.uri.startsWith('https://');
            if (aHttps !== bHttps) return aHttps ? -1 : 1;
            // Then local preference (local before remote)
            if (a.local !== b.local) return a.local ? -1 : 1;
            // Then by latency (lower is better)
            if (a.latencyMs !== null && b.latencyMs !== null) {
              return a.latencyMs - b.latencyMs;
            }
            return 0;
          });

          // Pick the best connection as recommended
          const recommended = sortedConnections.find((c) => c.reachable);

          return {
            name: server.name,
            platform: server.platform,
            version: server.productVersion,
            clientIdentifier: server.clientIdentifier,
            recommendedUri: recommended?.uri ?? null,
            connections: sortedConnections,
          };
        })
      );

      return { servers: testedServers, hasPlexToken: true };
    }
  );

  /**
   * POST /plex/add-server - Add an additional Plex server
   *
   * Requires authentication and owner role.
   * Uses existing Plex token from another connected server.
   */
  app.post('/plex/add-server', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = plexAddServerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('serverUri, serverName, and clientIdentifier are required');
    }

    const { serverUri, serverName, clientIdentifier } = body.data;
    const authUser = request.user;

    // Only owners can add servers
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can add servers');
    }

    // Get existing Plex server to retrieve token
    const existingPlexServer = await db
      .select({ token: servers.token })
      .from(servers)
      .where(eq(servers.type, 'plex'))
      .limit(1);

    if (existingPlexServer.length === 0) {
      return reply.badRequest('No Plex servers connected. Please link your Plex account first.');
    }

    const plexToken = existingPlexServer[0]!.token;

    // Check if server already exists (by machineIdentifier or URL)
    const existing = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.machineIdentifier, clientIdentifier))
      .limit(1);

    if (existing.length > 0) {
      return reply.conflict('This server is already connected');
    }

    // Also check by URL
    const existingByUrl = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.url, serverUri))
      .limit(1);

    if (existingByUrl.length > 0) {
      return reply.conflict('A server with this URL is already connected');
    }

    try {
      // Verify admin access on the new server
      const adminCheck = await PlexClient.verifyServerAdmin(plexToken, serverUri);
      if (!adminCheck.success) {
        // Provide specific error based on failure type
        if (adminCheck.code === PlexClient.AdminVerifyError.CONNECTION_FAILED) {
          return reply.serviceUnavailable(adminCheck.message);
        }
        return reply.forbidden(adminCheck.message);
      }

      // Create server record
      const [newServer] = await db
        .insert(servers)
        .values({
          name: serverName,
          type: 'plex',
          url: serverUri,
          token: plexToken,
          machineIdentifier: clientIdentifier,
        })
        .returning();

      if (!newServer) {
        return reply.internalServerError('Failed to create server');
      }

      app.log.info({ serverId: newServer.id, serverName }, 'Additional Plex server added');

      // Auto-sync server users and libraries in background
      syncServer(newServer.id, { syncUsers: true, syncLibraries: true })
        .then((result) => {
          app.log.info(
            {
              serverId: newServer.id,
              usersAdded: result.usersAdded,
              librariesSynced: result.librariesSynced,
            },
            'Auto-sync completed for new Plex server'
          );
        })
        .catch((error) => {
          app.log.error({ error, serverId: newServer.id }, 'Auto-sync failed for new Plex server');
        });

      return {
        success: true,
        server: {
          id: newServer.id,
          name: newServer.name,
          type: newServer.type,
          url: newServer.url,
        },
      };
    } catch (error) {
      app.log.error({ error }, 'Failed to add Plex server');
      return reply.internalServerError('Failed to add Plex server');
    }
  });
};
