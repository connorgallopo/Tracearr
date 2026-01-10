import {
  LayoutDashboard,
  Map,
  History,
  BarChart3,
  Users,
  Shield,
  AlertTriangle,
  Settings,
  TrendingUp,
  Film,
  UserCircle,
  Gauge,
  Smartphone,
  Activity,
} from 'lucide-react';

export interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface NavGroup {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  children: NavItem[];
}

export type NavEntry = NavItem | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

export const navigation: NavEntry[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Map', href: '/map', icon: Map },
  { name: 'History', href: '/history', icon: History },
  {
    name: 'Stats',
    icon: BarChart3,
    children: [
      { name: 'Activity', href: '/stats/activity', icon: TrendingUp },
      { name: 'Library', href: '/stats/library', icon: Film },
      { name: 'Users', href: '/stats/users', icon: UserCircle },
    ],
  },
  {
    name: 'Performance',
    icon: Gauge,
    children: [
      { name: 'Devices', href: '/stats/devices', icon: Smartphone },
      { name: 'Bandwidth', href: '/stats/bandwidth', icon: Activity },
    ],
  },
  { name: 'Users', href: '/users', icon: Users },
  { name: 'Rules', href: '/rules', icon: Shield },
  { name: 'Violations', href: '/violations', icon: AlertTriangle },
  { name: 'Settings', href: '/settings', icon: Settings },
];
