import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type * as ApiModule from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const { ApiError, imageProxyUrl } = await vi.importActual<typeof ApiModule>('@/lib/api');
  return {
    api: { auth: { me: vi.fn() } },
    ApiError,
    imageProxyUrl,
    AUTH_STATE_CHANGE_EVENT: 'tracearr:auth-state-change',
    BASE_URL: '/',
  };
});

vi.mock('@/lib/authClient', () => ({
  authClient: {
    signOut: vi.fn().mockResolvedValue(undefined),
    admin: { stopImpersonating: vi.fn().mockResolvedValue({ data: {}, error: null }) },
  },
}));

import { api, ApiError, AUTH_STATE_CHANGE_EVENT, BASE_URL } from '@/lib/api';
import { authClient } from '@/lib/authClient';
import { AuthProvider, useAuth } from './useAuth';

const mockMe = vi.mocked(api.auth.me);
const mockSignOut = vi.mocked(authClient.signOut);
const noSession = () => new ApiError('Unauthorized', 401);
const alice = {
  userId: 'u1',
  username: 'alice',
  email: null,
  thumbnail: null,
  role: 'owner' as const,
  aggregateTrustScore: 100,
  serverIds: [] as string[],
};

const originalLocation = window.location;

/** jsdom doesn't support real navigation, so href assignment is tracked via a spy setter. */
function mockLocation(pathname: string) {
  const setHref = vi.fn();
  Object.defineProperty(window, 'location', {
    value: {
      ...originalLocation,
      pathname,
      get href() {
        return pathname;
      },
      set href(value: string) {
        setHref(value);
      },
    },
    writable: true,
    configurable: true,
  });
  return setHref;
}

/** Refetch and let TanStack deliver the observer update, which lands a macrotask later. */
async function refetch(result: { current: { refetch: () => Promise<unknown> } }) {
  await act(async () => {
    await result.current.refetch();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  }
  return Wrapper;
}

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('exposes the frozen { user, isLoading, isAuthenticated, isSignedOut, logout, refetch } shape', async () => {
    mockMe.mockResolvedValue({
      userId: 'u1',
      username: 'alice',
      email: 'alice@example.com',
      thumbnail: null,
      role: 'owner',
      aggregateTrustScore: 100,
      serverIds: ['s1'],
    });

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(Object.keys(result.current).sort()).toEqual(
      ['user', 'isLoading', 'isAuthenticated', 'isSignedOut', 'logout', 'refetch'].sort()
    );
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.username).toBe('alice');
    expect(typeof result.current.logout).toBe('function');
    expect(typeof result.current.refetch).toBe('function');
  });

  it.each([
    ['a tofa preset', '/api/v1/profiles/avatars/astronaut.png'],
    ['a tofa upload', 'https://api.tofa.tv/avatars/u1.jpg'],
  ])('loads %s picture through the image proxy', async (_kind, thumbnail) => {
    mockMe.mockResolvedValue({ ...alice, thumbnail, thumbnailServerId: 's-tofa' });

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.user).not.toBeNull());
    const url = new URL(result.current.user?.thumbUrl ?? '', 'http://tracearr.test');
    expect(url.pathname).toBe('/api/v1/images/proxy');
    expect(url.searchParams.get('server')).toBe('s-tofa');
    expect(url.searchParams.get('url')).toBe(thumbnail);
  });

  it('loads a plex.tv picture straight from plex.tv', async () => {
    const thumbnail = 'https://plex.tv/users/abc/avatar?c=1';
    mockMe.mockResolvedValue({ ...alice, thumbnail, thumbnailServerId: null });

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.user).not.toBeNull());
    expect(result.current.user?.thumbUrl).toBe(thumbnail);
  });

  it("loads an OIDC provider's picture through the server", async () => {
    mockMe.mockResolvedValue({
      ...alice,
      thumbnail: 'https://idp.example.com/avatars/alice.png',
      thumbnailServerId: null,
    });

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.user).not.toBeNull());
    expect(result.current.user?.thumbUrl).toBe('/api/v1/images/account');
  });

  it('reports unauthenticated when the session lookup fails', async () => {
    mockMe.mockRejectedValue(noSession());

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it('keeps the signed-in user when the lookup fails on the network', async () => {
    mockMe.mockResolvedValueOnce(alice).mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    await refetch(result);

    expect(mockMe).toHaveBeenCalledTimes(2);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.username).toBe('alice');
  });

  it('keeps the signed-in user when a proxy answers the lookup with a 5xx', async () => {
    mockMe.mockResolvedValueOnce(alice).mockRejectedValue(new ApiError('Bad Gateway', 502));

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    await refetch(result);

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.username).toBe('alice');
  });

  it('signs the user out when the lookup comes back 401', async () => {
    mockMe.mockResolvedValueOnce(alice).mockRejectedValue(noSession());

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    await refetch(result);

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it('logout calls authClient.signOut and clears the cached auth state', async () => {
    mockMe.mockResolvedValueOnce(alice);
    // Session is gone once signOut clears the cookie - the invalidated refetch sees no session.
    mockMe.mockRejectedValueOnce(noSession());

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);

    await act(async () => {
      await result.current.logout();
    });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.isAuthenticated).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it('logout drops everything the last person loaded, keeping only the auth query', async () => {
    mockMe.mockResolvedValueOnce(alice);
    mockMe.mockRejectedValueOnce(noSession());
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['stats', 'me', 'UTC'], { daysWatched: 9 });
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.logout();
    });

    expect(client.getQueryData(['stats', 'me', 'UTC'])).toBeUndefined();
    await waitFor(() => expect(result.current.isSignedOut).toBe(true));
  });

  it('is not signed out when the lookup fails on the network', async () => {
    mockMe.mockRejectedValue(new Error('network down'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useAuth(), { wrapper: wrap });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isSignedOut).toBe(false);
  });

  it('carries impersonatedBy and never a trust score for the member being viewed', async () => {
    mockMe.mockResolvedValueOnce({
      ...alice,
      role: 'member' as const,
      aggregateTrustScore: undefined,
      impersonatedBy: 'owner-1',
    });

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.user?.impersonatedBy).toBe('owner-1');
    expect(result.current.user).not.toHaveProperty('trustScore');
  });

  it('logout while viewing as someone stops viewing instead of signing the owner out', async () => {
    const setHref = mockLocation('/');
    mockSignOut.mockClear();
    mockMe.mockResolvedValueOnce({ ...alice, role: 'member' as const, impersonatedBy: 'owner-1' });

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.logout();
    });

    expect(vi.mocked(authClient.admin.stopImpersonating)).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(setHref).toHaveBeenCalledWith(`${BASE_URL}users`);
  });

  it('skips the redirect when already on the login page', async () => {
    const setHref = mockLocation(`${BASE_URL}login`);
    mockMe.mockRejectedValue(noSession());

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      window.dispatchEvent(new Event(AUTH_STATE_CHANGE_EVENT));
    });

    expect(setHref).not.toHaveBeenCalled();
  });

  it('redirects to login when a 401 fires from elsewhere in the app', async () => {
    const setHref = mockLocation('/dashboard');
    mockMe.mockRejectedValue(noSession());

    const { result } = renderHook(() => useAuth(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      window.dispatchEvent(new Event(AUTH_STATE_CHANGE_EVENT));
    });

    expect(setHref).toHaveBeenCalledWith(`${BASE_URL}login`);
  });
});
