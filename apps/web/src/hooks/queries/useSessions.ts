import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { serverScopeFromIds, serverScopeKey } from '@tracearr/shared';
import { api } from '@/lib/api';

interface SessionsParams {
  page?: number;
  pageSize?: number;
  userId?: string;
  serverId?: string;
  state?: string;
}

export function useSessions(params: SessionsParams = {}) {
  return useQuery({
    queryKey: ['sessions', 'list', params],
    queryFn: () => api.sessions.list(params),
    staleTime: 1000 * 30, // 30 seconds
  });
}

function activeSessionsOptions(serverIds: string[], socketConnected: boolean, self: boolean) {
  const serverIdsKey = serverScopeKey(serverScopeFromIds(serverIds));
  return {
    queryKey: ['sessions', 'active', serverIdsKey, self],
    queryFn: () => api.sessions.getActive(serverIds.length ? serverIds : undefined, self),
    staleTime: 1000 * 15, // 15 seconds
    // Socket events keep this fresh when connected; polling is the fallback
    refetchInterval: socketConnected ? 1000 * 60 : 1000 * 30,
  };
}

export function useActiveSessions(serverIds: string[], socketConnected = false, self = false) {
  return useQuery({
    ...activeSessionsOptions(serverIds, socketConnected, self),
    select: (response) => response.data,
  });
}

/** Same request as useActiveSessions, so it costs nothing extra. Undefined unless the server sends it. */
export function useOthersActive(serverIds: string[], socketConnected = false, self = false) {
  return useQuery({
    ...activeSessionsOptions(serverIds, socketConnected, self),
    select: (response) => response.othersActive,
  });
}

export function useSession(id: string, startedAt?: Date | string) {
  return useQuery({
    queryKey: ['sessions', 'detail', id],
    queryFn: () => api.sessions.get(id, startedAt),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

export function useBulkDeleteSessions() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ids: string[]) => api.sessions.bulkDelete(ids),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      toast.success(t('toast.success.sessionsDeleted.title'), {
        description: t('toast.success.sessionsDeleted.message', { count: data.deleted }),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.sessionsDeleteFailed'), { description: error.message });
    },
  });
}
