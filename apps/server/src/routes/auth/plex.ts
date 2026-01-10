/**
 * Plex Authentication Routes
 *
 * POST /plex/check-pin - Check Plex PIN status
 * POST /plex/connect - Complete Plex signup and connect a server
 * GET /plex/available-servers - Discover available Plex servers for adding
 * POST /plex/add-server - Add an additional Plex server
 * GET /plex/accounts - List linked Plex accounts
 * POST /plex/link-account - Link a new Plex account
 * DELETE /plex/accounts/:id - Unlink a Plex account
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, count, sql } from 'drizzle-orm';
import { z } from 'zod';
import type {
  PlexAvailableServersResponse,
  PlexDiscoveredServer,
  PlexDiscoveredConnection,
  PlexAccountsResponse,
  LinkPlexAccountResponse,
  UnlinkPlexAccountResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers, users, serverUsers, plexAccounts } from '../../db/schema.js';
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
  accountId: z.uuid().optional(), // Which plex_account to use (optional for backwards compat)
});

const plexLinkAccountSchema = z.object({
  pin: z.string().min(1),
});

const plexUnlinkAccountSchema = z.object({
  id: z.uuid(),
});

// Connection testing timeout in milliseconds
const CONNECTION_TEST_TIMEOUT = 3000;

/**
 * Test connections to a Plex server and return results with reachability info
 */
