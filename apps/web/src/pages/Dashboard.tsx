import { useState } from 'react';
import { Play, Clock, AlertTriangle, Tv, MapPin, Calendar, Users, Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { NowPlayingCard } from '@/components/sessions';
import { StreamCard } from '@/components/map';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { ServerResourceCharts } from '@/components/charts/ServerResourceCharts';
import { useDashboardStats, useActiveSessions } from '@/hooks/queries';
import { useServerStatistics } from '@/hooks/queries/useServers';
import { useServer } from '@/hooks/useServer';
import type { ActiveSession } from '@tracearr/shared';

export function Dashboard() {
  const { selectedServerId, selectedServer } = useServer();
  const { data: stats, isLoading: statsLoading } = useDashboardStats(selectedServerId);
  const { data: sessions } = useActiveSessions(selectedServerId);

  // Session detail sheet state
  const [selectedSession, setSelectedSession] = useState<ActiveSession | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Only show server resource stats for Plex servers
  const isPlexServer = selectedServer?.type === 'plex';

  // Poll server statistics only when viewing a Plex server
  const {
    data: serverStats,
    isLoading: statsChartLoading,
    averages,
  } = useServerStatistics(selectedServerId ?? undefined, isPlexServer);

  const activeCount = sessions?.length ?? 0;
  const hasActiveStreams = activeCount > 0;

  return (
    <div className="space-y-6">
      {/* Today Stats Section */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Calendar className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">Today</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            icon={AlertTriangle}
            label="Alerts"
            value={stats?.alertsLast24h ?? 0}
            isLoading={statsLoading}
            href="/violations"
          />
          <StatCard
            icon={Play}
            label="Plays"
            value={stats?.todayPlays ?? 0}
            isLoading={statsLoading}
            href="/history"
            subValue={
              stats?.todaySessions && stats.todaySessions > stats.todayPlays
                ? `${stats.todaySessions} sessions`
                : undefined
            }
          />
          <StatCard
            icon={Clock}
            label="Watch Time"
            value={`${stats?.watchTimeHours ?? 0}h`}
            isLoading={statsLoading}
            href="/stats/activity"
          />
          <StatCard
            icon={Users}
            label="Active Users"
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
          <h2 className="text-lg font-semibold">Now Playing</h2>
          {hasActiveStreams && (
            <span className="bg-muted text-foreground rounded-full px-2 py-0.5 text-xs font-medium">
              {activeCount} {activeCount === 1 ? 'stream' : 'streams'}
            </span>
          )}
        </div>

        {!sessions || sessions.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="bg-muted rounded-full p-4">
                <Tv className="text-muted-foreground h-8 w-8" />
              </div>
              <h3 className="mt-4 font-semibold">No active streams</h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Active streams will appear here when users start watching
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sessions.map((session) => (
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
            <h2 className="text-lg font-semibold">Stream Locations</h2>
          </div>
          <Card className="overflow-hidden">
            <StreamCard sessions={sessions} height={320} />
          </Card>
        </section>
      )}

      {/* Server Resource Stats (Plex only) */}
      {isPlexServer && (
        <section>
          <div className="mb-4 flex items-center gap-2">
            <Activity className="text-primary h-5 w-5" />
            <h2 className="text-lg font-semibold">Server Resources</h2>
          </div>
          <ServerResourceCharts
            data={serverStats?.data}
            isLoading={statsChartLoading}
            averages={averages}
          />
        </section>
      )}

      {/* Session Detail Sheet */}
      <SessionDetailSheet session={selectedSession} open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
}
