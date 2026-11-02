/**
 * Plex login as a Better Auth plugin
 *
 * Ports the Plex PIN login flow (previously the `check-pin` / `connect`
 * Fastify handlers in routes/auth/plex.ts) onto Better Auth. The lookup and
 * first-run logic are unchanged; the only behavioral difference is the ending:
 * instead of issuing JWT access/refresh tokens, it creates a Better Auth
 * session and sets the session cookie.
 *
 * Endpoints (mounted under /api/v1/auth via the plugin):
 * - POST /plex/initiate   -> { handle, authUrl }
 * - POST /plex/check-pin   -> { authorized: false } | server-selection payload |
 *                             { authorized: true, user } with the session cookie
 * - POST /plex/connect     -> { authorized: true, user } with the session cookie
 *
 * Security: an auth_accounts plex row never grants login on its own. The owner
 * signs in through plex_accounts.allowLogin or the legacy-equivalent lookup with
 * Plex login usable; anyone else only through a synced Plex server account that
 * passes canMemberLogin. The session hook runs assertUserCanLogin on both.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { expireCookie, type setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { eq, and, asc, desc, ne, or, sql } from 'drizzle-orm';
import { REDIS_KEYS, type PlexDiscoveredServer } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, servers, serverUsers, plexAccounts, authAccounts } from '../db/schema.js';
import { PlexClient } from '../services/mediaServer/index.js';
import { testServerConnections } from '../services/mediaServer/plex/connectionTest.js';
import { syncServer } from '../services/sync.js';
import { getOwnerUser, getUserById } from '../services/userService.js';
import { getRedis } from './redisShared.js';
import { invalidateServersCache } from '../jobs/poller/database.js';
import {
  assertSignupAllowed,
  assertClaimCode,
  canMemberLogin,
  liveServerAccount,
  notPermitted,
  refused,
  usableLoginMethods,
} from './authGuards.js';
import { createSignedInSession, writeWithoutParams } from './memberLogin.js';

const PLEX_TEMP_TOKEN_TTL = 10 * 60; // 10 minutes for server selection
const PLEX_PIN_TTL = 15 * 60;

const checkPinBody = z.object({ handle: z.string(), claimCode: z.string().optional() });
const initiateBody = z.object({ forwardUrl: z.url().optional() });
const connectBody = z.object({
  tempToken: z.string(),
  serverUri: z.url(),
  serverName: z.string().min(1).max(100),
  clientIdentifier: z.string().optional(),
  claimCode: z.string().optional(),
});

type PlexEndpointCtx = Parameters<typeof setSessionCookie>[0];

interface PlexPinState {
  pinId: string;
  binding: string;
}

export interface PlexTokenMetadata {
  token: string;
  tokenKind: 'jwt' | 'legacy';
  refreshToken: string | null;
  expiresAt: Date | null;
}

// Transaction handle, or the plain db client when there's no surrounding transaction
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * Ensure the auth_accounts plex row exists for this (user, plex.tv account).
 * The unique(provider_id, account_id) constraint means a re-login must not
 * surface a constraint violation, so this upserts.
 *
 * For strong-PIN JWT tokens, `refreshToken` and `accessTokenExpiresAt` are
 * stored so the daily refresh job can renew them. Legacy tokens have no
 * expiry, so those columns stay null and the row is just a long-lived token.
 */
export async function upsertPlexAuthAccount(
  userId: string,
  plexAccountId: string,
  tokenInfo: PlexTokenMetadata | null,
  tx: Tx = db
) {
  const isJwt = tokenInfo?.tokenKind === 'jwt';
  const refreshToken = isJwt ? tokenInfo.refreshToken : null;
  const accessTokenExpiresAt = isJwt ? tokenInfo.expiresAt : null;
  const accessToken = tokenInfo?.token ?? null;

  await writeWithoutParams(
    () =>
      tx
        .insert(authAccounts)
        .values({
          id: randomUUID(),
          accountId: plexAccountId,
          providerId: 'plex',
          userId,
          accessToken,
          refreshToken,
          accessTokenExpiresAt,
        })
        .onConflictDoUpdate({
          target: [authAccounts.providerId, authAccounts.accountId],
          // Intentional downgrade on relogin: a legacy re-login nulls out
          // refreshToken/accessTokenExpiresAt, since a legacy token has neither.
          set: {
            userId,
            accessToken,
            refreshToken,
            accessTokenExpiresAt,
            updatedAt: new Date(),
          },
        }),
    { userId }
  );
}

