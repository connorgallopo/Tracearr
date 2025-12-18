/**
 * Activity tab - streaming statistics and charts
 * Query keys include selectedServerId for proper cache isolation per media server
 */
import { useState } from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { colors } from '@/lib/theme';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { PeriodSelector, type StatsPeriod } from '@/components/ui/period-selector';
import {
  PlaysChart,
  PlatformChart,
  DayOfWeekChart,
  HourOfDayChart,
  QualityChart,
} from '@/components/charts';

function ChartSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-4">
      <Text className="text-muted-foreground mb-2 text-sm font-semibold tracking-wide uppercase">
        {title}
      </Text>
      {children}
    </View>
  );
}

export default function ActivityScreen() {
  const [period, setPeriod] = useState<StatsPeriod>('month');
  const { selectedServerId } = useMediaServer();

  // Fetch all stats data with selected period - query keys include selectedServerId for cache isolation
  const {
    data: playsData,
    refetch: refetchPlays,
    isRefetching: isRefetchingPlays,
  } = useQuery({
    queryKey: ['stats', 'plays', period, selectedServerId],
    queryFn: () => api.stats.plays({ period, serverId: selectedServerId ?? undefined }),
  });

  const { data: dayOfWeekData, refetch: refetchDayOfWeek } = useQuery({
    queryKey: ['stats', 'dayOfWeek', period, selectedServerId],
    queryFn: () => api.stats.playsByDayOfWeek({ period, serverId: selectedServerId ?? undefined }),
  });

  const { data: hourOfDayData, refetch: refetchHourOfDay } = useQuery({
    queryKey: ['stats', 'hourOfDay', period, selectedServerId],
    queryFn: () => api.stats.playsByHourOfDay({ period, serverId: selectedServerId ?? undefined }),
  });

  const { data: platformsData, refetch: refetchPlatforms } = useQuery({
    queryKey: ['stats', 'platforms', period, selectedServerId],
    queryFn: () => api.stats.platforms({ period, serverId: selectedServerId ?? undefined }),
  });

  const { data: qualityData, refetch: refetchQuality } = useQuery({
    queryKey: ['stats', 'quality', period, selectedServerId],
    queryFn: () => api.stats.quality({ period, serverId: selectedServerId ?? undefined }),
  });

  const handleRefresh = () => {
    void refetchPlays();
    void refetchDayOfWeek();
    void refetchHourOfDay();
    void refetchPlatforms();
    void refetchQuality();
  };

  // Period labels for display
  const periodLabels: Record<StatsPeriod, string> = {
    week: 'Last 7 Days',
    month: 'Last 30 Days',
    year: 'Last Year',
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background.dark }}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="p-4 pt-3"
        refreshControl={
          <RefreshControl
            refreshing={isRefetchingPlays}
            onRefresh={handleRefresh}
            tintColor={colors.cyan.core}
          />
        }
      >
        {/* Header with Period Selector */}
        <View className="mb-4 flex-row items-center justify-between">
          <View>
            <Text className="text-lg font-semibold">Activity</Text>
            <Text className="text-muted-foreground text-sm">{periodLabels[period]}</Text>
          </View>
          <PeriodSelector value={period} onChange={setPeriod} />
        </View>

        {/* Plays Over Time */}
        <ChartSection title="Plays Over Time">
          <PlaysChart data={playsData?.data || []} height={180} />
        </ChartSection>

        {/* Day of Week & Hour of Day in a row on larger screens */}
        <View className="mb-4 flex-row gap-3">
          <View className="flex-1">
            <Text className="text-muted-foreground mb-2 text-sm font-semibold tracking-wide uppercase">
              By Day
            </Text>
            <DayOfWeekChart data={dayOfWeekData?.data || []} height={160} />
          </View>
        </View>

        <View className="mb-4">
          <Text className="text-muted-foreground mb-2 text-sm font-semibold tracking-wide uppercase">
            By Hour
          </Text>
          <HourOfDayChart data={hourOfDayData?.data || []} height={160} />
        </View>

        {/* Platform Breakdown */}
        <ChartSection title="Platforms">
          <PlatformChart data={platformsData?.data || []} />
        </ChartSection>

        {/* Quality Breakdown */}
        <ChartSection title="Playback Quality">
          {qualityData ? (
            <QualityChart
              directPlay={qualityData.directPlay}
              transcode={qualityData.transcode}
              directPlayPercent={qualityData.directPlayPercent}
              transcodePercent={qualityData.transcodePercent}
              height={120}
            />
          ) : (
            <Card className="h-[120px] items-center justify-center">
              <Text className="text-muted-foreground">Loading...</Text>
            </Card>
          )}
        </ChartSection>
      </ScrollView>
    </SafeAreaView>
  );
}
