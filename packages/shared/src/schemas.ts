/**
 * Zod validation schemas for API requests
 */

import { z } from 'zod';
import { isValidTimezone } from './constants.js';

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
const dateValidationRefinements = {
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

  // Server filter
  serverId: uuidSchema.optional(),
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

export const ruleParamsSchema = z.union([
  impossibleTravelParamsSchema,
  simultaneousLocationsParamsSchema,
  deviceVelocityParamsSchema,
  concurrentStreamsParamsSchema,
  geoRestrictionParamsSchema,
  accountInactivityParamsSchema,
]);

export const createRuleSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum([
    'impossible_travel',
    'simultaneous_locations',
    'device_velocity',
    'concurrent_streams',
    'geo_restriction',
    'account_inactivity',
  ]),
  params: z.record(z.string(), z.unknown()),
  serverUserId: uuidSchema.nullable().default(null),
  isActive: z.boolean().default(true),
});

export const updateRuleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

export const ruleIdParamSchema = z.object({
  id: uuidSchema,
});

// ============================================================================
// Violation Schemas
// ============================================================================

export const violationSortFieldSchema = z.enum(['createdAt', 'severity', 'user', 'rule']);
export type ViolationSortField = z.infer<typeof violationSortFieldSchema>;

export const violationQuerySchema = paginationSchema.extend({
  serverId: uuidSchema.optional(),
  serverUserId: uuidSchema.optional(),
  ruleId: uuidSchema.optional(),
  severity: z.enum(['low', 'warning', 'high']).optional(),
  acknowledged: booleanStringSchema.optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  orderBy: violationSortFieldSchema.optional(),
  orderDir: z.enum(['asc', 'desc']).optional(),
});

export const violationIdParamSchema = z.object({
  id: uuidSchema,
});

// ============================================================================
// Stats Schemas
// ============================================================================

export const serverIdFilterSchema = z.object({
  serverId: uuidSchema.optional(),
});

// Dashboard query schema with timezone support
export const dashboardQuerySchema = z.object({
  serverId: uuidSchema.optional(),
  timezone: timezoneSchema,
});

export const statsQuerySchema = z
  .object({
    period: statPeriodSchema.default('week'),
    startDate: z.iso.datetime().optional(),
    endDate: z.iso.datetime().optional(),
    serverId: uuidSchema.optional(),
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
    serverId: uuidSchema.optional(),
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

// Webhook format enum
export const webhookFormatSchema = z.enum(['json', 'ntfy', 'apprise', 'pushover']);

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
  discordWebhookUrl: nullableUrlSchema.optional(),
  customWebhookUrl: nullableUrlSchema.optional(),
  webhookFormat: webhookFormatSchema.nullable().optional(),
  ntfyTopic: z.string().max(200).nullable().optional(),
  ntfyAuthToken: nullableStringSchema(500).optional(),
  pushoverUserKey: nullableStringSchema(200).optional(),
  pushoverApiToken: nullableStringSchema(200).optional(),
  // Poller settings
  pollerEnabled: z.boolean().optional(),
  pollerIntervalMs: z.number().int().min(5000).max(300000).optional(),
  // GeoIP settings
  usePlexGeoip: z.boolean().optional(),
  // Tautulli integration
  tautulliUrl: nullableUrlSchema.optional(),
  tautulliApiKey: nullableStringSchema().optional(),
  // Network/access settings
  externalUrl: nullableUrlSchema.optional(),
  basePath: z.string().max(100).optional(),
  trustProxy: z.boolean().optional(),
  // Authentication settings
  primaryAuthMethod: z.enum(['jellyfin', 'local']).optional(),
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
  'completed',
  'finished',
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
  libraryId: z.uuid().optional(),
  timezone: timezoneSchema,
});

// Library growth query schema (time-series)
export const libraryGrowthQuerySchema = z.object({
  serverId: z.uuid().optional(),
  libraryId: z.uuid().optional(),
  period: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
  timezone: timezoneSchema,
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
  libraryId: z.uuid().optional(),
  period: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
  timezone: timezoneSchema,
});

// Library duplicates query schema (cross-server duplicate detection)
export const libraryDuplicatesQuerySchema = z.object({
  serverId: z.uuid().optional(), // Filter to show duplicates involving this server
  mediaType: z.enum(['movie', 'episode', 'show']).optional(),
  minConfidence: z.coerce.number().min(0).max(100).default(70),
  includeFuzzy: booleanStringSchema.default(true), // Include fuzzy title matches
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

// Library stale content query schema
export const libraryStaleQuerySchema = z.object({
  serverId: z.uuid().optional(),
  libraryId: z.uuid().optional(),
  mediaType: z.enum(['movie', 'show', 'artist']).optional(),
  staleDays: z.coerce.number().int().min(1).default(90), // Configurable threshold
  category: z.enum(['all', 'never_watched', 'stale']).default('all'),
  sortBy: z.enum(['size', 'days_stale', 'title']).default('size'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  timezone: timezoneSchema,
});

// Library watch statistics query schema
export const libraryWatchQuerySchema = z.object({
  serverId: uuidSchema.optional(),
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
  period: z.enum(['7d', '30d', '90d', '1y', 'all']).default('30d'),
  sortBy: z
    .enum(['plays', 'watch_hours', 'viewers', 'completion_rate', 'binge_score'])
    .default('plays'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
});

// ============================================================================
// Type Exports
// ============================================================================

export type LibraryStatsQueryInput = z.infer<typeof libraryStatsQuerySchema>;
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
export type LoginInput = z.infer<typeof loginSchema>;
export type CallbackInput = z.infer<typeof callbackSchema>;
export type CreateServerInput = z.infer<typeof createServerSchema>;
export type ReorderServersInput = z.infer<typeof reorderServersSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type SessionQueryInput = z.infer<typeof sessionQuerySchema>;
export type HistoryQueryInput = z.infer<typeof historyQuerySchema>;
export type HistoryAggregatesQueryInput = z.infer<typeof historyAggregatesQuerySchema>;
export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
export type ViolationQueryInput = z.infer<typeof violationQuerySchema>;
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
