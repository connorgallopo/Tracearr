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
  UserCircle,
  Gauge,
  Smartphone,
  Activity,
  BookOpen,
  Sparkles,
  HardDrive,
  Eye,
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
      { name: 'Users', href: '/stats/users', icon: UserCircle },
    ],
  },
  {
    name: 'Library',
    icon: BookOpen,
    children: [
      { name: 'Overview', href: '/library', icon: LayoutDashboard },
      { name: 'Quality', href: '/library/quality', icon: Sparkles },
      { name: 'Storage', href: '/library/storage', icon: HardDrive },
      { name: 'Watch', href: '/library/watch', icon: Eye },
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
