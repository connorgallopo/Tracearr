import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';
import { createMockRedis } from '@tracearr/test-utils';

vi.mock('../../services/mediaServer/silo/auth.js', () => ({
  siloBinding: vi.fn(() => ({ binding: 'binding-1', secret: 'secret-1' })),
  startPairing: vi.fn(),
  pollPairing: vi.fn(),
  cancelPairing: vi.fn(),
  logout: vi.fn(),
}));

import {
  cancelPairing,
  logout,
  pollPairing,
  startPairing,
} from '../../services/mediaServer/silo/auth.js';
import { GET_AND_DELETE_SCRIPT, setSharedRedis } from '../redisShared.js';
import {
  PIN_WAIT_SECONDS,
  claimParked,
  endPairing,
  holdLogin,
  openPairing,
  pairingLink,
  parkLogin,
  pollStoredPairing,
  readPairing,
  returnParked,
} from '../siloPairing.js';

const URL = 'http://silo.lan:8090';
const LOGIN = {
  accessToken: 'silo-access-1',
  user: { id: 'u-1', username: 'connor', email: null, role: 'admin' },
  profileId: 'p-1',
};

let redis: Redis;

const key = (handle: string) => REDIS_KEYS.SILO_PAIRING(handle);

async function open(publicUrl: string | null = null) {
  const start = await openPairing({
    purpose: 'add-server',
    ownerId: 'owner-1',
    name: 'Silo',
    url: URL,
    publicUrl,
  });
  const state = await readPairing(start.handle);
  if (!state) throw new Error('state not stored');
  return { start, state };
}

