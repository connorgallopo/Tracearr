import { useState, type ReactNode } from 'react';
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
import { formatStaleTime } from '@/lib/dateFormat';
import { formatBytes } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { MediaTypeBadge } from './badges';

type MediaTypeFilter = 'all' | 'movie' | 'show' | 'artist';
type SortBy = 'size' | 'title' | 'days_stale' | 'added_at';
type SortOrder = 'asc' | 'desc';

/** Neutral under a year, warning to two years, danger past that. */
function StaleBadge({ daysStale }: { daysStale: number }) {
  const { t } = useTranslation('pages');
  const variant = daysStale > 730 ? 'danger' : daysStale > 365 ? 'warning' : 'secondary';

  return <Badge variant={variant}>{formatStaleTime(daysStale, t)}</Badge>;
}

interface SortButtonProps {
  column: SortBy;
  sortBy: SortBy;
  sortOrder: SortOrder;
  onSort: (column: SortBy) => void;
  className?: string;
  children: ReactNode;
}

function SortButton({ column, sortBy, sortOrder, onSort, className, children }: SortButtonProps) {
  const active = sortBy === column;
  const Icon = !active ? ArrowUpDown : sortOrder === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      className={cn('hover:text-foreground flex items-center gap-1', className)}
      onClick={() => onSort(column)}
    >
      {children}
      <Icon className={cn('h-4 w-4', !active && 'opacity-50')} />
    </button>
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
  const { t } = useTranslation(['pages', 'common']);

  const [activeTab, setActiveTab] = useState<'never-watched' | 'stale'>('never-watched');
  const [staleDays, setStaleDays] = useState('90');
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>('all');
  const [neverWatchedPage, setNeverWatchedPage] = useState(1);
  const [stalePage, setStalePage] = useState(1);
  const [sortBy, setSortBy] = useState<SortBy>('size');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const colorMap = useServerColorMap();

  const resetPages = () => {
    setNeverWatchedPage(1);
    setStalePage(1);
  };

  // Convert filter value to API param
  const mediaTypeParam = mediaTypeFilter === 'all' ? undefined : mediaTypeFilter;

  // Handle sort click
  const handleSort = (column: SortBy) => {
    resetPages();
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

  const sort = { sortBy, sortOrder, onSort: handleSort };

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
          <div className="text-muted-foreground">{t('common:states.loading')}</div>
        </div>
      );
    }

    if (!data?.items?.length) {
      return (
        <EmptyState
          icon={Archive}
          title={t('library.storage.stale.empty.title')}
          description={t('library.storage.stale.empty.description')}
        />
      );
    }

    const totalPages = Math.ceil(data.pagination.total / data.pagination.pageSize);

    return (
      <div className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[60px]">{t('common:labels.type')}</TableHead>
              <TableHead>
                <SortButton column="title" {...sort}>
                  {t('library.storage.colTitle')}
                </SortButton>
              </TableHead>
              {isMultiServer && <TableHead>{t('common:labels.server')}</TableHead>}
              <TableHead className="text-right">
                <SortButton column="size" className="ml-auto" {...sort}>
                  {t('common:labels.size')}
                </SortButton>
              </TableHead>
              <TableHead>
                <SortButton column="added_at" {...sort}>
                  {t('library.overview.added')}
                </SortButton>
              </TableHead>
              {showStaleColumn && (
                <TableHead>
                  <SortButton column="days_stale" {...sort}>
                    {t('library.storage.stale.columns.staleFor')}
                  </SortButton>
                </TableHead>
              )}
              <TableHead>{t('common:labels.quality')}</TableHead>
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
            navigation: t('common:table.pagination'),
            status: t('common:table.pageOf', { page, total: totalPages }),
            previous: t('common:actions.previous'),
            next: t('common:actions.next'),
            goToPage: t('common:table.goToPage'),
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
            {t('library.storage.stale.tabs.neverWatched', {
              count: neverWatched.data?.summary.neverWatched.count ?? 0,
            })}
          </TabsTrigger>
          <TabsTrigger value="stale">
            {t('library.storage.stale.tabs.stale', {
              count: stale.data?.summary.stale.count ?? 0,
            })}
          </TabsTrigger>
        </TabsList>

        <div className="flex items-center gap-2">
          {/* Media type filter */}
          <Select
            value={mediaTypeFilter}
            onValueChange={(v) => {
              setMediaTypeFilter(v as MediaTypeFilter);
              resetPages();
            }}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('library.storage.stale.allTypes')}</SelectItem>
              <SelectItem value="movie">{t('common:media.movie_plural')}</SelectItem>
              <SelectItem value="show">{t('common:media.tvShows')}</SelectItem>
              <SelectItem value="artist">{t('common:media.music')}</SelectItem>
            </SelectContent>
          </Select>

          {/* Threshold selector (only for stale tab) */}
          {activeTab === 'stale' && (
            <Select
              value={staleDays}
              onValueChange={(v) => {
                setStaleDays(v);
                setStalePage(1);
              }}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="90">{t('library.storage.stale.threshold.months3')}</SelectItem>
                <SelectItem value="180">{t('library.storage.stale.threshold.months6')}</SelectItem>
                <SelectItem value="365">{t('library.storage.stale.threshold.year1')}</SelectItem>
                <SelectItem value="730">{t('library.storage.stale.threshold.years2')}</SelectItem>
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
