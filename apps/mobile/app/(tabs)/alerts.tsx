/**
 * Alerts tab - violations with infinite scroll
 * Query keys include selectedServerId for proper cache isolation per media server
 */
import { View, FlatList, RefreshControl, Pressable, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useInfiniteQuery, useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { formatDistanceToNow } from 'date-fns';
import {
  MapPin,
  Users,
  Zap,
  Monitor,
  Globe,
  AlertTriangle,
  Check,
  type LucideIcon,
} from 'lucide-react-native';
import { api } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/ui/user-avatar';
import { colors } from '@/lib/theme';
import type { ViolationWithDetails, RuleType, UnitSystem } from '@tracearr/shared';
import { formatSpeed } from '@tracearr/shared';

const PAGE_SIZE = 50;

// Rule type icons mapping
const ruleIcons: Record<RuleType, LucideIcon> = {
  impossible_travel: MapPin,
  simultaneous_locations: Users,
  device_velocity: Zap,
  concurrent_streams: Monitor,
  geo_restriction: Globe,
};

// Rule type display names
const ruleLabels: Record<RuleType, string> = {
  impossible_travel: 'Impossible Travel',
  simultaneous_locations: 'Simultaneous Locations',
  device_velocity: 'Device Velocity',
  concurrent_streams: 'Concurrent Streams',
  geo_restriction: 'Geo Restriction',
};

// Format violation data into readable description based on rule type
function getViolationDescription(
  violation: ViolationWithDetails,
  unitSystem: UnitSystem = 'metric'
): string {
  const data = violation.data;
  const ruleType = violation.rule?.type;

  if (!data || !ruleType) {
    return 'Rule violation detected';
  }

  switch (ruleType) {
    case 'impossible_travel': {
      const from = data.fromCity || data.fromLocation || 'unknown location';
      const to = data.toCity || data.toLocation || 'unknown location';
      const speed =
        typeof data.calculatedSpeedKmh === 'number'
          ? formatSpeed(data.calculatedSpeedKmh, unitSystem)
          : 'impossible speed';
      return `Traveled from ${from} to ${to} at ${speed}`;
    }
    case 'simultaneous_locations': {
      const locations = data.locations as string[] | undefined;
      const count = data.locationCount as number | undefined;
      if (locations && locations.length > 0) {
        return `Active from ${locations.length} locations: ${locations.slice(0, 2).join(', ')}${locations.length > 2 ? '...' : ''}`;
      }
      if (count) {
        return `Streaming from ${count} different locations simultaneously`;
      }
      return 'Streaming from multiple locations simultaneously';
    }
    case 'device_velocity': {
      const ipCount = data.ipCount as number | undefined;
      const windowHours = data.windowHours as number | undefined;
      if (ipCount && windowHours) {
        return `${ipCount} different IPs used in ${windowHours}h window`;
      }
      return 'Too many unique devices in short period';
    }
    case 'concurrent_streams': {
      const streamCount = data.streamCount as number | undefined;
      const maxStreams = data.maxStreams as number | undefined;
      if (streamCount && maxStreams) {
        return `${streamCount} concurrent streams (limit: ${maxStreams})`;
      }
      return 'Exceeded concurrent stream limit';
    }
    case 'geo_restriction': {
      const country = data.country as string | undefined;
      const blockedCountry = data.blockedCountry as string | undefined;
      if (country || blockedCountry) {
        return `Streaming from blocked region: ${country || blockedCountry}`;
      }
      return 'Streaming from restricted location';
    }
    default:
      return 'Rule violation detected';
  }
}

function SeverityBadge({ severity }: { severity: string }) {
  const variant =
    severity === 'critical' || severity === 'high'
      ? 'destructive'
      : severity === 'warning'
        ? 'warning'
        : 'default';

  return (
    <Badge variant={variant} className="capitalize">
      {severity}
    </Badge>
  );
}

function RuleIcon({ ruleType }: { ruleType: RuleType | undefined }) {
  const IconComponent = ruleType ? ruleIcons[ruleType] : AlertTriangle;
  return (
    <View className="bg-surface h-8 w-8 items-center justify-center rounded-lg">
      <IconComponent size={16} color={colors.cyan.core} />
    </View>
  );
}

function ViolationCard({
  violation,
  onAcknowledge,
  onPress,
  unitSystem,
}: {
  violation: ViolationWithDetails;
  onAcknowledge: () => void;
  onPress: () => void;
  unitSystem: UnitSystem;
}) {
  const username = violation.user?.username || 'Unknown User';
  const ruleType = violation.rule?.type as RuleType | undefined;
  const ruleName = ruleType ? ruleLabels[ruleType] : violation.rule?.name || 'Unknown Rule';
  const description = getViolationDescription(violation, unitSystem);
  const timeAgo = formatDistanceToNow(new Date(violation.createdAt), { addSuffix: true });

  return (
    <Pressable onPress={onPress} className="active:opacity-80">
      <Card className="mb-3">
        {/* Header: User + Severity */}
        <View className="mb-3 flex-row items-start justify-between">
          <Pressable
            className="flex-1 flex-row items-center gap-2.5 active:opacity-70"
            onPress={onPress}
          >
            <UserAvatar thumbUrl={violation.user?.thumbUrl} username={username} size={40} />
            <View className="flex-1">
              <Text className="text-base font-semibold">{username}</Text>
              <Text className="text-muted-foreground text-xs">{timeAgo}</Text>
            </View>
          </Pressable>
          <SeverityBadge severity={violation.severity} />
        </View>

        {/* Content: Rule Type with Icon + Description */}
        <View className="mb-3 flex-row items-start gap-3">
          <RuleIcon ruleType={ruleType} />
          <View className="flex-1">
            <Text className="text-cyan-core mb-1 text-sm font-medium">{ruleName}</Text>
            <Text className="text-secondary text-sm leading-5" numberOfLines={2}>
              {description}
            </Text>
          </View>
        </View>

        {/* Action Button */}
        {!violation.acknowledgedAt ? (
          <Pressable
            className="bg-cyan-core/15 flex-row items-center justify-center gap-2 rounded-lg py-2.5 active:opacity-70"
            onPress={(e) => {
              e.stopPropagation();
              onAcknowledge();
            }}
          >
            <Check size={16} color={colors.cyan.core} />
            <Text className="text-cyan-core text-sm font-semibold">Acknowledge</Text>
          </Pressable>
        ) : (
          <View className="bg-success/10 flex-row items-center justify-center gap-2 rounded-lg py-2.5">
            <Check size={16} color={colors.success} />
            <Text className="text-success text-sm">Acknowledged</Text>
          </View>
        )}
      </Card>
    </Pressable>
  );
}

export default function AlertsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { selectedServerId } = useMediaServer();

  // Fetch settings for unit system preference
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
  const unitSystem = settings?.unitSystem ?? 'metric';

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch, isRefetching } =
    useInfiniteQuery({
      queryKey: ['violations', selectedServerId],
      queryFn: ({ pageParam = 1 }) =>
        api.violations.list({
          page: pageParam,
          pageSize: PAGE_SIZE,
          serverId: selectedServerId ?? undefined,
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['violations', selectedServerId] });
    },
  });

  // Flatten all pages into single array
  const violations = data?.pages.flatMap((page) => page.data) || [];
  const unacknowledgedCount = violations.filter((v) => !v.acknowledgedAt).length;
  const total = data?.pages[0]?.total || 0;

  const handleEndReached = () => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  };

  const handleViolationPress = (violation: ViolationWithDetails) => {
    // Navigate to user detail page
    if (violation.user?.id) {
      router.push(`/user/${violation.user.id}` as never);
    }
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background.dark }}
      edges={['left', 'right', 'bottom']}
    >
      <FlatList
        data={violations}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ViolationCard
            violation={item}
            onAcknowledge={() => acknowledgeMutation.mutate(item.id)}
            onPress={() => handleViolationPress(item)}
            unitSystem={unitSystem}
          />
        )}
        contentContainerClassName="p-4 pt-3"
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.cyan.core}
          />
        }
        ListHeaderComponent={
          <View className="mb-3 flex-row items-center justify-between">
            <View>
              <Text className="text-lg font-semibold">Alerts</Text>
              <Text className="text-muted-foreground text-sm">
                {total} {total === 1 ? 'violation' : 'violations'} total
              </Text>
            </View>
            {unacknowledgedCount > 0 && (
              <View className="bg-destructive/20 rounded-lg px-3 py-1.5">
                <Text className="text-destructive text-sm font-medium">
                  {unacknowledgedCount} pending
                </Text>
              </View>
            )}
          </View>
        }
        ListFooterComponent={
          isFetchingNextPage ? (
            <View className="items-center py-4">
              <ActivityIndicator size="small" color={colors.cyan.core} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View className="items-center py-16">
            <View className="bg-success/10 border-success/20 mb-4 h-20 w-20 items-center justify-center rounded-full border">
              <Check size={32} color={colors.success} />
            </View>
            <Text className="mb-2 text-xl font-semibold">All Clear</Text>
            <Text className="text-muted-foreground px-8 text-center text-sm leading-5">
              No rule violations have been detected. Your users are behaving nicely!
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}
