import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  Database,
  HardDrive,
  Film,
  Tv,
  Calendar,
  TrendingUp,
  Library as LibraryIcon,
} from 'lucide-react';
import { TIME_MS } from '@tracearr/shared';
import { allSelectedNeedLibraryEmptyState, serverNeedsLibrarySetup } from '@/lib/servers';
import type {
  AlbumShelfRow,
  CatalogRowServerEntry,
  GrowthDataPoint,
  LibraryGrowthResponse,
  MostPopularShelfRow,
  RecentlyUpdatedShelfRow,
  RecentlyAddedShelfRow,
  Server,
  ShelvesResponse,
} from '@tracearr/shared';
import { Shelf, ShelfSkeleton } from '@/components/media-browse/Shelf';
import {
  PosterCard,
  toPosterCardServers,
  type ServerLookupEntry,
} from '@/components/media-browse/PosterCard';
import { ErrorState } from '@/components/library/ErrorState';
import { LibraryEmptyState } from '@/components/library/LibraryEmptyState';
import { LibraryGrowthChart } from '@/components/charts';
import { ServerBadge } from '@/components/server';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LibraryStatsSkeleton } from '@/components/ui/skeleton';
import { StatCard, formatNumber } from '@/components/ui/stat-card';
import type { TimeRangeValue } from '@/components/ui/time-range-picker';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useLibraryStats,
  useLibraryGrowth,
  useLibraryStatus,
  useShelves,
  type LibraryStatusResponse,
} from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useServer } from '@/hooks/useServer';
import { toApiDayParams, useTimeRange } from '@/hooks/useTimeRange';
import { browseHref } from '@/lib/browseLinks';
import { formatBytes } from '@/lib/formatters';
import { formatCompactAge, formatLastUpdated } from '@/lib/dateFormat';

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
 * or backfill is running. Servers with library sync disabled are skipped.
 */
function serversNeedingSync(
  statusByServer: Map<string, { data?: LibraryStatusResponse }>,
  selectedServers: Server[]
): Server[] {
  return selectedServers.filter((server) =>
    serverNeedsLibrarySetup(server, statusByServer.get(server.id)?.data)
  );
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
  // A show's own copy date is when the series first appeared, not when the
  // episodes counted above arrived.
  const addedAt = row.newestEpisodeAt ?? mostRecentAddedAt(row.servers);

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
        servers={toPosterCardServers(row.servers, serverById)}
        resolutionBest={row.resolutionBest}
        watchedState={row.watchedState}
        newEpisodes={row.newEpisodes ?? undefined}
      />
      <CardMeta>{meta}</CardMeta>
    </div>
  );
}