/**
 * The identity behind a plex.tv id outside plex_accounts: users.plex_account_id (legacy) or a
 * Plex server account whose external id is the plex.tv id. Neither is unique per identity, so the
 * owner wins and the rest fall in a fixed order. Constrained to Plex servers: the poller writes
 * external_id from whatever an upstream reports, so a hostile Jellyfin or Emby server could
 * otherwise plant one and claim the owner's identity.
 */
async function legacyPlexIdentity(plexTvId: string) {
  const [identity] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(
      or(
        eq(users.plexAccountId, plexTvId),
        sql`exists (
          select 1 from server_users su join servers s on s.id = su.server_id
          where su.user_id = ${users.id} and s.type = 'plex' and su.external_id = ${plexTvId}
        )`
      )
    )
    .orderBy(desc(sql`${users.role} = 'owner'`), asc(users.createdAt), asc(users.id))
    .limit(1);
  return identity ?? null;
}

/**
 * A member's own synced Plex account proves membership (the sync sets removedAt when it ends), so
 * no plex.tv call is made. The first identity, in a fixed order, whose account passes the gates
 * signs in. The owner never signs in here: that is the owner branch, behind the Plex switch.
 */
async function finishPlexMemberLogin(
  ctx: PlexEndpointCtx,
  authResult: { id: string } & PlexTokenMetadata
) {
  const rows = await db
    .select({ userId: serverUsers.userId, serverId: serverUsers.serverId })
    .from(serverUsers)
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .where(
      and(
        eq(serverUsers.plexAccountId, authResult.id),
        ne(users.role, 'owner'),
        eq(servers.type, 'plex'),
        liveServerAccount
      )
    )
    .orderBy(asc(serverUsers.userId), asc(serverUsers.serverId));
  let userId: string | null = null;
  let notPermittedSomewhere = false;
  for (const row of rows) {
    const gate = await canMemberLogin(row.userId, row.serverId);
    if (gate.ok) {
      userId = row.userId;
      break;
    }
    if (gate.reason === 'not-permitted') notPermittedSomewhere = true;
  }
  // plex.tv returned this account for the PIN, so a person the rule keeps out is told so.
  if (!userId) throw notPermittedSomewhere ? notPermitted() : refused();

  // A member's plex.tv token reaches their whole Plex account and Tracearr never uses it: the
  // sync's view of their server accounts is what keeps them signed in.
  await upsertPlexAuthAccount(userId, authResult.id, null);
  const user = await createSignedInSession(ctx, userId);
  return ctx.json({ authorized: true, user });
}

