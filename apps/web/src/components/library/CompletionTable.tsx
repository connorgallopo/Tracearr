import { useState, useEffect } from 'react';
import { CheckCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { CompletionItem, SeasonCompletion, SeriesCompletion } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLibraryCompletion } from '@/hooks/queries/useLibrary';
import { EmptyState, EngagementTierBadge } from '@/components/library';

interface CompletionTableProps {
  serverId?: string | null;
  libraryId?: string | null;
}

type ViewLevel = 'item' | 'season' | 'series';

/**
 * Tabbed table for completion rates at item/season/series level.
 * Shows progress bars and status badges per row.
 */
export function CompletionTable({ serverId, libraryId }: CompletionTableProps) {
  const [viewLevel, setViewLevel] = useState<ViewLevel>('item');
  const [page, setPage] = useState(1);

  // Reset page when view level changes
  useEffect(() => {
    setPage(1);
  }, [viewLevel]);

  const completion = useLibraryCompletion(serverId, libraryId, viewLevel, page, 20);

  const handleViewChange = (value: string) => {
    setViewLevel(value as ViewLevel);
  };

  // Narrow the union type
  const data = completion.data;
  const items = data && 'items' in data ? data.items : undefined;
  const seasons = data && 'seasons' in data ? data.seasons : undefined;
  const series = data && 'series' in data ? data.series : undefined;
  const pagination = data?.pagination;

  const renderLoading = () => (
    <div className="flex h-48 items-center justify-center">
      <div className="text-muted-foreground">Loading...</div>
    </div>
  );

  const renderEmpty = () => (
    <EmptyState
      icon={CheckCircle}
      title="No completion data"
      description="No watch data is available for this library."
    />
  );

  const renderItemsTable = (data: CompletionItem[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Server</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last Watched</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((item) => (
          <TableRow key={item.id}>
            <TableCell>
              <div>
                <span className="font-medium">{item.title}</span>
                {item.showTitle && (
                  <span className="text-muted-foreground block text-xs">
                    {item.showTitle} S{item.seasonNumber} E{item.episodeNumber}
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant="outline">{item.serverName}</Badge>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <Progress value={item.completionPct} className="w-20" />
                <span className="text-muted-foreground text-xs">{item.completionPct}%</span>
              </div>
            </TableCell>
            <TableCell>
              <EngagementTierBadge status={item.status} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {item.lastWatchedAt
                ? formatDistanceToNow(new Date(item.lastWatchedAt), { addSuffix: true })
                : 'Never'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  const renderSeasonsTable = (data: SeasonCompletion[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Show</TableHead>
          <TableHead>Season</TableHead>
          <TableHead>Episodes</TableHead>
          <TableHead>Progress</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((season) => (
          <TableRow key={`${season.showTitle}-${season.seasonNumber}`}>
            <TableCell className="font-medium">{season.showTitle}</TableCell>
            <TableCell>Season {season.seasonNumber}</TableCell>
            <TableCell>
              {season.completedEpisodes}/{season.totalEpisodes}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <Progress value={season.completionPct} className="w-20" />
                <span className="text-muted-foreground text-xs">
                  {season.completionPct.toFixed(0)}%
                </span>
              </div>
            </TableCell>
            <TableCell>
              <EngagementTierBadge status={season.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  const renderSeriesTable = (data: SeriesCompletion[]) => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Show</TableHead>
          <TableHead>Seasons</TableHead>
          <TableHead>Episodes</TableHead>
          <TableHead>Avg Progress</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((show) => (
          <TableRow key={show.showTitle}>
            <TableCell className="font-medium">{show.showTitle}</TableCell>
            <TableCell>
              {show.completedSeasons}/{show.totalSeasons}
            </TableCell>
            <TableCell>
              {show.completedEpisodes}/{show.totalEpisodes}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <Progress value={show.avgSeasonCompletionPct} className="w-20" />
                <span className="text-muted-foreground text-xs">
                  {show.avgSeasonCompletionPct.toFixed(0)}%
                </span>
              </div>
            </TableCell>
            <TableCell>
              <EngagementTierBadge status={show.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  const renderPagination = () => {
    if (!pagination) return null;
    const totalPages = Math.ceil(pagination.total / pagination.pageSize);
    if (totalPages <= 1) return null;

    return (
      <div className="flex items-center justify-between px-2 pt-4">
        <span className="text-muted-foreground text-sm">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p - 1)}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      </div>
    );
  };

  const renderContent = () => {
    if (completion.isLoading) return renderLoading();

    if (viewLevel === 'item') {
      if (!items?.length) return renderEmpty();
      return (
        <>
          {renderItemsTable(items)}
          {renderPagination()}
        </>
      );
    }

    if (viewLevel === 'season') {
      if (!seasons?.length) return renderEmpty();
      return (
        <>
          {renderSeasonsTable(seasons)}
          {renderPagination()}
        </>
      );
    }

    // viewLevel === 'series'
    if (!series?.length) return renderEmpty();
    return (
      <>
        {renderSeriesTable(series)}
        {renderPagination()}
      </>
    );
  };

  return (
    <Tabs value={viewLevel} onValueChange={handleViewChange}>
      <TabsList>
        <TabsTrigger value="item">Items</TabsTrigger>
        <TabsTrigger value="season">Seasons</TabsTrigger>
        <TabsTrigger value="series">Series</TabsTrigger>
      </TabsList>
      <TabsContent value={viewLevel}>{renderContent()}</TabsContent>
    </Tabs>
  );
}
