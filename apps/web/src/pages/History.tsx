/**
 * History page - comprehensive session history with powerful filtering.
 * Features infinite scroll, URL state sync, column visibility, and aggregate statistics.
 */

import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import { useSearchParams, useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { HistoryFiltersBar } from '@/components/history/HistoryFilters';
import {
  DEFAULT_COLUMN_VISIBILITY,
  NARROW_HIDDEN_COLUMNS,
  type ColumnVisibility,
  type HistoryColumnId,
} from '@/components/history/historyColumns';
import { HistoryTable, type SortableColumn } from '@/components/history/HistoryTable';
import { useFittedColumns } from '@/components/history/useFittedColumns';
import { HistoryAggregates } from '@/components/history/HistoryAggregates';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { ErrorState, InlineErrorState } from '@/components/library/ErrorState';
import {
  useHistorySessions,
  useHistoryAggregates,
  useFilterOptions,
  useSession,
  type HistoryFilters,
} from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useServer } from '@/hooks/useServer';
import { type DateWindow, resolveWindow, useTimeRange } from '@/hooks/useTimeRange';
import { PLAYBACK_DECISIONS, type SessionWithDetails } from '@tracearr/shared';

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

// Columns the user turned on while the table was too narrow for them, which stay shown
const CHOSEN_COLUMNS_KEY = 'tracearr-history-columns-chosen';

function isNarrowHiddenColumn(value: unknown): value is HistoryColumnId {
  return NARROW_HIDDEN_COLUMNS.some((column) => column === value);
}

function loadChosenColumns(): HistoryColumnId[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CHOSEN_COLUMNS_KEY) ?? '[]');
    if (Array.isArray(stored)) return stored.filter(isNarrowHiddenColumn);
  } catch {
    // Ignore parse errors
  }
  return [];
}

function saveChosenColumns(columns: HistoryColumnId[]): void {
  try {
    localStorage.setItem(CHOSEN_COLUMNS_KEY, JSON.stringify(columns));
  } catch {
    // Ignore storage errors
  }
}

