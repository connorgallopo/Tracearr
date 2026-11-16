/**
 * tofa cloud: the device sign-in, the account's servers, and the check of a cloud token's
 * signature. Cloudflare in front of api.tofa.tv turns away some clients by User-Agent; Node's
 * default fetch gets through.
 */

import { createPublicKey, verify, type webcrypto } from 'node:crypto';
import { fetchJson, jsonHeaders } from '../../../utils/http.js';

const CLOUD_URL = 'https://api.tofa.tv';
const JWKS_TTL_MS = 60 * 60 * 1000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export class TofaCloudTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TofaCloudTokenError';
  }
}

export interface TofaDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export type TofaDeviceTokenResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'approved'; accessToken: string };

export interface TofaCloudServer {
  id: string;
  name: string;
  online: boolean;
  localAddress: string | null;
}

interface CloudServerItem {
  id: string;
  name: string;
  role: string;
  online: boolean;
  connection: { local_ip?: string | null; port?: number | null } | null;
}

type Jwk = webcrypto.JsonWebKey & { kid?: string };

let jwks: { keys: Jwk[]; fetchedAt: number } | null = null;

function cloud<T>(path: string, accessToken?: string, init: RequestInit = {}): Promise<T> {
  return fetchJson<T>(`${CLOUD_URL}${path}`, {
    ...init,
    headers: jsonHeaders(accessToken),
    service: 'tofa',
  });
}

async function signingKey(kid: string): Promise<Jwk | undefined> {
  const cached = jwks && Date.now() - jwks.fetchedAt < JWKS_TTL_MS ? jwks.keys : null;
  const found = cached?.find((key) => key.kid === kid);
  if (found) return found;
  // A kid the cached set lacks may be a rotated key, so the set is read again once.
  const { keys } = await cloud<{ keys: Jwk[] }>('/.well-known/jwks.json');
  jwks = { keys, fetchedAt: Date.now() };
  return keys.find((key) => key.kid === kid);
}

function decodePart(part: string | undefined): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));
    if (decoded && typeof decoded === 'object') return decoded as Record<string, unknown>;
  } catch {
    // falls through to the refusal below
  }
  throw new TofaCloudTokenError('malformed token');
}

export async function verifyCloudToken(
  accessToken: string
): Promise<{ identityId: string; expiresAt: Date }> {
  const [headerPart, payloadPart, signature, ...rest] = accessToken.split('.');
  if (!headerPart || !payloadPart || !signature || rest.length > 0) {
    throw new TofaCloudTokenError('malformed token');
  }
  const header = decodePart(headerPart);
  if (header.alg !== 'EdDSA') throw new TofaCloudTokenError('unexpected algorithm');
  if (typeof header.kid !== 'string') throw new TofaCloudTokenError('token names no key');

  const jwk = await signingKey(header.kid);
  if (!jwk) throw new TofaCloudTokenError('unknown signing key');
  const valid = verify(
    null,
    Buffer.from(`${headerPart}.${payloadPart}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(signature, 'base64url')
  );
  if (!valid) throw new TofaCloudTokenError('bad signature');

  const claims = decodePart(payloadPart);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== 'tofa-connect') throw new TofaCloudTokenError('wrong issuer');
  if (!audiences.includes('cloud')) throw new TofaCloudTokenError('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new TofaCloudTokenError('expired');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) {
    throw new TofaCloudTokenError('token names no identity');
  }
  return { identityId: claims.sub, expiresAt: new Date(claims.exp * 1000) };
}

export async function requestDeviceCode(): Promise<TofaDeviceCode> {
  const code = await cloud<{
    device_code: string;
    user_code: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  }>('/device/code', undefined, {
    method: 'POST',
    body: JSON.stringify({ client_name: 'Tracearr', client_type: 'monitoring' }),
  });
  return {
    deviceCode: code.device_code,
    userCode: code.user_code,
    verificationUriComplete: code.verification_uri_complete,
    intervalSeconds: code.interval,
    expiresInSeconds: code.expires_in,
  };
}

/** One poll; the device flow answers 400 with an error code until the code is approved. */
export async function pollDeviceToken(deviceCode: string): Promise<TofaDeviceTokenResult> {
  const response = await fetch(`${CLOUD_URL}/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: deviceCode }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };
  if (response.ok && body.access_token) {
    return { status: 'approved', accessToken: body.access_token };
  }
  switch (body.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow_down' };
    case 'expired_token':
    case 'invalid_grant':
      return { status: 'expired' };
    default:
      throw new Error(`tofa device token request failed: ${response.status} ${body.error ?? ''}`);
  }
}

export async function getCloudProfile(
  accessToken: string
): Promise<{ identityId: string; username: string; email: string | null }> {
  const me = await cloud<{ identity_id: string; username: string; email?: string | null }>(
    '/v1/me',
    accessToken
  );
  return { identityId: me.identity_id, username: me.username, email: me.email ?? null };
}

export async function listOwnedServers(accessToken: string): Promise<TofaCloudServer[]> {
  const { items } = await cloud<{ items: CloudServerItem[] }>('/servers', accessToken);
  return items
    .filter((server) => server.role === 'owner')
    .map((server) => ({
      id: server.id,
      name: server.name,
      online: server.online,
      localAddress:
        server.connection?.local_ip && server.connection.port
          ? `http://${server.connection.local_ip}:${server.connection.port}`
          : null,
    }));
}

/** A session on the server for the signed-in account, which can create API keys there. */
export async function openServerSession(accessToken: string, serverId: string): Promise<string> {
  const session = await cloud<{ access_token: string }>(
    `/servers/${encodeURIComponent(serverId)}/server-session`,
    accessToken,
    { method: 'POST' }
  );
  return session.access_token;
}
