/**
 * Silo sign-in calls: pairing by a code an account approves, password sign-in, the profile PIN
 * check, and the API key Tracearr makes and deletes with a login.
 *
 * Not through fetchSilo: these answer 204 with no body, and Silo's PIN check must not be retried
 * on a 429. A redirect is never followed, since it would resend a password, secret or token past
 * the SSRF check on the server URL.
 */

import { createHash, randomBytes } from 'node:crypto';
import { assertNever } from '@tracearr/shared';
import {
  fetchJson,
  fetchText,
  isHttpStatus,
  jsonHeaders,
  type HttpRequestOptions,
} from '../../../utils/http.js';
import { createLogger } from '../../../utils/logger.js';
import { assertSafeProbeUrl, probeRefusal } from '../../../utils/ssrf.js';
import { API_PATH } from './client.js';
import type {
  SiloAuthProviders,
  SiloCreatedKey,
  SiloDeviceLoginCapability,
  SiloDeviceLoginPoll,
  SiloDeviceLoginStart,
  SiloOwnProfile,
  SiloPage,
  SiloProfileVerification,
  SiloTokenPair,
} from './types.js';

const log = createLogger('silo-auth');

export const SILO_KEY_LABEL = 'Tracearr';
export const SILO_KEY_SCOPES = [
  'admin:monitor:read',
  'admin:sessions:control',
  'libraries:read',
] as const;

const DEVICE_NAME = 'Tracearr';
const DEVICE_HEADERS = {
  'X-Silo-Device-Name': DEVICE_NAME,
  'X-Silo-Device-Platform': DEVICE_NAME,
};

export interface SiloLogin {
  accessToken: string;
  user: { id: string; username: string; email: string | null; role: string };
}

