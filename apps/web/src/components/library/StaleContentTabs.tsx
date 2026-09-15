import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { formatMediaTech, type StaleResponse } from '@tracearr/shared';
import type { Server } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { DataTablePager } from '@/components/ui/data-table';
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
import { useServerColorMap } from '@/hooks/useServerColorMap';
import { ServerColumnCell } from '@/components/server';
import { formatBytes } from '@/lib/formatters';
import { EmptyState } from '@/components/ui/empty-state';
import { MediaTypeBadge } from './badges';

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

interface StaleContentTabsProps {
  serverIds: string[];
  libraryId?: string | null;
  isMultiServer: boolean;
  selectedServers: Server[];
}

/**
 * Tabbed component for displaying never-watched and stale content.
 * Includes a threshold selector for the "stale" category (3m/6m/1y/2y).
 */
export function StaleContentTabs({
  serverIds,
  libraryId,
  isMultiServer,
  selectedServers,
}: StaleContentTabsProps) {
  const { t } = useTranslation('common');

  const [activeTab, setActiveTab] = useState<'never-watched' | 'stale'>('never-watched');
  const [staleDays, setStaleDays] = useState('90');
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>('all');
  const [neverWatchedPage, setNeverWatchedPage] = useState(1);
  const [stalePage, setStalePage] = useState(1);
  const [sortBy, setSortBy] = useState<SortBy>('size');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const colorMap = useServerColorMap();

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
    serverIds,
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
    serverIds,
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
              {isMultiServer && <TableHead>Server</TableHead>}
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
            {data.items.map((item) => {
              const serverColor = isMultiServer ? (colorMap.get(item.serverId) ?? null) : null;
              const accentStyle = serverColor
                ? { boxShadow: `inset 3px 0 0 0 ${serverColor}` }
                : undefined;
              const rowServer = isMultiServer
                ? (selectedServers.find((s) => s.id === item.serverId) ?? null)
                : null;

              return (
                <TableRow key={item.id} style={accentStyle}>
                  <TableCell>
                    <MediaTypeBadge mediaType={item.mediaType} />
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">{item.title}</span>
                    {item.year && <span className="text-muted-foreground ml-1">({item.year})</span>}
                  </TableCell>
                  {isMultiServer && (
                    <TableCell>
                      {rowServer ? (
                        <ServerColumnCell server={rowServer} />
                      ) : (
                        <Badge variant="outline">{item.serverName}</Badge>
                      )}
                    </TableCell>
                  )}
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
              );
            })}
          </TableBody>
        </Table>

        <DataTablePager
          page={page}
          pageCount={totalPages}
          canPrevious={page > 1}
          canNext={page < totalPages}
          onPrevious={() => onPageChange(page - 1)}
          onNext={() => onPageChange(page + 1)}
          onPage={onPageChange}
          labels={{
            navigation: t('table.pagination'),
            status: t('table.pageOf', { page, total: totalPages }),
            previous: t('actions.previous'),
            next: t('actions.next'),
            goToPage: t('table.goToPage'),
          }}
          className="px-2"
        />
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
