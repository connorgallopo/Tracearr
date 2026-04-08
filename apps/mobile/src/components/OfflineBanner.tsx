/**
 * Offline banner component
 * Shows persistent warning banner when disconnected from server
 * Includes pulsing animation and manual retry button
 */
import React, { useEffect, useRef } from 'react';
import { View, Pressable, Animated } from 'react-native';
import { Text } from '@/components/ui/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WifiOff } from 'lucide-react-native';
import { useShallow } from 'zustand/react/shallow';
import { useAuthStateStore } from '../lib/authStateStore';
import { colors, spacing, withAlpha } from '../lib/theme';
import { useTranslation } from '@tracearr/translations/mobile';

interface OfflineBannerProps {
  onRetry: () => void;
}

export function OfflineBanner({ onRetry }: OfflineBannerProps) {
  const { t } = useTranslation(['mobile', 'common']);
  const { connectionState, server, tokenStatus } = useAuthStateStore(
    useShallow((s) => ({
      connectionState: s.connectionState,
      server: s.server,
      tokenStatus: s.tokenStatus,
    }))
  );
  const insets = useSafeAreaInsets();
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Only show offline banner if user is authenticated (has paired server)
  // and connection is lost. Don't show on fresh install or during pairing.
  const isAuthenticated = server !== null && tokenStatus !== 'revoked';

  useEffect(() => {
    if (connectionState === 'disconnected') {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.5,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [connectionState, pulseAnim]);

  if (connectionState !== 'disconnected' || !isAuthenticated) return null;

  return (
    <View
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 6,
        zIndex: 1000,
        backgroundColor: colors.warning,
        top: insets.top + spacing.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Animated.View style={{ opacity: pulseAnim }}>
          <WifiOff size={16} color={colors.background.dark} />
        </Animated.View>
        <Text className="text-background text-sm font-medium">
          {t('mobile:errors.connectionLost')}
        </Text>
      </View>
      <Pressable
        onPress={onRetry}
        style={{
          backgroundColor: withAlpha(colors.background.dark, '30'),
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 4,
        }}
      >
        <Text className="text-background text-xs font-semibold">{t('common:actions.retry')}</Text>
      </Pressable>
    </View>
  );
}
