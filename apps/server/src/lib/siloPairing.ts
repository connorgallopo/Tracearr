/**
 * Silo pairing requests in flight: the Redis state behind a handle the browser holds, and the
 * login an approval gives while it waits for a profile PIN.
 */

import { randomBytes } from 'node:crypto';
import { REDIS_KEYS, type SiloPairStart } from '@tracearr/shared';
import {
  cancelPairing,
  logout,
  pollPairing,
  siloBinding,
  startPairing,
  type SiloLogin,
  type SiloPairingPoll,
} from '../services/mediaServer/silo/auth.js';
import { createLogger } from '../utils/logger.js';
import { GET_AND_DELETE_SCRIPT, getRedis } from './redisShared.js';

const log = createLogger('silo-pairing');

export type SiloPairingState = {
  url: string;
  deviceCode: string;
  secret: string;
  /** Origin the browser's link uses in place of the one Silo built */
  publicUrl: string | null;
  login?: SiloLogin & { profileId: string };
  wrongPins?: number;
} & (
  | { purpose: 'add-server'; ownerId: string; name: string }
  | { purpose: 'rekey' | 'link'; ownerId: string; serverId: string }
  | { purpose: 'sign-in'; serverId: string }
);

export const PIN_WAIT_SECONDS = 300;
export const MAX_WRONG_PINS = 3;
/** A parked state outlives the timer that logs its login out, so the timer always finds it */
const PARKED_GRACE_MS = 60_000;

/** Omit applied to each purpose, so the purpose's own fields stay */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ponytail: the PIN wait timer is in-process; a restart inside the wait leaves that login until
// Silo's own expiry, and a wrong PIN checked on another instance ends the login rather than
// parking it again. Keep the deadline in the state if Tracearr ever runs several instances.
/** When this instance logs out each parked login, by handle */
const pinDeadlines = new Map<string, number>();

const stateKey = (handle: string) => REDIS_KEYS.SILO_PAIRING(handle);

const failureOf = (error: unknown) => (error instanceof Error ? error.message : 'unknown error');

/** The link with its origin swapped for publicUrl's, path and query kept */
export function pairingLink(verificationUriComplete: string, publicUrl: string | null): string {
  if (!publicUrl) return verificationUriComplete;
  const link = new URL(verificationUriComplete);
  return `${new URL(publicUrl).origin}${link.pathname}${link.search}`;
}

/** Starts the request, stores the state for Silo's expires_in, returns what the browser may see */
export async function openPairing(
  state: OmitEach<SiloPairingState, 'deviceCode' | 'secret' | 'login' | 'wrongPins'>
): Promise<SiloPairStart> {
  const { binding, secret } = siloBinding();
  const request = await startPairing(state.url, binding);
  const handle = randomBytes(32).toString('hex');
  await getRedis().set(
    stateKey(handle),
    JSON.stringify({ ...state, deviceCode: request.deviceCode, secret }),
    'EX',
    request.expiresIn
  );
  return {
    handle,
    userCode: request.userCode,
    link: pairingLink(request.verificationUriComplete, state.publicUrl),
    expiresIn: request.expiresIn,
    interval: request.interval,
  };
}

export async function readPairing(handle: string): Promise<SiloPairingState | null> {
  const raw = await getRedis().get(stateKey(handle));
  return raw ? (JSON.parse(raw) as SiloPairingState) : null;
}

/** One poll. Deletes the state when Silo says the request is gone; moves its TTL to a pending poll's expiresAt */
export async function pollStoredPairing(
  handle: string,
  state: SiloPairingState
): Promise<SiloPairingPoll> {
  const poll = await pollPairing(state.url, state.deviceCode, state.secret);
  const key = stateKey(handle);
  if (poll.status === 'gone') {
    await getRedis().del(key);
  } else if (poll.status === 'pending' && poll.expiresAt) {
    const seconds = Math.ceil((Date.parse(poll.expiresAt) - Date.now()) / 1000);
    if (seconds > (await getRedis().ttl(key))) await getRedis().expire(key, seconds);
  }
  return poll;
}

/**
 * Runs work that holds a Silo login and logs it out in finally, unless the work called park()
 * because it parked the login for a PIN
 */
export async function holdLogin<T>(
  url: string,
  login: SiloLogin,
  work: (park: () => void) => Promise<T>
): Promise<T> {
  let parked = false;
  try {
    return await work(() => {
      parked = true;
    });
  } finally {
    if (!parked) await logout(url, login.accessToken);
  }
}

async function takeState(handle: string): Promise<SiloPairingState | null> {
  const raw = await getRedis().eval(GET_AND_DELETE_SCRIPT, 1, stateKey(handle));
  return typeof raw === 'string' ? (JSON.parse(raw) as SiloPairingState) : null;
}

/** Get-and-delete (Lua) of a parked state; null when absent or not parked */
export async function claimParked(handle: string): Promise<SiloPairingState | null> {
  const state = await takeState(handle);
  return state?.login ? state : null;
}

function armPinTimer(handle: string): number {
  const held = pinDeadlines.get(handle);
  if (held !== undefined) return held;
  const deadline = Date.now() + PIN_WAIT_SECONDS * 1000;
  pinDeadlines.set(handle, deadline);
  setTimeout(() => {
    pinDeadlines.delete(handle);
    claimParked(handle)
      .then((state) => state?.login && logout(state.url, state.login.accessToken))
      .catch((error: unknown) => {
        log.warn(`A Silo login waiting for a PIN could not be ended: ${failureOf(error)}`);
      });
  }, PIN_WAIT_SECONDS * 1000).unref();
  return deadline;
}

async function storeParked(handle: string, state: SiloPairingState, deadline: number) {
  await getRedis().set(
    stateKey(handle),
    JSON.stringify(state),
    'PX',
    deadline + PARKED_GRACE_MS - Date.now()
  );
}

/** Parks an approved login for PIN_WAIT_SECONDS and arms the logout timer */
export async function parkLogin(
  handle: string,
  state: SiloPairingState,
  login: SiloLogin & { profileId: string }
): Promise<void> {
  await storeParked(handle, { ...state, login }, armPinTimer(handle));
}

/** Puts a claimed state back with its remaining TTL after a wrong PIN */
export async function returnParked(handle: string, state: SiloPairingState): Promise<void> {
  const deadline = pinDeadlines.get(handle);
  if (deadline === undefined) {
    if (state.login) await logout(state.url, state.login.accessToken);
    return;
  }
  await storeParked(handle, state, deadline);
}

/** Cancels the Silo request, logs out a parked login, deletes the state. Never throws */
export async function endPairing(handle: string): Promise<void> {
  try {
    const state = await takeState(handle);
    if (!state) return;
    await cancelPairing(state.url, state.deviceCode);
    if (state.login) await logout(state.url, state.login.accessToken);
  } catch (error) {
    log.warn(`A Silo pairing request could not be ended: ${failureOf(error)}`);
  }
}
