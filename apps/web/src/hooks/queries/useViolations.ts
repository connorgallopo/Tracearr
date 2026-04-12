import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  ViolationWithDetails,
  PaginatedResponse,
  ViolationSeverity,
  ViolationSortField,
} from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface ViolationsParams {
  page?: number;
  pageSize?: number;
  userId?: string;
  ruleId?: string;
  severity?: ViolationSeverity;
  acknowledged?: boolean;
  serverId?: string;
  orderBy?: ViolationSortField;
  orderDir?: 'asc' | 'desc';
}

export function useViolations(params: ViolationsParams = {}) {
  return useQuery({
    queryKey: ['violations', 'list', params],
    queryFn: () => api.violations.list(params),
    staleTime: 1000 * 30, // 30 seconds
  });
}

export function useViolation(id: string) {
  return useQuery({
    queryKey: ['violations', 'detail', id],
    queryFn: () => api.violations.get(id),
    enabled: !!id,
    staleTime: 1000 * 30,
  });
}

export function useAcknowledgeViolation() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.violations.acknowledge(id),
    onMutate: async (id) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: ['violations', 'list'] });

      const previousData = queryClient.getQueriesData<PaginatedResponse<ViolationWithDetails>>({
        queryKey: ['violations', 'list'],
      });

      // Update all matching queries
      queryClient.setQueriesData<PaginatedResponse<ViolationWithDetails>>(
        { queryKey: ['violations', 'list'] },
        (old) => {
          if (!old) return old;
          return {
            ...old,
            data: old.data.map((v) => (v.id === id ? { ...v, acknowledgedAt: new Date() } : v)),
          };
        }
      );

      return { previousData };
    },
    onError: (err, id, context) => {
      // Rollback on error
      if (context?.previousData) {
        for (const [queryKey, data] of context.previousData) {
          queryClient.setQueryData(queryKey, data);
        }
      }
      toast.error(t('toast.error.acknowledgeFailed'), { description: err.message });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      toast.success(t('toast.success.violationAcknowledged.title'), {
        description: t('toast.success.violationAcknowledged.message'),
      });
    },
  });
}

export function useDismissViolation() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.violations.dismiss(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      toast.success(t('toast.success.violationDismissed.title'), {
        description: t('toast.success.violationDismissed.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.dismissFailed'), { description: error.message });
    },
  });
}

export interface BulkViolationParams {
  ids?: string[];
  selectAll?: boolean;
  filters?: {
    serverId?: string;
    severity?: string;
    acknowledged?: boolean;
  };
}

export function useBulkAcknowledgeViolations() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: BulkViolationParams) => api.violations.bulkAcknowledge(params),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      toast.success(t('toast.success.violationsAcknowledged.title'), {
        description: t('toast.success.violationsAcknowledged.message', {
          count: data.acknowledged,
        }),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.acknowledgeFailed'), { description: error.message });
    },
  });
}

export function useBulkDismissViolations() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: BulkViolationParams) => api.violations.bulkDismiss(params),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      toast.success(t('toast.success.violationsDismissed.title'), {
        description: t('toast.success.violationsDismissed.message', { count: data.dismissed }),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.dismissFailed'), { description: error.message });
    },
  });
}
