import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, HardDrive, Film, Tv, Calendar, TrendingUp } from 'lucide-react';
import { TIME_MS } from '@tracearr/shared';
import type {
  CatalogRowServerEntry,
  GrowthDataPoint,
  LibraryGrowthResponse,
  MostPopularShelfRow,
  RecentlyAddedShelfRow,
  Server,
  ServerType,
} from '@tracearr/shared';
import { Shelf } from '@/components/media-browse/Shelf';
import { PosterCard, type PosterCardServer } from '@/components/media-browse/PosterCard';
import { ErrorState } from '@/components/library/ErrorState';
import { LibraryEmptyState } from '@/components/library/LibraryEmptyState';
import { LibraryGrowthChart } from '@/components/charts';
import { ServerBadge } from '@/components/server';
import { Skeleton, LibraryStatsSkeleton } from '@/components/ui/skeleton';
import { StatCard, formatNumber } from '@/components/ui/stat-card';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useLibraryStats,
  useLibraryGrowth,
  useLibraryStatus,
  useShelves,
  type LibraryStatusResponse,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';
import { formatBytes, formatCompactAge } from '@/lib/formatters';
import { getHour12 } from '@/lib/timeFormat';

function formatLastUpdated(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: getHour12(),
  });
}

/**
 * Aggregate multi-server growth response into a single-server-shaped object.
 * Points from the same day across different servers are summed per media type.
 * When only one server is selected the response already has one point per day
 * so this is a no-op (identity over the map).
 */
function aggregateGrowthData(raw: LibraryGrowthResponse): LibraryGrowthResponse {
  const aggregate = (series: GrowthDataPoint[]): GrowthDataPoint[] => {
    const byDay = new Map<string, { total: number; additions: number }>();
    for (const point of series) {
      const existing = byDay.get(point.day);
      if (existing) {
        existing.total += point.total;
        existing.additions += point.additions;
      } else {
        byDay.set(point.day, { total: point.total, additions: point.additions });
      }
    }
    return Array.from(byDay.entries()).map(([day, vals]) => ({
      day,
      total: vals.total,
      additions: vals.additions,
      serverId: '',
    }));
  };

  return {
    period: raw.period,
    movies: aggregate(raw.movies ?? []),
    episodes: aggregate(raw.episodes ?? []),
    music: aggregate(raw.music ?? []),
  };
}

/**
 * Servers that need attention: isSynced is false, needsBackfill is true,
 * or backfill is running.
 */
function serversNeedingSync(
  statusByServer: Map<string, { data?: LibraryStatusResponse }>,
  selectedServers: Server[]
): Server[] {
  return selectedServers.filter((server) => {
    const result = statusByServer.get(server.id);
    const data = result?.data;
    if (!data) return false;
    return !data.isSynced || data.needsBackfill || data.isBackfillRunning;
  });
}

interface ServerLookupEntry {
  name: string;
  type: ServerType;
  color?: string | null;
}

function resolvePosterCardServers(
  entries: CatalogRowServerEntry[],
  serverById: Map<string, ServerLookupEntry>
): PosterCardServer[] {
  return entries.map((entry) => {
    const server = serverById.get(entry.serverId);
    return {
      serverId: entry.serverId,
      name: server?.name ?? entry.serverId,
      type: server?.type ?? 'plex',
      color: server?.color ?? null,
      addedAt: entry.addedAt,
      videoResolution: entry.videoResolution,
      versionCount: entry.versionCount,
    };
  });
}

/**
 * A title is "recently added" by whichever server most recently added it,
 * not the server that has had it the longest.
 */
function mostRecentAddedAt(entries: CatalogRowServerEntry[]): string | null {
  const first = entries[0];
  if (!first) return null;
  return entries.reduce(
    (latest, entry) => (entry.addedAt > latest ? entry.addedAt : latest),
    first.addedAt
  );
}

function joinMeta(parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => !!part).join(' · ');
}

/**
 * One truncated line shared by every shelf's card meta. PosterCard already
 * renders the year under the title, so this line never repeats it - only
 * datapoints beyond the year belong here.
 */
function CardMeta({ children }: { children: string }) {
  return <p className="text-muted-foreground truncate text-xs">{children}</p>;
}

