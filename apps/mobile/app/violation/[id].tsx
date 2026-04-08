/**
 * Violation Detail Screen
 * Shows comprehensive violation information with stream comparison
 *
 * Responsive layout:
 * - Phone: Single column, compact layout
 * - Tablet (md+): Responsive padding, 2-column stream comparison grid
 */
import { useMemo } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient, useMutation, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow, format } from 'date-fns';
import {
  AlertTriangle,
  Check,
  X,
  Clock,
  Film,
  Tv,
  Music,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react-native';
import { api } from '@/lib/api';
import { useResponsive } from '@/hooks/useResponsive';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { UserAvatar } from '@/components/ui/user-avatar';
import { ActionResultsList } from '@/components/violations/ActionResultsList';
import { colors, spacing, ACCENT_COLOR } from '@/lib/theme';
import {
  getViolationDescription,
  collectViolationSessions,
  RULE_DISPLAY_NAMES,
} from '@tracearr/shared';
import type { ViolationWithDetails, ViolationSessionInfo } from '@tracearr/shared';
import { useTranslation } from '@tracearr/translations/mobile';

import { ruleIcons } from '@/lib/violations';

import { SeverityBadge } from '@/components/violations/SeverityBadge';

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

interface StreamCardProps {
  session: ViolationSessionInfo;
  index: number;
  isTriggering: boolean;
  userHistory?: ViolationWithDetails['userHistory'];
}

function StreamCard({ session, index, isTriggering, userHistory }: StreamCardProps) {
  const MediaIcon = getMediaIcon(session.mediaType);

  // Check if values are new (not seen before)
  const isNewIP = userHistory?.previousIPs
    ? !userHistory.previousIPs.includes(session.ipAddress)
    : false;
  const isNewDevice = userHistory?.previousDevices
    ? !userHistory.previousDevices.includes(session.deviceId || session.device || '')
    : false;
  const isNewLocation = userHistory?.previousLocations
    ? !userHistory.previousLocations.some(
        (loc) => loc.city === session.geoCity && loc.country === session.geoCountry
      )
    : false;

  const locationText = [session.geoCity, session.geoRegion, session.geoCountry]
    .filter(Boolean)
    .join(', ');

  return (
    <Card
      className={isTriggering ? 'bg-surface/50' : ''}
      style={isTriggering ? { borderColor: `${ACCENT_COLOR}80` } : undefined}
    >
      {/* Header */}
      <View className="mb-3">
        <View className="mb-1 flex-row items-center gap-2">
          <Text className="text-muted-foreground text-xs font-medium">
            {isTriggering ? 'Triggering Stream' : `Stream #${index + 1}`}
          </Text>
          {isTriggering && (
            <View className="bg-primary/20 rounded px-1.5 py-0.5">
              <Text className="text-primary text-xs">Primary</Text>
            </View>
          )}
        </View>
        <View className="flex-row items-center gap-2">
          <View className="bg-surface h-8 w-8 items-center justify-center rounded">
            <MediaIcon size={14} color={colors.text.muted.dark} />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-medium" numberOfLines={1}>
              {session.mediaTitle}
              {session.grandparentTitle && (
                <Text className="text-muted-foreground"> - {session.grandparentTitle}</Text>
              )}
            </Text>
            <Text className="text-muted-foreground text-xs capitalize">
              {session.mediaType}
              {session.quality && ` - ${session.quality}`}
            </Text>
          </View>
        </View>
      </View>

      {/* Details Grid */}
      <View className="gap-3">
        {/* IP Address */}
        <View className="flex-row items-start justify-between">
          <View className="flex-1">
            <View className="mb-1 flex-row items-center gap-1.5">
              <Text className="text-muted-foreground text-xs">IP Address</Text>
              {isNewIP ? (
                <AlertCircle size={12} color={colors.warning} />
              ) : (
                <CheckCircle2 size={12} color={colors.success} />
              )}
            </View>
            <Text className="font-mono text-sm">{session.ipAddress}</Text>
            {isNewIP && <Text className="text-warning mt-0.5 text-xs">First time seen</Text>}
          </View>
        </View>

        {/* Location */}
        {locationText && (
          <View>
            <View className="mb-1 flex-row items-center gap-1.5">
              <Text className="text-muted-foreground text-xs">Location</Text>
              {isNewLocation ? (
                <AlertCircle size={12} color={colors.error} />
              ) : (
                <CheckCircle2 size={12} color={colors.success} />
              )}
            </View>
            <Text className="text-sm">{locationText}</Text>
            {isNewLocation && (
              <Text className="text-destructive mt-0.5 text-xs">First time seen</Text>
            )}
          </View>
        )}

        {/* Device */}
        {(session.device || session.deviceId) && (
          <View>
            <View className="mb-1 flex-row items-center gap-1.5">
              <Text className="text-muted-foreground text-xs">Device</Text>
              {isNewDevice ? (
                <AlertCircle size={12} color={colors.orange.core} />
              ) : (
                <CheckCircle2 size={12} color={colors.success} />
              )}
            </View>
            <Text className="text-sm">
              {session.device || session.deviceId}
              {session.playerName && ` (${session.playerName})`}
            </Text>
            {isNewDevice && (
              <Text style={{ color: colors.orange.core }} className="mt-0.5 text-xs">
                First time seen
              </Text>
            )}
          </View>
        )}

        {/* Platform */}
        {session.platform && (
          <View>
            <Text className="text-muted-foreground mb-1 text-xs">Platform</Text>
            <Text className="text-sm">
              {session.platform}
              {session.product && ` - ${session.product}`}
            </Text>
          </View>
        )}

        {/* Started At */}
        <Text className="text-muted-foreground text-xs">
          Started {formatDistanceToNow(new Date(session.startedAt), { addSuffix: true })}
        </Text>
      </View>
    </Card>
  );
}

/**
 * Search all violation caches for a specific violation by ID.
 * Uses getQueriesData to match any cache key starting with ['violations'],
 * which covers the alerts list (with filters), user detail, etc.
 */
function findViolationInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  violationId: string
): ViolationWithDetails | undefined {
  // Search paginated caches (alerts list uses { pages: [...] } shape)
  const allCaches = queryClient.getQueriesData<{
    pages?: { data: ViolationWithDetails[] }[];
    data?: ViolationWithDetails[];
  }>({ queryKey: ['violations'] });

  for (const [_key, data] of allCaches) {
    if (!data) continue;
    // Paginated (infinite query) shape
    if (data.pages) {
      for (const page of data.pages) {
        const found = page.data?.find((v) => v.id === violationId);
        if (found) return found;
      }
    }
    // Flat list shape
    if (data.data) {
      const found = data.data.find((v) => v.id === violationId);
      if (found) return found;
    }
  }
  return undefined;
}

