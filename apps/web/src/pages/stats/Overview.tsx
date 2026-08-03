import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  Activity,
  Clock,
  Film,
  History as HistoryIcon,
  MonitorSmartphone,
  Play,
  Tv,
  UserRound,
  Users,
} from 'lucide-react';
import type {
  PlatformStats,
  SessionWithDetails,
  TopMovie,
  TopShow,
  TopUserStats,
  UserStats,
} from '@tracearr/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getAvatarUrl } from '@/components/users/utils';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard, formatNumber, formatWatchTime } from '@/components/ui/stat-card';
import { ErrorState } from '@/components/library/ErrorState';
import {
  useConcurrentStats,
  useHistoryAggregates,
  useHistorySessions,
  usePlatformStats,
  useQualityStats,
  useTopMovies,
  useTopShows,
  useTopUsers,
  useUserStats,
  type StatsTimeRange,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { imageProxyUrl } from '@/lib/api';
import { safeFormatDistanceToNow } from '@/lib/formatters';
import { cn } from '@/lib/utils';

type RankingMetric = 'plays' | 'watchTime';
type WatchPeriod = '7d' | '30d' | '90d' | '1y' | 'all';

const PERIODS: { value: WatchPeriod; label: string }[] = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
];

export function periodFilters(period: WatchPeriod): {
  stats: StatsTimeRange;
  history: { startDate?: Date; endDate?: Date };
} {
  if (period === 'all') return { stats: { period: 'all' }, history: {} };

  const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period];
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  const nativePeriod =
    period === '7d' ? 'week' : period === '30d' ? 'month' : period === '1y' ? 'year' : undefined;

  return {
    stats: nativePeriod
      ? { period: nativePeriod }
      : {
          period: 'custom',
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        },
    history: { startDate, endDate },
  };
}

interface LeaderboardItem {
  id: string;
  label: string;
  detail?: string;
  value: string;
  href: string;
  imageUrl?: string;
}

interface LeaderboardCardProps {
  title: string;
  unit: string;
  items: LeaderboardItem[];
  isLoading: boolean;
  visual: 'poster' | 'avatar' | 'platform';
  fallbackIcon: typeof Film;
}

