/**
 * Drizzle ORM schema definitions for Tracearr
 *
 * Multi-Server User Architecture:
 * - `users` = Identity (the real human)
 * - `server_users` = Account on a specific server (Plex/Jellyfin/Emby)
 * - One user can have multiple server_users (accounts across servers)
 * - Sessions and violations link to server_users (server-specific)
 */

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  real,
  jsonb,
  index,
  uniqueIndex,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { ALL_MEDIA_TYPES } from '../constants/mediaTypes.js';

// Server types enum
export const serverTypeEnum = ['plex', 'jellyfin', 'emby'] as const;

// Session state enum
export const sessionStateEnum = ['playing', 'paused', 'stopped'] as const;

// Media type enum - imported from centralized constants
export const mediaTypeEnum = ALL_MEDIA_TYPES;

// Rule type enum
export const ruleTypeEnum = [
  'impossible_travel',
  'simultaneous_locations',
  'device_velocity',
  'concurrent_streams',
  'geo_restriction',
] as const;

// Violation severity enum
export const violationSeverityEnum = ['low', 'warning', 'high'] as const;

// Media servers (Plex/Jellyfin/Emby instances)
export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    type: varchar('type', { length: 20 }).notNull().$type<(typeof serverTypeEnum)[number]>(),
    url: text('url').notNull(),
    token: text('token').notNull(), // Encrypted
    machineIdentifier: varchar('machine_identifier', { length: 100 }), // Plex clientIdentifier for dedup
    // For Plex servers: which linked Plex account this server was added from (nullable for Jellyfin/Emby and legacy)
    plexAccountId: uuid('plex_account_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('servers_plex_account_idx').on(table.plexAccountId)]
);

/**
 * Users - Identity table representing real humans
 *
 * This is the "anchor" identity that can own multiple server accounts.
 * Stores authentication credentials and aggregated metrics.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Identity
    username: varchar('username', { length: 100 }).notNull(), // Login identifier (unique)
    name: varchar('name', { length: 255 }), // Display name (optional, defaults to null)
    thumbnail: text('thumbnail'), // Custom avatar (nullable)
    email: varchar('email', { length: 255 }), // For identity matching (nullable)

    // Authentication (nullable - not all users authenticate directly)
    passwordHash: text('password_hash'), // bcrypt hash for local login
    plexAccountId: varchar('plex_account_id', { length: 255 }), // Plex.tv global account ID for OAuth

    // Access control - combined permission level and account status
    // Can log in: 'owner', 'admin', 'viewer'
    // Cannot log in: 'member' (default), 'disabled', 'pending'
    role: varchar('role', { length: 20 })
      .notNull()
      .$type<'owner' | 'admin' | 'viewer' | 'member' | 'disabled' | 'pending'>()
      .default('member'),

    // Aggregated metrics (cached, updated by triggers)
    aggregateTrustScore: integer('aggregate_trust_score').notNull().default(100),
    totalViolations: integer('total_violations').notNull().default(0),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Username is display name from media server (not unique across servers)
    index('users_username_idx').on(table.username),
    uniqueIndex('users_email_unique').on(table.email),
    index('users_plex_account_id_idx').on(table.plexAccountId),
    index('users_role_idx').on(table.role),
  ]
);

/**
 * Plex Accounts - Linked Plex.tv accounts for server discovery
 *
 * Allows owners to link multiple Plex.tv accounts to add servers from different accounts.
 * Each account stores a token for Plex API calls (server discovery, etc.).
 * The allowLogin flag controls which accounts can be used for authentication.
 */
export const plexAccounts = pgTable(
  'plex_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    plexAccountId: varchar('plex_account_id', { length: 255 }).notNull(),
    plexUsername: varchar('plex_username', { length: 255 }),
    plexEmail: varchar('plex_email', { length: 255 }),
    plexThumbnail: varchar('plex_thumbnail', { length: 500 }),
    plexToken: varchar('plex_token', { length: 500 }).notNull(),
    allowLogin: boolean('allow_login').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One Plex.tv account can only be linked to one Tracearr user
    unique('plex_accounts_plex_account_id_unique').on(table.plexAccountId),
    // No duplicate links for same user (defense in depth)
    unique('plex_accounts_user_plex_unique').on(table.userId, table.plexAccountId),
    index('plex_accounts_user_idx').on(table.userId),
    index('plex_accounts_allow_login_idx').on(table.plexAccountId, table.allowLogin),
  ]
);

