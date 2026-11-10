import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { AuthUser, JellyfinEmbyServerType } from '@tracearr/shared';
import { authClient } from '@/lib/authClient';
import { SignInError } from '@/lib/signInRefusal';

const QUICK_CONNECT_POLL_MS = 2000;

// better-fetch keeps the whole error body, but its type only names message, status and statusText
const errorCode = (error: object | null | undefined): string | undefined =>
  error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

// better-fetch rethrows a dropped request as the browser's own message ("Failed to fetch")
async function post<T>(url: string, body: Record<string, string>, fallbackMessage: string) {
  try {
    return await authClient.$fetch<T>(url, { method: 'POST', body });
  } catch {
    throw new Error(fallbackMessage);
  }
}

interface QuickConnectCheck {
  authorized: boolean;
  expired?: boolean;
  user?: Pick<AuthUser, 'userId' | 'username' | 'role'>;
}

export function useMemberSignIn() {
  const { t } = useTranslation('common');

  return useMutation({
    mutationFn: async (credentials: {
      type: JellyfinEmbyServerType;
      serverId: string;
      username: string;
      password: string;
    }) => {
      const { type, ...body } = credentials;
      const { error } = await post(`/${type}/sign-in`, body, t('errors.generic'));
      if (error) throw new SignInError(error.message ?? t('errors.generic'), errorCode(error));
    },
  });
}

/**
 * Asks Jellyfin for a Quick Connect code. Data is null when the server has Quick Connect
 * switched off. `attempt` is part of the key, so bumping it asks for a new code.
 */
export function useQuickConnectCode(serverId: string, attempt: number, enabled: boolean) {
  const { t } = useTranslation('common');

  return useQuery({
    queryKey: ['member-login', 'quick-connect', serverId, attempt],
    queryFn: async () => {
      const { data, error } = await post<{ handle: string; code: string }>(
        '/jellyfin/quick-connect/initiate',
        { serverId },
        t('errors.generic')
      );
      if (error?.status === 404) return null;
      if (error || !data) throw new Error(error?.message ?? t('errors.generic'));
      return data;
    },
    enabled,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * Polls a Quick Connect code until Jellyfin approves it or it lapses. A dropped request keeps
 * polling; an HTTP error from Tracearr ends it.
 */
export function useQuickConnectCheck(handle: string | undefined) {
  const { t } = useTranslation('common');

  return useQuery({
    queryKey: ['member-login', 'quick-connect-check', handle],
    queryFn: async (): Promise<QuickConnectCheck> => {
      const result = await authClient
        .$fetch<QuickConnectCheck>('/jellyfin/quick-connect/check', {
          method: 'POST',
          body: { handle },
        })
        .catch(() => null);
      if (!result) return { authorized: false };
      if (result.error || !result.data) {
        throw new SignInError(
          result.error?.message ?? t('errors.generic'),
          errorCode(result.error)
        );
      }
      return result.data;
    },
    enabled: !!handle,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const { data, status } = query.state;
      return status === 'error' || data?.authorized || data?.expired
        ? false
        : QUICK_CONNECT_POLL_MS;
    },
  });
}
