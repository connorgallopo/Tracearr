/**
 * Condition field definitions for the Rules Builder V2.
 *
 * This is the single source of truth for field metadata in the UI.
 * All condition-related components reference this registry.
 */

import type {
  ConditionField,
  Operator,
  DeviceType,
  Platform,
  VideoResolution,
} from '@tracearr/shared';

// Field categories for organizing in the UI
export type FieldCategory =
  | 'session_behavior'
  | 'stream_quality'
  | 'user_attributes'
  | 'device_client'
  | 'network_location'
  | 'scope';

// Value input types for rendering the appropriate component
export type ValueInputType = 'number' | 'boolean' | 'text' | 'select' | 'multi-select' | 'cidr';

// Operator groups for reuse
const COMPARISON_OPERATORS: Operator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'];
const EQUALITY_OPERATORS: Operator[] = ['eq', 'neq'];
const ARRAY_OPERATORS: Operator[] = ['in', 'not_in'];
const STRING_OPERATORS: Operator[] = ['contains', 'not_contains'];

// Human-readable operator labels
export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: 'equals',
  neq: 'not equals',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  in: 'is one of',
  not_in: 'is not one of',
  contains: 'contains',
  not_contains: 'does not contain',
};

// Shared option definitions
export const DEVICE_TYPE_OPTIONS: { value: DeviceType; label: string }[] = [
  { value: 'mobile', label: 'Mobile' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'tv', label: 'TV' },
  { value: 'desktop', label: 'Desktop' },
  { value: 'browser', label: 'Browser' },
  { value: 'unknown', label: 'Unknown' },
];

export const PLATFORM_OPTIONS: { value: Platform; label: string }[] = [
  { value: 'ios', label: 'iOS' },
  { value: 'android', label: 'Android' },
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
  { value: 'tvos', label: 'tvOS' },
  { value: 'androidtv', label: 'Android TV' },
  { value: 'roku', label: 'Roku' },
  { value: 'webos', label: 'webOS' },
  { value: 'tizen', label: 'Tizen' },
  { value: 'unknown', label: 'Unknown' },
];

export const RESOLUTION_OPTIONS: { value: VideoResolution; label: string }[] = [
  { value: '4K', label: '4K (2160p)' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
  { value: 'SD', label: 'SD' },
  { value: 'unknown', label: 'Unknown' },
];

export const MEDIA_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'movie', label: 'Movie' },
  { value: 'episode', label: 'TV Episode' },
  { value: 'track', label: 'Music' },
  { value: 'photo', label: 'Photo' },
  { value: 'live', label: 'Live TV' },
  { value: 'trailer', label: 'Trailer' },
];

// Field definition interface
export interface FieldDefinition {
  field: ConditionField;
  label: string;
  description: string;
  category: FieldCategory;
  operators: Operator[];
  valueType: ValueInputType;
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  hasWindowHours?: boolean; // For velocity-type fields
  hasExcludeSameDevice?: boolean; // For cross-session comparison fields
  hasExcludeSameIp?: boolean; // For detecting different-IP concurrent streams
  hasCountDeviceTypes?: boolean; // For limiting which device types are counted
  hidden?: boolean; // Hide from UI (e.g., not yet implemented in backend)
}

// Category labels for UI grouping
export const CATEGORY_LABELS: Record<FieldCategory, string> = {
  session_behavior: 'Session Behavior',
  stream_quality: 'Stream Quality',
  user_attributes: 'User Attributes',
  device_client: 'Device & Client',
  network_location: 'Network & Location',
  scope: 'Scope',
};

