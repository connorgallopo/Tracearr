/**
 * Drawer layout that wraps the main tab navigation
 * Provides a hamburger menu accessible from any tab
 */
import { Drawer } from 'expo-router/drawer';
import { DrawerContent } from '@/components/navigation/DrawerContent';
import { colors } from '@/lib/theme';
import { useTranslation } from '@tracearr/translations/mobile';

export default function DrawerLayout() {
  const { t } = useTranslation(['mobile']);
  return (
    <Drawer
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={{
        headerShown: false, // We use custom AppHeader in tabs
        drawerStyle: {
          backgroundColor: colors.background.dark,
          width: 260,
        },
        drawerType: 'front',
        overlayColor: 'rgba(0, 0, 0, 0.6)',
        swipeEnabled: true,
        swipeEdgeWidth: 50,
      }}
    >
      <Drawer.Screen
        name="(tabs)"
        options={{
          drawerLabel: t('mobile:navigation.home'),
          headerShown: false,
        }}
      />
    </Drawer>
  );
}
