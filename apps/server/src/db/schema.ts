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
  primaryKey,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import {
  MEDIA_TYPES,
  type AutomationKind,
  type EmailRichTextDoc,
  type EmailSuppressionReason,
  type NewsletterImageMode,
  type NewsletterLinks,
  type NewsletterRecipientStatus,
  type NewsletterRecipients,
  type NewsletterSchedule,
  type NewsletterScope,
  type NewsletterSections,
  type NewsletterSendOutcome,
  type NewsletterSendTrigger,
  type NewsletterSendVariant,
  type NewsletterWindow,
  type NotificationEventType,
  type RequestCounts,
  type RequestServiceType,
  type MediaRequestStatus,
  type RequestSeason,
  type RunOutcome,
  type TEMPLATE_GROUPS,
  type TemplateDefinition,
  type TemplateInput,
  type TriggerNode,
} from '@tracearr/shared';

// Server types enum
export const serverTypeEnum = ['plex', 'jellyfin', 'emby'] as const;

// Session state enum
export const sessionStateEnum = ['playing', 'paused', 'stopped'] as const;

// Media type enum - imported from shared package
export const mediaTypeEnum = MEDIA_TYPES;

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
  AutomationConditions,
  AutomationActions,
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
    // The address members open a Jellyfin or Emby server at; always null for Plex, which links through app.plex.tv.
    publicUrl: text('public_url'),
    token: text('token').notNull(), // Encrypted
    machineIdentifier: varchar('machine_identifier', { length: 100 }), // The media server's own id: Plex clientIdentifier (also used for dedup), Jellyfin/Emby System/Info Id
    // For Plex servers: which linked Plex account this server was added from (nullable for Jellyfin/Emby and legacy)
    plexAccountId: uuid('plex_account_id'),
    displayOrder: integer('display_order').default(0).notNull(),
    color: varchar('color', { length: 7 }), // Hex color like #3b82f6
    // The version the media server reports, and the newest release known for it.
    version: text('version'),
    latestVersion: text('latest_version'),
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
    // Non-normalized username shown in the UI; better-auth username plugin field.
    displayUsername: varchar('display_username', { length: 100 }),
    name: varchar('name', { length: 255 }), // Display name (optional, defaults to null)
    thumbnail: text('thumbnail'), // Custom avatar (nullable)
    email: varchar('email', { length: 255 }), // For identity matching (nullable)
    emailVerified: boolean('email_verified').notNull().default(false),
    // Owner-typed address for newsletters only; never a login, never a sync match key
    contactEmail: varchar('contact_email', { length: 255 }),

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

    // better-auth admin plugin fields
    banned: boolean('banned'),
    banReason: text('ban_reason'),
    banExpires: timestamp('ban_expires', { withTimezone: true }),

    // Aggregated metrics (cached, recomputed in-app by recomputeIdentityAggregates
    // after every serverUsers.trustScore write and violation insert - no
    // database trigger exists)
    aggregateTrustScore: integer('aggregate_trust_score').notNull().default(100),
    totalViolations: integer('total_violations').notNull().default(0),

    // Identity-level date rollups over ALL of the person's accounts, removed
    // ones included: removing an account does not un-happen its history. Trust
    // deliberately does not follow that rule (it prefers active accounts).
    firstJoinedAt: timestamp('first_joined_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Username is display name from media server (not unique across servers)
    index('users_username_idx').on(table.username),
    // Login usernames must be case-insensitively unique; members keep sharing
    // usernames freely (distinct humans on different servers can collide).
    uniqueIndex('users_login_username_unique')
      .on(sql`lower(${table.username})`)
      .where(sql`role IN ('owner', 'admin', 'viewer')`),
    uniqueIndex('users_email_unique').on(table.email),
    index('users_plex_account_id_idx').on(table.plexAccountId),
    index('users_role_idx').on(table.role),
    // Roster sort orders. Each one has to match the ORDER BY in
    // routes/users/list.ts key for key, direction for direction, nulls for
    // nulls, or the plan drops from an index scan to an incremental sort.
    index('users_display_name_idx').on(sql`coalesce(${table.name}, ${table.username})`, table.id),
    index('users_aggregate_trust_idx').on(table.aggregateTrustScore.desc(), table.id),
    index('users_first_joined_idx').on(table.firstJoinedAt.desc().nullsLast(), table.id),
    index('users_last_activity_idx').on(table.lastActivityAt.desc().nullsLast(), table.id),
    // Roster search matches users.name or any account's username
    index('users_name_trgm_idx').using('gin', sql`${table.name} gin_trgm_ops`),
    check(
      'users_contact_email_lower',
      sql`${table.contactEmail} IS NULL OR ${table.contactEmail} = lower(${table.contactEmail})`
    ),
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

    // Removal tracking - set when user no longer exists on media server
    removedAt: timestamp('removed_at', { withTimezone: true }),

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
    index('server_users_username_trgm_idx').using('gin', sql`${table.username} gin_trgm_ops`),
    // For Plex sync matching by plex.tv account ID
    index('server_users_plex_account_idx').on(table.serverId, table.plexAccountId),
    // For account inactivity rule queries
    index('server_users_last_activity_idx').on(table.lastActivityAt),
    // For filtering out removed users
    index('server_users_removed_at_idx').on(table.removedAt),
  ]
);

