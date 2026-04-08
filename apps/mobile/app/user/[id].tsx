/**
 * User Detail Screen
 * Shows comprehensive user information with web feature parity
 * Query keys include selectedServerId for proper cache isolation per media server
 *
 * Responsive layout:
 * - Phone: Single column, 64px avatar, 2x2 stats grid
 * - Tablet (md+): Responsive padding, 80px avatar, 1x4 stats row, 2-column Locations/Devices
 */
import {
  View,
  ScrollView,
  RefreshControl,
  Pressable,
  ActivityIndicator,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Crown,
  Play,
  Clock,
  AlertTriangle,
  Globe,
  MapPin,
  Smartphone,
  Tv,
  ChevronRight,
  Check,
  Film,
  Music,
  XCircle,
  User,
  Bot,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect } from 'react';
import { api, getServerUrl } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { useResponsive } from '@/hooks/useResponsive';
import { Text } from '@/components/ui/text';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/ui/user-avatar';
import { cn } from '@/lib/utils';
import { colors, spacing, ACCENT_COLOR } from '@/lib/theme';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import type {
  Session,
  ViolationWithDetails,
  UserLocation,
  UserDevice,
  RuleType,
  TerminationLogWithDetails,
} from '@tracearr/shared';
import { RULE_DISPLAY_NAMES } from '@tracearr/shared';
import { useTranslation } from '@tracearr/translations/mobile';

const PAGE_SIZE = 10;

