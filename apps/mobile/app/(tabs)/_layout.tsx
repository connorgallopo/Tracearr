/**
 * Main tab navigation layout
 */
import { Tabs } from 'expo-router';
import {
  LayoutDashboard,
  Activity,
  Users,
  Bell,
  Settings,
  type LucideIcon,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/lib/theme';
import { ServerSelector } from '@/components/ServerSelector';

interface TabIconProps {
  icon: LucideIcon;
  focused: boolean;
}

function TabIcon({ icon: Icon, focused }: TabIconProps) {
  return (
    <Icon
      size={24}
      color={focused ? colors.cyan.core : colors.text.muted.dark}
      strokeWidth={focused ? 2.5 : 2}
    />
  );
}

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  // Dynamic tab bar height: base height + safe area bottom inset
  const tabBarHeight = 60 + insets.bottom;

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerStyle: {
          backgroundColor: colors.background.dark,
        },
        headerTintColor: colors.text.primary.dark,
        headerTitleStyle: {
          fontWeight: '600',
        },
        tabBarStyle: {
          backgroundColor: colors.card.dark,
          borderTopColor: colors.border.dark,
          borderTopWidth: 1,
          height: tabBarHeight,
          paddingBottom: insets.bottom,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.cyan.core,
        tabBarInactiveTintColor: colors.text.muted.dark,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '500',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          headerTitle: () => <ServerSelector />,
          tabBarLabel: 'Dashboard',
          tabBarIcon: ({ focused }) => <TabIcon icon={LayoutDashboard} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          headerTitle: () => <ServerSelector />,
          tabBarLabel: 'Activity',
          tabBarIcon: ({ focused }) => <TabIcon icon={Activity} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="users"
        options={{
          title: 'Users',
          headerTitle: () => <ServerSelector />,
          tabBarLabel: 'Users',
          tabBarIcon: ({ focused }) => <TabIcon icon={Users} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          headerTitle: () => <ServerSelector />,
          tabBarLabel: 'Alerts',
          tabBarIcon: ({ focused }) => <TabIcon icon={Bell} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
          tabBarIcon: ({ focused }) => <TabIcon icon={Settings} focused={focused} />,
        }}
      />
    </Tabs>
  );
}
