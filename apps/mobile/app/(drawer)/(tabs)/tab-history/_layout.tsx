import { View, Pressable, Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { DrawerActions, useNavigation } from '@react-navigation/native';
import { Menu, Bell } from 'lucide-react-native';
import { useUnacknowledgedAlertsCount } from '@/hooks';
import { Text } from '@/components/ui/text';
import { colors, spacing } from '@/lib/theme';
import { useTranslation } from '@tracearr/translations/mobile';

function HeaderLeft() {
  const navigation = useNavigation();
  return (
    <Pressable
      onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
      style={{ padding: spacing.xs }}
    >
      <Menu size={24} color={colors.text.primary.dark} />
    </Pressable>
  );
}

function HeaderRight() {
  const router = useRouter();
  const { hasAlerts, displayCount } = useUnacknowledgedAlertsCount();

  return (
    <Pressable onPress={() => router.push('/alerts')} style={{ padding: spacing.xs }}>
      <View style={{ position: 'relative' }}>
        <Bell size={24} color={colors.text.primary.dark} />
        {hasAlerts && (
          <View
            style={{
              position: 'absolute',
              top: -6,
              right: -8,
              minWidth: 18,
              borderRadius: 10,
              backgroundColor: colors.error,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 4,
            }}
          >
            <Text style={{ fontSize: 10, fontWeight: '700', color: '#fff' }}>{displayCount}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

export default function HistoryStack() {
  const { t } = useTranslation(['nav']);
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.text.primary.dark,
        headerTitleStyle: { fontWeight: '600' },
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.background.dark },
        contentStyle: { backgroundColor: colors.background.dark },
        headerTitleAlign: 'center',
        headerLeft: Platform.OS === 'android' ? () => <HeaderLeft /> : undefined,
        headerRight: Platform.OS === 'android' ? () => <HeaderRight /> : undefined,
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: t('nav:history'),
        }}
      />
    </Stack>
  );
}
