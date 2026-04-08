/**
 * Settings stack navigator layout
 * Provides navigation between settings sub-screens
 */
import { Stack, useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { colors } from '@/lib/theme';

export default function SettingsLayout() {
  const router = useRouter();

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: {
          backgroundColor: colors.background.dark,
        },
        headerTintColor: colors.text.primary.dark,
        headerTitleStyle: {
          fontWeight: '600',
        },
        headerBackTitle: 'Back',
        headerLeft: () => (
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <ChevronLeft size={28} color={colors.text.primary.dark} />
          </Pressable>
        ),
        contentStyle: {
          backgroundColor: colors.background.dark,
        },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Settings',
        }}
      />
      <Stack.Screen
        name="notifications"
        options={{
          title: 'Notifications',
        }}
      />
      <Stack.Screen
        name="language"
        options={{
          title: 'Language',
        }}
      />
    </Stack>
  );
}
