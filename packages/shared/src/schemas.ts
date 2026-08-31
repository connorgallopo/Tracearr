/**
 * Zod validation schemas for API requests
 */

import { z } from 'zod';
import { isValidTimezone } from './constants.js';
import { listDateBoundSchema, listSortSchema } from './listQuery.js';

// ============================================================================
// Shared Enum Constants
// ============================================================================

/** Server types supported by Tracearr */
const SERVER_TYPES = ['plex', 'jellyfin', 'emby'] as const;
export const serverTypeSchema = z.enum(SERVER_TYPES);
export type ServerType = z.infer<typeof serverTypeSchema>;

/** Media types for content filtering */
const MEDIA_TYPES = ['movie', 'episode', 'track', 'live'] as const;
export const mediaTypeSchema = z.enum(MEDIA_TYPES);
export type MediaType = z.infer<typeof mediaTypeSchema>;

/** Time periods for statistics queries */
const STAT_PERIODS = ['day', 'week', 'month', 'year', 'all', 'custom'] as const;
export const statPeriodSchema = z.enum(STAT_PERIODS);
export type StatPeriod = z.infer<typeof statPeriodSchema>;

// ============================================================================
// Shared Date Validation Refinements
// ============================================================================

/**
 * Refinement: Custom period requires both startDate and endDate
 */
function requireDatesForCustomPeriod(data: {
  period?: string;
  startDate?: string;
  endDate?: string;
}) {
  if (data.period === 'custom') {
    return data.startDate && data.endDate;
  }
  return true;
}

/**
 * Refinement: If dates provided, startDate must be before endDate
 */
function validateDateOrder(data: { startDate?: string; endDate?: string }) {
  if (data.startDate && data.endDate) {
    return new Date(data.startDate) < new Date(data.endDate);
  }
  return true;
}

/** Standard date validation refinements for stats queries */
export const dateValidationRefinements = {
  customPeriodRequiresDates: {
    refinement: requireDatesForCustomPeriod,
    message: 'Custom period requires startDate and endDate',
  },
  startBeforeEnd: {
    refinement: validateDateOrder,
    message: 'startDate must be before endDate',
  },
};

// ============================================================================
// Common Schemas
// ============================================================================

export const uuidSchema = z.uuid();

// Accepts either a single UUID string or an array of UUID strings from query params
export const serverIdsQuerySchema = z
  .union([uuidSchema.transform((id) => [id]), z.array(uuidSchema)])
  .optional();
// Same shape as serverIdsQuerySchema, used for identity (users.id) filters
export const userIdsQuerySchema = z
  .union([uuidSchema.transform((id) => [id]), z.array(uuidSchema)])
  .optional();

// The server-scope filter every multi-server endpoint accepts.
export const serverIdFilterSchema = z.object({
  serverId: uuidSchema.optional(),
  serverIds: serverIdsQuerySchema,
});

// `${serverId}:${libraryId}` composite key for the catalog Library filter -
// a library id is only unique within its own server, so the filter has to
// pin both.
export const libraryKeySchema = z.string().refine((value) => {
  const separator = value.indexOf(':');
  if (separator === -1) return false;
  const serverId = value.slice(0, separator);
  const libraryId = value.slice(separator + 1);
  return uuidSchema.safeParse(serverId).success && libraryId.length >= 1 && libraryId.length <= 100;
}, 'Invalid library key');
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// Parses boolean query params - z.coerce.boolean() treats "false" as truthy
export const booleanStringSchema = z
  .union([z.boolean(), z.string()])
  .transform((val) => (typeof val === 'boolean' ? val : val === 'true'));

// IANA timezone string validation (e.g., 'America/Los_Angeles', 'Europe/London')
// Uses shared isValidTimezone helper which validates via Intl API
export const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(isValidTimezone, { message: 'Invalid IANA timezone identifier' })
  .optional();

// ============================================================================
// Auth Schemas
// ============================================================================

export const loginSchema = z.object({
  serverType: serverTypeSchema,
  returnUrl: z.url().optional(),
});

export const callbackSchema = z.object({
  code: z.string().optional(),
  token: z.string().optional(),
  serverType: serverTypeSchema,
});

// ============================================================================
// Server Schemas
// ============================================================================

export const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  type: serverTypeSchema,
  url: z.url(),
  token: z.string().min(1),
});

export const serverIdParamSchema = z.object({
  id: uuidSchema,
});

export const reorderServersSchema = z.object({
  servers: z.array(
    z.object({
      id: uuidSchema,
      displayOrder: z.number().int().min(0),
    })
  ),
});

export const updateServerSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    url: z.url().optional(),
    clientIdentifier: z.string().optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a valid hex color (e.g. #3b82f6)')
      .optional()
      .nullable(),
  })
  .refine((data) => data.name !== undefined || data.url !== undefined || data.color !== undefined, {
    message: 'At least one of name, url, or color is required',
  });

// ============================================================================
// User Schemas
// ============================================================================

export const updateUserSchema = z.object({
  allowGuest: z.boolean().optional(),
  trustScore: z.number().int().min(0).max(100).optional(),
});