async function openParked() {
  const { start, state } = await open();
  await parkLogin(start.handle, state, LOGIN);
  return start.handle;
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-21T10:00:00Z') });
  redis = createMockRedis();
  setSharedRedis(redis);
  vi.mocked(startPairing).mockResolvedValue({
    deviceCode: 'dc-1',
    userCode: '4821-7730',
    verificationUriComplete: `${URL}/activate?code=48217730`,
    expiresIn: 900,
    interval: 5,
  });
  vi.mocked(logout).mockResolvedValue();
  vi.mocked(cancelPairing).mockResolvedValue();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('openPairing', () => {
  it('stores the secrets for expires_in and returns only what the browser may see', async () => {
    const { start } = await open();

    expect(start).toEqual({
      handle: expect.stringMatching(/^[0-9a-f]{64}$/),
      userCode: '4821-7730',
      link: `${URL}/activate?code=48217730`,
      expiresIn: 900,
      interval: 5,
    });
    expect(JSON.stringify(start)).not.toContain('dc-1');
    expect(JSON.stringify(start)).not.toContain('secret-1');
    expect(startPairing).toHaveBeenCalledWith(URL, 'binding-1');
    expect(await redis.ttl(key(start.handle))).toBe(900);
    expect(JSON.parse((await redis.get(key(start.handle))) ?? '{}')).toMatchObject({
      deviceCode: 'dc-1',
      secret: 'secret-1',
      ownerId: 'owner-1',
    });
  });
});

describe('pairingLink', () => {
  it('swaps the origin for the public URL and keeps the path and query', () => {
    expect(
      pairingLink('http://silo.lan:8090/activate?code=12345678', 'https://silo.example.com/base')
    ).toBe('https://silo.example.com/activate?code=12345678');
    expect(pairingLink('http://silo.lan:8090/activate?code=12345678', null)).toBe(
      'http://silo.lan:8090/activate?code=12345678'
    );
  });
});

describe('pollStoredPairing', () => {
  it('deletes the state when Silo says the request is gone', async () => {
    const { start, state } = await open();
    vi.mocked(pollPairing).mockResolvedValue({ status: 'gone' });

    expect(await pollStoredPairing(start.handle, state)).toEqual({ status: 'gone' });
    expect(await redis.exists(key(start.handle))).toBe(0);
    expect(pollPairing).toHaveBeenCalledWith(URL, 'dc-1', 'secret-1');
  });

  it('keeps a pending state and moves its TTL to a later expires_at only', async () => {
    const { start, state } = await open();
    const pending = (seconds: number) => ({
      status: 'pending' as const,
      opened: true,
      expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    });

    vi.mocked(pollPairing).mockResolvedValueOnce(pending(1200));
    await pollStoredPairing(start.handle, state);
    expect(await redis.ttl(key(start.handle))).toBe(1200);

    vi.mocked(pollPairing).mockResolvedValueOnce(pending(300));
    await pollStoredPairing(start.handle, state);
    expect(await redis.ttl(key(start.handle))).toBe(1200);
  });
});

describe('holdLogin', () => {
  it('logs out once when the work resolves', async () => {
    expect(await holdLogin(URL, LOGIN, async () => 'done')).toBe('done');
    expect(logout).toHaveBeenCalledExactlyOnceWith(URL, LOGIN.accessToken);
  });

  it('logs out once when the work throws, and rethrows', async () => {
    const failure = new Error('key call failed');

    await expect(
      holdLogin(URL, LOGIN, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(logout).toHaveBeenCalledOnce();
  });

  it('leaves a parked login signed in', async () => {
    await holdLogin(URL, LOGIN, async (park) => park());

    expect(logout).not.toHaveBeenCalled();
  });
});

describe('parked logins', () => {
  it('claims with the Lua get-and-delete, not GETDEL', async () => {
    const handle = await openParked();
    const evalSpy = vi.spyOn(redis, 'eval');
    const getdelSpy = vi.spyOn(redis, 'getdel');

    await claimParked(handle);

    expect(evalSpy).toHaveBeenCalledWith(GET_AND_DELETE_SCRIPT, 1, key(handle));
    expect(getdelSpy).not.toHaveBeenCalled();
  });

  it('keeps the login for the PIN wait plus a minute', async () => {
    const handle = await openParked();

    expect(await redis.ttl(key(handle))).toBe(PIN_WAIT_SECONDS + 60);
    expect((await readPairing(handle))?.login).toEqual(LOGIN);
  });

  it('logs out a login still parked when the PIN wait ends, and deletes the state', async () => {
    const handle = await openParked();

    await vi.advanceTimersByTimeAsync(PIN_WAIT_SECONDS * 1000);

    expect(logout).toHaveBeenCalledExactlyOnceWith(URL, LOGIN.accessToken);
    expect(await redis.exists(key(handle))).toBe(0);
  });

  it('logs out once at the PIN wait after a wrong PIN put the login back', async () => {
    const handle = await openParked();
    await vi.advanceTimersByTimeAsync(100_000);
    const claimed = await claimParked(handle);
    if (!claimed) throw new Error('not parked');
    await returnParked(handle, { ...claimed, wrongPins: 1 });

    await vi.advanceTimersByTimeAsync(PIN_WAIT_SECONDS * 1000 - 100_000);

    expect(logout).toHaveBeenCalledOnce();
    expect(await redis.exists(key(handle))).toBe(0);
  });

  it('leaves a claimed login to its claimer', async () => {
    const handle = await openParked();
    await claimParked(handle);

    await vi.advanceTimersByTimeAsync(PIN_WAIT_SECONDS * 1000);

    expect(logout).not.toHaveBeenCalled();
  });

  it('arms no second timer for a login parked again', async () => {
    const handle = await openParked();
    await vi.advanceTimersByTimeAsync(100_000);
    const claimed = await claimParked(handle);
    if (!claimed) throw new Error('not parked');
    await returnParked(handle, claimed);
    await parkLogin(handle, claimed, LOGIN);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(PIN_WAIT_SECONDS * 1000);
    expect(logout).toHaveBeenCalledOnce();
  });

  it('claims a state once and puts it back with its remaining TTL', async () => {
    const handle = await openParked();
    await vi.advanceTimersByTimeAsync(100_000);

    const claimed = await claimParked(handle);
    expect(claimed?.login).toEqual(LOGIN);
    expect(await claimParked(handle)).toBeNull();

    if (!claimed) throw new Error('not parked');
    await returnParked(handle, claimed);
    expect(await redis.ttl(key(handle))).toBe(PIN_WAIT_SECONDS + 60 - 100);
  });
});

describe('endPairing', () => {
  it('cancels the request and logs out a parked login', async () => {
    const handle = await openParked();

    await endPairing(handle);

    expect(cancelPairing).toHaveBeenCalledWith(URL, 'dc-1');
    expect(logout).toHaveBeenCalledExactlyOnceWith(URL, LOGIN.accessToken);
    expect(await redis.exists(key(handle))).toBe(0);
  });

  it('only cancels an unparked request', async () => {
    const { start } = await open();

    await endPairing(start.handle);

    expect(cancelPairing).toHaveBeenCalledOnce();
    expect(logout).not.toHaveBeenCalled();
    expect(await redis.exists(key(start.handle))).toBe(0);
  });

  it('does nothing for a missing handle and never throws', async () => {
    await expect(endPairing('0'.repeat(64))).resolves.toBeUndefined();
    vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('redis down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(endPairing('1'.repeat(64))).resolves.toBeUndefined();

    expect(cancelPairing).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });
});