/**
 * Server Users - Account on a specific media server
 *
 * Represents a user's account on a Plex/Jellyfin/Emby server.
 * One user (identity) can have multiple server_users (accounts across servers).
 * Sessions and violations link here for per-server tracking.
 */
export const serverUsers = pgTable(
  'server_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Relationships - always linked to both user and server
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),

    // Server-specific identity
    externalId: varchar('external_id', { length: 255 }).notNull(), // Plex/Jellyfin user ID
    username: varchar('username', { length: 255 }).notNull(), // Username on this server
    email: varchar('email', { length: 255 }), // Email from server sync (may differ from users.email)
    thumbUrl: text('thumb_url'), // Avatar from server

    // When user joined/was added to media server (Plex provides this, Jellyfin/Emby don't)
    joinedAt: timestamp('joined_at', { withTimezone: true }),

    // Server-specific permissions
    isServerAdmin: boolean('is_server_admin').notNull().default(false),

    // Per-server trust
    trustScore: integer('trust_score').notNull().default(100),
    sessionCount: integer('session_count').notNull().default(0), // For aggregate weighting

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One account per user per server
    uniqueIndex('server_users_user_server_unique').on(table.userId, table.serverId),
    // Atomic upsert during sync
    uniqueIndex('server_users_server_external_unique').on(table.serverId, table.externalId),
    // Query optimization
    index('server_users_user_idx').on(table.userId),
    index('server_users_server_idx').on(table.serverId),
    index('server_users_username_idx').on(table.username),
  ]
);

