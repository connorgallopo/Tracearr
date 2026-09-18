import { z } from 'zod';
import { DYNAMIC_RANGE_TOKENS } from '../dynamicRange.js';
import { RESOLUTION_LABELS } from '../resolution.js';
import { contextSupplies, type TriggerContext } from './triggers.js';

// Operators
export const comparisonOperatorSchema = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
export const arrayOperatorSchema = z.enum(['in', 'not_in']);
export const stringOperatorSchema = z.enum(['contains', 'not_contains']);
export const operatorSchema = z.union([
  comparisonOperatorSchema,
  arrayOperatorSchema,
  stringOperatorSchema,
]);

// Condition fields by category
export const sessionBehaviorFieldSchema = z.enum([
  'concurrent_streams',
  'active_session_distance_km',
  'travel_speed_kmh',
  'unique_ips_in_window',
  'unique_devices_in_window',
  'inactive_days',
  'current_pause_minutes',
  'total_pause_minutes',
]);

export const streamQualityFieldSchema = z.enum([
  'source_resolution',
  'output_resolution',
  'is_transcoding',
  'is_transcode_downgrade',
  'source_bitrate_mbps',
]);

export const transcodingConditionValueSchema = z.enum([
  'video',
  'audio',
  'video_or_audio',
  'neither',
]);

export const userAttributeFieldSchema = z.enum(['user_id', 'trust_score', 'account_age_days']);

export const deviceClientFieldSchema = z.enum(['device_type', 'client_name', 'platform']);

export const networkLocationFieldSchema = z.enum(['is_local_network', 'country', 'ip_in_range']);

export const scopeFieldSchema = z.enum(['server_id', 'media_type']);

/** The `_after` fields read the value a library item ends the sync with. */
export const mediaFieldSchema = z.enum([
  'library_item_type',
  'library_name',
  'resolution_after',
  'dynamic_range_after',
  'video_codec_after',
  'audio_channels_after',
  'file_size_after',
]);

export const conditionFieldSchema = z.union([
  sessionBehaviorFieldSchema,
  streamQualityFieldSchema,
  userAttributeFieldSchema,
  deviceClientFieldSchema,
  networkLocationFieldSchema,
  scopeFieldSchema,
  mediaFieldSchema,
]);

// Enums
export const videoResolutionSchema = z.enum([
  '8K',
  '4K',
  '1440p',
  '1080p',
  '720p',
  '480p',
  'SD',
  'unknown',
]);
// A server older than the release listed accepts the value, then ranks it as 0 and folds
// the stream's own 1440p or 8K into 4K, so the condition matches the wrong streams.
const RESOLUTION_INTRODUCED_IN = { '8K': '2.4.0', '1440p': '2.4.0' };

export const deviceTypeSchema = z.enum(['mobile', 'tablet', 'tv', 'desktop', 'browser', 'unknown']);
export const platformSchema = z.enum([
  'ios',
  'android',
  'windows',
  'macos',
  'linux',
  'tvos',
  'androidtv',
  'roku',
  'webos',
  'tizen',
  'unknown',
]);
export const mediaTypeEnumSchema = z.enum([
  'movie',
  'episode',
  'track',
  'photo',
  'live',
  'trailer',
]);
/** library_items.media_type, which is a wider vocabulary than a session's mediaType. */
export const libraryItemTypeSchema = z.enum([
  'movie',
  'show',
  'season',
  'episode',
  'artist',
  'album',
  'track',
  'photo',
]);
// Condition value
export const conditionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
]);

// Condition and action nodes carry these; zod would strip them from a saved rule otherwise.
export const nodeFieldsShape = {
  id: z.uuid().optional(),
  enabled: z.boolean().optional(),
};

// Single condition
export const conditionSchema = z.object({
  ...nodeFieldsShape,
  field: conditionFieldSchema,
  operator: operatorSchema,
  value: conditionValueSchema,
  params: z
    .object({
      // The history fetch sizes itself from the largest active window; 168h
      // (7 days) bounds that fetch and matches the sessions hypertable's
      // compression boundary.
      window_hours: z
        .number()
        .int()
        .positive()
        .max(168, 'Window cannot exceed 168 hours (7 days)')
        .optional(),
      exclude_same_device: z.boolean().optional(),
      exclude_same_ip: z.boolean().optional(),
      count_device_types: z.array(deviceTypeSchema).optional(),
    })
    .optional(),
});

// Condition group; `match` names the logic, and a group saved before it existed reads as 'any'.
export const conditionGroupSchema = z.object({
  ...nodeFieldsShape,
  match: z.enum(['all', 'any']).optional(),
  conditions: z.array(conditionSchema).min(1),
});

// Rule conditions (AND logic between groups)
export const automationConditionsSchema = z.object({
  groups: z.array(conditionGroupSchema),
});

