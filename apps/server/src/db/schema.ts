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
import { MEDIA_TYPES, type WebhookFormat } from '@tracearr/shared';

// Server types enum
export const serverTypeEnum = ['plex', 'jellyfin', 'emby'] as const;

// Session state enum
export const sessionStateEnum = ['playing', 'paused', 'stopped'] as const;

// Media type enum - imported from shared package
export const mediaTypeEnum = MEDIA_TYPES;

// Rule type enum
export const ruleTypeEnum = [
  'impossible_travel',
  'simultaneous_locations',
  'device_velocity',
  'concurrent_streams',
  'geo_restriction',
  'account_inactivity',
] as const;

// Violation severity enum
export const violationSeverityEnum = ['low', 'warning', 'high'] as const;

// ============================================================
// Stream Details JSONB Types (imported from shared package)
// ============================================================

import type {
  SourceVideoDetails,
  SourceAudioDetails,
  StreamVideoDetails,
  StreamAudioDetails,
  TranscodeInfo,
  SubtitleInfo,
} from '@tracearr/shared';

// Re-export for consumers of this module
export type {
  SourceVideoDetails,
  SourceAudioDetails,
  StreamVideoDetails,
  StreamAudioDetails,
  TranscodeInfo,
  SubtitleInfo,
};

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
    displayOrder: integer('display_order').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('servers_plex_account_idx').on(table.plexAccountId),
    index('servers_display_order_idx').on(table.displayOrder),
  ]
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

    // Public API access
    apiToken: varchar('api_token', { length: 60 }), // Public API key (format: trr_pub_<base64url>)

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
    externalId: varchar('external_id', { length: 255 }).notNull(), // Local server user ID (Plex PMS ID / Jellyfin ID)
    // For Plex: plex.tv account ID (different from local PMS ID). Used for sync matching.
    // Sessions use externalId (local PMS ID), sync uses plexAccountId (plex.tv ID)
    plexAccountId: varchar('plex_account_id', { length: 255 }),
    username: varchar('username', { length: 255 }).notNull(), // Username on this server
    email: varchar('email', { length: 255 }), // Email from server sync (may differ from users.email)
    thumbUrl: text('thumb_url'), // Avatar from server

    // When user joined/was added to media server (Plex provides this, Jellyfin/Emby don't)
    joinedAt: timestamp('joined_at', { withTimezone: true }),

    // Last activity timestamp
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),

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
    // For Plex sync matching by plex.tv account ID
    index('server_users_plex_account_idx').on(table.serverId, table.plexAccountId),
    // For account inactivity rule queries
    index('server_users_last_activity_idx').on(table.lastActivityAt),
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
    geoContinent: varchar('geo_continent', { length: 100 }),
    geoPostal: varchar('geo_postal', { length: 20 }),
    geoLat: real('geo_lat'),
    geoLon: real('geo_lon'),
    geoAsnNumber: integer('geo_asn_number'),
    geoAsnOrganization: varchar('geo_asn_organization', { length: 255 }),
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

    // ============ Stream Details (Source Media) ============
    // Scalar columns for high-frequency queries (indexed)
    sourceVideoCodec: varchar('source_video_codec', { length: 50 }), // H264, HEVC, VP9, AV1
    sourceVideoWidth: integer('source_video_width'), // pixels
    sourceVideoHeight: integer('source_video_height'), // pixels
    sourceAudioCodec: varchar('source_audio_codec', { length: 50 }), // TrueHD, DTS-HD MA, AAC
    sourceAudioChannels: integer('source_audio_channels'), // 2, 6, 8

    // ============ Stream Details (Delivered to Client) ============
    streamVideoCodec: varchar('stream_video_codec', { length: 50 }), // Codec after transcode
    streamAudioCodec: varchar('stream_audio_codec', { length: 50 }), // Codec after transcode

    // ============ Detailed JSONB Fields ============
    // Source video: bitrate, framerate, dynamicRange, aspectRatio, profile, level, colorSpace, colorDepth
    sourceVideoDetails: jsonb('source_video_details').$type<SourceVideoDetails>(),
    // Source audio: bitrate, channelLayout, language, sampleRate
    sourceAudioDetails: jsonb('source_audio_details').$type<SourceAudioDetails>(),
    // Stream video: bitrate, width, height, framerate, dynamicRange
    streamVideoDetails: jsonb('stream_video_details').$type<StreamVideoDetails>(),
    // Stream audio: bitrate, channels, language
    streamAudioDetails: jsonb('stream_audio_details').$type<StreamAudioDetails>(),
    // Transcode: containerDecision, sourceContainer, streamContainer, hwDecoding, hwEncoding, speed, throttled
    transcodeInfo: jsonb('transcode_info').$type<TranscodeInfo>(),
    // Subtitle: decision, codec, language, forced
    subtitleInfo: jsonb('subtitle_info').$type<SubtitleInfo>(),
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
    index('sessions_server_rating_idx').on(table.serverId, table.ratingKey), // For library item joins (watch/stale/roi)
    // Index for Tautulli import deduplication fallback (when externalSessionId not found)
    index('sessions_dedup_fallback_idx').on(
      table.serverId,
      table.serverUserId,
      table.ratingKey,
      table.startedAt
    ),
    // Indexes for stats queries
    index('sessions_geo_idx').on(table.geoLat, table.geoLon), // For /stats/locations basic geo lookup
    // sessions_geo_time_idx removed - superseded by idx_sessions_geo_partial in timescale.ts
    index('sessions_media_type_idx').on(table.mediaType), // For media type aggregations
    index('sessions_transcode_idx').on(table.isTranscode), // For quality stats
    index('sessions_platform_idx').on(table.platform), // For platform stats
    // sessions_top_movies_idx and sessions_top_shows_idx removed - superseded by time-prefixed variants in timescale.ts
    // Covering index for history aggregates queries (server + date range + reference_id for COUNT DISTINCT)
    index('idx_sessions_server_date_ref').on(table.serverId, table.startedAt, table.referenceId),
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
    // Nullable: null for account_inactivity rules (no associated session)
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
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
    // Partial unique index to prevent duplicate unacknowledged session-based violations
    // Defense-in-depth: catches race conditions that bypass application-level dedup
    // Only applies to violations with a session (session-based rules)
    uniqueIndex('violations_unique_active_user_session_type')
      .on(table.serverUserId, table.sessionId, table.ruleType)
      .where(sql`${table.acknowledgedAt} IS NULL AND ${table.sessionId} IS NOT NULL`),
    // Index for inactivity rule deduplication queries
    // SELECT ... WHERE serverUserId = ? AND ruleId = ? AND acknowledgedAt IS NULL
    index('violations_inactivity_dedup_idx').on(
      table.serverUserId,
      table.ruleId,
      table.acknowledgedAt
    ),
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
  // Notification settings
  discordWebhookUrl: text('discord_webhook_url'),
  customWebhookUrl: text('custom_webhook_url'),
  webhookFormat: text('webhook_format').$type<WebhookFormat>(), // Format for custom webhook payloads
  ntfyTopic: text('ntfy_topic'), // Topic for ntfy notifications (required when webhookFormat is 'ntfy')
  ntfyAuthToken: text('ntfy_auth_token'), // Auth token for protected ntfy servers (Bearer token)
  pushoverUserKey: text('pushover_user_key'),
  pushoverApiToken: text('pushover_api_token'),
  // Poller settings
  pollerEnabled: boolean('poller_enabled').notNull().default(true),
  pollerIntervalMs: integer('poller_interval_ms').notNull().default(15000),
  // GeoIP settings
  usePlexGeoip: boolean('use_plex_geoip').notNull().default(false), // Use Plex API for GeoIP lookups (sends IPs to plex.tv)
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
  libraryItems: many(libraryItems),
  librarySnapshots: many(librarySnapshots),
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