/**
 * External ids whose own server_users row was folded into another one by a
 * same-server merge.
 *
 * Without this the fold is undone by ordinary playback: the merge deletes the
 * absorbed row, the media server keeps reporting that external id, and the
 * poller's (server_id, external_id) lookup misses and creates a fresh account
 * under a fresh identity. Lookups fall back here so the session lands on the
 * surviving account.
 */
export const serverUserExternalAliases = pgTable(
  'server_user_external_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    serverUserId: uuid('server_user_id')
      .notNull()
      .references(() => serverUsers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Mirrors server_users_server_external_unique: one owner per external id per server
    uniqueIndex('server_user_external_aliases_server_external_unique').on(
      table.serverId,
      table.externalId
    ),
    index('server_user_external_aliases_server_user_idx').on(table.serverUserId),
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
    grandparentTitle: text('grandparent_title'), // Show name (for episodes)
    seasonNumber: integer('season_number'), // Season number (for episodes)
    episodeNumber: integer('episode_number'), // Episode number (for episodes)
    year: integer('year'), // Release year
    thumbPath: varchar('thumb_path', { length: 500 }), // Poster path (e.g., /library/metadata/123/thumb)
    ratingKey: varchar('rating_key', { length: 255 }), // Plex/Jellyfin media identifier
    // Which file/version of the item was played (Plex Media.id, JF/Emby
    // MediaSource id). Soft reference like ratingKey: server-scoped, no FK,
    // de-references gracefully after a library rebuild.
    serverVersionKey: varchar('server_version_key', { length: 255 }),
    parentRatingKey: varchar('parent_rating_key', { length: 255 }),
    grandparentRatingKey: varchar('grandparent_rating_key', { length: 255 }),
    // Identity stamped at insert from library_items/media; survives item deletion
    mediaId: uuid('media_id'),
    showMediaId: uuid('show_media_id'),
    imdbId: varchar('imdb_id', { length: 20 }),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
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
    // sessions_external_session_idx removed - the only predicates on external_session_id
    // (import cursor CAST, dedup regex) are non-sargable for a btree
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
    // sessions_geo_idx and sessions_geo_time_idx removed - every geo predicate carries
    // IS NOT NULL, so idx_sessions_geo_partial in timescale.ts covers them all
    index('sessions_media_type_idx').on(table.mediaType), // For media type aggregations
    index('sessions_transcode_idx').on(table.isTranscode), // For quality stats
    index('sessions_platform_idx').on(table.platform), // For platform stats
    // sessions_top_movies_idx and sessions_top_shows_idx removed - superseded by time-prefixed variants in timescale.ts
    // Covering index for history aggregates queries (server + date range + reference_id for COUNT DISTINCT)
    index('idx_sessions_server_date_ref').on(table.serverId, table.startedAt, table.referenceId),
    // sessions_stale_detection_idx removed - the stale sweep is the only last_seen_at
    // predicate and idx_sessions_open_last_seen (partial, timescale.ts) matches it exactly
    index('sessions_media_idx').on(table.mediaId, table.startedAt),
    index('sessions_show_media_idx').on(table.showMediaId, table.startedAt),
  ]
);

// A parameterized automation blueprint; instances bind its inputs and point back at it
export const automationTemplates = pgTable('automation_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  group: text('group').notNull().$type<(typeof TEMPLATE_GROUPS)[number]>(),
  kind: text('kind').notNull().$type<AutomationKind>(),
  builtin: boolean('builtin').notNull().default(false),
  source: text('source').notNull().$type<'builtin' | 'import' | 'local'>(),
  author: text('author'),
  minServerVersion: text('min_server_version'),
  currentVersion: integer('current_version').notNull().default(1),
  fingerprint: text('fingerprint').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Immutable per-version payload; a fingerprint change appends a row rather than editing one
export const automationTemplateVersions = pgTable(
  'automation_template_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => automationTemplates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    inputs: jsonb('inputs').$type<TemplateInput[]>().notNull(),
    definition: jsonb('definition').$type<TemplateDefinition>().notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('automation_template_versions_template_version_uq').on(table.templateId, table.version),
  ]
);