function RecentlyAddedCard({
  row,
  serverById,
}: {
  row: RecentlyAddedShelfRow;
  serverById: Map<string, ServerLookupEntry>;
}) {
  const { t } = useTranslation('pages');
  const addedAt = mostRecentAddedAt(row.servers);

  const meta = joinMeta([
    addedAt ? t('media.landing.card.addedCompactAgo', { age: formatCompactAge(addedAt) }) : null,
  ]);

  return (
    <div className="space-y-1.5">
      <PosterCard
        mediaId={row.mediaId}
        title={row.title}
        year={row.year}
        posterUrl={row.posterUrl}
        posterVersion={row.posterVersion}
        dominantColor={row.dominantColor}
        servers={resolvePosterCardServers(row.servers, serverById)}
        resolutionBest={row.resolutionBest}
        watchedState={row.watchedState}
        newEpisodes={row.newEpisodes ?? undefined}
      />
      <CardMeta>{meta}</CardMeta>
    </div>
  );
}

function MostPopularCard({
  row,
  serverById,
}: {
  row: MostPopularShelfRow;
  serverById: Map<string, ServerLookupEntry>;
}) {
  return (
    <div className="space-y-1.5">
      <PosterCard
        mediaId={row.mediaId}
        title={row.title}
        year={row.year}
        posterUrl={row.posterUrl}
        posterVersion={row.posterVersion}
        dominantColor={row.dominantColor}
        servers={resolvePosterCardServers(row.servers, serverById)}
        resolutionBest={row.resolutionBest}
        watchedState={row.watchedState}
        plays={row.plays}
        viewers={row.viewers}
        rank={row.rank}
      />
    </div>
  );
}

/**
 * Mirrors Shelf's heading markup so an empty shelf reads as "nothing here
 * this period" instead of vanishing and leaving an unexplained gap.
 */
function EmptyShelf({ id, title, message }: { id: string; title: string; message: string }) {
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-[16px] font-semibold tracking-[-0.01em]">
        {title}
      </h2>
      <p className="text-muted-foreground text-sm">{message}</p>
    </section>
  );
}

