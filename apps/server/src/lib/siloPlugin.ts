/**
 * Adding a Silo server, and replacing its key, by a code a Silo admin approves, as a Better Auth
 * plugin.
 *
 * Endpoints (mounted under /api/v1/auth via the plugin):
 * - POST /silo/pair/start   -> SiloPairStart: the code to approve in Silo, and a link to Silo's page for it
 * - POST /silo/pair/check   -> SiloPairCheck: one poll; an approval makes a key with the approver's login
 * - POST /silo/pair/cancel  -> { status: 'canceled' }
 *
 * Security: only the owner session that started a request can finish or cancel it. The Silo login
 * an approval gives never reaches the browser or the database, sits in Redis only while it waits
 * for a profile PIN, and is logged out on every path out (holdLogin).
 */

import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, type getSessionFromCtx } from 'better-auth/api';
import { and, eq } from 'drizzle-orm';
import {
  REDIS_KEYS,
  assertNever,
  siloPairCancelSchema,
  siloPairCheckSchema,
  siloPairStartSchema,
  type SiloPairCheck,
  type SiloPairStart,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { publishServersChanged } from '../jobs/poller/database.js';
import { readServerFacts } from '../services/mediaServer/byServerType.js';
import {
  createTracearrKey,
  deleteKey,
  pairingOffered,
  primaryProfile,
  verifyPin,
  type SiloLogin,
  type SiloProfileProof,
} from '../services/mediaServer/silo/auth.js';
import { SiloClient } from '../services/mediaServer/silo/client.js';
import { liveServerCondition } from '../services/liveServers.js';
import { verifyServerChange } from '../services/serverChange.js';
import {
  connectedServerConflict,
  createServer,
  startAddedServer,
} from '../services/serverCreate.js';
import { sseManager } from '../services/sseManager.js';
import { createLogger } from '../utils/logger.js';
import { requireOwnerSession } from './ownerSession.js';
import { getRedis } from './redisShared.js';
import {
  MAX_WRONG_PINS,
  claimParked,
  endPairing,
  holdLogin,
  openPairing,
  parkLogin,
  pollStoredPairing,
  readPairing,
  returnParked,
  type SiloPairingState,
} from './siloPairing.js';

const log = createLogger('silo-pairing');

type EndpointCtx = Parameters<typeof getSessionFromCtx>[0];
type OwnerPairing = Exclude<SiloPairingState, { purpose: 'sign-in' }>;
/** SiloPairCheck as sent: the added server's dates are serialized on the way out */
type CheckAnswer =
  | Exclude<SiloPairCheck, { status: 'added' }>
  | {
      status: 'added';
      server: Awaited<ReturnType<typeof createServer>>['server'];
      canStopStreams: boolean;
    };

const EXPIRED = { status: 'expired' } as const;
const ALREADY_CONNECTED = 'This server is already connected';

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown');

/** A member's sign-in request is never an owner's to finish */
function ownedBy(state: SiloPairingState | null, ownerId: string): state is OwnerPairing {
  if (!state) return false;
  switch (state.purpose) {
    case 'add-server':
    case 'rekey':
    case 'link':
      return state.ownerId === ownerId;
    case 'sign-in':
      return false;
    default:
      return assertNever(state);
  }
}

function needsAdmin(purpose: OwnerPairing['purpose']): boolean {
  switch (purpose) {
    case 'add-server':
    case 'rekey':
      return true;
    case 'link':
      return false;
    default:
      return assertNever(purpose);
  }
}

/** Key-less; called only for an address checkSiloServer let through */
function readIdentity(url: string): Promise<string | null> {
  return new SiloClient({ url, token: '' }).getServerIdentity().catch(() => null);
}

async function liveSiloServer(serverId: string) {
  const [server] = await db
    .select()
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.type, 'silo'), liveServerCondition))
    .limit(1);
  if (!server) throw new APIError('NOT_FOUND', { message: 'Server not found' });
  return server;
}

async function assertPairingOffered(url: string): Promise<void> {
  if (!(await pairingOffered(url))) {
    throw new APIError('BAD_REQUEST', {
      message: 'Pairing is off on this Silo server. Use an API key instead.',
    });
  }
}

/** Deletes a key a failed attempt made, with the login that made it */
async function dropKey(url: string, login: SiloLogin, proof: SiloProfileProof, keyId: string) {
  await deleteKey(url, login.accessToken, proof, keyId).catch((error: unknown) => {
    log.error('could not delete the key a failed Silo pairing made', {
      url,
      error: errorName(error),
    });
  });
}