async function testServerConnections(
  connections: Array<{
    uri: string;
    local: boolean;
    address: string;
    port: number;
    relay: boolean;
  }>,
  token: string
): Promise<PlexDiscoveredConnection[]> {
  const results = await Promise.all(
    connections.map(async (conn): Promise<PlexDiscoveredConnection> => {
      const start = Date.now();
      try {
        const response = await fetch(`${conn.uri}/`, {
          headers: plexHeaders(token),
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

  // Sort: reachable first, then HTTPS, then local preference, then by latency
  return results.sort((a, b) => {
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    const aHttps = a.uri.startsWith('https://');
    const bHttps = b.uri.startsWith('https://');
    if (aHttps !== bHttps) return aHttps ? -1 : 1;
    if (a.local !== b.local) return a.local ? -1 : 1;
    if (a.latencyMs !== null && b.latencyMs !== null) {
      return a.latencyMs - b.latencyMs;
    }
    return 0;
  });
}

export const plexRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /plex/check-pin - Check Plex PIN status
   *
   * Returns:
   * - { authorized: false } if PIN not yet claimed
   * - { authorized: true, accessToken, refreshToken, user } if user found by plex_accounts or plexAccountId
   * - { authorized: true, needsServerSelection: true, servers, tempToken } if new Plex user
   *
   * Auth lookup priority:
   * 1. plex_accounts table (where allow_login = true)
   * 2. users.plexAccountId (legacy, auto-migrates to plex_accounts)
   * 3. server_users.externalId (server-synced users)
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

      // Priority 1: Check plex_accounts table (new multi-account system)
      const plexAccount = await db
        .select({
          id: plexAccounts.id,
          userId: plexAccounts.userId,
          allowLogin: plexAccounts.allowLogin,
        })
        .from(plexAccounts)
        .where(
          and(eq(plexAccounts.plexAccountId, authResult.id), eq(plexAccounts.allowLogin, true))
        )
        .limit(1);

      if (plexAccount.length > 0) {
        const account = plexAccount[0]!;
        const user = await getUserById(account.userId);

        if (user) {
          // Update plex account info
          await db
            .update(plexAccounts)
            .set({
              plexUsername: authResult.username,
              plexEmail: authResult.email,
              plexThumbnail: authResult.thumb,
              plexToken: authResult.token,
            })
            .where(eq(plexAccounts.id, account.id));

          // Update user display info
          await db
            .update(users)
            .set({
              username: authResult.username,
              email: authResult.email,
              thumbnail: authResult.thumb,
              updatedAt: new Date(),
            })
            .where(eq(users.id, user.id));

          app.log.info(
            { userId: user.id, plexAccountId: account.id },
            'Plex user login via plex_accounts'
          );

          return {
            authorized: true,
            ...(await generateTokens(app, user.id, authResult.username, user.role)),
          };
        }
      }

      // Priority 2: Check users.plexAccountId (legacy - migrate to plex_accounts)
      let existingUser = await getUserByPlexAccountId(authResult.id);

      // Priority 3: Check by externalId in server_users (server-synced users)
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
        // Returning Plex user via legacy lookup - auto-migrate to plex_accounts
        const user = existingUser;

        // Check if plex_account already exists (without allowLogin)
        const existingPlexAccount = await db
          .select({ id: plexAccounts.id })
          .from(plexAccounts)
          .where(eq(plexAccounts.plexAccountId, authResult.id))
          .limit(1);

        if (existingPlexAccount.length === 0) {
          // Migrate: Create plex_account entry with allowLogin=true
          await db.insert(plexAccounts).values({
            userId: user.id,
            plexAccountId: authResult.id,
            plexUsername: authResult.username,
            plexEmail: authResult.email,
            plexThumbnail: authResult.thumb,
            plexToken: authResult.token,
            allowLogin: true,
          });
          app.log.info(
            { userId: user.id, plexAccountId: authResult.id },
            'Auto-migrated user to plex_accounts'
          );
        }

        // Update user display info
        await db
          .update(users)
          .set({
            username: authResult.username,
            email: authResult.email,
            thumbnail: authResult.thumb,
            plexAccountId: authResult.id, // Keep for backwards compat
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));

        app.log.info({ userId: user.id }, 'Returning Plex user login (legacy lookup, migrated)');

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

      // If they have servers, test connections and let them select one
      if (plexServers.length > 0) {
        // Test connections for each server in parallel
        const testedServers: PlexDiscoveredServer[] = await Promise.all(
          plexServers.map(async (s) => {
            const testedConnections = await testServerConnections(s.connections, authResult.token);
            const recommended = testedConnections.find((c) => c.reachable);

            return {
              name: s.name,
              platform: s.platform,
              version: s.productVersion,
              clientIdentifier: s.clientIdentifier,
              publicAddressMatches: s.publicAddressMatches,
              httpsRequired: s.httpsRequired,
              connections: testedConnections,
              recommendedUri: recommended?.uri ?? null,
            };
          })
        );

        return {
          authorized: true,
          needsServerSelection: true,
          servers: testedServers,
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
          plexAccountId: authResult.id, // Keep for backwards compat
          role,
        })
        .returning();

      if (!newUser) {
        return reply.internalServerError('Failed to create user');
      }

      // Create plex_account entry (new multi-account system)
      await db.insert(plexAccounts).values({
        userId: newUser.id,
        plexAccountId: authResult.id,
        plexUsername: authResult.username,
        plexEmail: authResult.email,
        plexThumbnail: authResult.thumb,
        plexToken: authResult.token,
        allowLogin: true, // First account can login
      });

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

      const pmsClient = new PlexClient({ url: serverUri, token: plexToken });
      const localAccounts = await pmsClient.getUsers();
      // Owner is typically account ID "1", or the admin account
      const ownerLocalAccount = localAccounts.find((a) => a.isAdmin) ?? localAccounts[0];
      const ownerLocalId = ownerLocalAccount?.id ?? '1';

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
          plexAccountId: plexAccountId, // Keep for backwards compat
          role,
        })
        .returning();

      if (!newUser) {
        return reply.internalServerError('Failed to create user');
      }

      // Create plex_account entry (new multi-account system)
      const [newPlexAccount] = await db
        .insert(plexAccounts)
        .values({
          userId: newUser.id,
          plexAccountId: plexAccountId,
          plexUsername: plexUsername,
          plexEmail: plexEmail,
          plexThumbnail: plexThumb,
          plexToken: plexToken,
          allowLogin: true, // First account can login
        })
        .returning();

      // Update server with plex_account FK
      if (!newPlexAccount) {
        app.log.error({ plexAccountId, userId: newUser.id }, 'Failed to create plex_account entry');
        return reply.internalServerError('Failed to link Plex account');
      }

      await db
        .update(servers)
        .set({ plexAccountId: newPlexAccount.id })
        .where(eq(servers.id, serverId));

      // Create server_user linking the identity to this server
      // Use local PMS user ID (not Plex.tv ID) so it matches session data
      await db.insert(serverUsers).values({
        userId: newUser.id,
        serverId,
        externalId: ownerLocalId,
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
   *
   * Query params:
   * - accountId: Optional. If provided, uses the token from specified plex_account.
   *              If not provided, falls back to first Plex server's token (legacy).
   */
  app.get(
    '/plex/available-servers',
    { preHandler: [app.authenticate] },
    async (request, reply): Promise<PlexAvailableServersResponse> => {
      const authUser = request.user;
      const { accountId } = request.query as { accountId?: string };

      // Only owners can add servers
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can add servers');
      }

      // Get user for ownership verification
      const user = await getUserById(authUser.userId);
      if (!user) {
        return reply.unauthorized('User not found');
      }

      let plexToken: string;

      // If accountId provided, use that plex_account's token
      if (accountId) {
        const account = await db
          .select({ plexToken: plexAccounts.plexToken })
          .from(plexAccounts)
          .where(and(eq(plexAccounts.id, accountId), eq(plexAccounts.userId, user.id)))
          .limit(1);

        if (account.length === 0) {
          return reply.notFound('Plex account not found');
        }
        plexToken = account[0]!.plexToken;
      } else {
        // Legacy fallback: use first Plex server's token
        const existingPlexServers = await db
          .select({ token: servers.token })
          .from(servers)
          .where(eq(servers.type, 'plex'))
          .limit(1);

        if (existingPlexServers.length === 0) {
          // No Plex servers connected - check if user has linked plex accounts
          const userAccounts = await db
            .select({ plexToken: plexAccounts.plexToken })
            .from(plexAccounts)
            .where(eq(plexAccounts.userId, user.id))
            .limit(1);

          if (userAccounts.length === 0) {
            return { servers: [], hasPlexToken: false };
          }
          plexToken = userAccounts[0]!.plexToken;
        } else {
          plexToken = existingPlexServers[0]!.token;
        }
      }

      // Get all servers the user owns from plex.tv
      let allServers;
      try {
        allServers = await PlexClient.getServers(plexToken);
      } catch (error) {
        app.log.error({ error }, 'Failed to fetch servers from plex.tv');
        return reply.internalServerError('Failed to fetch servers from Plex');
      }

      // Get existing Plex servers for dedup check
      const connectedPlexServers = await db
        .select({ machineIdentifier: servers.machineIdentifier })
        .from(servers)
        .where(eq(servers.type, 'plex'));

      // Get list of already-connected machine identifiers
      const connectedMachineIds = new Set(
        connectedPlexServers
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
          const testedConnections = await testServerConnections(server.connections, plexToken);
          const recommended = testedConnections.find((c) => c.reachable);

          return {
            name: server.name,
            platform: server.platform,
            version: server.productVersion,
            clientIdentifier: server.clientIdentifier,
            recommendedUri: recommended?.uri ?? null,
            connections: testedConnections,
          };
        })
      );

      return { servers: testedServers, hasPlexToken: true };
    }
  );

  /**
   * GET /plex/server-connections/:serverId - Get connections for an existing server
   *
   * Used when editing a server's URL. Returns the available connections for the server.
   */
  app.get(
    '/plex/server-connections/:serverId',
    { preHandler: [app.authenticate] },
    async (request, reply): Promise<{ server: PlexDiscoveredServer } | { server: null }> => {
      const authUser = request.user;
      const { serverId } = request.params as { serverId: string };

      // Only owners can edit servers
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can edit servers');
      }

      // Get the server from DB
      const serverRows = await db
        .select({
          id: servers.id,
          token: servers.token,
          name: servers.name,
          machineIdentifier: servers.machineIdentifier,
        })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);

      if (serverRows.length === 0) {
        return reply.notFound('Server not found');
      }

      const existingServer = serverRows[0]!;

      // Fetch servers from plex.tv
      let plexServers;
      try {
        plexServers = await PlexClient.getServers(existingServer.token);
      } catch (error) {
        app.log.error({ error }, 'Failed to fetch servers from plex.tv');
        return reply.internalServerError('Failed to fetch servers from Plex');
      }

      // Find the specific server by machineIdentifier (if we have it)
      const targetServer = existingServer.machineIdentifier
        ? plexServers.find((s) => s.clientIdentifier === existingServer.machineIdentifier)
        : plexServers[0]; // Fallback to first server if no machineIdentifier

      if (!targetServer) {
        // Server not found in plex.tv - might be offline or token revoked
        return { server: null };
      }

      // Test connections
      const testedConnections = await testServerConnections(
        targetServer.connections,
        existingServer.token
      );
      const recommended = testedConnections.find((c) => c.reachable);

      return {
        server: {
          name: targetServer.name,
          platform: targetServer.platform,
          version: targetServer.productVersion,
          clientIdentifier: targetServer.clientIdentifier,
          recommendedUri: recommended?.uri ?? null,
          connections: testedConnections,
        },
      };
    }
  );

  /**
   * POST /plex/add-server - Add an additional Plex server
   *
   * Requires authentication and owner role.
   *
   * Body params:
   * - serverUri, serverName, clientIdentifier: Required
   * - accountId: Optional. If provided, uses the token from specified plex_account
   *              and sets the FK on the new server.
   */
  app.post('/plex/add-server', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = plexAddServerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('serverUri, serverName, and clientIdentifier are required');
    }

    const { serverUri, serverName, clientIdentifier, accountId } = body.data;
    const authUser = request.user;

    // Only owners can add servers
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can add servers');
    }

    // Get user for ownership verification
    const user = await getUserById(authUser.userId);
    if (!user) {
      return reply.unauthorized('User not found');
    }

    let plexToken: string;
    let plexAccountId: string | undefined;

    // If accountId provided, use that plex_account's token
    if (accountId) {
      const account = await db
        .select({ id: plexAccounts.id, plexToken: plexAccounts.plexToken })
        .from(plexAccounts)
        .where(and(eq(plexAccounts.id, accountId), eq(plexAccounts.userId, user.id)))
        .limit(1);

      if (account.length === 0) {
        return reply.notFound('Plex account not found');
      }
      plexToken = account[0]!.plexToken;
      plexAccountId = account[0]!.id;
    } else {
      // Legacy fallback: use first Plex server's token and account linkage
      const existingPlexServer = await db
        .select({ token: servers.token, plexAccountId: servers.plexAccountId })
        .from(servers)
        .where(eq(servers.type, 'plex'))
        .limit(1);

      if (existingPlexServer.length === 0) {
        // Check if user has linked plex accounts
        const userAccounts = await db
          .select({ id: plexAccounts.id, plexToken: plexAccounts.plexToken })
          .from(plexAccounts)
          .where(eq(plexAccounts.userId, user.id))
          .limit(1);

        if (userAccounts.length === 0) {
          return reply.badRequest('No Plex accounts linked. Please link your Plex account first.');
        }
        plexToken = userAccounts[0]!.plexToken;
        plexAccountId = userAccounts[0]!.id;
      } else {
        plexToken = existingPlexServer[0]!.token;
        // Also inherit the plexAccountId from the existing server if available
        plexAccountId = existingPlexServer[0]!.plexAccountId ?? undefined;
      }
    }

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
          plexAccountId: plexAccountId, // Link to plex_account if available
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

  // ===========================================================================
  // Plex Account Management (Multi-Account Support)
  // ===========================================================================

  /**
   * GET /plex/accounts - List linked Plex accounts
   *
   * Returns all Plex accounts linked to the current user,
   * with server counts for each account.
   */
  app.get(
    '/plex/accounts',
    { preHandler: [app.authenticate] },
    async (request, reply): Promise<PlexAccountsResponse> => {
      const authUser = request.user;

      // Only owners can manage Plex accounts
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can manage Plex accounts');
      }

      // Get user ID from auth
      const user = await getUserById(authUser.userId);
      if (!user) {
        return reply.unauthorized('User not found');
      }

      // Auto-repair: Link any orphaned Plex servers to their accounts
      // This fixes servers added before plexAccountId tracking was implemented
      // Matches by external Plex account ID (stable) instead of token (changes on re-auth)
      const orphanedServers = await db
        .select({ id: servers.id, token: servers.token })
        .from(servers)
        .where(and(eq(servers.type, 'plex'), sql`${servers.plexAccountId} IS NULL`));

      if (orphanedServers.length > 0) {
        // Get user's plex accounts with their external IDs (stable identifier)
        const userAccounts = await db
          .select({ id: plexAccounts.id, externalId: plexAccounts.plexAccountId })
          .from(plexAccounts)
          .where(eq(plexAccounts.userId, user.id));

        for (const server of orphanedServers) {
          try {
            // Get the Plex account ID from the server's token
            const accountInfo = await PlexClient.getAccountInfo(server.token);

            // Find matching account by external Plex ID (stable, doesn't change)
            const matchingAccount = userAccounts.find((a) => a.externalId === accountInfo.id);
            if (matchingAccount) {
              await db
                .update(servers)
                .set({ plexAccountId: matchingAccount.id })
                .where(eq(servers.id, server.id));
              app.log.info(
                { serverId: server.id, accountId: matchingAccount.id },
                'Auto-linked orphaned Plex server to account'
              );
            }
          } catch {
            // Token might be invalid/expired - skip this server
            app.log.debug(
              { serverId: server.id },
              'Could not fetch account info for orphaned server'
            );
          }
        }
      }

      // Get all linked plex accounts with server counts
      // Note: Using raw table/column names in subquery because Drizzle's sql`` template
      // doesn't correctly interpolate table references in correlated subqueries
      const accounts = await db
        .select({
          id: plexAccounts.id,
          plexAccountId: plexAccounts.plexAccountId,
          plexUsername: plexAccounts.plexUsername,
          plexEmail: plexAccounts.plexEmail,
          plexThumbnail: plexAccounts.plexThumbnail,
          allowLogin: plexAccounts.allowLogin,
          createdAt: plexAccounts.createdAt,
          serverCount: sql<number>`COALESCE((
            SELECT COUNT(*)::int FROM servers
            WHERE servers.plex_account_id = plex_accounts.id
          ), 0)`,
        })
        .from(plexAccounts)
        .where(eq(plexAccounts.userId, user.id))
        .orderBy(plexAccounts.createdAt);

      return {
        accounts: accounts.map((a) => ({
          id: a.id,
          plexAccountId: a.plexAccountId,
          plexUsername: a.plexUsername,
          plexEmail: a.plexEmail,
          plexThumbnail: a.plexThumbnail,
          allowLogin: a.allowLogin,
          serverCount: a.serverCount,
          createdAt: a.createdAt,
        })),
      };
    }
  );

  /**
   * POST /plex/link-account - Link a new Plex account
   *
   * Completes Plex OAuth and links the account to the current user.
   * The new account cannot be used for login (allowLogin=false).
   */
  app.post(
    '/plex/link-account',
    { preHandler: [app.authenticate] },
    async (request, reply): Promise<LinkPlexAccountResponse> => {
      const body = plexLinkAccountSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('pin is required');
      }

      const { pin } = body.data;
      const authUser = request.user;

      // Only owners can link Plex accounts
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can link Plex accounts');
      }

      // Get user
      const user = await getUserById(authUser.userId);
      if (!user) {
        return reply.unauthorized('User not found');
      }

      try {
        // Check the PIN with Plex
        const authResult = await PlexClient.checkOAuthPin(pin);

        if (!authResult) {
          return reply.badRequest('PIN not yet authorized or expired');
        }

        // Check if this Plex account is already linked to ANY user
        const existingAccount = await db
          .select({ id: plexAccounts.id, userId: plexAccounts.userId })
          .from(plexAccounts)
          .where(eq(plexAccounts.plexAccountId, authResult.id))
          .limit(1);

        if (existingAccount.length > 0) {
          if (existingAccount[0]!.userId === user.id) {
            return reply.conflict('This Plex account is already linked to your account');
          }
          return reply.conflict('This Plex account is linked to another Tracearr user');
        }

        // Create the plex_account entry
        const [newAccount] = await db
          .insert(plexAccounts)
          .values({
            userId: user.id,
            plexAccountId: authResult.id,
            plexUsername: authResult.username,
            plexEmail: authResult.email,
            plexThumbnail: authResult.thumb,
            plexToken: authResult.token,
            allowLogin: false, // Additional accounts cannot log in by default
          })
          .returning();

        if (!newAccount) {
          return reply.internalServerError('Failed to link Plex account');
        }

        app.log.info(
          { userId: user.id, plexAccountId: authResult.id },
          'Plex account linked successfully'
        );

        return {
          account: {
            id: newAccount.id,
            plexAccountId: newAccount.plexAccountId,
            plexUsername: newAccount.plexUsername,
            plexEmail: newAccount.plexEmail,
            plexThumbnail: newAccount.plexThumbnail,
            allowLogin: newAccount.allowLogin,
            serverCount: 0, // New account has no servers yet
            createdAt: newAccount.createdAt,
          },
        };
      } catch (error) {
        app.log.error({ error }, 'Failed to link Plex account');
        return reply.internalServerError('Failed to link Plex account');
      }
    }
  );

  /**
   * DELETE /plex/accounts/:id - Unlink a Plex account
   *
   * Removes a linked Plex account. Cannot unlink if:
   * - It's the only account with allowLogin=true and user has no password
   * - There are servers connected through this account
   */
  app.delete(
    '/plex/accounts/:id',
    { preHandler: [app.authenticate] },
    async (request, reply): Promise<UnlinkPlexAccountResponse> => {
      const params = plexUnlinkAccountSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid account ID');
      }

      const { id } = params.data;
      const authUser = request.user;

      // Only owners can unlink accounts
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can unlink Plex accounts');
      }

      // Get user
      const user = await getUserById(authUser.userId);
      if (!user) {
        return reply.unauthorized('User not found');
      }

      // Get the account to unlink
      const [account] = await db
        .select()
        .from(plexAccounts)
        .where(and(eq(plexAccounts.id, id), eq(plexAccounts.userId, user.id)))
        .limit(1);

      if (!account) {
        return reply.notFound('Plex account not found');
      }

      // Check if this account has servers connected
      const [serverCount] = await db
        .select({ count: count() })
        .from(servers)
        .where(eq(servers.plexAccountId, id));

      if (serverCount && serverCount.count > 0) {
        return reply.badRequest(
          `Cannot unlink this Plex account. Please delete the ${serverCount.count} server(s) connected through this account first.`
        );
      }

      // Check if this is the only login account and user has no password
      if (account.allowLogin) {
        const [loginAccountCount] = await db
          .select({ count: count() })
          .from(plexAccounts)
          .where(and(eq(plexAccounts.userId, user.id), eq(plexAccounts.allowLogin, true)));

        const hasPassword = user.passwordHash !== null;

        if (loginAccountCount && loginAccountCount.count <= 1 && !hasPassword) {
          return reply.badRequest(
            'Cannot unlink your only login account. Set a password first or link another Plex account with login enabled.'
          );
        }
      }

      // Delete the account
      await db.delete(plexAccounts).where(eq(plexAccounts.id, id));

      app.log.info(
        { userId: user.id, plexAccountId: account.plexAccountId },
        'Plex account unlinked successfully'
      );

      return { success: true };
    }
  );
};
