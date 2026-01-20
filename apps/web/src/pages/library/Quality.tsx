import { useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ErrorState,
  EmptyState,
  CodecBreakdown,
  QualityProgress,
  QualityTrend,
} from '@/components/library';
import { QualityTimelineChart, QualityDonutChart } from '@/components/charts';
import { useLibraryQuality, useLibraryStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';

export function LibraryQuality() {
  const { selectedServerId } = useServer();
  const { value: timeRange, setValue: setTimeRange } = useTimeRange();

  // Map TimeRangePicker periods to API format
  const apiPeriod = useMemo(() => {
    switch (timeRange.period) {
      case 'week':
        return '7d';
      case 'month':
        return '30d';
      case 'year':
        return '1y';
      case 'all':
        return '1y'; // Default to 1y for "all" since API has limits
      default:
        return '30d';
    }
  }, [timeRange.period]);

  const quality = useLibraryQuality(selectedServerId, null, apiPeriod);
  const stats = useLibraryStats(selectedServerId); // For current snapshot donut

  // Compute trend from quality data (first vs last point)
  const qualityTrend = useMemo(() => {
    if (!quality.data?.data || quality.data.data.length < 2) {
      return null;
    }

    const data = quality.data.data;
    const first = data[0]!;
    const last = data[data.length - 1]!;

    // Calculate 1080p+ percentage at start and end of period
    const firstPct1080Plus = first.pct1080p + first.pct4k;
    const lastPct1080Plus = last.pct1080p + last.pct4k;

    return {
      currentPct: lastPct1080Plus,
      previousPct: firstPct1080Plus,
    };
  }, [quality.data]);

  // Get current quality snapshot from stats or last quality data point
  const currentQuality = useMemo(() => {
    // Prefer stats.qualityBreakdown for current snapshot
    if (stats.data?.qualityBreakdown) {
      return stats.data.qualityBreakdown;
    }
    // Fallback to last quality data point
    if (quality.data?.data?.length) {
      const last = quality.data.data[quality.data.data.length - 1]!;
      return {
        count4k: last.count4k,
        count1080p: last.count1080p,
        count720p: last.count720p,
        countSd: last.countSd,
      };
    }
    return null;
  }, [stats.data, quality.data]);

  // Get codec counts from last quality data point
  const codecCounts = useMemo(() => {
    if (!quality.data?.data?.length) return null;
    const last = quality.data.data[quality.data.data.length - 1]!;
    return {
      hevc: last.hevcCount,
      h264: last.h264Count,
      av1: last.av1Count,
      total: last.totalItems,
    };
  }, [quality.data]);

  // Header component (used in all states)
  const header = (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold">Quality</h1>
        <p className="text-muted-foreground text-sm">Quality evolution and codec distribution</p>
      </div>
      <TimeRangePicker value={timeRange} onChange={setTimeRange} />
    </div>
  );

  // Show error state with retry
  if (quality.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title="Failed to load quality data"
          message={quality.error?.message ?? 'Could not fetch quality data. Please try again.'}
          onRetry={quality.refetch}
        />
      </div>
    );
  }

  // Show empty state if no quality data
  if (!quality.isLoading && (!quality.data?.data || quality.data.data.length === 0)) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={BarChart3}
          title="No quality data yet"
          description="Quality metrics will appear here once library snapshots have been collected. This typically happens automatically within 24 hours."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {/* Quality Evolution Chart (full width) */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-medium">Quality Evolution</CardTitle>
            {qualityTrend && (
              <QualityTrend
                currentPct1080Plus={qualityTrend.currentPct}
                previousPct1080Plus={qualityTrend.previousPct}
              />
            )}
          </div>
        </CardHeader>
        <CardContent>
          <QualityTimelineChart
            data={quality.data}
            isLoading={quality.isLoading}
            height={300}
            period={timeRange.period}
          />
        </CardContent>
      </Card>

      {/* Two column grid: Donut + Stats */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Current Quality Breakdown */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Current Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <QualityDonutChart
              data={currentQuality ?? undefined}
              isLoading={stats.isLoading}
              height={220}
            />
          </CardContent>
        </Card>

        {/* Quality Stats */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Quality Indicators</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Progress indicator */}
            {currentQuality && (
              <QualityProgress
                count1080p={currentQuality.count1080p}
                count4k={currentQuality.count4k}
                total={
                  currentQuality.count4k +
                  currentQuality.count1080p +
                  currentQuality.count720p +
                  currentQuality.countSd
                }
              />
            )}

            {/* Codec breakdown */}
            {codecCounts && (
              <div className="border-t pt-4">
                <h4 className="mb-3 text-sm font-medium">Codec Distribution</h4>
                <CodecBreakdown
                  hevc={codecCounts.hevc}
                  h264={codecCounts.h264}
                  av1={codecCounts.av1}
                  total={codecCounts.total}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
