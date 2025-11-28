import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { User, Session, PaginatedResponse } from '@tracearr/shared';
import { api } from '@/lib/api';

export function useUsers() {
  return useQuery({
    queryKey: ['users', 'list'],
    queryFn: api.users.list,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUser(id: string) {
  return useQuery({
    queryKey: ['users', 'detail', id],
    queryFn: () => api.users.get(id),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

export function useUserSessions(id: string, params: { page?: number; pageSize?: number } = {}) {
  return useQuery({
    queryKey: ['users', 'sessions', id, params],
    queryFn: () => api.users.sessions(id, params),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<User> }) =>
      api.users.update(id, data),
    onSuccess: (data, variables) => {
      // Update user in cache
      queryClient.setQueryData(['users', 'detail', variables.id], data);
      // Invalidate users list
      queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
    },
  });
}
