/**
 * React Query hooks for the History page.
 * Provides infinite scroll queries and filter options.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { HistoryQueryInput } from '@tracearr/shared';
import { api } from '@/lib/api';

/**
 * Filter parameters for history queries.
 * Omits cursor and pageSize as those are handled by infinite query.
 */
export interface HistoryFilters {
  serverUserIds?: string[];
  serverId?: string;
  state?: 'playing' | 'paused' | 'stopped';
  mediaTypes?: ('movie' | 'episode' | 'track' | 'live')[];
  startDate?: Date;
  endDate?: Date;
  search?: string;
  platforms?: string[];
  product?: string;
  device?: string;
  playerName?: string;
  ipAddress?: string;
  geoCountries?: string[];
  geoCity?: string;
  geoRegion?: string;
  transcodeDecisions?: ('directplay' | 'copy' | 'transcode')[];
  watched?: boolean;
  excludeShortSessions?: boolean;
  orderBy?: 'startedAt' | 'durationMs' | 'mediaTitle';
  orderDir?: 'asc' | 'desc';
}

/**
 * Infinite query for history sessions with cursor-based pagination.
 * Supports all history filters and provides aggregate stats.
 */
export function useHistorySessions(filters: HistoryFilters = {}, pageSize = 50) {
  return useInfiniteQuery({
    queryKey: ['sessions', 'history', filters, pageSize],
    queryFn: async ({ pageParam }) => {
      const params: Partial<HistoryQueryInput> & { cursor?: string } = {
        ...filters,
        pageSize,
        cursor: pageParam,
      };
      return api.sessions.history(params);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 1000 * 30, // 30 seconds
  });
}

/**
 * Query for filter options (platforms, products, devices, countries, etc.).
 * Used to populate filter dropdowns.
 * Accepts optional date range to match the current history filter.
 */
export function useFilterOptions(params?: { serverId?: string; startDate?: Date; endDate?: Date }) {
  return useQuery({
    queryKey: [
      'sessions',
      'filter-options',
      params?.serverId,
      params?.startDate?.toISOString(),
      params?.endDate?.toISOString(),
    ],
    queryFn: () => api.sessions.filterOptions(params),
    staleTime: 1000 * 60 * 5, // 5 minutes - filter options don't change often
  });
}
