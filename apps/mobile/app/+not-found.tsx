/**
 * 404 Not Found screen
 */
import { View, Pressable } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AlertCircle } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { colors } from '@/lib/theme';
import { useTranslation } from '@tracearr/translations/mobile';

export default function NotFoundScreen() {
  const router = useRouter();
  const { t } = useTranslation(['common']);

  return (
    <>
      <Stack.Screen options={{ title: t('common:errors.pageNotFound') }} />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background.dark }}>
        <View className="flex-1 items-center justify-center px-6">
          <View className="bg-card border-border mb-4 h-20 w-20 items-center justify-center rounded-full border">
            <AlertCircle size={32} color={colors.text.muted.dark} />
          </View>
          <Text className="mb-1 text-center text-lg font-semibold">
            {t('common:errors.pageNotFound')}
          </Text>
          <Text className="text-muted-foreground mb-6 text-center text-sm">
            {t('common:errors.pageNotFoundDesc')}
          </Text>
          <Pressable
            className="bg-primary rounded-lg px-6 py-3"
            onPress={() => router.replace('/index')}
          >
            <Text className="font-semibold text-white">{t('common:actions.goHome')}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </>
  );
}