async function startAdd(
  ownerId: string,
  body: { url: string; name: string; publicUrl?: string | null }
): Promise<SiloPairStart> {
  const url = body.url.replace(/\/$/, '');
  const refusal = await SiloClient.checkSiloServer(url);
  if (refusal) throw new APIError('BAD_REQUEST', { message: refusal });
  if (await connectedServerConflict('silo', url, await readIdentity(url))) {
    throw new APIError('CONFLICT', { message: ALREADY_CONNECTED });
  }
  await assertPairingOffered(url);
  return openPairing({
    purpose: 'add-server',
    ownerId,
    name: body.name,
    url,
    publicUrl: body.publicUrl ?? null,
  });
}

async function startRekey(ownerId: string, serverId: string): Promise<SiloPairStart> {
  const server = await liveSiloServer(serverId);
  await assertPairingOffered(server.url);
  return openPairing({
    purpose: 'rekey',
    ownerId,
    serverId,
    url: server.url,
    publicUrl: server.publicUrl,
  });
}

/** Any failure once the key exists deletes it before the login is logged out */
async function addServer(
  state: Extract<OwnerPairing, { purpose: 'add-server' }>,
  login: SiloLogin,
  proof: SiloProfileProof
): Promise<CheckAnswer> {
  const { url } = state;
  const machineIdentifier = await readIdentity(url);
  if (await connectedServerConflict('silo', url, machineIdentifier)) {
    throw new APIError('BAD_REQUEST', { message: ALREADY_CONNECTED });
  }
  const key = await createTracearrKey(url, login.accessToken, proof);
  let added: Awaited<ReturnType<typeof createServer>>;
  try {
    const verify = await SiloClient.verifyServerAdmin(key.key, url);
    if (!verify.success) throw new APIError('BAD_REQUEST', { message: verify.message });
    const facts = await readServerFacts('silo', url, key.key);
    // A query error carries its bound parameters, the new key among them.
    added = await createServer({
      name: state.name,
      type: 'silo',
      url,
      token: key.key,
      publicUrl: state.publicUrl,
      machineIdentifier,
      apiKeyId: key.id,
      facts,
      ownerServerUser: {
        userId: state.ownerId,
        externalId: login.user.id,
        username: login.user.username,
        email: login.user.email,
        cloudIdentityId: null,
      },
    }).catch((error: unknown) => {
      log.error('could not save a Silo server added by pairing', { error: errorName(error) });
      throw new APIError('BAD_REQUEST', { message: 'Could not save the server. Try again.' });
    });
  } catch (error) {
    await dropKey(url, login, proof, key.id);
    throw error;
  }
  await startAddedServer(added.server, added.requestServiceIds);
  return {
    status: 'added',
    server: added.server,
    canStopStreams: added.server.canStopStreams !== false,
  };
}

/**
 * The new key is verified and saved before the old one is deleted, and the socket moves to it
 * first when this instance can move it.
 */
async function rekey(
  state: Extract<OwnerPairing, { serverId: string }>,
  login: SiloLogin,
  proof: SiloProfileProof
): Promise<CheckAnswer> {
  const server = await liveSiloServer(state.serverId);
  const key = await createTracearrKey(state.url, login.accessToken, proof);
  try {
    const change = await verifyServerChange(server, { url: server.url, token: key.key });
    if (!change.ok) throw new APIError('BAD_REQUEST', { message: change.message });
    await db
      .update(servers)
      .set({
        ...change.facts,
        token: key.key,
        apiKeyId: key.id,
        ...(change.backfilledIdentity ? { machineIdentifier: change.backfilledIdentity } : {}),
        updatedAt: new Date(),
      })
      .where(eq(servers.id, server.id));
  } catch (error) {
    await dropKey(state.url, login, proof, key.id);
    throw error;
  }
  log.info('Server API key replaced by pairing', { serverId: server.id });

  await publishServersChanged();
  await sseManager.refresh().catch((error: unknown) => {
    log.error('SSE refresh failed after API key update', {
      serverId: server.id,
      error: errorName(error),
    });
  });

  let oldKeyLeft = true;
  if (server.apiKeyId) {
    try {
      oldKeyLeft =
        (await deleteKey(state.url, login.accessToken, proof, server.apiKeyId)) === 'not-found';
    } catch (error) {
      log.warn('could not delete the replaced Silo key', {
        serverId: server.id,
        error: errorName(error),
      });
    }
  }
  return { status: 'rekeyed', oldKeyLeft };
}

function finish(
  state: OwnerPairing,
  login: SiloLogin,
  proof: SiloProfileProof
): Promise<CheckAnswer> {
  switch (state.purpose) {
    case 'add-server':
      return addServer(state, login, proof);
    case 'rekey':
      return rekey(state, login, proof);
    case 'link':
      throw new APIError('BAD_REQUEST', { message: 'Silo accounts are not linked by code' });
    default:
      return assertNever(state);
  }
}

