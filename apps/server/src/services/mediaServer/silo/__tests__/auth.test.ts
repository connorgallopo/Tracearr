import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn(), fetchText: vi.fn() };
});

import { fetchJson, fetchText, HttpClientError } from '../../../../utils/http.js';
import {
  SILO_KEY_SCOPES,
  cancelPairing,
  createTracearrKey,
  deleteKey,
  logout,
  pairingOffered,
  passwordLogin,
  passwordLoginOffered,
  pollPairing,
  primaryProfile,
  siloBinding,
  startPairing,
  verifyPin,
} from '../auth.js';

const mockFetchJson = vi.mocked(fetchJson);
const mockFetchText = vi.mocked(fetchText);

const URL = 'http://silo.local:8090';
const TOKEN = 'silo-access-7c2e9f4a';

const httpError = (statusCode: number) =>
  new HttpClientError({ service: 'silo', statusCode, statusText: 'error', url: URL });

const tokenPair = (email?: string) => ({
  access_token: TOKEN,
  refresh_token: 'refresh',
  expires_in: 900,
  user: {
    id: 'u-1',
    username: 'connor',
    ...(email === undefined ? {} : { email }),
    role: 'admin',
  },
});

const login = (email: string | null = 'c@example.com') => ({
  accessToken: TOKEN,
  user: { id: 'u-1', username: 'connor', email, role: 'admin' },
});

const jsonCall = (index = 0) => {
  const [url, init] = mockFetchJson.mock.calls[index] ?? [];
  return { url, init, body: init?.body ? JSON.parse(init.body as string) : undefined };
};

