import { useState } from 'react';
import { Eye, Clock, CheckCircle2, Flame, BarChart3 } from 'lucide-react';
import { StatCard, formatWatchTime } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ErrorState,
  EmptyState,
  CompletionTable,
  BingeHighlightsTable,
} from '@/components/library';
import {
  WatchCountChart,
  CompletionDonutChart,
  HourlyDistributionChart,
  MonthlyTrendChart,
} from '@/components/charts';
import { useLibraryWatch, useLibraryCompletion, useLibraryPatterns } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

function formatPeakHour(hour: number | undefined): string {
  if (hour === undefined) return '-';
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

function formatPeakDay(day: number | undefined): string {
  if (day === undefined) return '';
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[day] ?? '';
}

export function LibraryWatch() {
  const { selectedServerId } = useServer();

  // Watch data for KPIs and watch count chart
  const [watchPage, setWatchPage] = useState(1);
  const watch = useLibraryWatch(selectedServerId, null, watchPage, 20);

  // Completion data for donut chart summary (just first page for counts)
  const completionSummary = useLibraryCompletion(selectedServerId, null, 'item', 1, 1);

  // Patterns data for hourly/monthly charts, peak times, binge shows
  const patterns = useLibraryPatterns(selectedServerId, null, 12); // 12 weeks = ~3 months

  // Header component (used in all states)
  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold">Watch Analytics</h1>
        <p className="text-muted-foreground text-sm">Viewing behavior and content engagement</p>
      </div>
    </div>
  );

  // Show error state with retry
  if (watch.isError || patterns.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title="Failed to load watch analytics"
          message={watch.error?.message ?? patterns.error?.message ?? 'Could not fetch watch data.'}
          onRetry={() => {
            watch.refetch();
            patterns.refetch();
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
          title="No watch data yet"
          description="Watch analytics will appear here once content has been played. Check back after some viewing activity."
        />
      </div>
    );
  }

  // Extract completion summary data for the donut chart
  const completionData = completionSummary.data;
  const completionSummaryData = completionData?.summary;

  return (
    <div className="space-y-6">
      {header}

      {/* KPI Cards Grid - 4 columns on desktop, 2 on mobile */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={Eye}
          label="Watched"
          value={`${watch.data?.summary.watchedCount ?? 0}/${watch.data?.summary.totalItems ?? 0}`}
          subValue={`${(watch.data?.summary.watchedPct ?? 0).toFixed(0)}% watched`}
          isLoading={watch.isLoading}
        />
        <StatCard
          icon={Clock}
          label="Total Watch Time"
          value={formatWatchTime(watch.data?.summary.totalWatchMs ?? 0)}
          subValue={`${(watch.data?.summary.avgWatchesPerItem ?? 0).toFixed(1)} avg per item`}
          isLoading={watch.isLoading}
        />
        <StatCard
          icon={CheckCircle2}
          label="Completed"
          value={`${completionSummaryData?.completedCount ?? 0}`}
          subValue="items"
          isLoading={completionSummary.isLoading}
        />
        <StatCard
          icon={Flame}
          label="Peak Hour"
          value={formatPeakHour(patterns.data?.peakTimes.peakHour)}
          subValue={formatPeakDay(patterns.data?.peakTimes.peakDayOfWeek)}
          isLoading={patterns.isLoading}
        />
      </div>

      {/* Watch Count Chart - Full Width */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">Most Watched</CardTitle>
        </CardHeader>
        <CardContent>
          <WatchCountChart
            data={watch.data?.items}
            isLoading={watch.isLoading}
            height={250}
            limit={10}
          />
        </CardContent>
      </Card>

      {/* Completion Section - Two Columns */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Left: Completion Donut */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Completion Status</CardTitle>
          </CardHeader>
          <CardContent>
            <CompletionDonutChart
              completed={completionSummaryData?.completedCount ?? 0}
              inProgress={completionSummaryData?.inProgressCount ?? 0}
              notStarted={completionSummaryData?.notStartedCount ?? 0}
              isLoading={completionSummary.isLoading}
              height={220}
            />
          </CardContent>
        </Card>

        {/* Right: Completion Summary Stats */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Completion Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Summary counts */}
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-green-500">
                  {completionSummaryData?.completedCount ?? 0}
                </p>
                <p className="text-muted-foreground text-sm">Completed</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-orange-500">
                  {completionSummaryData?.inProgressCount ?? 0}
                </p>
                <p className="text-muted-foreground text-sm">In Progress</p>
              </div>
              <div>
                <p className="text-muted-foreground text-2xl font-bold">
                  {completionSummaryData?.notStartedCount ?? 0}
                </p>
                <p className="text-muted-foreground text-sm">Not Started</p>
              </div>
            </div>
            {/* Average completion */}
            {completionSummaryData && (
              <div className="border-t pt-4 text-center">
                <p className="text-lg font-medium">
                  {completionSummaryData.overallCompletionPct.toFixed(0)}%
                </p>
                <p className="text-muted-foreground text-sm">Average Completion</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Completion Table - Full Width */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">Completion Details</CardTitle>
          <p className="text-muted-foreground text-sm">
            Track progress at item, season, or series level
          </p>
        </CardHeader>
        <CardContent>
          <CompletionTable serverId={selectedServerId} libraryId={null} />
        </CardContent>
      </Card>

      {/* Viewing Patterns Section - Two Columns */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Left: Hourly Distribution */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-medium">Viewing Hours</CardTitle>
              {patterns.data?.peakTimes.peakHour !== undefined && (
                <Badge variant="outline">
                  Peak: {formatPeakHour(patterns.data.peakTimes.peakHour)}
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
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-medium">Monthly Trends</CardTitle>
              {patterns.data?.seasonalTrends && (
                <div className="flex gap-2">
                  <Badge variant="success" className="text-xs">
                    Busiest: {patterns.data.seasonalTrends.busiestMonth}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    Quietest: {patterns.data.seasonalTrends.quietestMonth}
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
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-medium">Binge Highlights</CardTitle>
              <p className="text-muted-foreground text-sm">
                Shows with the most intensive viewing patterns
              </p>
            </div>
            {patterns.data?.summary && (
              <div className="text-right">
                <p className="text-lg font-medium">
                  {patterns.data.summary.bingeSessionsPct.toFixed(0)}%
                </p>
                <p className="text-muted-foreground text-xs">binge sessions</p>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <BingeHighlightsTable data={patterns.data?.bingeShows} isLoading={patterns.isLoading} />
        </CardContent>
      </Card>
    </div>
  );
}
