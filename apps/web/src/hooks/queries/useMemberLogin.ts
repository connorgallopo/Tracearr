import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { assertNever, type AuthUser, type ServerType } from '@tracearr/shared';
import { authClient } from '@/lib/authClient';
import type { ServerAccountSignInType } from '@/lib/serverType';
import { SignInError } from '@/lib/signInRefusal';

/** Jellyfin gives no poll interval; Silo's initiate answer carries its own */
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

/** The endpoints a type's code sign-in calls; null for a type with none */
function memberCodePaths(type: ServerType): { initiate: string; check: string } | null {
  switch (type) {
    case 'jellyfin':
      return {
        initiate: '/jellyfin/quick-connect/initiate',
        check: '/jellyfin/quick-connect/check',
      };
    case 'silo':
      return { initiate: '/silo/code/initiate', check: '/silo/code/check' };
    case 'plex':
    case 'emby':
    case 'tofa':
      return null;
    default:
      return assertNever(type);
  }
}

/** link and interval come only from Silo */
interface MemberCode {
  handle: string;
  code: string;
  link?: string;
  interval?: number;
}

interface MemberCodeCheck {
  authorized: boolean;
  expired?: boolean;
  user?: Pick<AuthUser, 'userId' | 'username' | 'role'>;
}

export function useMemberSignIn() {
  const { t } = useTranslation('common');

  return useMutation({
    mutationFn: async (credentials: {
      type: ServerAccountSignInType;
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
 * Asks the server for a sign-in code: Jellyfin's Quick Connect, Silo's pairing. Data is null when
 * the server has code sign-in switched off. `attempt` is part of the key, so bumping it asks for a
 * new code.
 */
export function useMemberCode(
  type: ServerType,
  serverId: string,
  attempt: number,
  enabled: boolean
) {
  const { t } = useTranslation('common');
  const paths = memberCodePaths(type);

  return useQuery({
    queryKey: ['member-login', 'code', type, serverId, attempt],
    queryFn: async () => {
      if (!paths) return null;
      const { data, error } = await post<MemberCode>(
        paths.initiate,
        { serverId },
        t('errors.generic')
      );
      if (error?.status === 404) return null;
      if (error || !data) throw new Error(error?.message ?? t('errors.generic'));
      return data;
    },
    enabled: enabled && !!paths,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * Polls a sign-in code until the server approves it or it lapses, one check at a time, every
 * `interval` seconds when the code came with one. A dropped request keeps polling; an HTTP error
 * from Tracearr ends it.
 */
export function useMemberCodeCheck(type: ServerType, code: MemberCode | null | undefined) {
  const { t } = useTranslation('common');
  const paths = memberCodePaths(type);
  const handle = code?.handle;
  const pollMs = code?.interval ? code.interval * 1000 : QUICK_CONNECT_POLL_MS;

  return useQuery({
    queryKey: ['member-login', 'code-check', type, handle],
    queryFn: async (): Promise<MemberCodeCheck> => {
      if (!paths) return { authorized: false, expired: true };
      const result = await authClient
        .$fetch<MemberCodeCheck>(paths.check, {
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
    enabled: !!handle && !!paths,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const { data, status } = query.state;
      return status === 'error' || data?.authorized || data?.expired ? false : pollMs;
    },
  });
}