export const updateUserIdentitySchema = z.object({
  name: z.string().max(255).nullable().optional(),
});

export type UpdateUserIdentityInput = z.infer<typeof updateUserIdentitySchema>;

export const userIdParamSchema = z.object({
  id: uuidSchema,
});

// scope=identity expands a per-account query to every account the caller can
// access under the same person (identity). Absent = today's single-account
// behavior, unchanged.
export const identityScopeQuerySchema = z.object({
  scope: z.enum(['identity']).optional(),
});
export type IdentityScopeQuery = z.infer<typeof identityScopeQuerySchema>;

export const identityScopedPaginationSchema = paginationSchema.extend({
  scope: z.enum(['identity']).optional(),
});

export const mergeUsersBodySchema = z.object({
  targetUserId: uuidSchema,
  confirmSameServerCombine: z.boolean().default(false),
});
export type MergeUsersBody = z.infer<typeof mergeUsersBodySchema>;

export const mergeUserParamSchema = z.object({ id: uuidSchema });
export const splitServerUserParamSchema = z.object({ id: uuidSchema });

export const USER_SORT_FIELDS = ['username', 'trustScore', 'joinedAt', 'lastActivityAt'] as const;
export const userSortFieldSchema = z.enum(USER_SORT_FIELDS);
export type UserSortField = z.infer<typeof userSortFieldSchema>;

/**
 * The roster filter set, shared by GET /users and POST /users/bulk/reset-trust.
 *
 * Both endpoints resolve their row set from this one schema, so a bulk action
 * can never reach further than the table showed. Adding a filter to the list
 * query alone is exactly how "Select all 3 users" turns into resetting every
 * account on the server: z.object strips unknown keys, so the bulk endpoint
 * would drop the narrowing filter silently rather than reject it.
 */
export const userRosterFilterSchema = serverIdFilterSchema.extend({
  includeRemoved: booleanStringSchema.default(false),
  search: z.string().trim().min(1).max(100).optional(),
  /**
   * Identities holding an ACTIVE account on every server listed.
   *
   * This is a property of the person ("who has access to both Plex and the 4K
   * server"), not a view scope. The global server selector already scopes which
   * servers' data is on screen; this asks a different question and is evaluated
   * against the caller's full permission scope, so it still answers while the
   * view is narrowed to one server.
   */
  hasAccessTo: serverIdsQuerySchema,
  // Identity-level bounds: earliest account join, latest account activity.
  joinedAfter: listDateBoundSchema,
  joinedBefore: listDateBoundSchema,
  activeAfter: listDateBoundSchema,
  activeBefore: listDateBoundSchema,
});
export type UserRosterFilters = z.infer<typeof userRosterFilterSchema>;

export const userListQuerySchema = paginationSchema
  .extend(userRosterFilterSchema.shape)
  .extend(listSortSchema(USER_SORT_FIELDS).shape);

export const bulkResetTrustBodySchema = z.object({
  ids: z.array(uuidSchema).max(1000).optional(),
  selectAll: z.boolean().optional(),
  filters: userRosterFilterSchema.optional(),
});

// ============================================================================
// Session Schemas
// ============================================================================

export const sessionQuerySchema = paginationSchema.extend({
  serverUserId: uuidSchema.optional(),
  serverId: uuidSchema.optional(),
  state: z.enum(['playing', 'paused', 'stopped']).optional(),
  mediaType: mediaTypeSchema.optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

/**
 * Enhanced history query schema with comprehensive filtering for the History page.
 * Supports cursor-based pagination for efficient infinite scroll and
 * all available session fields for filtering.
 */
const commaSeparatedArray = (schema: z.ZodType) =>
  z
    .union([schema.array(), z.string().transform((s) => (s ? s.split(',') : []))])
    .optional()
    .transform((arr) => (arr && arr.length > 0 ? arr : undefined));

export const historyQuerySchema = z.object({
  // Pagination - cursor-based for infinite scroll (more efficient than offset for large datasets)
  cursor: z.string().optional(), // Composite: `${startedAt.getTime()}_${playId}`
  pageSize: z.coerce.number().int().positive().max(100).default(50),

  // User filter - supports multi-select (comma-separated UUIDs in query string)
  serverUserIds: commaSeparatedArray(uuidSchema),

  // Server filter - serverIds takes precedence over serverId when both are provided
  serverId: uuidSchema.optional(),
  serverIds: serverIdsQuerySchema,
  state: z.enum(['playing', 'paused', 'stopped']).optional(),

  // Media type filter - supports multi-select
  mediaTypes: commaSeparatedArray(mediaTypeSchema),

  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),

  // Title/content search (ILIKE on mediaTitle and grandparentTitle)
  search: z.string().max(200).optional(),

  // Platform filter - supports multi-select (comma-separated in query string)
  platforms: commaSeparatedArray(z.string().max(100)),
  product: z.string().max(255).optional(), // Plex for Windows, Jellyfin Web
  device: z.string().max(255).optional(), // iPhone, Android TV
  playerName: z.string().max(255).optional(), // Device friendly name

  // Network/location filters
  ipAddress: z.string().max(45).optional(), // Exact IP match
  // Country filter - supports multi-select (comma-separated in query string)
  geoCountries: commaSeparatedArray(z.string().max(100)),
  geoCity: z.string().max(255).optional(), // City name
  geoRegion: z.string().max(255).optional(), // State/province

  transcodeDecisions: commaSeparatedArray(z.enum(['directplay', 'copy', 'transcode'])),

  // Status filters
  watched: booleanStringSchema.optional(), // 85%+ completion
  excludeShortSessions: booleanStringSchema.optional(), // Exclude <120s sessions

  // Sorting
  orderBy: z.enum(['startedAt', 'durationMs', 'mediaTitle']).default('startedAt'),
  orderDir: z.enum(['asc', 'desc']).default('desc'),
});

// Aggregates query - same filters as history but without sorting/pagination
// Used for separate aggregates endpoint so sorting changes don't reload stats
export const historyAggregatesQuerySchema = historyQuerySchema.omit({
  cursor: true,
  pageSize: true,
  orderBy: true,
  orderDir: true,
});

// Filter options query - scoping params for /sessions/filter-options dropdowns
export const filterOptionsQuerySchema = z
  .object({
    serverId: uuidSchema.optional(),
    serverIds: serverIdsQuerySchema,
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    includeAllCountries: booleanStringSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return data.startDate <= data.endDate;
      }
      return true;
    },
    { message: 'startDate must be before endDate' }
  );

