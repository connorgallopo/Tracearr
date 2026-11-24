import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSiloPairing } from './useSiloPairing';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const $fetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/authClient', () => ({ authClient: { $fetch } }));

const started = {
  handle: 'h'.repeat(43),
  userCode: '12345678',
  link: 'https://silo.example.com/activate?code=12345678',
  expiresIn: 600,
  interval: 1,
};
const body = { purpose: 'add-server', url: 'http://10.0.0.5:8090', name: 'Basement' } as const;

const checks = () => $fetch.mock.calls.filter(([url]) => url === '/silo/pair/check');

function answer(check: object) {
  return { data: check, error: null };
}

function renderPairing() {
  const client = new QueryClient();
  return renderHook(() => useSiloPairing(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

async function startPairing(check: (url: string) => Promise<unknown>) {
  $fetch.mockImplementation((url: string) =>
    url === '/silo/pair/start' ? Promise.resolve(answer(started)) : check(url)
  );
  const view = renderPairing();
  act(() => view.result.current.start(body));
  await waitFor(() => expect(view.result.current.pairing).toEqual(started));
  return view;
}

describe('useSiloPairing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with the body and polls on the interval Silo gave', async () => {
    const view = await startPairing(() =>
      Promise.resolve(answer({ status: 'pending', opened: false }))
    );

    expect($fetch).toHaveBeenCalledWith('/silo/pair/start', { method: 'POST', body });
    await waitFor(() => expect(checks()).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(checks()).toHaveLength(2));
    expect(checks()[0]).toEqual([
      '/silo/pair/check',
      { method: 'POST', body: { handle: started.handle } },
    ]);
    expect(view.result.current.check).toEqual({ status: 'pending', opened: false });
  });

  it('never starts a second check, or a PIN, while one check is in flight', async () => {
    const view = await startPairing(() => new Promise(() => undefined));

    await waitFor(() => expect(checks()).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    act(() => view.result.current.submitPin('1234'));

    expect(checks()).toHaveLength(1);
  });

  it('stops polling on needs-pin and sends the PIN as the next check', async () => {
    let next: object = { status: 'needs-pin', wrongPin: false };
    const view = await startPairing(() => Promise.resolve(answer(next)));

    await waitFor(() => expect(view.result.current.check?.status).toBe('needs-pin'));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(checks()).toHaveLength(1);

    next = { status: 'needs-pin', wrongPin: true };
    act(() => view.result.current.submitPin('1234'));
    await waitFor(() =>
      expect(view.result.current.check).toEqual({ status: 'needs-pin', wrongPin: true })
    );
    expect(checks()[1]).toEqual([
      '/silo/pair/check',
      { method: 'POST', body: { handle: started.handle, pin: '1234' } },
    ]);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(checks()).toHaveLength(2);
  });

  it('keeps polling through a dropped request and stops on a refusal with its message', async () => {
    let attempt = 0;
    const view = await startPairing(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({
        data: null,
        error: { status: 400, message: 'This server is already connected' },
      });
    });

    await waitFor(() => expect(checks()).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(view.result.current.error).toBe('This server is already connected'));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(checks()).toHaveLength(2);
  });

  it('cancels a live handle on unmount and not one that has finished', async () => {
    const view = await startPairing(() =>
      Promise.resolve(answer({ status: 'pending', opened: true }))
    );
    await waitFor(() => expect(view.result.current.check?.status).toBe('pending'));

    view.unmount();
    expect($fetch).toHaveBeenCalledWith('/silo/pair/cancel', {
      method: 'POST',
      body: { handle: started.handle },
    });

    $fetch.mockClear();
    const done = await startPairing(() => Promise.resolve(answer({ status: 'not-admin' })));
    await waitFor(() => expect(done.result.current.check?.status).toBe('not-admin'));
    done.unmount();
    expect($fetch).not.toHaveBeenCalledWith('/silo/pair/cancel', expect.anything());
  });

  it('cancels again when a check in flight at unmount comes back parked for a PIN', async () => {
    let resolveCheck: (value: unknown) => void = () => undefined;
    const view = await startPairing((url) =>
      url === '/silo/pair/check'
        ? new Promise((resolve) => {
            resolveCheck = resolve;
          })
        : Promise.resolve(answer({ status: 'canceled' }))
    );
    await waitFor(() => expect(checks()).toHaveLength(1));

    view.unmount();
    const cancels = () => $fetch.mock.calls.filter(([url]) => url === '/silo/pair/cancel');
    expect(cancels()).toHaveLength(1);

    resolveCheck(answer({ status: 'needs-pin', wrongPin: false }));
    await waitFor(() => expect(cancels()).toHaveLength(2));
    expect(cancels()[1]).toEqual([
      '/silo/pair/cancel',
      { method: 'POST', body: { handle: started.handle } },
    ]);
  });
});
