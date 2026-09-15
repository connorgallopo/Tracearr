/**
 * The icons automations show: one per trigger group, one per action type, and one for
 * an automation as a whole taken from its first condition field.
 */

import { createElement, type ReactElement } from 'react';
import { TRIGGERS, type ActionType, type ConditionField, type TriggerType } from '@tracearr/shared';
import {
  ArrowUpFromLine,
  Bell,
  Clock,
  Globe,
  Library,
  Mail,
  MapPin,
  MessageSquare,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Server,
  Settings2,
  Shield,
  Smartphone,
  Split,
  TrendingUp,
  UserRound,
  Users,
  Wifi,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { DescribableDefinition } from './describe';

const CONDITION_FIELD_ICONS: Partial<Record<ConditionField, LucideIcon>> = {
  concurrent_streams: Users,
  active_session_distance_km: MapPin,
  travel_speed_kmh: MapPin,
  unique_ips_in_window: Zap,
  unique_devices_in_window: Zap,
  inactive_days: Clock,
  current_pause_minutes: Pause,
  total_pause_minutes: Pause,
  source_resolution: Monitor,
  output_resolution: Monitor,
  is_transcoding: RefreshCw,
  is_transcode_downgrade: RefreshCw,
  source_bitrate_mbps: Monitor,
  trust_score: Shield,
  account_age_days: Clock,
  country: Globe,
  is_local_network: Wifi,
  ip_in_range: Globe,
};

const TRIGGER_GROUP_ICONS = {
  sessions: Play,
  accounts: UserRound,
  library: Library,
  servers: Server,
  updates: ArrowUpFromLine,
  notifications: Mail,
} as const satisfies Record<(typeof TRIGGERS)[TriggerType]['group'], LucideIcon>;

const ACTION_ICONS = {
  send: Bell,
  trust: TrendingUp,
  kill_stream: XCircle,
  message_client: MessageSquare,
  if: Split,
} as const satisfies Record<ActionType, LucideIcon>;

/** The triggers a reader scans for by what they are rather than by their group. */
const TRIGGER_ICONS: Partial<Record<TriggerType, LucideIcon>> = {
  'session.held_for': Pause,
  'account.inactive_for': UserRound,
  'account.new_device': Smartphone,
  'account.trust_changed': Shield,
};

function iconForTrigger(type: TriggerType): LucideIcon {
  return TRIGGER_ICONS[type] ?? TRIGGER_GROUP_ICONS[TRIGGERS[type].group];
}

/** Triggers share an icon per group: the group is what a reader scans for. */
export function triggerIcon(type: TriggerType): ReactElement {
  return createElement(iconForTrigger(type), { className: 'size-4' });
}

export function actionIcon(type: ActionType, className = 'size-4'): ReactElement {
  return createElement(ACTION_ICONS[type], { className });
}

function iconForConditions(definition: DescribableDefinition): LucideIcon | undefined {
  const field = definition.conditions?.groups[0]?.conditions[0]?.field;
  return field ? CONDITION_FIELD_ICONS[field] : undefined;
}

/** Built with createElement so this stays a plain module and callers stay one expression. */
export function automationIcon(automation: DescribableDefinition): ReactElement {
  return createElement(iconForConditions(automation) ?? Settings2, { className: 'size-5' });
}

/** A template row: what its first check looks at, or failing that what starts it. */
export function templateIcon(
  definition: DescribableDefinition,
  className = 'size-4'
): ReactElement {
  const trigger = definition.triggers?.find((node) => node.enabled !== false)?.type;
  const icon = iconForConditions(definition) ?? (trigger ? iconForTrigger(trigger) : Settings2);
  return createElement(icon, { className });
}