function LeaderboardCard({
  title,
  unit,
  items,
  isLoading,
  visual,
  fallbackIcon: FallbackIcon,
}: LeaderboardCardProps) {
  const { t } = useTranslation('pages');
  const first = items[0];

  return (
    <Card className="overflow-hidden">
      <div className="flex h-11 items-center justify-between border-b px-3.5">
        <h2 className="text-xs font-semibold">{title}</h2>
        <span className="text-muted-foreground text-[10px] font-medium tracking-[0.08em] uppercase">
          {unit}
        </span>
      </div>
      {isLoading ? (
        <div className="grid min-h-52 grid-cols-[5rem_minmax(0,1fr)] gap-2 p-2.5">
          <Skeleton className={cn('h-full w-full', visual === 'avatar' && 'h-16 rounded-full')} />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground flex min-h-52 flex-col items-center justify-center gap-2 px-4 text-center text-sm">
          <FallbackIcon className="h-7 w-7 opacity-50" />
          <span>{t('statsOverview.noPlays')}</span>
        </div>
      ) : (
        <div className="grid min-h-52 grid-cols-[5rem_minmax(0,1fr)]">
          <div className="flex items-start justify-center p-2.5 pr-1.5" aria-hidden="true">
            {visual === 'avatar' ? (
              <Avatar className="mt-2 h-14 w-14 border">
                <AvatarImage src={first?.imageUrl} alt="" />
                <AvatarFallback className="text-lg font-semibold">
                  {first?.label.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            ) : visual === 'platform' ? (
              <div className="bg-muted mt-2 flex h-14 w-14 items-center justify-center rounded-xl border">
                <MonitorSmartphone className="h-7 w-7 text-green-500" />
              </div>
            ) : first?.imageUrl ? (
              <img
                src={first.imageUrl}
                alt=""
                className="h-40 w-[4.5rem] rounded-md object-cover shadow"
                loading="lazy"
              />
            ) : (
              <div className="bg-muted flex h-40 w-[4.5rem] items-center justify-center rounded-md border">
                <FallbackIcon className="text-muted-foreground h-7 w-7" />
              </div>
            )}
          </div>
          <ol className="min-w-0 py-1.5 pr-2.5">
            {items.slice(0, 5).map((item, index) => (
              <li key={item.id} className="border-b last:border-0">
                <Link
                  to={item.href}
                  className="hover:bg-muted/50 focus-visible:ring-ring grid min-h-10 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-1.5 rounded-sm px-1.5 focus-visible:ring-2 focus-visible:outline-none"
                >
                  <span className="text-muted-foreground text-right text-[10px] tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{item.label}</span>
                    {item.detail && (
                      <span className="text-muted-foreground block truncate text-[10px]">
                        {item.detail}
                      </span>
                    )}
                  </span>
                  <span className="text-primary text-xs font-semibold tabular-nums">
                    {item.value}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Card>
  );
}

function movieItems(items: TopMovie[] | undefined, metric: RankingMetric): LeaderboardItem[] {
  return (items ?? []).map((item) => ({
    id: `${item.serverId}-${item.ratingKey}`,
    label: item.title,
    detail: item.year ? String(item.year) : undefined,
    value:
      metric === 'plays' ? formatNumber(item.totalPlays) : `${item.totalWatchHours.toFixed(1)}h`,
    href: `/history?period=all&search=${encodeURIComponent(item.title)}`,
    imageUrl: item.thumbPath
      ? imageProxyUrl(item.serverId, item.thumbPath, 160, 240, 'poster')
      : undefined,
  }));
}

function popularMovieItems(items: TopMovie[] | undefined): LeaderboardItem[] {
  return (items ?? []).map((item) => ({
    id: `${item.serverId}-${item.ratingKey}`,
    label: item.title,
    detail: item.year ? String(item.year) : undefined,
    value: formatNumber(item.uniqueViewers),
    href: `/history?period=all&search=${encodeURIComponent(item.title)}`,
    imageUrl: item.thumbPath
      ? imageProxyUrl(item.serverId, item.thumbPath, 160, 240, 'poster')
      : undefined,
  }));
}

function showItems(items: TopShow[] | undefined, metric: RankingMetric): LeaderboardItem[] {
  return (items ?? []).map((item) => ({
    id: `${item.serverId}-${item.showTitle}`,
    label: item.showTitle,
    detail: item.year ? String(item.year) : undefined,
    value:
      metric === 'plays'
        ? formatNumber(item.totalEpisodeViews)
        : `${item.totalWatchHours.toFixed(1)}h`,
    href: `/history?period=all&search=${encodeURIComponent(item.showTitle)}`,
    imageUrl: item.thumbPath
      ? imageProxyUrl(item.serverId, item.thumbPath, 160, 240, 'poster')
      : undefined,
  }));
}

function popularShowItems(items: TopShow[] | undefined): LeaderboardItem[] {
  return (items ?? []).map((item) => ({
    id: `${item.serverId}-${item.showTitle}`,
    label: item.showTitle,
    detail: item.year ? String(item.year) : undefined,
    value: formatNumber(item.uniqueViewers),
    href: `/history?period=all&search=${encodeURIComponent(item.showTitle)}`,
    imageUrl: item.thumbPath
      ? imageProxyUrl(item.serverId, item.thumbPath, 160, 240, 'poster')
      : undefined,
  }));
}

function playUserItems(items: UserStats[] | undefined): LeaderboardItem[] {
  return (items ?? []).map((item) => ({
    id: item.serverUserId,
    label: item.username,
    value: formatNumber(item.playCount),
    href: `/users/${item.serverUserId}`,
    imageUrl: getAvatarUrl(item.serverId, item.thumbUrl, 96) ?? undefined,
  }));
}

function watchUserItems(items: TopUserStats[] | undefined): LeaderboardItem[] {
  return (items ?? []).map((item) => ({
    id: item.userId,
    label: item.identityName ?? item.username,
    value: `${item.watchTimeHours.toFixed(1)}h`,
    href: `/users/${item.serverUserId}`,
    imageUrl: item.thumbUrl
      ? item.thumbUrl.startsWith('http')
        ? item.thumbUrl
        : item.serverId
          ? imageProxyUrl(item.serverId, item.thumbUrl, 96, 96, 'avatar')
          : undefined
      : undefined,
  }));
}

function platformItems(
  items: PlatformStats[] | undefined,
  metric: RankingMetric,
  unknownLabel: string
): LeaderboardItem[] {
  return [...(items ?? [])]
    .sort((a, b) => (metric === 'plays' ? b.count - a.count : b.watchTimeHours - a.watchTimeHours))
    .map((item) => {
      const platform = item.platform ?? unknownLabel;
      return {
        id: platform,
        label: platform,
        value: metric === 'plays' ? formatNumber(item.count) : `${item.watchTimeHours.toFixed(1)}h`,
        href: item.platform
          ? `/history?period=all&platforms=${encodeURIComponent(platform)}`
          : '/history?period=all',
      };
    });
}

function RecentSessions({ sessions }: { sessions: SessionWithDetails[] }) {
  const { t } = useTranslation('pages');

  return (
    <Card className="overflow-hidden">
      <div className="flex h-11 items-center justify-between border-b px-3.5">
        <h2 className="text-xs font-semibold">{t('statsOverview.recent.title')}</h2>
        <Link to="/history" className="text-muted-foreground hover:text-foreground text-[10px]">
          {t('statsOverview.recent.viewHistory')} →
        </Link>
      </div>
      {sessions.length === 0 ? (
        <div className="text-muted-foreground flex min-h-24 items-center justify-center text-sm">
          {t('statsOverview.recent.empty')}
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 2xl:grid-cols-5">
          {sessions.map((session) => (
            <Link
              key={session.id}
              to={`/history/${session.id}`}
              className="hover:bg-muted/50 focus-visible:ring-ring min-w-0 border-b p-3 last:border-0 focus-visible:ring-2 focus-visible:outline-none sm:border-r 2xl:border-b-0 2xl:last:border-r-0 sm:[&:nth-child(2n)]:border-r-0 2xl:[&:nth-child(2n)]:border-r"
            >
              <span className="block truncate text-xs font-medium">
                {session.grandparentTitle ?? session.mediaTitle}
              </span>
              <span className="text-muted-foreground mt-1 block truncate text-[10px]">
                {session.user.identityName ?? session.user.username} ·{' '}
                {safeFormatDistanceToNow(session.stoppedAt ?? session.startedAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

export function StatsOverview() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds } = useServer();
  const [metric, setMetric] = useState<RankingMetric>('plays');
  const [period, setPeriod] = useState<WatchPeriod>('90d');
  const filters = useMemo(() => periodFilters(period), [period]);
  const contentSort = metric === 'plays' ? 'plays' : 'watch_hours';

  const aggregates = useHistoryAggregates({
    serverIds: selectedServerIds,
    mediaTypes: ['movie', 'episode'],
    excludeShortSessions: true,
    ...filters.history,
  });
  const movies = useTopMovies(selectedServerIds, period, contentSort, 'desc', 1, 5);
  const popularMovies = useTopMovies(selectedServerIds, period, 'viewers', 'desc', 1, 5);
  const shows = useTopShows(selectedServerIds, period, contentSort, 'desc', 1, 5);
  const popularShows = useTopShows(selectedServerIds, period, 'viewers', 'desc', 1, 5);
  const playUsers = useUserStats(filters.stats, selectedServerIds);
  const watchUsers = useTopUsers(filters.stats, selectedServerIds);
  const platforms = usePlatformStats(filters.stats, selectedServerIds);
  const concurrent = useConcurrentStats(filters.stats, selectedServerIds);
  const quality = useQualityStats(filters.stats, selectedServerIds);
  const recent = useHistorySessions(
    {
      serverIds: selectedServerIds,
      mediaTypes: ['movie', 'episode'],
      orderBy: 'startedAt',
      orderDir: 'desc',
    },
    5
  );

  const allQueries = [
    aggregates,
    movies,
    popularMovies,
    shows,
    popularShows,
    playUsers,
    watchUsers,
    platforms,
    concurrent,
    quality,
    recent,
  ];
  const failedQuery = allQueries.find((query) => query.isError);
  const peak = (concurrent.data ?? []).reduce(
    (best, point) => (point.total > best.total ? point : best),
    { hour: '', total: 0, direct: 0, directStream: 0, transcode: 0 }
  );
  const recentSessions = recent.data?.pages[0]?.data.slice(0, 5) ?? [];
  const userItems =
    metric === 'plays' ? playUserItems(playUsers.data) : watchUserItems(watchUsers.data);
  const platformLeaderboard = platformItems(platforms.data, metric, t('common:labels.unknown'));
  const metricUnit =
    metric === 'plays' ? t('statsOverview.units.plays') : t('statsOverview.units.hours');
  const showUnit =
    metric === 'plays' ? t('statsOverview.units.episodes') : t('statsOverview.units.hours');

  if (failedQuery) {
    return (
      <ErrorState
        title={t('statsOverview.errorTitle')}
        message={failedQuery.error?.message ?? t('common:errors.unexpectedError')}
        onRetry={() => {
          for (const query of allQueries) void query.refetch();
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-start justify-between gap-4 xl:flex-row xl:items-center">
        <div>
          <h1 className="text-2xl font-bold">{t('statsOverview.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('statsOverview.subtitle')}</p>
        </div>
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={t('statsOverview.controls.ariaLabel')}
        >
          <div
            className="bg-muted flex rounded-lg border p-1"
            role="group"
            aria-label={t('statsOverview.controls.metricAriaLabel')}
          >
            <button
              type="button"
              aria-pressed={metric === 'plays'}
              onClick={() => setMetric('plays')}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                metric === 'plays' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              )}
            >
              {t('statsOverview.controls.playCount')}
            </button>
            <button
              type="button"
              aria-pressed={metric === 'watchTime'}
              onClick={() => setMetric('watchTime')}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                metric === 'watchTime'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground'
              )}
            >
              {t('statsOverview.controls.watchTime')}
            </button>
          </div>
          <div
            className="bg-muted flex rounded-lg border p-1"
            role="group"
            aria-label={t('statsOverview.controls.periodAriaLabel')}
          >
            {PERIODS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={period === option.value}
                onClick={() => setPeriod(option.value)}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  period === option.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Play}
          label={t('statsOverview.units.plays')}
          value={formatNumber(aggregates.data?.playCount ?? 0)}
          isLoading={aggregates.isLoading}
        />
        <StatCard
          icon={Clock}
          label={t('statsOverview.controls.watchTime')}
          value={formatWatchTime(aggregates.data?.totalWatchTimeMs ?? 0)}
          isLoading={aggregates.isLoading}
        />
        <StatCard
          icon={Users}
          label={t('statsOverview.kpis.uniqueViewers')}
          value={formatNumber(aggregates.data?.uniqueUsers ?? 0)}
          isLoading={aggregates.isLoading}
        />
        <StatCard
          icon={Activity}
          label={t('statsOverview.kpis.peakConcurrent')}
          value={peak.total}
          subValue={peak.hour ? safeFormatDistanceToNow(peak.hour) : undefined}
          isLoading={concurrent.isLoading}
        />
      </div>

      <div className="grid gap-3 min-[1600px]:grid-cols-3! lg:grid-cols-2">
        <LeaderboardCard
          title={t('statsOverview.leaderboards.mostWatchedMovies')}
          unit={metricUnit}
          items={movieItems(movies.data?.items, metric)}
          isLoading={movies.isLoading}
          visual="poster"
          fallbackIcon={Film}
        />
        <LeaderboardCard
          title={t('statsOverview.leaderboards.mostPopularMovies')}
          unit={t('statsOverview.units.viewers')}
          items={popularMovieItems(popularMovies.data?.items)}
          isLoading={popularMovies.isLoading}
          visual="poster"
          fallbackIcon={Film}
        />
        <LeaderboardCard
          title={t('statsOverview.leaderboards.mostWatchedShows')}
          unit={showUnit}
          items={showItems(shows.data?.items, metric)}
          isLoading={shows.isLoading}
          visual="poster"
          fallbackIcon={Tv}
        />
        <LeaderboardCard
          title={t('statsOverview.leaderboards.mostPopularShows')}
          unit={t('statsOverview.units.viewers')}
          items={popularShowItems(popularShows.data?.items)}
          isLoading={popularShows.isLoading}
          visual="poster"
          fallbackIcon={Tv}
        />
        <LeaderboardCard
          title={t('statsOverview.leaderboards.mostActiveUsers')}
          unit={metricUnit}
          items={userItems}
          isLoading={metric === 'plays' ? playUsers.isLoading : watchUsers.isLoading}
          visual="avatar"
          fallbackIcon={UserRound}
        />
        <LeaderboardCard
          title={t('statsOverview.leaderboards.mostActivePlatforms')}
          unit={metricUnit}
          items={platformLeaderboard}
          isLoading={platforms.isLoading}
          visual="platform"
          fallbackIcon={MonitorSmartphone}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
        {recent.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <RecentSessions sessions={recentSessions} />
        )}
        <Card className="overflow-hidden">
          <div className="flex h-11 items-center justify-between border-b px-3.5">
            <h2 className="text-xs font-semibold">{t('statsOverview.streamMix.title')}</h2>
            <span className="text-muted-foreground text-[10px] font-medium tracking-[0.08em] uppercase">
              {PERIODS.find((option) => option.value === period)?.label}
            </span>
          </div>
          <div className="p-3.5">
            <div className="flex items-baseline gap-2">
              <strong className="text-3xl tracking-tight tabular-nums">{peak.total}</strong>
              <span className="text-muted-foreground text-xs">
                {t('statsOverview.streamMix.peakStreams')}
              </span>
            </div>
            {quality.isLoading ? (
              <Skeleton className="mt-3 h-8 w-full" />
            ) : quality.data?.total ? (
              <>
                <div
                  className="bg-muted mt-3 flex h-2 overflow-hidden rounded-full"
                  role="img"
                  aria-label={t('statsOverview.streamMix.ariaLabel', {
                    directPlay: quality.data.directPlayPercent,
                    directStream: quality.data.directStreamPercent,
                    transcode: quality.data.transcodePercent,
                  })}
                >
                  <span
                    className="bg-green-500"
                    style={{ width: `${quality.data.directPlayPercent}%` }}
                  />
                  <span
                    className="bg-blue-500"
                    style={{ width: `${quality.data.directStreamPercent}%` }}
                  />
                  <span
                    className="bg-yellow-500"
                    style={{ width: `${quality.data.transcodePercent}%` }}
                  />
                </div>
                <div className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
                  <span>
                    {t('common:playback.directPlay')}{' '}
                    <b className="text-foreground">{quality.data.directPlayPercent}%</b>
                  </span>
                  <span>
                    {t('common:playback.directStream')}{' '}
                    <b className="text-foreground">{quality.data.directStreamPercent}%</b>
                  </span>
                  <span>
                    {t('common:playback.transcode')}{' '}
                    <b className="text-foreground">{quality.data.transcodePercent}%</b>
                  </span>
                </div>
              </>
            ) : (
              <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
                <HistoryIcon className="h-4 w-4" /> {t('statsOverview.noPlays')}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