// Automations (sharing detection policies and notification housekeeping)
export const automations = pgTable(
  'automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    conditions: jsonb('conditions').$type<AutomationConditions>(),
    actions: jsonb('actions').$type<AutomationActions>(),
    kind: text('kind').notNull().default('policy').$type<AutomationKind>(),
    // The NOT NULL lands at runtime once the boot pass has backfilled every row.
    triggers: jsonb('triggers').$type<TriggerNode[]>().notNull().default([]),
    severity: varchar('severity', { length: 20 })
      .notNull()
      .default('warning')
      .$type<(typeof violationSeverityEnum)[number]>(),
    // Scope - at most one of serverId, serverUserId, userId is ever set
    // (enforced in the Zod schema/route validation, not a DB constraint - this
    // table has no other CHECK constraints today).
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    serverUserId: uuid('server_user_id').references(() => serverUsers.id, { onDelete: 'cascade' }),
    // Identity (person) scope: applies to every server_user of this identity.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // Opt-in cross-server enforcement for identity-aware rules. Defaults false
    // so every existing rule keeps today's single-account behavior.
    enforceAcrossServers: boolean('enforce_across_servers').notNull().default(false),
    // Null falls back to the per-kind default in the retention worker.
    cooldownMinutes: integer('cooldown_minutes'),
    retentionDays: integer('retention_days'),
    templateId: uuid('template_id').references(() => automationTemplates.id, {
      onDelete: 'restrict',
    }),
    templateVersion: integer('template_version'),
    templateInputs: jsonb('template_inputs').$type<Record<string, unknown>>(),
    // Where a detached instance came from; kept for provenance, so no FK.
    originTemplateId: uuid('origin_template_id'),
    originTemplateVersion: integer('origin_template_version'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('automations_active_idx').on(table.isActive),
    index('automations_server_id_idx').on(table.serverId),
    index('automations_server_user_id_idx').on(table.serverUserId),
    index('automations_user_id_idx').on(table.userId),
    index('automations_template_id_idx').on(table.templateId),
  ]
);

// Immutable snapshot of an automation's definition; runs point at the version they ran
export const automationVersions = pgTable(
  'automation_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('automation_versions_automation_version_uq').on(table.automationId, table.version),
  ]
);

// One row per automation run; policy runs that completed are what the UI calls violations
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // The physical column is still rule_id; only the drizzle property carries the new name.
    automationId: uuid('rule_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    // Links to server_users for per-server tracking
    serverUserId: uuid('server_user_id').references(() => serverUsers.id, { onDelete: 'cascade' }),
    // Nullable: null for account_inactivity rules (no associated session)
    // No FK: sessions is a hypertable, so timescale.ts drops the constraint at boot.
    sessionId: uuid('session_id'),
    severity: varchar('severity', { length: 20 }).$type<(typeof violationSeverityEnum)[number]>(),
    // The server the run acted on; no FK, so a deleted server leaves its runs readable.
    serverId: uuid('server_id'),
    data: jsonb('data').notNull().$type<Record<string, unknown>>(),
    kind: text('kind').notNull().default('policy').$type<AutomationKind>(),
    outcome: text('outcome').notNull().default('completed').$type<RunOutcome>(),
    humanSummary: text('human_summary'),
    definitionVersionId: uuid('definition_version_id').references(() => automationVersions.id),
    steps: jsonb('steps').$type<unknown[]>(),
    // What the run was about, by scope: session id, server user id, `server:<id>` or `install`.
    subjectKey: text('subject_key'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    // Soft delete. Dismiss keeps the row so dedup still sees it and the same
    // violation can never re-arm (the inactivity worker recreated dismissed
    // violations hourly when dismiss was a hard delete). Read paths filter on
    // dismissedAt IS NULL; the partial unique index below still blocks
    // re-inserts because dismissed rows keep acknowledgedAt null.
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  },
  (table) => [
    index('automation_runs_server_user_id_idx').on(table.serverUserId),
    index('automation_runs_rule_id_idx').on(table.automationId),
    index('automation_runs_created_at_idx').on(table.createdAt),
    // Composite index for deduplication queries:
    // SELECT ... WHERE serverUserId = ? AND acknowledgedAt IS NULL AND createdAt >= ?
    index('automation_runs_dedup_idx').on(
      table.serverUserId,
      table.acknowledgedAt,
      table.createdAt
    ),
    // Partial unique index to prevent duplicate unacknowledged session-based violations
    // Defense-in-depth: catches race conditions that bypass application-level dedup
    // Notification runs stay out of it: they accumulate completed rows per subject.
    uniqueIndex('automation_runs_unique_active_subject')
      .on(table.automationId, table.subjectKey)
      .where(
        sql`kind = 'policy' AND outcome = 'completed' AND acknowledged_at IS NULL AND session_id IS NOT NULL`
      ),
    // Index for inactivity rule deduplication queries
    // SELECT ... WHERE serverUserId = ? AND ruleId = ? AND acknowledgedAt IS NULL
    index('automation_runs_inactivity_dedup_idx').on(
      table.serverUserId,
      table.automationId,
      table.acknowledgedAt
    ),
    // The retention purge scans by kind and age.
    index('automation_runs_retention_idx').on(table.kind, table.finishedAt),
    // The notification gate reads (automation, subject) and filters the edge out of data.
    index('automation_runs_notification_gate_idx')
      .on(table.automationId, table.subjectKey)
      .where(sql`kind = 'notification' AND outcome = 'completed'`),
    // Every violation count and list composes the alias; diagnostics outnumber it 20:1.
    // The id column is the list's paging tiebreak, so the scan needs no sort on top.
    index('automation_runs_violation_alias_idx')
      .on(table.createdAt.desc().nullsFirst(), table.id)
      .where(sql`kind = 'policy' AND outcome = 'completed'`),
    // The runs list default sort; null placement and tiebreak match its ORDER BY.
    index('automation_runs_started_at_idx').on(table.startedAt.desc().nullsLast(), table.id),
    // Every runs list narrows by the caller's servers before it sorts.
    index('automation_runs_server_started_idx').on(table.serverId, table.startedAt.desc()),
  ]
);

