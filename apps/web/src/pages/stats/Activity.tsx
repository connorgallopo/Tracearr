import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import {
  PlaysChart,
  PlatformChart,
  DayOfWeekChart,
  HourOfDayChart,
  QualityChart,
  ConcurrentChart,
} from '@/components/charts';
import {
  usePlaysStats,
  usePlaysByDayOfWeek,
  usePlaysByHourOfDay,
  usePlatformStats,
  useQualityStats,
  useConcurrentStats,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';

export function StatsActivity() {
  const { value: timeRange, setValue: setTimeRange, apiParams } = useTimeRange();
  const { selectedServerId } = useServer();

  // Fetch all stats with the same time range and server filter
  const plays = usePlaysStats(apiParams, selectedServerId);
  const dayOfWeek = usePlaysByDayOfWeek(apiParams, selectedServerId);
  const hourOfDay = usePlaysByHourOfDay(apiParams, selectedServerId);
  const platforms = usePlatformStats(apiParams, selectedServerId);
  const quality = useQualityStats(apiParams, selectedServerId);
  const concurrent = useConcurrentStats(apiParams, selectedServerId);

  // Transform data for charts
  const platformData = platforms.data?.map((p) => ({
    name: p.platform ?? 'Unknown',
    count: p.count,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Activity</h1>
          <p className="text-muted-foreground text-sm">
            Play trends, patterns, and streaming behavior
          </p>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Charts grid */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Plays Over Time */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Plays Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            <PlaysChart
              data={plays.data}
              isLoading={plays.isLoading}
              height={250}
              period={timeRange.period}
            />
          </CardContent>
        </Card>

        {/* Concurrent Streams */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Concurrent Streams</CardTitle>
          </CardHeader>
          <CardContent>
            <ConcurrentChart
              data={concurrent.data}
              isLoading={concurrent.isLoading}
              height={250}
              period={timeRange.period}
            />
          </CardContent>
        </Card>

        {/* Day of Week */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Activity by Day of Week</CardTitle>
          </CardHeader>
          <CardContent>
            <DayOfWeekChart data={dayOfWeek.data} isLoading={dayOfWeek.isLoading} height={250} />
          </CardContent>
        </Card>

        {/* Hour of Day */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Activity by Hour of Day</CardTitle>
          </CardHeader>
          <CardContent>
            <HourOfDayChart data={hourOfDay.data} isLoading={hourOfDay.isLoading} height={250} />
          </CardContent>
        </Card>

        {/* Platforms */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Platforms</CardTitle>
          </CardHeader>
          <CardContent>
            <PlatformChart data={platformData} isLoading={platforms.isLoading} height={250} />
          </CardContent>
        </Card>

        {/* Stream Quality */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Stream Quality</CardTitle>
          </CardHeader>
          <CardContent>
            <QualityChart data={quality.data} isLoading={quality.isLoading} height={250} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
