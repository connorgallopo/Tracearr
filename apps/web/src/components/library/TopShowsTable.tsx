import { Tv, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Server, TopShowsResponse } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { DataTablePager } from '@/components/ui/data-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ServerBadge } from '@/components/server';
import { EmptyState } from '@/components/ui/empty-state';
import { getCompletionBadge } from './badges';
import {
  SortableTableHead,
  nextSortOrder,
  type SortOrder,
} from '@/components/ui/sortable-table-head';

export type ShowSortBy =
  'plays' | 'watch_hours' | 'viewers' | 'completion_rate' | 'episodes_per_viewer';

interface TopShowsTableProps {
  data: TopShowsResponse | undefined;
  isLoading?: boolean;
  page: number;
  onPageChange: (page: number) => void;
  sortBy: ShowSortBy;
  sortOrder: SortOrder;
  onSortChange: (sortBy: ShowSortBy, sortOrder: SortOrder) => void;
  selectedServers?: Server[];
  isMultiServer?: boolean;
}

/**
 * Table component for displaying top TV shows by engagement metrics.
 * Server-side sortable by episode views, watch hours, viewers, completion rate and episodes per viewer.
 * In multi-server mode renders per-title color dots for each server that owns the show.
 */
export function TopShowsTable({
  data,
  isLoading,
  page,
  onPageChange,
  sortBy,
  sortOrder,
  onSortChange,
  selectedServers = [],
  isMultiServer = false,
}: TopShowsTableProps) {
  const { t } = useTranslation(['pages', 'common']);

  const handleSort = (field: ShowSortBy) => {
    onSortChange(field, nextSortOrder(field, sortBy, sortOrder, 'desc'));
  };

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
        icon={Zap}
        title={t('library.watch.top.shows.empty.title')}
        description={t('library.watch.top.shows.empty.description')}
      />
    );
  }

  const totalPages = Math.ceil(data.pagination.total / data.pagination.pageSize);

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%]">{t('library.watch.binge.columns.show')}</TableHead>
            <SortableTableHead
              field="plays"
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
            >
              {t('common:labels.plays')}
            </SortableTableHead>
            <SortableTableHead
              field="watch_hours"
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
            >
              {t('common:labels.watchHours')}
            </SortableTableHead>
            <SortableTableHead
              field="viewers"
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
            >
              {t('common:labels.viewers')}
            </SortableTableHead>
            <SortableTableHead
              field="completion_rate"
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
            >
              {t('common:labels.completion')}
            </SortableTableHead>
            <SortableTableHead
              field="episodes_per_viewer"
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={handleSort}
            >
              {t('library.watch.binge.columns.episodesPerViewer')}
            </SortableTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((item) => (
            <TableRow key={item.mediaId}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="gap-1 bg-blue-500/10 text-blue-500">
                    <Tv className="h-3 w-3" />
                    {t('common:media.tv')}
                  </Badge>
                  <div>
                    <span className="font-medium">{item.showTitle}</span>
                    {item.year && <span className="text-muted-foreground ml-1">({item.year})</span>}
                  </div>
                  {isMultiServer && item.serverIds && item.serverIds.length > 0 && (
                    <div className="flex items-center gap-0.5">
                      {item.serverIds.map((sid) => {
                        const server = selectedServers.find((s) => s.id === sid);
                        if (!server) return null;
                        return <ServerBadge key={sid} server={server} variant="compact" />;
                      })}
                    </div>
                  )}
                </div>
              </TableCell>
              <TableCell className="font-medium">{item.totalEpisodeViews}</TableCell>
              <TableCell>{item.totalWatchHours.toFixed(1)}</TableCell>
              <TableCell>{item.uniqueViewers}</TableCell>
              <TableCell>{getCompletionBadge(item.avgCompletionRate)}</TableCell>
              <TableCell className="font-medium">{item.episodesPerViewer.toFixed(1)}</TableCell>
            </TableRow>
          ))}
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
}