export const sessionIdParamSchema = z.object({
  id: uuidSchema,
});

// Session termination schema
export const terminateSessionBodySchema = z.object({
  /** Optional message to display to user (Plex only, ignored by Jellyfin/Emby) */
  reason: z.string().max(500).optional(),
});

// ============================================================================
// Rule Schemas
// ============================================================================

export const impossibleTravelParamsSchema = z.object({
  maxSpeedKmh: z.number().positive().default(500),
  ignoreVpnRanges: z.boolean().optional(),
});

export const simultaneousLocationsParamsSchema = z.object({
  minDistanceKm: z.number().positive().default(100),
});

export const deviceVelocityParamsSchema = z.object({
  maxIps: z.number().int().positive().default(5),
  windowHours: z.number().int().positive().default(24),
});

export const concurrentStreamsParamsSchema = z.object({
  maxStreams: z.number().int().positive().default(3),
});

export const geoRestrictionParamsSchema = z.object({
  mode: z.enum(['blocklist', 'allowlist']).default('blocklist'),
  countries: z.array(z.string().length(2)).default([]),
});

export const accountInactivityParamsSchema = z.object({
  inactivityValue: z.number().int().positive().default(30),
  inactivityUnit: z.enum(['days', 'weeks', 'months']).default('days'),
});

// ============================================
// Rules Builder V2 - Validation Schemas
// ============================================

// The condition and action contract lives in ./automations; re-exported here so
// importers keep the path they already use.
export {
  comparisonOperatorSchema,
  arrayOperatorSchema,
  stringOperatorSchema,
  operatorSchema,
  sessionBehaviorFieldSchema,
  streamQualityFieldSchema,
  transcodingConditionValueSchema,
  userAttributeFieldSchema,
  deviceClientFieldSchema,
  networkLocationFieldSchema,
  scopeFieldSchema,
  conditionFieldSchema,
  videoResolutionSchema,
  deviceTypeSchema,
  platformSchema,
  mediaTypeEnumSchema,
  conditionValueSchema,
  conditionSchema,
  conditionGroupSchema,
  automationConditionsSchema,
} from './automations/conditions.js';
export type {
  ComparisonOperator,
  ArrayOperator,
  StringOperator,
  Operator,
  SessionBehaviorField,
  StreamQualityField,
  UserAttributeField,
  DeviceClientField,
  NetworkLocationField,
  ScopeField,
  ConditionField,
  VideoResolution,
  DeviceType,
  Platform,
  MediaTypeEnum,
  ConditionValue,
  Condition,
  ConditionGroup,
  AutomationConditions,
} from './automations/conditions.js';
export {
  sendActionSchema,
  trustActionSchema,
  sessionTargetSchema,
  killStreamActionSchema,
  messageClientActionSchema,
  actionSchema,
  actionTypeSchema,
  automationActionsSchema,
} from './automations/actions.js';
export type {
  SessionTarget,
  ActionType,
  SendAction,
  TrustAction,
  KillStreamAction,
  MessageClientAction,
  Action,
  AutomationActions,
} from './automations/actions.js';
export const violationSeveritySchema = z.enum(['low', 'warning', 'high']);

// An automation may be scoped to at most one of server, account, or person.
export function hasAtMostOneScope(data: {
  serverId?: string | null;
  serverUserId?: string | null;
  userId?: string | null;
}) {
  return [data.serverId, data.serverUserId, data.userId].filter((v) => v != null).length <= 1;
}

export const AUTOMATION_SCOPE_ERROR_MESSAGE =
  'An automation can only be scoped to one of server, account, or person';

export const scopeRefinement = {
  message: AUTOMATION_SCOPE_ERROR_MESSAGE,
} as const;

