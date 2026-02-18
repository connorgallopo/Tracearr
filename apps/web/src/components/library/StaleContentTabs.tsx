import { useState, useEffect } from 'react';
import {
  Archive,
  Film,
  Tv,
  Music,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CalendarIcon,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { formatMediaTech, type StaleResponse } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { useLibraryStale } from '@/hooks/queries/useLibrary';
import { formatBytes } from '@/lib/formatters';
import { EmptyState } from '@/components/library';
import { cn } from '@/lib/utils';

type MediaTypeFilter = 'all' | 'movie' | 'show' | 'artist';
type SortBy = 'size' | 'title' | 'days_stale' | 'added_at';
type SortOrder = 'asc' | 'desc';

/**
 * Format days stale into human-readable string
 */
function formatStaleTime(days: number): string {
  if (days < 30) return `${days} day${days !== 1 ? 's' : ''}`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months !== 1 ? 's' : ''}`;
  }
  const years = Math.floor(days / 365);
  const remainingDays = days % 365;
  const months = Math.floor(remainingDays / 30);
  if (months === 0) {
    return `${years} year${years !== 1 ? 's' : ''}`;
  }
  return `${years}y ${months}m`;
}

/**
 * Badge component for staleness with color coding
 * Yellow: < 1 year, Orange: 1-2 years, Red: > 2 years
 */
function StaleBadge({ daysStale }: { daysStale: number }) {
  const colorClass =
    daysStale > 730
      ? 'bg-red-500/10 text-red-500'
      : daysStale > 365
        ? 'bg-orange-500/10 text-orange-500'
        : 'bg-yellow-500/10 text-yellow-500';

  return (
    <Badge variant="secondary" className={colorClass}>
      {formatStaleTime(daysStale)}
    </Badge>
  );
}

/**
 * Badge component for media type (Movie, TV, Music)
 */
function MediaTypeBadge({ mediaType }: { mediaType: string }) {
  switch (mediaType) {
    case 'movie':
      return (
        <Badge variant="secondary" className="gap-1">
          <Film className="h-3 w-3" />
          Movie
        </Badge>
      );
    case 'show':
      return (
        <Badge variant="secondary" className="gap-1 bg-blue-500/10 text-blue-500">
          <Tv className="h-3 w-3" />
          TV
        </Badge>
      );
    case 'artist':
      return (
        <Badge variant="secondary" className="gap-1 bg-purple-500/10 text-purple-500">
          <Music className="h-3 w-3" />
          Music
        </Badge>
      );
    default:
      return null;
  }
}

interface StaleContentTabsProps {
  serverId?: string | null;
  libraryId?: string | null;
}

type DaysPreset = 30 | 90 | 180 | 365 | 730;

const PRESETS: DaysPreset[] = [30, 90, 180, 365, 730];

/**
 * Format the custom days button label. Returns 'Custom' when no custom value is set,
 * otherwise returns an abbreviated human-readable string (e.g. '45 days', '3mo', '2y').
 */
function formatCustomLabel(isCustomDays: boolean, staleDays: number): string {
  if (!isCustomDays) return 'Custom';
  if (staleDays < 30) return staleDays === 1 ? '1 day' : `${staleDays} days`;
  if (staleDays < 365) return `${Math.floor(staleDays / 30)}mo`;
  return `${Math.floor(staleDays / 365)}y`;
}

/**
 * Tabbed component for displaying never-watched and stale content.
 * Includes preset day buttons and custom input for the "stale" category threshold.
 */
export function StaleContentTabs({ serverId, libraryId }: StaleContentTabsProps) {
  const [activeTab, setActiveTab] = useState<'never-watched' | 'stale'>('never-watched');
  const [staleDays, setStaleDays] = useState<number>(90);
  const [isCustomDays, setIsCustomDays] = useState(false);
  const [customDaysInput, setCustomDaysInput] = useState('');
  const [isCustomPopoverOpen, setIsCustomPopoverOpen] = useState(false);
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>('all');
  const [neverWatchedPage, setNeverWatchedPage] = useState(1);
  const [stalePage, setStalePage] = useState(1);
  const [sortBy, setSortBy] = useState<SortBy>('size');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Reset pages when filters change
  useEffect(() => {
    setStalePage(1);
  }, [staleDays]);

  useEffect(() => {
    setNeverWatchedPage(1);
    setStalePage(1);
  }, [mediaTypeFilter, sortBy, sortOrder]);

  // Convert filter value to API param
  const mediaTypeParam = mediaTypeFilter === 'all' ? undefined : mediaTypeFilter;

  // Handle preset button click
  const handlePresetClick = (days: DaysPreset) => {
    setStaleDays(days);
    setIsCustomDays(false);
  };

  // Handle custom days apply
  const handleCustomApply = () => {
    const days = parseInt(customDaysInput, 10);
    if (Number.isFinite(days) && days > 0) {
      setStaleDays(days);
      setIsCustomDays(true);
      setIsCustomPopoverOpen(false);
    }
  };

  // Handle sort click
  const handleSort = (column: SortBy) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder(column === 'title' ? 'asc' : 'desc'); // Default: title asc, others desc
    }
  };

  // Fetch both to avoid flicker on tab switch
  const neverWatched = useLibraryStale(
    serverId,
    libraryId,
    90, // staleDays doesn't matter for never_watched category
    'never_watched',
    neverWatchedPage,
    20,
    mediaTypeParam,
    sortBy,
    sortOrder
  );
  const stale = useLibraryStale(
    serverId,
    libraryId,
    staleDays,
    'stale',
    stalePage,
    20,
    mediaTypeParam,
    sortBy,
    sortOrder
  );

  const handleTabChange = (value: string) => {
    setActiveTab(value as 'never-watched' | 'stale');
  };

  const renderTable = (
    data: StaleResponse | undefined,
    isLoading: boolean,
    page: number,
    onPageChange: (page: number) => void,
    showStaleColumn: boolean
  ) => {
    if (isLoading) {
      return (
        <div className="flex h-48 items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      );
    }

    if (!data?.items?.length) {
      return (
        <EmptyState
          icon={Archive}
          title="No stale content"
          description="All content in your library has been watched recently."
        />
      );
    }

    const totalPages = Math.ceil(data.pagination.total / data.pagination.pageSize);

    return (
      <div className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[60px]">Type</TableHead>
              <TableHead>
                <button
                  className="hover:text-foreground flex items-center gap-1"
                  onClick={() => handleSort('title')}
                >
                  Title
                  {sortBy === 'title' ? (
                    sortOrder === 'asc' ? (
                      <ArrowUp className="h-4 w-4" />
                    ) : (
                      <ArrowDown className="h-4 w-4" />
                    )
                  ) : (
                    <ArrowUpDown className="h-4 w-4 opacity-50" />
                  )}
                </button>
              </TableHead>
              <TableHead>Server</TableHead>
              <TableHead className="text-right">
                <button
                  className="hover:text-foreground ml-auto flex items-center gap-1"
                  onClick={() => handleSort('size')}
                >
                  Size
                  {sortBy === 'size' ? (
                    sortOrder === 'asc' ? (
                      <ArrowUp className="h-4 w-4" />
                    ) : (
                      <ArrowDown className="h-4 w-4" />
                    )
                  ) : (
                    <ArrowUpDown className="h-4 w-4 opacity-50" />
                  )}
                </button>
              </TableHead>
              <TableHead>
                <button
                  className="hover:text-foreground flex items-center gap-1"
                  onClick={() => handleSort('added_at')}
                >
                  Added
                  {sortBy === 'added_at' ? (
                    sortOrder === 'asc' ? (
                      <ArrowUp className="h-4 w-4" />
                    ) : (
                      <ArrowDown className="h-4 w-4" />
                    )
                  ) : (
                    <ArrowUpDown className="h-4 w-4 opacity-50" />
                  )}
                </button>
              </TableHead>
              {showStaleColumn && (
                <TableHead>
                  <button
                    className="hover:text-foreground flex items-center gap-1"
                    onClick={() => handleSort('days_stale')}
                  >
                    Stale For
                    {sortBy === 'days_stale' ? (
                      sortOrder === 'asc' ? (
                        <ArrowUp className="h-4 w-4" />
                      ) : (
                        <ArrowDown className="h-4 w-4" />
                      )
                    ) : (
                      <ArrowUpDown className="h-4 w-4 opacity-50" />
                    )}
                  </button>
                </TableHead>
              )}
              <TableHead>Quality</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <MediaTypeBadge mediaType={item.mediaType} />
                </TableCell>
                <TableCell>
                  <span className="font-medium">{item.title}</span>
                  {item.year && <span className="text-muted-foreground ml-1">({item.year})</span>}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{item.serverName}</Badge>
                </TableCell>
                <TableCell className="text-right">{formatBytes(item.fileSize)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDistanceToNow(new Date(item.addedAt), { addSuffix: true })}
                </TableCell>
                {showStaleColumn && (
                  <TableCell>
                    <StaleBadge daysStale={item.daysStale} />
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">
                  {formatMediaTech(item.resolution)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-2">
            <span className="text-muted-foreground text-sm">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(page - 1)}
                disabled={page <= 1}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPageChange(page + 1)}
                disabled={page >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <div className="mb-4 flex items-center justify-between">
        <TabsList>
          <TabsTrigger value="never-watched">
            Never Watched ({neverWatched.data?.summary.neverWatched.count ?? 0})
          </TabsTrigger>
          <TabsTrigger value="stale">
            Stale Content ({stale.data?.summary.stale.count ?? 0})
          </TabsTrigger>
        </TabsList>

        <div className="flex items-center gap-2">
          {/* Media type filter */}
          <Select
            value={mediaTypeFilter}
            onValueChange={(v) => setMediaTypeFilter(v as MediaTypeFilter)}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="movie">Movies</SelectItem>
              <SelectItem value="show">TV Shows</SelectItem>
              <SelectItem value="artist">Music</SelectItem>
            </SelectContent>
          </Select>

          {/* Days threshold selector (only for stale tab) */}
          {activeTab === 'stale' && (
            <div className="bg-muted inline-flex items-center gap-1 rounded-lg p-1">
              {/* Preset buttons */}
              {PRESETS.map((days) => (
                <button
                  key={days}
                  onClick={() => handlePresetClick(days)}
                  className={cn(
                    'cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    staleDays === days && !isCustomDays
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {days >= 365
                    ? `${Math.floor(days / 365)}y`
                    : days >= 30
                      ? `${Math.floor(days / 30)}mo`
                      : `${days}d`}
                </button>
              ))}

              {/* Custom days input */}
              <Popover open={isCustomPopoverOpen} onOpenChange={setIsCustomPopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    className={cn(
                      'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      isCustomDays
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <CalendarIcon className="h-3.5 w-3.5" />
                    {formatCustomLabel(isCustomDays, staleDays)}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-80" align="end">
                  <div className="space-y-3">
                    <div>
                      <h4 className="mb-2 font-medium">Custom Days</h4>
                      <p className="text-muted-foreground text-sm">
                        Enter the number of days for stale content threshold
                      </p>
                    </div>
                    <Input
                      type="number"
                      min="1"
                      placeholder="e.g., 45"
                      value={customDaysInput}
                      onChange={(e) => setCustomDaysInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleCustomApply();
                        }
                      }}
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setCustomDaysInput('');
                          setIsCustomPopoverOpen(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleCustomApply}
                        disabled={!customDaysInput || parseInt(customDaysInput, 10) <= 0}
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      </div>

      <TabsContent value="never-watched">
        {renderTable(
          neverWatched.data,
          neverWatched.isLoading,
          neverWatchedPage,
          setNeverWatchedPage,
          false
        )}
      </TabsContent>
      <TabsContent value="stale">
        {renderTable(stale.data, stale.isLoading, stalePage, setStalePage, true)}
      </TabsContent>
    </Tabs>
  );
}
