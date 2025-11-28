import { useQuery } from '@tanstack/react-query';
import type { Session, ActiveSession, PaginatedResponse } from '@tracearr/shared';
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

export function useActiveSessions() {
  return useQuery({
    queryKey: ['sessions', 'active'],
    queryFn: api.sessions.getActive,
    staleTime: 1000 * 15, // 15 seconds
    refetchInterval: 1000 * 30, // 30 seconds
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ['sessions', 'detail', id],
    queryFn: () => api.sessions.get(id),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}
