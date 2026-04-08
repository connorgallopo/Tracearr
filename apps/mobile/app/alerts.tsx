/**
 * Alerts screen - violations with infinite scroll and filters
 * Accessed via bell icon in header - not a tab anymore
 * Query keys include selectedServerId for proper cache isolation per media server
 *
 * Responsive layout:
 * - Phone: Single column, compact cards
 * - Tablet (md+): 2-column grid, filters row, larger avatars
 */
import { useState, useMemo, useCallback } from 'react';
import { View, FlatList, RefreshControl, Pressable, ActivityIndicator } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useInfiniteQuery, useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { formatDistanceToNow } from 'date-fns';
import { AlertTriangle, Check, Filter, ChevronRight, ChevronLeft } from 'lucide-react-native';
import { api } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { useResponsive } from '@/hooks/useResponsive';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { UserAvatar } from '@/components/ui/user-avatar';
import { colors, spacing, ACCENT_COLOR } from '@/lib/theme';
import type {
  ViolationWithDetails,
  RuleType,
  ViolationSeverity,
  UnitSystem,
} from '@tracearr/shared';
import { getViolationDescription, RULE_DISPLAY_NAMES } from '@tracearr/shared';
import { useTranslation } from '@tracearr/translations/mobile';

const PAGE_SIZE = 50;

type StatusFilter = 'all' | 'pending' | 'acknowledged';

import { ruleIcons } from '@/lib/violations';

import { SeverityBadge } from '@/components/violations/SeverityBadge';

function RuleIcon({ ruleType }: { ruleType: RuleType | undefined }) {
  const IconComponent = ruleType ? ruleIcons[ruleType] : AlertTriangle;
  return (
    <View className="bg-surface h-8 w-8 items-center justify-center rounded-lg">
      <IconComponent size={16} color={ACCENT_COLOR} />
    </View>
  );
}

