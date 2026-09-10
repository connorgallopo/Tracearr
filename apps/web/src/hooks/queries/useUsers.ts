import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  MERGE_SAME_SERVER_CONFIRMATION_REQUIRED,
  serverScopeFromIds,
  serverScopeKey,
  type UserRosterFilters,
} from '@tracearr/shared';
import { api, type UserListParams } from '@/lib/api';

export function useUsers(params: UserListParams = {}, options: { enabled?: boolean } = {}) {
  const serverIdsKey = serverScopeKey(serverScopeFromIds(params.serverIds));
  return useQuery({
    queryKey: ['users', 'list', { ...params, serverIds: serverIdsKey }],
    queryFn: () => api.users.list(params),
    enabled: options.enabled ?? true,
    // A search query changes often as the user types (debounced upstream) and
    // shouldn't linger stale as long as the default roster listing does.
    staleTime: params.search ? 1000 * 10 : 1000 * 60 * 5,
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

/**
 * Aggregate endpoint that fetches all user data in one request.
 * Use this for the UserDetail page instead of multiple separate queries.
 * Reduces 6 API calls to 1, significantly improving load time.
 */
export function useUserFull(id: string, params: { scope?: 'identity' } = {}) {
  return useQuery({
    queryKey: ['users', 'full', id, params.scope ?? null],
    queryFn: () => api.users.getFull(id, params),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

export function useUserSessions(
  id: string,
  params: { page?: number; pageSize?: number; scope?: 'identity' } = {}
) {
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
    mutationFn: ({ id, data }: { id: string; data: { trustScore?: number } }) =>
      api.users.update(id, data),
    onSuccess: (data, variables) => {
      // Update user in cache
      queryClient.setQueryData(['users', 'detail', variables.id], data);
      // Invalidate users list and every cached full-detail view - a trust
      // edit on one account can also change a merged identity's aggregate
      // shown from a sibling account's "all servers" view.
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['users', 'full'] });
    },
  });
}

export function useUpdateUserIdentity() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: { name?: string | null; contactEmail?: string | null };
    }) => api.users.updateIdentity(id, data),
    onSuccess: () => {
      // A name or contact email is shared across the whole identity, so every cached
      // full-detail view (any account anchor, any scope) needs a refetch.
      void queryClient.invalidateQueries({ queryKey: ['users', 'full'] });
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
      toast.success(t('toast.success.identityUpdated'));
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.identityUpdateFailed'), { description: error.message });
    },
  });
}

export function useUserLocations(id: string, params: { scope?: 'identity' } = {}) {
  return useQuery({
    queryKey: ['users', 'locations', id, params.scope ?? null],
    queryFn: () => api.users.locations(id, params),
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUserDevices(id: string, params: { scope?: 'identity' } = {}) {
  return useQuery({
    queryKey: ['users', 'devices', id, params.scope ?? null],
    queryFn: () => api.users.devices(id, params),
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUserTerminations(
  id: string,
  params: { page?: number; pageSize?: number; scope?: 'identity' } = {}
) {
  return useQuery({
    queryKey: ['users', 'terminations', id, params],
    queryFn: () => api.users.terminations(id, params),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

export interface BulkResetTrustParams {
  ids?: string[];
  selectAll?: boolean;
  /**
   * Every filter the roster was narrowed by. Sending a subset makes "select all
   * N" reset people the table never showed.
   */
  filters?: Partial<UserRosterFilters>;
}

export function useBulkResetTrust() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: BulkResetTrustParams) => api.users.bulkResetTrust(params),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      // Identity trust shows on the stats leaderboard too
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      toast.success(t('toast.success.trustScoresReset.title'), {
        description: t('toast.success.trustScoresReset.message', { count: data.updated }),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.trustScoresResetFailed'), { description: error.message });
    },
  });
}

export function useMergeSuggestions(enabled: boolean) {
  return useQuery({
    queryKey: ['users', 'merge-suggestions'],
    queryFn: () => api.users.mergeSuggestions(),
    enabled,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useMergeUsers() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      sourceUserId: string;
      targetUserId: string;
      confirmSameServerCombine?: boolean;
    }) =>
      api.users.merge(input.sourceUserId, {
        targetUserId: input.targetUserId,
        confirmSameServerCombine: input.confirmSameServerCombine,
      }),
    onSuccess: (data) => {
      // Leaderboards/dashboard/history aggregate by identity, so a merge has to
      // drop their cached pre-merge data too, not just the roster.
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      toast.success(t('toast.success.usersMerged.title'), {
        description:
          data.droppedRuleNames.length > 0
            ? t('toast.success.usersMerged.automationsKept', {
                names: data.droppedRuleNames.join(', '),
              })
            : undefined,
      });
    },
    onError: (error: Error) => {
      // The same-server sentinel isn't a failure - callers surface the destructive
      // confirmation UI instead of a toast when they see this message.
      if (error.message === MERGE_SAME_SERVER_CONFIRMATION_REQUIRED) {
        return;
      }
      toast.error(t('toast.error.userMergeFailed'), { description: error.message });
    },
  });
}

export function useSplitServerUser() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { serverUserId: string }) => api.serverUsers.split(input.serverUserId),
    onSuccess: () => {
      // Same reasoning as merge: splitting reshapes identity-level aggregates too.
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      toast.success(t('toast.success.serverUserSplit.title'));
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.serverUserSplitFailed'), { description: error.message });
    },
  });
}
