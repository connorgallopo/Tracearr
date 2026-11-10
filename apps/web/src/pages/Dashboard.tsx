import { lazy, Suspense, useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Clock, AlertTriangle, MapPin, Calendar, Users, Activity } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
const StreamCard = lazy(() =>
  import('@/components/map/StreamCard').then((m) => ({ default: m.StreamCard }))
);
import { ServerResourceCharts } from '@/components/charts/ServerResourceCharts';
import { ServerBandwidthChart } from '@/components/charts/BandwidthChart';
import { ErrorState } from '@/components/library/ErrorState';
import { NowPlayingSection } from '@/components/dashboard/NowPlayingSection';
import { SectionHeading } from '@/components/dashboard/SectionHeading';
import { PersonalDashboard } from '@/components/dashboard/PersonalDashboard';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useDashboardStats, useActiveSessions } from '@/hooks/queries';
import { useServerLiveStats, useMultiServerLiveStats } from '@/hooks/queries/useServers';
import { useAuth } from '@/hooks/useAuth';
import { useServer } from '@/hooks/useServer';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import { useSocket } from '@/hooks/useSocket';
import { SERVER_PROFILES, pickServerColor } from '@tracearr/shared';
import { formatWatchTime } from '@/lib/dateFormat';
import { cn } from '@/lib/utils';

function ServerDashboard({ actions }: { actions?: ReactNode }) {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds, selectedServers, isMultiServer, selectedServerId } = useServer();
  const { isConnected } = useSocket();
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
  } = useActiveSessions(selectedServerIds, isConnected);

  const serverColorMap = useServerColorMap();

  // Sort sessions by server display order so cards group by server
  const sortedSessions = useMemo(() => {
    if (!sessions) return undefined;
    const orderMap = new Map(selectedServers.map((s) => [s.id, s.displayOrder ?? 0]));
    return [...sessions].sort(
      (a, b) => (orderMap.get(a.serverId) ?? 0) - (orderMap.get(b.serverId) ?? 0)
    );
  }, [sessions, selectedServers]);

  // Single-server view: Plex always shows the section; Jellyfin/Emby show it
  // once the SSE plugin's server.stats samples start arriving
  const singleServer = !isMultiServer ? selectedServers[0] : undefined;
  const singleProfile = singleServer && SERVER_PROFILES[singleServer.type];

  // Multi-server view fans out to every selected server and overlays one
  // line per server that reports data. Servers without a stats source yet
  // (Jellyfin/Emby until the SSE plugin samples them) return empty series
  // and contribute no line.
  const statsServerIds = useMemo(
    () => (isMultiServer ? selectedServers.filter((s) => !s.historicalAt).map((s) => s.id) : []),
    [isMultiServer, selectedServers]
  );

  const {
    statistics: serverStats,
    statisticsAverages: averages,
    bandwidth: bandwidthStats,
    bandwidthAverages,
    clockSkewMs: singleClockSkewMs,
    isLoading: liveStatsLoading,
  } = useServerLiveStats(
    selectedServerId ?? undefined,
    !!singleServer && !singleServer.historicalAt
  );

  const showServerResources =
    !!singleServer &&
    !singleServer.historicalAt &&
    (singleProfile?.hostStats === 'plexStatistics' || (serverStats?.length ?? 0) > 0);

  const liveSelected = selectedServers.filter((s) => !s.historicalAt);

  const showBandwidthChart =
    !!singleProfile?.reportsBandwidth ||
    (isMultiServer && liveSelected.some((s) => SERVER_PROFILES[s.type].reportsBandwidth));
  const singleProcessLabel = singleServer
    ? { plex: 'Plex Media Server', jellyfin: 'Jellyfin', emby: 'Emby' }[singleServer.type]
    : undefined;

  const {
    series: multiLiveStats,
    clockSkewMs: multiClockSkewMs,
    isLoading: multiStatsLoading,
  } = useMultiServerLiveStats(statsServerIds, statsServerIds.length > 0);

  const clockSkewMs = showServerResources ? singleClockSkewMs : multiClockSkewMs;

  const hasAnyMultiData = multiLiveStats.some(
    (s) => s.statistics.length > 0 || s.bandwidth.length > 0
  );
  const showMultiServerResources =
    isMultiServer &&
    (hasAnyMultiData ||
      liveSelected.some((s) => SERVER_PROFILES[s.type].hostStats === 'plexStatistics'));

  const seriesMeta = useCallback(
    (serverId: string) => {
      const server = selectedServers.find((p) => p.id === serverId);
      return {
        serverId,
        serverName: server?.name ?? serverId,
        color:
          serverColorMap.get(serverId) ??
          pickServerColor(
            server?.type ?? 'plex',
            selectedServers.map((p) => p.color)
          ),
      };
    },
    [selectedServers, serverColorMap]
  );

  const resourceMultiSeries = useMemo(
    () =>
      showMultiServerResources
        ? multiLiveStats
            .filter((s) => s.statistics.length > 0)
            .map((s) => ({ ...seriesMeta(s.serverId), data: s.statistics }))
        : undefined,
    [showMultiServerResources, multiLiveStats, seriesMeta]
  );

  const bandwidthMultiSeries = useMemo(
    () =>
      showMultiServerResources
        ? multiLiveStats
            .filter((s) => s.bandwidth.length > 0)
            .map((s) => ({ ...seriesMeta(s.serverId), data: s.bandwidth }))
        : undefined,
    [showMultiServerResources, multiLiveStats, seriesMeta]
  );

  const hasActiveStreams = (sessions?.length ?? 0) > 0;

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
        <SectionHeading icon={Calendar} title={t('common:time.today')} actions={actions} />
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
            value={formatWatchTime(stats?.watchTimeMs ?? 0)}
            subValue={
              stats?.listenTimeMs
                ? `${t('common:labels.listenTime')} ${formatWatchTime(stats.listenTimeMs)}`
                : undefined
            }
            isLoading={statsLoading}
            href="/stats/activity"
          />
          <StatCard
            icon={Users}
            label={t('dashboard.activeUsers')}
            value={stats?.activeUsersToday ?? 0}
            isLoading={statsLoading}
            href="/stats/people"
          />
        </div>
      </section>

      <NowPlayingSection sessions={sortedSessions} />

      {/* Stream Map - only show when there are active streams */}
      {hasActiveStreams && (
        <section>
          <SectionHeading icon={MapPin} title={t('dashboard.streamLocations')} />
          <Card className="overflow-hidden py-0">
            <Suspense fallback={<div className="bg-muted/30 h-[320px] w-full animate-pulse" />}>
              <StreamCard
                sessions={sessions}
                height={320}
                isMultiServer={isMultiServer}
                serverColorMap={serverColorMap}
              />
            </Suspense>
          </Card>
        </section>
      )}

      {/* Server Resource Stats (single server, or per-server overlay lines) */}
      {(showServerResources || showMultiServerResources) && (
        <section>
          <SectionHeading icon={Activity} title={t('dashboard.serverResources')} />
          <div
            className={cn('grid gap-4', showBandwidthChart ? 'md:grid-cols-3' : 'md:grid-cols-2')}
          >
            <ServerResourceCharts
              data={showServerResources ? serverStats : undefined}
              isLoading={
                showServerResources ? liveStatsLoading : multiStatsLoading && !hasAnyMultiData
              }
              averages={showServerResources ? averages : undefined}
              multiSeries={showMultiServerResources ? resourceMultiSeries : undefined}
              processLabel={singleProcessLabel}
              clockSkewMs={clockSkewMs}
            />
            {showBandwidthChart && (
              <ServerBandwidthChart
                data={showServerResources ? bandwidthStats : undefined}
                isLoading={
                  showServerResources ? liveStatsLoading : multiStatsLoading && !hasAnyMultiData
                }
                averages={showServerResources ? bandwidthAverages : undefined}
                multiSeries={showMultiServerResources ? bandwidthMultiSeries : undefined}
                clockSkewMs={clockSkewMs}
              />
            )}
          </div>
        </section>
      )}
    </div>
  );
}

