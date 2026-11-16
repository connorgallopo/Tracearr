import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type * as ApiModule from '@/lib/api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const auth = vi.hoisted(() => ({
  initiateTofa: vi.fn(),
  initiateTofaLink: vi.fn(),
  checkTofa: vi.fn(),
  connectTofa: vi.fn(),
  addTofaServer: vi.fn(),
}));
vi.mock('@/lib/api', async () => ({
  api: { auth },
  ApiError: (await vi.importActual<typeof ApiModule>('@/lib/api')).ApiError,
}));

import { toast } from 'sonner';
import { SIGN_IN_ERROR_CODES } from '@tracearr/shared';
import { ApiError } from '@/lib/api';
import { useTofaSignIn } from './useTofaSignIn';

const popup = { closed: false, close: vi.fn(), location: { assign: vi.fn() } };
const server = { id: 'srv-1', name: 'Attic', online: true, localAddress: 'http://10.0.0.5:33333' };

async function startWaiting(interval = 5) {
  auth.initiateTofa.mockResolvedValue({
    handle: 'h-1',
    verificationUri: 'https://app.tofa.tv/link?code=ABCD-EFGH',
    userCode: 'ABCD-EFGH',
    expiresIn: 600,
    interval,
  });
  const hook = renderHook(() => useTofaSignIn({ purpose: 'sign-in' }));
  await act(() => hook.result.current.start());
  return hook;
}

async function reachPicker() {
  auth.checkTofa.mockResolvedValue({
    status: 'select-server',
    tempToken: 'temp-1',
    username: 'dana',
    servers: [server],
  });
  const hook = await startWaiting();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  return hook;
}