function ShelfSkeleton({ title }: { title: string }) {
  return (
    <div className="space-y-3">
      <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{title}</h2>
      <div className="flex gap-4 overflow-x-hidden">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="w-[138px] shrink-0 space-y-1.5">
            <Skeleton className="aspect-[2/3] w-full rounded-md" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The merged media Overview: library stat cards and growth from the old
 * /library overview plus the landing shelves. The old landing's KPI strip
 * (watched this period, hours watched, newly added) was dropped deliberately
 * - owner decision during the nav consolidation, the library stat cards
 * cover the totals now. The Dead Weight table moved to the Storage page,
 * next to Stale Content.
 */
export function MediaOverview() {
  const { t } = useTranslation(['pages', 'common']);
  const {
    selectedServerIds,
    selectedServers,
    servers,
    isMultiServer,
    isLoading: serversLoading,
  } = useServer();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();

  const statusResult = useLibraryStatus(selectedServerIds);
  const {
    data: stats,
    isLoading: statsIsLoading,
    isError: statsIsError,
    error: statsError,
    refetch: refetchStats,
  } = useLibraryStats(selectedServerIds);

  const growthParams = useMemo(() => {
    switch (timeRange.period) {
      case 'week':
        return { period: '7d' };
      case 'month':
        return { period: '30d' };
      case 'year':
        return { period: '1y' };
      case 'all':
        return { period: 'all' };
      case 'day': {
        // Snap to the current hour boundary so the ISO strings (the server's
        // Redis cache key) repeat across recomputes within the same hour.
        const endDate = new Date();
        endDate.setMinutes(0, 0, 0);
        const startDate = new Date(endDate.getTime() - TIME_MS.DAY);
        return {
          period: '30d',
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        };
      }
      case 'custom':
        return timeRange.startDate && timeRange.endDate
          ? {
              period: '30d',
              startDate: timeRange.startDate.toISOString(),
              endDate: timeRange.endDate.toISOString(),
            }
          : { period: '30d' };
      default:
        return { period: '30d' };
    }
  }, [timeRange]);

  const growth = useLibraryGrowth(
    selectedServerIds,
    null,
    growthParams.period,
    growthParams.startDate,
    growthParams.endDate
  );

  // Aggregate multi-server growth before passing to chart; single-server is a no-op.
  const aggregatedGrowth = useMemo<LibraryGrowthResponse | undefined>(() => {
    if (!growth.data) return undefined;
    return aggregateGrowthData(growth.data);
  }, [growth.data]);

  const periodChanges = useMemo(() => {
    if (!aggregatedGrowth) {
      return { movies: 0, episodes: 0, music: 0, total: 0 };
    }

    const sumAdditions = (series: GrowthDataPoint[] | undefined) =>
      series?.reduce((sum, d) => sum + d.additions, 0) ?? 0;

    const movies = sumAdditions(aggregatedGrowth.movies);
    const episodes = sumAdditions(aggregatedGrowth.episodes);
    const music = sumAdditions(aggregatedGrowth.music);

    return { movies, episodes, music, total: movies + episodes + music };
  }, [aggregatedGrowth]);

  const periodLabel = useMemo(() => {
    switch (timeRange.period) {
      case 'week':
        return t('library.overview.thisWeek');
      case 'month':
        return t('library.overview.thisMonth');
      case 'year':
        return t('library.overview.thisYear');
      case 'all':
        return t('common:time.allTime').toLowerCase();
      default:
        return t('library.overview.thisPeriod');
    }
  }, [timeRange.period, t]);

  // The date-range picker only affects the Added stat, the growth chart, and
  // the Most Popular shelves - everything else on this page reflects the
  // whole library regardless of the picker, so it gets this hint instead.
  const allTimeLabel = t('common:time.allTime').toLowerCase();

  const unreadyServers = useMemo(
    () => serversNeedingSync(statusResult.byServer, selectedServers),
    [statusResult.byServer, selectedServers]
  );

  const allStatusLoaded = !statusResult.isLoading;
  const allServersUnready =
    allStatusLoaded &&
    selectedServerIds.length > 0 &&
    unreadyServers.length === selectedServerIds.length;

  const serverById = useMemo(
    () => new Map(servers.map((server) => [server.id, server])),
    [servers]
  );

  const apiTimeRange = useMemo(
    () => ({
      period: timeRange.period,
      startDate: timeRange.startDate?.toISOString(),
      endDate: timeRange.endDate?.toISOString(),
    }),
    [timeRange]
  );

  const {
    data: shelves,
    isLoading: shelvesIsLoading,
    isError: shelvesIsError,
    refetch: refetchShelves,
  } = useShelves(selectedServerIds, apiTimeRange, false);

  const hasNoServers = !serversLoading && selectedServerIds.length === 0;
  const hasEmptyLibrary =
    !hasNoServers &&
    !shelvesIsLoading &&
    !shelvesIsError &&
    !!shelves &&
    shelves.meta.movies === 0 &&
    shelves.meta.shows === 0;

  const recentlyAddedCaption = t('media.landing.shelves.captionRecentlyAdded');
  const mostPopularCaption = t(`media.landing.shelves.captionMostPopular.${timeRange.period}`);
  const shelfViewAllLabel = t('media.landing.deadWeight.viewAll');

  const refetchAll = () => {
    void refetchStats();
    void refetchShelves();
  };

  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold">{t('library.title')}</h1>
        <p className="text-muted-foreground text-sm">{t('library.overview.description')}</p>
        {!statsIsLoading && !statsIsError && (
          <div className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
            <Calendar className="h-3 w-3" />
            <span>
              {t('library.overview.lastUpdated')} {formatLastUpdated(stats?.asOf)}
            </span>
          </div>
        )}
      </div>
      <TimeRangePicker value={timeRange} onChange={setTimeRange} />
    </div>
  );

  if (hasNoServers || allServersUnready || hasEmptyLibrary) {
    return (
      <div className="space-y-6">
        {header}
        <LibraryEmptyState onComplete={refetchAll} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {header}

      <div className="space-y-6">
        {statsIsLoading ? (
          <LibraryStatsSkeleton />
        ) : statsIsError ? (
          <ErrorState
            title={t('library.overview.failedToLoad')}
            message={statsError?.message ?? t('library.overview.failedToLoadDesc')}
            onRetry={refetchStats}
          />
        ) : (
          <>
            {/* Sync-needed banner: shown when some (but not all) servers need attention */}
            {unreadyServers.length > 0 && (
              <div className="bg-muted border-border flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 text-sm">
                <span className="text-muted-foreground shrink-0">
                  {t('library.overview.serversNeedSync', 'These servers need to sync:')}
                </span>
                {isMultiServer
                  ? unreadyServers.map((server) => (
                      <ServerBadge key={server.id} server={server} variant="outlined" />
                    ))
                  : null}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard
                icon={Database}
                label={t('library.overview.totalItems')}
                value={formatNumber(stats?.totalItems ?? 0)}
                subValue={allTimeLabel}
              />
              <StatCard
                icon={HardDrive}
                label={t('debug.totalSize')}
                value={formatBytes(stats?.totalSizeBytes)}
                subValue={allTimeLabel}
              />
              <StatCard
                icon={Film}
                label={t('common:media.movie_plural')}
                value={formatNumber(stats?.movieCount ?? 0)}
                subValue={allTimeLabel}
              />
              <StatCard
                icon={Tv}
                label={t('common:media.episode_plural')}
                value={formatNumber(stats?.episodeCount ?? 0)}
                subValue={joinMeta([
                  stats?.showCount
                    ? `${formatNumber(stats.showCount)} ${t('library.overview.shows')}`
                    : null,
                  allTimeLabel,
                ])}
              />
              <StatCard
                icon={TrendingUp}
                label={t('library.overview.added')}
                value={`+${formatNumber(periodChanges.total)}`}
                subValue={periodLabel}
                isLoading={growth.isLoading}
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base font-medium">
                  {t('library.overview.libraryGrowth')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <LibraryGrowthChart
                  data={aggregatedGrowth}
                  isLoading={growth.isLoading}
                  height={250}
                  period={timeRange.period}
                />
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {shelvesIsLoading ? (
        <div className="space-y-8" data-testid="media-landing-skeleton">
          <ShelfSkeleton title={t('media.landing.shelves.recentlyAddedMovies')} />
          <ShelfSkeleton title={t('media.landing.shelves.recentlyAddedShows')} />
          <ShelfSkeleton title={t('media.landing.shelves.mostPopularMovies')} />
          <ShelfSkeleton title={t('media.landing.shelves.mostPopularShows')} />
        </div>
      ) : shelvesIsError ? (
        <ErrorState message={t('media.landing.loadError')} onRetry={refetchShelves} />
      ) : (
        shelves && (
          <div className="space-y-8">
            {shelves.recentlyAddedMovies.length > 0 ? (
              <Shelf
                id="recently-added-movies"
                title={t('media.landing.shelves.recentlyAddedMovies')}
                caption={recentlyAddedCaption}
                viewAllHref="/media/browse"
                viewAllLabel={shelfViewAllLabel}
              >
                {shelves.recentlyAddedMovies.map((row) => (
                  <RecentlyAddedCard key={row.mediaId} row={row} serverById={serverById} />
                ))}
              </Shelf>
            ) : (
              <EmptyShelf
                id="recently-added-movies"
                title={t('media.landing.shelves.recentlyAddedMovies')}
                message={t('media.landing.shelves.emptyRecentlyAdded')}
              />
            )}
            {shelves.recentlyAddedShows.length > 0 ? (
              <Shelf
                id="recently-added-shows"
                title={t('media.landing.shelves.recentlyAddedShows')}
                caption={recentlyAddedCaption}
                viewAllHref="/media/browse?type=shows"
                viewAllLabel={shelfViewAllLabel}
              >
                {shelves.recentlyAddedShows.map((row) => (
                  <RecentlyAddedCard key={row.mediaId} row={row} serverById={serverById} />
                ))}
              </Shelf>
            ) : (
              <EmptyShelf
                id="recently-added-shows"
                title={t('media.landing.shelves.recentlyAddedShows')}
                message={t('media.landing.shelves.emptyRecentlyAdded')}
              />
            )}
            {shelves.mostPopularMovies.length > 0 ? (
              <Shelf
                id="most-popular-movies"
                itemWidthClassName="w-[174px]"
                title={t('media.landing.shelves.mostPopularMovies')}
                caption={mostPopularCaption}
                viewAllHref="/media/browse"
                viewAllLabel={shelfViewAllLabel}
              >
                {shelves.mostPopularMovies.map((row) => (
                  <MostPopularCard key={row.mediaId} row={row} serverById={serverById} />
                ))}
              </Shelf>
            ) : (
              <EmptyShelf
                id="most-popular-movies"
                title={t('media.landing.shelves.mostPopularMovies')}
                message={t('media.landing.shelves.emptyMostPopular')}
              />
            )}
            {shelves.mostPopularShows.length > 0 ? (
              <Shelf
                id="most-popular-shows"
                itemWidthClassName="w-[174px]"
                title={t('media.landing.shelves.mostPopularShows')}
                caption={mostPopularCaption}
                viewAllHref="/media/browse?type=shows"
                viewAllLabel={shelfViewAllLabel}
              >
                {shelves.mostPopularShows.map((row) => (
                  <MostPopularCard key={row.mediaId} row={row} serverById={serverById} />
                ))}
              </Shelf>
            ) : (
              <EmptyShelf
                id="most-popular-shows"
                title={t('media.landing.shelves.mostPopularShows')}
                message={t('media.landing.shelves.emptyMostPopular')}
              />
            )}
          </div>
        )
      )}
    </div>
  );
}
