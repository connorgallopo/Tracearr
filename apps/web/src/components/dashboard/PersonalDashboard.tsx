import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Calendar, Clock, Film, Flame, Link2, Play, Trophy } from 'lucide-react';
import { Link } from 'react-router';
import type { HistoryAggregates, MyTopTitleRow } from '@tracearr/shared';
import { NowPlayingSection } from '@/components/dashboard/NowPlayingSection';
import { SectionHeading } from '@/components/dashboard/SectionHeading';
import {
  PosterCard,
  toPosterCardServers,
  type ServerLookupEntry,
} from '@/components/media-browse/PosterCard';
import { Shelf, ShelfSkeleton } from '@/components/media-browse/Shelf';
import { MyRequestsCard } from '@/components/requests/MyRequestsCard';
import { AllTimeSection } from '@/components/stats/AllTimeSection';
import { HowYouWatchCard, activeProfile } from '@/components/stats/HowYouWatchCard';
import { InlineErrorState } from '@/components/library/ErrorState';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { formatWatchTime } from '@/lib/dateFormat';
import {
  useActiveSessions,
  useEngagementStats,
  useHistoryAggregates,
  useMyStats,
  useMyTopTitles,
  useOthersActive,
  useOwnerLinks,
  usePlaysByDayOfWeek,
  usePlaysByHourOfDay,
} from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useServer } from '@/hooks/useServer';
import { useSocket } from '@/hooks/useSocket';
import type { StatsTimeRange } from '@/lib/api';
import { deltaPercent, periodWindows } from '@/lib/periodWindows';
import { cn } from '@/lib/utils';

const ALL_TIME: StatsTimeRange = { period: 'all' };
const SHELF = 'w-fit min-w-0 max-w-full';
const CARD = 'min-w-72 flex-1';

function ActionsRow({ children }: { children: ReactNode }) {
  return <div className="flex justify-end">{children}</div>;
}

