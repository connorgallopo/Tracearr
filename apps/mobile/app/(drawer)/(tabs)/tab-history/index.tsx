/**
 * History tab - redesigned with filters, date ranges, and compact list view
 * Matches web UI quality with proper filtering and aggregates
 */
import { useState, useMemo, useCallback, useRef } from 'react';
import { View, FlatList, RefreshControl, ActivityIndicator, Platform } from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useRouter, Stack } from 'expo-router';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { Play } from 'lucide-react-native';
import { api } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { useUnacknowledgedAlertsCount } from '@/hooks';
import { ACCENT_COLOR, colors } from '@/lib/theme';
import { Text } from '@/components/ui/text';
import {
  HistoryFilters,
  HistoryRow,
  HistoryRowSeparator,
  HistoryAggregates,
  FilterBottomSheet,
  type TimePeriod,
  type FilterBottomSheetRef,
  type FilterState,
} from '@/components/history';
import type { SessionWithDetails } from '@tracearr/shared';
import { useTranslation } from '@tracearr/translations/mobile';

const PAGE_SIZE = 50;

// Convert TimePeriod to date range
function getDateRange(period: TimePeriod): { startDate: Date; endDate: Date } {
  const now = new Date();
  const endDate = now;

  switch (period) {
    case '7d':
      return { startDate: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), endDate };
    case '30d':
      return { startDate: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), endDate };
    case '90d':
      return { startDate: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), endDate };
    case '1y':
      return { startDate: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000), endDate };
    case 'all':
      // Use a very old date for "all time"
      return { startDate: new Date('2000-01-01'), endDate };
  }
}

export default function HistoryScreen() {
  const { t } = useTranslation(['mobile']);
  const router = useRouter();
  const navigation = useNavigation();
  const { selectedServerId } = useMediaServer();
  const { hasAlerts, displayCount } = useUnacknowledgedAlertsCount();
  const filterSheetRef = useRef<FilterBottomSheetRef>(null);

  // Filter state
  const [period, setPeriod] = useState<TimePeriod>('30d');
  const [search, setSearch] = useState('');
  const [advancedFilters, setAdvancedFilters] = useState<FilterState>({
    serverUserIds: [],
    platforms: [],
    geoCountries: [],
    mediaTypes: [],
    transcodeDecisions: [],
  });

  // Count active advanced filters
  const activeFilterCount = useMemo((): number => {
    return (
      advancedFilters.serverUserIds.length +
      advancedFilters.platforms.length +
      advancedFilters.geoCountries.length +
      advancedFilters.mediaTypes.length +
      advancedFilters.transcodeDecisions.length
    );
  }, [advancedFilters]);

  // Fetch filter options for the bottom sheet
  const { data: filterOptions } = useQuery({
    queryKey: ['sessions', 'filter-options', selectedServerId],
    queryFn: () => api.sessions.filterOptions(selectedServerId ?? undefined),
    staleTime: 1000 * 60 * 5, // 5 minutes
    enabled: !!selectedServerId,
  });

  // Build filters object
  const filters = useMemo(() => {
    const { startDate, endDate } = getDateRange(period);
    return {
      serverId: selectedServerId ?? undefined,
      startDate,
      endDate,
      search: search.trim() || undefined,
      serverUserIds:
        advancedFilters.serverUserIds.length > 0 ? advancedFilters.serverUserIds : undefined,
      platforms: advancedFilters.platforms.length > 0 ? advancedFilters.platforms : undefined,
      geoCountries:
        advancedFilters.geoCountries.length > 0 ? advancedFilters.geoCountries : undefined,
      mediaTypes: advancedFilters.mediaTypes.length > 0 ? advancedFilters.mediaTypes : undefined,
      transcodeDecisions:
        advancedFilters.transcodeDecisions.length > 0
          ? advancedFilters.transcodeDecisions
          : undefined,
      orderBy: 'startedAt' as const,
      orderDir: 'desc' as const,
    };
  }, [selectedServerId, period, search, advancedFilters]);

  // Fetch history with infinite scroll
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch, isRefetching, isLoading } =
    useInfiniteQuery({
      queryKey: ['sessions', 'history', selectedServerId, filters],
      queryFn: async ({ pageParam }) => {
        return api.sessions.history({
          ...filters,
          cursor: pageParam,
          pageSize: PAGE_SIZE,
        });
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled: !!selectedServerId,
    });

  // Fetch aggregates for summary stats
  const { data: aggregates, isLoading: isLoadingAggregates } = useQuery({
    queryKey: ['sessions', 'history', 'aggregates', selectedServerId, period],
    queryFn: () => {
      const { startDate, endDate } = getDateRange(period);
      return api.sessions.historyAggregates({
        serverId: selectedServerId ?? undefined,
        startDate,
        endDate,
      });
    },
    staleTime: 1000 * 60,
    enabled: !!selectedServerId,
  });

  // Flatten all pages into single array
  const sessions = useMemo(() => {
    return data?.pages.flatMap((page) => page.data) || [];
  }, [data]);

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleSessionPress = useCallback(
    (session: SessionWithDetails) => {
      router.push(`/session/${session.id}` as never);
    },
    [router]
  );

  const handleFilterPress = useCallback(() => {
    filterSheetRef.current?.open();
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: SessionWithDetails }) => (
      <HistoryRow session={item} onPress={() => handleSessionPress(item)} />
    ),
    [handleSessionPress]
  );

  const keyExtractor = useCallback((item: SessionWithDetails) => item.id, []);

  return (
    <>
      <View style={{ flex: 1, backgroundColor: '#09090B' }}>
        <FlatList
          data={sessions}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          ItemSeparatorComponent={HistoryRowSeparator}
          contentContainerStyle={{ paddingBottom: 24 }}
          contentInsetAdjustmentBehavior="automatic"
          onEndReached={handleEndReached}
          onEndReachedThreshold={0.5}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={ACCENT_COLOR}
            />
          }
          ListHeaderComponent={
            <View className="px-4 pt-2">
              {/* Filters */}
              <HistoryFilters
                period={period}
                onPeriodChange={setPeriod}
                search={search}
                onSearchChange={setSearch}
                activeFilterCount={activeFilterCount}
                onFilterPress={handleFilterPress}
              />

              {/* Aggregates */}
              <HistoryAggregates aggregates={aggregates} isLoading={isLoadingAggregates} />
            </View>
          }
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className="items-center py-4">
                <ActivityIndicator size="small" color={ACCENT_COLOR} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            isLoading ? (
              <View className="items-center py-12">
                <ActivityIndicator size="large" color={ACCENT_COLOR} />
              </View>
            ) : (
              <View className="items-center px-4 py-12">
                <View
                  className="mb-4 h-16 w-16 items-center justify-center rounded-full"
                  style={{ backgroundColor: colors.surface.dark }}
                >
                  <Play size={28} color={colors.icon.default} />
                </View>
                <Text className="mb-2 text-lg font-semibold">
                  {t('mobile:history.noHistoryFound')}
                </Text>
                <Text className="text-muted-foreground max-w-[280px] text-center text-sm">
                  {search || activeFilterCount > 0
                    ? t('mobile:history.adjustFilters')
                    : t('mobile:history.historyWillAppear')}
                </Text>
              </View>
            )
          }
        />

        {/* Filter Bottom Sheet */}
        <FilterBottomSheet
          ref={filterSheetRef}
          filterOptions={filterOptions}
          filters={advancedFilters}
          onFiltersChange={setAdvancedFilters}
        />
      </View>

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
