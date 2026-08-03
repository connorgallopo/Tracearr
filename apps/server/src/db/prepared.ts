/**
 * Prepared statements for hot-path queries
 *
 * Prepared statements optimize performance by allowing PostgreSQL to reuse
 * query plans across executions. These are particularly valuable for:
 * - Queries called on every page load (dashboard)
 * - Queries called frequently during polling
 * - Queries with predictable parameter patterns
 *
 * All statement definitions live in createStatements() — the single source of truth.
 * initPreparedStatements() recreates them after a pool recreation (e.g. TimescaleDB
 * extension upgrade). ESM live bindings ensure importers see updated references.
 *
 * @see https://orm.drizzle.team/docs/perf-queries
 */

import { eq, gte, and, isNull, desc, sql, inArray } from 'drizzle-orm';
import { db } from './client.js';
import { sessions, violations, users, serverUsers, servers, rules } from './schema.js';
import { PRIMARY_MEDIA_TYPES } from '../constants/index.js';

/**
 * Single source of truth for all prepared statement definitions.
 */
function createStatements() {
  return {
    // ========================================================================
    // Dashboard Stats Queries
    // ========================================================================

    /**
     * Count unique plays (grouped by reference_id) since a given date
     * Used for: Dashboard "Today's Plays" metric
     * Called: Every dashboard page load
     * Note: Excludes live TV and music tracks
     */
    playsCountSince: db
      .select({
        count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
      })
      .from(sessions)
      .where(
        and(
          gte(sessions.startedAt, sql.placeholder('since')),
          inArray(sessions.mediaType, PRIMARY_MEDIA_TYPES)
        )
      )
      .prepare('plays_count_since'),

    /**
     * Sum total watch time since a given date
     * Used for: Dashboard "Watch Time" metric
     * Called: Every dashboard page load
     * Note: Excludes live TV and music tracks
     */
    watchTimeSince: db
      .select({
        totalMs: sql<number>`COALESCE(SUM(duration_ms), 0)::bigint`,
      })
      .from(sessions)
      .where(
        and(
          gte(sessions.startedAt, sql.placeholder('since')),
          inArray(sessions.mediaType, PRIMARY_MEDIA_TYPES)
        )
      )
      .prepare('watch_time_since'),

    /**
     * Count violations since a given date
     * Used for: Dashboard "Alerts" metric
     * Called: Every dashboard page load
     */
    violationsCountSince: db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(violations)
      .where(gte(violations.createdAt, sql.placeholder('since')))
      .prepare('violations_count_since'),

    /**
     * Count unique active identities (people, not accounts) since a given date
     * Used for: Dashboard "Active Users Today" metric
     * Called: Every dashboard page load
     * Note: Excludes live TV and music tracks. A merged person with accounts
     * on multiple servers counts once.
     */
    uniqueUsersSince: db
      .select({
        count: sql<number>`count(DISTINCT ${serverUsers.userId})::int`,
      })
      .from(sessions)
      .innerJoin(serverUsers, eq(sessions.serverUserId, serverUsers.id))
      .where(
        and(
          gte(sessions.startedAt, sql.placeholder('since')),
          inArray(sessions.mediaType, PRIMARY_MEDIA_TYPES)
        )
      )
      .prepare('unique_users_since'),

    /**
     * Count unacknowledged violations
     * Used for: Alert badge in navigation
     * Called: On app load and after acknowledgment
     */
    unacknowledgedViolationsCount: db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(violations)
      .where(isNull(violations.acknowledgedAt))
      .prepare('unacknowledged_violations_count'),

    // ========================================================================
    // Polling Queries
    // ========================================================================

    /**
     * Find server user by server ID and external ID
     * Used for: Server user lookup during session polling
     * Called: Every poll cycle for each active session (potentially 10+ times per 15 seconds)
     */
    serverUserByExternalId: db
      .select()
      .from(serverUsers)
      .where(
        and(
          eq(serverUsers.serverId, sql.placeholder('serverId')),
          eq(serverUsers.externalId, sql.placeholder('externalId'))
        )
      )
      .limit(1)
      .prepare('server_user_by_external_id'),

    /**
     * Find session by server ID and session key
     * Used for: Session lookup during polling to check for existing sessions
     * Called: Every poll cycle for each active session
     */
    sessionByServerAndKey: db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverId, sql.placeholder('serverId')),
          eq(sessions.sessionKey, sql.placeholder('sessionKey'))
        )
      )
      .limit(1)
      .prepare('session_by_server_and_key'),

    // ========================================================================
    // User Queries
    // ========================================================================

    /**
     * Get server user by ID with basic info
     * Used for: Server user details in violations, sessions
     * Called: Frequently for UI enrichment
     */
    serverUserById: db
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
      .prepare('server_user_by_id'),

    /**
     * Get user identity by ID
     * Used for: User identity info (the real person)
     * Called: When viewing user profile
     */
    userById: db
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
      .prepare('user_by_id'),

    // ========================================================================
    // Session Queries
    // ========================================================================

    /**
     * Get session by ID
     * Used for: Session detail page, violation context
     * Called: When viewing session details
     */
    sessionById: db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sql.placeholder('id')))
      .limit(1)
      .prepare('session_by_id'),

    // ========================================================================
    // Stats Queries (hot-path for dashboard and analytics pages)
    // ========================================================================

    /**
     * Plays by platform since a given date
     * Used for: Stats platform breakdown chart
     * Called: Every stats page load
     * Note: Excludes live TV and music tracks
     */
    playsByPlatformSince: db
      .select({
        platform: sessions.platform,
        count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
        watchTimeHours: sql<number>`round(COALESCE(sum(duration_ms), 0) / 3600000.0, 1)::float`,
      })
      .from(sessions)
      .where(
        and(
          gte(sessions.startedAt, sql.placeholder('since')),
          inArray(sessions.mediaType, PRIMARY_MEDIA_TYPES)
        )
      )
      .groupBy(sessions.platform)
      .orderBy(sql`count(DISTINCT COALESCE(reference_id, id)) DESC`)
      .prepare('plays_by_platform_since'),

    /**
     * Quality breakdown (direct vs transcode) since a given date
     * Used for: Stats quality chart
     * Called: Every stats page load
     * Note: Excludes live TV and music tracks
     */
    qualityStatsSince: db
      .select({
        tier: sql<string>`CASE
          WHEN is_transcode = true THEN 'transcode'
          WHEN video_decision = 'copy' OR audio_decision = 'copy' THEN 'copy'
          ELSE 'directplay'
        END`.as('tier'),
        count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
      })
      .from(sessions)
      .where(
        and(
          gte(sessions.startedAt, sql.placeholder('since')),
          inArray(sessions.mediaType, PRIMARY_MEDIA_TYPES)
        )
      )
      .groupBy(sql`tier`)
      .prepare('quality_stats_since'),

    /**
     * Watch time by media type since a given date
     * Used for: Watch time breakdown by content type
     * Called: Stats page load
     */
    watchTimeByTypeSince: db
      .select({
        mediaType: sessions.mediaType,
        totalMs: sql<number>`COALESCE(SUM(duration_ms), 0)::bigint`,
      })
      .from(sessions)
      .where(gte(sessions.startedAt, sql.placeholder('since')))
      .groupBy(sessions.mediaType)
      .prepare('watch_time_by_type_since'),

    // ========================================================================
    // Rule Queries (hot-path for poller)
    // ========================================================================

    /**
     * Get all active rules
     * Used for: Rule evaluation during session polling
     * Called: Every poll cycle (~15 seconds per server)
     */
    getActiveRules: db
      .select()
      .from(rules)
      .where(eq(rules.isActive, true))
      .prepare('get_active_rules'),

    /**
     * Get recent sessions for a user (for rule evaluation)
     * Used for: Evaluating device velocity, concurrent streams rules
     * Called: During rule evaluation for active sessions
     */
    getUserRecentSessions: db
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
      .prepare('get_user_recent_sessions'),

    // ========================================================================
    // Violation Queries
    // ========================================================================

    /**
     * Get unacknowledged violations with pagination
     * Used for: Violation list in dashboard
     * Called: Frequently for alert displays
     */
    getUnackedViolations: db
      .select()
      .from(violations)
      .where(isNull(violations.acknowledgedAt))
      .orderBy(desc(violations.createdAt))
      .limit(sql.placeholder('limit'))
      .prepare('get_unacked_violations'),

    // ========================================================================
    // Server Queries
    // ========================================================================

    /**
     * Get server by ID
     * Used for: Server details, validation
     * Called: Frequently during API requests
     */
    serverById: db
      .select()
      .from(servers)
      .where(eq(servers.id, sql.placeholder('id')))
      .limit(1)
      .prepare('server_by_id'),
  };
}