/** The copy on this server replaced an earlier one, so the meta line says what changed rather than how new it is. */
function RecentlyUpdatedCard({
  row,
  serverById,
}: {
  row: RecentlyUpdatedShelfRow;
  serverById: Map<string, ServerLookupEntry>;
}) {
  const { t } = useTranslation('pages');
  const addedAt = row.newestEpisodeAt ?? mostRecentAddedAt(row.servers);

  const meta = joinMeta([
    row.replacedEpisodes
      ? t('media.landing.card.replacedEpisodes', { count: row.replacedEpisodes })
      : null,
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
        servers={toPosterCardServers(row.servers, serverById)}
        resolutionBest={row.resolutionBest}
        watchedState={row.watchedState}
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
        servers={toPosterCardServers(row.servers, serverById)}
        resolutionBest={row.resolutionBest}
        watchedState={row.watchedState}
        plays={row.plays}
        viewers={row.viewers}
        rank={row.rank}
        mediaType={row.mediaType}
        albumCount={row.albumCount}
      />
    </div>
  );
}

/** An album row is one server's copy; the card opens its artist when the artist is known. */
function RecentlyAddedAlbumCard({
  row,
  serverById,
}: {
  row: AlbumShelfRow;
  serverById: Map<string, ServerLookupEntry>;
}) {
  const { t } = useTranslation('pages');
  const meta = joinMeta([
    row.artistTitle,
    t('media.landing.card.addedCompactAgo', { age: formatCompactAge(row.addedAt) }),
  ]);

  return (
    <div className="space-y-1.5">
      <PosterCard
        mediaId={row.artistMediaId}
        mediaType="album"
        title={row.title}
        year={row.year}
        posterUrl={row.posterUrl}
        posterVersion={row.posterVersion}
        dominantColor={null}
        servers={toPosterCardServers(
          [
            {
              serverId: row.serverId,
              addedAt: row.addedAt,
              videoResolution: null,
              fileSize: null,
              versionCount: 0,
            },
          ],
          serverById
        )}
        resolutionBest={null}
        watchedState="unwatched"
      />
      <CardMeta>{meta}</CardMeta>
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

interface ShelfSection {
  id: string;
  title: string;
  caption?: string;
  viewAllHref?: string;
  emptyMessage: string;
  itemWidthClassName?: string;
  /** Recently Updated is a file-replacement log the owner reads; members never see it. */
  staffOnly?: boolean;
  cards: ReactNode[];
}

const MEMBER_TIME_RANGE: TimeRangeValue = { period: 'month' };
const NO_SERVERS: string[] = [];

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
  const { user } = useAuth();
  const isMember = user?.role === 'member';
  const queryClient = useQueryClient();
  const { value: pickedRange } = useTimeRange();
  const timeRange = isMember ? MEMBER_TIME_RANGE : pickedRange;

  // A member has no sync state or growth to read, and an empty list keeps both hooks idle
  const ownerServerIds = isMember ? NO_SERVERS : selectedServerIds;
  const statusResult = useLibraryStatus(ownerServerIds);
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
      case 'custom': {
        const { startDate, endDate } = toApiDayParams(timeRange);
        return startDate && endDate ? { period: '30d', startDate, endDate } : { period: '30d' };
      }
      default:
        return { period: '30d' };
    }
  }, [timeRange]);

  const growth = useLibraryGrowth(
    ownerServerIds,
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
    () => (isMember ? [] : serversNeedingSync(statusResult.byServer, selectedServers)),
    [isMember, statusResult.byServer, selectedServers]
  );

  const allServersUnready =
    !isMember &&
    allSelectedNeedLibraryEmptyState(
      selectedServers,
      statusResult.byServer,
      statusResult.isLoading
    );

  const serverById = useMemo(
    () => new Map(servers.map((server) => [server.id, server])),
    [servers]
  );

  const apiTimeRange = useMemo(() => toApiDayParams(timeRange), [timeRange]);

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
    shelves.meta.shows === 0 &&
    shelves.meta.artists === 0;
  const hasMusic = !!shelves && shelves.meta.artists > 0;

  const recentlyAddedCaption = t('media.landing.shelves.captionRecentlyAdded');
  const mostPopularCaption = t(`media.landing.shelves.captionMostPopular.${timeRange.period}`);
  const shelfViewAllLabel = t('media.landing.deadWeight.viewAll');

  const refetchAll = () => {
    void refetchStats();
    void refetchShelves();
  };

  const movieCount = stats?.movieCount ?? 0;
  const showCount = stats?.showCount ?? 0;
  const memberCounts = joinMeta([
    movieCount > 0 ? t('library.overview.movieCount', { count: movieCount }) : null,
    showCount > 0 ? t('library.overview.showCount', { count: showCount }) : null,
  ]);

  const toolbar = isMember ? (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground text-xs">{memberCounts}</p>
      <Button variant="outline" size="sm" asChild>
        <Link to={browseHref('movie', { watched: 'unwatched' })}>
          {t('library.overview.notWatchedByYou')}
        </Link>
      </Button>
    </div>
  ) : null;

  if (hasNoServers || allServersUnready || hasEmptyLibrary) {
    return (
      <div className="space-y-6">
        {toolbar}
        {isMember ? (
          <EmptyState
            icon={LibraryIcon}
            title={t('library.overview.memberEmpty.title')}
            description={t('library.overview.memberEmpty.description')}
          />
        ) : (
          <LibraryEmptyState onComplete={refetchAll} />
        )}
      </div>
    );
  }

  const shelfSkeletons: { title: string; aspect?: 'square' }[] = [
    { title: t('media.landing.shelves.recentlyAddedMovies') },
    { title: t('media.landing.shelves.recentlyAddedShows') },
    ...(isMember ? [] : [{ title: t('media.landing.shelves.recentlyUpdated') }]),
    { title: t('media.landing.shelves.mostPopularMovies') },
    { title: t('media.landing.shelves.mostPopularShows') },
    // Music shelves only skeleton in when an earlier response showed artists,
    // so a movie and show install never sees two shelves appear and vanish.
    ...(queryClient
      .getQueriesData<ShelvesResponse>({ queryKey: ['media', 'shelves'] })
      .some(([, cached]) => (cached?.meta.artists ?? 0) > 0)
      ? [
          { title: t('media.landing.shelves.recentlyAddedAlbums'), aspect: 'square' as const },
          { title: t('media.landing.shelves.mostPlayedArtists'), aspect: 'square' as const },
        ]
      : []),
  ];

  const shelfSections: ShelfSection[] = shelves
    ? [
        {
          id: 'recently-added-movies',
          title: t('media.landing.shelves.recentlyAddedMovies'),
          caption: recentlyAddedCaption,
          viewAllHref: '/media/browse',
          emptyMessage: t('media.landing.shelves.emptyRecentlyAdded'),
          cards: shelves.recentlyAddedMovies.map((row) => (
            <RecentlyAddedCard key={row.mediaId} row={row} serverById={serverById} />
          )),
        },
        {
          id: 'recently-added-shows',
          title: t('media.landing.shelves.recentlyAddedShows'),
          caption: recentlyAddedCaption,
          viewAllHref: '/media/browse?type=show',
          emptyMessage: t('media.landing.shelves.emptyRecentlyAdded'),
          cards: shelves.recentlyAddedShows.map((row) => (
            <RecentlyAddedCard key={row.mediaId} row={row} serverById={serverById} />
          )),
        },
        {
          id: 'recently-updated',
          title: t('media.landing.shelves.recentlyUpdated'),
          caption: t('media.landing.shelves.captionRecentlyUpdated'),
          viewAllHref: '/media/browse',
          emptyMessage: t('media.landing.shelves.emptyRecentlyUpdated'),
          staffOnly: true,
          cards: shelves.recentlyUpdated.map((row) => (
            <RecentlyUpdatedCard key={row.mediaId} row={row} serverById={serverById} />
          )),
        },
        {
          id: 'most-popular-movies',
          title: t('media.landing.shelves.mostPopularMovies'),
          caption: mostPopularCaption,
          viewAllHref: '/media/browse',
          emptyMessage: t('media.landing.shelves.emptyMostPopular'),
          itemWidthClassName: 'w-[174px]',
          cards: shelves.mostPopularMovies.map((row) => (
            <MostPopularCard key={row.mediaId} row={row} serverById={serverById} />
          )),
        },
        {
          id: 'most-popular-shows',
          title: t('media.landing.shelves.mostPopularShows'),
          caption: mostPopularCaption,
          viewAllHref: '/media/browse?type=show',
          emptyMessage: t('media.landing.shelves.emptyMostPopular'),
          itemWidthClassName: 'w-[174px]',
          cards: shelves.mostPopularShows.map((row) => (
            <MostPopularCard key={row.mediaId} row={row} serverById={serverById} />
          )),
        },
        ...(hasMusic
          ? [
              {
                id: 'recently-added-albums',
                title: t('media.landing.shelves.recentlyAddedAlbums'),
                emptyMessage: t('media.landing.shelves.emptyRecentlyAdded'),
                cards: shelves.recentlyAddedAlbums.map((row) => (
                  <RecentlyAddedAlbumCard
                    key={`${row.serverId}:${row.ratingKey}`}
                    row={row}
                    serverById={serverById}
                  />
                )),
              },
              {
                id: 'most-played-artists',
                title: t('media.landing.shelves.mostPlayedArtists'),
                caption: mostPopularCaption,
                viewAllHref: '/media/browse?type=artist',
                emptyMessage: t('media.landing.shelves.emptyMostPopular'),
                itemWidthClassName: 'w-[174px]',
                cards: shelves.mostPlayedArtists.map((row) => (
                  <MostPopularCard key={row.mediaId} row={row} serverById={serverById} />
                )),
              },
            ]
          : []),
      ].filter((section) => !isMember || (!section.staffOnly && section.cards.length > 0))
    : [];

  return (
    <div className="space-y-8">
      {toolbar}

      {!isMember && (
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
                    {t('library.overview.serversNeedSync')}
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
                  {!statsIsLoading && !statsIsError && (
                    <CardAction className="text-muted-foreground flex items-center gap-1 text-xs">
                      <Calendar className="h-3 w-3" />
                      <span>
                        {t('library.overview.lastUpdated')} {formatLastUpdated(stats?.asOf)}
                      </span>
                    </CardAction>
                  )}
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
      )}

      {shelvesIsLoading ? (
        <div className="space-y-8" data-testid="media-landing-skeleton">
          {shelfSkeletons.map(({ title, aspect }) => (
            <ShelfSkeleton key={title} title={title} aspect={aspect} />
          ))}
        </div>
      ) : shelvesIsError ? (
        <ErrorState message={t('media.landing.loadError')} onRetry={refetchShelves} />
      ) : (
        <div className="space-y-8">
          {shelfSections.map((section) =>
            section.cards.length > 0 ? (
              <Shelf
                key={section.id}
                id={section.id}
                itemWidthClassName={section.itemWidthClassName}
                title={section.title}
                caption={section.caption}
                viewAllHref={section.viewAllHref}
                viewAllLabel={shelfViewAllLabel}
              >
                {section.cards}
              </Shelf>
            ) : (
              <EmptyShelf
                key={section.id}
                id={section.id}
                title={section.title}
                message={section.emptyMessage}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
