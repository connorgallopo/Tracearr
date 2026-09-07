import { useTranslation } from 'react-i18next';
import { Eye, Clock, CheckCircle2, Flame, BarChart3 } from 'lucide-react';
import type { Server } from '@tracearr/shared';
import { StatCard, formatWatchTime } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState, BingeHighlightsTable, MostWatchedSection } from '@/components/library';
import { EmptyState } from '@/components/ui/empty-state';
import {
  CompletionDonutChart,
  HourlyDistributionChart,
  MonthlyTrendChart,
} from '@/components/charts';
import { PerServerCardGrid } from '@/components/server';
import { useLibraryWatch, useLibraryCompletion, useLibraryPatterns } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { getHour12 } from '@/lib/timeFormat';

function formatPeakHour(hour: number | undefined): string {
  if (hour === undefined) return '-';
  const date = new Date(2024, 0, 1, hour);
  return date.toLocaleTimeString(undefined, { hour: 'numeric', hour12: getHour12() });
}

function formatPeakDay(day: number | undefined): string {
  if (day === undefined) return '';
  // Create a date for the given day of week (Jan 7, 2024 is a Sunday)
  const refDate = new Date(2024, 0, 7 + day);
  return refDate.toLocaleDateString(undefined, { weekday: 'long' });
}

interface ServerCompletionCardProps {
  server: Server;
}

/**
 * Per-server completion donuts used when multiple servers are selected.
 * Fetches movie and episode completion independently for the given server.
 */
function ServerCompletionCard({ server }: ServerCompletionCardProps) {
  const { t } = useTranslation('common');
  const movieCompletion = useLibraryCompletion(server.id, null, 'item', 1, 1, 'movie');
  const tvCompletion = useLibraryCompletion(server.id, null, 'item', 1, 1, 'episode');

  const movieSummary = movieCompletion.data?.summary;
  const tvSummary = tvCompletion.data?.summary;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
          {t('media.movie_plural')}
        </p>
        <CompletionDonutChart
          completed={movieSummary?.completedCount ?? 0}
          inProgress={movieSummary?.inProgressCount ?? 0}
          notStarted={movieSummary?.notStartedCount ?? 0}
          isLoading={movieCompletion.isLoading}
          height={180}
        />
      </div>
      <div>
        <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
          {t('media.tvShows')}
        </p>
        <CompletionDonutChart
          completed={tvSummary?.completedCount ?? 0}
          inProgress={tvSummary?.inProgressCount ?? 0}
          notStarted={tvSummary?.notStartedCount ?? 0}
          isLoading={tvCompletion.isLoading}
          height={180}
        />
      </div>
    </div>
  );
}