type Statements = ReturnType<typeof createStatements>;

// Named exports — populated by initPreparedStatements() during server startup
// and reassigned after pool recreation (e.g. TimescaleDB extension upgrade).
// NOT eagerly initialised so the module can be imported without a live db.
export let playsCountSince: Statements['playsCountSince'];
export let watchTimeSince: Statements['watchTimeSince'];
export let violationsCountSince: Statements['violationsCountSince'];
export let uniqueUsersSince: Statements['uniqueUsersSince'];
export let unacknowledgedViolationsCount: Statements['unacknowledgedViolationsCount'];
export let serverUserByExternalId: Statements['serverUserByExternalId'];
export let sessionByServerAndKey: Statements['sessionByServerAndKey'];
export let serverUserById: Statements['serverUserById'];
export let userById: Statements['userById'];
export let sessionById: Statements['sessionById'];
export let playsByPlatformSince: Statements['playsByPlatformSince'];
export let qualityStatsSince: Statements['qualityStatsSince'];
export let watchTimeByTypeSince: Statements['watchTimeByTypeSince'];
export let getActiveRules: Statements['getActiveRules'];
export let getUserRecentSessions: Statements['getUserRecentSessions'];
export let getUnackedViolations: Statements['getUnackedViolations'];
export let serverById: Statements['serverById'];

/** Create (or recreate) all prepared statements against the current db instance */
export function initPreparedStatements(): void {
  const s = createStatements();
  playsCountSince = s.playsCountSince;
  watchTimeSince = s.watchTimeSince;
  violationsCountSince = s.violationsCountSince;
  uniqueUsersSince = s.uniqueUsersSince;
  unacknowledgedViolationsCount = s.unacknowledgedViolationsCount;
  serverUserByExternalId = s.serverUserByExternalId;
  sessionByServerAndKey = s.sessionByServerAndKey;
  serverUserById = s.serverUserById;
  userById = s.userById;
  sessionById = s.sessionById;
  playsByPlatformSince = s.playsByPlatformSince;
  qualityStatsSince = s.qualityStatsSince;
  watchTimeByTypeSince = s.watchTimeByTypeSince;
  getActiveRules = s.getActiveRules;
  getUserRecentSessions = s.getUserRecentSessions;
  getUnackedViolations = s.getUnackedViolations;
  serverById = s.serverById;
}

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
