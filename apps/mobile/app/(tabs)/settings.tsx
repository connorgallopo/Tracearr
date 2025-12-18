/**
 * Settings tab - notifications, app info
 * Server selection is handled via the global header selector
 */
import { View, ScrollView, Pressable, Switch, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LogOut } from 'lucide-react-native';
import { useAuthStore } from '@/lib/authStore';
import { Text } from '@/components/ui/text';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { colors } from '@/lib/theme';
import Constants from 'expo-constants';

function SettingsRow({
  label,
  value,
  onPress,
  showChevron,
  leftIcon,
  rightIcon,
  destructive,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  showChevron?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  destructive?: boolean;
}) {
  const content = (
    <View className="min-h-[48px] flex-row items-center justify-between px-4 py-3">
      <View className="flex-1 flex-row items-center">
        {leftIcon && <View className="mr-3">{leftIcon}</View>}
        <Text className={cn('flex-1 text-base', destructive && 'text-destructive')}>{label}</Text>
      </View>
      <View className="flex-row items-center">
        {value && <Text className="text-muted-foreground ml-4 text-right text-base">{value}</Text>}
        {rightIcon}
        {showChevron && <ChevronRight size={20} color={colors.text.muted.dark} className="ml-2" />}
      </View>
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} className="active:bg-background active:opacity-70">
        {content}
      </Pressable>
    );
  }

  return content;
}

function SettingsToggle({
  label,
  description,
  value,
  onValueChange,
  disabled,
  isLoading,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  isLoading?: boolean;
}) {
  return (
    <View className="min-h-[48px] flex-row items-center justify-between px-4 py-3">
      <View className="mr-4 flex-1">
        <Text className={cn('text-base', disabled && 'opacity-50')}>{label}</Text>
        {description && (
          <Text className={cn('text-muted-foreground mt-0.5 text-xs', disabled && 'opacity-50')}>
            {description}
          </Text>
        )}
      </View>
      {isLoading ? (
        <ActivityIndicator size="small" color={colors.cyan.core} />
      ) : (
        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          trackColor={{ false: colors.switch.trackOff, true: colors.switch.trackOn }}
          thumbColor={value ? colors.switch.thumbOn : colors.switch.thumbOff}
        />
      )}
    </View>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-6 px-4">
      <Text className="text-muted-foreground mb-2 text-sm font-semibold tracking-wide uppercase">
        {title}
      </Text>
      <Card className="overflow-hidden p-0">{children}</Card>
    </View>
  );
}

function Divider() {
  return <View className="bg-border ml-4 h-px" />;
}

export default function SettingsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { activeServerId, activeServer, isLoading: isAuthLoading, logout } = useAuthStore();

  const appVersion = Constants.expoConfig?.version || '1.0.0';

  // Fetch notification preferences
  const {
    data: preferences,
    isLoading: isLoadingPrefs,
    error: prefsError,
  } = useQuery({
    queryKey: ['notifications', 'preferences'],
    queryFn: api.notifications.getPreferences,
    staleTime: 1000 * 60, // 1 minute
    enabled: !!activeServerId,
  });

  // Update mutation for quick toggle
  const updateMutation = useMutation({
    mutationFn: api.notifications.updatePreferences,
    onMutate: async (newData) => {
      await queryClient.cancelQueries({
        queryKey: ['notifications', 'preferences'],
      });
      const previousData = queryClient.getQueryData(['notifications', 'preferences']);
      queryClient.setQueryData(['notifications', 'preferences'], (old: typeof preferences) =>
        old ? { ...old, ...newData } : old
      );
      return { previousData };
    },
    onError: (_err, _newData, context) => {
      if (context?.previousData) {
        queryClient.setQueryData(['notifications', 'preferences'], context.previousData);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ['notifications', 'preferences'],
      });
    },
  });

  const handleDisconnect = () => {
    Alert.alert(
      'Disconnect from Server',
      'Are you sure you want to disconnect? You will need to scan a QR code to reconnect.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await queryClient.cancelQueries();
              await logout();
              queryClient.clear();
            })();
          },
        },
      ]
    );
  };

  const handleTogglePush = (value: boolean) => {
    updateMutation.mutate({ pushEnabled: value });
  };

  const navigateToNotificationSettings = () => {
    router.push('/settings/notifications');
  };

  // Count enabled notification events for summary
  const enabledEventCount = preferences
    ? [
        preferences.onViolationDetected,
        preferences.onStreamStarted,
        preferences.onStreamStopped,
        preferences.onConcurrentStreams,
        preferences.onNewDevice,
        preferences.onTrustScoreChanged,
        preferences.onServerDown,
        preferences.onServerUp,
      ].filter(Boolean).length
    : 0;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background.dark }}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView className="flex-1" contentContainerClassName="py-4">
        {/* Connected Server Info */}
        {activeServer && (
          <SettingsSection title="Connected Server">
            <SettingsRow label="Name" value={activeServer.name} />
            <Divider />
            <SettingsRow label="URL" value={activeServer.url} />
            <Divider />
            <SettingsRow
              label="Disconnect"
              onPress={handleDisconnect}
              leftIcon={<LogOut size={20} color={colors.error} />}
              destructive
            />
          </SettingsSection>
        )}

        {/* Notification Settings */}
        {activeServerId && (
          <SettingsSection title="Notifications">
            {prefsError ? (
              <View className="px-4 py-3">
                <Text className="text-destructive text-sm">
                  Failed to load notification settings
                </Text>
              </View>
            ) : (
              <>
                <SettingsToggle
                  label="Push Notifications"
                  description="Receive alerts on this device"
                  value={preferences?.pushEnabled ?? false}
                  onValueChange={handleTogglePush}
                  isLoading={isLoadingPrefs}
                  disabled={updateMutation.isPending}
                />
                <Divider />
                <SettingsRow
                  label="Notification Settings"
                  value={
                    preferences?.pushEnabled ? `${enabledEventCount} events enabled` : 'Disabled'
                  }
                  onPress={navigateToNotificationSettings}
                  showChevron
                />
                <Text className="text-muted-foreground px-4 py-2 text-xs leading-4">
                  Configure which events trigger notifications, quiet hours, and filters.
                </Text>
              </>
            )}
          </SettingsSection>
        )}

        {/* App Info */}
        <SettingsSection title="About">
          <SettingsRow label="App Version" value={appVersion} />
          <Divider />
          <SettingsRow
            label="Build"
            value={(Constants.expoConfig?.extra?.buildNumber as string | undefined) ?? 'dev'}
          />
        </SettingsSection>

        {/* Loading indicator */}
        {isAuthLoading && (
          <View className="items-center px-4 py-8">
            <ActivityIndicator color={colors.cyan.core} />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