// Segmented control matching History page pattern
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: colors.surface.dark,
        borderRadius: 8,
        padding: 4,
      }}
    >
      {options.map((option) => {
        const isSelected = value === option.value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 6,
              backgroundColor: isSelected ? colors.card.dark : 'transparent',
            }}
          >
            <Text
              style={{
                fontSize: 13,
                fontWeight: '600',
                color: isSelected ? colors.text.primary.dark : colors.text.muted.dark,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ViolationCard({
  violation,
  onAcknowledge,
  onPress,
  unitSystem,
  isTablet,
}: {
  violation: ViolationWithDetails;
  onAcknowledge: () => void;
  onPress: () => void;
  unitSystem: UnitSystem;
  isTablet?: boolean;
}) {
  const { t } = useTranslation(['mobile', 'common', 'pages', 'nav', 'notifications']);
  const displayName = violation.user?.identityName ?? violation.user?.username ?? 'Unknown User';
  const username = violation.user?.username ?? 'Unknown';
  const ruleType = violation.rule?.type as RuleType | undefined;
  const ruleName = ruleType ? RULE_DISPLAY_NAMES[ruleType] : violation.rule?.name || 'Unknown Rule';
  const description = getViolationDescription(violation, unitSystem);
  const timeAgo = formatDistanceToNow(new Date(violation.createdAt), { addSuffix: true });
  const avatarSize = isTablet ? 48 : 40;

  return (
    <Pressable onPress={onPress} className="active:opacity-80">
      <Card className="mb-3">
        {/* Header: User + Severity */}
        <View className="mb-3 flex-row items-start justify-between">
          <View className="flex-1 flex-row items-center gap-2.5">
            <UserAvatar
              thumbUrl={violation.user?.thumbUrl}
              serverId={violation.user?.serverId}
              username={username}
              size={avatarSize}
            />
            <View className="flex-1">
              <Text className="text-base font-semibold" numberOfLines={1}>
                {displayName}
              </Text>
              {violation.user?.identityName && violation.user.identityName !== username && (
                <Text className="text-muted-foreground text-xs">@{username}</Text>
              )}
              <Text className="text-muted-foreground text-xs">{timeAgo}</Text>
            </View>
          </View>
          <View className="flex-row items-center gap-2">
            <SeverityBadge severity={violation.severity} />
            <ChevronRight size={16} color={colors.text.muted.dark} />
          </View>
        </View>

        {/* Content: Rule Type with Icon + Description */}
        <View className="mb-3 flex-row items-start gap-3">
          <RuleIcon ruleType={ruleType} />
          <View className="flex-1">
            <Text className="text-primary mb-1 text-sm font-medium">{ruleName}</Text>
            <Text className="text-secondary text-sm leading-5" numberOfLines={2}>
              {description}
            </Text>
          </View>
        </View>

        {/* Action Button */}
        {!violation.acknowledgedAt ? (
          <Pressable
            className="bg-primary/15 flex-row items-center justify-center gap-2 rounded-lg py-2.5 active:opacity-70"
            onPress={(e) => {
              e.stopPropagation();
              onAcknowledge();
            }}
          >
            <Check size={16} color={ACCENT_COLOR} />
            <Text className="text-primary text-sm font-semibold">
              {t('common:actions.acknowledge')}
            </Text>
          </Pressable>
        ) : (
          <View className="bg-success/10 flex-row items-center justify-center gap-2 rounded-lg py-2.5">
            <Check size={16} color={colors.success} />
            <Text className="text-success text-sm">{t('common:states.acknowledged')}</Text>
          </View>
        )}
      </Card>
    </Pressable>
  );
}

export default function AlertsScreen() {
  const { t } = useTranslation(['mobile', 'common', 'pages', 'nav', 'notifications']);
  const router = useRouter();
  const queryClient = useQueryClient();
  const { selectedServerId } = useMediaServer();
  const { isTablet, select } = useResponsive();
  const insets = useSafeAreaInsets();

  const severityOptions: { value: ViolationSeverity | 'all'; label: string }[] = [
    { value: 'all', label: t('notifications:settings.allTypes') },
    { value: 'high', label: t('common:severity.high') },
    { value: 'warning', label: t('common:severity.warning') },
    { value: 'low', label: t('common:severity.low') },
  ];

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: t('notifications:settings.allTypes') },
    { value: 'pending', label: t('common:states.pending') },
    { value: 'acknowledged', label: t('mobile:alerts.done') },
  ];

  // Filter state
  const [severityFilter, setSeverityFilter] = useState<ViolationSeverity | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Responsive values
  const horizontalPadding = select({ base: spacing.md, md: spacing.lg, lg: spacing.xl });
  const numColumns = isTablet ? 2 : 1;

  // Fetch settings for unit system preference
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
    staleTime: 1000 * 60 * 5,
  });
  const unitSystem = settings?.unitSystem ?? 'metric';

  // Clear iOS app icon badge when viewing alerts screen
  // This matches standard iOS UX where viewing notifications clears the badge
  // The badge syncs with actual count on foreground and after acknowledging
  useFocusEffect(
    useCallback(() => {
      void Notifications.setBadgeCountAsync(0);
    }, [])
  );

  // Build query params based on filters
  const queryParams = useMemo(
    () => ({
      pageSize: PAGE_SIZE,
      serverId: selectedServerId ?? undefined,
      severity: severityFilter === 'all' ? undefined : severityFilter,
      acknowledged: statusFilter === 'all' ? undefined : statusFilter === 'acknowledged',
    }),
    [selectedServerId, severityFilter, statusFilter]
  );

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch, isRefetching } =
    useInfiniteQuery({
      queryKey: ['violations', selectedServerId, severityFilter, statusFilter],
      queryFn: ({ pageParam }) =>
        api.violations.list({
          ...queryParams,
          page: pageParam,
        }),
      initialPageParam: 1,
      getNextPageParam: (lastPage: { page: number; totalPages: number }) => {
        if (lastPage.page < lastPage.totalPages) {
          return lastPage.page + 1;
        }
        return undefined;
      },
    });

  const acknowledgeMutation = useMutation({
    mutationFn: api.violations.acknowledge,
    onSuccess: async () => {
      void queryClient.invalidateQueries({ queryKey: ['violations'] });

      // Sync iOS app icon badge with actual unacknowledged count
      try {
        const response = await api.violations.list({
          acknowledged: false,
          pageSize: 1,
        });
        await Notifications.setBadgeCountAsync(response.total);
      } catch {
        // Fail silently - badge might be slightly off but app shouldn't crash
      }
    },
  });

  // Flatten all pages into single array
  const violations = data?.pages.flatMap((page) => page.data) || [];
  const total = data?.pages[0]?.total || 0;

  // Count unacknowledged from current filtered view
  const unacknowledgedCount = violations.filter((v) => !v.acknowledgedAt).length;

  const handleEndReached = () => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  };

  const handleViolationPress = (violation: ViolationWithDetails) => {
    // Navigate to violation detail page
    router.push(`/violation/${violation.id}` as never);
  };

  const hasActiveFilters = severityFilter !== 'all' || statusFilter !== 'all';

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      // Fallback to home - navigate to the drawer's index (dashboard)
      router.replace('/(drawer)/(tabs)' as never);
    }
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: '#09090B' }}
      edges={['left', 'right', 'bottom']}
    >
      {/* Header with back button */}
      <View
        className="border-border border-b"
        style={{ paddingTop: insets.top, backgroundColor: colors.background.dark }}
      >
        <View className="h-14 flex-row items-center justify-between px-4">
          <Pressable
            onPress={handleBack}
            className="h-11 w-11 items-center justify-center rounded-lg"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <ChevronLeft size={24} color={colors.text.primary.dark} />
          </Pressable>
          <Text className="text-[17px] font-semibold">{t('nav:alerts')}</Text>
          <View className="w-11" />
        </View>
      </View>

      <FlatList
        data={violations}
        keyExtractor={(item) => item.id}
        numColumns={numColumns}
        key={numColumns}
        renderItem={({ item, index }) => (
          <View
            style={{
              flex: 1,
              paddingLeft: isTablet && index % 2 === 1 ? spacing.sm / 2 : 0,
              paddingRight: isTablet && index % 2 === 0 ? spacing.sm / 2 : 0,
            }}
          >
            <ViolationCard
              violation={item}
              onAcknowledge={() => acknowledgeMutation.mutate(item.id)}
              onPress={() => handleViolationPress(item)}
              unitSystem={unitSystem}
              isTablet={isTablet}
            />
          </View>
        )}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: spacing.sm,
          paddingBottom: spacing.xl,
        }}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ACCENT_COLOR} />
        }
        ListHeaderComponent={
          <View className="mb-4 gap-3">
            {/* Summary row */}
            <View className="flex-row items-center justify-between">
              <Text className="text-muted-foreground text-sm">
                {hasActiveFilters ? `${violations.length} of ` : ''}
                {t('common:count.alert', { count: total })}
              </Text>
              {unacknowledgedCount > 0 && statusFilter !== 'acknowledged' && (
                <View className="bg-destructive/20 rounded-full px-3 py-1">
                  <Text className="text-destructive text-xs font-semibold">
                    {unacknowledgedCount} {t('common:states.pending').toLowerCase()}
                  </Text>
                </View>
              )}
            </View>

            {/* Severity filter */}
            <View className="gap-1.5">
              <Text className="text-muted-foreground text-xs font-medium">
                {t('common:labels.severity')}
              </Text>
              <SegmentedControl
                options={severityOptions}
                value={severityFilter}
                onChange={setSeverityFilter}
              />
            </View>

            {/* Status filter */}
            <View className="gap-1.5">
              <Text className="text-muted-foreground text-xs font-medium">
                {t('common:labels.status')}
              </Text>
              <SegmentedControl
                options={statusOptions}
                value={statusFilter}
                onChange={setStatusFilter}
              />
            </View>
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
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 24,
              paddingVertical: 80,
            }}
          >
            {hasActiveFilters ? (
              <>
                {/* No matches for current filters */}
                <View
                  style={{
                    width: 72,
                    height: 72,
                    borderRadius: 36,
                    backgroundColor: colors.surface.dark,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 20,
                  }}
                >
                  <Filter size={32} color={colors.text.muted.dark} />
                </View>
                <Text
                  style={{
                    fontSize: 20,
                    fontWeight: '600',
                    color: colors.text.primary.dark,
                    marginBottom: 8,
                  }}
                >
                  {t('pages:violations.noMatches')}
                </Text>
                <Text
                  style={{
                    fontSize: 14,
                    color: colors.text.muted.dark,
                    textAlign: 'center',
                    marginBottom: 24,
                    lineHeight: 20,
                  }}
                >
                  {t('pages:violations.tryAdjustingFilters')}
                </Text>
                <Pressable
                  onPress={() => {
                    setSeverityFilter('all');
                    setStatusFilter('all');
                  }}
                  style={{
                    backgroundColor: colors.surface.dark,
                    paddingHorizontal: 20,
                    paddingVertical: 10,
                    borderRadius: 8,
                  }}
                >
                  <Text style={{ color: ACCENT_COLOR, fontSize: 14, fontWeight: '600' }}>
                    {t('mobile:alerts.clearFilters')}
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                {/* All clear - simple centered design */}
                <View
                  style={{
                    width: 80,
                    height: 80,
                    borderRadius: 40,
                    backgroundColor: `${colors.success}20`,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 24,
                  }}
                >
                  <Check size={40} color={colors.success} strokeWidth={2.5} />
                </View>
                <Text
                  style={{
                    fontSize: 22,
                    fontWeight: '700',
                    color: colors.text.primary.dark,
                    marginBottom: 8,
                  }}
                >
                  {t('pages:violations.allClear')}
                </Text>
                <Text
                  style={{
                    fontSize: 14,
                    color: colors.text.muted.dark,
                    textAlign: 'center',
                    lineHeight: 20,
                  }}
                >
                  {t('pages:violations.noViolationsDetected')}
                </Text>
              </>
            )}
          </View>
        }
      />
    </SafeAreaView>
  );
}