// The main field definitions registry
export const FIELD_DEFINITIONS: Record<ConditionField, FieldDefinition> = {
  // Session Behavior
  concurrent_streams: {
    field: 'concurrent_streams',
    label: 'Concurrent Streams',
    description: 'Number of active streams from the same user',
    category: 'session_behavior',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    min: 1,
    max: 100,
    step: 1,
    hasExcludeSameDevice: true,
    hasExcludeSameIp: true,
    hasCountDeviceTypes: true,
  },
  active_session_distance_km: {
    field: 'active_session_distance_km',
    label: 'Distance Between Sessions',
    description: 'Distance in km between simultaneous sessions',
    category: 'session_behavior',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'km',
    min: 0,
    step: 10,
    hasExcludeSameDevice: true,
  },
  travel_speed_kmh: {
    field: 'travel_speed_kmh',
    label: 'Travel Speed',
    description: 'Calculated travel speed between locations',
    category: 'session_behavior',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'km/h',
    min: 0,
    step: 50,
    hasExcludeSameDevice: true,
  },
  unique_ips_in_window: {
    field: 'unique_ips_in_window',
    label: 'Unique IPs in Window',
    description: 'Number of unique IP addresses in time window',
    category: 'session_behavior',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    min: 1,
    max: 100,
    step: 1,
    hasWindowHours: true,
  },
  unique_devices_in_window: {
    field: 'unique_devices_in_window',
    label: 'Unique Devices in Window',
    description: 'Number of unique devices in time window',
    category: 'session_behavior',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    min: 1,
    max: 100,
    step: 1,
    hasWindowHours: true,
  },
  inactive_days: {
    field: 'inactive_days',
    label: 'Days Inactive',
    description: 'Days since last activity',
    category: 'session_behavior',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'days',
    min: 0,
    step: 1,
  },
  current_pause_minutes: {
    field: 'current_pause_minutes',
    label: 'Current Pause Duration',
    description: 'How long the session has been continuously paused',
    category: 'session_behavior',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'minutes',
    min: 1,
    step: 5,
  },
  total_pause_minutes: {
    field: 'total_pause_minutes',
    label: 'Total Pause Duration',
    description: 'Total accumulated pause time across all pause/resume cycles',
    category: 'session_behavior',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'minutes',
    min: 1,
    step: 5,
  },

  // Stream Quality
  source_resolution: {
    field: 'source_resolution',
    label: 'Source Resolution',
    description: 'Original media resolution',
    category: 'stream_quality',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'select',
    options: RESOLUTION_OPTIONS,
  },
  output_resolution: {
    field: 'output_resolution',
    label: 'Output Resolution',
    description: 'Transcoded/delivered resolution',
    category: 'stream_quality',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'select',
    options: RESOLUTION_OPTIONS,
  },
  is_transcoding: {
    field: 'is_transcoding',
    label: 'Is Transcoding',
    description: 'Whether video or audio streams are being transcoded',
    category: 'stream_quality',
    operators: EQUALITY_OPERATORS,
    valueType: 'select',
    options: [
      { value: 'video', label: 'Video' },
      { value: 'audio', label: 'Audio' },
      { value: 'video_or_audio', label: 'Video or Audio' },
      { value: 'neither', label: 'Neither (Direct Play)' },
    ],
  },
  is_transcode_downgrade: {
    field: 'is_transcode_downgrade',
    label: 'Transcode Downgrade',
    description: 'Output resolution is lower than source',
    category: 'stream_quality',
    operators: EQUALITY_OPERATORS,
    valueType: 'boolean',
  },
  source_bitrate_mbps: {
    field: 'source_bitrate_mbps',
    label: 'Source Bitrate',
    description: 'Original media bitrate',
    category: 'stream_quality',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'Mbps',
    min: 0,
    step: 1,
  },

  // User Attributes
  user_id: {
    field: 'user_id',
    label: 'User',
    description: 'Specific user(s) by ID',
    category: 'user_attributes',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multi-select',
    placeholder: 'Select users...',
  },
  trust_score: {
    field: 'trust_score',
    label: 'Trust Score',
    description: "User's trust score (0-100)",
    category: 'user_attributes',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    min: 0,
    max: 100,
    step: 1,
  },
  account_age_days: {
    field: 'account_age_days',
    label: 'Account Age',
    description: 'Days since account creation',
    category: 'user_attributes',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'days',
    min: 0,
    step: 1,
  },

  // Device & Client
  device_type: {
    field: 'device_type',
    label: 'Device Type',
    description: 'Type of device used',
    category: 'device_client',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multi-select',
    options: DEVICE_TYPE_OPTIONS,
  },
  client_name: {
    field: 'client_name',
    label: 'Client/Player',
    description: 'Media player application',
    category: 'device_client',
    operators: [...EQUALITY_OPERATORS, ...STRING_OPERATORS],
    valueType: 'text',
    placeholder: 'e.g., Plex for iOS',
  },
  platform: {
    field: 'platform',
    label: 'Platform/OS',
    description: 'Operating system',
    category: 'device_client',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multi-select',
    options: PLATFORM_OPTIONS,
  },

  // Network & Location
  is_local_network: {
    field: 'is_local_network',
    label: 'Local Network',
    description: 'Streaming from local network',
    category: 'network_location',
    operators: EQUALITY_OPERATORS,
    valueType: 'boolean',
  },
  country: {
    field: 'country',
    label: 'Country',
    description: 'Geographic country',
    category: 'network_location',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multi-select',
    placeholder: 'Select countries...',
  },
  ip_in_range: {
    field: 'ip_in_range',
    label: 'IP Range',
    description: 'IP address in CIDR range (IPv4 or IPv6)',
    category: 'network_location',
    operators: EQUALITY_OPERATORS,
    valueType: 'cidr',
    placeholder: 'e.g., 192.168.1.0/24 or 2001:db8:abcd:7800::/64',
  },

  // Scope
  server_id: {
    field: 'server_id',
    label: 'Server',
    description: 'Specific media server',
    category: 'scope',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multi-select',
    placeholder: 'Select servers...',
  },
  library_id: {
    field: 'library_id',
    label: 'Library',
    description: 'Specific library',
    category: 'scope',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multi-select',
    placeholder: 'Select libraries...',
    hidden: true, // TODO: Backend doesn't support library_id yet
  },
  media_type: {
    field: 'media_type',
    label: 'Media Type',
    description: 'Type of content',
    category: 'scope',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multi-select',
    options: MEDIA_TYPE_OPTIONS,
  },
};

