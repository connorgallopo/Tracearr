/**
 * Dashboard tab - overview of streaming activity
 * Supports multi-server selection with colored cards and map markers
 *
 * Responsive layout:
 * - Phone: Single column, stacked cards
 * - Tablet (md+): 2-column grid for Now Playing, larger map
 * - Large tablet (lg+): 3-column grid for Now Playing
 */
import { useMemo } from 'react';
import { View, ScrollView, RefreshControl, Platform } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { useServerStatistics } from '@/hooks/useServerStatistics';
import { useResponsive } from '@/hooks/useResponsive';
import { useUnacknowledgedAlertsCount } from '@/hooks';
import { StreamMap } from '@/components/map/StreamMap';
import { NowPlayingCard } from '@/components/sessions';
import { ServerResourceCard } from '@/components/server/ServerResourceCard';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { colors, spacing, ACCENT_COLOR } from '@/lib/theme';
import { useTranslation } from '@tracearr/translations/mobile';

/**
 * Compact stat pill for dashboard summary bar
 */
function StatPill({
  icon,
  value,
  unit,
  color = colors.text.secondary.dark,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string | number;
  unit?: string;
  color?: string;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.card.dark,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 20,
        gap: 6,
      }}
    >
      <Ionicons name={icon} size={14} color={color} />
      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text.primary.dark }}>
        {value}
      </Text>
      {unit && <Text style={{ fontSize: 11, color: colors.text.muted.dark }}>{unit}</Text>}
    </View>
  );
}