export const plexPlugin = () =>
  ({
    id: 'plex',
    endpoints: {
      plexInitiate: createAuthEndpoint(
        '/plex/initiate',
        { method: 'POST', body: initiateBody },
        async (ctx) => {
          const { pinId, authUrl } = await PlexClient.initiateOAuth(ctx.body.forwardUrl);
          // Whoever polls a pin id plex.tv authorized gets that person's session, so the id never
          // leaves the server and the handle that stands for it only works in this browser.
          const handle = randomBytes(32).toString('hex');
          const binding = randomBytes(32).toString('hex');
          const pin: PlexPinState = { pinId, binding };
          await getRedis().setex(REDIS_KEYS.PLEX_PIN(handle), PLEX_PIN_TTL, JSON.stringify(pin));
          const cookie = ctx.context.createAuthCookie('plex_pin', { maxAge: PLEX_PIN_TTL });
          ctx.setCookie(cookie.name, binding, cookie.attributes);
          return ctx.json({ handle, authUrl });
        }
      ),
      plexCheckPin: createAuthEndpoint(
        '/plex/check-pin',
        { method: 'POST', body: checkPinBody },
        async (ctx) => {
          const { handle, claimCode } = ctx.body;
          const key = REDIS_KEYS.PLEX_PIN(handle);
          const stored = await getRedis().get(key);
          const pin = stored ? (JSON.parse(stored) as PlexPinState) : null;
          const cookie = ctx.context.createAuthCookie('plex_pin');
          if (!pin || ctx.getCookie(cookie.name) !== pin.binding) {
            return ctx.json({ authorized: false, expired: true });
          }
          try {
            const authResult = await PlexClient.checkOAuthPin(pin.pinId);

            if (!authResult) {
              return ctx.json({ authorized: false, message: 'PIN not yet authorized' });
            }
            await getRedis().del(key);
            expireCookie(ctx, cookie);

            // Priority 1: plex_accounts table (login-capable accounts only)
            const [account] = await db
              .select({
                id: plexAccounts.id,
                userId: plexAccounts.userId,
                allowLogin: plexAccounts.allowLogin,
              })
              .from(plexAccounts)
              .where(
                and(
                  eq(plexAccounts.plexAccountId, authResult.id),
                  eq(plexAccounts.allowLogin, true)
                )
              )
              .limit(1);

            if (account) {
              const user = await getUserById(account.userId);

              if (user?.role === 'owner') {
                if (!(await usableLoginMethods()).plex) throw refused();

                // authResult.token may be a strong-PIN JWT (see PlexTokenMetadata).
                // Only clients.plex.tv has been confirmed to accept a JWT here; PMS
                // itself may reject a JWT in X-Plex-Token. Re-validate against a
                // real PMS before the JWT branch can ever fire - today
                // initiateOAuth never sends a JWK, so tokenKind is always 'legacy'
                // and this mirror only ever carries a legacy token.
                await writeWithoutParams(
                  () =>
                    db
                      .update(plexAccounts)
                      .set({
                        plexUsername: authResult.username,
                        plexEmail: authResult.email,
                        plexThumbnail: authResult.thumb,
                        plexToken: authResult.token,
                      })
                      .where(eq(plexAccounts.id, account.id)),
                  { userId: user.id }
                );

                const refreshed = await writeWithoutParams(
                  () =>
                    db
                      .update(servers)
                      .set({ token: authResult.token, updatedAt: new Date() })
                      .where(eq(servers.plexAccountId, account.id))
                      .returning({ id: servers.id, name: servers.name }),
                  { userId: user.id }
                );
                if (refreshed.length > 0) invalidateServersCache();

                if (refreshed.length > 0) {
                  ctx.context.logger.info('Refreshed Plex token for linked servers', {
                    plexAccountId: account.id,
                    servers: refreshed.map((s) => s.name),
                  });
                }

                await db
                  .update(users)
                  .set({
                    username: authResult.username,
                    email: authResult.email,
                    thumbnail: authResult.thumb,
                    updatedAt: new Date(),
                  })
                  .where(eq(users.id, user.id));

                await upsertPlexAuthAccount(user.id, authResult.id, authResult);

                ctx.context.logger.info('Plex user login via plex_accounts', {
                  userId: user.id,
                  plexAccountId: account.id,
                });

                const sessionUser = await createSignedInSession(ctx, user.id);
                return ctx.json({
                  authorized: true,
                  user: { id: sessionUser.id, username: authResult.username, role: 'owner' },
                });
              }
              if (user) return await finishPlexMemberLogin(ctx, authResult);
            }

            // Priority 2 and 3: users.plexAccountId (legacy, migrated to plex_accounts below)
            // and Plex server accounts
            const legacy = await legacyPlexIdentity(authResult.id);

            if (legacy?.role === 'owner') {
              if (!(await usableLoginMethods()).plex) throw refused();
              const user = legacy;

              const existingPlexAccount = await db
                .select({ id: plexAccounts.id })
                .from(plexAccounts)
                .where(eq(plexAccounts.plexAccountId, authResult.id))
                .limit(1);

              if (existingPlexAccount.length === 0) {
                await writeWithoutParams(
                  () =>
                    db.insert(plexAccounts).values({
                      userId: user.id,
                      plexAccountId: authResult.id,
                      plexUsername: authResult.username,
                      plexEmail: authResult.email,
                      plexThumbnail: authResult.thumb,
                      plexToken: authResult.token,
                      allowLogin: true,
                    }),
                  { userId: user.id }
                );
                ctx.context.logger.info('Auto-migrated user to plex_accounts', {
                  userId: user.id,
                  plexAccountId: authResult.id,
                });
              }

              await db
                .update(users)
                .set({
                  username: authResult.username,
                  email: authResult.email,
                  thumbnail: authResult.thumb,
                  plexAccountId: authResult.id,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, user.id));

              await upsertPlexAuthAccount(user.id, authResult.id, authResult);

              ctx.context.logger.info('Returning Plex user login (legacy lookup, migrated)', {
                userId: user.id,
              });

              const sessionUser = await createSignedInSession(ctx, user.id);
              return ctx.json({
                authorized: true,
                user: { id: sessionUser.id, username: authResult.username, role: 'owner' },
              });
            }

            if (legacy || (await getOwnerUser())) {
              return await finishPlexMemberLogin(ctx, authResult);
            }

            // No identity and no owner - first-run setup.
            await assertSignupAllowed();

            // Claim code guard before the outbound probes below: getServers and
            // testServerConnections reach hosts named by the caller's own plex
            // account, so an ungated instance is a LAN scanner.
            assertClaimCode(claimCode);

            const plexServers = await PlexClient.getServers(authResult.token);

            const tempToken = randomUUID().replace(/-/g, '');
            await getRedis().setex(
              REDIS_KEYS.PLEX_TEMP_TOKEN(tempToken),
              PLEX_TEMP_TOKEN_TTL,
              JSON.stringify({
                plexAccountId: authResult.id,
                plexUsername: authResult.username,
                plexEmail: authResult.email,
                plexThumb: authResult.thumb,
                plexToken: authResult.token,
                plexTokenKind: authResult.tokenKind,
                plexRefreshToken: authResult.refreshToken,
                plexTokenExpiresAt: authResult.expiresAt
                  ? authResult.expiresAt.toISOString()
                  : null,
              })
            );

            if (plexServers.length > 0) {
              const testedServers: PlexDiscoveredServer[] = await Promise.all(
                plexServers.map(async (s) => {
                  const testedConnections = await testServerConnections(
                    s.connections,
                    authResult.token
                  );
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

              return ctx.json({
                authorized: true,
                needsServerSelection: true,
                servers: testedServers,
                tempToken,
              });
            }

            // No servers - create the first user without a server connection.
            // (Claim code already checked above, before the outbound probes.)
            const [newUser] = await db
              .insert(users)
              .values({
                username: authResult.username,
                email: authResult.email,
                thumbnail: authResult.thumb,
                plexAccountId: authResult.id,
                role: 'owner',
              })
              .returning();

            if (!newUser) {
              throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create user' });
            }

            await writeWithoutParams(
              () =>
                db.insert(plexAccounts).values({
                  userId: newUser.id,
                  plexAccountId: authResult.id,
                  plexUsername: authResult.username,
                  plexEmail: authResult.email,
                  plexThumbnail: authResult.thumb,
                  plexToken: authResult.token,
                  allowLogin: true,
                }),
              { userId: newUser.id }
            );

            await upsertPlexAuthAccount(newUser.id, authResult.id, authResult);

            await getRedis().del(REDIS_KEYS.PLEX_TEMP_TOKEN(tempToken));

            ctx.context.logger.info('New Plex user created (no servers)', {
              userId: newUser.id,
              role: 'owner',
            });

            const sessionUser = await createSignedInSession(ctx, newUser.id);
            return ctx.json({
              authorized: true,
              user: { id: sessionUser.id, username: newUser.username, role: 'owner' },
            });
          } catch (error) {
            if (error instanceof APIError) throw error;
            // A query error carries its bound parameters, Plex tokens among them.
            ctx.context.logger.error('Plex check-pin failed', {
              error: error instanceof Error ? error.name : 'unknown',
            });
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Failed to check Plex authorization',
            });
          }
        }
      ),
      plexConnect: createAuthEndpoint(
        '/plex/connect',
        { method: 'POST', body: connectBody },
        async (ctx) => {
          const { tempToken, serverUri, serverName, clientIdentifier, claimCode } = ctx.body;

          // Temp token is consumed only on success so a failed attempt can retry.
          const stored = await getRedis().get(REDIS_KEYS.PLEX_TEMP_TOKEN(tempToken));
          if (!stored) {
            throw new APIError('UNAUTHORIZED', {
              message: 'Invalid or expired temp token. Please restart login.',
            });
          }

          const {
            plexAccountId,
            plexUsername,
            plexEmail,
            plexThumb,
            plexToken,
            plexTokenKind,
            plexRefreshToken,
            plexTokenExpiresAt,
          } = JSON.parse(stored) as {
            plexAccountId: string;
            plexUsername: string;
            plexEmail: string;
            plexThumb: string;
            plexToken: string;
            plexTokenKind?: 'jwt' | 'legacy';
            plexRefreshToken?: string | null;
            plexTokenExpiresAt?: string | null;
          };

          try {
            // Re-check owner existence at connect time (temp token may be stale).
            await assertSignupAllowed();

            // Claim code guard before the outbound admin probe.
            assertClaimCode(claimCode);

            const adminCheck = await PlexClient.verifyServerAdmin(plexToken, serverUri);
            if (!adminCheck.success) {
              if (adminCheck.code === PlexClient.AdminVerifyError.CONNECTION_FAILED) {
                throw new APIError('SERVICE_UNAVAILABLE', { message: adminCheck.message });
              }
              throw new APIError('FORBIDDEN', { message: adminCheck.message });
            }

            const pmsClient = new PlexClient({ url: serverUri, token: plexToken });
            const localAccounts = await pmsClient.getUsers();
            const ownerLocalAccount = localAccounts.find((a) => a.isAdmin) ?? localAccounts[0];
            const ownerLocalId = ownerLocalAccount?.id ?? '1';

            let server = await db
              .select()
              .from(servers)
              .where(and(eq(servers.url, serverUri), eq(servers.type, 'plex')))
              .limit(1);

            if (server.length === 0) {
              server = await writeWithoutParams(
                () =>
                  db
                    .insert(servers)
                    .values({
                      name: serverName,
                      type: 'plex',
                      url: serverUri,
                      token: plexToken,
                      machineIdentifier: clientIdentifier,
                    })
                    .returning(),
                { plexAccountId }
              );
            } else {
              const existingServer = server[0]!;
              await writeWithoutParams(
                () =>
                  db
                    .update(servers)
                    .set({
                      token: plexToken,
                      updatedAt: new Date(),
                      ...(clientIdentifier && !existingServer.machineIdentifier
                        ? { machineIdentifier: clientIdentifier }
                        : {}),
                    })
                    .where(eq(servers.id, existingServer.id)),
                { plexAccountId }
              );
            }
            invalidateServersCache();

            const serverId = server[0]!.id;

            const [newUser] = await db
              .insert(users)
              .values({
                username: plexUsername,
                email: plexEmail,
                thumbnail: plexThumb,
                plexAccountId,
                role: 'owner',
              })
              .returning();

            if (!newUser) {
              throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create user' });
            }

            const [newPlexAccount] = await writeWithoutParams(
              () =>
                db
                  .insert(plexAccounts)
                  .values({
                    userId: newUser.id,
                    plexAccountId,
                    plexUsername,
                    plexEmail,
                    plexThumbnail: plexThumb,
                    plexToken,
                    allowLogin: true,
                  })
                  .returning(),
              { userId: newUser.id }
            );

            if (!newPlexAccount) {
              ctx.context.logger.error('Failed to create plex_account entry', {
                plexAccountId,
                userId: newUser.id,
              });
              throw new APIError('INTERNAL_SERVER_ERROR', {
                message: 'Failed to link Plex account',
              });
            }

            await upsertPlexAuthAccount(newUser.id, plexAccountId, {
              token: plexToken,
              tokenKind: plexTokenKind ?? 'legacy',
              refreshToken: plexRefreshToken ?? null,
              expiresAt: plexTokenExpiresAt ? new Date(plexTokenExpiresAt) : null,
            });

            await db
              .update(servers)
              .set({ plexAccountId: newPlexAccount.id })
              .where(eq(servers.id, serverId));
            invalidateServersCache();

            await db.insert(serverUsers).values({
              userId: newUser.id,
              serverId,
              externalId: ownerLocalId,
              plexAccountId,
              username: plexUsername,
              email: plexEmail,
              thumbUrl: plexThumb,
              isServerAdmin: true,
            });

            // Consume the temp token now that records are committed.
            await getRedis().del(REDIS_KEYS.PLEX_TEMP_TOKEN(tempToken));

            ctx.context.logger.info('New Plex user with server created', {
              userId: newUser.id,
              serverId,
              role: 'owner',
            });

            syncServer(serverId, { syncUsers: true, syncLibraries: true })
              .then((result) => {
                ctx.context.logger.info('Auto-sync completed for Plex server', {
                  serverId,
                  usersAdded: result.usersAdded,
                  librariesSynced: result.librariesSynced,
                });
              })
              .catch((error: unknown) => {
                ctx.context.logger.error('Auto-sync failed for Plex server', {
                  err: error,
                  serverId,
                });
              });

            const sessionUser = await createSignedInSession(ctx, newUser.id);
            return ctx.json({
              authorized: true,
              user: { id: sessionUser.id, username: newUser.username, role: 'owner' },
            });
          } catch (error) {
            if (error instanceof APIError) throw error;
            // A query error carries its bound parameters, Plex tokens among them.
            ctx.context.logger.error('Plex connect failed', {
              error: error instanceof Error ? error.name : 'unknown',
            });
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Failed to connect to Plex server',
            });
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
