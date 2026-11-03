import { useTranslation } from 'react-i18next';
import { Eye, Clock, CheckCircle2, Flame, BarChart3 } from 'lucide-react';
import type { Server } from '@tracearr/shared';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState, BingeHighlightsTable, MostWatchedSection } from '@/components/library';
import { EmptyState } from '@/components/ui/empty-state';
import {
  CompletionDonutChart,
  HourlyDistributionChart,
  MonthlyTrendChart,
} from '@/components/charts';
import { PerServerCardGrid } from '@/components/server';
import { useLibraryWatch, useLibraryPatterns } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { toApiLibraryParams, useTimeRange } from '@/hooks/useTimeRange';
import { weekdayName, formatWatchTime, formatTrendDate, formatHourOfDay } from '@/lib/dateFormat';
import type { TimeRangeValue } from '@/components/ui/time-range-picker';

interface ServerCompletionCardProps {
  server: Server;
  timeRange: TimeRangeValue;
}

/** Per-server completion donuts used when multiple servers are selected. */
function ServerCompletionCard({ server, timeRange }: ServerCompletionCardProps) {
  const { t } = useTranslation('common');
  const watch = useLibraryWatch([server.id], null, toApiLibraryParams(timeRange));
  const completion = watch.data?.summary.completion;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
          {t('media.movie_plural')}
        </p>
        <CompletionDonutChart
          completed={completion?.movie.completed ?? 0}
          inProgress={completion?.movie.inProgress ?? 0}
          notStarted={completion?.movie.notStarted ?? 0}
          isLoading={watch.isLoading}
          height={180}
        />
      </div>
      <div>
        <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
          {t('media.tvShows')}
        </p>
        <CompletionDonutChart
          completed={completion?.episode.completed ?? 0}
          inProgress={completion?.episode.inProgress ?? 0}
          notStarted={completion?.episode.notStarted ?? 0}
          isLoading={watch.isLoading}
          height={180}
        />
      </div>
    </div>
  );
}

export function LibraryWatch() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();
  const { value: timeRange } = useTimeRange();

  const range = toApiLibraryParams(timeRange);
  const watch = useLibraryWatch(selectedServerIds, null, range);
  const patterns = useLibraryPatterns(selectedServerIds, null, range);

  const summary = watch.data?.summary;

  // Show error state with retry
  if (watch.isError || patterns.isError) {
    return (
      <div className="space-y-6">
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

  if (!watch.isLoading && summary?.totalItems === 0) {
    return (
      <div className="space-y-6">
        <EmptyState
          icon={BarChart3}
          title={t('library.watch.noData')}
          description={t('library.watch.noDataDesc')}
        />
      </div>
    );
  }

  const trend = patterns.data?.trend;
  // The server reports hour 0 and Sunday as the peak of a range with no plays
  const peakTimes = patterns.data?.peakTimes;
  const peak = peakTimes?.hourlyDistribution.some((h) => h.watchCount > 0) ? peakTimes : undefined;
  const totalCompleted = summary
    ? summary.completion.movie.completed + summary.completion.episode.completed
    : 0;

  return (
    <div className="space-y-6">
      {/* KPI Cards Grid - 4 columns on desktop, 2 on mobile */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={Eye}
          label={t('library.watch.watched')}
          value={`${summary?.watchedCount ?? 0}/${summary?.totalItems ?? 0}`}
          subValue={t('library.watch.percentWatchedValue', {
            pct: (summary?.watchedPct ?? 0).toFixed(0),
          })}
          isLoading={watch.isLoading}
        />
        <StatCard
          icon={Clock}
          label={t('library.watch.totalWatchTime')}
          value={formatWatchTime(summary?.totalWatchMs ?? 0)}
          subValue={t('library.watch.avgPerItemValue', {
            value: (summary?.avgPlaysPerItem ?? 0).toFixed(1),
          })}
          isLoading={watch.isLoading}
        />
        <StatCard
          icon={CheckCircle2}
          label={t('library.watch.completed')}
          value={`${totalCompleted}`}
          subValue={t('common:labels.items').toLowerCase()}
          isLoading={watch.isLoading}
        />
        <StatCard
          icon={Flame}
          label={t('library.watch.peakHour')}
          value={peak ? formatHourOfDay(peak.peakHour) : '-'}
          subValue={peak ? weekdayName(peak.peakDayOfWeek, 'long') : ''}
          isLoading={patterns.isLoading}
        />
      </div>

      {/* Most Watched Section with Movies/Shows Tabs */}
      <MostWatchedSection
        serverIds={selectedServerIds}
        selectedServers={selectedServers}
        isMultiServer={isMultiServer}
        timeRange={timeRange}
      />

      {/* Completion Section */}
      {isMultiServer ? (
        // Multi-server: one card per server, each with its own Movies + TV donuts
        <PerServerCardGrid
          servers={selectedServers}
          renderServer={(server) => <ServerCompletionCard server={server} timeRange={timeRange} />}
        />
      ) : (
        // Single-server: two-donut Movies / TV layout
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
                completed={summary?.completion.movie.completed ?? 0}
                inProgress={summary?.completion.movie.inProgress ?? 0}
                notStarted={summary?.completion.movie.notStarted ?? 0}
                isLoading={watch.isLoading}
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
                completed={summary?.completion.episode.completed ?? 0}
                inProgress={summary?.completion.episode.inProgress ?? 0}
                notStarted={summary?.completion.episode.notStarted ?? 0}
                isLoading={watch.isLoading}
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
              {peak && (
                <Badge variant="outline">
                  {t('library.watch.peak')} {formatHourOfDay(peak.peakHour)}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <HourlyDistributionChart
              data={peakTimes?.hourlyDistribution}
              isLoading={patterns.isLoading}
              height={220}
            />
          </CardContent>
        </Card>

        {/* Right: Viewing trend with highlights */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-medium">
                {t('library.watch.viewingTrend')}
              </CardTitle>
              {trend?.busiest && trend.quietest && (
                <div className="flex gap-2">
                  <Badge variant="success" className="text-xs">
                    {t('library.watch.busiest')} {formatTrendDate(trend.busiest, trend.bucket)}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {t('library.watch.quietest')} {formatTrendDate(trend.quietest, trend.bucket)}
                  </Badge>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <MonthlyTrendChart trend={trend} isLoading={patterns.isLoading} height={220} />
          </CardContent>
        </Card>
      </div>

      {/* Binge Highlights Section - Full Width */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium">
            {t('library.watch.bingeHighlights')}
          </CardTitle>
          <p className="text-muted-foreground text-sm">{t('library.watch.bingeHighlightsDesc')}</p>
          {patterns.data?.summary && (
            <CardAction className="text-right">
              <p className="text-lg font-medium">
                {patterns.data.summary.consecutivePlaysPct.toFixed(0)}%
              </p>
              <p className="text-muted-foreground text-xs">{t('library.watch.consecutivePlays')}</p>
            </CardAction>
          )}
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