// Rule action execution results (for V2 rules)
export const ruleActionResults = pgTable(
  'rule_action_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    violationId: uuid('violation_id').references(() => automationRuns.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id').references(() => automations.id, { onDelete: 'cascade' }),
    actionType: varchar('action_type', { length: 50 }).notNull(),
    success: boolean('success').notNull(),
    skipped: boolean('skipped').default(false),
    skipReason: text('skip_reason'),
    errorMessage: text('error_message'),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_rule_action_results_violation').on(table.violationId),
    index('idx_rule_action_results_rule').on(table.ruleId),
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
    previousRefreshTokenHash: varchar('previous_refresh_token_hash', { length: 64 }),
    // Set for pairings created after the better-auth migration; null for legacy pairings
    betterAuthSessionId: text('better_auth_session_id'),
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
    index('mobile_sessions_ba_session_idx').on(table.betterAuthSessionId),
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

export const destinationKindEnum = [
  'discord',
  'json_webhook',
  'ntfy',
  'gotify',
  'apprise',
  'pushover',
  'email',
  'push',
  'web_toast',
] as const;

// Outbound notification destinations; config is AES-GCM ciphertext (destinationCrypto), NULL for built-ins.
export const destinations = pgTable(
  'destinations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    type: varchar('type', { length: 30 }).notNull().$type<(typeof destinationKindEnum)[number]>(),
    config: text('config'),
    events: jsonb('events').notNull().default([]).$type<NotificationEventType[]>(),
    enabled: boolean('enabled').notNull().default(true),
    builtin: boolean('builtin').notNull().default(false),
    configStatus: varchar('config_status', { length: 20 })
      .notNull()
      .default('ok')
      .$type<'ok' | 'reencrypt'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('destinations_builtin_type_uidx')
      .on(table.type)
      .where(sql`${table.builtin} = true`),
  ]
);

export const requestServices = pgTable(
  'request_services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 20 }).notNull().$type<RequestServiceType>(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    config: text('config'),
    configStatus: varchar('config_status', { length: 20 })
      .notNull()
      .default('ok')
      .$type<'ok' | 'reencrypt'>(),
    enabled: boolean('enabled').notNull().default(true),
    remoteServerId: text('remote_server_id').notNull(),
    version: text('version'),
    syncCursor: timestamp('sync_cursor', { withTimezone: true }),
    lastCounts: jsonb('last_counts').$type<RequestCounts>(),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastFullSyncAt: timestamp('last_full_sync_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('request_services_server_unique').on(table.serverId)]
);

export const mediaRequests = pgTable(
  'media_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => requestServices.id, { onDelete: 'cascade' }),
    remoteId: integer('remote_id').notNull(),
    remoteMediaId: integer('remote_media_id').notNull(),
    mediaType: varchar('media_type', { length: 10 }).notNull().$type<'movie' | 'show'>(),
    title: text('title'),
    year: integer('year'),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    imdbId: varchar('imdb_id', { length: 20 }),
    ratingKey: varchar('rating_key', { length: 255 }),
    // Same convention as libraryItems.mediaId: media rows merge-fold, so no FK
    mediaId: uuid('media_id'),
    serverUserId: uuid('server_user_id').references(() => serverUsers.id, {
      onDelete: 'set null',
    }),
    remoteUserId: integer('remote_user_id').notNull(),
    remoteUsername: text('remote_username').notNull(),
    remotePlexId: varchar('remote_plex_id', { length: 64 }),
    remoteJellyfinUserId: varchar('remote_jellyfin_user_id', { length: 64 }),
    status: varchar('status', { length: 20 }).notNull().$type<MediaRequestStatus>(),
    seasons: jsonb('seasons').$type<RequestSeason[]>(),
    is4k: boolean('is_4k').notNull().default(false),
    isAutoRequest: boolean('is_auto_request').notNull().default(false),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }),
    remoteUpdatedAt: timestamp('remote_updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_requests_service_remote_unique').on(table.serviceId, table.remoteId),
    index('media_requests_media_idx').on(table.mediaId),
    index('media_requests_server_user_idx').on(table.serverUserId),
    index('media_requests_requested_at_idx').on(table.requestedAt),
    index('media_requests_service_updated_idx').on(table.serviceId, table.remoteUpdatedAt),
  ]
);

/** What a delivery needs to turn a `poster:<cardId>` reference back into bytes or a URL. */
export interface PosterRef {
  serverId: string;
  thumbPath: string;
  version: string;
}