// ============================================================================
// Library Statistics Tables
// ============================================================================

/**
 * Library Items - Catalog of media items across all servers
 *
 * Stores media metadata with native columns for external IDs (IMDB, TMDB, TVDB)
 * for fast cross-server duplicate detection. B-tree indexes on external IDs
 * provide sub-millisecond lookups (100-1000x faster than JSONB with GIN indexes).
 *
 * Note: This table stores the current state of library items. Historical
 * snapshots are tracked in library_snapshots (TimescaleDB hypertable).
 */
export const libraryItems = pgTable(
  'library_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // Server relationship
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),

    // Server-specific identifiers
    libraryId: varchar('library_id', { length: 100 }).notNull(), // Server's library identifier
    ratingKey: varchar('rating_key', { length: 255 }).notNull(), // Server-specific media ID

    // External IDs (native columns for B-tree index performance)
    // 100-1000x faster lookups than JSONB with GIN indexes
    imdbId: varchar('imdb_id', { length: 20 }), // IMDB ID (tt1234567 format)
    tmdbId: integer('tmdb_id'), // TMDB ID
    tvdbId: integer('tvdb_id'), // TVDB ID

    // Media metadata
    title: varchar('title', { length: 500 }).notNull(),
    mediaType: varchar('media_type', { length: 20 }).notNull(), // movie, episode, season, show, artist, album, track
    year: integer('year'),

    // Quality tracking
    videoResolution: varchar('video_resolution', { length: 20 }), // '4k', '1080p', '720p', 'sd'
    videoCodec: varchar('video_codec', { length: 50 }), // 'hevc', 'h264', 'av1'
    audioCodec: varchar('audio_codec', { length: 50 }),
    audioChannels: integer('audio_channels'), // 2 (stereo), 6 (5.1), 8 (7.1)
    fileSize: bigint('file_size', { mode: 'number' }), // Bytes

    // Debug only - never used for matching (file paths differ across servers)
    filePath: text('file_path'),

    // Hierarchy fields for episodes and tracks (Plex-style naming)
    // For episodes: grandparent=show, parent=season, item_index=episode#, parent_index=season#
    // For tracks: grandparent=artist, parent=album, item_index=track#
    grandparentTitle: varchar('grandparent_title', { length: 500 }),
    grandparentRatingKey: varchar('grandparent_rating_key', { length: 255 }),
    parentTitle: varchar('parent_title', { length: 500 }),
    parentRatingKey: varchar('parent_rating_key', { length: 255 }),
    parentIndex: integer('parent_index'), // season number for episodes
    itemIndex: integer('item_index'), // episode number or track number

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Partial B-tree indexes on external IDs (exclude NULLs - saves 20-40% index size)
    index('idx_library_items_imdb_partial')
      .on(table.imdbId)
      .where(sql`${table.imdbId} IS NOT NULL`),
    index('idx_library_items_tmdb_partial')
      .on(table.tmdbId)
      .where(sql`${table.tmdbId} IS NOT NULL`),
    index('idx_library_items_tvdb_partial')
      .on(table.tvdbId)
      .where(sql`${table.tvdbId} IS NOT NULL`),

    // Composite index for library-scoped queries
    index('idx_library_items_server_library').on(table.serverId, table.libraryId),

    // Unique constraint to prevent duplicates (one rating_key per server)
    uniqueIndex('library_items_server_rating_key_unique').on(table.serverId, table.ratingKey),

    // Composite index for media type filtering (used by nearly all library routes)
    index('idx_library_items_server_media_type').on(table.serverId, table.mediaType),

    // Composite index for growth queries (created_at range filtering with server context)
    index('idx_library_items_server_created').on(table.serverId, table.createdAt),

    // GIN trigram index for fuzzy duplicate detection (requires pg_trgm extension)
    index('idx_library_items_title_trgm').using('gin', sql`${table.title} gin_trgm_ops`),
  ]
);