function LastThirtyDays({
  serverIds,
  streak,
  othersStreaming,
  actions,
}: {
  serverIds: string[];
  streak: number;
  othersStreaming: number | undefined;
  actions?: ReactNode;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const [now] = useState(() => new Date(Math.floor(Date.now() / 60_000) * 60_000));
  const windows = useMemo(() => periodWindows({ period: 'month' }, now), [now]);
  const current = useHistoryAggregates({ serverIds, self: true, ...windows.current });
  const previous = useHistoryAggregates({ serverIds, self: true, ...windows.previous });

  // With no heading to ride, the toggle keeps a row of its own so the admin view stays reachable
  const actionsRow = actions ? <ActionsRow>{actions}</ActionsRow> : null;
  if (current.isError) {
    return (
      <section className="space-y-3">
        {actionsRow}
        <InlineErrorState message={current.error.message} onRetry={() => void current.refetch()} />
      </section>
    );
  }
  if (current.data?.playCount === 0) return actionsRow;

  const totals = current.data;
  const before = previous.isPlaceholderData ? undefined : previous.data;
  const watchMs = (agg: HistoryAggregates | undefined) =>
    agg ? agg.totalWatchTimeMs - agg.listenTimeMs : undefined;
  const listenMs = totals?.listenTimeMs ?? 0;
  const watchNow = watchMs(totals);
  const watchBefore = watchMs(before);
  const watchDelta =
    watchNow === undefined || watchBefore === undefined
      ? null
      : deltaPercent(watchNow, watchBefore);
  const playsDelta =
    totals === undefined || before === undefined
      ? null
      : deltaPercent(totals.playCount, before.playCount);

  return (
    <section>
      <SectionHeading
        icon={Calendar}
        title={t('dashboard.me.last30')}
        caption={
          othersStreaming ? t('dashboard.othersStreaming', { count: othersStreaming }) : undefined
        }
        actions={actions}
      />
      <div className="flex flex-wrap gap-3 *:min-w-40 *:flex-1">
        <StatCard
          icon={Clock}
          label={t('dashboard.watchTime')}
          value={formatWatchTime(watchNow ?? 0)}
          delta={
            watchDelta === null
              ? undefined
              : { value: watchDelta, label: t('userDetail.cards.vsPrior') }
          }
          isLoading={!totals}
          subValue={
            listenMs > 0
              ? `${t('common:labels.listenTime')} ${formatWatchTime(listenMs)}`
              : undefined
          }
        />
        <StatCard
          icon={Play}
          label={t('dashboard.plays')}
          value={totals?.playCount ?? 0}
          isLoading={!totals}
          delta={
            playsDelta === null
              ? undefined
              : { value: playsDelta, label: t('userDetail.cards.vsPrior') }
          }
        />
        <StatCard
          icon={Film}
          label={t('yourStats.titles')}
          value={totals?.uniqueContent ?? 0}
          isLoading={!totals}
        />
        {streak > 0 && (
          <StatCard
            icon={Flame}
            label={t('dashboard.dayStreak')}
            value={streak}
            subValue={t('dashboard.me.streakDetail')}
          />
        )}
      </div>
    </section>
  );
}

function TopTitleCard({
  row,
  serverById,
}: {
  row: MyTopTitleRow;
  serverById: Map<string, ServerLookupEntry>;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const count =
    row.episodes != null
      ? t('dashboard.me.episodes', { count: row.episodes })
      : t('common:count.play', { count: row.plays });

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
        watchedStateSelf={row.watchedState}
        rank={row.rank}
      />
      {/* pl-9 matches the rank lane PosterCard reserves, so this lines up under the title */}
      <p className="text-muted-foreground truncate pl-9 text-xs">
        {count} · {formatWatchTime(row.watchTimeMs)}
      </p>
    </div>
  );
}

function TopTitles({ serverIds, className }: { serverIds: string[]; className?: string }) {
  const { t } = useTranslation(['pages', 'common']);
  const { servers } = useServer();
  const titles = useMyTopTitles(serverIds);
  const serverById = useMemo(
    () => new Map(servers.map((server) => [server.id, server])),
    [servers]
  );
  const title = t('dashboard.me.topTitles');

  if (titles.isError) {
    return (
      <InlineErrorState
        message={titles.error?.message ?? t('common:errors.unexpectedError')}
        onRetry={() => void titles.refetch()}
      />
    );
  }
  if (titles.isLoading) {
    return (
      <div className={className}>
        <ShelfSkeleton title={title} />
      </div>
    );
  }
  const rows = titles.data?.data ?? [];
  if (rows.length === 0) return null;

  return (
    <Shelf
      id="top-titles"
      icon={Trophy}
      title={title}
      caption={t('dashboard.me.last30').toLowerCase()}
      itemWidthClassName="w-[174px]"
      className={className}
    >
      {rows.map((row) => (
        <TopTitleCard key={row.mediaId} row={row} serverById={serverById} />
      ))}
    </Shelf>
  );
}

function HowYouWatch({ serverIds, className }: { serverIds: string[]; className?: string }) {
  const engagement = useEngagementStats(ALL_TIME, serverIds, { self: true });
  const dayOfWeek = usePlaysByDayOfWeek(ALL_TIME, serverIds, { self: true });
  const hourOfDay = usePlaysByHourOfDay(ALL_TIME, serverIds, { self: true });

  if (engagement.isLoading) return <Skeleton className={cn('h-44 rounded-xl', className)} />;
  const profile = activeProfile(engagement.data?.userProfiles);
  if (!profile) return null;

  return (
    <HowYouWatchCard
      profile={profile}
      breakdown={engagement.data?.engagementBreakdown}
      dayOfWeek={dayOfWeek.data}
      hourOfDay={hourOfDay.data}
      className={className}
    />
  );
}

function Welcome() {
  const { t } = useTranslation('pages');
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const { data: ownerLinks } = useOwnerLinks(isOwner);

  // Watching never fills this in for an owner whose own account syncs in as someone else.
  if (isOwner && ownerLinks?.length && ownerLinks.every((link) => link.linked === null)) {
    return (
      <EmptyState
        icon={Link2}
        title={t('dashboard.me.link.title')}
        description={t('dashboard.me.link.description')}
      >
        <Button asChild>
          <Link to="/settings/servers/connections">{t('dashboard.me.link.action')}</Link>
        </Button>
      </EmptyState>
    );
  }

  return (
    <EmptyState
      icon={BarChart3}
      title={t('dashboard.me.welcome.title')}
      description={t('dashboard.me.welcome.description')}
    >
      <Button asChild>
        <Link to="/media/browse">{t('dashboard.me.welcome.browse')}</Link>
      </Button>
    </EmptyState>
  );
}

/** What the signed-in person has watched; every read asks for their own accounts. */
export function PersonalDashboard({ actions }: { actions?: ReactNode }) {
  const { selectedServerIds } = useServer();
  const { isConnected } = useSocket();
  const myStats = useMyStats();
  const streams = useActiveSessions(selectedServerIds, isConnected, true);
  const { data: othersStreaming } = useOthersActive(selectedServerIds, isConnected, true);

  const hasNoPlays = myStats.isSuccess && myStats.data.daysWatched === 0;
  // The toggle rides the first heading on the page
  const isStreaming = (streams.data?.length ?? 0) > 0;

  return (
    <div className="space-y-8">
      {streams.isError ? (
        <InlineErrorState message={streams.error.message} onRetry={() => void streams.refetch()} />
      ) : (
        <NowPlayingSection
          sessions={streams.data}
          hideWhenEmpty
          actions={isStreaming ? actions : undefined}
        />
      )}

      {hasNoPlays ? (
        <>
          {actions && !isStreaming && <ActionsRow>{actions}</ActionsRow>}
          <Welcome />
        </>
      ) : (
        <LastThirtyDays
          serverIds={selectedServerIds}
          streak={myStats.data?.currentStreak ?? 0}
          othersStreaming={othersStreaming}
          actions={isStreaming ? undefined : actions}
        />
      )}

      {/* The shelf sizes to its posters, so a short list shares the row with the cards instead of stranding one poster in a full-width row */}
      <div className="flex flex-wrap items-start gap-6 empty:hidden">
        {!hasNoPlays && <TopTitles serverIds={selectedServerIds} className={SHELF} />}
        {!hasNoPlays && <HowYouWatch serverIds={selectedServerIds} className={CARD} />}
        {!hasNoPlays &&
          (myStats.isError ? (
            <InlineErrorState
              message={myStats.error.message}
              onRetry={() => void myStats.refetch()}
            />
          ) : myStats.data ? (
            <AllTimeSection stats={myStats.data} className={CARD} />
          ) : (
            <Skeleton className={cn('h-40 rounded-xl', CARD)} />
          ))}
        <MyRequestsCard className={CARD} />
      </div>
    </div>
  );
}