export const newsletters = pgTable('newsletters', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  enabled: boolean('enabled').notNull().default(true),
  destinationId: uuid('destination_id').references(() => destinations.id, { onDelete: 'set null' }),
  schedule: jsonb('schedule').notNull().$type<NewsletterSchedule>(),
  timezone: text('timezone').notNull(),
  window: jsonb('window').notNull().$type<NewsletterWindow>(),
  scope: jsonb('scope').notNull().$type<NewsletterScope>(),
  sections: jsonb('sections').notNull().$type<NewsletterSections>(),
  subject: text('subject').notNull(),
  senderName: text('sender_name'),
  intro: jsonb('intro').$type<EmailRichTextDoc>(),
  outro: jsonb('outro').$type<EmailRichTextDoc>(),
  recipients: jsonb('recipients').notNull().$type<NewsletterRecipients>(),
  imageMode: text('image_mode').notNull().default('auto').$type<NewsletterImageMode>(),
  skipWhenEmpty: boolean('skip_when_empty').notNull().default(true),
  links: jsonb('links').notNull().default({ tracearr: false }).$type<NewsletterLinks>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const newsletterSends = pgTable(
  'newsletter_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    newsletterId: uuid('newsletter_id')
      .notNull()
      .references(() => newsletters.id, { onDelete: 'cascade' }),
    // The transport at send time; no FK, so a deleted destination leaves history readable
    destinationId: uuid('destination_id'),
    trigger: text('trigger').notNull().$type<NewsletterSendTrigger>(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    itemCounts: jsonb('item_counts').notNull().default({}).$type<Record<string, number>>(),
    recipientCount: integer('recipient_count').notNull().default(0),
    outcome: text('outcome').notNull().default('rendering').$type<NewsletterSendOutcome>(),
    error: text('error'),
    // One entry per set of servers some recipient belongs to
    variants: jsonb('variants').notNull().default([]).$type<NewsletterSendVariant[]>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    // One open send per newsletter: a manual and a scheduled run cannot overlap
    uniqueIndex('newsletter_sends_open_uidx')
      .on(table.newsletterId)
      .where(sql`${table.outcome} IN ('rendering', 'sending')`),
    index('idx_newsletter_sends_newsletter_started').on(table.newsletterId, table.startedAt),
  ]
);

/** The rendered digest of one variant; the send's view link and delivery both read it. */
export const newsletterSendSnapshots = pgTable(
  'newsletter_send_snapshots',
  {
    sendId: uuid('send_id')
      .notNull()
      .references(() => newsletterSends.id, { onDelete: 'cascade' }),
    variantKey: text('variant_key').notNull(),
    viewToken: text('view_token').notNull().unique(),
    // The rendered subject; the newsletter's template can change after the send
    subject: text('subject').notNull(),
    // Rendered once with poster:<cardId> refs; retention deletes the row
    html: text('html').notNull(),
    text: text('text').notNull(),
    posters: jsonb('posters').notNull().default({}).$type<Record<string, PosterRef>>(),
  },
  (table) => [primaryKey({ columns: [table.sendId, table.variantKey] })]
);

export const newsletterSendRecipients = pgTable(
  'newsletter_send_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sendId: uuid('send_id')
      .notNull()
      .references(() => newsletterSends.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Which snapshot this person gets; retry-failed re-enqueues with it
    variantKey: text('variant_key').notNull(),
    status: text('status').notNull().default('queued').$type<NewsletterRecipientStatus>(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    // Written before the send is attempted, so a retry can tell a lost reply from a lost connection
    messageId: text('message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [index('idx_newsletter_send_recipients_send_status').on(table.sendId, table.status)]
);

export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    address: text('address').primaryKey(),
    reason: text('reason').notNull().$type<EmailSuppressionReason>(),
    sourceSendId: uuid('source_send_id').references(() => newsletterSends.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('email_suppressions_lower', sql`${table.address} = lower(${table.address})`)]
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
    ruleId: uuid('rule_id').references(() => automations.id, { onDelete: 'set null' }),
    violationId: uuid('violation_id').references(() => automationRuns.id, { onDelete: 'set null' }),

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

// User merge audit trail. Records every identity merge so non-destructive
// merges can be undone via split. sourceUserId has no FK because the merge
// deletes that users row.
export const userMergeAudits = pgTable(
  'user_merge_audits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceUserId: uuid('source_user_id').notNull(),
    targetUserId: uuid('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actingUserId: uuid('acting_user_id').references(() => users.id, { onDelete: 'set null' }),
    movedServerUserIds: jsonb('moved_server_user_ids').notNull().$type<string[]>(),
    combinedServerUsers: jsonb('combined_server_users')
      .notNull()
      .$type<{ sourceServerUserId: string; targetServerUserId: string; serverId: string }[]>(),
    wasSameServerCombine: boolean('was_same_server_combine').notNull().default(false),
    sourceUserSnapshot: jsonb('source_user_snapshot').notNull().$type<{
      username: string;
      name: string | null;
      email: string | null;
      thumbnail: string | null;
      role: string;
    }>(),
    // Which plex_accounts / mobile_sessions / mobile_tokens rows repointIdentityRows
    // moved off the source identity during this merge, so a later split can move
    // exactly those rows back onto the restored identity. Null on audit rows written
    // before this column existed; split treats null the same as "nothing recorded"
    // and leaves those rows on the target, matching the pre-existing behavior.
    movedIdentityRowIds: jsonb('moved_identity_row_ids').$type<{
      plexAccountIds: string[];
      mobileSessionIds: string[];
      mobileTokenIds: string[];
    }>(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('user_merge_audits_target_idx').on(table.targetUserId),
    index('user_merge_audits_created_at_idx').on(table.createdAt),
  ]
);

// Unit system enum for display preferences
export const unitSystemEnum = ['metric', 'imperial'] as const;

// Application settings (key-value store)
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  value: jsonb('value'),
});

// ============================================================================
// Better Auth tables (session storage, login providers, verification tokens)
// Field set matches better-auth 1.6.23 codegen for core + username + admin + bearer.
// ============================================================================

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_sessions_user_idx').on(table.userId)]
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_accounts_user_idx').on(table.userId),
    unique('auth_accounts_provider_account_unique').on(table.providerId, table.accountId),
  ]
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_verifications_identifier_idx').on(table.identifier)]
);

// ============================================================================
// Relations
// ============================================================================

export const serversRelations = relations(servers, ({ one, many }) => ({
  serverUsers: many(serverUsers),
  sessions: many(sessions),
  libraryItems: many(libraryItems),
  librarySnapshots: many(librarySnapshots),
  libraries: many(libraries),
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
  automations: many(automations),
  automationRuns: many(automationRuns),
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
  automationRuns: many(automationRuns),
}));

export const automationsRelations = relations(automations, ({ one, many }) => ({
  server: one(servers, {
    fields: [automations.serverId],
    references: [servers.id],
  }),
  serverUser: one(serverUsers, {
    fields: [automations.serverUserId],
    references: [serverUsers.id],
  }),
  runs: many(automationRuns),
  versions: many(automationVersions),
  actionResults: many(ruleActionResults),
}));

export const automationVersionsRelations = relations(automationVersions, ({ one }) => ({
  automation: one(automations, {
    fields: [automationVersions.automationId],
    references: [automations.id],
  }),
}));

export const automationRunsRelations = relations(automationRuns, ({ one, many }) => ({
  automation: one(automations, {
    fields: [automationRuns.automationId],
    references: [automations.id],
  }),
  serverUser: one(serverUsers, {
    fields: [automationRuns.serverUserId],
    references: [serverUsers.id],
  }),
  session: one(sessions, {
    fields: [automationRuns.sessionId],
    references: [sessions.id],
  }),
  definitionVersion: one(automationVersions, {
    fields: [automationRuns.definitionVersionId],
    references: [automationVersions.id],
  }),
  actionResults: many(ruleActionResults),
}));

export const ruleActionResultsRelations = relations(ruleActionResults, ({ one }) => ({
  violation: one(automationRuns, {
    fields: [ruleActionResults.violationId],
    references: [automationRuns.id],
  }),
  rule: one(automations, {
    fields: [ruleActionResults.ruleId],
    references: [automations.id],
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
  rule: one(automations, {
    fields: [terminationLogs.ruleId],
    references: [automations.id],
  }),
  violation: one(automationRuns, {
    fields: [terminationLogs.violationId],
    references: [automationRuns.id],
  }),
}));

export const userMergeAuditsRelations = relations(userMergeAudits, ({ one }) => ({
  targetUser: one(users, {
    fields: [userMergeAudits.targetUserId],
    references: [users.id],
  }),
  actingUser: one(users, {
    fields: [userMergeAudits.actingUserId],
    references: [users.id],
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
    title: text('title').notNull(),
    mediaType: varchar('media_type', { length: 20 }).notNull(), // movie, episode, season, show, artist, album, track
    year: integer('year'),

    // Quality tracking
    videoResolution: varchar('video_resolution', { length: 20 }), // '4k', '1080p', '720p', 'sd'
    videoCodec: varchar('video_codec', { length: 50 }), // 'hevc', 'h264', 'av1'
    audioCodec: varchar('audio_codec', { length: 50 }),
    audioChannels: integer('audio_channels'), // 2 (stereo), 6 (5.1), 8 (7.1)
    fileSize: bigint('file_size', { mode: 'number' }), // Bytes
    // Normalized dynamic range token (see @tracearr/shared normalizeDynamicRange),
    // e.g. 'sdr', 'hdr10', 'dolby vision'. Newly tracked: copies synced before this
    // column existed show no value until their server's next sync.
    videoDynamicRange: varchar('video_dynamic_range', { length: 20 }),

    // Quality columns above are rollups over library_item_versions: file_size
    // is the SUM of active versions, the rest come from the best version.
    versionCount: integer('version_count').notNull().default(1),
    // Hash over the sorted active-version tuples, computed at parse time.
    // Joins the upsert's setWhere guard so version-only changes update the row.
    versionsFingerprint: text('versions_fingerprint'),

    // Debug only - never used for matching (file paths differ across servers)
    filePath: text('file_path'),

    // Hierarchy fields for episodes and tracks (Plex-style naming)
    // For episodes: grandparent=show, parent=season, item_index=episode#, parent_index=season#
    // For tracks: grandparent=artist, parent=album, item_index=track#
    grandparentTitle: text('grandparent_title'),
    grandparentRatingKey: varchar('grandparent_rating_key', { length: 255 }),
    parentTitle: text('parent_title'),
    parentRatingKey: varchar('parent_rating_key', { length: 255 }),
    parentIndex: integer('parent_index'), // season number for episodes
    itemIndex: integer('item_index'), // episode number or track number

    // Canonical identity (media.id); resolved during library sync
    mediaId: uuid('media_id'),
    genres: text('genres').array(),
    // Soft delete - set when the item disappears from the server; upsert clears it
    removedAt: timestamp('removed_at', { withTimezone: true }),
    // 'event' (SSE removal, accurate time) or 'scan' (removed_at = when the scan noticed)
    removedSource: varchar('removed_source', { length: 10 }),
    // id of the copy this row replaced; set once by event-witnessed replacement linking
    replacesLibraryItemId: uuid('replaces_library_item_id'),
    // When Tracearr first saw this rating key; app-set on insert, null = predates tracking
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),

    // Browsing UI: cached poster thumbnail path and dominant color accent
    thumbPath: text('thumb_path'),
    dominantColor: varchar('dominant_color', { length: 7 }),

    // Timestamps
    // Holds the SERVER-reported added date (sync overwrites it), not Tracearr first-sync time
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

    // The image pipeline's dominant-color persist and stored-color read both
    // filter on (server_id, thumb_path); without this they seq-scan the table
    // once per poster during a cache warm
    index('idx_library_items_server_thumb').on(table.serverId, table.thumbPath),

    // Composite index for growth queries (created_at range filtering with server context)
    index('idx_library_items_server_created').on(table.serverId, table.createdAt),

    // GIN trigram index for fuzzy duplicate detection (requires pg_trgm extension)
    index('idx_library_items_title_trgm').using('gin', sql`${table.title} gin_trgm_ops`),

    index('idx_library_items_media').on(table.mediaId),
    index('idx_library_items_removed')
      .on(table.removedAt)
      .where(sql`${table.removedAt} IS NOT NULL`),

    // Ascending so a backward scan matches the recently-added ORDER BY created_at DESC, id DESC
    index('idx_library_items_added_active')
      .on(table.createdAt, table.id)
      .where(sql`${table.removedAt} IS NULL`),

    index('idx_library_items_type_added_active')
      .on(table.mediaType, table.createdAt)
      .where(sql`${table.removedAt} IS NULL`),

    index('idx_library_items_resolution_active')
      .on(table.videoResolution)
      .where(sql`${table.removedAt} IS NULL`),

    // The availability query's hide-a-linked-tombstone probe seq-scans without this
    index('idx_library_items_replaces_active')
      .on(table.replacesLibraryItemId)
      .where(sql`${table.replacesLibraryItemId} IS NOT NULL AND ${table.removedAt} IS NULL`),

    index('idx_library_items_dynamic_range_active')
      .on(table.videoDynamicRange)
      .where(sql`${table.removedAt} IS NULL`),

    index('idx_library_items_seen_active')
      .on(sql`COALESCE(${table.firstSeenAt}, ${table.createdAt})`)
      .where(sql`${table.removedAt} IS NULL`),
  ]
);

/**
 * Physical file versions of a library item. One row per Plex Media child /
 * Jellyfin-Emby MediaSource; a single-file item has exactly one. Soft-deleted
 * via removed_at so an upgrade or deletion leaves history; the 'legacy:1'
 * sentinel rows seeded by the migration are the one exception and are hard
 * deleted when real versions replace them.
 */
export const libraryItemVersions = pgTable(
  'library_item_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    libraryItemId: uuid('library_item_id')
      .notNull()
      .references(() => libraryItems.id, { onDelete: 'cascade' }),

    // Plex Media.id / JF MediaSource.Id / Emby mediasource_{id}, stored as the
    // server reports it. Server-scoped and unstable across library rebuilds.
    serverVersionKey: varchar('server_version_key', { length: 255 }).notNull(),

    videoResolution: varchar('video_resolution', { length: 20 }),
    videoCodec: varchar('video_codec', { length: 50 }),
    videoDynamicRange: varchar('video_dynamic_range', { length: 20 }),
    audioCodec: varchar('audio_codec', { length: 50 }),
    audioChannels: integer('audio_channels'),
    container: varchar('container', { length: 50 }),
    bitrate: integer('bitrate'), // kbps

    fileSize: bigint('file_size', { mode: 'number' }), // SUM of this version's Parts, bytes
    partCount: integer('part_count').notNull().default(1),
    filePath: text('file_path'),

    // Our own observation timestamp; no server reports when a version was added
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('library_item_versions_item_key_unique').on(
      table.libraryItemId,
      table.serverVersionKey
    ),
    index('idx_liv_item_active')
      .on(table.libraryItemId)
      .where(sql`${table.removedAt} IS NULL`),
    index('idx_liv_resolution_active')
      .on(table.videoResolution)
      .where(sql`${table.removedAt} IS NULL`),
    // Backfill-completion signal: shrinks to empty as sentinels are replaced
    index('idx_liv_legacy_sentinel')
      .on(table.libraryItemId)
      .where(sql`${table.serverVersionKey} = 'legacy:1'`),
  ]
);

export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mediaType: varchar('media_type', { length: 20 }).notNull(),
    // Type-namespaced identity key, e.g. movie:imdb:tt0322259 (see mediaMatchKey.ts)
    matchKey: text('match_key').notNull(),
    imdbId: varchar('imdb_id', { length: 20 }),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    title: text('title').notNull(),
    normalizedTitle: text('normalized_title'),
    // Browse ordering key: like normalized_title but with a leading English
    // article (the/a/an) stripped, so "The Matrix" sorts and buckets under M.
    // Computed in app code (buildSortTitle) alongside every title write; the
    // old DB-generated expression used normalize(), which Postgres rejects on
    // non-UTF8 clusters (supervised installs used to initdb as SQL_ASCII).
    sortTitle: text('sort_title'),
    year: integer('year'),
    parentMediaId: uuid('parent_media_id'),
    showMediaId: uuid('show_media_id'),
    genres: text('genres').array(),
    mergedIntoId: uuid('merged_into_id'),
    // Newest library_items.created_at across all copies; drives recently-added browsing order
    latestAddedAt: timestamp('latest_added_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_match_key_unique').on(table.matchKey),
    index('idx_media_type_imdb')
      .on(table.mediaType, table.imdbId)
      .where(sql`${table.imdbId} IS NOT NULL`),
    index('idx_media_type_tmdb')
      .on(table.mediaType, table.tmdbId)
      .where(sql`${table.tmdbId} IS NOT NULL`),
    index('idx_media_type_tvdb')
      .on(table.mediaType, table.tvdbId)
      .where(sql`${table.tvdbId} IS NOT NULL`),
    index('idx_media_type_title_year').on(table.mediaType, table.normalizedTitle, table.year),
    index('idx_media_show').on(table.showMediaId),
    index('idx_media_parent').on(table.parentMediaId),
    index('idx_media_merged_into')
      .on(table.mergedIntoId)
      .where(sql`${table.mergedIntoId} IS NOT NULL`),

    // Keyset pagination for recently-added browsing; both columns DESC for a uniform ROW comparison
    index('idx_media_type_added_active')
      .on(table.mediaType, table.latestAddedAt.desc(), table.id.desc())
      .where(sql`${table.mergedIntoId} IS NULL`),
    index('idx_media_title_trgm').using('gin', sql`${table.normalizedTitle} gin_trgm_ops`),
    index('idx_media_type_title_id')
      .on(table.mediaType, table.normalizedTitle, table.id)
      .where(sql`${table.mergedIntoId} IS NULL`),
    // Keyset/offset walking order for the title-sorted catalog (article-aware)
    index('idx_media_type_sort_title_id')
      .on(table.mediaType, table.sortTitle, table.id)
      .where(sql`${table.mergedIntoId} IS NULL`),
    // Offset walking order for the year-sorted catalog
    index('idx_media_type_year_id')
      .on(table.mediaType, table.year.desc(), table.id.desc())
      .where(sql`${table.mergedIntoId} IS NULL`),
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

    // Multi-version rollups, nullable: NULL means "written before versions
    // existed", distinct from a genuine zero. Buckets above are overlapping
    // (a 4K+1080p title counts in both), so their sums can exceed item_count;
    // count_high_quality is titles with any version at 1080p or better and
    // cannot be derived from overlapping buckets.
    countHighQuality: integer('count_high_quality'),
    versionCount: integer('version_count'),
  },
  (table) => [
    // Unique (also covers the same composite time-series query pattern):
    // one snapshot per server+library+time. Backfill relies on this at the
    // database level (ON CONFLICT DO NOTHING) so a concurrent double-run
    // can't create duplicate rows. Valid on a hypertable because it includes
    // the partitioning column (snapshot_time).
    uniqueIndex('library_snapshots_server_library_time_idx').on(
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

/**
 * Libraries - Names/media type for each server's libraries, keyed by the
 * server's own library_id (the same id library_items.library_id carries).
 * Populated during library sync; not present for library_ids synced before
 * this table existed until their server's next sync.
 */
export const libraries = pgTable(
  'libraries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    libraryId: varchar('library_id', { length: 100 }).notNull(),
    name: text('name').notNull(),
    mediaType: varchar('media_type', { length: 20 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('libraries_server_library_unique').on(table.serverId, table.libraryId)]
);

export const librariesRelations = relations(libraries, ({ one }) => ({
  server: one(servers, {
    fields: [libraries.serverId],
    references: [servers.id],
  }),
}));