/**
 * Library Snapshots - Time-series table for tracking library state over time
 *
 * This table is converted to a TimescaleDB hypertable with 1-day chunks.
 * Stores aggregate statistics per library per snapshot time.
 *
 * CRITICAL: Dimensions limited to server_id, library_id, snapshot_time to prevent
 * cardinality explosion. No unbounded fields (title, file_path) as columns.
 *
 * Compression: Activates after 3 days (allows enrichment to complete)
 * Retention: 1 year (automatic chunk dropping)
 */
export const librarySnapshots = pgTable(
  'library_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // DIMENSION: Low cardinality (~1-10 servers)
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    // DIMENSION: Low cardinality (~10-50 libraries per server)
    libraryId: varchar('library_id', { length: 100 }).notNull(),
    // TIME DIMENSION: Primary partitioning key for hypertable
    snapshotTime: timestamp('snapshot_time', { withTimezone: true }).notNull(),

    // Aggregate counts - total items in library at snapshot time
    itemCount: integer('item_count').notNull(),
    totalSize: bigint('total_size', { mode: 'number' }).notNull(), // Bytes

    // Media type breakdown
    movieCount: integer('movie_count').notNull().default(0),
    episodeCount: integer('episode_count').notNull().default(0),
    seasonCount: integer('season_count').notNull().default(0),
    showCount: integer('show_count').notNull().default(0),
    musicCount: integer('music_count').notNull().default(0),

    // Resolution breakdown
    count4k: integer('count_4k').notNull().default(0),
    count1080p: integer('count_1080p').notNull().default(0),
    count720p: integer('count_720p').notNull().default(0),
    countSd: integer('count_sd').notNull().default(0),

    // Codec breakdown
    hevcCount: integer('hevc_count').notNull().default(0),
    h264Count: integer('h264_count').notNull().default(0),
    av1Count: integer('av1_count').notNull().default(0),

    // Enrichment status tracking
    enrichmentPending: integer('enrichment_pending').notNull().default(0),
    enrichmentComplete: integer('enrichment_complete').notNull().default(0),
  },
  (table) => [
    // Composite index for time-series queries by server and library
    index('library_snapshots_server_library_time_idx').on(
      table.serverId,
      table.libraryId,
      table.snapshotTime
    ),
    // Index on snapshot_time for retention policy efficiency
    index('library_snapshots_time_idx').on(table.snapshotTime),
  ]
);

export const librarySnapshotsRelations = relations(librarySnapshots, ({ one }) => ({
  server: one(servers, {
    fields: [librarySnapshots.serverId],
    references: [servers.id],
  }),
}));

export const libraryItemsRelations = relations(libraryItems, ({ one }) => ({
  server: one(servers, {
    fields: [libraryItems.serverId],
    references: [servers.id],
  }),
}));
