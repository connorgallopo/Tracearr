/**
 * Activity tab - streaming statistics and charts
 * Query keys include selectedServerId for proper cache isolation per media server
 *
 * Responsive layout:
 * - Phone: Single column, smaller chart heights
 * - Tablet (md+): 2-column grid, taller charts, increased padding
 */
import { useState } from 'react';
import { View, ScrollView, RefreshControl, Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { useResponsive } from '@/hooks/useResponsive';
import { useUnacknowledgedAlertsCount } from '@/hooks';
import { spacing, ACCENT_COLOR } from '@/lib/theme';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { PeriodSelector, type StatsPeriod } from '@/components/ui/period-selector';
import {
  PlaysChart,
  ConcurrentChart,
  PlatformChart,
  DayOfWeekChart,
  HourOfDayChart,
  QualityChart,
} from '@/components/charts';
import { useTranslation } from '@tracearr/translations/mobile';

function ChartSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ flex: 1 }}>
      <Text className="text-muted-foreground mb-2 text-sm font-semibold tracking-wide uppercase">
        {title}
      </Text>
      {children}
    </View>
  );
}

export default function ActivityScreen() {
  const { t } = useTranslation(['mobile', 'common']);
  const router = useRouter();
  const navigation = useNavigation();
  const [period, setPeriod] = useState<StatsPeriod>('month');
  const { selectedServerId } = useMediaServer();
  const { isTablet, select } = useResponsive();
  const { hasAlerts, displayCount } = useUnacknowledgedAlertsCount();

  // Responsive values
  const horizontalPadding = select({ base: spacing.md, md: spacing.lg, lg: spacing.xl });
  const chartHeightLarge = select({ base: 180, md: 250 });
  const chartHeightSmall = select({ base: 160, md: 220 });
  const qualityHeight = select({ base: 120, md: 160 });

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

  const { data: concurrentData, refetch: refetchConcurrent } = useQuery({
    queryKey: ['stats', 'concurrent', period, selectedServerId],
    queryFn: () => api.stats.concurrent({ period, serverId: selectedServerId ?? undefined }),
  });

  const handleRefresh = () => {
    void refetchPlays();
    void refetchConcurrent();
    void refetchDayOfWeek();
    void refetchHourOfDay();
    void refetchPlatforms();
    void refetchQuality();
  };

  // Period labels for display
  const periodLabels: Record<StatsPeriod, string> = {
    week: t('common:periods.last7Days'),
    month: t('common:periods.last30Days'),
    year: t('common:periods.lastYear'),
  };

  return (
    <>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: spacing.sm,
          paddingBottom: spacing.xl,
        }}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={isRefetchingPlays}
            onRefresh={handleRefresh}
            tintColor={ACCENT_COLOR}
          />
        }
      >
        {/* Header with Period Selector */}
        <View className="mb-4 flex-row items-center justify-between">
          <View>
            <Text className="text-muted-foreground text-sm">{periodLabels[period]}</Text>
          </View>
          <PeriodSelector value={period} onChange={setPeriod} />
        </View>

        {/* Plays & Concurrent - side by side on tablets */}
        <View
          style={{
            flexDirection: isTablet ? 'row' : 'column',
            gap: isTablet ? spacing.md : spacing.sm,
            marginBottom: isTablet ? spacing.md : spacing.sm,
          }}
        >
          <ChartSection title={t('mobile:activity.playsOverTime')}>
            <PlaysChart data={playsData?.data || []} height={chartHeightLarge} />
          </ChartSection>

          <ChartSection title={t('mobile:activity.concurrentStreams')}>
            <ConcurrentChart data={concurrentData?.data || []} height={chartHeightLarge} />
          </ChartSection>
        </View>

        {/* Day of Week & Hour of Day - side by side on tablets */}
        <View
          style={{
            flexDirection: isTablet ? 'row' : 'column',
            gap: isTablet ? spacing.md : spacing.sm,
            marginBottom: isTablet ? spacing.md : spacing.sm,
          }}
        >
          <ChartSection title={t('common:periods.byDay')}>
            <DayOfWeekChart data={dayOfWeekData?.data || []} height={chartHeightSmall} />
          </ChartSection>

          <ChartSection title={t('common:periods.byHour')}>
            <HourOfDayChart data={hourOfDayData?.data || []} height={chartHeightSmall} />
          </ChartSection>
        </View>

        {/* Platform & Quality - side by side on tablets */}
        <View
          style={{
            flexDirection: isTablet ? 'row' : 'column',
            gap: isTablet ? spacing.md : spacing.sm,
          }}
        >
          <ChartSection title={t('mobile:activity.platforms')}>
            <PlatformChart data={platformsData?.data || []} height={chartHeightSmall} />
          </ChartSection>

          <ChartSection title={t('mobile:activity.playbackQuality')}>
            {qualityData ? (
              <QualityChart
                directPlay={qualityData.directPlay}
                directStream={qualityData.directStream ?? 0}
                transcode={qualityData.transcode}
                directPlayPercent={qualityData.directPlayPercent}
                directStreamPercent={qualityData.directStreamPercent ?? 0}
                transcodePercent={qualityData.transcodePercent}
                height={qualityHeight}
              />
            ) : (
              <Card style={{ height: qualityHeight }} className="items-center justify-center">
                <Text className="text-muted-foreground">{t('common:states.loading')}</Text>
              </Card>
            )}
          </ChartSection>
        </View>
      </ScrollView>

      {/* iOS Native Toolbar */}
      {Platform.OS === 'ios' && (
        <>
          <Stack.Toolbar placement="left">
            <Stack.Toolbar.Button
              icon="line.3.horizontal"
              onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
            />
          </Stack.Toolbar>
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button icon="bell" onPress={() => router.push('/alerts')}>
              {hasAlerts && <Stack.Toolbar.Badge>{displayCount}</Stack.Toolbar.Badge>}
            </Stack.Toolbar.Button>
          </Stack.Toolbar>
        </>
      )}
    </>
  );
}
