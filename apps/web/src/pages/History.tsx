/**
 * History page - comprehensive session history with powerful filtering.
 * Features infinite scroll, URL state sync, column visibility, and aggregate statistics.
 */

import { useEffect, useMemo, useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInView } from 'react-intersection-observer';
import { Card, CardContent } from '@/components/ui/card';
import {
  HistoryFiltersBar,
  DEFAULT_COLUMN_VISIBILITY,
  type ColumnVisibility,
} from '@/components/history/HistoryFilters';
import { HistoryTable, type SortableColumn } from '@/components/history/HistoryTable';
import { HistoryAggregates } from '@/components/history/HistoryAggregates';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { useHistorySessions, useFilterOptions, type HistoryFilters } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import type { SessionWithDetails } from '@tracearr/shared';

// Local storage key for column visibility
const COLUMN_VISIBILITY_KEY = 'tracearr-history-columns';

// Load column visibility from local storage
function loadColumnVisibility(): ColumnVisibility {
  try {
    const stored = localStorage.getItem(COLUMN_VISIBILITY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ColumnVisibility>;
      // Merge with defaults to handle new columns
      return { ...DEFAULT_COLUMN_VISIBILITY, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_COLUMN_VISIBILITY;
}

// Save column visibility to local storage
function saveColumnVisibility(visibility: ColumnVisibility): void {
  try {
    localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(visibility));
  } catch {
    // Ignore storage errors
  }
}

function parseCommaSeparated<T extends string>(
  value: string | null,
  validValues?: readonly T[]
): T[] | undefined {
  if (!value) return undefined;
  const values = value.split(',').filter(Boolean) as T[];
  if (validValues) {
    const filtered = values.filter((v) => validValues.includes(v));
    return filtered.length > 0 ? filtered : undefined;
  }
  return values.length > 0 ? values : undefined;
}

// Parse URL search params into filter object
function parseFiltersFromUrl(searchParams: URLSearchParams): HistoryFilters {
  const filters: HistoryFilters = {};

  const userIds = searchParams.get('userIds');
  if (userIds) {
    const parsed = userIds.split(',').filter(Boolean);
    if (parsed.length > 0) filters.serverUserIds = parsed;
  }

  const serverId = searchParams.get('serverId');
  if (serverId) filters.serverId = serverId;

  const mediaTypes = parseCommaSeparated(searchParams.get('mediaTypes'), [
    'movie',
    'episode',
    'track',
    'live',
  ] as const);
  if (mediaTypes) filters.mediaTypes = mediaTypes;

  const state = searchParams.get('state');
  if (state === 'playing' || state === 'paused' || state === 'stopped') {
    filters.state = state;
  }

  const transcodeDecisions = parseCommaSeparated(searchParams.get('transcodeDecisions'), [
    'directplay',
    'copy',
    'transcode',
  ] as const);
  if (transcodeDecisions) filters.transcodeDecisions = transcodeDecisions;

  const platforms = parseCommaSeparated<string>(searchParams.get('platforms'));
  if (platforms) filters.platforms = platforms;

  const countries = parseCommaSeparated<string>(searchParams.get('countries'));
  if (countries) filters.geoCountries = countries;

  const search = searchParams.get('search');
  if (search) filters.search = search;

  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const period = searchParams.get('period');

  if (startDate) {
    const parsed = new Date(startDate);
    if (!isNaN(parsed.getTime())) filters.startDate = parsed;
  }

  if (endDate) {
    const parsed = new Date(endDate);
    if (!isNaN(parsed.getTime())) filters.endDate = parsed;
  }

  // Default to 30d only on fresh page load (no period param)
  // If period=all, user explicitly wants all data
  if (!filters.startDate && !filters.endDate && period !== 'all') {
    const now = new Date();
    filters.startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    filters.endDate = now;
  }

  const watched = searchParams.get('watched');
  if (watched === 'true') filters.watched = true;
  if (watched === 'false') filters.watched = false;

  const orderBy = searchParams.get('orderBy');
  if (orderBy === 'startedAt' || orderBy === 'durationMs' || orderBy === 'mediaTitle') {
    filters.orderBy = orderBy;
  }

  const orderDir = searchParams.get('orderDir');
  if (orderDir === 'asc' || orderDir === 'desc') {
    filters.orderDir = orderDir;
  }

  return filters;
}

// Convert filter object to URL search params
function filtersToUrlParams(filters: HistoryFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.serverUserIds?.length) params.set('userIds', filters.serverUserIds.join(','));
  if (filters.serverId) params.set('serverId', filters.serverId);
  if (filters.mediaTypes?.length) params.set('mediaTypes', filters.mediaTypes.join(','));
  if (filters.state) params.set('state', filters.state);
  if (filters.transcodeDecisions?.length)
    params.set('transcodeDecisions', filters.transcodeDecisions.join(','));
  if (filters.platforms?.length) params.set('platforms', filters.platforms.join(','));
  if (filters.geoCountries?.length) params.set('countries', filters.geoCountries.join(','));
  if (filters.search) params.set('search', filters.search);
  if (filters.startDate) params.set('startDate', filters.startDate.toISOString());
  if (filters.endDate) params.set('endDate', filters.endDate.toISOString());
  if (!filters.startDate && !filters.endDate) params.set('period', 'all');
  if (filters.watched !== undefined) params.set('watched', String(filters.watched));
  if (filters.orderBy && filters.orderBy !== 'startedAt') params.set('orderBy', filters.orderBy);
  if (filters.orderDir && filters.orderDir !== 'desc') params.set('orderDir', filters.orderDir);

  return params;
}

export function History() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedServerId } = useServer();
  const [selectedSession, setSelectedSession] = useState<SessionWithDetails | null>(null);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(loadColumnVisibility);

  // Parse filters from URL on mount and when URL changes
  const filters = useMemo(() => {
    const parsed = parseFiltersFromUrl(searchParams);
    // Apply selected server from context if not in URL
    if (!parsed.serverId && selectedServerId) {
      parsed.serverId = selectedServerId;
    }
    return parsed;
  }, [searchParams, selectedServerId]);

  // Query hooks
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useHistorySessions(filters);

  const { data: filterOptions, isLoading: filterOptionsLoading } = useFilterOptions({
    serverId: filters.serverId,
    startDate: filters.startDate,
    endDate: filters.endDate,
  });

  // Intersection observer for infinite scroll
  const { ref: loadMoreRef, inView } = useInView({
    threshold: 0,
    rootMargin: '200px', // Start loading before reaching the end
  });

  // Fetch next page when load more element is in view
  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Flatten pages into single sessions array
  const sessions = useMemo(() => {
    return data?.pages.flatMap((page) => page.data) ?? [];
  }, [data]);

  // Get aggregates from first page
  const aggregates = data?.pages[0]?.aggregates;
  const total = data?.pages[0]?.total;

  // Handle filter changes - update URL
  const handleFiltersChange = useCallback(
    (newFilters: HistoryFilters) => {
      const params = filtersToUrlParams(newFilters);
      setSearchParams(params, { replace: true });
    },
    [setSearchParams]
  );

  // Handle column visibility changes - save to local storage
  const handleColumnVisibilityChange = useCallback((newVisibility: ColumnVisibility) => {
    setColumnVisibility(newVisibility);
    saveColumnVisibility(newVisibility);
  }, []);

  // Handle session click - open detail sheet
  const handleSessionClick = useCallback((session: SessionWithDetails) => {
    setSelectedSession(session);
  }, []);

  // Handle sort column change - toggle direction if same column, otherwise set new column
  const handleSortChange = useCallback(
    (column: SortableColumn) => {
      const currentOrderBy = filters.orderBy ?? 'startedAt';
      const currentOrderDir = filters.orderDir ?? 'desc';
      const newFilters = { ...filters };

      if (currentOrderBy === column) {
        // Toggle direction
        newFilters.orderDir = currentOrderDir === 'desc' ? 'asc' : 'desc';
      } else {
        // New column - default to descending
        newFilters.orderBy = column;
        newFilters.orderDir = 'desc';
      }
      handleFiltersChange(newFilters);
    },
    [filters, handleFiltersChange]
  );

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold">History</h1>
        <p className="text-muted-foreground">
          Browse all streaming sessions with powerful filtering
        </p>
      </div>

      {/* Aggregates Summary */}
      <HistoryAggregates aggregates={aggregates} total={total} isLoading={isLoading} />

      {/* Filters */}
      <Card>
        <CardContent className="pt-4">
          <HistoryFiltersBar
            filters={filters}
            onFiltersChange={handleFiltersChange}
            filterOptions={filterOptions}
            isLoading={isLoading || filterOptionsLoading}
            columnVisibility={columnVisibility}
            onColumnVisibilityChange={handleColumnVisibilityChange}
          />
        </CardContent>
      </Card>

      {/* Sessions Table */}
      <Card>
        <CardContent className="p-0">
          <HistoryTable
            sessions={sessions}
            isLoading={isLoading}
            isFetchingNextPage={isFetchingNextPage}
            onSessionClick={handleSessionClick}
            columnVisibility={columnVisibility}
            sortBy={filters.orderBy ?? 'startedAt'}
            sortDir={filters.orderDir ?? 'desc'}
            onSortChange={handleSortChange}
          />

          {/* Infinite scroll trigger */}
          {hasNextPage && (
            <div
              ref={loadMoreRef}
              className="text-muted-foreground flex justify-center py-4 text-sm"
            >
              {isFetchingNextPage ? 'Loading more...' : 'Scroll for more'}
            </div>
          )}

          {/* End of results indicator */}
          {!hasNextPage && sessions.length > 0 && (
            <div className="text-muted-foreground flex justify-center py-4 text-sm">
              Showing all {total?.toLocaleString()} results
            </div>
          )}
        </CardContent>
      </Card>

      {/* Session Detail Sheet */}
      <SessionDetailSheet
        session={selectedSession}
        open={!!selectedSession}
        onOpenChange={(open) => !open && setSelectedSession(null)}
      />
    </div>
  );
}
