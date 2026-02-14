/**
 * Display utilities for V2 rules in the rules list.
 *
 * Generates human-readable summaries and icons from conditions/actions.
 */

import type { ReactNode } from 'react';
import type {
  Rule,
  Condition,
  Action,
  ActionType,
  ConditionField,
  Operator,
  RulesFilterOptions,
} from '@tracearr/shared';
import { type UnitSystem, formatConditionFieldValue } from '@tracearr/shared';
import {
  MapPin,
  Users,
  Zap,
  Clock,
  Monitor,
  RefreshCw,
  Shield,
  Globe,
  Wifi,
  HardDrive,
  Settings2,
} from 'lucide-react';
import { FIELD_DEFINITIONS } from './conditionFields';
import { ACTION_DEFINITIONS } from './actionDefinitions';

// Condition field → icon mapping
const CONDITION_FIELD_ICONS: Partial<Record<ConditionField, ReactNode>> = {
  // Session behavior
  concurrent_streams: <Users className="h-5 w-5" />,
  active_session_distance_km: <MapPin className="h-5 w-5" />,
  travel_speed_kmh: <MapPin className="h-5 w-5" />,
  unique_ips_in_window: <Zap className="h-5 w-5" />,
  unique_devices_in_window: <Zap className="h-5 w-5" />,
  inactive_days: <Clock className="h-5 w-5" />,
  bandwidth_usage_gb: <HardDrive className="h-5 w-5" />,

  // Stream quality
  source_resolution: <Monitor className="h-5 w-5" />,
  output_resolution: <Monitor className="h-5 w-5" />,
  is_transcoding: <RefreshCw className="h-5 w-5" />,
  is_transcode_downgrade: <RefreshCw className="h-5 w-5" />,
  source_bitrate_mbps: <Monitor className="h-5 w-5" />,

  // User attributes
  trust_score: <Shield className="h-5 w-5" />,
  account_age_days: <Clock className="h-5 w-5" />,

  // Network/location
  country: <Globe className="h-5 w-5" />,
  is_local_network: <Wifi className="h-5 w-5" />,
  ip_in_range: <Globe className="h-5 w-5" />,
};

// Fallback icon for unknown fields
const DEFAULT_ICON = <Settings2 className="h-5 w-5" />;

// Compact operator symbols for display
const OPERATOR_SYMBOLS: Record<Operator, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'in',
  not_in: 'not in',
  contains: 'contains',
  not_contains: 'excludes',
};

// Compact field labels for summary display
const COMPACT_FIELD_LABELS: Partial<Record<ConditionField, string>> = {
  inactive_days: 'Inactive',
  concurrent_streams: 'Streams',
  travel_speed_kmh: 'Travel speed',
  active_session_distance_km: 'Session distance',
  unique_ips_in_window: 'Unique IPs',
  unique_devices_in_window: 'Unique devices',
  trust_score: 'Trust',
  account_age_days: 'Account age',
  bandwidth_usage_gb: 'Bandwidth',
  source_resolution: 'Resolution',
  output_resolution: 'Output',
  is_transcoding: 'Transcoding',
  is_transcode_downgrade: 'Downgrade',
  source_bitrate_mbps: 'Bitrate',
  country: 'Country',
  is_local_network: 'Local network',
  device_type: 'Device',
  client_name: 'Client',
  platform: 'Platform',
};

/**
 * Get the icon for a V2 rule based on its first condition field.
 */
export function getRuleIcon(rule: Rule): ReactNode {
  const firstCondition = getFirstCondition(rule);
  if (!firstCondition) return DEFAULT_ICON;

  return CONDITION_FIELD_ICONS[firstCondition.field] ?? DEFAULT_ICON;
}

/**
 * Get the first condition from a V2 rule.
 */
function getFirstCondition(rule: Rule): Condition | null {
  if (!rule.conditions?.groups?.length) return null;

  const firstGroup = rule.conditions.groups[0];
  if (!firstGroup?.conditions?.length) return null;

  return firstGroup.conditions[0] ?? null;
}

/**
 * Count total conditions across all groups.
 */
function countTotalConditions(rule: Rule): number {
  if (!rule.conditions?.groups) return 0;

  return rule.conditions.groups.reduce((total, group) => {
    return total + (group.conditions?.length ?? 0);
  }, 0);
}

/**
 * Format a single condition to a human-readable string.
 */