export default function ViolationDetailScreen() {
  const { t } = useTranslation(['mobile', 'common', 'pages', 'nav']);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isTablet, select } = useResponsive();

  // Responsive values
  const horizontalPadding = select({ base: spacing.md, md: spacing.lg, lg: spacing.xl });

  // Get settings for unit system
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
    staleTime: 1000 * 60 * 5,
  });
  const unitSystem = settings?.unitSystem ?? 'metric';

  // Try to find the violation in any existing cache
  const cachedViolation = useMemo(
    () => (id ? findViolationInCache(queryClient, id) : undefined),
    [queryClient, id]
  );

  // Fetch from API with cache as initial data
  const {
    data: violation,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['violations', 'detail', id],
    queryFn: () => api.violations.get(id),
    initialData: cachedViolation,
    staleTime: cachedViolation ? 1000 * 60 : 0,
    enabled: !!id,
  });

  // Update header title
  const ruleType = violation?.rule?.type;
  const ruleName = ruleType ? RULE_DISPLAY_NAMES[ruleType] : 'Violation';

  // Acknowledge mutation
  const acknowledgeMutation = useMutation({
    mutationFn: api.violations.acknowledge,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      router.back();
    },
  });

  // Dismiss mutation
  const dismissMutation = useMutation({
    mutationFn: api.violations.dismiss,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      router.back();
    },
  });

  const handleAcknowledge = () => {
    if (!violation) return;
    acknowledgeMutation.mutate(violation.id);
  };

  const handleDismiss = () => {
    if (!violation) return;
    Alert.alert(
      t('pages:violations.dismissViolation'),
      t('pages:violations.dismissViolationConfirm'),
      [
        { text: t('common:actions.cancel'), style: 'cancel' },
        {
          text: t('common:actions.dismiss'),
          style: 'destructive',
          onPress: () => dismissMutation.mutate(violation.id),
        },
      ]
    );
  };

  const handleUserPress = () => {
    if (violation?.user?.id) {
      router.push(`/user/${violation.user.id}` as never);
    }
  };

  // Collect all sessions for comparison (skip for inactivity violations)
  const allSessions = useMemo(
    () =>
      violation && violation.rule?.type !== 'account_inactivity'
        ? collectViolationSessions(violation)
        : [],
    [violation]
  );

  // Analysis stats
  const analysis = useMemo(() => {
    if (allSessions.length <= 1) return null;
    return {
      uniqueIPs: new Set(allSessions.map((s) => s.ipAddress)).size,
      uniqueDevices: new Set(
        allSessions.map((s) => s.deviceId || s.device).filter((d): d is string => !!d)
      ).size,
      uniqueLocations: new Set(
        allSessions.map((s) => `${s.geoCity || ''}-${s.geoCountry || ''}`).filter((l) => l !== '-')
      ).size,
    };
  }, [allSessions]);

  // Loading state (only shown when no cached data)
  if (isLoading && !violation) {
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

  if (!violation || isError) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.background.dark }}
        edges={['left', 'right', 'bottom']}
      >
        <View className="flex-1 items-center justify-center px-8">
          <View className="bg-card border-border mb-4 h-20 w-20 items-center justify-center rounded-full border">
            <AlertTriangle size={32} color={colors.text.muted.dark} />
          </View>
          <Text className="mb-1 text-center text-xl font-semibold">
            {t('pages:violations.detail.notFound')}
          </Text>
          <Text className="text-muted-foreground text-center text-sm">
            {t('mobile:violation.violationNotFoundDesc')}
          </Text>
          <Pressable className="bg-primary mt-6 rounded-lg px-6 py-3" onPress={() => router.back()}>
            <Text className="font-semibold text-white">{t('common:actions.back')}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const description = getViolationDescription(violation, unitSystem);
  const IconComponent = ruleType ? ruleIcons[ruleType] : AlertTriangle;
  const isPending = !violation.acknowledgedAt;

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
      >
        {/* User Info */}
        <Card className="mb-4">
          <Pressable className="flex-row items-center gap-4" onPress={handleUserPress}>
            <UserAvatar
              thumbUrl={violation.user?.thumbUrl}
              serverId={violation.user?.serverId}
              username={violation.user?.username || 'Unknown'}
              size={isTablet ? 64 : 56}
            />
            <View className="flex-1">
              <Text className="text-lg font-semibold">
                {violation.user?.identityName ?? violation.user?.username}
              </Text>
              {violation.user?.identityName &&
                violation.user.identityName !== violation.user.username && (
                  <Text className="text-muted-foreground text-sm">@{violation.user.username}</Text>
                )}
              {violation.server?.name && (
                <Text className="text-muted-foreground text-sm">{violation.server.name}</Text>
              )}
            </View>
            <SeverityBadge severity={violation.severity} />
          </Pressable>
        </Card>

        {/* Rule Info */}
        <Card className="mb-4">
          <View className="mb-3 flex-row items-center gap-3">
            <View className="bg-primary/15 h-10 w-10 items-center justify-center rounded-lg">
              <IconComponent size={20} color={ACCENT_COLOR} />
            </View>
            <View className="flex-1">
              <Text className="text-base font-semibold">{violation.rule?.name || ruleName}</Text>
              <Text className="text-muted-foreground text-sm capitalize">
                {ruleType?.replace(/_/g, ' ') || t('mobile:violation.customRule')}
              </Text>
            </View>
          </View>
          <Text className="text-secondary leading-6">{description}</Text>
        </Card>

        {/* Account Inactivity Details */}
        {ruleType === 'account_inactivity' && (
          <Card className="mb-4">
            <View className="mb-3 flex-row items-center gap-2">
              <Clock size={16} color={colors.text.muted.dark} />
              <Text className="text-muted-foreground text-sm font-semibold">
                {t('pages:violations.detail.inactivity')}
              </Text>
            </View>
            <View className="bg-surface rounded-lg p-4">
              <View className="flex-row gap-4">
                {/* Days Inactive */}
                <View className="flex-1">
                  <Text className="text-muted-foreground mb-1 text-xs">
                    {t('pages:violations.detail.daysInactive')}
                  </Text>
                  <Text className="text-2xl font-bold">
                    {(violation.data?.inactiveDays as number) ?? 'N/A'}
                  </Text>
                </View>
                {/* Threshold */}
                <View className="flex-1">
                  <Text className="text-muted-foreground mb-1 text-xs">
                    {t('pages:violations.detail.threshold')}
                  </Text>
                  <Text className="text-2xl font-bold">
                    {(violation.data?.thresholdDays as number) ?? 'N/A'}
                    <Text className="text-muted-foreground text-sm font-normal"> days</Text>
                  </Text>
                </View>
              </View>
              {/* Last Activity */}
              <View className="mt-4">
                <Text className="text-muted-foreground mb-1 text-xs">
                  {t('pages:violations.detail.lastActivity')}
                </Text>
                {violation.data?.neverActive ? (
                  <View className="flex-row items-center gap-1">
                    <AlertCircle size={14} color={colors.warning} />
                    <Text className="text-warning text-sm font-medium">
                      {t('pages:violations.detail.neverActive')}
                    </Text>
                  </View>
                ) : violation.data?.lastActivityAt ? (
                  <View>
                    <Text className="text-sm font-medium">
                      {format(new Date(violation.data.lastActivityAt as string), 'PPpp')}
                    </Text>
                    <Text className="text-muted-foreground text-xs">
                      {formatDistanceToNow(new Date(violation.data.lastActivityAt as string), {
                        addSuffix: true,
                      })}
                    </Text>
                  </View>
                ) : (
                  <Text className="text-muted-foreground text-sm">Unknown</Text>
                )}
              </View>
            </View>
          </Card>
        )}

        {/* Stream Comparison (not for inactivity violations) */}
        {allSessions.length > 0 && (
          <View className="mb-4">
            <View className="mb-3 flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <Film size={16} color={colors.text.muted.dark} />
                <Text className="text-muted-foreground text-sm font-semibold">
                  {t('mobile:violation.streamComparison')}
                </Text>
                {allSessions.length > 1 && (
                  <View className="bg-surface rounded px-2 py-0.5">
                    <Text className="text-muted-foreground text-xs">
                      {allSessions.length} streams
                    </Text>
                  </View>
                )}
              </View>
              {/* Analysis badges */}
              {analysis && (
                <View className="flex-row gap-1.5">
                  {analysis.uniqueIPs > 1 && (
                    <View className="bg-warning/20 rounded px-2 py-0.5">
                      <Text className="text-warning text-xs">{analysis.uniqueIPs} IPs</Text>
                    </View>
                  )}
                  {analysis.uniqueDevices > 1 && (
                    <View
                      style={{ backgroundColor: `${colors.orange.core}20` }}
                      className="rounded px-2 py-0.5"
                    >
                      <Text style={{ color: colors.orange.core }} className="text-xs">
                        {analysis.uniqueDevices} Devices
                      </Text>
                    </View>
                  )}
                  {analysis.uniqueLocations > 1 && (
                    <View className="bg-destructive/20 rounded px-2 py-0.5">
                      <Text className="text-destructive text-xs">
                        {analysis.uniqueLocations} Locations
                      </Text>
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* Stream cards */}
            <View style={{ gap: spacing.sm }}>
              {allSessions.map((session, idx) => (
                <StreamCard
                  key={session.id}
                  session={session}
                  index={idx}
                  isTriggering={idx === 0 && violation.session?.id === session.id}
                  userHistory={violation.userHistory}
                />
              ))}
            </View>
          </View>
        )}

        {/* Action Results (V2 Rules) */}
        {violation.actionResults && violation.actionResults.length > 0 && (
          <Card className="mb-4">
            <ActionResultsList results={violation.actionResults} />
          </Card>
        )}

        {/* Timestamps */}
        <Card className="mb-4">
          <View className="gap-3">
            <View className="flex-row items-center gap-2">
              <Clock size={16} color={colors.text.muted.dark} />
              <View className="flex-1">
                <Text className="text-muted-foreground text-xs">{t('common:labels.created')}</Text>
                <Text className="text-sm">
                  {formatDistanceToNow(new Date(violation.createdAt), { addSuffix: true })}
                </Text>
                <Text className="text-muted-foreground text-xs">
                  {format(new Date(violation.createdAt), 'PPpp')}
                </Text>
              </View>
            </View>
            {violation.acknowledgedAt && (
              <View className="flex-row items-center gap-2">
                <Check size={16} color={colors.success} />
                <View className="flex-1">
                  <Text className="text-success text-sm">
                    Acknowledged{' '}
                    {formatDistanceToNow(new Date(violation.acknowledgedAt), { addSuffix: true })}
                  </Text>
                </View>
              </View>
            )}
          </View>
        </Card>

        {/* Actions */}
        <View style={{ flexDirection: isTablet ? 'row' : 'column', gap: spacing.sm }}>
          {isPending && (
            <Pressable
              className="bg-primary flex-1 flex-row items-center justify-center gap-2 rounded-lg py-3.5"
              onPress={handleAcknowledge}
              disabled={acknowledgeMutation.isPending}
            >
              {acknowledgeMutation.isPending ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <>
                  <Check size={18} color="white" />
                  <Text className="font-semibold text-white">
                    {t('common:actions.acknowledge')}
                  </Text>
                </>
              )}
            </Pressable>
          )}
          <Pressable
            className="bg-destructive flex-1 flex-row items-center justify-center gap-2 rounded-lg py-3.5"
            onPress={handleDismiss}
            disabled={dismissMutation.isPending}
          >
            {dismissMutation.isPending ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <>
                <X size={18} color="white" />
                <Text className="font-semibold text-white">{t('common:actions.dismiss')}</Text>
              </>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