// Session history (will be converted to hypertable)
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    // Links to server_users for per-server tracking
    serverUserId: uuid('server_user_id')
      .notNull()
      .references(() => serverUsers.id, { onDelete: 'cascade' }),
    sessionKey: varchar('session_key', { length: 255 }).notNull(),
    // Plex Session.id - required for termination API (different from sessionKey)
    // For Jellyfin/Emby, sessionKey is used directly for termination
    plexSessionId: varchar('plex_session_id', { length: 255 }),
    state: varchar('state', { length: 20 }).notNull().$type<(typeof sessionStateEnum)[number]>(),
    mediaType: varchar('media_type', { length: 20 })
      .notNull()
      .$type<(typeof mediaTypeEnum)[number]>(),
    mediaTitle: text('media_title').notNull(),
    // Enhanced media metadata for episodes
    grandparentTitle: varchar('grandparent_title', { length: 500 }), // Show name (for episodes)
    seasonNumber: integer('season_number'), // Season number (for episodes)
    episodeNumber: integer('episode_number'), // Episode number (for episodes)
    year: integer('year'), // Release year
    thumbPath: varchar('thumb_path', { length: 500 }), // Poster path (e.g., /library/metadata/123/thumb)
    ratingKey: varchar('rating_key', { length: 255 }), // Plex/Jellyfin media identifier
    externalSessionId: varchar('external_session_id', { length: 255 }), // External reference for deduplication
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(), // Last time session was seen in poll (for stale detection) - no default, app always provides
    durationMs: bigint('duration_ms', { mode: 'number' }), // Actual watch duration (excludes paused time)
    totalDurationMs: bigint('total_duration_ms', { mode: 'number' }), // Total media length
    progressMs: bigint('progress_ms', { mode: 'number' }), // Current playback position
    // Pause tracking - accumulates total paused time across pause/resume cycles
    lastPausedAt: timestamp('last_paused_at', { withTimezone: true }), // When current pause started
    pausedDurationMs: bigint('paused_duration_ms', { mode: 'number' }).notNull().default(0), // Accumulated pause time
    // Session grouping for "resume where left off" tracking
    referenceId: uuid('reference_id'), // Links to first session in resume chain
    watched: boolean('watched').notNull().default(false), // True if user watched 85%+
    forceStopped: boolean('force_stopped').notNull().default(false), // True if session was force-stopped due to inactivity
    shortSession: boolean('short_session').notNull().default(false), // True if session duration < MIN_PLAY_TIME_MS (120s)
    ipAddress: varchar('ip_address', { length: 45 }).notNull(),
    geoCity: varchar('geo_city', { length: 255 }),
    geoRegion: varchar('geo_region', { length: 255 }), // State/province/subdivision
    geoCountry: varchar('geo_country', { length: 100 }),
    geoLat: real('geo_lat'),
    geoLon: real('geo_lon'),
    playerName: varchar('player_name', { length: 255 }), // Player title/friendly name
    deviceId: varchar('device_id', { length: 255 }), // Machine identifier (unique device UUID)
    product: varchar('product', { length: 255 }), // Product name (e.g., "Plex for iOS")
    device: varchar('device', { length: 255 }), // Device type (e.g., "iPhone", "Android TV")
    platform: varchar('platform', { length: 100 }),
    quality: varchar('quality', { length: 100 }),
    isTranscode: boolean('is_transcode').notNull().default(false),
    // Transcode decisions: 'transcode' | 'copy' | 'directplay'
    // copy = direct stream (container remux), directplay = true direct play
    videoDecision: varchar('video_decision', { length: 50 }),
    audioDecision: varchar('audio_decision', { length: 50 }),
    bitrate: integer('bitrate'),
    // Live TV specific fields (null for non-live content)
    channelTitle: varchar('channel_title', { length: 255 }), // Channel name (e.g., "HBO", "ESPN")
    channelIdentifier: varchar('channel_identifier', { length: 100 }), // Channel number/ID
    channelThumb: varchar('channel_thumb', { length: 500 }), // Channel logo path
    // Music track metadata (null for non-track content)
    artistName: varchar('artist_name', { length: 255 }), // Artist name
    albumName: varchar('album_name', { length: 255 }), // Album name
    trackNumber: integer('track_number'), // Track number in album
    discNumber: integer('disc_number'), // Disc number for multi-disc albums
  },
  (table) => [
    index('sessions_server_user_time_idx').on(table.serverUserId, table.startedAt),
    index('sessions_server_time_idx').on(table.serverId, table.startedAt),
    index('sessions_state_idx').on(table.state),
    index('sessions_external_session_idx').on(table.serverId, table.externalSessionId),
    index('sessions_active_lookup_idx').on(table.serverId, table.sessionKey, table.stoppedAt),
    index('sessions_device_idx').on(table.serverUserId, table.deviceId),
    index('sessions_reference_idx').on(table.referenceId), // For session grouping queries
    index('sessions_server_user_rating_idx').on(table.serverUserId, table.ratingKey), // For resume detection
    // Index for Tautulli import deduplication fallback (when externalSessionId not found)
    index('sessions_dedup_fallback_idx').on(
      table.serverId,
      table.serverUserId,
      table.ratingKey,
      table.startedAt
    ),
    // Indexes for stats queries
    index('sessions_geo_idx').on(table.geoLat, table.geoLon), // For /stats/locations basic geo lookup
    index('sessions_geo_time_idx').on(table.startedAt, table.geoLat, table.geoLon), // For time-filtered map queries
    index('sessions_media_type_idx').on(table.mediaType), // For media type aggregations
    index('sessions_transcode_idx').on(table.isTranscode), // For quality stats
    index('sessions_platform_idx').on(table.platform), // For platform stats
    // Indexes for top-content queries (movies and shows aggregation)
    index('sessions_top_movies_idx').on(table.mediaType, table.mediaTitle, table.year), // For top movies GROUP BY
    index('sessions_top_shows_idx').on(table.mediaType, table.grandparentTitle), // For top shows GROUP BY series
    // Index for stale session detection (active sessions that haven't been seen recently)
    index('sessions_stale_detection_idx').on(table.lastSeenAt, table.stoppedAt),
  ]
);

// Sharing detection rules
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    type: varchar('type', { length: 50 }).notNull().$type<(typeof ruleTypeEnum)[number]>(),
    params: jsonb('params').notNull().$type<Record<string, unknown>>(),
    // Nullable: null = global rule, set = specific server user
    serverUserId: uuid('server_user_id').references(() => serverUsers.id, { onDelete: 'cascade' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rules_active_idx').on(table.isActive),
    index('rules_server_user_id_idx').on(table.serverUserId),
  ]
);