// Helper functions

/**
 * Get field definition by field name
 */
export function getFieldDefinition(field: ConditionField): FieldDefinition {
  return FIELD_DEFINITIONS[field];
}

/**
 * Get all fields grouped by category
 */
export function getFieldsByCategory(): Record<FieldCategory, FieldDefinition[]> {
  const grouped: Record<FieldCategory, FieldDefinition[]> = {
    session_behavior: [],
    stream_quality: [],
    user_attributes: [],
    device_client: [],
    network_location: [],
    scope: [],
  };

  for (const def of Object.values(FIELD_DEFINITIONS)) {
    if (!def.hidden) {
      grouped[def.category].push(def);
    }
  }

  return grouped;
}

/**
 * Get available operators for a field
 */
export function getOperatorsForField(field: ConditionField): Operator[] {
  return FIELD_DEFINITIONS[field]?.operators ?? EQUALITY_OPERATORS;
}

/**
 * Check if an operator works with arrays (in/not_in)
 */
export function isArrayOperator(operator: Operator): boolean {
  return operator === 'in' || operator === 'not_in';
}

/**
 * Get the default value for a field
 */
export function getDefaultValueForField(
  field: ConditionField
): string | number | boolean | string[] {
  const def = FIELD_DEFINITIONS[field];
  if (!def) return '';

  switch (def.valueType) {
    case 'number':
      return def.min ?? 0;
    case 'boolean':
      return true;
    case 'multi-select':
      return [];
    case 'select':
      return def.options?.[0]?.value ?? '';
    default:
      return '';
  }
}

/**
 * Get the default operator for a field
 */
export function getDefaultOperatorForField(field: ConditionField): Operator {
  const def = FIELD_DEFINITIONS[field];
  if (!def) return 'eq';

  // For comparison fields, default to 'gte' (more common use case)
  if (def.valueType === 'number' && def.operators.includes('gte')) {
    return 'gte';
  }

  // For arrays, default to 'in'
  if (
    (def.valueType === 'multi-select' || def.valueType === 'select') &&
    def.operators.includes('in')
  ) {
    return 'in';
  }

  // Otherwise use first available operator
  return def.operators[0] ?? 'eq';
}
