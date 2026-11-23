/**
 * Member sign-in through Jellyfin (password or Quick Connect), Emby (password) and Silo (password
 * or a code the member approves in Silo), as a Better Auth plugin. Every endpoint checks, before
 * any outbound call, that the server is a live one of its type that someone could sign in through
 * (openToMemberSignIn); whether this person may is canMemberLogin's answer once the server
 * accepted them.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { and, eq, sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  assertNever,
  memberPasswordSignInSchema,
  quickConnectCheckSchema,
  quickConnectInitiateSchema,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, serverUsers } from '../db/schema.js';
import { EmbyClient, JellyfinClient } from '../services/mediaServer/index.js';
import {
  pairingOffered,
  passwordLogin as siloPasswordLogin,
} from '../services/mediaServer/silo/auth.js';
import type { MediaServerAuth } from '../services/mediaServer/types.js';
import { createLogger } from '../utils/logger.js';
import { CLIENT_IP_HEADER } from './auth.js';
import { mediaSignInClosed, openToMemberSignIn, refused } from './authGuards.js';
import {
  finishMemberLogin,
  memberDeviceId,
  type MemberLoginInput,
  type MemberLoginProvider,
} from './memberLogin.js';
import { getRedis, INCREMENT_SCRIPT } from './redisShared.js';
import {
  endPairing,
  holdLogin,
  openPairing,
  pollStoredPairing,
  readPairing,
  type SiloPairingState,
} from './siloPairing.js';

const log = createLogger('member-login');

const QUICK_CONNECT_TTL = 10 * 60;
const FAILURE_WINDOW = 15 * 60;
const MAX_FAILURES = 3;

// Hands back a reservation for an attempt the server never answered; a key that expired in the
// meantime stays gone, and the count never goes below zero.
export const RELEASE_SCRIPT = `if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then return redis.call('DECR', KEYS[1]) end
return 0`;

type LoginServer = Awaited<ReturnType<typeof loginServer>>;

async function loginServer(serverId: string, type: MemberLoginProvider) {
  if (await mediaSignInClosed()) throw refused();
  const [server] = await db
    .select({ id: servers.id, url: servers.url, publicUrl: servers.publicUrl })
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.type, type), openToMemberSignIn))
    .limit(1);
  if (!server) throw refused();
  return server;
}

// The DeviceId has to be stable per person so a re-login replaces the previous Jellyfin token,
// but the person is unknown until the server answers. The synced username is the best key
// available before that; an unknown one is hashed so nothing typed reaches the header.
async function deviceIdFor(serverId: string, username: string): Promise<string> {
  const [row] = await db
    .select({ userId: serverUsers.userId })
    .from(serverUsers)
    .where(
      and(
        eq(serverUsers.serverId, serverId),
        eq(sql`lower(${serverUsers.username})`, username.toLowerCase())
      )
    )
    .limit(1);
  if (row) return memberDeviceId(row.userId);
  const hash = createHash('sha256').update(`${serverId}:${username.toLowerCase()}`).digest('hex');
  return memberDeviceId(hash.slice(0, 32));
}

function isUnreachable(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError'))
  );
}

// Nothing the media server said goes back to the browser or into the log.
function serverFailure(error: unknown, serverId: string): APIError {
  if (isUnreachable(error)) {
    log.warn('media server unreachable during sign-in', { serverId });
    return new APIError('SERVICE_UNAVAILABLE', {
      message: 'The media server could not be reached.',
    });
  }
  log.error('media server sign-in failed', { serverId });
  return new APIError('INTERNAL_SERVER_ERROR', { message: 'Sign-in failed. Try again later.' });
}

async function callServer<T>(serverId: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw serverFailure(error, serverId);
  }
}

type SignedInAccount = Pick<MemberLoginInput, 'externalId' | 'token' | 'deviceId'>;

/** null when the server refused the username and password */
type PasswordSignIn = (
  server: LoginServer,
  username: string,
  password: string,
  forwardedFor: string
) => Promise<SignedInAccount | null>;

type AuthenticateByName = (
  url: string,
  username: string,
  pw: string,
  deviceId: string,
  forwardedFor: string
) => Promise<MediaServerAuth | null>;

function byNameSignIn(authenticate: AuthenticateByName): PasswordSignIn {
  return async (server, username, password, forwardedFor) => {
    const deviceId = await deviceIdFor(server.id, username);
    const auth = await callServer(server.id, () =>
      authenticate(server.url, username, password, deviceId, forwardedFor)
    );
    return auth && { ...auth, deviceId };
  };
}

/** Tracearr keeps no Silo login: it is logged out before the person is signed in here */
const siloSignIn: PasswordSignIn = async (server, username, password) => {
  const login = await callServer(server.id, () =>
    siloPasswordLogin(server.url, username, password)
  );
  if (!login) return null;
  return holdLogin(server.url, login, async () => ({
    externalId: login.user.id,
    token: null,
    deviceId: null,
  }));
};

function passwordSignIn(type: MemberLoginProvider, authenticate: PasswordSignIn) {
  return createAuthEndpoint(
    `/${type}/sign-in`,
    { method: 'POST', body: memberPasswordSignInSchema },
    async (ctx) => {
      const { serverId, username, password } = ctx.body;
      const server = await loginServer(serverId, type);
      const failuresKey = REDIS_KEYS.LOGIN_FAILURES(serverId, username.toLowerCase());
      const redis = getRedis();
      // Every attempt takes a slot before the server sees it, so parallel guesses cannot all pass
      // a read of the count. A wrong password keeps its slot; a right one clears the count.
      const attempt = Number(await redis.eval(INCREMENT_SCRIPT, 1, failuresKey, FAILURE_WINDOW));
      if (attempt > MAX_FAILURES) throw refused();

      let account: SignedInAccount | null;
      try {
        account = await authenticate(
          server,
          username,
          password,
          ctx.headers?.get(CLIENT_IP_HEADER) ?? ''
        );
      } catch (error) {
        await redis.eval(RELEASE_SCRIPT, 1, failuresKey);
        throw error;
      }
      if (!account) throw refused();
      await redis.del(failuresKey);
      return finishMemberLogin(ctx, {
        serverId,
        serverUrl: server.url,
        providerId: type,
        ...account,
      });
    }
  );
}