// A server-scoped automation detects on that server's sessions only; enforcing its
// actions across every server would kill sessions it cannot see.
export function scopeAllowsCrossServerEnforcement(data: {
  serverId?: string | null;
  enforceAcrossServers?: boolean;
}) {
  return !(data.serverId != null && data.enforceAcrossServers === true);
}

export const AUTOMATION_CROSS_SERVER_ENFORCEMENT_ERROR_MESSAGE =
  'A server-scoped automation cannot enforce actions across all servers';

export const crossServerEnforcementRefinement = {
  message: AUTOMATION_CROSS_SERVER_ENFORCEMENT_ERROR_MESSAGE,
} as const;

// Bulk operations schemas
export const bulkUpdateAutomationsSchema = z.object({
  ids: z.array(uuidSchema).min(1, 'At least one automation ID is required'),
  isActive: z.boolean(),
});

export const bulkDeleteAutomationsSchema = z.object({
  ids: z.array(uuidSchema).min(1, 'At least one automation ID is required'),
});

// ============================================================================
// Violation Schemas
// ============================================================================

export const VIOLATION_SORT_FIELDS = ['createdAt', 'severity', 'user', 'rule'] as const;
export const violationSortFieldSchema = z.enum(VIOLATION_SORT_FIELDS);
export type ViolationSortField = z.infer<typeof violationSortFieldSchema>;

/**
 * The violations roster filter set, shared by GET /violations and both bulk
 * endpoints.
 *
 * All three resolve their row set from this one schema, so a bulk action can
 * never reach past what the table showed. The bulk body used to carry a
 * narrower copy that omitted ruleId, serverUserId and the date bounds: z.object
 * strips unknown keys, so filtering the table to one rule and one week and
 * hitting "select all" dismissed every violation on the server and reversed
 * their trust adjustments.
 */
export const violationRosterFilterSchema = serverIdFilterSchema.extend({
  serverUserId: uuidSchema.optional(),
  // Identity-level filter: matches violations from every server account under
  // this person (users.id), scoped to the caller's accessible servers.
  // userIds is the multi-select form; userId stays supported for back-compat.
  userId: uuidSchema.optional(),
  userIds: userIdsQuerySchema,
  ruleId: uuidSchema.optional(),
  severity: z.enum(['low', 'warning', 'high']).optional(),
  acknowledged: booleanStringSchema.optional(),
  // Calendar days, resolved to half-open UTC bounds so endDate includes the
  // whole day it names.
  startDate: listDateBoundSchema,
  endDate: listDateBoundSchema,
});
export type ViolationRosterFilters = z.infer<typeof violationRosterFilterSchema>;

export const violationQuerySchema = paginationSchema
  .extend(violationRosterFilterSchema.shape)
  .extend(listSortSchema(VIOLATION_SORT_FIELDS).shape);

export const violationBulkBodySchema = z.object({
  ids: z.array(uuidSchema).max(1000).optional(),
  selectAll: z.boolean().optional(),
  filters: violationRosterFilterSchema.optional(),
});
export type ViolationBulkBody = z.infer<typeof violationBulkBodySchema>;

export const violationIdParamSchema = z.object({
  id: uuidSchema,
});

// ============================================================================
// Stats Schemas
// ============================================================================

// Dashboard query schema with timezone support
export const dashboardQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  serverIds: serverIdsQuerySchema,
  timezone: timezoneSchema,
});

export const statsQuerySchema = z
  .object({
    period: statPeriodSchema.default('week'),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    serverId: uuidSchema.optional(),
    serverIds: serverIdsQuerySchema,
    timezone: timezoneSchema,
  })
  .refine(dateValidationRefinements.customPeriodRequiresDates.refinement, {
    message: dateValidationRefinements.customPeriodRequiresDates.message,
  })
  .refine(dateValidationRefinements.startBeforeEnd.refinement, {
    message: dateValidationRefinements.startBeforeEnd.message,
  });

// Location stats with full filtering - uses same period system as statsQuerySchema
export const locationStatsQuerySchema = z
  .object({
    period: statPeriodSchema.default('month'),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    serverUserId: uuidSchema.optional(),
    // Additive multi-account filter: when set, takes precedence over serverUserId so a
    // merged person's full history (all their server accounts) can be filtered at once.
    serverUserIds: commaSeparatedArray(uuidSchema),
    serverId: uuidSchema.optional(),
    serverIds: serverIdsQuerySchema,
    mediaType: mediaTypeSchema.optional(),
  })
  .refine(dateValidationRefinements.customPeriodRequiresDates.refinement, {
    message: dateValidationRefinements.customPeriodRequiresDates.message,
  })
  .refine(dateValidationRefinements.startBeforeEnd.refinement, {
    message: dateValidationRefinements.startBeforeEnd.message,
  });

// ============================================================================
// Webhook & Settings Schemas
// ============================================================================

// Unit system enum for display preferences
export const unitSystemSchema = z.enum(['metric', 'imperial']);