beforeEach(() => {
  mockFetchJson.mockReset();
  mockFetchText.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('siloBinding', () => {
  it('draws a secret and the base64url SHA-256 of it, both 43 characters', () => {
    const { binding, secret } = siloBinding();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(binding).toBe(
      createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('base64url')
    );
  });
});

describe('Silo sign-in calls', () => {
  it('never follow a redirect and are named silo with a 10 s timeout', async () => {
    mockFetchJson.mockResolvedValue({});
    mockFetchText.mockResolvedValue('');

    await startPairing(URL, 'b').catch(() => {});
    await pollPairing(URL, 'dc', 's').catch(() => {});
    await cancelPairing(URL, 'dc');
    await passwordLogin(URL, 'u', 'p').catch(() => {});
    await logout(URL, TOKEN);
    await primaryProfile(URL, TOKEN).catch(() => {});
    await verifyPin(URL, TOKEN, 'p-1', '1234').catch(() => {});
    await createTracearrKey(URL, TOKEN, { profileId: null, profileToken: null }).catch(() => {});
    await deleteKey(URL, TOKEN, { profileId: null, profileToken: null }, '7');
    await pairingOffered(URL);
    await passwordLoginOffered(URL);

    const calls = [...mockFetchJson.mock.calls, ...mockFetchText.mock.calls];
    expect(calls).toHaveLength(11);
    for (const [url, init] of calls) {
      expect(url.startsWith(`${URL}/api/v2/`)).toBe(true);
      expect(init).toMatchObject({ service: 'silo', timeout: 10_000, redirect: 'manual' });
    }
  });
});

describe('startPairing', () => {
  it('starts a bound request named Tracearr and maps its answer', async () => {
    mockFetchJson.mockResolvedValue({
      device_code: 'dc-1',
      user_code: '4821-7730',
      verification_uri_complete: `${URL}/activate?code=48217730`,
      expires_in: 900,
      interval: 5,
    });

    expect(await startPairing(URL, 'binding-1')).toEqual({
      deviceCode: 'dc-1',
      userCode: '4821-7730',
      verificationUriComplete: `${URL}/activate?code=48217730`,
      expiresIn: 900,
      interval: 5,
    });
    const { url, init, body } = jsonCall();
    expect(url).toBe(`${URL}/api/v2/auth/device/start`);
    expect(init?.method).toBe('POST');
    expect(body).toEqual({
      device_name: 'Tracearr',
      device_platform: 'Tracearr',
      binding: 'binding-1',
    });
  });

  it('refuses a link-local address before any request', async () => {
    await expect(startPairing('http://169.254.169.254', 'b')).rejects.toThrow();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

describe('pollPairing', () => {
  it('answers pending with opened, expiresAt and pollAfter, sending the binding secret', async () => {
    mockFetchJson.mockResolvedValue({
      status: 'pending',
      opened: true,
      expires_at: '2026-11-21T10:20:00Z',
      poll_after: 5,
    });

    expect(await pollPairing(URL, 'dc-1', 'secret-1')).toEqual({
      status: 'pending',
      opened: true,
      expiresAt: '2026-11-21T10:20:00Z',
      pollAfter: 5,
    });
    const { url, init, body } = jsonCall();
    expect(url).toBe(`${URL}/api/v2/auth/device/poll`);
    expect(body).toEqual({ device_code: 'dc-1', binding_secret: 'secret-1' });
    expect(init?.headers).toMatchObject({
      'X-Silo-Device-Name': 'Tracearr',
      'X-Silo-Device-Platform': 'Tracearr',
      'User-Agent': 'Tracearr',
    });
  });

  it.each(['denied', 'consumed', 'canceled', 'expired'])('answers %s as gone', async (status) => {
    mockFetchJson.mockResolvedValue({ status, opened: false, poll_after: 5 });

    expect(await pollPairing(URL, 'dc-1', 's')).toEqual({ status: 'gone' });
  });

  it('answers a 404 as gone', async () => {
    mockFetchJson.mockRejectedValue(httpError(404));

    expect(await pollPairing(URL, 'dc-1', 's')).toEqual({ status: 'gone' });
  });

  it('maps an approval, with an empty or missing email as null', async () => {
    mockFetchJson.mockResolvedValueOnce({ status: 'approved', tokens: tokenPair('') });
    mockFetchJson.mockResolvedValueOnce({ status: 'approved', tokens: tokenPair() });
    mockFetchJson.mockResolvedValueOnce({
      status: 'approved',
      tokens: tokenPair('c@example.com'),
    });

    expect(await pollPairing(URL, 'dc-1', 's')).toEqual({
      status: 'approved',
      login: login(null),
    });
    expect(await pollPairing(URL, 'dc-1', 's')).toEqual({
      status: 'approved',
      login: login(null),
    });
    expect(await pollPairing(URL, 'dc-1', 's')).toEqual({ status: 'approved', login: login() });
  });

  it('throws on a 403', async () => {
    mockFetchJson.mockRejectedValue(httpError(403));

    await expect(pollPairing(URL, 'dc-1', 's')).rejects.toBeInstanceOf(HttpClientError);
  });
});

describe('cancelPairing', () => {
  it('posts the device code and never throws', async () => {
    mockFetchText.mockRejectedValue(httpError(500));

    await expect(cancelPairing(URL, 'dc-1')).resolves.toBeUndefined();
    const [url, init] = mockFetchText.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/api/v2/auth/device/cancel`);
    expect(JSON.parse(init?.body as string)).toEqual({ device_code: 'dc-1' });
  });
});

describe('passwordLogin', () => {
  it.each([401, 403])('answers null to a %i', async (status) => {
    mockFetchJson.mockRejectedValue(httpError(status));

    expect(await passwordLogin(URL, 'connor', 'pw')).toBeNull();
  });

  it.each([409, 429])('throws on a %i', async (status) => {
    mockFetchJson.mockRejectedValue(httpError(status));

    await expect(passwordLogin(URL, 'connor', 'pw')).rejects.toBeInstanceOf(HttpClientError);
  });

  it('maps the token pair and names the device Tracearr', async () => {
    mockFetchJson.mockResolvedValue(tokenPair(''));

    expect(await passwordLogin(URL, 'connor', 'pw')).toEqual(login(null));
    const { url, init, body } = jsonCall();
    expect(url).toBe(`${URL}/api/v2/auth/login`);
    expect(body).toEqual({ username: 'connor', password: 'pw' });
    expect(init?.headers).toMatchObject({
      'X-Silo-Device-Name': 'Tracearr',
      'X-Silo-Device-Platform': 'Tracearr',
      'User-Agent': 'Tracearr',
    });
  });
});

describe('logout', () => {
  it('posts the bearer to /auth/logout and takes an empty 204', async () => {
    mockFetchText.mockResolvedValue('');

    await logout(URL, TOKEN);

    const [url, init] = mockFetchText.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/api/v2/auth/logout`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a 500', httpError(500)],
    ['a network error', new TypeError('fetch failed')],
  ])('resolves on %s and warns without the token', async (_name, error) => {
    mockFetchText.mockRejectedValue(error);

    await expect(logout(URL, TOKEN)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(TOKEN);
  });
});

describe('primaryProfile', () => {
  it('picks the primary profile with no query and no profile headers', async () => {
    mockFetchJson.mockResolvedValue({
      items: [
        { id: 'p-2', is_primary: false, has_pin: false },
        { id: 'p-1', is_primary: true, has_pin: true },
      ],
    });

    expect(await primaryProfile(URL, TOKEN)).toEqual({ id: 'p-1', hasPin: true });
    const { url, init } = jsonCall();
    expect(url).toBe(`${URL}/api/v2/profiles`);
    expect(init?.headers).not.toHaveProperty('X-Profile-Id');
    expect(init?.headers).not.toHaveProperty('X-Profile-Token');
  });

  it('answers null for an account with no profile', async () => {
    mockFetchJson.mockResolvedValue({ items: [] });

    expect(await primaryProfile(URL, TOKEN)).toBeNull();
  });
});

describe('verifyPin', () => {
  it('answers wrong when the PIN does not match', async () => {
    mockFetchJson.mockResolvedValue({ valid: false, expires_at: null });

    expect(await verifyPin(URL, TOKEN, 'p-1', '0000')).toBe('wrong');
    const { url, body } = jsonCall();
    expect(url).toBe(`${URL}/api/v2/profiles/p-1/verify-pin`);
    expect(body).toEqual({ pin: '0000' });
  });

  it('returns the profile token on a match', async () => {
    mockFetchJson.mockResolvedValue({ valid: true, profile_token: 'pt-1', expires_at: null });

    expect(await verifyPin(URL, TOKEN, 'p-1', '1234')).toEqual({ profileToken: 'pt-1' });
  });

  it('answers locked to a 429 after one request', async () => {
    mockFetchJson.mockRejectedValue(httpError(429));

    expect(await verifyPin(URL, TOKEN, 'p-1', '1234')).toBe('locked');
    expect(mockFetchJson).toHaveBeenCalledOnce();
  });
});

describe('createTracearrKey', () => {
  beforeEach(() => {
    mockFetchJson.mockResolvedValue({ id: '7', key: 'silo_key' });
  });

  it('creates the Tracearr key as the named profile', async () => {
    expect(await createTracearrKey(URL, TOKEN, { profileId: 'p-1', profileToken: null })).toEqual({
      id: '7',
      key: 'silo_key',
    });
    const { url, init, body } = jsonCall();
    expect(url).toBe(`${URL}/api/v2/api-keys`);
    expect(body).toEqual({ label: 'Tracearr', scopes: [...SILO_KEY_SCOPES] });
    expect(init?.headers).toMatchObject({ 'X-Profile-Id': 'p-1' });
    expect(init?.headers).not.toHaveProperty('X-Profile-Token');
  });

  it('sends the profile token when the proof has one', async () => {
    await createTracearrKey(URL, TOKEN, { profileId: 'p-1', profileToken: 'pt-1' });

    expect(jsonCall().init?.headers).toMatchObject({
      'X-Profile-Id': 'p-1',
      'X-Profile-Token': 'pt-1',
    });
  });

  it('sends no profile headers for an account with no profile', async () => {
    await createTracearrKey(URL, TOKEN, { profileId: null, profileToken: null });

    expect(jsonCall().init?.headers).not.toHaveProperty('X-Profile-Id');
  });
});

describe('deleteKey', () => {
  const proof = { profileId: 'p-1', profileToken: 'pt-1' };

  it('deletes the key with the profile headers and takes an empty 204', async () => {
    mockFetchText.mockResolvedValue('');

    expect(await deleteKey(URL, TOKEN, proof, '7')).toBe('deleted');
    const [url, init] = mockFetchText.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/api/v2/api-keys/7`);
    expect(init?.method).toBe('DELETE');
    expect(init?.headers).toMatchObject({ 'X-Profile-Id': 'p-1', 'X-Profile-Token': 'pt-1' });
  });

  it('answers not-found to a 404 and throws on a 403', async () => {
    mockFetchText.mockRejectedValueOnce(httpError(404));
    mockFetchText.mockRejectedValueOnce(httpError(403));

    expect(await deleteKey(URL, TOKEN, proof, '7')).toBe('not-found');
    await expect(deleteKey(URL, TOKEN, proof, '7')).rejects.toBeInstanceOf(HttpClientError);
  });
});

describe('pairingOffered', () => {
  it.each([
    [{ state: 'available', session_binding: true }, true],
    [{ state: 'available', session_binding: false }, false],
    [{ state: 'disabled', session_binding: true }, false],
  ])('answers %j as %s', async (capability, offered) => {
    mockFetchJson.mockResolvedValue(capability);

    expect(await pairingOffered(URL)).toBe(offered);
    expect(jsonCall().url).toBe(`${URL}/api/v2/auth/device/capability`);
  });

  it('answers false on an error', async () => {
    mockFetchJson.mockRejectedValue(httpError(500));

    expect(await pairingOffered(URL)).toBe(false);
  });
});

describe('passwordLoginOffered', () => {
  it('answers the password_login flag', async () => {
    mockFetchJson.mockResolvedValueOnce({ password_login: true, items: [] });
    mockFetchJson.mockResolvedValueOnce({ password_login: false, items: [] });

    expect(await passwordLoginOffered(URL)).toBe(true);
    expect(await passwordLoginOffered(URL)).toBe(false);
    expect(jsonCall().url).toBe(`${URL}/api/v2/auth/providers`);
  });

  it('answers false on an error', async () => {
    mockFetchJson.mockRejectedValue(new TypeError('fetch failed'));

    expect(await passwordLoginOffered(URL)).toBe(false);
  });
});