// Rule violations
export const violations = pgTable(
  'violations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    // Links to server_users for per-server tracking
    serverUserId: uuid('server_user_id')
      .notNull()
      .references(() => serverUsers.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    severity: varchar('severity', { length: 20 })
      .notNull()
      .$type<(typeof violationSeverityEnum)[number]>(),
    // Denormalized rule type for unique constraint (rules.type copied here)
    // This enables the partial unique index without requiring a join
    ruleType: varchar('rule_type', { length: 50 }).notNull().$type<(typeof ruleTypeEnum)[number]>(),
    data: jsonb('data').notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (table) => [
    index('violations_server_user_id_idx').on(table.serverUserId),
    index('violations_rule_id_idx').on(table.ruleId),
    index('violations_created_at_idx').on(table.createdAt),
    // Composite index for deduplication queries:
    // SELECT ... WHERE serverUserId = ? AND acknowledgedAt IS NULL AND createdAt >= ?
    index('violations_dedup_idx').on(table.serverUserId, table.acknowledgedAt, table.createdAt),
    // Partial unique index to prevent duplicate unacknowledged violations
    // Defense-in-depth: catches race conditions that bypass application-level dedup
    uniqueIndex('violations_unique_active_user_session_type')
      .on(table.serverUserId, table.sessionId, table.ruleType)
      .where(sql`${table.acknowledgedAt} IS NULL`),
  ]
);

// Mobile pairing tokens (one-time use, expire after 15 minutes)
export const mobileTokens = pgTable('mobile_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(), // SHA-256 of trr_mob_xxx token
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'cascade' }),
  usedAt: timestamp('used_at', { withTimezone: true }), // Set when token is used, null = unused
});

// Mobile sessions (paired devices)
export const mobileSessions = pgTable(
  'mobile_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Link to user identity for multi-user support
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: varchar('refresh_token_hash', { length: 64 }).notNull().unique(), // SHA-256
    deviceName: varchar('device_name', { length: 100 }).notNull(),
    deviceId: varchar('device_id', { length: 100 }).notNull(),
    platform: varchar('platform', { length: 20 }).notNull().$type<'ios' | 'android'>(),
    expoPushToken: varchar('expo_push_token', { length: 255 }), // For push notifications
    deviceSecret: varchar('device_secret', { length: 64 }), // For push payload encryption (base64)
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('mobile_sessions_user_idx').on(table.userId),
    index('mobile_sessions_device_id_idx').on(table.deviceId),
    index('mobile_sessions_refresh_token_idx').on(table.refreshTokenHash),
    index('mobile_sessions_expo_push_token_idx').on(table.expoPushToken),
  ]
);

// Notification preferences per mobile device
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mobileSessionId: uuid('mobile_session_id')
      .notNull()
      .unique()
      .references(() => mobileSessions.id, { onDelete: 'cascade' }),

    // Global toggles
    pushEnabled: boolean('push_enabled').notNull().default(true),

    // Event type toggles
    onViolationDetected: boolean('on_violation_detected').notNull().default(true),
    onStreamStarted: boolean('on_stream_started').notNull().default(false),
    onStreamStopped: boolean('on_stream_stopped').notNull().default(false),
    onConcurrentStreams: boolean('on_concurrent_streams').notNull().default(true),
    onNewDevice: boolean('on_new_device').notNull().default(true),
    onTrustScoreChanged: boolean('on_trust_score_changed').notNull().default(false),
    onServerDown: boolean('on_server_down').notNull().default(true),
    onServerUp: boolean('on_server_up').notNull().default(true),

    // Severity filtering (violations only)
    violationMinSeverity: integer('violation_min_severity').notNull().default(1), // 1=low, 2=warning, 3=high
    violationRuleTypes: text('violation_rule_types').array().default([]), // Empty = all types

    // Rate limiting
    maxPerMinute: integer('max_per_minute').notNull().default(10),
    maxPerHour: integer('max_per_hour').notNull().default(60),

    // Quiet hours
    quietHoursEnabled: boolean('quiet_hours_enabled').notNull().default(false),
    quietHoursStart: varchar('quiet_hours_start', { length: 5 }), // HH:MM format
    quietHoursEnd: varchar('quiet_hours_end', { length: 5 }), // HH:MM format
    quietHoursTimezone: varchar('quiet_hours_timezone', { length: 50 }).default('UTC'),
    quietHoursOverrideCritical: boolean('quiet_hours_override_critical').notNull().default(true),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notification_prefs_mobile_session_idx').on(table.mobileSessionId),
    // Validate quiet hours format: HH:MM where HH is 00-23 and MM is 00-59
    check(
      'quiet_hours_start_format',
      sql`${table.quietHoursStart} IS NULL OR ${table.quietHoursStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`
    ),
    check(
      'quiet_hours_end_format',
      sql`${table.quietHoursEnd} IS NULL OR ${table.quietHoursEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`
    ),
  ]
);

