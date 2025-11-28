import { useQuery } from '@tanstack/react-query';
import type { DashboardStats, PlayStats, UserStats, LocationStats } from '@tracearr/shared';
import { api } from '@/lib/api';

export function useDashboardStats() {
  return useQuery({
    queryKey: ['stats', 'dashboard'],
    queryFn: api.stats.dashboard,
    staleTime: 1000 * 30, // 30 seconds
    refetchInterval: 1000 * 60, // 1 minute
  });
}

export function usePlaysStats(period: 'day' | 'week' | 'month' = 'week') {
  return useQuery({
    queryKey: ['stats', 'plays', period],
    queryFn: () => api.stats.plays(period),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUserStats() {
  return useQuery({
    queryKey: ['stats', 'users'],
    queryFn: api.stats.users,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useLocationStats() {
  return useQuery({
    queryKey: ['stats', 'locations'],
    queryFn: api.stats.locations,
    staleTime: 1000 * 60, // 1 minute
  });
}