export type ComparisonOperator = z.infer<typeof comparisonOperatorSchema>;
export type ArrayOperator = z.infer<typeof arrayOperatorSchema>;
export type StringOperator = z.infer<typeof stringOperatorSchema>;
export type Operator = z.infer<typeof operatorSchema>;
export type SessionBehaviorField = z.infer<typeof sessionBehaviorFieldSchema>;
export type StreamQualityField = z.infer<typeof streamQualityFieldSchema>;
export type UserAttributeField = z.infer<typeof userAttributeFieldSchema>;
export type DeviceClientField = z.infer<typeof deviceClientFieldSchema>;
export type NetworkLocationField = z.infer<typeof networkLocationFieldSchema>;
export type ScopeField = z.infer<typeof scopeFieldSchema>;
export type MediaField = z.infer<typeof mediaFieldSchema>;
export type LibraryItemType = z.infer<typeof libraryItemTypeSchema>;
export type ConditionField = z.infer<typeof conditionFieldSchema>;
export type TranscodingConditionValue = z.infer<typeof transcodingConditionValueSchema>;
export type VideoResolution = z.infer<typeof videoResolutionSchema>;
export type DeviceType = z.infer<typeof deviceTypeSchema>;
export type Platform = z.infer<typeof platformSchema>;
export type MediaTypeEnum = z.infer<typeof mediaTypeEnumSchema>;
export type ConditionValue = z.infer<typeof conditionValueSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type ConditionGroup = z.infer<typeof conditionGroupSchema>;
/** How a group combines its conditions; a group stored before it existed reads as 'any'. */
export type ConditionMatch = NonNullable<ConditionGroup['match']>;
export type AutomationConditions = z.infer<typeof automationConditionsSchema>;

export type ConditionValueType = 'number' | 'boolean' | 'text' | 'select' | 'multiSelect' | 'cidr';

export interface ConditionFieldDescriptor {
  category:
    | 'session_behavior'
    | 'stream_quality'
    | 'user_attributes'
    | 'device_client'
    | 'network_location'
    | 'scope'
    | 'media';
  /** The narrowest trigger context that can supply this field. */
  requires: TriggerContext;
  operators: readonly Operator[];
  valueType: ConditionValueType;
  options?: readonly string[];
  /** Options the client fetches instead of the catalog carrying them. */
  dynamicSource?: 'users' | 'countries' | 'servers';
  unit?: 'km' | 'kmh' | 'mbps' | 'days' | 'minutes' | 'hours' | 'gb';
  min?: number;
  max?: number;
  step?: number;
  flags: {
    windowHours?: true;
    excludeSameDevice?: true;
    excludeSameIp?: true;
    countDeviceTypes?: true;
  };
  /** Aggregates across every account behind one person when the context carries them. */
  identityAware: boolean;
}

const COMPARISON_OPERATORS = comparisonOperatorSchema.options;
const EQUALITY_OPERATORS = ['eq', 'neq'] as const satisfies readonly Operator[];
const ARRAY_OPERATORS = arrayOperatorSchema.options;
const STRING_OPERATORS = stringOperatorSchema.options;

