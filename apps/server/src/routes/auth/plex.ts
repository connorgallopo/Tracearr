/**
 * Plex Authentication Routes
 *
 * GET /plex/available-servers - Discover available Plex servers for adding
 * POST /plex/add-server - Add an additional Plex server
 * GET /plex/accounts - List linked Plex accounts
 * POST /plex/link-account - Link a new Plex account
 * POST /plex/accounts/:id/reauthorize - Replace a linked account's Plex token
 * DELETE /plex/accounts/:id - Unlink a Plex account
 *
 * Plex login (initiate / check-pin / connect) lives in the Better Auth plugin
 * at `lib/plexPlugin.ts`, served under the same URLs via the wildcard mount.
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, count, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getPlexClientIdentifier } from '../../utils/http.js';
import {
  REDIS_KEYS,
  type PlexAvailableServersResponse,
  type PlexDiscoveredServer,
  type PlexDiscoveredConnection,
  type PlexConnectionError,
  type PlexAccountsResponse,
  type LinkPlexAccountResponse,
  type UnlinkPlexAccountResponse,
  type ReauthorizePlexAccountResponse,
  type ReauthorizedServer,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers, serverUsers, plexAccounts } from '../../db/schema.js';
import { invalidateServersCache, publishServersChanged } from '../../jobs/poller/database.js';
import { reconcilePlexAccountToken } from '../../services/plexAccounts.js';
import { sseManager } from '../../services/sseManager.js';
import {
  HISTORICAL_EDIT_MESSAGE,
  isLiveRow,
  liveServerCondition,
} from '../../services/liveServers.js';
import { PlexClient } from '../../services/mediaServer/index.js';
import {
  compareConnections,
  plexDirectPublicIp,
  testSingleConnection,
  testServerConnections,
} from '../../services/mediaServer/plex/connectionTest.js';
// Token encryption removed - tokens now stored in plain text (DB is localhost-only)
import { syncServer } from '../../services/sync.js';
import { rebuildAutoSyncSchedules } from '../../jobs/librarySyncQueue.js';
import { getUserById } from '../../services/userService.js';
import { isClaimCodeEnabled, validateClaimCode } from '../../utils/claimCode.js';

// Schemas
const plexAddServerSchema = z.object({
  serverUri: z.url(),
  serverName: z.string().min(1).max(100),
  clientIdentifier: z.string().min(1), // Required for dedup
  accountId: z.uuid().optional(), // Which plex_account to use (optional for backwards compat)
});

const plexPinBodySchema = z.object({
  pin: z.string().min(1),
});

const plexAccountIdParamSchema = z.object({
  id: z.uuid(),
});

const plexTestConnectionSchema = z.object({
  uri: z.url(),
  accountId: z.uuid().optional(),
  tempToken: z.string().optional(), // Set during signup before the user has a Tracearr account
  claimCode: z.string().optional(),
});

type PlexTokenSource =
  | { kind: 'account'; token: string; accountRowId: string; plexTvAccountId: string }
  | { kind: 'server'; token: string }
  | { kind: 'account-not-found' }
  | { kind: 'none' };

/**
 * Pick which Plex token to talk to plex.tv with.
 *
 * A linked account is preferred over a server's copy of a token: it is scoped
 * to the user, it is the row that login and the refresh job keep current, and
 * it carries the account ids a caller needs to attribute a new server. The
 * server copy stays as a last resort for owners who log in with a password and
 * added their servers by hand, who can legitimately have no linked account.
 *
 * Both fallbacks order by creation so the choice does not drift between calls.
 */
