import { useQuery } from '@tanstack/react-query';
import '@tracearr/shared';
import { api, type StatsTimeRange, getBrowserTimezone } from '@/lib/api';

// Re-export for backwards compatibility and convenience
export type { StatsTimeRange };

export function useDashboardStats(serverId?: string | null) {
  // Include timezone in cache key since "today" varies by timezone
  const timezone = getBrowserTimezone();
  return useQuery({
    queryKey: ['stats', 'dashboard', serverId, timezone],
    queryFn: () => api.stats.dashboard(serverId ?? undefined),
    staleTime: 1000 * 30, // 30 seconds
    refetchInterval: 1000 * 60, // 1 minute
  });
}

export function usePlaysStats(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'plays', timeRange, serverId],
    queryFn: () => api.stats.plays(timeRange ?? { period: 'week' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUserStats(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'users', timeRange, serverId],
    queryFn: () => api.stats.users(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export interface LocationStatsFilters {
  timeRange?: StatsTimeRange;
  serverUserId?: string;
  serverId?: string;
  mediaType?: 'movie' | 'episode' | 'track';
}

export function useLocationStats(filters?: LocationStatsFilters) {
  return useQuery({
    queryKey: ['stats', 'locations', filters],
    queryFn: () => api.stats.locations(filters),
    staleTime: 1000 * 60, // 1 minute
  });
}

export function usePlaysByDayOfWeek(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'plays-by-dayofweek', timeRange, serverId],
    queryFn: () =>
      api.stats.playsByDayOfWeek(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function usePlaysByHourOfDay(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'plays-by-hourofday', timeRange, serverId],
    queryFn: () =>
      api.stats.playsByHourOfDay(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function usePlatformStats(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'platforms', timeRange, serverId],
    queryFn: () => api.stats.platforms(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useQualityStats(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'quality', timeRange, serverId],
    queryFn: () => api.stats.quality(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useTopUsers(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'top-users', timeRange, serverId],
    queryFn: () => api.stats.topUsers(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useTopContent(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'top-content', timeRange, serverId],
    queryFn: () => api.stats.topContent(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useConcurrentStats(timeRange?: StatsTimeRange, serverId?: string | null) {
  return useQuery({
    queryKey: ['stats', 'concurrent', timeRange, serverId],
    queryFn: () => api.stats.concurrent(timeRange ?? { period: 'month' }, serverId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