const permissiveUrlSchema = z.string().refine(
  (val) => {
    // Must start with http:// or https://
    if (!/^https?:\/\//i.test(val)) return false;
    // Must have something after the protocol
    const afterProtocol = val.replace(/^https?:\/\//i, '');
    if (!afterProtocol || afterProtocol === '/') return false;
    // Check hostname doesn't have whitespace
    const hostPart = afterProtocol.split('/')[0];
    if (!hostPart || /\s/.test(hostPart)) return false;
    return true;
  },
  { message: 'Invalid URL. Must start with http:// or https:// followed by a hostname' }
);

// Nullable URL schema that converts empty strings to null (for clearing fields)
// Auto-prepends http:// if a bare hostname is provided (no protocol)
const nullableUrlSchema = z.preprocess((val) => {
  if (val === '' || val === null || val === undefined) return null;
  const str = String(val).trim();
  if (!str) return null;
  // Auto-prepend http:// if no protocol specified (for convenience)
  if (str && !/^https?:\/\//i.test(str)) {
    return `http://${str}`;
  }
  return str;
}, permissiveUrlSchema.nullable());

// Nullable string schema that converts empty strings to null (for clearing fields)
const nullableStringSchema = (maxLength?: number) =>
  z.preprocess(
    (val) => (val === '' ? null : val),
    maxLength ? z.string().max(maxLength).nullable() : z.string().nullable()
  );

// Settings schemas
export const updateSettingsSchema = z.object({
  allowGuestAccess: z.boolean().optional(),
  // Display preferences
  unitSystem: unitSystemSchema.optional(),
  // Poller settings
  pollerEnabled: z.boolean().optional(),
  pollerIntervalMs: z.number().int().min(5000).max(300000).optional(),
  // GeoIP settings
  usePlexGeoip: z.boolean().optional(),
  // Tautulli integration
  tautulliUrl: nullableUrlSchema.optional(),
  tautulliApiKey: nullableStringSchema().optional(),
  tautulliBasicAuthUsername: nullableStringSchema(255).optional(),
  tautulliBasicAuthPassword: nullableStringSchema(255).optional(),
  // Network/access settings
  externalUrl: nullableUrlSchema.optional(),
  trustProxy: z.boolean().optional(),
  // Tailscale VPN
  tailscaleHostname: z
    .string()
    .max(255)
    .regex(/^[a-zA-Z0-9-]*$/, 'Hostname may only contain letters, numbers, and hyphens')
    .nullable()
    .optional(),
  // Backup settings
  backupScheduleType: z.enum(['disabled', 'daily', 'weekly', 'monthly']).optional(),
  backupScheduleTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format')
    .optional(),
  backupScheduleDayOfWeek: z.number().int().min(0).max(6).optional(),
  backupScheduleDayOfMonth: z.number().int().min(1).max(31).optional(),
  backupRetentionCount: z.number().int().min(1).max(30).optional(),
  // Update checks
  pluginUpdateCheckEnabled: z.boolean().optional(),
  serverUpdateCheckEnabled: z.boolean().optional(),
  // Watch completion thresholds (percent, per media type)
  watchedThresholdMovie: z.number().int().min(1).max(100).optional(),
  watchedThresholdTv: z.number().int().min(1).max(100).optional(),
  watchedThresholdMusic: z.number().int().min(1).max(100).optional(),
  // Public API v2
  publicApiRateLimitPerMinute: z.number().int().min(1).optional(),
  // Media browsing: warm poster caches for a server after its library sync completes
  imagePrecacheEnabled: z.boolean().optional(),
  // Media browsing: server whose poster wins when a title exists on multiple servers
  preferredPosterServerId: z.string().uuid().nullable().optional(),
});

// ============================================================================
// Tailscale Schemas
// ============================================================================

export const tailscaleEnableSchema = z.object({
  hostname: z
    .string()
    .max(63)
    .regex(/^[a-zA-Z0-9-]*$/, 'Hostname may only contain letters, numbers, and hyphens')
    .optional(),
});

export const tailscaleExitNodeSchema = z.object({
  id: z.string().nullable().optional(),
});

// ============================================================================
// Tautulli Import Schemas
// ============================================================================

export const tautulliImportSchema = z.object({
  serverId: uuidSchema, // Which Tracearr server to import into
  overwriteFriendlyNames: z.boolean().optional(), // Whether to overwrite existing identity names
  includeStreamDetails: z.boolean().optional(), // (BETA) Fetch detailed codec/bitrate info via additional API calls
});

// ============================================================================
// Jellystat Import Schemas
// ============================================================================

/**
 * PlayState object from Jellystat backup
 * Uses loose() to allow extra fields that Jellystat may include
 */
export const jellystatPlayStateSchema = z.looseObject({
  IsPaused: z.boolean().nullable().optional(),
  PositionTicks: z.number().nullable().optional(),
  RuntimeTicks: z.number().nullable().optional(),
  Completed: z.boolean().nullable().optional(),
}); // Allow extra fields like IsMuted, VolumeLevel, CanSeek, etc.

/**
 * TranscodingInfo object from Jellystat backup
 * Uses looseObject() to allow extra fields like AudioCodec, VideoCodec, etc.
 */
export const jellystatTranscodingInfoSchema = z
  .looseObject({
    Bitrate: z.number().nullable().optional(),
  }) // Allow extra fields like AudioCodec, VideoCodec, Container, etc.
  .nullable()
  .optional();

/**
 * Individual playback activity record from Jellystat export
 * Uses looseObject() to allow extra fields like ApplicationVersion, MediaStreams, etc.
 */
export const jellystatPlaybackActivitySchema = z.looseObject({
  Id: z.string(),
  UserId: z.string(),
  UserName: z.string().nullable().optional(),
  NowPlayingItemId: z.string(),
  NowPlayingItemName: z.string(),
  SeriesName: z.string().nullable().optional(),
  SeasonId: z.string().nullable().optional(),
  EpisodeId: z.string().nullable().optional(),
  PlaybackDuration: z.union([z.string(), z.number()]), // Can be string or number
  ActivityDateInserted: z.string(), // ISO 8601 timestamp
  PlayMethod: z
    .string()
    .refine(
      (val) => val === 'DirectPlay' || val === 'DirectStream' || val.startsWith('Transcode'),
      {
        message:
          'PlayMethod must be DirectPlay, DirectStream, or Transcode (with optional codec info)',
      }
    )
    .nullable()
    .optional(),
  PlayState: jellystatPlayStateSchema.nullable().optional(),
  TranscodingInfo: jellystatTranscodingInfoSchema,
  RemoteEndPoint: z.string().nullable().optional(),
  Client: z.string().nullable().optional(),
  DeviceName: z.string().nullable().optional(),
  DeviceId: z.string().nullable().optional(),
  IsPaused: z.boolean().nullable().optional(), // Top-level IsPaused (separate from PlayState.IsPaused)
}); // Allow extra fields like ApplicationVersion, MediaStreams, ServerId, etc.

/**
 * Jellystat backup file structure
 * The backup is an array with a single object containing table data
 * Individual activity records are validated separately during import to skip bad records
 */
export const jellystatBackupSchema = z.array(
  z.object({
    jf_playback_activity: z.array(z.unknown()).optional(), // Validate records individually during import
  })
);

/**
 * Request body for Jellystat import (multipart form data is parsed separately)
 */
export const jellystatImportBodySchema = z.object({
  serverId: uuidSchema, // Which Tracearr server to import into
  enrichMedia: z.coerce.boolean().default(true), // Fetch season/episode from Jellyfin API
  updateStreamDetails: z.coerce.boolean().default(false), // Update existing records with stream/transcode data
});

// ============================================================================
// Playback Reporting Import Schemas
// ============================================================================

const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const playbackReportingImportSchema = z.object({
  serverId: uuidSchema,
  timezone: z.string().refine(isValidTimeZone, { message: 'Invalid IANA timezone' }),
  enrichMedia: z.boolean().default(true),
  importFullRange: z.boolean().default(false),
});

export const playbackReportingTestSchema = z.object({
  serverId: uuidSchema,
});

/**
 * Import job status response
 */
export const importJobStatusSchema = z.object({
  jobId: z.string(),
  state: z.enum(['queued', 'active', 'completed', 'failed', 'delayed']),
  progress: z.number().min(0).max(100).optional(),
  result: z
    .object({
      imported: z.number(),
      skipped: z.number(),
      errors: z.number(),
      enriched: z.number().optional(),
    })
    .optional(),
  failedReason: z.string().optional(),
});

// ============================================================================
// Engagement Stats Schemas
// ============================================================================

// Engagement tier enum for validation
export const engagementTierSchema = z.enum([
  'abandoned',
  'sampled',
  'engaged',
  'watched',
  'rewatched',
  'unknown',
]);
export type EngagementTier = z.infer<typeof engagementTierSchema>;

// User behavior type enum for validation
export const userBehaviorTypeSchema = z.enum([
  'inactive',
  'sampler',
  'casual',
  'completionist',
  'rewatcher',
]);
export type UserBehaviorType = z.infer<typeof userBehaviorTypeSchema>;

// Engagement stats query schema - extends base stats query
export const engagementQuerySchema = z
  .object({
    period: statPeriodSchema.default('week'),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    serverId: uuidSchema.optional(),
    serverIds: serverIdsQuerySchema,
    timezone: timezoneSchema,
    // Engagement-specific filters
    mediaType: mediaTypeSchema.optional(),
    limit: z.coerce.number().int().positive().max(100).default(10),
  })
  .refine(dateValidationRefinements.customPeriodRequiresDates.refinement, {
    message: dateValidationRefinements.customPeriodRequiresDates.message,
  })
  .refine(dateValidationRefinements.startBeforeEnd.refinement, {
    message: dateValidationRefinements.startBeforeEnd.message,
  });

// Show stats query schema
export const showsQuerySchema = z
  .object({
    period: statPeriodSchema.default('month'),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    serverId: uuidSchema.optional(),
    serverIds: serverIdsQuerySchema,
    timezone: timezoneSchema,
    limit: z.coerce.number().int().positive().max(100).default(20),
    orderBy: z
      .enum(['totalEpisodeViews', 'totalWatchHours', 'bingeScore', 'uniqueViewers'])
      .default('totalEpisodeViews'),
  })
  .refine(dateValidationRefinements.customPeriodRequiresDates.refinement, {
    message: dateValidationRefinements.customPeriodRequiresDates.message,
  })
  .refine(dateValidationRefinements.startBeforeEnd.refinement, {
    message: dateValidationRefinements.startBeforeEnd.message,
  });

// ============================================================================
// Library Stats Schemas
// ============================================================================

// Library stats query schema
export const libraryStatsQuerySchema = z.object({
  serverId: z.uuid().optional(),
  serverIds: serverIdsQuerySchema,
  libraryId: z.uuid().optional(),
  timezone: timezoneSchema,
});

// Library status query schema
export const libraryStatusQuerySchema = z.object({
  serverId: z.uuid().optional(),
  serverIds: serverIdsQuerySchema,
});

// Library growth query schema (time-series)
export const libraryGrowthQuerySchema = z
  .object({
    serverId: z.uuid().optional(),
    serverIds: serverIdsQuerySchema,
    libraryId: z.uuid().optional(),
    period: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    timezone: timezoneSchema,
  })
  .refine(dateValidationRefinements.startBeforeEnd.refinement, {
    message: dateValidationRefinements.startBeforeEnd.message,
  });

// Library quality evolution query schema
export const libraryQualityQuerySchema = z.object({
  serverId: z.uuid().optional(),
  period: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
  mediaType: z.enum(['all', 'movies', 'shows']).default('all'),
  timezone: timezoneSchema,
});

// Library storage analytics query schema
export const libraryStorageQuerySchema = z.object({
  serverId: z.uuid().optional(),
  serverIds: serverIdsQuerySchema, // Combined scope so mirror dedup spans servers
  libraryId: z.uuid().optional(),
  period: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
  timezone: timezoneSchema,
});

// Library duplicates query schema (cross-server duplicate detection)
export const libraryDuplicatesQuerySchema = z.object({
  serverId: z.uuid().optional(), // Filter to show duplicates involving this server
  serverIds: serverIdsQuerySchema, // Restrict detection to a subset of accessible servers
  mediaType: z.enum(['movie', 'episode', 'show']).optional(),
  minConfidence: z.coerce.number().min(0).max(100).default(70),
  includeFuzzy: booleanStringSchema.default(true), // Include fuzzy title matches
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

// Library stale content query schema
export const libraryStaleQuerySchema = z.object({
  serverId: z.uuid().optional(),
  serverIds: serverIdsQuerySchema,
  libraryId: z.uuid().optional(),
  mediaType: z.enum(['movie', 'show', 'artist']).optional(),
  staleDays: z.coerce.number().int().min(1).default(90), // Configurable threshold
  category: z.enum(['all', 'never_watched', 'stale']).default('all'),
  sortBy: z.enum(['size', 'days_stale', 'title', 'added_at']).default('size'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  timezone: timezoneSchema,
});

// Library watch statistics query schema
export const libraryWatchQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  serverIds: serverIdsQuerySchema,
  libraryId: z.string().optional(),
  mediaType: z.enum(['movie', 'episode', 'show']).optional(),
  minWatchCount: z.coerce.number().int().min(0).optional(),
  maxWatchCount: z.coerce.number().int().min(0).optional(),
  includeUnwatched: z.coerce.boolean().default(true),
  sortBy: z.enum(['watch_count', 'last_watched', 'title', 'file_size']).default('watch_count'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// Library ROI (Return on Investment) query schema
export const libraryRoiQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  serverIds: serverIdsQuerySchema,
  libraryId: z.string().optional(),
  mediaType: z.enum(['movie', 'show', 'artist', 'all']).default('all'),
  // Filter by value category
  valueCategory: z.enum(['low_value', 'moderate_value', 'high_value', 'all']).default('all'),
  // Time range for watch calculations (affects recency weighting)
  periodDays: z.coerce.number().int().min(30).max(365).default(90),
  // Include age decay in value calculation
  includeAgeDecay: z.coerce.boolean().default(true),
  // Minimum file size to include (bytes) - filter out tiny files
  minFileSize: z.coerce.number().int().min(0).default(0),
  sortBy: z
    .enum(['watch_hours_per_gb', 'value_score', 'file_size', 'title'])
    .default('watch_hours_per_gb'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'), // Low value first by default
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// Library watch patterns query schema (binge, peak times, seasonal)
export const libraryPatternsQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  serverIds: serverIdsQuerySchema,
  libraryId: z.string().optional(),
  // Time range for pattern analysis (default: 52 weeks per CONTEXT.md)
  periodWeeks: z.coerce.number().int().min(4).max(104).default(52),
  // Scope: per-user patterns or server-wide aggregate
  scope: z.enum(['user', 'server']).default('server'),
  // Which patterns to include
  includeBinge: z.coerce.boolean().default(true),
  includePeakTimes: z.coerce.boolean().default(true),
  includeSeasonalTrends: z.coerce.boolean().default(true),
  // For binge: minimum episodes to consider a binge session
  bingeThreshold: z.coerce.number().int().min(2).max(10).default(3),
  // Limit for top binge shows
  limit: z.coerce.number().int().positive().max(50).default(10),
  // Timezone for hour/day extraction (defaults to UTC on backend)
  timezone: timezoneSchema,
});

// Library completion rate analysis query schema
export const libraryCompletionQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  libraryId: z.string().optional(),
  mediaType: z.enum(['movie', 'episode', 'show']).optional(),
  // For TV: aggregate to episode, season, or series level
  aggregateLevel: z.enum(['item', 'season', 'series']).default('item'),
  // Completion status filter
  status: z.enum(['completed', 'in_progress', 'not_started', 'all']).default('all'),
  minCompletionPct: z.coerce.number().min(0).max(100).optional(),
  maxCompletionPct: z.coerce.number().min(0).max(100).optional(),
  sortBy: z.enum(['completion_pct', 'title', 'last_watched']).default('completion_pct'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// Library top content query schema (for top movies and top shows endpoints)
export const topContentQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  serverIds: serverIdsQuerySchema,
  period: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
  sortBy: z
    .enum(['plays', 'watch_hours', 'viewers', 'completion_rate', 'binge_score'])
    .default('plays'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
});

// Library shelves query schema (windowed recently-added/most-popular/dead-weight
// command center) - same day/week/month/year/all/custom period convention as
// statsQuerySchema, matching the frontend's TimeRangePicker/TimeRangeValue shape.
export const shelvesQuerySchema = z
  .object({
    period: statPeriodSchema.default('month'),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    serverIds: serverIdsQuerySchema,
    includeDeadWeight: booleanStringSchema.default(true),
  })
  .refine(dateValidationRefinements.customPeriodRequiresDates.refinement, {
    message: dateValidationRefinements.customPeriodRequiresDates.message,
  })
  .refine(dateValidationRefinements.startBeforeEnd.refinement, {
    message: dateValidationRefinements.startBeforeEnd.message,
  });

// ============================================================================
// Type Exports
// ============================================================================

export type LibraryStatsQueryInput = z.infer<typeof libraryStatsQuerySchema>;
export type LibraryStatusQueryInput = z.infer<typeof libraryStatusQuerySchema>;
export type LibraryGrowthQueryInput = z.infer<typeof libraryGrowthQuerySchema>;
export type LibraryQualityQueryInput = z.infer<typeof libraryQualityQuerySchema>;
export type LibraryStorageQueryInput = z.infer<typeof libraryStorageQuerySchema>;
export type LibraryDuplicatesQueryInput = z.infer<typeof libraryDuplicatesQuerySchema>;
export type LibraryStaleQueryInput = z.infer<typeof libraryStaleQuerySchema>;
export type LibraryWatchQueryInput = z.infer<typeof libraryWatchQuerySchema>;
export type LibraryRoiQueryInput = z.infer<typeof libraryRoiQuerySchema>;
export type LibraryPatternsQueryInput = z.infer<typeof libraryPatternsQuerySchema>;
export type LibraryCompletionQueryInput = z.infer<typeof libraryCompletionQuerySchema>;
export type TopContentQueryInput = z.infer<typeof topContentQuerySchema>;
export type ShelvesQueryInput = z.infer<typeof shelvesQuerySchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CallbackInput = z.infer<typeof callbackSchema>;
export type CreateServerInput = z.infer<typeof createServerSchema>;
export type ReorderServersInput = z.infer<typeof reorderServersSchema>;
export type UpdateServerInput = z.infer<typeof updateServerSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type SessionQueryInput = z.infer<typeof sessionQuerySchema>;
export type HistoryQueryInput = z.infer<typeof historyQuerySchema>;
export type HistoryAggregatesQueryInput = z.infer<typeof historyAggregatesQuerySchema>;
export type FilterOptionsQueryInput = z.infer<typeof filterOptionsQuerySchema>;

export type BulkUpdateAutomationsInput = z.infer<typeof bulkUpdateAutomationsSchema>;
export type BulkDeleteAutomationsInput = z.infer<typeof bulkDeleteAutomationsSchema>;

export type ServerIdFilterInput = z.infer<typeof serverIdFilterSchema>;
export type DashboardQueryInput = z.infer<typeof dashboardQuerySchema>;
export type StatsQueryInput = z.infer<typeof statsQuerySchema>;
export type LocationStatsQueryInput = z.infer<typeof locationStatsQuerySchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type TautulliImportInput = z.infer<typeof tautulliImportSchema>;

// Jellystat types
export type JellystatPlayState = z.infer<typeof jellystatPlayStateSchema>;
export type JellystatTranscodingInfo = z.infer<typeof jellystatTranscodingInfoSchema>;
export type JellystatPlaybackActivity = z.infer<typeof jellystatPlaybackActivitySchema>;
export type JellystatBackup = z.infer<typeof jellystatBackupSchema>;
export type JellystatImportBody = z.infer<typeof jellystatImportBodySchema>;
export type ImportJobStatus = z.infer<typeof importJobStatusSchema>;

// Engagement types
export type EngagementQueryInput = z.infer<typeof engagementQuerySchema>;
export type ShowsQueryInput = z.infer<typeof showsQuerySchema>;
