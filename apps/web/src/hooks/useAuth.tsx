import { createContext, useContext, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AuthUser } from '@tracearr/shared';
import { api, tokenStorage, AUTH_STATE_CHANGE_EVENT } from '@/lib/api';

interface UserProfile extends AuthUser {
  email: string | null;
  thumbUrl: string | null;
  trustScore: number;
  hasPassword?: boolean;
  hasPlexLinked?: boolean;
}

interface AuthContextValue {
  user: UserProfile | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  logout: () => Promise<void>;
  refetch: () => Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const {
    data: userData,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      // Don't even try if no token
      if (!tokenStorage.getAccessToken()) {
        return null;
      }
      try {
        const user = await api.auth.me();
        // Return full user profile including thumbUrl
        return {
          userId: user.userId ?? user.id ?? '',
          username: user.username,
          role: user.role,
          serverIds: user.serverIds ?? (user.serverId ? [user.serverId] : []),
          email: user.email ?? null,
          thumbUrl: user.thumbnail ?? user.thumbUrl ?? null,
          trustScore: user.aggregateTrustScore ?? user.trustScore ?? 100,
          hasPassword: user.hasPassword,
          hasPlexLinked: user.hasPlexLinked,
        } as UserProfile;
      } catch {
        // Don't clear tokens on network errors (e.g., server restart)
        // The API layer already clears tokens on real auth failures (401 + failed refresh)
        // Just return null to indicate "not currently authenticated"
        return null;
      }
    },
    // Retry configuration following AWS best practices:
    // - 3 retries (industry standard)
    // - Exponential backoff with full jitter to prevent thundering herd
    // - Cap at 10s to prevent excessively long waits
    // - Only retry on network errors, not on 4xx auth errors (handled by API layer)
    retry: (failureCount, error) => {
      // Don't retry on auth errors (4xx) - API layer handles token refresh
      // Only retry on network errors (TypeError: fetch failed, etc.)
      if (error instanceof Error && error.message.includes('401')) return false;
      if (error instanceof Error && error.message.includes('403')) return false;
      return failureCount < 3;
    },
    // Full jitter: random(0, min(cap, base * 2^attempt))
    // This spreads out retries to prevent all clients hitting server at once
    retryDelay: (attemptIndex) => {
      const baseDelay = 1000;
      const maxDelay = 10000;
      const exponentialDelay = Math.min(maxDelay, baseDelay * 2 ** attemptIndex);
      // Full jitter - random value between 0 and the exponential delay
      return Math.random() * exponentialDelay;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    // Auto-refetch when network reconnects (handles stale tabs)
    refetchOnReconnect: true,
    // Refetch when window regains focus (handles stale tabs)
    refetchOnWindowFocus: true,
  });

  // Listen for auth state changes (e.g., token cleared due to failed refresh)
  useEffect(() => {
    const handleAuthChange = () => {
      // Immediately clear auth data and redirect to login
      queryClient.setQueryData(['auth', 'me'], null);
      queryClient.clear();
      window.location.href = '/login';
    };

    window.addEventListener(AUTH_STATE_CHANGE_EVENT, handleAuthChange);
    return () => window.removeEventListener(AUTH_STATE_CHANGE_EVENT, handleAuthChange);
  }, [queryClient]);

  const logoutMutation = useMutation({
    mutationFn: async () => {
      try {
        await api.auth.logout();
      } catch {
        // Ignore API errors - we're logging out anyway
      } finally {
        // Use silent mode to avoid double-redirect (we handle redirect in onSettled)
        tokenStorage.clearTokens(true);
      }
    },
    onSettled: () => {
      // Always redirect, whether success or failure
      queryClient.setQueryData(['auth', 'me'], null);
      queryClient.clear();
      window.location.href = '/login';
    },
  });

  const logout = useCallback(async () => {
    await logoutMutation.mutateAsync();
  }, [logoutMutation]);

  // Optimistic authentication pattern (industry standard):
  // - If we have tokens in localStorage, assume authenticated until tokens are cleared
  // - Tokens only get cleared on explicit 401/403 from the server
  // - This prevents "logout" during temporary server unavailability (restarts, network issues)
  // See: https://github.com/TanStack/query/discussions/1547
  const hasTokens = !!tokenStorage.getAccessToken();

  const value = useMemo<AuthContextValue>(
    () => ({
      user: userData ?? null,
      isLoading,
      // Optimistic: authenticated if we have tokens (server might just be temporarily down)
      // Only false when tokens are explicitly cleared (logout or 401/403 rejection)
      isAuthenticated: hasTokens,
      logout,
      refetch,
    }),
    [userData, isLoading, hasTokens, logout, refetch]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Hook for protected routes
export function useRequireAuth(): AuthContextValue {
  const auth = useAuth();

  useEffect(() => {
    // isAuthenticated is now token-based (optimistic auth)
    // So this only triggers when tokens don't exist (never logged in, or explicitly logged out)
    if (!auth.isAuthenticated) {
      window.location.href = '/login';
    }
  }, [auth.isAuthenticated]);

  return auth;
}
