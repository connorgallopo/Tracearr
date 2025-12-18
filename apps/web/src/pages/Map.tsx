import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { StreamMap } from '@/components/map';
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
import { useLocationStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';

const MEDIA_TYPES = [
  { value: 'movie', label: 'Movies' },
  { value: 'episode', label: 'TV' },
  { value: 'track', label: 'Music' },
] as const;

export function Map() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();
  const { selectedServerId } = useServer();

  // Parse filters from URL, use selected server from context
  const filters = useMemo(() => {
    const serverUserId = searchParams.get('serverUserId');
    const mediaType = searchParams.get('mediaType') as 'movie' | 'episode' | 'track' | null;
    const viewMode = (searchParams.get('view') as 'heatmap' | 'circles') || 'heatmap';

    return {
      serverUserId: serverUserId || undefined,
      serverId: selectedServerId || undefined,
      mediaType: mediaType || undefined,
      viewMode,
    };
  }, [searchParams, selectedServerId]);

  // Build API params including time range
  const apiParams = useMemo(
    () => ({
      timeRange: {
        period: timeRange.period,
        startDate: timeRange.startDate?.toISOString(),
        endDate: timeRange.endDate?.toISOString(),
      },
      serverUserId: filters.serverUserId,
      serverId: filters.serverId,
      mediaType: filters.mediaType,
    }),
    [timeRange, filters]
  );

  // Fetch data - includes available filter options based on current filters
  const { data: locationData, isLoading: locationsLoading } = useLocationStats(apiParams);

  const locations = locationData?.data ?? [];
  const summary = locationData?.summary;
  const availableFilters = locationData?.availableFilters;

  // Dynamic filter options from the response
  const users = availableFilters?.users ?? [];
  const mediaTypes = availableFilters?.mediaTypes ?? [];

  // Get selected filter labels for display
  const selectedUser = users.find((u) => u.id === filters.serverUserId);
  const selectedMediaType = MEDIA_TYPES.find((m) => m.value === filters.mediaType);

  // Filter MEDIA_TYPES to only show available options
  const availableMediaTypeOptions = MEDIA_TYPES.filter((m) => mediaTypes.includes(m.value));

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

  // Set view mode
  const setViewMode = (mode: 'heatmap' | 'circles') => {
    setFilter('view', mode === 'heatmap' ? null : mode);
  };

  // Clear all filters (except time range which has its own controls)
  const clearFilters = () => {
    const params = new URLSearchParams();
    // Preserve time range params
    if (searchParams.get('period')) params.set('period', searchParams.get('period')!);
    if (searchParams.get('from')) params.set('from', searchParams.get('from')!);
    if (searchParams.get('to')) params.set('to', searchParams.get('to')!);
    setSearchParams(params, { replace: true });
  };

  // Check if any non-time filters are active
  const hasFilters = filters.serverUserId || filters.mediaType;

  // Build summary text
  const summaryContext = useMemo(() => {
    const parts: string[] = [];
    if (selectedUser) parts.push(selectedUser.identityName ?? selectedUser.username);
    if (selectedMediaType) parts.push(selectedMediaType.label);
    return parts.join(' · ') || 'All activity';
  }, [selectedUser, selectedMediaType]);

  return (
    <div className="-m-6 flex h-[calc(100vh-4rem)] flex-col">
      {/* Filter bar */}
      <div className="bg-card/50 relative z-20 flex items-center gap-3 border-b px-4 py-2 backdrop-blur">
        {/* Time range picker */}
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />

        <div className="bg-border h-4 w-px" />

        {/* User filter */}
        <Select
          value={filters.serverUserId ?? '_all'}
          onValueChange={(v) => setFilter('serverUserId', v === '_all' ? null : v)}
        >
          <SelectTrigger className="h-8 w-[140px] text-sm">
            <SelectValue placeholder="All users" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All users</SelectItem>
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
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All types</SelectItem>
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
            <span className="hidden sm:inline">Heatmap</span>
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
            <span className="hidden sm:inline">Circles</span>
          </Button>
        </div>

        {/* Summary stats - right side */}
        <div className="ml-auto flex items-center gap-4 text-sm">
          <div className="text-muted-foreground">{summaryContext}</div>
          <div className="flex items-center gap-3">
            <div>
              <span className="font-semibold tabular-nums">{summary?.totalStreams ?? 0}</span>
              <span className="text-muted-foreground ml-1">streams</span>
            </div>
            <div className="bg-border h-4 w-px" />
            <div>
              <span className="font-semibold tabular-nums">{summary?.uniqueLocations ?? 0}</span>
              <span className="text-muted-foreground ml-1">locations</span>
            </div>
          </div>
        </div>
      </div>

      {/* Map */}
      <div className="relative flex-1">
        <StreamMap locations={locations} isLoading={locationsLoading} viewMode={filters.viewMode} />
      </div>
    </div>
  );
}