// Safe date parsing helper - handles string dates from API
function safeParseDate(date: Date | string | null | undefined): Date | null {
  if (!date) return null;
  const parsed = new Date(date);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Safe format distance helper
function safeFormatDistanceToNow(date: Date | string | null | undefined): string {
  const parsed = safeParseDate(date);
  if (!parsed) return 'Unknown';
  return formatDistanceToNow(parsed, { addSuffix: true });
}

// Safe format date helper
function safeFormatDate(date: Date | string | null | undefined, formatStr: string): string {
  const parsed = safeParseDate(date);
  if (!parsed) return 'Unknown';
  return format(parsed, formatStr);
}

import { ruleIcons } from '@/lib/violations';

function TrustScoreBadge({ score, showLabel = false }: { score: number; showLabel?: boolean }) {
  const variant = score < 50 ? 'destructive' : score < 75 ? 'warning' : 'success';
  const label = score < 50 ? 'Low' : score < 75 ? 'Medium' : 'High';

  return (
    <View className="flex-row items-center gap-2">
      <View
        className={cn(
          'min-w-[45px] items-center rounded-md px-2.5 py-1',
          variant === 'destructive' && 'bg-destructive/20',
          variant === 'warning' && 'bg-warning/20',
          variant === 'success' && 'bg-success/20'
        )}
      >
        <Text
          className={cn(
            'text-base font-bold',
            variant === 'destructive' && 'text-destructive',
            variant === 'warning' && 'text-warning',
            variant === 'success' && 'text-success'
          )}
        >
          {score}
        </Text>
      </View>
      {showLabel && <Text className="text-muted-foreground text-sm">{label} Trust</Text>}
    </View>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  subValue,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  subValue?: string;
}) {
  return (
    <View className="bg-surface border-border flex-1 rounded-lg border p-3">
      <View className="mb-1 flex-row items-center gap-2">
        <Icon size={14} color={colors.text.muted.dark} />
        <Text className="text-muted-foreground text-xs">{label}</Text>
      </View>
      <Text className="text-xl font-bold">{value}</Text>
      {subValue && <Text className="text-muted-foreground mt-0.5 text-xs">{subValue}</Text>}
    </View>
  );
}

function formatDuration(ms: number | null): string {
  if (!ms) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function LocationCard({ location }: { location: UserLocation }) {
  const locationText =
    [location.city, location.region, location.country].filter(Boolean).join(', ') ||
    'Unknown Location';

  return (
    <View className="border-border flex-row items-center gap-3 border-b py-3">
      <View className="bg-primary/10 h-8 w-8 items-center justify-center rounded-full">
        <MapPin size={16} color={ACCENT_COLOR} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-medium">{locationText}</Text>
        <Text className="text-muted-foreground text-xs">
          {location.sessionCount} {location.sessionCount === 1 ? 'session' : 'sessions'}
          {' • '}
          {safeFormatDistanceToNow(location.lastSeenAt)}
        </Text>
      </View>
    </View>
  );
}

function DeviceCard({ device }: { device: UserDevice }) {
  const deviceName = device.playerName || device.device || device.product || 'Unknown Device';
  const platform = device.platform || 'Unknown Platform';

  return (
    <View className="border-border flex-row items-center gap-3 border-b py-3">
      <View className="bg-primary/10 h-8 w-8 items-center justify-center rounded-full">
        <Smartphone size={16} color={ACCENT_COLOR} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-medium">{deviceName}</Text>
        <Text className="text-muted-foreground text-xs">
          {platform} • {device.sessionCount} {device.sessionCount === 1 ? 'session' : 'sessions'}
        </Text>
        <Text className="text-muted-foreground text-xs">
          Last seen {safeFormatDistanceToNow(device.lastSeenAt)}
        </Text>
      </View>
    </View>
  );
}

function getMediaIcon(mediaType: string): typeof Film {
  switch (mediaType) {
    case 'movie':
      return Film;
    case 'episode':
      return Tv;
    case 'track':
      return Music;
    default:
      return Film;
  }
}

function SessionCard({
  session,
  onPress,
  serverUrl,
}: {
  session: Session;
  onPress?: () => void;
  serverUrl: string | null;
}) {
  const locationText = [session.geoCity, session.geoCountry].filter(Boolean).join(', ');
  const MediaIcon = getMediaIcon(session.mediaType);

  // Build poster URL - need serverId and thumbPath
  const hasPoster = serverUrl && session.thumbPath && session.serverId;
  const posterUrl = hasPoster
    ? `${serverUrl}/api/v1/images/proxy?server=${session.serverId}&url=${encodeURIComponent(session.thumbPath!)}&width=80&height=120`
    : null;

  // Determine display state - show "Watched" for completed sessions that reached 80%+
  const getDisplayState = () => {
    if (session.watched) return { label: 'Watched', variant: 'success' as const };
    if (session.state === 'playing') return { label: 'Playing', variant: 'success' as const };
    if (session.state === 'paused') return { label: 'Paused', variant: 'warning' as const };
    if (session.state === 'stopped') return { label: 'Stopped', variant: 'secondary' as const };
    return { label: session.state || 'Unknown', variant: 'secondary' as const };
  };
  const displayState = getDisplayState();

  return (
    <Pressable onPress={onPress} className="border-border border-b py-3 active:opacity-70">
      <View className="flex-row">
        {/* Poster */}
        <View className="bg-surface mr-3 h-14 w-10 overflow-hidden rounded-md">
          {posterUrl ? (
            <Image
              source={{ uri: posterUrl }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="cover"
            />
          ) : (
            <View className="h-full w-full items-center justify-center">
              <MediaIcon size={18} color={colors.text.muted.dark} />
            </View>
          )}
        </View>

        {/* Content */}
        <View className="flex-1">
          <View className="mb-1 flex-row items-start justify-between">
            <View className="mr-2 flex-1">
              <Text className="text-sm font-medium" numberOfLines={1}>
                {session.mediaTitle}
              </Text>
              <Text className="text-muted-foreground text-xs capitalize">{session.mediaType}</Text>
            </View>
            <Badge variant={displayState.variant}>{displayState.label}</Badge>
          </View>
          <View className="mt-1 flex-row items-center gap-4">
            <View className="flex-row items-center gap-1">
              <Clock size={12} color={colors.text.muted.dark} />
              <Text className="text-muted-foreground text-xs">
                {formatDuration(session.durationMs)}
              </Text>
            </View>
            <View className="flex-row items-center gap-1">
              <Tv size={12} color={colors.text.muted.dark} />
              <Text className="text-muted-foreground text-xs">{session.platform || 'Unknown'}</Text>
            </View>
            {locationText && (
              <View className="flex-row items-center gap-1">
                <Globe size={12} color={colors.text.muted.dark} />
                <Text className="text-muted-foreground text-xs">{locationText}</Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

function ViolationCard({
  violation,
  onAcknowledge,
}: {
  violation: ViolationWithDetails;
  onAcknowledge: () => void;
}) {
  const ruleType = violation.rule?.type as RuleType | undefined;
  const ruleName = ruleType ? RULE_DISPLAY_NAMES[ruleType] : violation.rule?.name || 'Unknown Rule';
  const IconComponent = ruleType ? ruleIcons[ruleType] : AlertTriangle;
  const timeAgo = safeFormatDistanceToNow(violation.createdAt);

  return (
    <View className="border-border border-b py-3">
      <View className="mb-2 flex-row items-start justify-between">
        <View className="flex-1 flex-row items-center gap-2">
          <View className="bg-surface h-7 w-7 items-center justify-center rounded-md">
            <IconComponent size={14} color={ACCENT_COLOR} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-medium">{ruleName}</Text>
            <Text className="text-muted-foreground text-xs">{timeAgo}</Text>
          </View>
        </View>
        <SeverityBadge severity={violation.severity} />
      </View>
      {!violation.acknowledgedAt ? (
        <Pressable
          className="bg-primary/15 mt-2 flex-row items-center justify-center gap-1.5 rounded-md py-2 active:opacity-70"
          onPress={onAcknowledge}
        >
          <Check size={14} color={ACCENT_COLOR} />
          <Text className="text-primary text-xs font-semibold">Acknowledge</Text>
        </Pressable>
      ) : (
        <View className="mt-2 flex-row items-center gap-1.5">
          <Check size={14} color={colors.success} />
          <Text className="text-success text-xs">Acknowledged</Text>
        </View>
      )}
    </View>
  );
}

function TerminationCard({ termination }: { termination: TerminationLogWithDetails }) {
  const timeAgo = safeFormatDistanceToNow(termination.createdAt);
  const isManual = termination.trigger === 'manual';

  return (
    <View className="border-border border-b py-3">
      <View className="mb-2 flex-row items-start justify-between">
        <View className="flex-1 flex-row items-center gap-2">
          <View className="bg-surface h-7 w-7 items-center justify-center rounded-md">
            {isManual ? (
              <User size={14} color={ACCENT_COLOR} />
            ) : (
              <Bot size={14} color={ACCENT_COLOR} />
            )}
          </View>
          <View className="flex-1">
            <Text className="text-sm font-medium" numberOfLines={1}>
              {termination.mediaTitle ?? 'Unknown Media'}
            </Text>
            <Text className="text-muted-foreground text-xs capitalize">
              {termination.mediaType ?? 'unknown'} • {timeAgo}
            </Text>
          </View>
        </View>
        <Badge variant={isManual ? 'default' : 'secondary'}>{isManual ? 'Manual' : 'Rule'}</Badge>
      </View>
      <View className="ml-9">
        <Text className="text-muted-foreground text-xs">
          {isManual
            ? `By @${termination.triggeredByUsername ?? 'Unknown'}`
            : (termination.ruleName ?? 'Unknown rule')}
        </Text>
        {termination.reason && (
          <Text className="text-muted-foreground mt-1 text-xs" numberOfLines={2}>
            Reason: {termination.reason}
          </Text>
        )}
        <View className="mt-1 flex-row items-center gap-1">
          {termination.success ? (
            <>
              <Check size={12} color={colors.success} />
              <Text className="text-success text-xs">Success</Text>
            </>
          ) : (
            <>
              <XCircle size={12} color={colors.error} />
              <Text className="text-destructive text-xs">Failed</Text>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

export default function UserDetailScreen() {
  const { t } = useTranslation(['mobile', 'common', 'pages', 'nav']);
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { selectedServerId } = useMediaServer();
  const { isTablet, select } = useResponsive();
  const serverUrl = getServerUrl();

  // Responsive values
  const horizontalPadding = select({ base: spacing.md, md: spacing.lg, lg: spacing.xl });
  const avatarSize = isTablet ? 80 : 64;

  // Fetch user detail - query keys include selectedServerId for cache isolation
  const {
    data: user,
    isLoading: userLoading,
    refetch: refetchUser,
    isRefetching: userRefetching,
  } = useQuery({
    queryKey: ['user', id, selectedServerId],
    queryFn: () => api.users.get(id),
    enabled: !!id,
  });

  // Update header title with display name (identity name or username)
  useEffect(() => {
    if (user) {
      const displayName = user.identityName ?? user.username;
      navigation.setOptions({ title: displayName });
    }
  }, [user?.identityName, user?.username, navigation]);

  // Fetch user sessions
  const {
    data: sessionsData,
    isLoading: sessionsLoading,
    fetchNextPage: fetchMoreSessions,
    hasNextPage: hasMoreSessions,
    isFetchingNextPage: fetchingMoreSessions,
  } = useInfiniteQuery({
    queryKey: ['user', id, 'sessions', selectedServerId],
    queryFn: ({ pageParam }) => api.users.sessions(id, { page: pageParam, pageSize: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (lastPage: { page: number; totalPages: number }) => {
      if (lastPage.page < lastPage.totalPages) {
        return lastPage.page + 1;
      }
      return undefined;
    },
    enabled: !!id,
  });

  // Fetch user violations
  const {
    data: violationsData,
    isLoading: violationsLoading,
    fetchNextPage: fetchMoreViolations,
    hasNextPage: hasMoreViolations,
    isFetchingNextPage: fetchingMoreViolations,
  } = useInfiniteQuery({
    queryKey: ['violations', { userId: id }, selectedServerId],
    queryFn: ({ pageParam }) =>
      api.violations.list({ userId: id, page: pageParam, pageSize: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (lastPage: { page: number; totalPages: number }) => {
      if (lastPage.page < lastPage.totalPages) {
        return lastPage.page + 1;
      }
      return undefined;
    },
    enabled: !!id,
  });

  // Fetch user locations
  const { data: locations, isLoading: locationsLoading } = useQuery({
    queryKey: ['user', id, 'locations', selectedServerId],
    queryFn: () => api.users.locations(id),
    enabled: !!id,
  });

  // Fetch user devices
  const { data: devices, isLoading: devicesLoading } = useQuery({
    queryKey: ['user', id, 'devices', selectedServerId],
    queryFn: () => api.users.devices(id),
    enabled: !!id,
  });

  // Fetch user terminations
  const {
    data: terminationsData,
    isLoading: terminationsLoading,
    fetchNextPage: fetchMoreTerminations,
    hasNextPage: hasMoreTerminations,
    isFetchingNextPage: fetchingMoreTerminations,
  } = useInfiniteQuery({
    queryKey: ['user', id, 'terminations', selectedServerId],
    queryFn: ({ pageParam }) =>
      api.users.terminations(id, { page: pageParam, pageSize: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (lastPage: { page: number; totalPages: number }) => {
      if (lastPage.page < lastPage.totalPages) {
        return lastPage.page + 1;
      }
      return undefined;
    },
    enabled: !!id,
  });

  // Acknowledge mutation
  const acknowledgeMutation = useMutation({
    mutationFn: api.violations.acknowledge,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['violations', { userId: id }, selectedServerId],
      });
    },
  });

  const sessions = sessionsData?.pages.flatMap((page) => page.data) || [];
  const violations = violationsData?.pages.flatMap((page) => page.data) || [];
  const terminations = terminationsData?.pages.flatMap((page) => page.data) || [];
  const totalSessions = sessionsData?.pages[0]?.total || 0;
  const totalViolations = violationsData?.pages[0]?.total || 0;
  const totalTerminations = terminationsData?.pages[0]?.total || 0;

  const handleRefresh = () => {
    void refetchUser();
    void queryClient.invalidateQueries({ queryKey: ['user', id, 'sessions', selectedServerId] });
    void queryClient.invalidateQueries({
      queryKey: ['violations', { userId: id }, selectedServerId],
    });
    void queryClient.invalidateQueries({ queryKey: ['user', id, 'locations', selectedServerId] });
    void queryClient.invalidateQueries({ queryKey: ['user', id, 'devices', selectedServerId] });
    void queryClient.invalidateQueries({
      queryKey: ['user', id, 'terminations', selectedServerId],
    });
  };

  const handleSessionPress = (session: Session) => {
    router.push(`/session/${session.id}` as never);
  };

  if (userLoading) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.background.dark }}
        edges={['left', 'right', 'bottom']}
      >
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={ACCENT_COLOR} />
        </View>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.background.dark }}
        edges={['left', 'right', 'bottom']}
      >
        <View className="flex-1 items-center justify-center px-8">
          <View className="bg-card border-border mb-4 h-20 w-20 items-center justify-center rounded-full border">
            <User size={32} color={colors.text.muted.dark} />
          </View>
          <Text className="mb-1 text-center text-lg font-semibold">
            {t('pages:userDetail.userNotFound')}
          </Text>
          <Text className="text-muted-foreground text-center text-sm">
            {t('mobile:userDetail.userMayBeRemoved')}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background.dark }}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          paddingTop: spacing.sm,
          paddingBottom: spacing.xl,
        }}
        refreshControl={
          <RefreshControl
            refreshing={userRefetching}
            onRefresh={handleRefresh}
            tintColor={ACCENT_COLOR}
          />
        }
      >
        {/* User Info Card */}
        <Card className="mb-4">
          <View className="flex-row items-start gap-4">
            <UserAvatar
              thumbUrl={user.thumbUrl}
              serverId={user.serverId}
              username={user.username}
              size={avatarSize}
            />
            <View className="flex-1">
              <View className="mb-1 flex-row items-center gap-2">
                <Text className="text-xl font-bold">{user.identityName ?? user.username}</Text>
                {user.role === 'owner' && <Crown size={18} color={colors.warning} />}
              </View>
              {/* Show @username if identity name is displayed */}
              {user.identityName && user.identityName !== user.username && (
                <Text className="text-muted-foreground text-sm">@{user.username}</Text>
              )}
              {user.email && (
                <Text className="text-muted-foreground mb-2 text-sm">{user.email}</Text>
              )}
              <TrustScoreBadge score={user.trustScore} showLabel />
            </View>
          </View>
        </Card>

        {/* Stats Grid - single row on tablet, 2 rows on phone */}
        {isTablet ? (
          <View className="mb-4 flex-row gap-3">
            <StatCard icon={Play} label={t('pages:userDetail.sessions')} value={totalSessions} />
            <StatCard
              icon={AlertTriangle}
              label={t('pages:userDetail.violations')}
              value={totalViolations}
            />
            <StatCard
              icon={Clock}
              label="Joined"
              value={safeFormatDate(user.createdAt, 'MMM d, yyyy')}
            />
            <StatCard
              icon={Globe}
              label={t('pages:userDetail.locations')}
              value={locations?.length || 0}
            />
          </View>
        ) : (
          <>
            <View className="mb-4 flex-row gap-3">
              <StatCard icon={Play} label={t('pages:userDetail.sessions')} value={totalSessions} />
              <StatCard
                icon={AlertTriangle}
                label={t('pages:userDetail.violations')}
                value={totalViolations}
              />
            </View>
            <View className="mb-4 flex-row gap-3">
              <StatCard
                icon={Clock}
                label="Joined"
                value={safeFormatDate(user.createdAt, 'MMM d, yyyy')}
              />
              <StatCard
                icon={Globe}
                label={t('pages:userDetail.locations')}
                value={locations?.length || 0}
              />
            </View>
          </>
        )}

        {/* Locations & Devices - side by side on tablet */}
        <View
          style={{
            flexDirection: isTablet ? 'row' : 'column',
            gap: isTablet ? spacing.md : 0,
            marginBottom: spacing.md,
          }}
        >
          {/* Locations */}
          <Card style={{ flex: isTablet ? 1 : undefined, marginBottom: isTablet ? 0 : spacing.md }}>
            <CardHeader>
              <View className="flex-row items-center justify-between">
                <CardTitle>{t('pages:userDetail.locations')}</CardTitle>
                <Text className="text-muted-foreground text-xs">
                  {locations?.length || 0} {locations?.length === 1 ? 'location' : 'locations'}
                </Text>
              </View>
            </CardHeader>
            <CardContent>
              {locationsLoading ? (
                <ActivityIndicator size="small" color={ACCENT_COLOR} />
              ) : locations && locations.length > 0 ? (
                locations
                  .slice(0, 5)
                  .map((location, index) => (
                    <LocationCard
                      key={`${location.city}-${location.country}-${index}`}
                      location={location}
                    />
                  ))
              ) : (
                <Text className="text-muted-foreground py-4 text-center text-sm">
                  {t('mobile:userDetail.noLocationsRecorded')}
                </Text>
              )}
              {locations && locations.length > 5 && (
                <View className="items-center pt-3">
                  <Text className="text-muted-foreground text-xs">
                    +{locations.length - 5} more locations
                  </Text>
                </View>
              )}
            </CardContent>
          </Card>

          {/* Devices */}
          <Card style={{ flex: isTablet ? 1 : undefined }}>
            <CardHeader>
              <View className="flex-row items-center justify-between">
                <CardTitle>{t('nav:devices')}</CardTitle>
                <Text className="text-muted-foreground text-xs">
                  {devices?.length || 0} {devices?.length === 1 ? 'device' : 'devices'}
                </Text>
              </View>
            </CardHeader>
            <CardContent>
              {devicesLoading ? (
                <ActivityIndicator size="small" color={ACCENT_COLOR} />
              ) : devices && devices.length > 0 ? (
                devices
                  .slice(0, 5)
                  .map((device, index) => (
                    <DeviceCard key={device.deviceId || index} device={device} />
                  ))
              ) : (
                <Text className="text-muted-foreground py-4 text-center text-sm">
                  {t('mobile:userDetail.noDevicesRecorded')}
                </Text>
              )}
              {devices && devices.length > 5 && (
                <View className="items-center pt-3">
                  <Text className="text-muted-foreground text-xs">
                    +{devices.length - 5} more devices
                  </Text>
                </View>
              )}
            </CardContent>
          </Card>
        </View>

        {/* Recent Sessions */}
        <Card className="mb-4">
          <CardHeader>
            <View className="flex-row items-center justify-between">
              <CardTitle>{t('common:labels.recentSessions')}</CardTitle>
              <Text className="text-muted-foreground text-xs">{totalSessions} total</Text>
            </View>
          </CardHeader>
          <CardContent>
            {sessionsLoading ? (
              <ActivityIndicator size="small" color={ACCENT_COLOR} />
            ) : sessions.length > 0 ? (
              <>
                {sessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    serverUrl={serverUrl}
                    onPress={() => handleSessionPress(session)}
                  />
                ))}
                {hasMoreSessions && (
                  <Pressable
                    className="items-center py-3 active:opacity-70"
                    onPress={() => void fetchMoreSessions()}
                    disabled={fetchingMoreSessions}
                  >
                    {fetchingMoreSessions ? (
                      <ActivityIndicator size="small" color={ACCENT_COLOR} />
                    ) : (
                      <View className="flex-row items-center gap-1">
                        <Text className="text-primary text-sm font-medium">
                          {t('common:labels.loadMore')}
                        </Text>
                        <ChevronRight size={16} color={ACCENT_COLOR} />
                      </View>
                    )}
                  </Pressable>
                )}
              </>
            ) : (
              <Text className="text-muted-foreground py-4 text-center text-sm">
                {t('common:empty.noSessionsFound')}
              </Text>
            )}
          </CardContent>
        </Card>

        {/* Violations */}
        <Card className="mb-8">
          <CardHeader>
            <View className="flex-row items-center justify-between">
              <CardTitle>{t('pages:userDetail.violations')}</CardTitle>
              <Text className="text-muted-foreground text-xs">{totalViolations} total</Text>
            </View>
          </CardHeader>
          <CardContent>
            {violationsLoading ? (
              <ActivityIndicator size="small" color={ACCENT_COLOR} />
            ) : violations.length > 0 ? (
              <>
                {violations.map((violation) => (
                  <ViolationCard
                    key={violation.id}
                    violation={violation}
                    onAcknowledge={() => acknowledgeMutation.mutate(violation.id)}
                  />
                ))}
                {hasMoreViolations && (
                  <Pressable
                    className="items-center py-3 active:opacity-70"
                    onPress={() => void fetchMoreViolations()}
                    disabled={fetchingMoreViolations}
                  >
                    {fetchingMoreViolations ? (
                      <ActivityIndicator size="small" color={ACCENT_COLOR} />
                    ) : (
                      <View className="flex-row items-center gap-1">
                        <Text className="text-primary text-sm font-medium">
                          {t('common:labels.loadMore')}
                        </Text>
                        <ChevronRight size={16} color={ACCENT_COLOR} />
                      </View>
                    )}
                  </Pressable>
                )}
              </>
            ) : (
              <View className="items-center py-4">
                <View className="bg-success/10 mb-2 h-12 w-12 items-center justify-center rounded-full">
                  <Check size={24} color={colors.success} />
                </View>
                <Text className="text-muted-foreground text-sm">
                  {t('mobile:userDetail.noViolations')}
                </Text>
              </View>
            )}
          </CardContent>
        </Card>

        {/* Termination History */}
        <Card className="mb-8">
          <CardHeader>
            <View className="flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <XCircle size={18} color={colors.text.primary.dark} />
                <CardTitle>{t('pages:userDetail.terminationHistory')}</CardTitle>
              </View>
              <Text className="text-muted-foreground text-xs">{totalTerminations} total</Text>
            </View>
          </CardHeader>
          <CardContent>
            {terminationsLoading ? (
              <ActivityIndicator size="small" color={ACCENT_COLOR} />
            ) : terminations.length > 0 ? (
              <>
                {terminations.map((termination) => (
                  <TerminationCard key={termination.id} termination={termination} />
                ))}
                {hasMoreTerminations && (
                  <Pressable
                    className="items-center py-3 active:opacity-70"
                    onPress={() => void fetchMoreTerminations()}
                    disabled={fetchingMoreTerminations}
                  >
                    {fetchingMoreTerminations ? (
                      <ActivityIndicator size="small" color={ACCENT_COLOR} />
                    ) : (
                      <View className="flex-row items-center gap-1">
                        <Text className="text-primary text-sm font-medium">
                          {t('common:labels.loadMore')}
                        </Text>
                        <ChevronRight size={16} color={ACCENT_COLOR} />
                      </View>
                    )}
                  </Pressable>
                )}
              </>
            ) : (
              <Text className="text-muted-foreground py-4 text-center text-sm">
                {t('mobile:userDetail.noTerminations')}
              </Text>
            )}
          </CardContent>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}