export default function DashboardScreen() {
  const { t } = useTranslation(['mobile', 'pages', 'common']);
  const router = useRouter();
  const navigation = useNavigation();
  const { servers, selectedServerIds, selectedServerId, selectedServer, isMultiServer } =
    useMediaServer();
  const { isTablet, columns, select } = useResponsive();
  const { hasAlerts, displayCount } = useUnacknowledgedAlertsCount();

  const serverColorMap = useMemo(
    () => new Map(servers.map((s) => [s.id, s.color ?? null])),
    [servers]
  );

  const serverOrderMap = useMemo(
    () => new Map(servers.map((s) => [s.id, s.displayOrder ?? 0])),
    [servers]
  );

  const sortedServerIds = useMemo(() => [...selectedServerIds].sort(), [selectedServerIds]);

  const {
    data: stats,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: ['dashboard', 'stats', sortedServerIds],
    queryFn: () => api.stats.dashboard(selectedServerIds),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });

  const { data: activeSessions } = useQuery({
    queryKey: ['sessions', 'active', sortedServerIds],
    queryFn: () => api.sessions.active(selectedServerIds),
    staleTime: 1000 * 5,
    refetchInterval: 1000 * 30,
  });

  const sortedSessions = useMemo(() => {
    if (!activeSessions) return undefined;
    return [...activeSessions].sort((a, b) => {
      const orderA = serverOrderMap.get(a.server.id) ?? 0;
      const orderB = serverOrderMap.get(b.server.id) ?? 0;
      return orderA - orderB;
    });
  }, [activeSessions, serverOrderMap]);

  // Only show server resources for single Plex server
  const isPlexServer = !isMultiServer && selectedServer?.type === 'plex';

  const {
    latest: serverResources,
    isLoadingData: resourcesLoading,
    error: resourcesError,
  } = useServerStatistics(selectedServerId ?? undefined, isPlexServer);

  const horizontalPadding = select({ base: spacing.md, md: spacing.lg, lg: spacing.xl });
  const mapHeight = select({ base: 200, md: 280, lg: 320 });
  const nowPlayingColumns = columns.cards;

  return (
    <>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerClassName="pb-8"
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={ACCENT_COLOR} />
        }
      >
        {/* Today's Stats Bar */}
        {stats && (
          <View style={{ paddingHorizontal: horizontalPadding, paddingTop: 12, paddingBottom: 8 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: isTablet ? 12 : 8,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  color: colors.text.muted.dark,
                  fontWeight: '600',
                  marginRight: 2,
                }}
              >
                {t('mobile:dashboard.today')}
              </Text>
              <StatPill
                icon="play-circle-outline"
                value={stats.todayPlays}
                unit={t('pages:dashboard.plays')}
              />
              <StatPill
                icon="time-outline"
                value={stats.watchTimeHours}
                unit={t('mobile:dashboard.hrs')}
              />
              {isTablet && (
                <StatPill
                  icon="people-outline"
                  value={stats.activeUsersToday}
                  unit={t('pages:dashboard.activeUsers')}
                />
              )}
              <StatPill
                icon="warning-outline"
                value={stats.alertsLast24h}
                unit={t('pages:dashboard.alerts')}
                color={stats.alertsLast24h > 0 ? colors.warning : colors.text.muted.dark}
              />
            </View>
          </View>
        )}

        {/* Now Playing - Active Streams */}
        <View style={{ marginBottom: spacing.md, paddingHorizontal: horizontalPadding }}>
          <View className="mb-3 flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Ionicons name="tv-outline" size={18} color={ACCENT_COLOR} />
              <Text className="text-muted-foreground text-sm font-semibold tracking-wide uppercase">
                {t('pages:dashboard.nowPlaying')}
              </Text>
            </View>
            {sortedSessions && sortedSessions.length > 0 && (
              <View
                style={{
                  backgroundColor: 'rgba(24, 209, 231, 0.15)',
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderRadius: 12,
                }}
              >
                <Text style={{ color: ACCENT_COLOR, fontSize: 12, fontWeight: '600' }}>
                  {t('common:count.stream', { count: sortedSessions.length })}
                </Text>
              </View>
            )}
          </View>
          {sortedSessions && sortedSessions.length > 0 ? (
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                marginHorizontal: isTablet ? -spacing.sm / 2 : 0,
              }}
            >
              {sortedSessions.map((session) => (
                <View
                  key={session.id}
                  style={{
                    width: isTablet ? `${100 / nowPlayingColumns}%` : '100%',
                    paddingHorizontal: isTablet ? spacing.sm / 2 : 0,
                  }}
                >
                  <NowPlayingCard
                    session={session}
                    onPress={() => router.push(`/session/${session.id}` as never)}
                    isMultiServer={isMultiServer}
                    serverColor={serverColorMap.get(session.server.id)}
                  />
                </View>
              ))}
            </View>
          ) : (
            <Card className="py-8">
              <View className="items-center">
                <View
                  style={{
                    backgroundColor: colors.surface.dark,
                    padding: 16,
                    borderRadius: 999,
                    marginBottom: 12,
                  }}
                >
                  <Ionicons name="tv-outline" size={32} color={colors.text.muted.dark} />
                </View>
                <Text className="text-base font-semibold">
                  {t('pages:dashboard.noActiveStreams')}
                </Text>
                <Text className="text-muted-foreground mt-1 text-sm">
                  {t('pages:dashboard.streamsAppearHere')}
                </Text>
              </View>
            </Card>
          )}
        </View>

        {/* Stream Map - only show when there are active streams */}
        {sortedSessions && sortedSessions.length > 0 && (
          <View style={{ marginBottom: spacing.md, paddingHorizontal: horizontalPadding }}>
            <View className="mb-3 flex-row items-center gap-2">
              <Ionicons name="location-outline" size={18} color={ACCENT_COLOR} />
              <Text className="text-muted-foreground text-sm font-semibold tracking-wide uppercase">
                {t('pages:dashboard.streamLocations')}
              </Text>
            </View>
            <StreamMap
              sessions={sortedSessions}
              height={mapHeight}
              serverColorMap={isMultiServer ? serverColorMap : undefined}
            />
          </View>
        )}

        {/* Server Resources - only show for single Plex server */}
        {isPlexServer && (
          <View style={{ paddingHorizontal: horizontalPadding }}>
            <View className="mb-3 flex-row items-center gap-2">
              <Ionicons name="server-outline" size={18} color={ACCENT_COLOR} />
              <Text className="text-muted-foreground text-sm font-semibold tracking-wide uppercase">
                {t('pages:dashboard.serverResources')}
              </Text>
            </View>
            <ServerResourceCard
              latest={serverResources}
              isLoading={resourcesLoading}
              error={resourcesError}
            />
          </View>
        )}
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