export const CONDITION_FIELDS: Record<ConditionField, ConditionFieldDescriptor> = {
  concurrent_streams: {
    category: 'session_behavior',
    requires: 'session',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    min: 1,
    max: 100,
    step: 1,
    flags: { excludeSameDevice: true, excludeSameIp: true, countDeviceTypes: true },
    identityAware: true,
  },
  active_session_distance_km: {
    category: 'session_behavior',
    requires: 'session',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'km',
    min: 0,
    step: 10,
    flags: { excludeSameDevice: true },
    identityAware: true,
  },
  travel_speed_kmh: {
    category: 'session_behavior',
    requires: 'session',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'kmh',
    min: 0,
    step: 50,
    flags: { excludeSameDevice: true },
    identityAware: true,
  },
  unique_ips_in_window: {
    category: 'session_behavior',
    requires: 'session',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    min: 1,
    max: 100,
    step: 1,
    flags: { windowHours: true },
    identityAware: true,
  },
  unique_devices_in_window: {
    category: 'session_behavior',
    requires: 'session',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    min: 1,
    max: 100,
    step: 1,
    flags: { windowHours: true },
    identityAware: true,
  },
  inactive_days: {
    category: 'session_behavior',
    requires: 'account',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'days',
    min: 0,
    step: 1,
    flags: {},
    identityAware: false,
  },
  current_pause_minutes: {
    category: 'session_behavior',
    requires: 'session',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'minutes',
    min: 1,
    step: 5,
    flags: {},
    identityAware: false,
  },
  total_pause_minutes: {
    category: 'session_behavior',
    requires: 'session',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'minutes',
    min: 1,
    step: 5,
    flags: {},
    identityAware: false,
  },
  source_resolution: {
    category: 'stream_quality',
    requires: 'session',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'select',
    options: videoResolutionSchema.options,
    flags: {},
    identityAware: false,
  },
  output_resolution: {
    category: 'stream_quality',
    requires: 'session',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'select',
    options: videoResolutionSchema.options,
    flags: {},
    identityAware: false,
  },
  is_transcoding: {
    category: 'stream_quality',
    requires: 'session',
    operators: EQUALITY_OPERATORS,
    valueType: 'select',
    options: transcodingConditionValueSchema.options,
    flags: {},
    identityAware: false,
  },
  is_transcode_downgrade: {
    category: 'stream_quality',
    requires: 'session',
    operators: EQUALITY_OPERATORS,
    valueType: 'boolean',
    flags: {},
    identityAware: false,
  },
  source_bitrate_mbps: {
    category: 'stream_quality',
    requires: 'session',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'mbps',
    min: 0,
    step: 1,
    flags: {},
    identityAware: false,
  },
  user_id: {
    category: 'user_attributes',
    requires: 'account',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multiSelect',
    dynamicSource: 'users',
    flags: {},
    identityAware: false,
  },
  trust_score: {
    category: 'user_attributes',
    requires: 'account',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    min: 0,
    max: 100,
    step: 1,
    flags: {},
    identityAware: false,
  },
  account_age_days: {
    category: 'user_attributes',
    requires: 'account',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'days',
    min: 0,
    step: 1,
    flags: {},
    identityAware: false,
  },
  device_type: {
    category: 'device_client',
    requires: 'session',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multiSelect',
    options: deviceTypeSchema.options,
    flags: {},
    identityAware: false,
  },
  client_name: {
    category: 'device_client',
    requires: 'session',
    operators: [...EQUALITY_OPERATORS, ...STRING_OPERATORS],
    valueType: 'text',
    flags: {},
    identityAware: false,
  },
  platform: {
    category: 'device_client',
    requires: 'session',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multiSelect',
    options: platformSchema.options,
    flags: {},
    identityAware: false,
  },
  is_local_network: {
    category: 'network_location',
    requires: 'session',
    operators: EQUALITY_OPERATORS,
    valueType: 'boolean',
    flags: {},
    identityAware: false,
  },
  country: {
    category: 'network_location',
    requires: 'session',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multiSelect',
    dynamicSource: 'countries',
    flags: {},
    identityAware: false,
  },
  ip_in_range: {
    category: 'network_location',
    requires: 'session',
    operators: EQUALITY_OPERATORS,
    valueType: 'cidr',
    flags: {},
    identityAware: false,
  },
  server_id: {
    category: 'scope',
    requires: 'server',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multiSelect',
    dynamicSource: 'servers',
    flags: {},
    identityAware: false,
  },
  media_type: {
    category: 'scope',
    requires: 'session',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multiSelect',
    options: mediaTypeEnumSchema.options,
    flags: {},
    identityAware: false,
  },
  library_item_type: {
    category: 'media',
    requires: 'media',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multiSelect',
    options: libraryItemTypeSchema.options,
    flags: {},
    identityAware: false,
  },
  library_name: {
    category: 'media',
    requires: 'media',
    operators: [...EQUALITY_OPERATORS, ...STRING_OPERATORS],
    valueType: 'text',
    flags: {},
    identityAware: false,
  },
  resolution_after: {
    category: 'media',
    requires: 'media',
    // Compared by tier rank, so "at least 4K" is one row rather than a list.
    operators: COMPARISON_OPERATORS,
    valueType: 'select',
    options: RESOLUTION_LABELS,
    flags: {},
    identityAware: false,
  },
  dynamic_range_after: {
    category: 'media',
    requires: 'media',
    operators: [...EQUALITY_OPERATORS, ...ARRAY_OPERATORS],
    valueType: 'multiSelect',
    options: DYNAMIC_RANGE_TOKENS,
    flags: {},
    identityAware: false,
  },
  video_codec_after: {
    category: 'media',
    requires: 'media',
    operators: [...EQUALITY_OPERATORS, ...STRING_OPERATORS],
    valueType: 'text',
    flags: {},
    identityAware: false,
  },
  audio_channels_after: {
    category: 'media',
    requires: 'media',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    min: 1,
    max: 16,
    step: 1,
    flags: {},
    identityAware: false,
  },
  file_size_after: {
    category: 'media',
    requires: 'media',
    operators: COMPARISON_OPERATORS,
    valueType: 'number',
    unit: 'gb',
    min: 0,
    step: 1,
    flags: {},
    identityAware: false,
  },
};

/** Values a field gained after 2.2.0, by the release that first evaluates them. */
export const CONDITION_VALUE_INTRODUCED_IN: Partial<
  Record<ConditionField, Record<string, string>>
> = {
  source_resolution: RESOLUTION_INTRODUCED_IN,
  output_resolution: RESOLUTION_INTRODUCED_IN,
};

// Fields whose evaluators aggregate across every server_user id of the same identity.
// One of them is enough for cross-server enforcement to make sense, so the builder
// offers enforceAcrossServers as soon as any condition names one.
export const IDENTITY_AWARE_CONDITION_FIELDS = (
  Object.keys(CONDITION_FIELDS) as ConditionField[]
).filter((field) => CONDITION_FIELDS[field].identityAware);

/** Every field a trigger of this context can supply; a definition with no triggers offers all of them. */
export function fieldsAvailableFor(context: TriggerContext | null): ConditionField[] {
  const fields = Object.keys(CONDITION_FIELDS) as ConditionField[];
  if (context === null) return fields;
  return fields.filter((field) => contextSupplies(context, CONDITION_FIELDS[field].requires));
}
