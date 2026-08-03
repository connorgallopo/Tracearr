import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Clock, AlertTriangle, Tv, MapPin, Calendar, Users, Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { NowPlayingCard, getStreamMode } from '@/components/sessions';
import { StreamCard } from '@/components/map';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { ServerResourceCharts } from '@/components/charts/ServerResourceCharts';
import { ServerBandwidthChart } from '@/components/charts/BandwidthChart';
import { ErrorState } from '@/components/library/ErrorState';
import { NowPlayingCardSkeleton } from '@/components/ui/skeleton';
import { useDashboardStats, useActiveSessions } from '@/hooks/queries';
import { useServerStatistics, useServerBandwidth } from '@/hooks/queries/useServers';
import { useServer } from '@/hooks/useServer';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import type { ActiveSession } from '@tracearr/shared';

export function Dashboard() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds, selectedServers, isMultiServer, selectedServerId } = useServer();
  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
    error: statsErrorObj,
    refetch: refetchStats,
  } = useDashboardStats(selectedServerIds);
  const {
    data: sessions,
    isError: sessionsError,
    error: sessionsErrorObj,
    refetch: refetchSessions,
  } = useActiveSessions(selectedServerIds);

  // Session detail sheet state
  const [selectedSession, setSelectedSession] = useState<ActiveSession | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const serverColorMap = useServerColorMap();

  // Sort sessions by server display order so cards group by server
  const sortedSessions = useMemo(() => {
    if (!sessions) return undefined;
    const orderMap = new Map(selectedServers.map((s) => [s.id, s.displayOrder ?? 0]));
    return [...sessions].sort(
      (a, b) => (orderMap.get(a.serverId) ?? 0) - (orderMap.get(b.serverId) ?? 0)
    );
  }, [sessions, selectedServers]);

  // Only show server resource stats for a single Plex server
  const showServerResources = !isMultiServer && selectedServers[0]?.type === 'plex';

  // Poll server statistics only when viewing a single Plex server
  const {
    data: serverStats,
    isLoading: statsChartLoading,
    averages,
  } = useServerStatistics(selectedServerId ?? undefined, showServerResources);

  const [bandwidthPollInterval, setBandwidthPollInterval] = useState(6);
  const {
    data: bandwidthStats,
    isLoading: bandwidthChartLoading,
    averages: bandwidthAverages,
  } = useServerBandwidth(selectedServerId ?? undefined, showServerResources, bandwidthPollInterval);

  const activeCount = sessions?.length ?? 0;
  const hasActiveStreams = activeCount > 0;
  const streamModeCounts = useMemo(() => {
    const counts = { transcode: 0, directPlay: 0, directStream: 0 };
    for (const session of sessions ?? []) counts[getStreamMode(session)] += 1;
    return counts;
  }, [sessions]);

  if (statsError || sessionsError) {
    return (
      <ErrorState
        title={t('common:errors.somethingWentWrong')}
        message={
          statsErrorObj?.message ?? sessionsErrorObj?.message ?? t('common:errors.unexpectedError')
        }
        onRetry={() => {
          void refetchStats();
          void refetchSessions();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Today Stats Section */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Calendar className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t('common:time.today')}</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            icon={AlertTriangle}
            label={t('dashboard.alerts')}
            value={stats?.alertsLast24h ?? 0}
            isLoading={statsLoading}
            href="/violations"
          />
          <StatCard
            icon={Play}
            label={t('dashboard.plays')}
            value={stats?.todayPlays ?? 0}
            isLoading={statsLoading}
            href="/history"
            subValue={
              stats?.todaySessions && stats.todaySessions > stats.todayPlays
                ? t('common:count.session', { count: stats.todaySessions })
                : undefined
            }
          />
          <StatCard
            icon={Clock}
            label={t('dashboard.watchTime')}
            value={`${stats?.watchTimeHours ?? 0}h`}
            isLoading={statsLoading}
            href="/stats/activity"
          />
          <StatCard
            icon={Users}
            label={t('dashboard.activeUsers')}
            value={stats?.activeUsersToday ?? 0}
            isLoading={statsLoading}
            href="/stats/users"
          />
        </div>
      </section>

      {/* Now Playing Section */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Tv className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t('dashboard.nowPlaying')}</h2>
          {hasActiveStreams && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="bg-muted text-foreground rounded-full px-2 py-0.5 text-xs font-medium">
                {t('common:count.stream', { count: activeCount })}
              </span>
              {streamModeCounts.transcode > 0 && (
                <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-600 dark:text-yellow-400">
                  {t('statsOverview.pills.transcode', { count: streamModeCounts.transcode })}
                </span>
              )}
              {streamModeCounts.directPlay > 0 && (
                <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                  {t('statsOverview.pills.directPlay', { count: streamModeCounts.directPlay })}
                </span>
              )}
              {streamModeCounts.directStream > 0 && (
                <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
                  {t('statsOverview.pills.directStream', {
                    count: streamModeCounts.directStream,
                  })}
                </span>
              )}
            </div>
          )}
        </div>

        {!sortedSessions ? (
          <div className="grid gap-4 min-[2300px]:grid-cols-5! lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <NowPlayingCardSkeleton key={i} />
            ))}
          </div>
        ) : sortedSessions.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="bg-muted rounded-full p-4">
                <Tv className="text-muted-foreground h-8 w-8" />
              </div>
              <h3 className="mt-4 font-semibold">{t('dashboard.noActiveStreams')}</h3>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('dashboard.streamsAppearHere')}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 min-[2300px]:grid-cols-5! lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {sortedSessions.map((session) => (
              <NowPlayingCard
                key={session.id}
                session={session}
                onClick={() => {
                  setSelectedSession(session);
                  setSheetOpen(true);
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* Stream Map - only show when there are active streams */}
      {hasActiveStreams && (
        <section>
          <div className="mb-4 flex items-center gap-2">
            <MapPin className="text-primary h-5 w-5" />
            <h2 className="text-lg font-semibold">{t('dashboard.streamLocations')}</h2>
          </div>
          <Card className="overflow-hidden">
            <StreamCard
              sessions={sessions}
              height={320}
              isMultiServer={isMultiServer}
              serverColorMap={serverColorMap}
            />
          </Card>
        </section>
      )}

      {/* Server Resource Stats (single Plex server only) */}
      {showServerResources && (
        <section>
          <div className="mb-4 flex items-center gap-2">
            <Activity className="text-primary h-5 w-5" />
            <h2 className="text-lg font-semibold">{t('dashboard.serverResources')}</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <ServerResourceCharts
              data={serverStats?.data}
              isLoading={statsChartLoading}
              averages={averages}
            />
            <ServerBandwidthChart
              data={bandwidthStats?.data}
              isLoading={bandwidthChartLoading}
              averages={bandwidthAverages}
              pollInterval={bandwidthPollInterval}
              onPollIntervalChange={setBandwidthPollInterval}
            />
          </div>
        </section>
      )}

      {/* Session Detail Sheet */}
      <SessionDetailSheet session={selectedSession} open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
}