const VIEW_KEY = 'tracearr_dashboard_view';

type DashboardView = 'admin' | 'me';

function isView(value: unknown): value is DashboardView {
  return value === 'admin' || value === 'me';
}

function storedView(): DashboardView | null {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    return isView(stored) ? stored : null;
  } catch {
    return null;
  }
}

function ViewToggle({
  value,
  onChange,
}: {
  value: DashboardView;
  onChange: (next: DashboardView) => void;
}) {
  const { t } = useTranslation('pages');

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => isView(next) && onChange(next)}
      variant="outline"
      size="sm"
      aria-label={t('dashboard.view.label')}
      className="w-full sm:w-auto"
    >
      <ToggleGroupItem value="admin" className="flex-1 sm:flex-none">
        {t('dashboard.view.admin')}
      </ToggleGroupItem>
      <ToggleGroupItem value="me" className="flex-1 sm:flex-none">
        {t('dashboard.view.me')}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function DashboardPage({ children }: { children: ReactNode }) {
  const { t } = useTranslation('nav');

  return (
    <>
      <h1 className="sr-only">{t('dashboard')}</h1>
      {children}
    </>
  );
}

export function Dashboard() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  if (user?.role === 'member') {
    return (
      <DashboardPage>
        <PersonalDashboard />
      </DashboardPage>
    );
  }
  // Viewing as an admin shows what that admin lands on, with no toggle and no stored choice
  if (user?.impersonatedBy) {
    return (
      <DashboardPage>
        <ServerDashboard />
      </DashboardPage>
    );
  }

  const param = searchParams.get('view');
  const view = isView(param) ? param : (storedView() ?? 'admin');

  const select = (next: DashboardView) => {
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // storage is unavailable; the URL still carries the choice
    }
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set('view', next);
        return params;
      },
      { replace: true }
    );
  };

  const toggle = <ViewToggle value={view} onChange={select} />;
  return (
    <DashboardPage>
      {view === 'me' ? (
        <PersonalDashboard actions={toggle} />
      ) : (
        <ServerDashboard actions={toggle} />
      )}
    </DashboardPage>
  );
}