export function formatCondition(
  condition: Condition,
  filterOptions?: RulesFilterOptions,
  unitSystem?: UnitSystem
): string {
  const fieldDef = FIELD_DEFINITIONS[condition.field];
  const label = COMPACT_FIELD_LABELS[condition.field] ?? fieldDef?.label ?? condition.field;
  const operator = OPERATOR_SYMBOLS[condition.operator] ?? condition.operator;

  // Boolean fields: just show the label or "Not {label}"
  if (fieldDef?.valueType === 'boolean') {
    if (condition.value === true) {
      return label;
    }
    return `Not ${label.toLowerCase()}`;
  }

  let formattedValue = formatConditionValue(condition, fieldDef, filterOptions);
  const effectiveUnitSystem = unitSystem ?? 'metric';

  let unit = '';
  if (typeof condition.value === 'number') {
    const converted = formatConditionFieldValue(
      condition.value,
      condition.field,
      effectiveUnitSystem
    );
    if (converted.unit) {
      formattedValue = String(converted.displayValue);
      unit = ` ${converted.unit}`;
    }
  }

  if (!unit && fieldDef?.unit) {
    unit = ` ${fieldDef.unit}`;
  }

  // For 'in' operator with arrays, use format: "Country in US, CA"
  if (condition.operator === 'in' || condition.operator === 'not_in') {
    return `${label} ${operator} ${formattedValue}`;
  }

  // Standard format: "Inactive > 180 days"
  return `${label} ${operator} ${formattedValue}${unit}`;
}

/**
 * Look up a human-readable label for a dynamic field value.
 */
function lookupDynamicValue(
  field: ConditionField,
  value: string,
  filterOptions?: RulesFilterOptions
): string | null {
  if (!filterOptions) return null;

  switch (field) {
    case 'user_id': {
      const user = filterOptions.users?.find((u) => u.id === value);
      return user ? user.identityName || user.username : null;
    }
    case 'server_id': {
      const server = filterOptions.servers?.find((s) => s.id === value);
      return server?.name ?? null;
    }
    case 'country': {
      const country = filterOptions.countries?.find((c) => c.code === value);
      return country?.name ?? null;
    }
    default:
      return null;
  }
}

/**
 * Format a condition value for display.
 */
function formatConditionValue(
  condition: Condition,
  fieldDef: (typeof FIELD_DEFINITIONS)[ConditionField] | undefined,
  filterOptions?: RulesFilterOptions
): string {
  const { value, field } = condition;

  // Array values: join with comma (with dynamic lookups)
  if (Array.isArray(value)) {
    if (value.length === 0) return '(none)';
    const labels = value.map((v) => {
      if (typeof v === 'string') {
        return lookupDynamicValue(field, v, filterOptions) ?? v;
      }
      return String(v);
    });
    if (labels.length > 3) {
      return `${labels.slice(0, 3).join(', ')}...`;
    }
    return labels.join(', ');
  }

  // Try dynamic lookup first for fields like user_id, server_id, country
  if (typeof value === 'string') {
    const dynamicLabel = lookupDynamicValue(field, value, filterOptions);
    if (dynamicLabel) return dynamicLabel;
  }

  // Select fields: try to get option label from static options
  if (fieldDef?.options && typeof value === 'string') {
    const option = fieldDef.options.find((o) => o.value === value);
    if (option) return option.label;
  }

  return String(value);
}

// Compact action labels for summary display (design spec)
const COMPACT_ACTION_LABELS: Partial<Record<ActionType, string>> = {
  notify: 'Notify',
  log_only: 'Log',
  adjust_trust: 'Adjust trust',
  set_trust: 'Set trust',
  reset_trust: 'Reset trust',
  kill_stream: 'Kill stream',
  message_client: 'Message',
  disable_user: 'Disable user',
};

/**
 * Format the primary action for summary display.
 */
function formatAction(action: Action): string {
  // Use compact label if available, otherwise fall back to definition
  const compactLabel = COMPACT_ACTION_LABELS[action.type];
  if (compactLabel) return compactLabel;

  const def = ACTION_DEFINITIONS[action.type];
  return def?.label ?? action.type;
}

/**
 * Format actions array to a summary string.
 */
function formatActions(actions: Action[]): string {
  if (!actions.length) return 'No action';

  const first = actions[0];
  const second = actions[1];

  if (!first) return 'No action';

  if (actions.length === 1) {
    return formatAction(first);
  }

  if (actions.length === 2 && second) {
    return `${formatAction(first)}, ${formatAction(second)}`;
  }

  // More than 2: show first + count
  return `${formatAction(first)} (+${actions.length - 1} more)`;
}

/**
 * Generate a complete summary string for a V2 rule.
 *
 * Format: "Inactive > 180 days (+2 conditions) → Warning"
 */
export function getRuleSummary(
  rule: Rule,
  filterOptions?: RulesFilterOptions,
  unitSystem?: UnitSystem
): string {
  // Conditions part
  const firstCondition = getFirstCondition(rule);
  const totalConditions = countTotalConditions(rule);

  let conditionsPart: string;
  if (!firstCondition) {
    conditionsPart = 'No conditions';
  } else {
    conditionsPart = formatCondition(firstCondition, filterOptions, unitSystem);
    if (totalConditions > 1) {
      conditionsPart += ` (+${totalConditions - 1} more)`;
    }
  }

  // Actions part
  const actions = rule.actions?.actions ?? [];
  const actionsPart = formatActions(actions);

  return `${conditionsPart} → ${actionsPart}`;
}