export async function resolvePlexToken(
  userId: string,
  accountId?: string
): Promise<PlexTokenSource> {
  const accountColumns = {
    id: plexAccounts.id,
    plexToken: plexAccounts.plexToken,
    plexAccountId: plexAccounts.plexAccountId,
  };

  if (accountId) {
    const [account] = await db
      .select(accountColumns)
      .from(plexAccounts)
      .where(and(eq(plexAccounts.id, accountId), eq(plexAccounts.userId, userId)))
      .limit(1);

    if (!account) return { kind: 'account-not-found' };
    return {
      kind: 'account',
      token: account.plexToken,
      accountRowId: account.id,
      plexTvAccountId: account.plexAccountId,
    };
  }

  const [oldestAccount] = await db
    .select(accountColumns)
    .from(plexAccounts)
    .where(eq(plexAccounts.userId, userId))
    .orderBy(plexAccounts.createdAt)
    .limit(1);

  if (oldestAccount) {
    return {
      kind: 'account',
      token: oldestAccount.plexToken,
      accountRowId: oldestAccount.id,
      plexTvAccountId: oldestAccount.plexAccountId,
    };
  }

  const [oldestServer] = await db
    .select({ token: servers.token })
    .from(servers)
    .where(and(eq(servers.type, 'plex'), liveServerCondition))
    .orderBy(servers.createdAt)
    .limit(1);

  if (oldestServer) return { kind: 'server', token: oldestServer.token };

  return { kind: 'none' };
}

