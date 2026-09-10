import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import {
  PlaysChart,
  PlatformChart,
  DayOfWeekChart,
  HourOfDayChart,
  QualityChart,
  ConcurrentChart,
  EngagementBreakdownChart,
  PlaysVsSessionsChart,
} from '@/components/charts';
import { InlineErrorState } from '@/components/library/ErrorState';
import {
  usePlaysStats,
  usePlaysByDayOfWeek,
  usePlaysByHourOfDay,
  usePlatformStats,
  useQualityStats,
  useConcurrentStats,
  useEngagementStats,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';

export function StatsActivity() {
  const { t } = useTranslation(['pages', 'common']);
  const { value: timeRange, setValue: setTimeRange, apiParams } = useTimeRange();
  const { selectedServerIds, selectedServers, isMultiServer } = useServer();

  // Fetch all stats with the same time range and server filter
  const plays = usePlaysStats(apiParams, selectedServerIds);
  const dayOfWeek = usePlaysByDayOfWeek(apiParams, selectedServerIds);
  const hourOfDay = usePlaysByHourOfDay(apiParams, selectedServerIds);
  const platforms = usePlatformStats(apiParams, selectedServerIds);
  const quality = useQualityStats(apiParams, selectedServerIds);
  const concurrent = useConcurrentStats(apiParams, selectedServerIds);
  const engagement = useEngagementStats(apiParams, selectedServerIds);

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
          <h1 className="text-2xl font-bold">{t('activity.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('activity.description')}</p>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Plays Over Time */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">{t('activity.playsOverTime')}</CardTitle>
          </CardHeader>
          <CardContent>
            {plays.isError ? (
              <InlineErrorState
                message={plays.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void plays.refetch()}
              />
            ) : (
              <PlaysChart
                data={plays.data}
                isLoading={plays.isLoading}
                height={250}
                period={timeRange.period}
                isMultiServer={isMultiServer}
                servers={selectedServers}
              />
            )}
          </CardContent>
        </Card>

        {/* Concurrent Streams */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">
              {t('activity.concurrentStreams')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {concurrent.isError ? (
              <InlineErrorState
                message={concurrent.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void concurrent.refetch()}
              />
            ) : (
              <ConcurrentChart
                data={concurrent.data}
                isLoading={concurrent.isLoading}
                height={250}
                period={timeRange.period}
              />
            )}
          </CardContent>
        </Card>

        {/* Engagement Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">
              {t('activity.engagementBreakdown')}
            </CardTitle>
            <CardDescription>{t('activity.howUsersEngage')}</CardDescription>
          </CardHeader>
          <CardContent>
            {engagement.isError ? (
              <InlineErrorState
                message={engagement.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void engagement.refetch()}
              />
            ) : (
              <EngagementBreakdownChart
                data={engagement.data?.engagementBreakdown}
                isLoading={engagement.isLoading}
                height={250}
              />
            )}
          </CardContent>
        </Card>

        {/* Plays vs Sessions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">{t('activity.playsVsSessions')}</CardTitle>
            <CardDescription>{t('activity.playsVsSessionsDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {engagement.isError ? (
              <InlineErrorState
                message={engagement.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void engagement.refetch()}
              />
            ) : (
              <PlaysVsSessionsChart
                plays={engagement.data?.summary.totalPlays ?? 0}
                sessions={engagement.data?.summary.totalAllSessions ?? 0}
                isLoading={engagement.isLoading}
                height={200}
              />
            )}
          </CardContent>
        </Card>

        {/* Day of Week */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">
              {t('activity.activityByDayOfWeek')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dayOfWeek.isError ? (
              <InlineErrorState
                message={dayOfWeek.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void dayOfWeek.refetch()}
              />
            ) : (
              <DayOfWeekChart data={dayOfWeek.data} isLoading={dayOfWeek.isLoading} height={250} />
            )}
          </CardContent>
        </Card>

        {/* Hour of Day */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">
              {t('activity.activityByHourOfDay')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {hourOfDay.isError ? (
              <InlineErrorState
                message={hourOfDay.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void hourOfDay.refetch()}
              />
            ) : (
              <HourOfDayChart data={hourOfDay.data} isLoading={hourOfDay.isLoading} height={250} />
            )}
          </CardContent>
        </Card>

        {/* Platforms */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">{t('activity.platforms')}</CardTitle>
          </CardHeader>
          <CardContent>
            {platforms.isError ? (
              <InlineErrorState
                message={platforms.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void platforms.refetch()}
              />
            ) : (
              <PlatformChart data={platformData} isLoading={platforms.isLoading} height={250} />
            )}
          </CardContent>
        </Card>

        {/* Stream Quality */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">{t('activity.streamQuality')}</CardTitle>
          </CardHeader>
          <CardContent>
            {quality.isError ? (
              <InlineErrorState
                message={quality.error?.message ?? t('common:errors.unexpectedError')}
                onRetry={() => void quality.refetch()}
              />
            ) : (
              <QualityChart data={quality.data} isLoading={quality.isLoading} height={250} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
