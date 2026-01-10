/**
 * Clean filter bar for the History page using shadcn dropdown pattern.
 * Features TimeRangePicker, search, filter dropdown, and column visibility toggle.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Film,
  Tv,
  Music,
  Radio,
  MonitorPlay,
  Repeat2,
  X,
  Search,
  ListFilter,
  User,
  Globe,
  Monitor,
  ChevronDown,
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
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { TimeRangePicker, type TimeRangeValue } from '@/components/ui/time-range-picker';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { HistoryFilters } from '@/hooks/queries/useHistory';
import type { HistoryFilterOptions } from '@tracearr/shared';

// Column definitions for visibility toggle
export const HISTORY_COLUMNS = [
  { id: 'date', label: 'Date', defaultVisible: true },
  { id: 'user', label: 'User', defaultVisible: true },
  { id: 'content', label: 'Content', defaultVisible: true },
  { id: 'platform', label: 'Platform', defaultVisible: true },
  { id: 'location', label: 'Location', defaultVisible: true },
  { id: 'ip', label: 'IP Address', defaultVisible: false },
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
      onFiltersChange({
        ...filters,
        startDate: dateFilters.startDate,
        endDate: dateFilters.endDate,
      });
    },
    [filters, onFiltersChange]
  );

  const activeFilters = useMemo(() => {
    const active: {
      key: keyof HistoryFilters;
      label: string;
      value: string;
      icon?: typeof User;
    }[] = [];

    if (filters.serverUserIds?.length) {
      const userNames = filters.serverUserIds.map((id) => {
        const user = filterOptions?.users?.find((u) => u.id === id);
        return user?.identityName || user?.username || 'Unknown';
      });
      active.push({
        key: 'serverUserIds',
        label: 'Users',
        value: userNames.length > 2 ? `${userNames.length} selected` : userNames.join(', '),
        icon: User,
      });
    }
    if (filters.platforms?.length) {
      active.push({
        key: 'platforms',
        label: 'Platforms',
        value:
          filters.platforms.length > 2
            ? `${filters.platforms.length} selected`
            : filters.platforms.join(', '),
        icon: Monitor,
      });
    }
    if (filters.geoCountries?.length) {
      active.push({
        key: 'geoCountries',
        label: 'Countries',
        value:
          filters.geoCountries.length > 2
            ? `${filters.geoCountries.length} selected`
            : filters.geoCountries.join(', '),
        icon: Globe,
      });
    }
    if (filters.mediaTypes?.length) {
      const labels: Record<string, string> = {
        movie: 'Movies',
        episode: 'TV Shows',
        track: 'Music',
        live: 'Live TV',
      };
      const typeLabels = filters.mediaTypes.map((t) => labels[t] || t);
      active.push({
        key: 'mediaTypes',
        label: 'Types',
        value: typeLabels.length > 2 ? `${typeLabels.length} selected` : typeLabels.join(', '),
        icon: Film,
      });
    }
    if (filters.transcodeDecisions?.length) {
      const labels = {
        directplay: 'Direct Play',
        copy: 'Direct Stream',
        transcode: 'Transcode',
      };
      const decisionLabels = filters.transcodeDecisions.map((d) => labels[d]);
      active.push({
        key: 'transcodeDecisions',
        label: 'Quality',
        value:
          decisionLabels.length > 2
            ? `${decisionLabels.length} selected`
            : decisionLabels.join(', '),
        icon: filters.transcodeDecisions.includes('transcode') ? Repeat2 : MonitorPlay,
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
            {/* User filter - multi-select */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <User className="mr-2 h-4 w-4" />
                Users
                {filters.serverUserIds?.length ? (
                  <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-[10px]">
                    {filters.serverUserIds.length}
                  </Badge>
                ) : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="p-0">
                <ScrollArea className="h-[250px]">
                  <div className="p-1">
                    {filters.serverUserIds?.length ? (
                      <>
                        <DropdownMenuItem onClick={() => removeFilter('serverUserIds')}>
                          <X className="mr-2 h-4 w-4" />
                          Clear all users
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    {sortedUsers.map((user) => {
                      const isSelected = filters.serverUserIds?.includes(user.id) ?? false;
                      return (
                        <DropdownMenuCheckboxItem
                          key={user.id}
                          checked={isSelected}
                          onCheckedChange={(checked) => {
                            const current = filters.serverUserIds ?? [];
                            const updated = checked
                              ? [...current, user.id]
                              : current.filter((id) => id !== user.id);
                            onFiltersChange({
                              ...filters,
                              serverUserIds: updated.length > 0 ? updated : undefined,
                            });
                          }}
                          onSelect={(e) => e.preventDefault()}
                        >
                          <Avatar className="mr-2 h-5 w-5">
                            <AvatarImage src={user.thumbUrl ?? undefined} />
                            <AvatarFallback className="text-[8px]">
                              {user.username?.[0]?.toUpperCase() ?? '?'}
                            </AvatarFallback>
                          </Avatar>
                          <span className="truncate">{user.identityName || user.username}</span>
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </div>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Platform filter - multi-select */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Monitor className="mr-2 h-4 w-4" />
                Platforms
                {filters.platforms?.length ? (
                  <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-[10px]">
                    {filters.platforms.length}
                  </Badge>
                ) : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="p-0">
                <ScrollArea className="h-[250px]">
                  <div className="p-1">
                    {filters.platforms?.length ? (
                      <>
                        <DropdownMenuItem onClick={() => removeFilter('platforms')}>
                          <X className="mr-2 h-4 w-4" />
                          Clear all platforms
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    {filterOptions?.platforms?.map((opt) => {
                      const isSelected = filters.platforms?.includes(opt.value) ?? false;
                      return (
                        <DropdownMenuCheckboxItem
                          key={opt.value}
                          checked={isSelected}
                          onCheckedChange={(checked) => {
                            const current = filters.platforms ?? [];
                            const updated = checked
                              ? [...current, opt.value]
                              : current.filter((p) => p !== opt.value);
                            onFiltersChange({
                              ...filters,
                              platforms: updated.length > 0 ? updated : undefined,
                            });
                          }}
                          onSelect={(e) => e.preventDefault()}
                        >
                          <Monitor className="text-muted-foreground mr-2 h-4 w-4" />
                          <span className="flex-1 truncate">{opt.value}</span>
                          <Badge variant="secondary" className="ml-2 text-[10px]">
                            {opt.count}
                          </Badge>
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </div>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Country filter - multi-select */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="mr-2 h-4 w-4" />
                Countries
                {filters.geoCountries?.length ? (
                  <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-[10px]">
                    {filters.geoCountries.length}
                  </Badge>
                ) : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="p-0">
                <ScrollArea className="h-[250px]">
                  <div className="p-1">
                    {filters.geoCountries?.length ? (
                      <>
                        <DropdownMenuItem onClick={() => removeFilter('geoCountries')}>
                          <X className="mr-2 h-4 w-4" />
                          Clear all countries
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    {filterOptions?.countries?.map((opt) => {
                      const isSelected = filters.geoCountries?.includes(opt.value) ?? false;
                      return (
                        <DropdownMenuCheckboxItem
                          key={opt.value}
                          checked={isSelected}
                          onCheckedChange={(checked) => {
                            const current = filters.geoCountries ?? [];
                            const updated = checked
                              ? [...current, opt.value]
                              : current.filter((c) => c !== opt.value);
                            onFiltersChange({
                              ...filters,
                              geoCountries: updated.length > 0 ? updated : undefined,
                            });
                          }}
                          onSelect={(e) => e.preventDefault()}
                        >
                          <Globe className="text-muted-foreground mr-2 h-4 w-4" />
                          <span className="flex-1 truncate">{opt.value}</span>
                          <Badge variant="secondary" className="ml-2 text-[10px]">
                            {opt.count}
                          </Badge>
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </div>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            {/* Media Type - multi-select checkboxes */}
            <DropdownMenuLabel className="flex items-center justify-between">
              Media Type
              {filters.mediaTypes?.length ? (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {filters.mediaTypes.length}
                </Badge>
              ) : null}
            </DropdownMenuLabel>
            {[
              { value: 'movie' as const, label: 'Movies', icon: Film },
              { value: 'episode' as const, label: 'TV Shows', icon: Tv },
              { value: 'track' as const, label: 'Music', icon: Music },
              { value: 'live' as const, label: 'Live TV', icon: Radio },
            ].map(({ value, label, icon: Icon }) => {
              const isSelected = filters.mediaTypes?.includes(value) ?? false;
              return (
                <DropdownMenuCheckboxItem
                  key={value}
                  checked={isSelected}
                  onCheckedChange={(checked) => {
                    const current = filters.mediaTypes ?? [];
                    const updated = checked
                      ? [...current, value]
                      : current.filter((t) => t !== value);
                    onFiltersChange({
                      ...filters,
                      mediaTypes: updated.length > 0 ? updated : undefined,
                    });
                  }}
                  onSelect={(e) => e.preventDefault()}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                </DropdownMenuCheckboxItem>
              );
            })}

            <DropdownMenuSeparator />

            {/* Quality - multi-select checkboxes */}
            <DropdownMenuLabel className="flex items-center justify-between">
              Quality
              {filters.transcodeDecisions?.length ? (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {filters.transcodeDecisions.length}
                </Badge>
              ) : null}
            </DropdownMenuLabel>
            {[
              { value: 'directplay' as const, label: 'Direct Play', icon: MonitorPlay },
              { value: 'copy' as const, label: 'Direct Stream', icon: MonitorPlay },
              { value: 'transcode' as const, label: 'Transcode', icon: Repeat2 },
            ].map(({ value, label, icon: Icon }) => {
              const isSelected = filters.transcodeDecisions?.includes(value) ?? false;
              return (
                <DropdownMenuCheckboxItem
                  key={value}
                  checked={isSelected}
                  onCheckedChange={(checked) => {
                    const current = filters.transcodeDecisions ?? [];
                    const updated = checked
                      ? [...current, value]
                      : current.filter((d) => d !== value);
                    onFiltersChange({
                      ...filters,
                      transcodeDecisions: updated.length > 0 ? updated : undefined,
                    });
                  }}
                  onSelect={(e) => e.preventDefault()}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                </DropdownMenuCheckboxItem>
              );
            })}

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