type MemberPairing = Extract<SiloPairingState, { purpose: 'sign-in' }>;

/** An owner's request is never a member's to finish */
function memberPairing(state: SiloPairingState | null): state is MemberPairing {
  if (!state) return false;
  switch (state.purpose) {
    case 'sign-in':
      return true;
    case 'add-server':
    case 'rekey':
    case 'link':
      return false;
    default:
      return assertNever(state);
  }
}

interface QuickConnectState {
  serverId: string;
  secret: string;
  deviceId: string;
}

export const memberLoginPlugin = () =>
  ({
    id: 'member-login',
    endpoints: {
      jellyfinSignIn: passwordSignIn(
        'jellyfin',
        byNameSignIn((...args) => JellyfinClient.authenticateByName(...args))
      ),
      embySignIn: passwordSignIn(
        'emby',
        byNameSignIn((...args) => EmbyClient.authenticateByName(...args))
      ),
      siloSignIn: passwordSignIn('silo', siloSignIn),
      quickConnectInitiate: createAuthEndpoint(
        '/jellyfin/quick-connect/initiate',
        { method: 'POST', body: quickConnectInitiateSchema },
        async (ctx) => {
          const server = await loginServer(ctx.body.serverId, 'jellyfin');
          if (!(await JellyfinClient.quickConnectEnabled(server.url))) {
            throw new APIError('NOT_FOUND', { message: 'Quick Connect is off on this server.' });
          }
          const handle = randomBytes(32).toString('hex');
          // The person is unknown until the code is approved, so the device is the request's.
          const deviceId = `tracearr-qc-${handle.slice(0, 16)}`;
          const { secret, code } = await callServer(server.id, () =>
            JellyfinClient.quickConnectInitiate(server.url, deviceId)
          );
          // The secret redeems a token, so it stays in Redis and only the handle goes out.
          const state: QuickConnectState = { serverId: server.id, secret, deviceId };
          await getRedis().setex(
            REDIS_KEYS.QUICK_CONNECT(handle),
            QUICK_CONNECT_TTL,
            JSON.stringify(state)
          );
          return ctx.json({ handle, code });
        }
      ),
      quickConnectCheck: createAuthEndpoint(
        '/jellyfin/quick-connect/check',
        { method: 'POST', body: quickConnectCheckSchema },
        async (ctx) => {
          const key = REDIS_KEYS.QUICK_CONNECT(ctx.body.handle);
          const redis = getRedis();
          const stored = await redis.get(key);
          if (!stored) return ctx.json({ authorized: false, expired: true });
          const { serverId, secret, deviceId } = JSON.parse(stored) as QuickConnectState;
          const server = await loginServer(serverId, 'jellyfin');

          const status = await callServer(serverId, () =>
            JellyfinClient.quickConnectStatus(server.url, secret)
          );
          if (status === 'gone') {
            await redis.del(key);
            return ctx.json({ authorized: false, expired: true });
          }
          if (status === 'pending') return ctx.json({ authorized: false });

          const auth = await callServer(serverId, () =>
            JellyfinClient.quickConnectRedeem(server.url, secret, deviceId)
          );
          await redis.del(key);
          if (!auth) throw refused();
          return finishMemberLogin(ctx, {
            serverId,
            serverUrl: server.url,
            providerId: 'jellyfin',
            deviceId,
            ...auth,
          });
        }
      ),
      siloCodeInitiate: createAuthEndpoint(
        '/silo/code/initiate',
        { method: 'POST', body: quickConnectInitiateSchema },
        async (ctx) => {
          const server = await loginServer(ctx.body.serverId, 'silo');
          if (!(await pairingOffered(server.url))) {
            throw new APIError('NOT_FOUND', { message: 'Code sign-in is off on this server.' });
          }
          const { handle, userCode, link, interval } = await callServer(server.id, () =>
            openPairing({
              purpose: 'sign-in',
              serverId: server.id,
              url: server.url,
              publicUrl: server.publicUrl,
            })
          );
          return ctx.json({ handle, code: userCode, link, interval });
        }
      ),
      siloCodeCheck: createAuthEndpoint(
        '/silo/code/check',
        { method: 'POST', body: quickConnectCheckSchema },
        async (ctx) => {
          const { handle } = ctx.body;
          const state = await readPairing(handle);
          if (!memberPairing(state)) return ctx.json({ authorized: false, expired: true });
          let server: LoginServer;
          try {
            server = await loginServer(state.serverId, 'silo');
          } catch (error) {
            await endPairing(handle);
            throw error;
          }

          const poll = await callServer(server.id, () => pollStoredPairing(handle, state));
          switch (poll.status) {
            case 'pending':
              return ctx.json({ authorized: false });
            case 'gone':
              return ctx.json({ authorized: false, expired: true });
            case 'approved': {
              const { login } = poll;
              const externalId = await holdLogin(state.url, login, async () => {
                await getRedis().del(REDIS_KEYS.SILO_PAIRING(handle));
                return login.user.id;
              });
              return finishMemberLogin(ctx, {
                serverId: server.id,
                serverUrl: server.url,
                externalId,
                token: null,
                providerId: 'silo',
                deviceId: null,
              });
            }
            default:
              return assertNever(poll);
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
