/**
 * Auth layout - for login/pairing screens
 */
import { Stack } from 'expo-router';
import { colors } from '@/lib/theme';
import { useTranslation } from '@tracearr/translations/mobile';

export default function AuthLayout() {
  const { t } = useTranslation(['mobile']);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background.dark },
      }}
    >
      <Stack.Screen name="pair" options={{ title: t('mobile:pair.connectToServer') }} />
    </Stack>
  );
}
