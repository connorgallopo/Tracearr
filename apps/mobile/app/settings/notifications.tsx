/**
 * Notification Settings Screen
 * Per-device push notification configuration
 */
import { View, ScrollView, Switch, Pressable, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  ShieldAlert,
  Play,
  Square,
  Monitor,
  Smartphone,
  AlertTriangle,
  ServerCrash,
  ServerCog,
  Moon,
  Flame,
  MapPin,
  Users,
  Zap,
  Globe,
  type LucideIcon,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useAuthStateStore } from '@/lib/authStateStore';
import { colors, ACCENT_COLOR } from '@/lib/theme';
import type { NotificationPreferences } from '@tracearr/shared';
import { useTranslation } from '@tracearr/translations/mobile';

// Rule types for violation filtering with icons
const RULE_TYPES: { value: string; label: string; icon: LucideIcon }[] = [
  { value: 'impossible_travel', label: 'Impossible Travel', icon: MapPin },
  { value: 'simultaneous_locations', label: 'Simultaneous Locations', icon: Users },
  { value: 'device_velocity', label: 'Device Velocity', icon: Zap },
  { value: 'concurrent_streams', label: 'Concurrent Streams', icon: Monitor },
  { value: 'geo_restriction', label: 'Geo Restriction', icon: Globe },
];

// Severity levels for segmented control
const SEVERITY_OPTIONS: { value: string; label: string }[] = [
  { value: '1', label: 'All' },
  { value: '2', label: 'Warning+' },
  { value: '3', label: 'High Only' },
];

function Divider() {
  return <View className="bg-border ml-4 h-px" />;
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-6">
      <Text className="text-muted-foreground mb-2 text-sm font-semibold tracking-wide uppercase">
        {title}
      </Text>
      <Card className="overflow-hidden p-0">{children}</Card>
    </View>
  );
}

function SettingRow({
  icon: Icon,
  label,
  description,
  value,
  onValueChange,
  disabled,
}: {
  icon?: LucideIcon;
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View className="min-h-[52px] flex-row items-center justify-between px-4 py-3">
      <View className="mr-4 flex-1">
        <View className="flex-row items-center">
          {Icon && (
            <Icon
              size={18}
              color={disabled ? colors.text.muted.dark : colors.text.secondary.dark}
              style={{ marginRight: 10 }}
            />
          )}
          <Text className={cn('text-base', disabled && 'opacity-50')}>{label}</Text>
        </View>
        {description && (
          <Text
            className={cn(
              'text-muted-foreground mt-0.5 text-xs',
              Icon && 'ml-7',
              disabled && 'opacity-50'
            )}
          >
            {description}
          </Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: colors.switch.trackOff, true: colors.switch.trackOn }}
        thumbColor={value ? colors.switch.thumbOn : colors.switch.thumbOff}
      />
    </View>
  );
}

// Segmented control matching Alerts page pattern
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

function RateLimitStatus({
  remainingMinute,
  remainingHour,
  maxPerMinute,
  maxPerHour,
}: {
  remainingMinute?: number;
  remainingHour?: number;
  maxPerMinute: number;
  maxPerHour: number;
}) {
  return (
    <View className="px-4 py-3">
      <Text className="text-muted-foreground mb-2 text-sm">Current Rate Limit Status</Text>
      <View className="flex-row gap-4">
        <View className="bg-surface flex-1 rounded-lg p-3">
          <Text className="text-muted-foreground mb-1 text-xs">Per Minute</Text>
          <Text className="text-lg font-semibold">
            {remainingMinute ?? maxPerMinute} / {maxPerMinute}
          </Text>
        </View>
        <View className="bg-surface flex-1 rounded-lg p-3">
          <Text className="text-muted-foreground mb-1 text-xs">Per Hour</Text>
          <Text className="text-lg font-semibold">
            {remainingHour ?? maxPerHour} / {maxPerHour}
          </Text>
        </View>
      </View>
    </View>
  );
}