async function approved(
  handle: string,
  state: OwnerPairing,
  login: SiloLogin
): Promise<CheckAnswer> {
  return holdLogin(state.url, login, async (park) => {
    await getRedis().del(REDIS_KEYS.SILO_PAIRING(handle));
    if (needsAdmin(state.purpose) && login.user.role !== 'admin') return { status: 'not-admin' };
    const profile = await primaryProfile(state.url, login.accessToken);
    if (profile?.hasPin) {
      await parkLogin(handle, state, { ...login, profileId: profile.id });
      park();
      return { status: 'needs-pin', wrongPin: false };
    }
    return finish(state, login, { profileId: profile?.id ?? null, profileToken: null });
  });
}

async function checkPin(handle: string, ownerId: string, pin: string): Promise<CheckAnswer> {
  const claimed = await claimParked(handle);
  if (!claimed?.login) return EXPIRED;
  const { login } = claimed;
  return holdLogin(claimed.url, login, async (park) => {
    if (!ownedBy(claimed, ownerId)) return EXPIRED;
    const verified = await verifyPin(claimed.url, login.accessToken, login.profileId, pin);
    if (verified === 'locked') return { status: 'pin-locked' };
    if (verified === 'wrong') {
      const wrongPins = (claimed.wrongPins ?? 0) + 1;
      if (wrongPins >= MAX_WRONG_PINS) return EXPIRED;
      await returnParked(handle, { ...claimed, wrongPins });
      park();
      return { status: 'needs-pin', wrongPin: true };
    }
    return finish(claimed, login, {
      profileId: login.profileId,
      profileToken: verified.profileToken,
    });
  });
}

function failed(ctx: EndpointCtx, action: string, error: unknown): never {
  if (error instanceof APIError) throw error;
  // A query error carries its bound parameters, Silo keys among them.
  ctx.context.logger.error(`Silo ${action} failed`, { error: errorName(error) });
  throw new APIError('INTERNAL_SERVER_ERROR', { message: `Failed to ${action}` });
}

export const siloPlugin = () =>
  ({
    id: 'silo',
    endpoints: {
      siloPairStart: createAuthEndpoint(
        '/silo/pair/start',
        { method: 'POST', body: siloPairStartSchema },
        async (ctx) => {
          const ownerId = await requireOwnerSession(ctx);
          const body = ctx.body;
          try {
            switch (body.purpose) {
              case 'add-server':
                return await ctx.json(await startAdd(ownerId, body));
              case 'rekey':
                return await ctx.json(await startRekey(ownerId, body.serverId));
              default:
                return assertNever(body);
            }
          } catch (error) {
            return failed(ctx, 'start Silo pairing', error);
          }
        }
      ),
      siloPairCheck: createAuthEndpoint(
        '/silo/pair/check',
        { method: 'POST', body: siloPairCheckSchema },
        async (ctx) => {
          const ownerId = await requireOwnerSession(ctx);
          const { handle, pin } = ctx.body;
          try {
            const state = await readPairing(handle);
            if (!ownedBy(state, ownerId)) return await ctx.json<CheckAnswer>(EXPIRED);
            // A parked login is only ever claimed with a PIN; polling would find the code spent.
            if (state.login) {
              return await ctx.json<CheckAnswer>(
                pin === undefined
                  ? { status: 'needs-pin', wrongPin: false }
                  : await checkPin(handle, ownerId, pin)
              );
            }
            const poll = await pollStoredPairing(handle, state);
            switch (poll.status) {
              case 'pending':
                return await ctx.json<CheckAnswer>({ status: 'pending', opened: poll.opened });
              case 'gone':
                return await ctx.json<CheckAnswer>(EXPIRED);
              case 'approved':
                return await ctx.json<CheckAnswer>(await approved(handle, state, poll.login));
              default:
                return assertNever(poll);
            }
          } catch (error) {
            return failed(ctx, 'check Silo pairing', error);
          }
        }
      ),
      siloPairCancel: createAuthEndpoint(
        '/silo/pair/cancel',
        { method: 'POST', body: siloPairCancelSchema },
        async (ctx) => {
          const ownerId = await requireOwnerSession(ctx);
          const { handle } = ctx.body;
          try {
            if (ownedBy(await readPairing(handle), ownerId)) await endPairing(handle);
            return await ctx.json({ status: 'canceled' as const });
          } catch (error) {
            return failed(ctx, 'cancel Silo pairing', error);
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