function columnsForViewer(visibility: ColumnVisibility, isMember: boolean): ColumnVisibility {
  return isMember ? { ...visibility, user: false } : visibility;
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
function parseFiltersFromUrl(
  searchParams: URLSearchParams,
  dateWindow: DateWindow
): HistoryFilters {
  const filters: HistoryFilters = {};

  const userIds = parseCommaSeparated<string>(searchParams.get('userIds'));
  if (userIds) filters.serverUserIds = userIds;

  const profileIds = parseCommaSeparated<string>(searchParams.get('profileIds'));
  if (profileIds) filters.profileIds = profileIds;

  // serverIds=a,b is the canonical param; legacy serverId=X is back-compat
  const serverIdsParam = searchParams.get('serverIds');
  if (serverIdsParam) {
    const parsed = serverIdsParam.split(',').filter(Boolean);
    if (parsed.length > 0) filters.serverIds = parsed;
  } else {
    const legacyServerId = searchParams.get('serverId');
    if (legacyServerId) filters.serverIds = [legacyServerId];
  }

  const mediaTypes = parseCommaSeparated(searchParams.get('mediaTypes'), [
    'movie',
    'episode',
    'track',
    'live',
    'trailer',
  ] as const);
  if (mediaTypes) filters.mediaTypes = mediaTypes;

  const state = searchParams.get('state');
  if (state === 'playing' || state === 'paused' || state === 'stopped') {
    filters.state = state;
  }

  const transcodeDecisions = parseCommaSeparated(
    searchParams.get('transcodeDecisions'),
    PLAYBACK_DECISIONS
  );
  if (transcodeDecisions) filters.transcodeDecisions = transcodeDecisions;

  const network = searchParams.get('network');
  if (network === 'local' || network === 'remote') filters.network = network;

  const platforms = parseCommaSeparated<string>(searchParams.get('platforms'));
  if (platforms) filters.platforms = platforms;

  const countries = parseCommaSeparated<string>(searchParams.get('countries'));
  if (countries) filters.geoCountries = countries;

  const city = searchParams.get('city');
  if (city) filters.geoCity = city;
  if (searchParams.get('noCity') === 'true') filters.geoCityMissing = true;
  const region = searchParams.get('region');
  if (region) filters.geoRegion = region;
  if (searchParams.get('noRegion') === 'true') filters.geoRegionMissing = true;

  const search = searchParams.get('search');
  if (search) filters.search = search;

  if (dateWindow) {
    filters.startDate = dateWindow.startDate;
    filters.endDate = dateWindow.endDate;
  }

  const watched = searchParams.get('watched');
  if (watched === 'true') filters.watched = true;
  if (watched === 'false') filters.watched = false;
  if (searchParams.get('subtitleBurnIn') === 'true') filters.subtitleBurnIn = true;

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

// Convert filter object to URL search params. A filter set with a window keeps the range params
// useTimeRange owns; one without a window is the all-time range.
function filtersToUrlParams(filters: HistoryFilters, current: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.serverUserIds?.length) params.set('userIds', filters.serverUserIds.join(','));
  if (filters.profileIds?.length) params.set('profileIds', filters.profileIds.join(','));
  if (filters.serverIds?.length) params.set('serverIds', filters.serverIds.join(','));
  if (filters.mediaTypes?.length) params.set('mediaTypes', filters.mediaTypes.join(','));
  if (filters.state) params.set('state', filters.state);
  if (filters.transcodeDecisions?.length)
    params.set('transcodeDecisions', filters.transcodeDecisions.join(','));
  if (filters.network) params.set('network', filters.network);
  if (filters.platforms?.length) params.set('platforms', filters.platforms.join(','));
  if (filters.geoCountries?.length) params.set('countries', filters.geoCountries.join(','));
  if (filters.geoCity) params.set('city', filters.geoCity);
  if (filters.geoCityMissing) params.set('noCity', 'true');
  if (filters.geoRegion) params.set('region', filters.geoRegion);
  if (filters.geoRegionMissing) params.set('noRegion', 'true');
  if (filters.search) params.set('search', filters.search);
  if (!filters.startDate && !filters.endDate) {
    params.set('period', 'all');
  } else {
    for (const key of ['period', 'from', 'to']) {
      const value = current.get(key);
      if (value !== null) params.set(key, value);
    }
  }
  if (filters.watched !== undefined) params.set('watched', String(filters.watched));
  if (filters.subtitleBurnIn) params.set('subtitleBurnIn', 'true');
  if (filters.orderBy && filters.orderBy !== 'startedAt') params.set('orderBy', filters.orderBy);
  if (filters.orderDir && filters.orderDir !== 'desc') params.set('orderDir', filters.orderDir);

  return params;
}

export function History() {
  const { t } = useTranslation(['pages', 'common']);
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { value: range, setValue: setRange, apiParams } = useTimeRange();
  const { selectedServerIds, isMultiServer } = useServer();
  const { user } = useAuth();
  const isMember = user?.role === 'member';
  const [selectedSession, setSelectedSession] = useState<SessionWithDetails | null>(null);

  // Deep-link: fetch session by ID from route param and auto-open sheet
  const { data: linkedSession } = useSession(sessionId ?? '');
  const hasOpenedLinkedSession = useRef(false);

  useEffect(() => {
    if (linkedSession && !hasOpenedLinkedSession.current) {
      hasOpenedLinkedSession.current = true;
      setSelectedSession(linkedSession);
    }
  }, [linkedSession]);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(loadColumnVisibility);
  const [chosenColumns, setChosenColumns] = useState(loadChosenColumns);
  const wantedVisibility = useMemo(
    () => columnsForViewer(columnVisibility, isMember),
    [isMember, columnVisibility]
  );
  const {
    fitRef,
    columnVisibility: tableVisibility,
    fits,
  } = useFittedColumns(wantedVisibility, {
    isMultiServer,
    chosen: chosenColumns,
  });

  // A preset window is computed from now, so it is keyed on the range alone: a sort or
  // filter change must not shift it and refetch the aggregates.
  const { startDate: apiStart, endDate: apiEnd } = apiParams;
  const dateWindow = useMemo(
    () => resolveWindow(range.period, apiStart, apiEnd),
    [range.period, apiStart, apiEnd]
  );

  // Parse filters from URL on mount and when URL changes
  const filters = useMemo(() => {
    const parsed = parseFiltersFromUrl(searchParams, dateWindow);
    // Apply selected servers from context if not set in URL
    if (!parsed.serverIds?.length && selectedServerIds.length > 0) {
      parsed.serverIds = selectedServerIds;
    }
    return parsed;
  }, [searchParams, dateWindow, selectedServerIds]);

  // Query hooks
  const {
    data,
    isLoading,
    isFetching,
    isError: sessionsIsError,
    error: sessionsError,
    refetch: refetchSessions,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useHistorySessions(filters);

  // Separate aggregates query - uses data filters only (excludes sorting)
  // This prevents aggregates from reloading when sorting changes
  const { orderBy: _orderBy, orderDir: _orderDir, ...dataFilters } = filters;
  const {
    data: aggregatesData,
    isLoading: aggregatesLoading,
    isFetching: aggregatesFetching,
    isError: aggregatesIsError,
    error: aggregatesError,
    refetch: refetchAggregates,
  } = useHistoryAggregates(dataFilters);

  const { data: filterOptions, isLoading: filterOptionsLoading } = useFilterOptions({
    serverIds: filters.serverIds,
    startDate: filters.startDate,
    endDate: filters.endDate,
  });

  // Flatten pages into single sessions array
  const sessions = useMemo(() => {
    return data?.pages.flatMap((page) => page.data) ?? [];
  }, [data]);

  // Use aggregates from dedicated query (doesn't reload on sort changes)
  const aggregates = aggregatesData;
  const total = aggregatesData?.playCount;

  // Handle filter changes - update URL
  const handleFiltersChange = useCallback(
    (newFilters: HistoryFilters) => {
      setSearchParams(filtersToUrlParams(newFilters, searchParams), { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const updateChosenColumns = useCallback((chosen: HistoryColumnId[]) => {
    setChosenColumns(chosen);
    saveChosenColumns(chosen);
  }, []);

  const handleColumnToggle = useCallback(
    (column: HistoryColumnId, shown: boolean) => {
      if (!shown && chosenColumns.includes(column)) {
        updateChosenColumns(chosenColumns.filter((chosenColumn) => chosenColumn !== column));
        // The narrow table hides it again, and wider ones still show it
        if (!fits(wantedVisibility)) return;
      }
      const visibility = { ...columnVisibility, [column]: shown };
      setColumnVisibility(visibility);
      saveColumnVisibility(visibility);
      if (shown && isNarrowHiddenColumn(column) && !fits(columnsForViewer(visibility, isMember))) {
        updateChosenColumns([...chosenColumns, column]);
      }
    },
    [columnVisibility, chosenColumns, wantedVisibility, isMember, fits, updateChosenColumns]
  );

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
      <h1 className="sr-only">{t('pages:history.title')}</h1>

      {/* Aggregates Summary */}
      {aggregatesIsError ? (
        <InlineErrorState
          message={aggregatesError?.message ?? t('common:errors.unexpectedError')}
          onRetry={() => void refetchAggregates()}
        />
      ) : (
        <HistoryAggregates
          aggregates={aggregates}
          total={total}
          isLoading={aggregatesLoading}
          isFetching={aggregatesFetching}
        />
      )}

      {/* Filters */}
      <Card>
        <CardContent>
          <HistoryFiltersBar
            filters={filters}
            onFiltersChange={handleFiltersChange}
            timeRange={range}
            onTimeRangeChange={setRange}
            filterOptions={filterOptions}
            isFetching={isFetching || filterOptionsLoading}
            columnVisibility={tableVisibility}
            onColumnToggle={handleColumnToggle}
            isMultiServer={isMultiServer}
            isMember={isMember}
          />
        </CardContent>
      </Card>

      {/* Sessions Table */}
      {/* Card owns the vertical padding now, so a flush table zeroes both axes */}
      <Card className={sessionsIsError ? undefined : 'py-0'}>
        <CardContent ref={fitRef} className={sessionsIsError ? undefined : 'px-0'}>
          {sessionsIsError ? (
            <ErrorState
              title={t('common:errors.somethingWentWrong')}
              message={sessionsError?.message ?? t('common:errors.unexpectedError')}
              onRetry={() => void refetchSessions()}
            />
          ) : (
            <HistoryTable
              sessions={sessions}
              isLoading={isLoading}
              isFetching={isFetching}
              isFetchingNextPage={isFetchingNextPage}
              hasNextPage={hasNextPage}
              onLoadMore={() => void fetchNextPage()}
              onSessionClick={handleSessionClick}
              columnVisibility={tableVisibility}
              sortBy={filters.orderBy ?? 'startedAt'}
              sortDir={filters.orderDir ?? 'desc'}
              onSortChange={handleSortChange}
              isMultiServer={isMultiServer}
            />
          )}
        </CardContent>
      </Card>

      {/* Session Detail Sheet */}
      <SessionDetailSheet
        session={selectedSession}
        open={!!selectedSession}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSession(null);
            if (sessionId) void navigate('/history', { replace: true });
          }
        }}
      />
    </div>
  );
}
