/**
 * React Query hooks for library statistics endpoints
 *
 * All hooks follow the same patterns:
 * - 5-minute staleTime (library data updates daily)
 * - Timezone included in queryKey for endpoints that use it
 * - Consistent queryKey structure: ['library', endpoint, ...params, timezone?]
 */

import { useQuery } from '@tanstack/react-query';
import { api, getBrowserTimezone } from '@/lib/api';
import type {
  LibraryStatsResponse,
  LibraryGrowthResponse,
  LibraryQualityResponse,
  LibraryStorageResponse,
  DuplicatesResponse,
  StaleResponse,
  WatchResponse,
  CompletionResponse,
  PatternsResponse,
  RoiResponse,
} from '@tracearr/shared';

// 5 minutes - library data is updated once daily
const LIBRARY_STALE_TIME = 1000 * 60 * 5;

/**
 * Fetch current library statistics (item counts, size, quality breakdown)
 */
export function useLibraryStats(serverId?: string | null, libraryId?: string | null) {
  const timezone = getBrowserTimezone();
  return useQuery<LibraryStatsResponse>({
    queryKey: ['library', 'stats', serverId, libraryId, timezone],
    queryFn: () => api.library.stats(serverId ?? undefined, libraryId ?? undefined),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch library growth timeline (additions/removals over time)
 */
export function useLibraryGrowth(
  serverId?: string | null,
  libraryId?: string | null,
  period: string = '30d'
) {
  const timezone = getBrowserTimezone();
  return useQuery<LibraryGrowthResponse>({
    queryKey: ['library', 'growth', serverId, libraryId, period, timezone],
    queryFn: () => api.library.growth(serverId ?? undefined, libraryId ?? undefined, period),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch library quality evolution (resolution/codec breakdown over time)
 */
export function useLibraryQuality(
  serverId?: string | null,
  libraryId?: string | null,
  period: string = '30d'
) {
  const timezone = getBrowserTimezone();
  return useQuery<LibraryQualityResponse>({
    queryKey: ['library', 'quality', serverId, libraryId, period, timezone],
    queryFn: () => api.library.quality(serverId ?? undefined, libraryId ?? undefined, period),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch storage analytics with growth predictions
 */
export function useLibraryStorage(
  serverId?: string | null,
  libraryId?: string | null,
  period: string = '30d'
) {
  const timezone = getBrowserTimezone();
  return useQuery<LibraryStorageResponse>({
    queryKey: ['library', 'storage', serverId, libraryId, period, timezone],
    queryFn: () => api.library.storage(serverId ?? undefined, libraryId ?? undefined, period),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch cross-server duplicate detection results
 */
export function useLibraryDuplicates(
  serverId?: string | null,
  page: number = 1,
  pageSize: number = 20
) {
  return useQuery<DuplicatesResponse>({
    queryKey: ['library', 'duplicates', serverId, page, pageSize],
    queryFn: () => api.library.duplicates(serverId ?? undefined, page, pageSize),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch stale/unwatched content analysis
 */
export function useLibraryStale(
  serverId?: string | null,
  libraryId?: string | null,
  staleDays: number = 90,
  page: number = 1,
  pageSize: number = 20
) {
  return useQuery<StaleResponse>({
    queryKey: ['library', 'stale', serverId, libraryId, staleDays, page, pageSize],
    queryFn: () =>
      api.library.stale(serverId ?? undefined, libraryId ?? undefined, staleDays, page, pageSize),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch per-item watch statistics
 */
export function useLibraryWatch(
  serverId?: string | null,
  libraryId?: string | null,
  page: number = 1,
  pageSize: number = 20
) {
  return useQuery<WatchResponse>({
    queryKey: ['library', 'watch', serverId, libraryId, page, pageSize],
    queryFn: () => api.library.watch(serverId ?? undefined, libraryId ?? undefined, page, pageSize),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch completion rate analysis (item/season/series level)
 */
export function useLibraryCompletion(
  serverId?: string | null,
  libraryId?: string | null,
  aggregateLevel: string = 'item',
  page: number = 1,
  pageSize: number = 20
) {
  return useQuery<CompletionResponse>({
    queryKey: ['library', 'completion', serverId, libraryId, aggregateLevel, page, pageSize],
    queryFn: () =>
      api.library.completion(
        serverId ?? undefined,
        libraryId ?? undefined,
        aggregateLevel,
        page,
        pageSize
      ),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch watch patterns analysis (binge shows, peak times, trends)
 */
export function useLibraryPatterns(
  serverId?: string | null,
  libraryId?: string | null,
  periodWeeks: number = 12
) {
  const timezone = getBrowserTimezone();
  return useQuery<PatternsResponse>({
    queryKey: ['library', 'patterns', serverId, libraryId, periodWeeks, timezone],
    queryFn: () => api.library.patterns(serverId ?? undefined, libraryId ?? undefined, periodWeeks),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch content ROI analysis (watch value per storage cost)
 */
export function useLibraryRoi(
  serverId?: string | null,
  libraryId?: string | null,
  page: number = 1,
  pageSize: number = 20
) {
  const timezone = getBrowserTimezone();
  return useQuery<RoiResponse>({
    queryKey: ['library', 'roi', serverId, libraryId, page, pageSize, timezone],
    queryFn: () => api.library.roi(serverId ?? undefined, libraryId ?? undefined, page, pageSize),
    staleTime: LIBRARY_STALE_TIME,
  });
}
