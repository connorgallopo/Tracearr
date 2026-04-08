/**
 * Custom drawer content for the hamburger menu
 * Contains: Server Switcher, Settings link, User profile section at bottom
 */
import { useEffect, useRef } from 'react';
import { View, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Settings, ChevronRight } from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';
import { Text } from '@/components/ui/text';
import { UserAvatar } from '@/components/ui/user-avatar';
import { ServerSelector } from '@/components/ServerSelector';
import { useMediaServer } from '@/providers/MediaServerProvider';
import { api } from '@/lib/api';
import { ACCENT_COLOR, colors, spacing, withAlpha } from '@/lib/theme';
import { useTranslation } from '@tracearr/translations/mobile';

interface DrawerItemProps {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  showChevron?: boolean;
}

function DrawerItem({ icon, label, onPress, showChevron = true }: DrawerItemProps) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center justify-between px-4 py-3.5"
      android_ripple={{ color: withAlpha(ACCENT_COLOR, '20') }}
    >
      <View className="flex-row items-center gap-4">
        {icon}
        <Text className="text-[15px] font-medium">{label}</Text>
      </View>
      {showChevron && <ChevronRight size={20} color={colors.icon.default} />}
    </Pressable>
  );
}

function DrawerSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-6 px-4">
      <Text className="text-muted-foreground mb-2 ml-2 text-[11px] font-semibold tracking-wider uppercase">
        {title}
      </Text>
      <View className="bg-card overflow-hidden rounded-xl">{children}</View>
    </View>
  );
}

export function DrawerContent(props: DrawerContentComponentProps) {
  const { t } = useTranslation(['mobile', 'nav']);
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const isDashboard = pathname === '/' || pathname === '/index';
  const { selectedServerIds, selectServer } = useMediaServer();

  // When navigating away from Dashboard with multiple servers selected,
  // collapse to single server (other pages are single-server only)
  const prevIsDashboard = useRef(isDashboard);
  useEffect(() => {
    const wasDashboard = prevIsDashboard.current;
    prevIsDashboard.current = isDashboard;

    if (wasDashboard && !isDashboard && selectedServerIds.length > 1) {
      selectServer(selectedServerIds[0] ?? null);
    }
  }, [isDashboard, selectedServerIds, selectServer]);

  // Fetch current user profile
  const { data: user, isLoading: userLoading } = useQuery({
    queryKey: ['mobile', 'me'],
    queryFn: () => api.me(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const handleSettingsPress = () => {
    props.navigation.closeDrawer();
    router.push('/settings');
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#09090B', paddingTop: insets.top }}>
      {/* Scrollable content area */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: spacing.md }}>
        {/* App Title */}
        <View className="border-border mb-4 border-b px-6 pb-6">
          <Text className="text-primary text-2xl font-bold">Tracearr</Text>
        </View>

        {/* Server Section - uses existing ServerSelector */}
        <DrawerSection title={t('mobile:navigation.server')}>
          <View className="py-2">
            <ServerSelector multiSelect={isDashboard} />
          </View>
        </DrawerSection>

        {/* Navigation Section */}
        <DrawerSection title={t('mobile:navigation.navigation')}>
          <DrawerItem
            icon={<Settings size={20} color={colors.icon.default} />}
            label={t('nav:settings')}
            onPress={handleSettingsPress}
          />
        </DrawerSection>
      </ScrollView>

      {/* User Profile Section - fixed at bottom */}
      <View
        className="border-border border-t px-4 pt-4"
        style={{ paddingBottom: insets.bottom + (spacing.md as number) }}
      >
        {userLoading ? (
          <ActivityIndicator size="small" color={ACCENT_COLOR} />
        ) : user ? (
          <View className="flex-row items-center gap-4">
            <UserAvatar thumbUrl={user.thumbUrl} username={user.username} size={40} />
            <View className="flex-1">
              <Text className="text-[15px] font-semibold" numberOfLines={1}>
                {user.friendlyName}
              </Text>
              <Text className="text-muted-foreground text-xs capitalize">{user.role}</Text>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}
