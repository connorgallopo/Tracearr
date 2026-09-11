import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Tags } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/library/ErrorState';
import { LibraryEmptyState } from '@/components/library/LibraryEmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TopListChart } from '@/components/charts/TopListChart';
import { MediaTypeToggle } from '@/components/media-browse/MediaTypeToggle';
import { useGenres } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { formatNumber, formatWatchTime } from '@/components/ui/stat-card';

const CHART_LIMIT = 15;

function browseHref(type: 'movie' | 'show', genre: string): string {
  const params = new URLSearchParams();
  if (type === 'show') params.set('type', 'shows');
  params.set('genre', genre);
  return `/media/browse?${params.toString()}`;
}

function ChartPanelSkeleton() {
  return (
    <div className="bg-card-raised space-y-3 rounded-[calc(var(--radius)+2px)] border p-[16px_18px]">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-[250px] w-full" />
    </div>
  );
}

function TablePanelSkeleton() {
  return (
    <div className="bg-card-raised space-y-3 rounded-[calc(var(--radius)+2px)] border p-[16px_18px]">
      <Skeleton className="h-5 w-40" />
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MediaGenres() {
  const { t } = useTranslation('pages');
  const { selectedServerIds, isLoading: serversLoading, refetch } = useServer();
  const [type, setType] = useState<'movie' | 'show'>('movie');

  const { data, isLoading, isError, refetch: refetchGenres } = useGenres(type, selectedServerIds);
  const genres = useMemo(() => data?.data ?? [], [data]);

  const sortedByPlays = useMemo(() => [...genres].sort((a, b) => b.plays - a.plays), [genres]);

  const chartData = useMemo(
    () =>
      sortedByPlays.slice(0, CHART_LIMIT).map((row) => ({
        name: row.genre,
        value: row.plays,
        subtitle: t('media.genres.chart.itemCount', { count: row.itemCount }),
      })),
    [sortedByPlays, t]
  );

  const hasNoServers = !serversLoading && selectedServerIds.length === 0;
  const hasNoGenres = !isLoading && !isError && genres.length === 0;

  const header = (
    <div>
      <h1 className="text-2xl font-bold tracking-[-0.02em]">{t('media.genres.title')}</h1>
      <p className="text-muted-foreground text-sm">{t('media.genres.subtitle')}</p>
    </div>
  );

  if (hasNoServers) {
    return (
      <div className="space-y-6">
        {header}
        <LibraryEmptyState onComplete={refetch} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <MediaTypeToggle value={type} onChange={setType} />

      {isLoading ? (
        <div className="space-y-6" data-testid="genres-skeleton">
          <ChartPanelSkeleton />
          <TablePanelSkeleton />
        </div>
      ) : isError ? (
        <ErrorState message={t('media.genres.loadError')} onRetry={() => void refetchGenres()} />
      ) : hasNoGenres ? (
        <EmptyState
          icon={Tags}
          title={t('media.genres.empty.title')}
          description={t('media.genres.empty.description')}
        />
      ) : (
        <div className="space-y-6">
          <section
            aria-labelledby="genres-chart-heading"
            className="bg-card-raised space-y-3 rounded-[calc(var(--radius)+2px)] border p-[16px_18px]"
          >
            <h2 id="genres-chart-heading" className="text-[15px] font-semibold">
              {t('media.genres.chart.title')}
            </h2>
            <div role="img" aria-label={t('media.genres.chart.ariaLabel')}>
              <TopListChart
                data={chartData}
                valueLabel={t('media.genres.chart.valueLabel')}
                limit={CHART_LIMIT}
              />
            </div>
          </section>

          <section
            aria-labelledby="genres-table-heading"
            className="bg-card-raised space-y-3 rounded-[calc(var(--radius)+2px)] border p-[16px_18px]"
          >
            <h2 id="genres-table-heading" className="text-[15px] font-semibold">
              {t('media.genres.table.title')}
            </h2>
            <Table aria-label={t('media.genres.table.title')}>
              <TableCaption className="sr-only">{t('media.genres.table.title')}</TableCaption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.07em] uppercase">
                    {t('media.genres.table.columns.genre')}
                  </TableHead>
                  <TableHead className="text-muted-foreground text-right text-[10.5px] font-semibold tracking-[0.07em] uppercase">
                    {t('media.genres.table.columns.items')}
                  </TableHead>
                  <TableHead className="text-muted-foreground text-right text-[10.5px] font-semibold tracking-[0.07em] uppercase">
                    {t('media.genres.table.columns.plays')}
                  </TableHead>
                  <TableHead className="text-muted-foreground text-right text-[10.5px] font-semibold tracking-[0.07em] uppercase">
                    {t('media.genres.table.columns.watchTime')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedByPlays.map((row) => (
                  <TableRow key={row.genre}>
                    <TableCell className="whitespace-normal">
                      <Link
                        to={browseHref(type, row.genre)}
                        className="focus-visible:ring-ring text-primary rounded font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
                        aria-label={t(
                          type === 'movie'
                            ? 'media.genres.table.browseMovies'
                            : 'media.genres.table.browseShows',
                          { genre: row.genre }
                        )}
                      >
                        {row.genre}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.itemCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.plays)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatWatchTime(row.watchTimeMs)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </div>
      )}
    </div>
  );
}