export function LibraryWatch() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();

  // Watch data for KPIs - deduped across servers by the backend
  const watch = useLibraryWatch(selectedServerIds, null, 1, 20);

  // Completion data for single-server donut layout
  const movieCompletion = useLibraryCompletion(
    isMultiServer ? null : (selectedServerIds[0] ?? null),
    null,
    'item',
    1,
    1,
    'movie'
  );
  const tvCompletion = useLibraryCompletion(
    isMultiServer ? null : (selectedServerIds[0] ?? null),
    null,
    'item',
    1,
    1,
    'episode'
  );

  // Patterns data for hourly/monthly charts, peak times, binge shows - aggregated across servers
  const patterns = useLibraryPatterns(selectedServerIds, null, 12); // 12 weeks = ~3 months

  // Header component (used in all states)
  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold">{t('library.watch.title')}</h1>
        <p className="text-muted-foreground text-sm">{t('library.watch.description')}</p>
      </div>
    </div>
  );

  // Show error state with retry
  if (watch.isError || patterns.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t('library.watch.failedToLoad')}
          message={
            watch.error?.message ?? patterns.error?.message ?? t('library.watch.failedToLoadDesc')
          }
          onRetry={() => {
            void watch.refetch();
            void patterns.refetch();
          }}
        />
      </div>
    );
  }

  // Show empty state if no watch data
  if (!watch.isLoading && (!watch.data?.items || watch.data.items.length === 0)) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={BarChart3}
          title={t('library.watch.noData')}
          description={t('library.watch.noDataDesc')}
        />
      </div>
    );
  }

  // Total Completed: multi-server uses the deduped completedCount from watch.summary;
  // single-server sums movie + tv completion summaries for backward compatibility.
  const totalCompleted = isMultiServer
    ? (watch.data?.summary.completedCount ?? 0)
    : (movieCompletion.data?.summary.completedCount ?? 0) +
      (tvCompletion.data?.summary.completedCount ?? 0);

  const completedIsLoading = isMultiServer
    ? watch.isLoading
    : movieCompletion.isLoading || tvCompletion.isLoading;

  return (
    <div className="space-y-6">
      {header}

      {/* KPI Cards Grid - 4 columns on desktop, 2 on mobile */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={Eye}
          label={t('library.watch.watched')}
          value={`${watch.data?.summary.watchedCount ?? 0}/${watch.data?.summary.totalItems ?? 0}`}
          subValue={`${(watch.data?.summary.watchedPct ?? 0).toFixed(0)}${t('library.watch.percentWatched')}`}
          isLoading={watch.isLoading}
        />
        <StatCard
          icon={Clock}
          label={t('library.watch.totalWatchTime')}
          value={formatWatchTime(watch.data?.summary.totalWatchMs ?? 0)}
          subValue={`${(watch.data?.summary.avgWatchesPerItem ?? 0).toFixed(1)} ${t('library.watch.avgPerItem')}`}
          isLoading={watch.isLoading}
        />
        <StatCard
          icon={CheckCircle2}
          label={t('library.watch.completed')}
          value={`${totalCompleted}`}
          subValue={t('common:labels.items').toLowerCase()}
          isLoading={completedIsLoading}
        />
        <StatCard
          icon={Flame}
          label={t('library.watch.peakHour')}
          value={formatPeakHour(patterns.data?.peakTimes.peakHour)}
          subValue={formatPeakDay(patterns.data?.peakTimes.peakDayOfWeek)}
          isLoading={patterns.isLoading}
        />
      </div>

      {/* Most Watched Section with Movies/Shows Tabs */}
      <MostWatchedSection
        serverIds={selectedServerIds}
        selectedServers={selectedServers}
        isMultiServer={isMultiServer}
      />

      {/* Completion Section */}
      {isMultiServer ? (
        // Multi-server: one card per server, each with its own Movies + TV donuts
        <PerServerCardGrid
          servers={selectedServers}
          renderServer={(server) => <ServerCompletionCard server={server} />}
        />
      ) : (
        // Single-server: original two-donut Movies / TV layout
        <div className="grid gap-6 md:grid-cols-2">
          {/* Left: Movies Completion */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">
                {t('common:media.movie_plural')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CompletionDonutChart
                completed={movieCompletion.data?.summary.completedCount ?? 0}
                inProgress={movieCompletion.data?.summary.inProgressCount ?? 0}
                notStarted={movieCompletion.data?.summary.notStartedCount ?? 0}
                isLoading={movieCompletion.isLoading}
                height={220}
              />
            </CardContent>
          </Card>

          {/* Right: TV Shows Completion */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">{t('common:media.tvShows')}</CardTitle>
            </CardHeader>
            <CardContent>
              <CompletionDonutChart
                completed={tvCompletion.data?.summary.completedCount ?? 0}
                inProgress={tvCompletion.data?.summary.inProgressCount ?? 0}
                notStarted={tvCompletion.data?.summary.notStartedCount ?? 0}
                isLoading={tvCompletion.isLoading}
                height={220}
              />
            </CardContent>
          </Card>
        </div>
      )}

      {/* Viewing Patterns Section - Two Columns */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Left: Hourly Distribution */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-medium">
                {t('library.watch.viewingHours')}
              </CardTitle>
              {patterns.data?.peakTimes.peakHour !== undefined && (
                <Badge variant="outline">
                  {t('library.watch.peak')} {formatPeakHour(patterns.data.peakTimes.peakHour)}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <HourlyDistributionChart
              data={patterns.data?.peakTimes.hourlyDistribution}
              isLoading={patterns.isLoading}
              height={220}
            />
          </CardContent>
        </Card>

        {/* Right: Monthly Trends with highlights */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-medium">
                {t('library.watch.monthlyTrends')}
              </CardTitle>
              {patterns.data?.seasonalTrends && (
                <div className="flex gap-2">
                  <Badge variant="success" className="text-xs">
                    {t('library.watch.busiest')} {patterns.data.seasonalTrends.busiestMonth}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {t('library.watch.quietest')} {patterns.data.seasonalTrends.quietestMonth}
                  </Badge>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <MonthlyTrendChart
              data={patterns.data?.seasonalTrends.monthlyTrends}
              isLoading={patterns.isLoading}
              height={220}
            />
          </CardContent>
        </Card>
      </div>

      {/* Binge Highlights Section - Full Width */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-medium">
                {t('library.watch.bingeHighlights')}
              </CardTitle>
              <p className="text-muted-foreground text-sm">
                {t('library.watch.bingeHighlightsDesc')}
              </p>
            </div>
            {patterns.data?.summary && (
              <div className="text-right">
                <p className="text-lg font-medium">
                  {patterns.data.summary.bingeSessionsPct.toFixed(0)}%
                </p>
                <p className="text-muted-foreground text-xs">{t('library.watch.bingeSessions')}</p>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <BingeHighlightsTable
            data={patterns.data?.bingeShows}
            isLoading={patterns.isLoading}
            selectedServers={selectedServers}
            isMultiServer={isMultiServer}
          />
        </CardContent>
      </Card>
    </div>
  );
}
