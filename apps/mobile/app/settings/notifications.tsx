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
  type LucideIcon,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/authStore';
import { colors } from '@/lib/theme';
import type { NotificationPreferences } from '@tracearr/shared';

// Rule types for violation filtering
const RULE_TYPES = [
  { value: 'impossible_travel', label: 'Impossible Travel' },
  { value: 'simultaneous_locations', label: 'Simultaneous Locations' },
  { value: 'device_velocity', label: 'Device Velocity' },
  { value: 'concurrent_streams', label: 'Concurrent Streams' },
  { value: 'geo_restriction', label: 'Geo Restriction' },
] as const;

// Severity levels
const SEVERITY_LEVELS = [
  { value: 1, label: 'All (Low, Warning, High)' },
  { value: 2, label: 'Warning & High only' },
  { value: 3, label: 'High severity only' },
] as const;

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

function SelectRow({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  options: ReadonlyArray<{ value: number; label: string }>;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const currentOption = options.find((o) => o.value === value);

  const handlePress = () => {
    if (disabled) return;

    Alert.alert(
      label,
      undefined,
      options.map((option) => ({
        text: option.label,
        onPress: () => onChange(option.value),
        style: option.value === value ? 'cancel' : 'default',
      }))
    );
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      className={cn('min-h-[52px] px-4 py-3', 'active:opacity-70')}
    >
      <Text className={cn('text-muted-foreground mb-1 text-sm', disabled && 'opacity-50')}>
        {label}
      </Text>
      <Text className={cn('text-base', disabled && 'opacity-50')}>
        {currentOption?.label ?? 'Select...'}
      </Text>
    </Pressable>
  );
}

function MultiSelectRow({
  selectedValues,
  options,
  onChange,
  disabled,
}: {
  selectedValues: string[];
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  const toggleValue = (value: string) => {
    if (disabled) return;
    if (selectedValues.includes(value)) {
      onChange(selectedValues.filter((v) => v !== value));
    } else {
      onChange([...selectedValues, value]);
    }
  };

  const allSelected = selectedValues.length === 0;

  return (
    <View className="px-4 py-3">
      <View className="flex-row flex-wrap gap-2.5">
        <Pressable
          onPress={() => onChange([])}
          disabled={disabled}
          className={cn(
            'rounded-full border px-3 py-1.5',
            allSelected ? 'bg-cyan-core border-cyan-core' : 'border-border bg-card',
            disabled && 'opacity-50'
          )}
        >
          <Text className={cn('text-sm', allSelected ? 'text-background' : 'text-foreground')}>
            All Types
          </Text>
        </Pressable>
        {options.map((option) => {
          const isSelected = selectedValues.includes(option.value);
          return (
            <Pressable
              key={option.value}
              onPress={() => toggleValue(option.value)}
              disabled={disabled}
              className={cn(
                'rounded-full border px-3 py-1.5',
                isSelected ? 'bg-cyan-core border-cyan-core' : 'border-border bg-card',
                disabled && 'opacity-50'
              )}
            >
              <Text className={cn('text-sm', isSelected ? 'text-background' : 'text-foreground')}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
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
  const queryClient = useQueryClient();
  const { activeServerId } = useAuthStore();

  // Fetch current preferences (per-device, not per-server)
  const {
    data: preferences,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['notifications', 'preferences'],
    queryFn: api.notifications.getPreferences,
    enabled: !!activeServerId, // Still need auth
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
          <ActivityIndicator size="large" color={colors.cyan.core} />
          <Text className="text-muted-foreground mt-4">Loading preferences...</Text>
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
          <Text className="mb-2 text-center text-xl font-semibold">Unable to Load Preferences</Text>
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
      <ScrollView className="flex-1" contentContainerClassName="p-4">
        {/* Master Toggle */}
        <SettingsSection title="Push Notifications">
          <SettingRow
            icon={Bell}
            label="Enable Push Notifications"
            description="Receive alerts on this device"
            value={pushEnabled}
            onValueChange={(v) => handleUpdate('pushEnabled', v)}
          />
        </SettingsSection>

        {/* Event Toggles */}
        <SettingsSection title="Notification Events">
          <SettingRow
            icon={ShieldAlert}
            label="Violation Detected"
            description="Rule violation triggered"
            value={preferences.onViolationDetected}
            onValueChange={(v) => handleUpdate('onViolationDetected', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={Play}
            label="Stream Started"
            description="New playback began"
            value={preferences.onStreamStarted}
            onValueChange={(v) => handleUpdate('onStreamStarted', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={Square}
            label="Stream Stopped"
            description="Playback ended"
            value={preferences.onStreamStopped}
            onValueChange={(v) => handleUpdate('onStreamStopped', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={Monitor}
            label="Concurrent Streams"
            description="User exceeded stream limit"
            value={preferences.onConcurrentStreams}
            onValueChange={(v) => handleUpdate('onConcurrentStreams', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={Smartphone}
            label="New Device"
            description="New device detected for user"
            value={preferences.onNewDevice}
            onValueChange={(v) => handleUpdate('onNewDevice', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={AlertTriangle}
            label="Trust Score Changed"
            description="User trust score degraded"
            value={preferences.onTrustScoreChanged}
            onValueChange={(v) => handleUpdate('onTrustScoreChanged', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={ServerCrash}
            label="Server Down"
            description="Media server unreachable"
            value={preferences.onServerDown}
            onValueChange={(v) => handleUpdate('onServerDown', v)}
            disabled={!pushEnabled}
          />
          <Divider />
          <SettingRow
            icon={ServerCog}
            label="Server Up"
            description="Media server back online"
            value={preferences.onServerUp}
            onValueChange={(v) => handleUpdate('onServerUp', v)}
            disabled={!pushEnabled}
          />
        </SettingsSection>

        {/* Violation Filters - Only show if violation notifications are enabled */}
        {pushEnabled && preferences.onViolationDetected && (
          <SettingsSection title="Violation Filters">
            <MultiSelectRow
              selectedValues={preferences.violationRuleTypes}
              options={RULE_TYPES}
              onChange={(values) => handleUpdate('violationRuleTypes', values)}
            />
            <Divider />
            <SelectRow
              label="Minimum Severity"
              value={preferences.violationMinSeverity}
              options={SEVERITY_LEVELS}
              onChange={(value) => handleUpdate('violationMinSeverity', value)}
            />
          </SettingsSection>
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
              <Text className="text-background font-semibold">Send Test Notification</Text>
            )}
          </Button>
          <Text className="text-muted-foreground mt-2 text-center text-xs">
            Verify that push notifications are working correctly
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
