import { lazy, Suspense, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
const StreamMap = lazy(() =>
  import('@/components/map/StreamMap').then((m) => ({ default: m.StreamMap }))
);
import { ServerLegend } from '@/components/server';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Button } from '@/components/ui/button';
import { X, Flame, CircleDot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ErrorState } from '@/components/library/ErrorState';
import { useLocationStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import { useTimeRange } from '@/hooks/useTimeRange';

export function Map() {
  const { t } = useTranslation(['pages', 'common']);
  const [searchParams, setSearchParams] = useSearchParams();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();
  const serverColorMap = useServerColorMap();

  const MEDIA_TYPES = useMemo(
    () =>
      [
        { value: 'movie', label: t('common:media.movie_plural') },
        { value: 'episode', label: t('common:media.tv') },
        { value: 'track', label: t('common:media.music') },
      ] as const,
    [t]
  );

  // Parse filters from URL, use selected servers from context
  const filters = useMemo(() => {
    const serverUserId = searchParams.get('serverUserId');
    // Additive: the full set of a merged person's account ids, captured at
    // selection time so their whole history (not just the representative
    // account) is filtered. Falls back to the single id for older links.
    const serverUserIdsParam = searchParams.get('serverUserIds');
    const serverUserIds = serverUserIdsParam
      ? serverUserIdsParam.split(',').filter(Boolean)
      : undefined;
    const mediaType = searchParams.get('mediaType') as 'movie' | 'episode' | 'track' | null;
    const viewMode = (searchParams.get('view') as 'heatmap' | 'circles') || 'heatmap';

    return {
      serverUserId: serverUserId || undefined,
      serverUserIds,
      mediaType: mediaType || undefined,
      viewMode,
    };
  }, [searchParams]);

  // Build API params including time range
  const apiParams = useMemo(
    () => ({
      timeRange: {
        period: timeRange.period,
        startDate: timeRange.startDate?.toISOString(),
        endDate: timeRange.endDate?.toISOString(),
      },
      serverUserId: filters.serverUserId,
      serverUserIds: filters.serverUserIds,
      serverIds: selectedServerIds.length ? selectedServerIds : undefined,
      mediaType: filters.mediaType,
    }),
    [timeRange, filters, selectedServerIds]
  );

  const filterKey = useMemo(() => JSON.stringify(apiParams), [apiParams]);

  // Fetch data - includes available filter options based on current filters
  const {
    data: locationData,
    isLoading: locationsLoading,
    isError: locationsError,
    error: locationsErrorObj,
    refetch: refetchLocations,
  } = useLocationStats(apiParams);

  const locations = locationData?.data ?? [];
  const summary = locationData?.summary;
  const availableFilters = locationData?.availableFilters;

  // Dynamic filter options from the response
  const users = useMemo(() => availableFilters?.users ?? [], [availableFilters]);
  const mediaTypes = availableFilters?.mediaTypes ?? [];

  // Get selected filter labels for display
  const selectedUser = users.find((u) => u.id === filters.serverUserId);
  const selectedMediaType = MEDIA_TYPES.find((m) => m.value === filters.mediaType);

  // Filter MEDIA_TYPES to only show available options
  const availableMediaTypeOptions = MEDIA_TYPES.filter((m) => mediaTypes.includes(m.value));

  // Server name lookup for popup breakdowns
  const serverNameMap = useMemo(
    () => Object.fromEntries(selectedServers.map((s) => [s.id, s.name])),
    [selectedServers]
  );

  // If the selected person drops out of the option list (e.g. a server or media
  // type change narrows the context so they no longer have matching activity),
  // clear the stale selection instead of silently filtering on a vanished id.
  useEffect(() => {
    if (!filters.serverUserId || locationsLoading || !availableFilters) return;
    if (users.some((u) => u.id === filters.serverUserId)) return;
    const params = new URLSearchParams(searchParams);
    params.delete('serverUserId');
    params.delete('serverUserIds');
    setSearchParams(params, { replace: true });
  }, [
    filters.serverUserId,
    users,
    locationsLoading,
    availableFilters,
    searchParams,
    setSearchParams,
  ]);

  // Update a single filter
  const setFilter = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    setSearchParams(params, { replace: true });
  };

  // Update the user filter - also captures the person's full account set so
  // filtering covers a merged identity's history across every server, not
  // just the representative account shown in the dropdown.
  const setUserFilter = (value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value === '_all') {
      params.delete('serverUserId');
      params.delete('serverUserIds');
    } else {
      const person = users.find((u) => u.id === value);
      params.set('serverUserId', value);
      const ids = person?.serverUserIds?.length ? person.serverUserIds : [value];
      params.set('serverUserIds', ids.join(','));
    }
    setSearchParams(params, { replace: true });
  };

  // Set view mode
  const setViewMode = (mode: 'heatmap' | 'circles') => {
    setFilter('view', mode === 'heatmap' ? null : mode);
  };

  // Clear all filters (except time range which has its own controls)
  const clearFilters = () => {
    const params = new URLSearchParams();
    // Preserve time range params
    const period = searchParams.get('period');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (period) params.set('period', period);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    setSearchParams(params, { replace: true });
  };

  // Check if any non-time filters are active
  const hasFilters = filters.serverUserId || filters.mediaType;

  // Build summary text
  const summaryContext = useMemo(() => {
    const parts: string[] = [];
    if (selectedUser) parts.push(selectedUser.identityName ?? selectedUser.username);
    if (selectedMediaType) parts.push(selectedMediaType.label);
    return parts.join(' · ') || t('map.allActivity');
  }, [selectedUser, selectedMediaType, t]);

  const hasData = locations.length > 0;

  return (
    <div className="-m-6 flex h-[calc(100vh-3rem)] flex-col md:h-screen">
      {/* Filter bar */}
      <div className="bg-card/50 relative z-20 flex items-center gap-3 border-b px-4 py-2 backdrop-blur">
        {/* Time range picker */}
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />

        <div className="bg-border h-4 w-px" />

        {/* User filter */}
        <Select value={filters.serverUserId ?? '_all'} onValueChange={setUserFilter}>
          <SelectTrigger className="h-8 w-[140px] text-sm">
            <SelectValue placeholder={t('map.allUsers')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">{t('map.allUsers')}</SelectItem>
            {users.map((user) => (
              <SelectItem key={user.id} value={user.id}>
                {user.identityName ?? user.username}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Media type filter */}
        <Select
          value={filters.mediaType ?? '_all'}
          onValueChange={(v) => setFilter('mediaType', v === '_all' ? null : v)}
        >
          <SelectTrigger className="h-8 w-[100px] text-sm">
            <SelectValue placeholder={t('map.allTypes')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">{t('map.allTypes')}</SelectItem>
            {availableMediaTypeOptions.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="text-muted-foreground hover:text-foreground h-8 px-2"
          >
            <X className="h-4 w-4" />
          </Button>
        )}

        <div className="bg-border h-4 w-px" />

        {/* View mode toggle */}
        <div className="bg-muted/50 flex h-8 rounded-md border p-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setViewMode('heatmap')}
            className={cn(
              'h-7 gap-1.5 rounded-sm px-2.5 text-xs',
              filters.viewMode === 'heatmap'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-transparent'
            )}
          >
            <Flame className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('map.heatmap')}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setViewMode('circles')}
            className={cn(
              'h-7 gap-1.5 rounded-sm px-2.5 text-xs',
              filters.viewMode === 'circles'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-transparent'
            )}
          >
            <CircleDot className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('map.circles')}</span>
          </Button>
        </div>

        {/* Summary stats - right side */}
        <div className="ml-auto flex items-center gap-4 text-sm">
          <div className="text-muted-foreground">{summaryContext}</div>
          <div className="flex items-center gap-3">
            <div>
              <span className="font-semibold tabular-nums">{summary?.totalStreams ?? 0}</span>
              <span className="text-muted-foreground ml-1">{t('map.streams')}</span>
            </div>
            <div className="bg-border h-4 w-px" />
            <div>
              <span className="font-semibold tabular-nums">{summary?.uniqueLocations ?? 0}</span>
              <span className="text-muted-foreground ml-1">{t('map.locations')}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Map */}
      <div className="relative flex-1">
        {locationsError ? (
          <ErrorState
            title={t('common:errors.somethingWentWrong')}
            message={locationsErrorObj?.message ?? t('common:errors.unexpectedError')}
            onRetry={() => void refetchLocations()}
          />
        ) : (
          <>
            <Suspense fallback={<div className="bg-muted/30 h-full w-full animate-pulse" />}>
              <StreamMap
                locations={locations}
                isLoading={locationsLoading}
                viewMode={filters.viewMode}
                filterKey={filterKey}
                serverColorMap={serverColorMap}
                serverNameMap={serverNameMap}
                isMultiServer={isMultiServer}
              />
            </Suspense>
            {isMultiServer && hasData && filters.viewMode === 'circles' && (
              <ServerLegend variant="floating" servers={selectedServers} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