export interface SiloPairingRequest {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type SiloPairingPoll =
  | { status: 'pending'; opened: boolean; expiresAt: string | null; pollAfter: number }
  | { status: 'gone' }
  | { status: 'approved'; login: SiloLogin };

export interface SiloPrimaryProfile {
  id: string;
  hasPin: boolean;
}

/** The profile headers key calls send; none for an account with no profile */
export interface SiloProfileProof {
  profileId: string | null;
  profileToken: string | null;
}

const endpoint = (url: string, path: string) => `${url}${API_PATH}${path}`;

function siloOptions({
  token,
  method,
  headers,
  body,
}: {
  token?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: object;
} = {}): HttpRequestOptions {
  return {
    method,
    headers: { ...jsonHeaders(token), 'User-Agent': DEVICE_NAME, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    service: 'silo',
    timeout: 10_000,
    redirect: 'manual',
  };
}

const profileHeaders = ({ profileId, profileToken }: SiloProfileProof) => ({
  ...(profileId ? { 'X-Profile-Id': profileId } : {}),
  ...(profileToken ? { 'X-Profile-Token': profileToken } : {}),
});

const failureOf = (error: unknown) => (error instanceof Error ? error.message : 'unknown error');

function toLogin({ access_token, user }: SiloTokenPair): SiloLogin {
  return {
    accessToken: access_token,
    user: { id: user.id, username: user.username, email: user.email || null, role: user.role },
  };
}

/** A secret for one pairing request, and the binding Silo stores: base64url SHA-256 of it */
export function siloBinding(): { binding: string; secret: string } {
  const secret = randomBytes(32);
  return {
    binding: createHash('sha256').update(secret).digest('base64url'),
    secret: secret.toString('base64url'),
  };
}

export async function startPairing(url: string, binding: string): Promise<SiloPairingRequest> {
  assertSafeProbeUrl(url);
  const start = await fetchJson<SiloDeviceLoginStart>(
    endpoint(url, '/auth/device/start'),
    siloOptions({
      method: 'POST',
      body: { device_name: DEVICE_NAME, device_platform: DEVICE_NAME, binding },
    })
  );
  return {
    deviceCode: start.device_code,
    userCode: start.user_code,
    verificationUriComplete: start.verification_uri_complete,
    expiresIn: start.expires_in,
    interval: start.interval,
  };
}

export async function pollPairing(
  url: string,
  deviceCode: string,
  secret: string
): Promise<SiloPairingPoll> {
  let poll: SiloDeviceLoginPoll;
  try {
    poll = await fetchJson<SiloDeviceLoginPoll>(
      endpoint(url, '/auth/device/poll'),
      siloOptions({
        method: 'POST',
        headers: DEVICE_HEADERS,
        body: { device_code: deviceCode, binding_secret: secret },
      })
    );
  } catch (error) {
    if (isHttpStatus(error, 404)) return { status: 'gone' };
    throw error;
  }
  switch (poll.status) {
    case 'pending':
      return {
        status: 'pending',
        opened: poll.opened,
        expiresAt: poll.expires_at ?? null,
        pollAfter: poll.poll_after,
      };
    case 'approved':
      if (!poll.tokens) throw new Error('Silo approved the sign-in without a token pair');
      return { status: 'approved', login: toLogin(poll.tokens) };
    case 'denied':
    case 'consumed':
    case 'canceled':
    case 'expired':
      return { status: 'gone' };
    default:
      return assertNever(poll.status);
  }
}

/** Never throws */
export async function cancelPairing(url: string, deviceCode: string): Promise<void> {
  try {
    await fetchText(
      endpoint(url, '/auth/device/cancel'),
      siloOptions({ method: 'POST', body: { device_code: deviceCode } })
    );
  } catch (error) {
    log.warn(`Silo at ${url} did not cancel a pairing request: ${failureOf(error)}`);
  }
}

/** null when Silo refuses the sign-in (401 or 403); anything else throws */
export async function passwordLogin(
  url: string,
  username: string,
  password: string
): Promise<SiloLogin | null> {
  assertSafeProbeUrl(url);
  try {
    return toLogin(
      await fetchJson<SiloTokenPair>(
        endpoint(url, '/auth/login'),
        siloOptions({ method: 'POST', headers: DEVICE_HEADERS, body: { username, password } })
      )
    );
  } catch (error) {
    if (isHttpStatus(error, 401, 403)) return null;
    throw error;
  }
}

/** Never throws; logs a warning naming no token */
export async function logout(url: string, accessToken: string): Promise<void> {
  try {
    await fetchText(
      endpoint(url, '/auth/logout'),
      siloOptions({ method: 'POST', token: accessToken })
    );
  } catch (error) {
    log.warn(`Silo at ${url} did not end a Tracearr sign-in: ${failureOf(error)}`);
  }
}

/** null when the account has no profile */
export async function primaryProfile(
  url: string,
  accessToken: string
): Promise<SiloPrimaryProfile | null> {
  const { items } = await fetchJson<SiloPage<SiloOwnProfile>>(
    endpoint(url, '/profiles'),
    siloOptions({ token: accessToken })
  );
  const primary = items.find((profile) => profile.is_primary);
  return primary ? { id: primary.id, hasPin: primary.has_pin } : null;
}

/** Never retried: Silo locks the profile after five wrong PINs and answers 429 meanwhile */
export async function verifyPin(
  url: string,
  accessToken: string,
  profileId: string,
  pin: string
): Promise<{ profileToken: string } | 'wrong' | 'locked'> {
  let result: SiloProfileVerification;
  try {
    result = await fetchJson<SiloProfileVerification>(
      endpoint(url, `/profiles/${encodeURIComponent(profileId)}/verify-pin`),
      siloOptions({ method: 'POST', token: accessToken, body: { pin } })
    );
  } catch (error) {
    if (isHttpStatus(error, 429)) return 'locked';
    throw error;
  }
  return result.valid && result.profile_token ? { profileToken: result.profile_token } : 'wrong';
}

export async function createTracearrKey(
  url: string,
  accessToken: string,
  proof: SiloProfileProof
): Promise<{ id: string; key: string }> {
  const { id, key } = await fetchJson<SiloCreatedKey>(
    endpoint(url, '/api-keys'),
    siloOptions({
      method: 'POST',
      token: accessToken,
      headers: profileHeaders(proof),
      body: { label: SILO_KEY_LABEL, scopes: SILO_KEY_SCOPES },
    })
  );
  return { id, key };
}

export async function deleteKey(
  url: string,
  accessToken: string,
  proof: SiloProfileProof,
  keyId: string
): Promise<'deleted' | 'not-found'> {
  try {
    await fetchText(
      endpoint(url, `/api-keys/${encodeURIComponent(keyId)}`),
      siloOptions({ method: 'DELETE', token: accessToken, headers: profileHeaders(proof) })
    );
    return 'deleted';
  } catch (error) {
    if (isHttpStatus(error, 404)) return 'not-found';
    throw error;
  }
}

/** Public: pairing is available with session binding */
export async function pairingOffered(url: string): Promise<boolean> {
  if (probeRefusal(url)) return false;
  try {
    const capability = await fetchJson<SiloDeviceLoginCapability>(
      endpoint(url, '/auth/device/capability'),
      siloOptions()
    );
    return capability.state === 'available' && capability.session_binding === true;
  } catch {
    return false;
  }
}

/** Public: /auth/providers password_login */
export async function passwordLoginOffered(url: string): Promise<boolean> {
  if (probeRefusal(url)) return false;
  try {
    const providers = await fetchJson<SiloAuthProviders>(
      endpoint(url, '/auth/providers'),
      siloOptions()
    );
    return providers.password_login === true;
  } catch {
    return false;
  }
}
