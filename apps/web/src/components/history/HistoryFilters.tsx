/**
 * Clean filter bar for the History page using shadcn dropdown pattern.
 * Features TimeRangePicker, search, filter dropdown, and column visibility toggle.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Film,
  Tv,
  Music,
  MonitorPlay,
  Repeat2,
  X,
  Search,
  ListFilter,
  User,
  Globe,
  Monitor,
  ChevronDown,
  Check,
  Columns3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { TimeRangePicker, type TimeRangeValue } from '@/components/ui/time-range-picker';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { HistoryFilters } from '@/hooks/queries/useHistory';
import type { HistoryFilterOptions } from '@tracearr/shared';

// Column definitions for visibility toggle
export const HISTORY_COLUMNS = [
  { id: 'date', label: 'Date', defaultVisible: true },
  { id: 'user', label: 'User', defaultVisible: true },
  { id: 'content', label: 'Content', defaultVisible: true },
  { id: 'platform', label: 'Platform', defaultVisible: true },
  { id: 'location', label: 'Location', defaultVisible: true },
  { id: 'quality', label: 'Quality', defaultVisible: true },
  { id: 'duration', label: 'Duration', defaultVisible: true },
  { id: 'progress', label: 'Progress', defaultVisible: true },
] as const;

export type HistoryColumnId = (typeof HISTORY_COLUMNS)[number]['id'];
export type ColumnVisibility = Record<HistoryColumnId, boolean>;

// Default visibility state
export const DEFAULT_COLUMN_VISIBILITY: ColumnVisibility = Object.fromEntries(
  HISTORY_COLUMNS.map((col) => [col.id, col.defaultVisible])
) as ColumnVisibility;

interface Props {
  filters: HistoryFilters;
  onFiltersChange: (filters: HistoryFilters) => void;
  filterOptions?: HistoryFilterOptions;
  isLoading?: boolean;
  columnVisibility: ColumnVisibility;
  onColumnVisibilityChange: (visibility: ColumnVisibility) => void;
}

// Convert TimeRangeValue to Date filters
function timeRangeToDateFilters(timeRange: TimeRangeValue): { startDate?: Date; endDate?: Date } {
  if (timeRange.period === 'custom' && timeRange.startDate && timeRange.endDate) {
    return { startDate: timeRange.startDate, endDate: timeRange.endDate };
  }

  const now = new Date();
  const endDate = now;
  let startDate: Date | undefined;

  switch (timeRange.period) {
    case 'day':
      startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case 'week':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'year':
      startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    case 'all':
    default:
      return {};
  }

  return { startDate, endDate };
}

// Convert Date filters back to TimeRangeValue
function dateFiltersToTimeRange(startDate?: Date, endDate?: Date): TimeRangeValue {
  if (!startDate && !endDate) {
    return { period: 'all' };
  }

  if (startDate && endDate) {
    const diff = endDate.getTime() - startDate.getTime();
    const days = diff / (24 * 60 * 60 * 1000);

    if (days >= 6 && days <= 8) return { period: 'week' };
    if (days >= 29 && days <= 31) return { period: 'month' };
    if (days >= 364 && days <= 366) return { period: 'year' };

    return { period: 'custom', startDate, endDate };
  }

  return { period: 'all' };
}

// Filter chip component
function FilterChip({
  label,
  value,
  icon: Icon,
  onRemove,
}: {
  label: string;
  value: string;
  icon?: typeof User;
  onRemove: () => void;
}) {
  return (
    <Badge variant="secondary" className="h-7 gap-1.5 pr-1.5 pl-2.5 text-xs font-normal">
      {Icon && <Icon className="text-muted-foreground h-3 w-3" />}
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-[120px] truncate font-medium">{value}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="hover:bg-muted-foreground/20 ml-0.5 rounded-full p-0.5"
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}

export function HistoryFiltersBar({
  filters,
  onFiltersChange,
  filterOptions,
  isLoading,
  columnVisibility,
  onColumnVisibilityChange,
}: Props) {
  const [searchInput, setSearchInput] = useState(filters.search ?? '');

  // Sync search input with filters
  useEffect(() => {
    setSearchInput(filters.search ?? '');
  }, [filters.search]);

  // Convert current date filters to TimeRangeValue
  const timeRange = useMemo(
    () => dateFiltersToTimeRange(filters.startDate, filters.endDate),
    [filters.startDate, filters.endDate]
  );

  // Handle time range change
  const handleTimeRangeChange = useCallback(
    (newTimeRange: TimeRangeValue) => {
      const dateFilters = timeRangeToDateFilters(newTimeRange);
      onFiltersChange({ ...filters, ...dateFilters });
    },
    [filters, onFiltersChange]
  );

  // Build active filters list
  const activeFilters = useMemo(() => {
    const active: {
      key: keyof HistoryFilters;
      label: string;
      value: string;
      icon?: typeof User;
    }[] = [];

    if (filters.serverUserId) {
      const user = filterOptions?.users?.find((u) => u.id === filters.serverUserId);
      active.push({
        key: 'serverUserId',
        label: 'User',
        value: user?.identityName || user?.username || 'Unknown',
        icon: User,
      });
    }
    if (filters.platform) {
      active.push({ key: 'platform', label: 'Platform', value: filters.platform, icon: Monitor });
    }
    if (filters.geoCountry) {
      active.push({ key: 'geoCountry', label: 'Country', value: filters.geoCountry, icon: Globe });
    }
    if (filters.mediaType) {
      const labels = { movie: 'Movies', episode: 'TV Shows', track: 'Music' };
      active.push({
        key: 'mediaType',
        label: 'Type',
        value: labels[filters.mediaType],
        icon: Film,
      });
    }
    if (filters.isTranscode !== undefined) {
      active.push({
        key: 'isTranscode',
        label: 'Quality',
        value: filters.isTranscode ? 'Transcode' : 'Direct',
        icon: filters.isTranscode ? Repeat2 : MonitorPlay,
      });
    }

    return active;
  }, [filters, filterOptions?.users]);

  // Debounced search effect
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (searchInput !== (filters.search ?? '')) {
        onFiltersChange({ ...filters, search: searchInput || undefined });
      }
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [searchInput, filters, onFiltersChange]);

  // Remove a specific filter
  const removeFilter = useCallback(
    (key: keyof HistoryFilters) => {
      const { [key]: _, ...newFilters } = filters;
      if (key === 'search') setSearchInput('');
      onFiltersChange(newFilters);
    },
    [filters, onFiltersChange]
  );

  // Clear all filters
  const clearFilters = useCallback(() => {
    setSearchInput('');
    onFiltersChange({});
  }, [onFiltersChange]);

  // Toggle column visibility
  const toggleColumn = useCallback(
    (columnId: HistoryColumnId) => {
      onColumnVisibilityChange({
        ...columnVisibility,
        [columnId]: !columnVisibility[columnId],
      });
    },
    [columnVisibility, onColumnVisibilityChange]
  );

  const hasActiveFilters = activeFilters.length > 0 || filters.search;
  const activeFilterCount = activeFilters.length + (filters.search ? 1 : 0);
  const hiddenColumnCount = Object.values(columnVisibility).filter((v) => !v).length;

  // Sort users alphabetically (case-insensitive)
  const sortedUsers = useMemo(() => {
    if (!filterOptions?.users) return [];
    return [...filterOptions.users].sort((a, b) => {
      const nameA = (a.identityName || a.username || '').toLowerCase();
      const nameB = (b.identityName || b.username || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [filterOptions?.users]);

  return (
    <div className="space-y-3">
      {/* Row 1: Time range, search, filter dropdown, and columns dropdown */}
      <div className="flex flex-wrap items-center gap-3">
        <TimeRangePicker value={timeRange} onChange={handleTimeRangeChange} />

        <div className="relative max-w-[400px] min-w-[200px] flex-1">
          <Search className="text-muted-foreground absolute top-2 left-2.5 h-4 w-4" />
          <Input
            placeholder="Search titles, users, locations, IPs..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-8 pr-8 pl-8 text-sm"
          />
          {searchInput && (
            <button
              onClick={() => {
                setSearchInput('');
                onFiltersChange({ ...filters, search: undefined });
              }}
              className="text-muted-foreground hover:text-foreground absolute top-2 right-2"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Filter dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <ListFilter className="h-4 w-4" />
              Filters
              {activeFilterCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                  {activeFilterCount}
                </Badge>
              )}
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {/* User filter */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <User className="mr-2 h-4 w-4" />
                User
                {filters.serverUserId && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="p-0">
                <ScrollArea className="h-[200px]">
                  <div className="p-1">
                    <DropdownMenuItem
                      onClick={() => removeFilter('serverUserId')}
                      className={cn(!filters.serverUserId && 'hidden')}
                    >
                      <X className="mr-2 h-4 w-4" />
                      Clear user filter
                    </DropdownMenuItem>
                    {filters.serverUserId && <DropdownMenuSeparator />}
                    {sortedUsers.map((user) => (
                      <DropdownMenuItem
                        key={user.id}
                        onClick={() => onFiltersChange({ ...filters, serverUserId: user.id })}
                      >
                        <Avatar className="mr-2 h-5 w-5">
                          <AvatarImage src={user.thumbUrl ?? undefined} />
                          <AvatarFallback className="text-[8px]">
                            {user.username?.[0]?.toUpperCase() ?? '?'}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 truncate">
                          {user.identityName || user.username}
                        </span>
                        {filters.serverUserId === user.id && <Check className="ml-2 h-4 w-4" />}
                      </DropdownMenuItem>
                    ))}
                  </div>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Platform filter */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Monitor className="mr-2 h-4 w-4" />
                Platform
                {filters.platform && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="p-0">
                <ScrollArea className="h-[200px]">
                  <div className="p-1">
                    <DropdownMenuItem
                      onClick={() => removeFilter('platform')}
                      className={cn(!filters.platform && 'hidden')}
                    >
                      <X className="mr-2 h-4 w-4" />
                      Clear platform filter
                    </DropdownMenuItem>
                    {filters.platform && <DropdownMenuSeparator />}
                    {filterOptions?.platforms?.map((opt) => (
                      <DropdownMenuItem
                        key={opt.value}
                        onClick={() => onFiltersChange({ ...filters, platform: opt.value })}
                      >
                        <Monitor className="text-muted-foreground mr-2 h-4 w-4" />
                        <span className="flex-1 truncate">{opt.value}</span>
                        <Badge variant="secondary" className="ml-2 text-[10px]">
                          {opt.count}
                        </Badge>
                        {filters.platform === opt.value && <Check className="ml-1 h-4 w-4" />}
                      </DropdownMenuItem>
                    ))}
                  </div>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Country filter */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="mr-2 h-4 w-4" />
                Country
                {filters.geoCountry && <Check className="ml-auto h-4 w-4" />}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="p-0">
                <ScrollArea className="h-[200px]">
                  <div className="p-1">
                    <DropdownMenuItem
                      onClick={() => removeFilter('geoCountry')}
                      className={cn(!filters.geoCountry && 'hidden')}
                    >
                      <X className="mr-2 h-4 w-4" />
                      Clear country filter
                    </DropdownMenuItem>
                    {filters.geoCountry && <DropdownMenuSeparator />}
                    {filterOptions?.countries?.map((opt) => (
                      <DropdownMenuItem
                        key={opt.value}
                        onClick={() => onFiltersChange({ ...filters, geoCountry: opt.value })}
                      >
                        <Globe className="text-muted-foreground mr-2 h-4 w-4" />
                        <span className="flex-1 truncate">{opt.value}</span>
                        <Badge variant="secondary" className="ml-2 text-[10px]">
                          {opt.count}
                        </Badge>
                        {filters.geoCountry === opt.value && <Check className="ml-1 h-4 w-4" />}
                      </DropdownMenuItem>
                    ))}
                  </div>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            {/* Media Type - radio group */}
            <DropdownMenuLabel>Media Type</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filters.mediaType ?? ''}
              onValueChange={(value) => {
                if (value === '') {
                  removeFilter('mediaType');
                } else {
                  onFiltersChange({
                    ...filters,
                    mediaType: value as 'movie' | 'episode' | 'track',
                  });
                }
              }}
            >
              <DropdownMenuRadioItem value="">All</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="movie">
                <Film className="mr-2 h-4 w-4" />
                Movies
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="episode">
                <Tv className="mr-2 h-4 w-4" />
                TV Shows
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="track">
                <Music className="mr-2 h-4 w-4" />
                Music
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />

            {/* Quality - radio group */}
            <DropdownMenuLabel>Quality</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={
                filters.isTranscode === undefined
                  ? ''
                  : filters.isTranscode
                    ? 'transcode'
                    : 'direct'
              }
              onValueChange={(value) => {
                if (value === '') {
                  removeFilter('isTranscode');
                } else {
                  onFiltersChange({ ...filters, isTranscode: value === 'transcode' });
                }
              }}
            >
              <DropdownMenuRadioItem value="">All</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="direct">
                <MonitorPlay className="mr-2 h-4 w-4" />
                Direct Play
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="transcode">
                <Repeat2 className="mr-2 h-4 w-4" />
                Transcode
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>

            {/* Clear all button */}
            {hasActiveFilters && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={clearFilters} className="text-muted-foreground">
                  <X className="mr-2 h-4 w-4" />
                  Clear all filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Column visibility dropdown - shadcn pattern */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <Columns3 className="h-4 w-4" />
              Columns
              {hiddenColumnCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                  {HISTORY_COLUMNS.length - hiddenColumnCount}
                </Badge>
              )}
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {HISTORY_COLUMNS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column.id}
                checked={columnVisibility[column.id]}
                onCheckedChange={() => toggleColumn(column.id)}
              >
                {column.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {isLoading && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <div className="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        )}
      </div>

      {/* Row 2: Active filters as chips (only show if filters are applied) */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2">
          {activeFilters.map((filter) => (
            <FilterChip
              key={filter.key}
              label={filter.label}
              value={filter.value}
              icon={filter.icon}
              onRemove={() => removeFilter(filter.key)}
            />
          ))}

          {filters.search && (
            <FilterChip
              label="Search"
              value={filters.search}
              icon={Search}
              onRemove={() => {
                setSearchInput('');
                removeFilter('search');
              }}
            />
          )}

          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-7 gap-1 px-2 text-xs"
            onClick={clearFilters}
          >
            <X className="h-3.5 w-3.5" />
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