// Notification event type enum
export const notificationEventTypeEnum = [
  'violation_detected',
  'stream_started',
  'stream_stopped',
  'concurrent_streams',
  'new_device',
  'trust_score_changed',
  'server_down',
  'server_up',
] as const;

// Notification channel routing configuration
// Controls which channels receive which event types (web admin configurable)
export const notificationChannelRouting = pgTable(
  'notification_channel_routing',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventType: varchar('event_type', { length: 50 })
      .notNull()
      .unique()
      .$type<(typeof notificationEventTypeEnum)[number]>(),

    // Channel toggles
    discordEnabled: boolean('discord_enabled').notNull().default(true),
    webhookEnabled: boolean('webhook_enabled').notNull().default(true),
    pushEnabled: boolean('push_enabled').notNull().default(true),
    webToastEnabled: boolean('web_toast_enabled').notNull().default(true),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('notification_channel_routing_event_type_idx').on(table.eventType)]
);

// Termination trigger type enum
export const terminationTriggerEnum = ['manual', 'rule'] as const;

// Stream termination audit log
export const terminationLogs = pgTable(
  'termination_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // What was terminated
    // Note: No FK constraint because sessions is a TimescaleDB hypertable
    // (hypertables don't support foreign key references to their primary key)
    // The relationship is maintained via Drizzle ORM relations
    sessionId: uuid('session_id').notNull(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    // The user whose stream was terminated
    serverUserId: uuid('server_user_id')
      .notNull()
      .references(() => serverUsers.id, { onDelete: 'cascade' }),

    // How it was triggered
    trigger: varchar('trigger', { length: 20 })
      .notNull()
      .$type<(typeof terminationTriggerEnum)[number]>(),

    // Who triggered it (for manual) - nullable for rule-triggered
    triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    // What rule triggered it (for rule-triggered) - nullable for manual
    ruleId: uuid('rule_id').references(() => rules.id, { onDelete: 'set null' }),
    violationId: uuid('violation_id').references(() => violations.id, { onDelete: 'set null' }),

    // Message shown to user (Plex only)
    reason: text('reason'),

    // Result
    success: boolean('success').notNull(),
    errorMessage: text('error_message'), // If success=false

    // Timestamp
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('termination_logs_session_idx').on(table.sessionId),
    index('termination_logs_server_user_idx').on(table.serverUserId),
    index('termination_logs_triggered_by_idx').on(table.triggeredByUserId),
    index('termination_logs_rule_idx').on(table.ruleId),
    index('termination_logs_created_at_idx').on(table.createdAt),
  ]
);

// Unit system enum for display preferences
export const unitSystemEnum = ['metric', 'imperial'] as const;

// Application settings (single row)
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  allowGuestAccess: boolean('allow_guest_access').notNull().default(false),
  // Display preferences
  unitSystem: varchar('unit_system', { length: 20 })
    .notNull()
    .$type<(typeof unitSystemEnum)[number]>()
    .default('metric'),
  discordWebhookUrl: text('discord_webhook_url'),
  customWebhookUrl: text('custom_webhook_url'),
  webhookFormat: text('webhook_format').$type<'json' | 'ntfy' | 'apprise'>(), // Format for custom webhook payloads
  ntfyTopic: text('ntfy_topic'), // Topic for ntfy notifications (required when webhookFormat is 'ntfy')
  ntfyAuthToken: text('ntfy_auth_token'), // Auth token for protected ntfy servers (Bearer token)
  // Poller settings
  pollerEnabled: boolean('poller_enabled').notNull().default(true),
  pollerIntervalMs: integer('poller_interval_ms').notNull().default(15000),
  // Tautulli integration
  tautulliUrl: text('tautulli_url'),
  tautulliApiKey: text('tautulli_api_key'), // Encrypted
  // Network/access settings for self-hosted deployments
  externalUrl: text('external_url'), // Public URL for mobile/external access (e.g., https://tracearr.example.com)
  basePath: varchar('base_path', { length: 100 }).notNull().default(''), // For subfolder proxies (e.g., /tracearr)
  trustProxy: boolean('trust_proxy').notNull().default(false), // Trust X-Forwarded-* headers from reverse proxy
  // Mobile access
  mobileEnabled: boolean('mobile_enabled').notNull().default(false),
  // Authentication settings
  primaryAuthMethod: varchar('primary_auth_method', { length: 20 })
    .$type<'jellyfin' | 'local'>()
    .notNull()
    .default('local'), // Default to local auth
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ============================================================================
// Relations
// ============================================================================