export const plexRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /plex/available-servers - Discover available Plex servers for adding
   *
   * Requires authentication and owner role.
   * Returns list of user's owned Plex servers that aren't already connected,
   * with connection testing results.
   *
   * Query params:
   * - accountId: Optional. If provided, uses the token from specified plex_account.
   *              If not provided, resolvePlexToken picks one.
   */
  app.get(
    '/plex/available-servers',
    { preHandler: [app.requireOwner] },
    async (request, reply): Promise<PlexAvailableServersResponse> => {
      const authUser = request.user;
      const { accountId } = request.query as { accountId?: string };

      // Get user for ownership verification
      const user = await getUserById(authUser.userId);
      if (!user) {
        return reply.unauthorized('User not found');
      }

      const tokenSource = await resolvePlexToken(user.id, accountId);
      if (tokenSource.kind === 'account-not-found') {
        return reply.notFound('Plex account not found');
      }
      if (tokenSource.kind === 'none') {
        return { servers: [], hasPlexToken: false };
      }
      const plexToken = tokenSource.token;

      // Get all servers the user owns from plex.tv
      let allServers;
      try {
        allServers = await PlexClient.getServers(plexToken);
      } catch (error) {
        app.log.error({ err: error }, 'Failed to fetch servers from plex.tv');
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
    { preHandler: [app.requireOwner] },
    async (request, reply): Promise<{ server: PlexDiscoveredServer } | { server: null }> => {
      const { serverId } = request.params as { serverId: string };

      // Get the server from DB
      const serverRows = await db
        .select({
          id: servers.id,
          token: servers.token,
          name: servers.name,
          url: servers.url,
          machineIdentifier: servers.machineIdentifier,
          historicalAt: servers.historicalAt,
        })
        .from(servers)
        .where(eq(servers.id, serverId))
        .limit(1);

      if (serverRows.length === 0) {
        return reply.notFound('Server not found');
      }

      const existingServer = serverRows[0]!;

      if (!isLiveRow(existingServer)) {
        return reply.conflict(HISTORICAL_EDIT_MESSAGE);
      }

      // Fetch servers from plex.tv
      let plexServers;
      try {
        plexServers = await PlexClient.getServers(existingServer.token);
      } catch (error) {
        app.log.error({ err: error }, 'Failed to fetch servers from plex.tv');
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

      // Test plex.tv-discovered connections
      const testedConnections = await testServerConnections(
        targetServer.connections,
        existingServer.token
      );

      // If the saved URL isn't one of plex.tv's connections, it's a custom URL.
      // Test it standalone and rank it with the rest so the user can see + click it.
      let customResult: PlexDiscoveredConnection | undefined;
      const savedUrlIsCustom = !testedConnections.some((c) => c.uri === existingServer.url);
      if (savedUrlIsCustom) {
        try {
          const parsed = new URL(existingServer.url);
          const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
          customResult = await testSingleConnection(
            {
              uri: existingServer.url,
              local: false,
              address: parsed.hostname,
              port,
              custom: true,
            },
            existingServer.token
          );
          testedConnections.push(customResult);
          testedConnections.sort(compareConnections);
        } catch {
          // Saved URL was malformed - skip injection rather than failing the whole request
        }
      }

      // A working saved URL stays recommended; the owner chose it on purpose
      const recommended = customResult?.reachable
        ? customResult
        : testedConnections.find((c) => c.reachable);

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
   * POST /plex/test-connection - Test reachability of a user-supplied URL
   *
   * Used to pre-verify a custom URL before saving the server. Returns a single
   * PlexDiscoveredConnection with custom: true so the frontend can render the
   * same row treatment (reachability + inline error) as plex.tv connections.
   *
   * Auth: accepts either an authenticated owner session OR a Plex signup
   * tempToken. The signup branch is used by Login.tsx before the user has a
   * Tracearr account; the temp token is read from Redis (not consumed) and
   * its plex token is used for the test request.
   *
   * If both `tempToken` and `accountId` are sent, `tempToken` takes priority.
   */
  app.post(
    '/plex/test-connection',
    async (request, reply): Promise<{ connection: PlexDiscoveredConnection } | undefined> => {
      const body = plexTestConnectionSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('uri is required');
      }

      const { uri, accountId, tempToken, claimCode } = body.data;

      // Resolve the plex token. Two branches:
      // 1. tempToken (signup): look up the stored Plex token from Redis
      //    without consuming it.
      // 2. authenticated owner: use accountId/fallback like /available-servers.
      let plexToken: string;
      if (tempToken) {
        const stored = await app.redis.get(REDIS_KEYS.PLEX_TEMP_TOKEN(tempToken));
        if (!stored) {
          return reply.unauthorized('Invalid or expired temp token');
        }
        const parsed = JSON.parse(stored) as { plexToken: string };
        plexToken = parsed.plexToken;

        // Claim code guard must run before the outbound probe
        if (isClaimCodeEnabled() && !validateClaimCode(claimCode)) {
          return reply.forbidden('Claim code required for first-time setup');
        }
      } else {
        // Run the standard authenticate decorator (covers JWT verify +
        // isTokenRevoked). It sends the reply on failure, so short-circuit.
        await app.requireOwner(request, reply);
        if (reply.sent) return undefined;
        const authUser = request.user;
        const user = await getUserById(authUser.userId);
        if (!user) {
          return reply.unauthorized('User not found');
        }

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
          const existingPlexServers = await db
            .select({ token: servers.token })
            .from(servers)
            .where(and(eq(servers.type, 'plex'), liveServerCondition))
            .orderBy(servers.createdAt)
            .limit(1);
          if (existingPlexServers.length > 0) {
            plexToken = existingPlexServers[0]!.token;
          } else {
            const userAccounts = await db
              .select({ plexToken: plexAccounts.plexToken })
              .from(plexAccounts)
              .where(eq(plexAccounts.userId, user.id))
              .limit(1);
            if (userAccounts.length === 0) {
              return reply.badRequest('No Plex accounts available to authenticate the test');
            }
            plexToken = userAccounts[0]!.plexToken;
          }
        }
      }

      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        return reply.badRequest('Invalid URL');
      }
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

      const rejected = (error: PlexConnectionError) => ({
        connection: {
          uri,
          local: false,
          address: parsed.hostname,
          port,
          reachable: false,
          latencyMs: null,
          error,
          custom: true,
        },
      });

      const publicIp = plexDirectPublicIp(parsed.hostname);
      if (publicIp) {
        let ownAddresses: string[];
        try {
          ownAddresses = (await PlexClient.getServers(plexToken)).flatMap((server) => [
            server.publicAddress,
            ...server.connections.map((conn) => conn.address),
          ]);
        } catch (error) {
          app.log.warn({ err: error }, 'Failed to fetch servers from plex.tv');
          return rejected({
            code: 'unknown',
            message: 'plex.tv did not answer, so this address could not be checked',
          });
        }
        if (!ownAddresses.includes(publicIp)) {
          return rejected({
            code: 'relay',
            message: 'Tracearr needs a direct connection to the server',
          });
        }
      }

      const connection = await testSingleConnection(
        {
          uri,
          local: false,
          address: parsed.hostname,
          port,
          custom: true,
        },
        plexToken
      );

      return { connection };
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
  app.post('/plex/add-server', { preHandler: [app.requireOwner] }, async (request, reply) => {
    const body = plexAddServerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('serverUri, serverName, and clientIdentifier are required');
    }

    const { serverUri, serverName, clientIdentifier, accountId } = body.data;
    const authUser = request.user;

    // Get user for ownership verification
    const user = await getUserById(authUser.userId);
    if (!user) {
      return reply.unauthorized('User not found');
    }

    const tokenSource = await resolvePlexToken(user.id, accountId);
    if (tokenSource.kind === 'account-not-found') {
      return reply.notFound('Plex account not found');
    }
    if (tokenSource.kind === 'none') {
      return reply.badRequest('No Plex accounts linked. Please link your Plex account first.');
    }

    const plexToken = tokenSource.token;
    const plexAccountId = tokenSource.kind === 'account' ? tokenSource.accountRowId : undefined;
    const plexTvAccountId =
      tokenSource.kind === 'account' ? tokenSource.plexTvAccountId : undefined;

    // Check if server already exists (by machineIdentifier or URL)
    const existing = await db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.type, 'plex'), eq(servers.machineIdentifier, clientIdentifier)))
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
      invalidateServersCache();

      if (!newServer) {
        return reply.internalServerError('Failed to create server');
      }

      // Create owner's serverUser for this server
      // This ensures the owner has a serverUser even before sync runs
      // (sync won't create new users for Plex - it only updates existing ones)
      try {
        const pmsClient = new PlexClient({ url: serverUri, token: plexToken });
        const localAccounts = await pmsClient.getUsers();
        const ownerLocalAccount = localAccounts.find((a) => a.isAdmin) ?? localAccounts[0];
        const ownerLocalId = ownerLocalAccount?.id ?? '1';

        await db.insert(serverUsers).values({
          userId: user.id,
          serverId: newServer.id,
          externalId: ownerLocalId, // Local PMS ID - used by poller
          plexAccountId: plexTvAccountId ?? null, // Plex.tv ID - used by sync
          username: user.username,
          email: user.email,
          thumbUrl: user.thumbnail,
          isServerAdmin: true,
        });

        app.log.info(
          { userId: user.id, serverId: newServer.id, externalId: ownerLocalId },
          'Created owner serverUser for new Plex server'
        );
      } catch (err) {
        // Log but don't fail - sync will create the serverUser later if needed
        app.log.warn(
          { error: err, serverId: newServer.id },
          'Failed to create owner serverUser, will be created on first stream'
        );
      }

      app.log.info({ serverId: newServer.id, serverName }, 'Additional Plex server added');

      rebuildAutoSyncSchedules().catch((error: unknown) => {
        app.log.error(
          { err: error, serverId: newServer.id },
          'Auto-sync schedule failed for new Plex server'
        );
      });

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
          app.log.error(
            { err: error, serverId: newServer.id },
            'Auto-sync failed for new Plex server'
          );
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
      app.log.error({ err: error }, 'Failed to add Plex server');
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
    { preHandler: [app.requireOwner] },
    async (request, reply): Promise<PlexAccountsResponse> => {
      const authUser = request.user;

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
              invalidateServersCache();
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
          liveServerCount: sql<number>`COALESCE((
            SELECT COUNT(*)::int FROM servers
            WHERE servers.plex_account_id = plex_accounts.id AND servers.historical_at IS NULL
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
          liveServerCount: a.liveServerCount,
          createdAt: a.createdAt,
        })),
        clientIdentifier: getPlexClientIdentifier(),
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
    { preHandler: [app.requireOwner] },
    async (request, reply): Promise<LinkPlexAccountResponse> => {
      const body = plexPinBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('pin is required');
      }

      const { pin } = body.data;
      const authUser = request.user;

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
            liveServerCount: 0,
            createdAt: newAccount.createdAt,
          },
        };
      } catch (error) {
        app.log.error({ err: error }, 'Failed to link Plex account');
        return reply.internalServerError('Failed to link Plex account');
      }
    }
  );

  /**
   * POST /plex/accounts/:id/reauthorize - Replace a linked account's Plex token
   *
   * A password change with "sign out of all devices" revokes every token, and
   * before this the only way back was deleting the server and its history.
   */
  app.post(
    '/plex/accounts/:id/reauthorize',
    { preHandler: [app.requireOwner] },
    async (request, reply): Promise<ReauthorizePlexAccountResponse> => {
      const params = plexAccountIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid account ID');
      }

      const body = plexPinBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('pin is required');
      }

      const { id } = params.data;
      const { pin } = body.data;
      const authUser = request.user;

      const user = await getUserById(authUser.userId);
      if (!user) {
        return reply.unauthorized('User not found');
      }

      const [account] = await db
        .select()
        .from(plexAccounts)
        .where(and(eq(plexAccounts.id, id), eq(plexAccounts.userId, user.id)))
        .limit(1);

      if (!account) {
        return reply.notFound('Plex account not found');
      }

      let authResult;
      try {
        authResult = await PlexClient.checkOAuthPin(pin);
      } catch (error) {
        app.log.error({ err: error, accountId: id }, 'Plex PIN check failed during reauthorize');
        return reply.internalServerError('Failed to reauthorize Plex account');
      }

      if (!authResult) {
        return reply.badRequest('PIN not yet authorized or expired');
      }

      // Addressed by Tracearr id, so the unique constraint on plex_account_id
      // never sees this write; without the check, a PIN authorized by any other
      // Plex user would repoint the owner's servers at that user's token.
      if (authResult.id !== account.plexAccountId) {
        const expected = account.plexUsername ?? account.plexEmail ?? 'the linked account';
        return reply.conflict(
          `That Plex sign-in was for a different account. Sign in as ${expected} to reauthorize it.`
        );
      }

      const { reconciled, unmatched } = await reconcilePlexAccountToken(account, authResult, {
        debug: (obj, msg) => app.log.debug(obj, msg),
        warn: (obj, msg) => app.log.warn(obj, msg),
      });

      // refresh() re-adds any connection whose stored token no longer matches,
      // so it carries the new token in without dropping anything first.
      if (reconciled.length > 0) {
        sseManager.refresh().catch((error: unknown) => {
          app.log.error({ err: error }, 'SSE refresh failed after Plex reauthorization');
        });
      }

      const verified: ReauthorizedServer[] = await Promise.all(
        reconciled.map(async (server) => {
          // The token is stored for when it is resumed; a historical server is never contacted.
          if (server.historicalAt) {
            return { id: server.id, name: server.name, status: server.status, ok: true };
          }
          let ok = false;
          try {
            const adminCheck = await PlexClient.verifyServerAdmin(authResult.token, server.url);
            ok = adminCheck.success;
          } catch (error) {
            app.log.debug(
              { err: error, serverId: server.id },
              'Server verification failed after reauthorization'
            );
          }
          return { id: server.id, name: server.name, status: server.status, ok };
        })
      );

      const results: ReauthorizedServer[] = [
        ...verified,
        ...unmatched.map((s): ReauthorizedServer => ({
          id: s.id,
          name: s.name,
          status: 'unmatched',
          ok: false,
        })),
      ];

      app.log.info(
        {
          userId: user.id,
          accountId: account.id,
          refreshed: verified.filter((s) => s.status === 'refreshed').length,
          adopted: verified.filter((s) => s.status === 'adopted').length,
          unmatched: unmatched.length,
        },
        'Plex account reauthorized'
      );

      const [serverCount] = await db
        .select({ count: count() })
        .from(servers)
        .where(eq(servers.plexAccountId, account.id));
      const [liveServerCount] = await db
        .select({ count: count() })
        .from(servers)
        .where(and(eq(servers.plexAccountId, account.id), liveServerCondition));

      return {
        account: {
          id: account.id,
          plexAccountId: account.plexAccountId,
          plexUsername: authResult.username,
          plexEmail: authResult.email,
          plexThumbnail: authResult.thumb,
          allowLogin: account.allowLogin,
          serverCount: serverCount?.count ?? 0,
          liveServerCount: liveServerCount?.count ?? 0,
          createdAt: account.createdAt,
        },
        servers: results,
      };
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
    { preHandler: [app.requireOwner] },
    async (request, reply): Promise<UnlinkPlexAccountResponse> => {
      const params = plexAccountIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid account ID');
      }

      const { id } = params.data;
      const authUser = request.user;

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

      const [liveCount] = await db
        .select({ count: count() })
        .from(servers)
        .where(and(eq(servers.plexAccountId, id), liveServerCondition));

      if (liveCount && liveCount.count > 0) {
        return reply.badRequest(
          `Cannot unlink this Plex account. Delete the ${liveCount.count} live server(s) connected through this account, or mark them historical, first.`
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

      // Historical servers keep their history but lose the link; a later reauthorize adopts them by identifier.
      await db.update(servers).set({ plexAccountId: null }).where(eq(servers.plexAccountId, id));
      await publishServersChanged();

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
