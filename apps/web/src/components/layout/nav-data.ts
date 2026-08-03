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
  Sparkles,
  HardDrive,
  Eye,
  Clapperboard,
  LayoutGrid,
  Tags,
} from 'lucide-react';
import type { NavKey } from '@tracearr/translations';

export interface NavItem {
  nameKey: NavKey;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface NavGroup {
  nameKey: NavKey;
  icon: React.ComponentType<{ className?: string }>;
  children: NavItem[];
}

export type NavEntry = NavItem | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

export const navigation: NavEntry[] = [
  { nameKey: 'dashboard', href: '/', icon: LayoutDashboard },
  { nameKey: 'map', href: '/map', icon: Map },
  { nameKey: 'history', href: '/history', icon: History },
  {
    nameKey: 'stats',
    icon: BarChart3,
    children: [
      { nameKey: 'overview', href: '/stats/overview', icon: LayoutDashboard },
      { nameKey: 'activity', href: '/stats/activity', icon: TrendingUp },
      { nameKey: 'users', href: '/stats/users', icon: UserCircle },
    ],
  },
  {
    nameKey: 'media',
    icon: Clapperboard,
    children: [
      { nameKey: 'overview', href: '/media', icon: LayoutDashboard },
      { nameKey: 'mediaBrowse', href: '/media/browse', icon: LayoutGrid },
      { nameKey: 'mediaGenres', href: '/media/genres', icon: Tags },
      { nameKey: 'quality', href: '/library/quality', icon: Sparkles },
      { nameKey: 'storage', href: '/library/storage', icon: HardDrive },
      { nameKey: 'watch', href: '/library/watch', icon: Eye },
    ],
  },
  {
    nameKey: 'performance',
    icon: Gauge,
    children: [
      { nameKey: 'devices', href: '/stats/devices', icon: Smartphone },
      { nameKey: 'bandwidth', href: '/stats/bandwidth', icon: Activity },
    ],
  },
  { nameKey: 'users', href: '/users', icon: Users },
  { nameKey: 'rules', href: '/rules', icon: Shield },
  { nameKey: 'violations', href: '/violations', icon: AlertTriangle },
  { nameKey: 'settings', href: '/settings', icon: Settings },
];
