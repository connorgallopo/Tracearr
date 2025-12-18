import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ViolationWithDetails, PaginatedResponse, ViolationSeverity } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

interface ViolationsParams {
  page?: number;
  pageSize?: number;
  userId?: string;
  severity?: ViolationSeverity;
  acknowledged?: boolean;
  serverId?: string;
}

export function useViolations(params: ViolationsParams = {}) {
  return useQuery({
    queryKey: ['violations', 'list', params],
    queryFn: () => api.violations.list(params),
    staleTime: 1000 * 30, // 30 seconds
  });
}

export function useAcknowledgeViolation() {
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
      toast.error('Failed to Acknowledge', { description: err.message });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      toast.success('Violation Acknowledged', {
        description: 'The violation has been marked as acknowledged.',
      });
    },
  });
}

export function useDismissViolation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.violations.dismiss(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      toast.success('Violation Dismissed', { description: 'The violation has been dismissed.' });
    },
    onError: (error: Error) => {
      toast.error('Failed to Dismiss', { description: error.message });
    },
  });
}