export default function NotificationSettingsScreen() {
  const { t } = useTranslation(['mobile', 'common', 'notifications']);
  const queryClient = useQueryClient();
  const server = useAuthStateStore((s) => s.server);

  // Fetch current preferences (per-device, not per-server)
  const {
    data: preferences,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['notifications', 'preferences'],
    queryFn: api.notifications.getPreferences,
    enabled: !!server, // Still need auth
  });

  // Update mutation with optimistic updates
  const updateMutation = useMutation({
    mutationFn: api.notifications.updatePreferences,
    onMutate: async (newData) => {
      await queryClient.cancelQueries({ queryKey: ['notifications', 'preferences'] });
      const previousData = queryClient.getQueryData<NotificationPreferences>([
        'notifications',
        'preferences',
      ]);
      queryClient.setQueryData(
        ['notifications', 'preferences'],
        (old: NotificationPreferences | undefined) => (old ? { ...old, ...newData } : old)
      );
      return { previousData };
    },
    onError: (_err, _newData, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['notifications', 'preferences'], context.previousData);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'preferences'] });
    },
  });

  // Test notification mutation
  const testMutation = useMutation({
    mutationFn: api.notifications.sendTest,
    onSuccess: (result) => {
      Alert.alert(result.success ? 'Test Sent' : 'Test Failed', result.message);
    },
    onError: (error: Error) => {
      Alert.alert('Error', error.message || 'Failed to send test notification');
    },
  });

  const handleUpdate = (
    key: keyof Omit<NotificationPreferences, 'id' | 'mobileSessionId' | 'createdAt' | 'updatedAt'>,
    value: boolean | number | string[]
  ) => {
    updateMutation.mutate({ [key]: value });
  };

  if (isLoading) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.background.dark }}
        edges={['left', 'right', 'bottom']}
      >
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={ACCENT_COLOR} />
          <Text className="text-muted-foreground mt-4">
            {t('mobile:notifications.loadingPreferences')}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error || !preferences) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.background.dark }}
        edges={['left', 'right', 'bottom']}
      >
        <View className="flex-1 items-center justify-center px-8">
          <Text className="mb-2 text-center text-xl font-semibold">
            {t('mobile:notifications.unableToLoadPreferences')}
          </Text>
          <Text className="text-muted-foreground text-center">
            {error instanceof Error ? error.message : 'An error occurred'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const pushEnabled = preferences.pushEnabled;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background.dark }}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView style={{ flex: 1 }} contentContainerClassName="p-4">
        {/* Master Toggle */}
        <SettingsSection title="Push Notifications">
          <SettingRow
            icon={Bell}
            label={t('notifications:settings.enablePushNotifications')}
            description={t('mobile:notifications.receiveAlerts')}
            value={pushEnabled}
            onValueChange={(v) => handleUpdate('pushEnabled', v)}
          />
        </SettingsSection>

        {/* Event Toggles */}
        <SettingsSection title={t('notifications:settings.notificationEvents')}>
          <SettingRow
            icon={ShieldAlert}
            label={t('notifications:settings.violationDetected')}
            description={t('mobile:notifications.ruleViolationTriggered')}
            value={preferences.onViolationDetected}
            onValueChange={(v) => handleUpdate('onViolationDetected', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={Play}
            label={t('notifications:settings.streamStarted')}
            description={t('mobile:notifications.newPlaybackBegan')}
            value={preferences.onStreamStarted}
            onValueChange={(v) => handleUpdate('onStreamStarted', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={Square}
            label={t('notifications:settings.streamStopped')}
            description={t('mobile:notifications.playbackEnded')}
            value={preferences.onStreamStopped}
            onValueChange={(v) => handleUpdate('onStreamStopped', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={Monitor}
            label={t('notifications:settings.concurrentStreams')}
            description={t('mobile:notifications.exceededStreamLimit')}
            value={preferences.onConcurrentStreams}
            onValueChange={(v) => handleUpdate('onConcurrentStreams', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={Smartphone}
            label={t('notifications:settings.newDevice')}
            description={t('mobile:notifications.newDeviceDetected')}
            value={preferences.onNewDevice}
            onValueChange={(v) => handleUpdate('onNewDevice', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={AlertTriangle}
            label={t('notifications:settings.trustScoreChanged')}
            description={t('mobile:notifications.trustScoreDegraded')}
            value={preferences.onTrustScoreChanged}
            onValueChange={(v) => handleUpdate('onTrustScoreChanged', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={ServerCrash}
            label={t('notifications:settings.serverDown')}
            description={t('mobile:notifications.serverUnreachable')}
            value={preferences.onServerDown}
            onValueChange={(v) => handleUpdate('onServerDown', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={ServerCog}
            label={t('notifications:settings.serverUp')}
            description={t('mobile:notifications.serverBackOnline')}
            value={preferences.onServerUp}
            onValueChange={(v) => handleUpdate('onServerUp', v)}
            disabled={!pushEnabled}
          />
        </SettingsSection>

        {/* Violation Filters - Only show if violation notifications are enabled */}
        {pushEnabled && preferences.onViolationDetected && (
          <>
            <SettingsSection title="Violation Types">
              <SettingRow
                icon={ShieldAlert}
                label="All Violation Types"
                description="Notify for every rule type"
                value={preferences.violationRuleTypes.length === 0}
                onValueChange={(allEnabled) => {
                  if (allEnabled) {
                    handleUpdate('violationRuleTypes', []);
                  } else {
                    // When turning off "All", enable all individual types
                    handleUpdate(
                      'violationRuleTypes',
                      RULE_TYPES.map((r) => r.value)
                    );
                  }
                }}
              />
              {preferences.violationRuleTypes.length > 0 && (
                <>
                  {RULE_TYPES.map((ruleType) => {
                    const isEnabled = preferences.violationRuleTypes.includes(ruleType.value);
                    return (
                      <View key={ruleType.value}>
                        <Divider />
                        <SettingRow
                          icon={ruleType.icon}
                          label={ruleType.label}
                          value={isEnabled}
                          onValueChange={(enabled) => {
                            const current = preferences.violationRuleTypes;
                            if (enabled) {
                              handleUpdate('violationRuleTypes', [...current, ruleType.value]);
                            } else {
                              const updated = current.filter((v) => v !== ruleType.value);
                              // If none left, keep at least one or revert to all
                              handleUpdate(
                                'violationRuleTypes',
                                updated.length === 0 ? [] : updated
                              );
                            }
                          }}
                        />
                      </View>
                    );
                  })}
                </>
              )}
            </SettingsSection>

            <SettingsSection title="Minimum Severity">
              <View className="px-4 py-3">
                <SegmentedControl
                  options={SEVERITY_OPTIONS}
                  value={String(preferences.violationMinSeverity)}
                  onChange={(value) => handleUpdate('violationMinSeverity', Number(value))}
                />
                <Text className="text-muted-foreground mt-2 text-xs">
                  Only notify for violations at or above this severity level
                </Text>
              </View>
            </SettingsSection>
          </>
        )}

        {/* Quiet Hours */}
        <SettingsSection title="Quiet Hours">
          <SettingRow
            icon={Moon}
            label="Enable Quiet Hours"
            description="Pause non-critical notifications during set hours"
            value={preferences.quietHoursEnabled}
            onValueChange={(v) => handleUpdate('quietHoursEnabled', v)}
            disabled={!pushEnabled}
          />
          {pushEnabled && preferences.quietHoursEnabled && (
            <>
              <Divider />
              <View className="px-4 py-3">
                <View className="flex-row items-center justify-between">
                  <View>
                    <Text className="text-muted-foreground text-sm">Start Time</Text>
                    <Text className="text-base">{preferences.quietHoursStart ?? '23:00'}</Text>
                  </View>
                  <Text className="text-muted-foreground mx-4">to</Text>
                  <View>
                    <Text className="text-muted-foreground text-sm">End Time</Text>
                    <Text className="text-base">{preferences.quietHoursEnd ?? '08:00'}</Text>
                  </View>
                </View>
                <Text className="text-muted-foreground mt-2 text-xs">
                  Timezone: {preferences.quietHoursTimezone || 'UTC'}
                </Text>
              </View>
              <Divider />
              <SettingRow
                icon={Flame}
                label="Override for Critical"
                description="High-severity violations still notify during quiet hours"
                value={preferences.quietHoursOverrideCritical}
                onValueChange={(v) => handleUpdate('quietHoursOverrideCritical', v)}
              />
            </>
          )}
        </SettingsSection>

        {/* Rate Limiting */}
        <SettingsSection title="Rate Limiting">
          <RateLimitStatus
            remainingMinute={preferences.rateLimitStatus?.remainingMinute}
            remainingHour={preferences.rateLimitStatus?.remainingHour}
            maxPerMinute={preferences.maxPerMinute}
            maxPerHour={preferences.maxPerHour}
          />
          <Divider />
          <View className="px-4 py-2">
            <Text className="text-muted-foreground text-xs leading-4">
              Rate limits prevent notification spam. Current limits: {preferences.maxPerMinute}/min,{' '}
              {preferences.maxPerHour}/hour.
            </Text>
          </View>
        </SettingsSection>

        {/* Test Notification */}
        <View className="mt-2 mb-4">
          <Button
            onPress={() => testMutation.mutate()}
            disabled={!pushEnabled || testMutation.isPending}
            className={cn(!pushEnabled && 'opacity-50')}
          >
            {testMutation.isPending ? (
              <ActivityIndicator size="small" color={colors.background.dark} />
            ) : (
              <Text className="text-background font-semibold">
                {t('mobile:notifications.sendTestNotification')}
              </Text>
            )}
          </Button>
          <Text className="text-muted-foreground mt-2 text-center text-xs">
            {t('mobile:notifications.testDescription')}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
