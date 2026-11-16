import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TofaCloudTokenError,
  listOwnedServers,
  pollDeviceToken,
  verifyCloudToken,
} from '../cloud.js';

const JWKS_URL = 'https://api.tofa.tv/.well-known/jwks.json';
const KID = 'tofa-key-1';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, use: 'sig' };

const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');

function signToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: 'EdDSA', kid: KID, typ: 'JWT' }
): string {
  const payload = {
    iss: 'tofa-connect',
    aud: 'cloud',
    sub: 'identity-1',
    exp: Math.floor(Date.now() / 1000) + 900,
    ...claims,
  };
  const signed = `${encode(header)}.${encode(payload)}`;
  return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString('base64url')}`;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ keys: [publicJwk] }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyCloudToken', () => {
  it('accepts a token signed by the published key', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600;

    expect(await verifyCloudToken(signToken({ exp }))).toEqual({
      identityId: 'identity-1',
      expiresAt: new Date(exp * 1000),
    });
  });

  it.each([
    ['rejects a token from another issuer', { iss: 'someone-else' }],
    ['rejects a token for another audience', { aud: 'server' }],
    ['rejects an expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
  ])('%s', async (_name, claims) => {
    await expect(verifyCloudToken(signToken(claims))).rejects.toBeInstanceOf(TofaCloudTokenError);
  });

  it('rejects a token whose kid is unknown after refetching the keys', async () => {
    await verifyCloudToken(signToken());
    fetchMock.mockClear();

    await expect(
      verifyCloudToken(signToken({}, { alg: 'EdDSA', kid: 'rotated-away' }))
    ).rejects.toBeInstanceOf(TofaCloudTokenError);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(JWKS_URL);
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = signToken().split('.');
    const forged = `${header}.${encode({
      iss: 'tofa-connect',
      aud: 'cloud',
      sub: 'someone-else',
      exp: Math.floor(Date.now() / 1000) + 900,
    })}.${signature}`;

    await expect(verifyCloudToken(forged)).rejects.toBeInstanceOf(TofaCloudTokenError);
  });

  it('rejects an alg other than EdDSA', async () => {
    await expect(verifyCloudToken(signToken({}, { alg: 'none', kid: KID }))).rejects.toBeInstanceOf(
      TofaCloudTokenError
    );
  });
});

describe('pollDeviceToken', () => {
  it('maps device token errors to pending, slow down and expired', async () => {
    const answer = (error: string) =>
      fetchMock.mockResolvedValueOnce(Response.json({ error }, { status: 400 }));

    answer('authorization_pending');
    expect(await pollDeviceToken('device-1')).toEqual({ status: 'pending' });
    answer('slow_down');
    expect(await pollDeviceToken('device-1')).toEqual({ status: 'slow_down' });
    answer('expired_token');
    expect(await pollDeviceToken('device-1')).toEqual({ status: 'expired' });
    answer('invalid_grant');
    expect(await pollDeviceToken('device-1')).toEqual({ status: 'expired' });
    answer('access_denied');
    await expect(pollDeviceToken('device-1')).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(Response.json({ access_token: 'cloud-token' }));
    expect(await pollDeviceToken('device-1')).toEqual({
      status: 'approved',
      accessToken: 'cloud-token',
    });
    const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
    expect(url).toBe('https://api.tofa.tv/device/token');
    expect(String(init?.body)).toBe(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=device-1'
    );
  });
});

describe('listOwnedServers', () => {
  it('lists only servers the account owns, with the local address', async () => {
    const server = (id: string, role: string, connection: unknown) => ({
      id,
      name: `server ${id}`,
      role,
      online: true,
      connect_url: `https://${id}.connect.tofa.tv:33333`,
      connection,
    });
    fetchMock.mockResolvedValueOnce(
      Response.json({
        items: [
          server('own', 'owner', { local_ip: '192.168.1.122', port: 33333, public_ip: '1.2.3.4' }),
          server('shared', 'guest', { local_ip: '10.0.0.5', port: 33333 }),
          server('unseen', 'owner', null),
        ],
        limit: 50,
        offset: 0,
        total: 3,
      })
    );

    expect(await listOwnedServers('cloud-token')).toEqual([
      { id: 'own', name: 'server own', online: true, localAddress: 'http://192.168.1.122:33333' },
      { id: 'unseen', name: 'server unseen', online: true, localAddress: null },
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.tofa.tv/servers');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer cloud-token' });
  });
});
