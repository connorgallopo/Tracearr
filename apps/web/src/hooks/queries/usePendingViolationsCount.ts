import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function usePendingViolationsCount(enabled: boolean): number {
  const { data } = useQuery({
    queryKey: ['violations', 'count', 'pending'],
    queryFn: () => api.violations.count({ acknowledged: false }),
    enabled,
    staleTime: 1000 * 30,
  });
  return data?.total ?? 0;
}
