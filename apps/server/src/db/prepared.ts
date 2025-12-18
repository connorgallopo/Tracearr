/**
 * Prepared statements for hot-path queries
 *
 * Prepared statements optimize performance by allowing PostgreSQL to reuse
 * query plans across executions. These are particularly valuable for:
 * - Queries called on every page load (dashboard)
 * - Queries called frequently during polling
 * - Queries with predictable parameter patterns
 *
 * @see https://orm.drizzle.team/docs/perf-queries
 */

import { eq, gte, and, isNull, desc, sql } from 'drizzle-orm';
import { db } from './client.js';
import { sessions, violations, users, serverUsers, servers, rules } from './schema.js';

// ============================================================================
// Dashboard Stats Queries
// ============================================================================

/**
 * Count unique plays (grouped by reference_id) since a given date
 * Used for: Dashboard "Today's Plays" metric
 * Called: Every dashboard page load
 */
export const playsCountSince = db
  .select({
    count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .prepare('plays_count_since');

/**
 * Sum total watch time since a given date
 * Used for: Dashboard "Watch Time" metric
 * Called: Every dashboard page load
 */
export const watchTimeSince = db
  .select({
    totalMs: sql<number>`COALESCE(SUM(duration_ms), 0)::bigint`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .prepare('watch_time_since');

/**
 * Count violations since a given date
 * Used for: Dashboard "Alerts" metric
 * Called: Every dashboard page load
 */
export const violationsCountSince = db
  .select({
    count: sql<number>`count(*)::int`,
  })
  .from(violations)
  .where(gte(violations.createdAt, sql.placeholder('since')))
  .prepare('violations_count_since');

/**
 * Count unique active users since a given date
 * Used for: Dashboard "Active Users Today" metric
 * Called: Every dashboard page load
 */
export const uniqueUsersSince = db
  .select({
    count: sql<number>`count(DISTINCT server_user_id)::int`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .prepare('unique_users_since');

/**
 * Count unacknowledged violations
 * Used for: Alert badge in navigation
 * Called: On app load and after acknowledgment
 */
export const unacknowledgedViolationsCount = db
  .select({
    count: sql<number>`count(*)::int`,
  })
  .from(violations)
  .where(isNull(violations.acknowledgedAt))
  .prepare('unacknowledged_violations_count');

// ============================================================================
// Polling Queries
// ============================================================================

/**
 * Find server user by server ID and external ID
 * Used for: Server user lookup during session polling
 * Called: Every poll cycle for each active session (potentially 10+ times per 15 seconds)
 */
export const serverUserByExternalId = db
  .select()
  .from(serverUsers)
  .where(
    and(
      eq(serverUsers.serverId, sql.placeholder('serverId')),
      eq(serverUsers.externalId, sql.placeholder('externalId'))
    )
  )
  .limit(1)
  .prepare('server_user_by_external_id');

/**
 * Find session by server ID and session key
 * Used for: Session lookup during polling to check for existing sessions
 * Called: Every poll cycle for each active session
 */
export const sessionByServerAndKey = db
  .select()
  .from(sessions)
  .where(
    and(
      eq(sessions.serverId, sql.placeholder('serverId')),
      eq(sessions.sessionKey, sql.placeholder('sessionKey'))
    )
  )
  .limit(1)
  .prepare('session_by_server_and_key');

// ============================================================================
// User Queries
// ============================================================================

/**
 * Get server user by ID with basic info
 * Used for: Server user details in violations, sessions
 * Called: Frequently for UI enrichment
 */
export const serverUserById = db
  .select({
    id: serverUsers.id,
    userId: serverUsers.userId,
    username: serverUsers.username,
    thumbUrl: serverUsers.thumbUrl,
    trustScore: serverUsers.trustScore,
  })
  .from(serverUsers)
  .where(eq(serverUsers.id, sql.placeholder('id')))
  .limit(1)
  .prepare('server_user_by_id');

/**
 * Get user identity by ID
 * Used for: User identity info (the real person)
 * Called: When viewing user profile
 */
export const userById = db
  .select({
    id: users.id,
    name: users.name,
    thumbnail: users.thumbnail,
    email: users.email,
    role: users.role,
    aggregateTrustScore: users.aggregateTrustScore,
  })
  .from(users)
  .where(eq(users.id, sql.placeholder('id')))
  .limit(1)
  .prepare('user_by_id');

// ============================================================================
// Session Queries
// ============================================================================

/**
 * Get session by ID
 * Used for: Session detail page, violation context
 * Called: When viewing session details
 */
export const sessionById = db
  .select()
  .from(sessions)
  .where(eq(sessions.id, sql.placeholder('id')))
  .limit(1)
  .prepare('session_by_id');

// ============================================================================
// Stats Queries (hot-path for dashboard and analytics pages)
// ============================================================================

/**
 * Plays by platform since a given date
 * Used for: Stats platform breakdown chart
 * Called: Every stats page load
 */
export const playsByPlatformSince = db
  .select({
    platform: sessions.platform,
    count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .groupBy(sessions.platform)
  .orderBy(sql`count(DISTINCT COALESCE(reference_id, id)) DESC`)
  .prepare('plays_by_platform_since');

/**
 * Quality breakdown (direct vs transcode) since a given date
 * Used for: Stats quality chart
 * Called: Every stats page load
 */
export const qualityStatsSince = db
  .select({
    isTranscode: sessions.isTranscode,
    count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .groupBy(sessions.isTranscode)
  .prepare('quality_stats_since');

/**
 * Watch time by media type since a given date
 * Used for: Watch time breakdown by content type
 * Called: Stats page load
 */
export const watchTimeByTypeSince = db
  .select({
    mediaType: sessions.mediaType,
    totalMs: sql<number>`COALESCE(SUM(duration_ms), 0)::bigint`,
  })
  .from(sessions)
  .where(gte(sessions.startedAt, sql.placeholder('since')))
  .groupBy(sessions.mediaType)
  .prepare('watch_time_by_type_since');

// ============================================================================
// Rule Queries (hot-path for poller)
// ============================================================================

/**
 * Get all active rules
 * Used for: Rule evaluation during session polling
 * Called: Every poll cycle (~15 seconds per server)
 */
export const getActiveRules = db
  .select()
  .from(rules)
  .where(eq(rules.isActive, true))
  .prepare('get_active_rules');

/**
 * Get recent sessions for a user (for rule evaluation)
 * Used for: Evaluating device velocity, concurrent streams rules
 * Called: During rule evaluation for active sessions
 */
export const getUserRecentSessions = db
  .select({
    id: sessions.id,
    startedAt: sessions.startedAt,
    stoppedAt: sessions.stoppedAt,
    ipAddress: sessions.ipAddress,
    deviceId: sessions.deviceId,
    geoLat: sessions.geoLat,
    geoLon: sessions.geoLon,
    geoCity: sessions.geoCity,
    geoCountry: sessions.geoCountry,
    state: sessions.state,
  })
  .from(sessions)
  .where(
    and(
      eq(sessions.serverUserId, sql.placeholder('serverUserId')),
      gte(sessions.startedAt, sql.placeholder('since'))
    )
  )
  .orderBy(desc(sessions.startedAt))
  .limit(100)
  .prepare('get_user_recent_sessions');

// ============================================================================
// Violation Queries
// ============================================================================

/**
 * Get unacknowledged violations with pagination
 * Used for: Violation list in dashboard
 * Called: Frequently for alert displays
 */
export const getUnackedViolations = db
  .select()
  .from(violations)
  .where(isNull(violations.acknowledgedAt))
  .orderBy(desc(violations.createdAt))
  .limit(sql.placeholder('limit'))
  .prepare('get_unacked_violations');

// ============================================================================
// Server Queries
// ============================================================================

/**
 * Get server by ID
 * Used for: Server details, validation
 * Called: Frequently during API requests
 */
export const serverById = db
  .select()
  .from(servers)
  .where(eq(servers.id, sql.placeholder('id')))
  .limit(1)
  .prepare('server_by_id');

// ============================================================================
// Type exports for execute results
// ============================================================================

export type PlaysCountResult = Awaited<ReturnType<typeof playsCountSince.execute>>;
export type WatchTimeResult = Awaited<ReturnType<typeof watchTimeSince.execute>>;
export type ViolationsCountResult = Awaited<ReturnType<typeof violationsCountSince.execute>>;
export type ServerUserByExternalIdResult = Awaited<
  ReturnType<typeof serverUserByExternalId.execute>
>;
export type ServerUserByIdResult = Awaited<ReturnType<typeof serverUserById.execute>>;
export type UserByIdResult = Awaited<ReturnType<typeof userById.execute>>;
export type SessionByIdResult = Awaited<ReturnType<typeof sessionById.execute>>;
export type PlaysByPlatformResult = Awaited<ReturnType<typeof playsByPlatformSince.execute>>;
export type QualityStatsResult = Awaited<ReturnType<typeof qualityStatsSince.execute>>;
export type WatchTimeByTypeResult = Awaited<ReturnType<typeof watchTimeByTypeSince.execute>>;
export type ActiveRulesResult = Awaited<ReturnType<typeof getActiveRules.execute>>;
export type UserRecentSessionsResult = Awaited<ReturnType<typeof getUserRecentSessions.execute>>;
export type UnackedViolationsResult = Awaited<ReturnType<typeof getUnackedViolations.execute>>;
export type ServerByIdResult = Awaited<ReturnType<typeof serverById.execute>>;
