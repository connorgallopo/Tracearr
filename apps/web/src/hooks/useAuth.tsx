import { createContext, useContext, useCallback, useMemo, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AuthUser } from '@tracearr/shared';
import { getAvatarUrl } from '@/components/users/utils';
import { api, ApiError, AUTH_STATE_CHANGE_EVENT, BASE_URL } from '@/lib/api';
import { authClient } from '@/lib/authClient';
import { dropUserData } from '@/lib/queryCache';
import { stopViewingAs } from '@/hooks/queries/useImpersonation';

interface UserProfile extends AuthUser {
  name: string | null;
  email: string | null;
  thumbUrl: string | null;
  hasPassword?: boolean;
  hasPlexLinked?: boolean;
  hasTofaLinked?: boolean;
}

interface AuthContextValue {
  user: UserProfile | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** /me answered 401 or 403, so there is no session; false while it loads or when it could not be reached. */
  isSignedOut: boolean;
  logout: () => Promise<void>;
  refetch: () => Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// 401/403 means the server answered and there is no session. A network error,
// proxy 5xx, or timeout means we never got an answer, so the last user stays.
const isSignedOut = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { t } = useTranslation('common');

  const {
    data: userData,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        const user = await api.auth.me();
        const thumbnail = user.thumbnail ?? user.thumbUrl;
        return {
          userId: user.userId ?? user.id ?? '',
          username: user.username,
          name: user.name ?? null,
          role: user.role,
          serverIds: user.serverIds ?? (user.serverId ? [user.serverId] : []),
          email: user.email ?? null,
          // A picture at an address of its own, such as an OIDC provider's, the server fetches.
          thumbUrl:
            getAvatarUrl(user.thumbnailServerId, thumbnail) ??
            (thumbnail && URL.canParse(thumbnail) ? `${BASE_URL}api/v1/images/account` : null),
          impersonatedBy: user.impersonatedBy,
          hasPassword: user.hasPassword,
          hasPlexLinked: user.hasPlexLinked,
          hasTofaLinked: user.hasTofaLinked,
        };
      } catch (error) {
        if (isSignedOut(error)) return null;
        // Thrown errors retry on the client defaults and keep the last user in place
        throw error;
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    // Auto-refetch when network reconnects (handles stale tabs)
    refetchOnReconnect: true,
    // Refetch when window regains focus (handles stale tabs)
    refetchOnWindowFocus: true,
  });

  // Listen for auth state changes (e.g., session cookie rejected by the API)
  useEffect(() => {
    const handleAuthChange = () => {
      // Immediately clear auth data and redirect to login
      queryClient.setQueryData(['auth', 'me'], null);
      queryClient.clear();
      // Assigning location.href reloads even when the URL is unchanged, so a
      // 401 fired while already on the login page would reload it forever.
      if (window.location.pathname !== `${BASE_URL}login`) {
        window.location.href = `${BASE_URL}login`;
      }
    };

    window.addEventListener(AUTH_STATE_CHANGE_EVENT, handleAuthChange);
    return () => window.removeEventListener(AUTH_STATE_CHANGE_EVENT, handleAuthChange);
  }, [queryClient]);

  const impersonating = !!userData?.impersonatedBy;
  const logout = useCallback(async () => {
    // Signing out of a preview would leave the owner signed out of themselves too
    if (impersonating) return stopViewingAs(queryClient, t('errors.generic'));
    await authClient.signOut();
    queryClient.setQueryData(['auth', 'me'], null);
    dropUserData(queryClient);
    await queryClient.invalidateQueries({ queryKey: ['auth'] });
  }, [impersonating, queryClient, t]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: userData ?? null,
      isLoading,
      isAuthenticated: !!userData,
      isSignedOut: userData === null,
      logout,
      refetch,
    }),
    [userData, isLoading, logout, refetch]
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
    // Only triggers once the /me query has resolved with no session
    // (never logged in, session expired, or explicitly logged out)
    if (!auth.isAuthenticated) {
      window.location.href = `${BASE_URL}login`;
    }
  }, [auth.isAuthenticated]);

  return auth;
}
