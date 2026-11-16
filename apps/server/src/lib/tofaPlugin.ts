/**
 * tofa sign-in as a Better Auth plugin, through tofa cloud's device flow.
 *
 * Endpoints (mounted under /api/v1/auth via the plugin):
 * - POST /tofa/initiate    -> { handle, verificationUri, userCode, expiresIn, interval }
 * - POST /tofa/check       -> one poll of the device code; signs in the owner or a member, or
 *                             lists the account's servers for first run and Add server
 * - POST /tofa/connect     -> first run: makes a key on the picked server, the owner and the server
 * - POST /tofa/add-server  -> the same for a signed-in owner, without creating an account
 *
 * The link purpose of /tofa/initiate and /tofa/check, for a signed-in owner, links the owner's
 * account on one tofa server and their tofa sign-in through the account the device flow proves.
 *
 * Security: the cloud token's signature names the account. The owner signs in through the tofa
 * auth_accounts row, while holding a live tofa server account with that cloud identity and with
 * tofa login usable; anyone else only through a synced tofa server account
 * carrying that cloud identity that passes canMemberLogin. No call reaches a tofa server at sign-in.
 * The cloud token waits in Redis until a server is picked; neither it nor the server session token
 * is ever written to the database.
 */

import { randomBytes } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { expireCookie, type setSessionCookie } from 'better-auth/cookies';
import { and, asc, eq, inArray, isNotNull, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { REDIS_KEYS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { authAccounts, servers, serverUsers, users } from '../db/schema.js';
import { readServerFacts } from '../services/mediaServer/byServerType.js';
import {
  getCloudProfile,
  listOwnedServers,
  openServerSession,
  pollDeviceToken,
  requestDeviceCode,
  TofaCloudTokenError,
  verifyCloudToken,
  type TofaCloudServer,
} from '../services/mediaServer/tofa/cloud.js';
import { TofaClient } from '../services/mediaServer/tofa/client.js';
import { isTofaPicture } from '../services/mediaServer/tofa/parser.js';
import { createServer, startAddedServer } from '../services/serverCreate.js';
import { deleteServer } from '../services/serverDelete.js';
import { getOwnerUser } from '../services/userService.js';
import { createLogger } from '../utils/logger.js';
import {
  assertClaimCode,
  assertSignupAllowed,
  canMemberLogin,
  hasOpenServer,
  liveServerAccount,
  mediaSignInClosed,
  notPermitted,
  refused,
  usableLoginMethods,
} from './authGuards.js';
import { getRedis } from './redisShared.js';
import { createSignedInSession, upsertTofaAccount } from './memberLogin.js';

const log = createLogger('tofa-sign-in');

// Long enough for the probe, the key and the first writes; a crashed attempt frees it on its own.
const CONNECT_LOCK_TTL = 60;
const RELEASE_LOCK_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

const purposeSchema = z.enum(['sign-in', 'add-server']);
type Purpose = z.infer<typeof purposeSchema>;

const initiateBody = z.discriminatedUnion('purpose', [
  z.object({ purpose: purposeSchema }),
  z.object({ purpose: z.literal('link'), serverId: z.uuid() }),
]);
const checkBody = z.object({ handle: z.string(), claimCode: z.string().optional() });
const addServerBody = z.object({
  tempToken: z.string(),
  serverId: z.string(),
  url: z.url().optional(),
});
const connectBody = addServerBody.extend({ claimCode: z.string().optional() });

type TofaEndpointCtx = Parameters<typeof setSessionCookie>[0];

type DeviceState = { deviceCode: string; binding: string } & z.infer<typeof initiateBody>;

interface CloudSignIn {
  accessToken: string;
  identityId: string;
  username: string;
  email: string | null;
  purpose: Purpose;
}

const EXPIRED = { status: 'expired' } as const;

async function requireOwnerSession(ctx: TofaEndpointCtx): Promise<string> {
  const current = await getSessionFromCtx(ctx);
  const role = (current?.user as { role?: string } | undefined)?.role;
  if (!current || current.session.impersonatedBy || role !== 'owner') {
    throw new APIError('FORBIDDEN', { message: 'Only the owner can add servers' });
  }
  return current.user.id;
}

/**
 * The owner's picture follows the one their tofa account last synced, unless it came from elsewhere;
 * tofa is not called here.
 */
async function refreshOwnerPicture(ownerId: string): Promise<void> {
  try {
    await copyTofaPicture(ownerId);
  } catch {
    log.warn('could not refresh the owner picture', { userId: ownerId });
  }
}

async function copyTofaPicture(ownerId: string): Promise<void> {
  const [row] = await db
    .select({ thumbUrl: serverUsers.thumbUrl, ownerThumbnail: users.thumbnail })
    .from(serverUsers)
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .where(
      and(
        eq(serverUsers.userId, ownerId),
        eq(servers.type, 'tofa'),
        isNotNull(serverUsers.thumbUrl)
      )
    )
    .orderBy(asc(serverUsers.serverId))
    .limit(1);
  if (!row?.thumbUrl) return;
  // A picture another sign-in gave the owner, such as Plex, stays theirs.
  if (row.ownerThumbnail && !isTofaPicture(row.ownerThumbnail)) return;
  await db
    .update(users)
    .set({ thumbnail: row.thumbUrl, updatedAt: new Date() })
    .where(eq(users.id, ownerId));
}

/**
 * A member's synced tofa account carrying the cloud identity proves membership: the sync clears
 * the identity when tofa revokes the person's access. The owner never signs in here.
 */
async function finishTofaMemberLogin(ctx: TofaEndpointCtx, identityId: string) {
  if (await mediaSignInClosed()) throw refused();
  const rows = await db
    .select({ userId: serverUsers.userId, serverId: serverUsers.serverId })
    .from(serverUsers)
    .innerJoin(servers, eq(serverUsers.serverId, servers.id))
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .where(
      and(
        eq(serverUsers.cloudIdentityId, identityId),
        ne(users.role, 'owner'),
        eq(servers.type, 'tofa'),
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
  // tofa cloud vouched for this account, so a person the rule keeps out is told so.
  if (!userId) throw notPermittedSomewhere ? notPermitted() : refused();

  await upsertTofaAccount(userId, identityId);
  const user = await createSignedInSession(ctx, userId);
  return ctx.json({ status: 'signed-in' as const, user });
}

/** The account's servers, kept server-side with its cloud token until a server is picked. */
async function offerServers(
  accessToken: string,
  identityId: string,
  expiresAt: Date,
  purpose: Purpose
) {
  const [profile, owned] = await Promise.all([
    getCloudProfile(accessToken),
    listOwnedServers(accessToken),
  ]);
  if (owned.length === 0) return { status: 'no-servers' as const, username: profile.username };
  const offered = await notConnected(owned);
  if (offered.length === 0) return { status: 'all-connected' as const, username: profile.username };
  const tempToken = randomBytes(32).toString('hex');
  const signIn: CloudSignIn = {
    accessToken,
    identityId,
    username: profile.username,
    email: profile.email,
    purpose,
  };
  const ttl = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  await getRedis().setex(REDIS_KEYS.TOFA_TEMP(tempToken), ttl, JSON.stringify(signIn));
  return {
    status: 'select-server' as const,
    tempToken,
    username: profile.username,
    servers: offered,
  };
}

/** The same match connectServer refuses a second connect on. */
async function notConnected(owned: TofaCloudServer[]): Promise<TofaCloudServer[]> {
  const addresses = owned.flatMap((server) => (server.localAddress ? [server.localAddress] : []));
  const connected = await db
    .select({ machineIdentifier: servers.machineIdentifier, url: servers.url })
    .from(servers)
    .where(
      or(
        inArray(
          servers.machineIdentifier,
          owned.map((server) => server.id)
        ),
        addresses.length > 0 ? inArray(servers.url, addresses) : undefined
      )
    );
  return owned.filter(
    (server) =>
      !connected.some(
        (row) => row.machineIdentifier === server.id || row.url === server.localAddress
      )
  );
}

async function readSignIn(tempToken: string, purpose: Purpose): Promise<CloudSignIn | null> {
  const stored = await getRedis().get(REDIS_KEYS.TOFA_TEMP(tempToken));
  const signIn = stored ? (JSON.parse(stored) as CloudSignIn) : null;
  return signIn?.purpose === purpose ? signIn : null;
}

type Connected =
  | { status: 'unreachable'; address: string }
  | {
      status: 'connected';
      server: Awaited<ReturnType<typeof createServer>>['server'];
      ownerId: string;
    };

/**
 * The key is made at the server's local address or the address the owner typed, never at
 * connect_url. Any failure after the key exists deletes it, so a failed attempt leaves nothing on
 * the server; the session is logged out last because the delete needs it.
 */
async function connectServer(
  signIn: CloudSignIn,
  picked: { serverId: string; url?: string },
  owner: { existingId: string } | { create: true }
): Promise<Connected> {
  const server = (await listOwnedServers(signIn.accessToken)).find((s) => s.id === picked.serverId);
  if (!server) {
    throw new APIError('FORBIDDEN', { message: 'Your tofa account does not own that server' });
  }
  const address = picked.url ?? server.localAddress;
  // Nothing in the servers table keeps a server from being added twice.
  const [connected] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(
      or(eq(servers.machineIdentifier, server.id), address ? eq(servers.url, address) : undefined)
    )
    .limit(1);
  if (connected) {
    throw new APIError('CONFLICT', { message: 'That tofa server is already connected' });
  }
  if (!address || !(await TofaClient.probe(address))) {
    return { status: 'unreachable', address: address ?? '' };
  }

  const sessionToken = await openServerSession(signIn.accessToken, server.id);
  try {
    const key = await TofaClient.createApiKey(address, sessionToken);
    let createdOwnerId: string | null = null;
    let createdServerId: string | null = null;
    try {
      const client = new TofaClient({ url: address, token: key.secret });
      if ((await client.getServerIdentity()) !== server.id) {
        throw new APIError('BAD_REQUEST', {
          message: 'That address answers as a different tofa server',
        });
      }
      const [localUsers, facts] = await Promise.all([
        client.getUsers(),
        readServerFacts('tofa', address, key.secret),
      ]);
      const ownerAccount = localUsers.find((u) => u.cloudIdentityId === signIn.identityId);
      if (!ownerAccount) {
        // An owner made without that account would have no password and no tofa way back in.
        if ('create' in owner) {
          throw new APIError('BAD_REQUEST', {
            message:
              'This tofa server has no account for the tofa account you signed in with, so you could not sign back in with it. Create the owner account with a username and password instead.',
          });
        }
        // The first sync then adds the owner's account as its own person, until a merge.
        log.warn('tofa lists no local account for the owner', { serverId: server.id });
      }

      const ownerId =
        'existingId' in owner
          ? owner.existingId
          : (createdOwnerId = await createOwner(
              signIn.username,
              signIn.email,
              ownerAccount?.thumb ?? null
            ));

      const { server: created, requestServiceIds } = await createServer({
        name: server.name,
        type: 'tofa',
        url: address,
        token: key.secret,
        machineIdentifier: server.id,
        facts,
        ownerServerUser: ownerAccount && {
          userId: ownerId,
          externalId: ownerAccount.id,
          username: ownerAccount.username,
          email: ownerAccount.email ?? null,
          thumbUrl: ownerAccount.thumb ?? null,
          cloudIdentityId: signIn.identityId,
        },
      });
      createdServerId = created.id;
      await upsertTofaAccount(ownerId, signIn.identityId);
      if ('existingId' in owner) await refreshOwnerPicture(ownerId);
      await startAddedServer(created, requestServiceIds);
      return { status: 'connected', server: created, ownerId };
    } catch (error) {
      // The server and owner made here go with the key; createServer saves nothing when it throws.
      if (createdServerId) await removeServer(createdServerId);
      if (createdOwnerId) await removeOwner(createdOwnerId);
      await TofaClient.deleteApiKey(address, sessionToken, key.id).catch(() => {
        log.error('could not delete the key a failed tofa connect made', { serverId: server.id });
      });
      throw error;
    }
  } finally {
    const loggedOut = await TofaClient.logoutSession(address, sessionToken).catch(() => false);
    log.info('tofa server session closed after connect', { serverId: server.id, loggedOut });
  }
}

async function createOwner(
  username: string,
  email: string | null,
  thumbnail: string | null
): Promise<string> {
  const [owner] = await db
    .insert(users)
    .values({ username, email, thumbnail, role: 'owner' })
    .returning({ id: users.id });
  if (!owner) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create user' });
  return owner.id;
}

async function removeServer(serverId: string): Promise<void> {
  try {
    await deleteServer(serverId);
  } catch {
    log.error('could not remove the server a failed tofa connect made', { serverId });
  }
}

/** Its tofa auth_accounts row goes with it on the cascade. */
async function removeOwner(ownerId: string): Promise<void> {
  try {
    await db.delete(users).where(eq(users.id, ownerId));
  } catch {
    log.error('could not remove the owner a failed tofa connect made', { userId: ownerId });
  }
}

/**
 * One connect per temp token at a time, so a double click or a retried request cannot make two
 * keys or two server rows. The temp token is spent only on success, so a refused attempt can retry.
 */
async function withConnectLock<T>(tempToken: string, connect: () => Promise<T>): Promise<T> {
  const lock = `${REDIS_KEYS.TOFA_TEMP(tempToken)}:lock`;
  const holder = randomBytes(16).toString('hex');
  if ((await getRedis().set(lock, holder, 'EX', CONNECT_LOCK_TTL, 'NX')) !== 'OK') {
    throw new APIError('CONFLICT', { message: 'This server is already being connected' });
  }
  try {
    return await connect();
  } finally {
    // A lock that outlived its TTL may belong to the next attempt by now.
    await getRedis().eval(RELEASE_LOCK_SCRIPT, 1, lock, holder);
  }
}

function failed(ctx: TofaEndpointCtx, action: string, error: unknown): never {
  if (error instanceof APIError) throw error;
  // A query error carries its bound parameters, the new API key among them.
  ctx.context.logger.error(`tofa ${action} failed`, {
    error: error instanceof Error ? error.name : 'unknown',
  });
  throw new APIError('INTERNAL_SERVER_ERROR', { message: `Failed to ${action}` });
}

export const tofaPlugin = () =>
  ({
    id: 'tofa',
    endpoints: {
      tofaInitiate: createAuthEndpoint(
        '/tofa/initiate',
        { method: 'POST', body: initiateBody },
        async (ctx) => {
          if (ctx.body.purpose !== 'sign-in') await requireOwnerSession(ctx);
          const code = await requestDeviceCode();
          // Whoever polls an approved device code gets that account's token, so the code never
          // leaves the server and the handle that stands for it only works in this browser.
          const handle = randomBytes(32).toString('hex');
          const binding = randomBytes(32).toString('hex');
          const state: DeviceState = { deviceCode: code.deviceCode, binding, ...ctx.body };
          await getRedis().setex(
            REDIS_KEYS.TOFA_DEVICE(handle),
            code.expiresInSeconds,
            JSON.stringify(state)
          );
          const cookie = ctx.context.createAuthCookie('tofa_device', {
            maxAge: code.expiresInSeconds,
          });
          ctx.setCookie(cookie.name, binding, cookie.attributes);
          return ctx.json({
            handle,
            verificationUri: code.verificationUriComplete,
            userCode: code.userCode,
            expiresIn: code.expiresInSeconds,
            interval: code.intervalSeconds,
          });
        }
      ),
      tofaCheck: createAuthEndpoint(
        '/tofa/check',
        { method: 'POST', body: checkBody },
        async (ctx) => {
          const { handle, claimCode } = ctx.body;
          const key = REDIS_KEYS.TOFA_DEVICE(handle);
          const stored = await getRedis().get(key);
          const state = stored ? (JSON.parse(stored) as DeviceState) : null;
          const cookie = ctx.context.createAuthCookie('tofa_device');
          if (!state || ctx.getCookie(cookie.name) !== state.binding) return ctx.json(EXPIRED);

          const owner = await getOwnerUser();
          const ownerId = state.purpose === 'sign-in' ? null : await requireOwnerSession(ctx);
          if (ownerId === null) {
            if (!owner) {
              assertClaimCode(claimCode);
            } else if (!(await usableLoginMethods()).tofa && !(await hasOpenServer('tofa'))) {
              // A member signs in through a tofa server open to them, which an Allow person can
              // make one whose member switch is off.
              throw refused();
            }
          }

          try {
            const poll = await pollDeviceToken(state.deviceCode);
            if (poll.status !== 'approved') {
              if (poll.status === 'expired') {
                await getRedis().del(key);
                expireCookie(ctx, cookie);
              }
              return await ctx.json(poll);
            }
            await getRedis().del(key);
            expireCookie(ctx, cookie);
            const { identityId, expiresAt } = await verifyCloudToken(poll.accessToken);

            if (state.purpose === 'add-server') {
              return await ctx.json(
                await offerServers(poll.accessToken, identityId, expiresAt, 'add-server')
              );
            }

            if (state.purpose === 'link' && ownerId !== null) {
              // Both import auth.js, which imports this module.
              const { linkOwnerTofaAccount } = await import('../services/ownerAccountLink.js');
              const { MergeValidationError } = await import('../services/mergeService.js');
              try {
                await linkOwnerTofaAccount(ownerId, state.serverId, identityId);
              } catch (error) {
                if (error instanceof MergeValidationError) {
                  throw new APIError('BAD_REQUEST', { message: error.message });
                }
                throw error;
              }
              await refreshOwnerPicture(ownerId);
              return await ctx.json({ status: 'linked' as const });
            }

            if (owner) {
              // As with Plex, the sign-in row alone is no way in: its person must still hold a
              // live tofa account with this identity, which a merge and split can take away.
              const [linked] = await db
                .select({ userId: authAccounts.userId })
                .from(authAccounts)
                .innerJoin(
                  serverUsers,
                  and(
                    eq(serverUsers.userId, authAccounts.userId),
                    eq(serverUsers.cloudIdentityId, authAccounts.accountId)
                  )
                )
                .innerJoin(servers, eq(serverUsers.serverId, servers.id))
                .where(
                  and(
                    eq(authAccounts.providerId, 'tofa'),
                    eq(authAccounts.accountId, identityId),
                    liveServerAccount
                  )
                )
                .limit(1);
              if (linked?.userId !== owner.id) return await finishTofaMemberLogin(ctx, identityId);
              if (!(await usableLoginMethods()).tofa) throw refused();
              await refreshOwnerPicture(owner.id);
              const user = await createSignedInSession(ctx, owner.id);
              return await ctx.json({ status: 'signed-in' as const, user });
            }

            await assertSignupAllowed();
            return await ctx.json(
              await offerServers(poll.accessToken, identityId, expiresAt, 'sign-in')
            );
          } catch (error) {
            if (error instanceof TofaCloudTokenError) return ctx.json(EXPIRED);
            return failed(ctx, 'check tofa sign-in', error);
          }
        }
      ),
      tofaConnect: createAuthEndpoint(
        '/tofa/connect',
        { method: 'POST', body: connectBody },
        async (ctx) => {
          const { tempToken, serverId, url, claimCode } = ctx.body;
          try {
            return await withConnectLock(tempToken, async () => {
              const signIn = await readSignIn(tempToken, 'sign-in');
              if (!signIn) return ctx.json(EXPIRED);
              await assertSignupAllowed();
              assertClaimCode(claimCode);
              const result = await connectServer(signIn, { serverId, url }, { create: true });
              if (result.status === 'unreachable') return ctx.json(result);
              await getRedis().del(REDIS_KEYS.TOFA_TEMP(tempToken));
              log.info('New tofa owner with server created', {
                userId: result.ownerId,
                serverId: result.server.id,
              });
              const user = await createSignedInSession(ctx, result.ownerId);
              return ctx.json({ status: 'signed-in' as const, user });
            });
          } catch (error) {
            return failed(ctx, 'connect to the tofa server', error);
          }
        }
      ),
      tofaAddServer: createAuthEndpoint(
        '/tofa/add-server',
        { method: 'POST', body: addServerBody },
        async (ctx) => {
          const ownerId = await requireOwnerSession(ctx);
          const { tempToken, serverId, url } = ctx.body;
          try {
            return await withConnectLock(tempToken, async () => {
              const signIn = await readSignIn(tempToken, 'add-server');
              if (!signIn) return ctx.json(EXPIRED);
              const result = await connectServer(
                signIn,
                { serverId, url },
                { existingId: ownerId }
              );
              if (result.status === 'unreachable') return ctx.json(result);
              await getRedis().del(REDIS_KEYS.TOFA_TEMP(tempToken));
              return ctx.json({
                status: 'added' as const,
                server: result.server,
                canStopStreams: result.server.canStopStreams !== false,
              });
            });
          } catch (error) {
            return failed(ctx, 'add the tofa server', error);
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