export const serversRelations = relations(servers, ({ one, many }) => ({
  serverUsers: many(serverUsers),
  sessions: many(sessions),
  plexAccount: one(plexAccounts, {
    fields: [servers.plexAccountId],
    references: [plexAccounts.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  serverUsers: many(serverUsers),
  mobileSessions: many(mobileSessions),
  mobileTokens: many(mobileTokens),
  plexAccounts: many(plexAccounts),
}));

export const plexAccountsRelations = relations(plexAccounts, ({ one, many }) => ({
  user: one(users, {
    fields: [plexAccounts.userId],
    references: [users.id],
  }),
  servers: many(servers),
}));

export const serverUsersRelations = relations(serverUsers, ({ one, many }) => ({
  user: one(users, {
    fields: [serverUsers.userId],
    references: [users.id],
  }),
  server: one(servers, {
    fields: [serverUsers.serverId],
    references: [servers.id],
  }),
  sessions: many(sessions),
  rules: many(rules),
  violations: many(violations),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  server: one(servers, {
    fields: [sessions.serverId],
    references: [servers.id],
  }),
  serverUser: one(serverUsers, {
    fields: [sessions.serverUserId],
    references: [serverUsers.id],
  }),
  violations: many(violations),
}));

export const rulesRelations = relations(rules, ({ one, many }) => ({
  serverUser: one(serverUsers, {
    fields: [rules.serverUserId],
    references: [serverUsers.id],
  }),
  violations: many(violations),
}));

export const violationsRelations = relations(violations, ({ one }) => ({
  rule: one(rules, {
    fields: [violations.ruleId],
    references: [rules.id],
  }),
  serverUser: one(serverUsers, {
    fields: [violations.serverUserId],
    references: [serverUsers.id],
  }),
  session: one(sessions, {
    fields: [violations.sessionId],
    references: [sessions.id],
  }),
}));

export const mobileSessionsRelations = relations(mobileSessions, ({ one }) => ({
  user: one(users, {
    fields: [mobileSessions.userId],
    references: [users.id],
  }),
  notificationPreferences: one(notificationPreferences, {
    fields: [mobileSessions.id],
    references: [notificationPreferences.mobileSessionId],
  }),
}));

export const notificationPreferencesRelations = relations(notificationPreferences, ({ one }) => ({
  mobileSession: one(mobileSessions, {
    fields: [notificationPreferences.mobileSessionId],
    references: [mobileSessions.id],
  }),
}));

export const mobileTokensRelations = relations(mobileTokens, ({ one }) => ({
  createdByUser: one(users, {
    fields: [mobileTokens.createdBy],
    references: [users.id],
  }),
}));

export const terminationLogsRelations = relations(terminationLogs, ({ one }) => ({
  session: one(sessions, {
    fields: [terminationLogs.sessionId],
    references: [sessions.id],
  }),
  server: one(servers, {
    fields: [terminationLogs.serverId],
    references: [servers.id],
  }),
  serverUser: one(serverUsers, {
    fields: [terminationLogs.serverUserId],
    references: [serverUsers.id],
  }),
  triggeredByUser: one(users, {
    fields: [terminationLogs.triggeredByUserId],
    references: [users.id],
  }),
  rule: one(rules, {
    fields: [terminationLogs.ruleId],
    references: [rules.id],
  }),
  violation: one(violations, {
    fields: [terminationLogs.violationId],
    references: [violations.id],
  }),
}));
