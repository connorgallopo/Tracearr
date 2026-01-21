import { useState, useEffect } from 'react';
import { Archive, Film, Tv, Music, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { StaleResponse } from '@tracearr/shared';
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
import { useLibraryStale } from '@/hooks/queries/useLibrary';
import { EmptyState } from '@/components/library';

type MediaTypeFilter = 'all' | 'movie' | 'show' | 'artist';
type SortBy = 'size' | 'title' | 'days_stale';
type SortOrder = 'asc' | 'desc';

/**
 * Format days stale into human-readable string
 */
function formatStaleTime(days: number): string {
  if (days < 30) return `${days} days`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return `${months} month${months !== 1 ? 's' : ''}`;
  }
  const years = Math.round(days / 365);
  return `${years} year${years !== 1 ? 's' : ''}`;
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

/**
 * Format bytes to human-readable string (GB or TB).
 */
function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 GB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb.toFixed(1)} GB`;
}

interface StaleContentTabsProps {
  serverId?: string | null;
  libraryId?: string | null;
}

/**
 * Tabbed component for displaying never-watched and stale content.
 * Includes a threshold selector for the "stale" category (3m/6m/1y/2y).
 */
export function StaleContentTabs({ serverId, libraryId }: StaleContentTabsProps) {
  const [activeTab, setActiveTab] = useState<'never-watched' | 'stale'>('never-watched');
  const [staleDays, setStaleDays] = useState('90');
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
    Number(staleDays),
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
    onPageChange: (page: number) => void
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
              <TableHead>Added</TableHead>
              <TableHead>Stale For</TableHead>
              <TableHead>Quality</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <MediaTypeBadge mediaType={item.mediaType} />
                    <div>
                      <span className="font-medium">{item.title}</span>
                      {item.year && (
                        <span className="text-muted-foreground ml-1">({item.year})</span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{item.serverName}</Badge>
                </TableCell>
                <TableCell className="text-right">{formatBytes(item.fileSize)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDistanceToNow(new Date(item.addedAt), { addSuffix: true })}
                </TableCell>
                <TableCell>
                  <StaleBadge daysStale={item.daysStale} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {item.resolution ?? 'Unknown'}
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

          {/* Threshold selector (only for stale tab) */}
          {activeTab === 'stale' && (
            <Select value={staleDays} onValueChange={setStaleDays}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="90">Unwatched for 3+ months</SelectItem>
                <SelectItem value="180">Unwatched for 6+ months</SelectItem>
                <SelectItem value="365">Unwatched for 1+ year</SelectItem>
                <SelectItem value="730">Unwatched for 2+ years</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <TabsContent value="never-watched">
        {renderTable(
          neverWatched.data,
          neverWatched.isLoading,
          neverWatchedPage,
          setNeverWatchedPage
        )}
      </TabsContent>
      <TabsContent value="stale">
        {renderTable(stale.data, stale.isLoading, stalePage, setStalePage)}
      </TabsContent>
    </Tabs>
  );
}