describe('useTofaSignIn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    auth.checkTofa.mockReset();
    popup.closed = false;
    vi.spyOn(window, 'open').mockReturnValue(popup as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls at the interval and backs off on slow down', async () => {
    auth.checkTofa
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'slow_down' })
      .mockResolvedValue({ status: 'pending' });
    const { result } = await startWaiting(5);

    expect(window.open).toHaveBeenCalledWith('about:blank', 'tofa_auth', expect.any(String));
    expect(popup.location.assign).toHaveBeenCalledWith('https://app.tofa.tv/link?code=ABCD-EFGH');
    expect(result.current.step).toBe('waiting');
    expect(result.current.userCode).toBe('ABCD-EFGH');

    await act(() => vi.advanceTimersByTimeAsync(4999));
    expect(auth.checkTofa).toHaveBeenCalledTimes(0);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(auth.checkTofa).toHaveBeenCalledTimes(1);
    expect(auth.checkTofa).toHaveBeenCalledWith({ handle: 'h-1' });

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(auth.checkTofa).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(9999));
    expect(auth.checkTofa).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(auth.checkTofa).toHaveBeenCalledTimes(3);

    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(auth.checkTofa).toHaveBeenCalledTimes(4);
  });

  it('stops polling after cancel', async () => {
    auth.checkTofa.mockResolvedValue({ status: 'pending' });
    const { result } = await startWaiting();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(auth.checkTofa).toHaveBeenCalledTimes(1);

    act(() => result.current.cancel());
    await act(() => vi.advanceTimersByTimeAsync(60000));

    expect(auth.checkTofa).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalled();
    expect(result.current.step).toBe('idle');
  });

  it('stops polling on unmount', async () => {
    auth.checkTofa.mockResolvedValue({ status: 'pending' });
    const { unmount } = await startWaiting();

    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60000));

    expect(auth.checkTofa).not.toHaveBeenCalled();
  });

  it('unmount during start does not begin polling', async () => {
    let resolveStart: (value: object) => void = () => {};
    auth.initiateTofa.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      })
    );
    const { result, unmount } = renderHook(() => useTofaSignIn({ purpose: 'sign-in' }));
    let started: Promise<void> = Promise.resolve();
    act(() => {
      started = result.current.start();
    });

    unmount();
    resolveStart({
      handle: 'h-1',
      verificationUri: 'u',
      userCode: 'c',
      expiresIn: 600,
      interval: 5,
    });
    await act(() => started);
    await act(() => vi.advanceTimersByTimeAsync(60000));

    expect(auth.checkTofa).not.toHaveBeenCalled();
  });

  it('a failed start or check shows inline instead of a toast', async () => {
    auth.initiateTofa.mockRejectedValueOnce(new Error('Invalid claim code'));
    const { result } = renderHook(() => useTofaSignIn({ purpose: 'sign-in' }));
    await act(() => result.current.start());

    expect(result.current.step).toBe('idle');
    expect(result.current.error).toEqual({ kind: 'failed', message: 'Invalid claim code' });

    auth.initiateTofa.mockResolvedValue({
      handle: 'h-1',
      verificationUri: 'u',
      userCode: 'c',
      expiresIn: 600,
      interval: 5,
    });
    auth.checkTofa.mockRejectedValue(
      new ApiError('Failed to check tofa sign-in', 500, {
        message: 'Failed to check tofa sign-in',
      })
    );
    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(result.current.error).toEqual({
      kind: 'failed',
      message: 'Failed to check tofa sign-in',
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('checks once more after a failed poll', async () => {
    auth.checkTofa
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ status: 'pending' })
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'));
    const { result } = await startWaiting();

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.step).toBe('waiting');
    expect(result.current.error).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(auth.checkTofa).toHaveBeenCalledTimes(3);
    expect(result.current.step).toBe('waiting');

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(auth.checkTofa).toHaveBeenCalledTimes(4);
    expect(result.current.step).toBe('idle');
    expect(result.current.error).toEqual({ kind: 'failed', message: 'fetch failed' });
  });

  it('a refused member sees the refusal, not an expired code', async () => {
    const refusal = 'Sign-in is not available for this account.';
    auth.checkTofa
      .mockRejectedValueOnce(new ApiError(refusal, 403, { message: refusal }))
      .mockResolvedValue({ status: 'expired' });
    const { result } = await startWaiting();

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.step).toBe('idle');
    expect(result.current.error).toEqual({ kind: 'failed', message: refusal });
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(auth.checkTofa).toHaveBeenCalledTimes(1);
  });

  it('ends at once when the check says the person is not permitted', async () => {
    auth.checkTofa.mockRejectedValue(
      new ApiError('Not permitted', 403, { code: SIGN_IN_ERROR_CODES.notPermitted })
    );
    const { result } = await startWaiting();

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.step).toBe('idle');
    expect(toast.error).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(auth.checkTofa).toHaveBeenCalledTimes(1);
  });

  it('a sign-in that fails to finish leaves the waiting state with the reason', async () => {
    auth.initiateTofa.mockResolvedValue({
      handle: 'h-1',
      verificationUri: 'u',
      userCode: 'c',
      expiresIn: 600,
      interval: 5,
    });
    auth.checkTofa.mockResolvedValue({ status: 'signed-in', user: { id: 'u-1' } });
    const onSignedIn = vi.fn().mockRejectedValue(new Error('Session refresh failed'));
    const { result } = renderHook(() => useTofaSignIn({ purpose: 'sign-in', onSignedIn }));
    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(result.current.step).toBe('idle');
    expect(result.current.error).toEqual({ kind: 'failed', message: 'Session refresh failed' });
  });

  it('reports expired inline', async () => {
    auth.checkTofa.mockResolvedValue({ status: 'expired' });
    const { result } = await startWaiting();
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(result.current.step).toBe('idle');
    expect(result.current.error).toEqual({ kind: 'expired' });
    await act(() => vi.advanceTimersByTimeAsync(60000));
    expect(auth.checkTofa).toHaveBeenCalledTimes(1);
  });

  it('lists the owned servers with who signed in', async () => {
    const { result } = await reachPicker();

    expect(result.current.step).toBe('select-server');
    expect(result.current.username).toBe('dana');
    expect(result.current.servers).toEqual([server]);
    expect(popup.close).toHaveBeenCalled();
  });

  it('shows timed out when connect answers expired', async () => {
    auth.connectTofa.mockResolvedValue({ status: 'expired' });
    const { result } = await reachPicker();

    await act(() => result.current.connect('srv-1'));

    expect(auth.connectTofa).toHaveBeenCalledWith({ tempToken: 'temp-1', serverId: 'srv-1' });
    expect(result.current.error).toEqual({ kind: 'timed-out' });
  });

  it('marks the row unreachable and retries with the typed address', async () => {
    const onSignedIn = vi.fn().mockResolvedValue(undefined);
    auth.checkTofa.mockResolvedValue({
      status: 'select-server',
      tempToken: 'temp-1',
      username: 'dana',
      servers: [server],
    });
    auth.initiateTofa.mockResolvedValue({
      handle: 'h-1',
      verificationUri: 'https://app.tofa.tv/link?code=X',
      userCode: 'X',
      expiresIn: 600,
      interval: 5,
    });
    const { result } = renderHook(() =>
      useTofaSignIn({ purpose: 'sign-in', claimCode: 'CLAIM', onSignedIn })
    );
    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(5000));
    auth.connectTofa.mockResolvedValueOnce({
      status: 'unreachable',
      address: 'http://10.0.0.5:33333',
    });

    await act(() => result.current.connect('srv-1'));
    expect(result.current.unreachable).toEqual({
      serverId: 'srv-1',
      address: 'http://10.0.0.5:33333',
    });

    auth.connectTofa.mockResolvedValueOnce({ status: 'signed-in', user: { id: 'u-1' } });
    await act(() => result.current.connect('srv-1', 'http://attic.lan:33333'));

    expect(auth.connectTofa).toHaveBeenLastCalledWith({
      tempToken: 'temp-1',
      serverId: 'srv-1',
      url: 'http://attic.lan:33333',
      claimCode: 'CLAIM',
    });
    expect(onSignedIn).toHaveBeenCalledWith('Attic');
  });

  it('disables Connect while connecting', async () => {
    let finish: (value: unknown) => void = () => {};
    auth.connectTofa.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const { result } = await reachPicker();

    act(() => {
      void result.current.connect('srv-1');
      void result.current.connect('srv-1');
    });

    expect(result.current.connectingTo).toBe('srv-1');
    expect(auth.connectTofa).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: 'expired' }));
    expect(result.current.connectingTo).toBeNull();
  });

  it('shows a refused connect as a connect error', async () => {
    auth.connectTofa.mockRejectedValue(new Error('That tofa server is already connected'));
    const { result } = await reachPicker();

    await act(() => result.current.connect('srv-1'));

    expect(result.current.error).toEqual({
      kind: 'connect-failed',
      message: 'That tofa server is already connected',
    });
    expect(result.current.step).toBe('select-server');
  });

  it('hands an added server to the caller and starts over', async () => {
    const onAdded = vi.fn();
    const added = { id: 'tracearr-1', name: 'Attic' };
    auth.addTofaServer.mockResolvedValue({ status: 'added', server: added, canStopStreams: true });
    auth.checkTofa.mockResolvedValue({
      status: 'select-server',
      tempToken: 'temp-1',
      username: 'dana',
      servers: [server],
    });
    auth.initiateTofa.mockResolvedValue({
      handle: 'h-1',
      verificationUri: 'https://app.tofa.tv/link?code=X',
      userCode: 'X',
      expiresIn: 600,
      interval: 5,
    });
    const { result } = renderHook(() => useTofaSignIn({ purpose: 'add-server', onAdded }));
    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(5000));

    await act(() => result.current.connect('srv-1'));

    expect(auth.initiateTofa).toHaveBeenCalledWith('add-server');
    expect(auth.addTofaServer).toHaveBeenCalledWith({ tempToken: 'temp-1', serverId: 'srv-1' });
    expect(onAdded).toHaveBeenCalledWith({ server: added, canStopStreams: true });
    expect(result.current.step).toBe('idle');
  });

  it('starts a link for its server and hands the approval to the caller', async () => {
    const onLinked = vi.fn();
    auth.checkTofa.mockResolvedValue({ status: 'linked' });
    auth.initiateTofaLink.mockResolvedValue({
      handle: 'h-1',
      verificationUri: 'https://app.tofa.tv/link?code=X',
      userCode: 'X',
      expiresIn: 600,
      interval: 5,
    });
    const { result } = renderHook(() =>
      useTofaSignIn({ purpose: { link: 'tracearr-1' }, onLinked })
    );
    await act(() => result.current.start());
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(auth.initiateTofaLink).toHaveBeenCalledWith('tracearr-1');
    expect(onLinked).toHaveBeenCalled();
    expect(result.current.step).toBe('idle');
  });
});
