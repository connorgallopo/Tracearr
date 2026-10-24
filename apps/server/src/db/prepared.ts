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

import { eq, gte, and, isNull, sql, inArray } from 'drizzle-orm';
import { db } from './client.js';
import { sessions, automationRuns, serverUsers } from './schema.js';
import { PLAYS_MEDIA_TYPES, PRIMARY_MEDIA_TYPES, WATCH_AND_LISTEN_MS } from '../constants/index.js';
import { violationAliasConditions } from '../services/automations/aliasFilter.js';
import { playbackDecisionSql } from '../utils/playbackDecisionSql.js';

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
     * Used for: Dashboard "Today's Sessions" metric
     * Called: Every dashboard page load
     * Note: Excludes live TV
     */
    playsCountSince: db
      .select({
        count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
      })
      .from(sessions)
      .where(
        and(
          gte(sessions.startedAt, sql.placeholder('since')),
          inArray(sessions.mediaType, PLAYS_MEDIA_TYPES)
        )
      )
      .prepare('plays_count_since'),

    /**
     * Sum watch time (movies and episodes) and listen time (music tracks) since a given date
     * Used for: Dashboard "Watch Time" and "Listen Time" metrics
     * Called: Every dashboard page load
     * Note: Excludes live TV
     */
    watchTimeSince: db
      .select(WATCH_AND_LISTEN_MS)
      .from(sessions)
      .where(
        and(
          gte(sessions.startedAt, sql.placeholder('since')),
          inArray(sessions.mediaType, PLAYS_MEDIA_TYPES)
        )
      )
      .prepare('watch_time_since'),

    /**
     * Count violations since a given date
     * Used for: Dashboard "Alerts" metric
     * Called: Every dashboard page load
     * Note: requireUser matches the server-filtered branch of dashboardStats,
     * which reaches the same rows through an inner join on server_users.
     */
    violationsCountSince: db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(automationRuns)
      .where(
        and(
          gte(automationRuns.createdAt, sql.placeholder('since')),
          isNull(automationRuns.dismissedAt),
          ...violationAliasConditions({ requireUser: true })
        )
      )
      .prepare('violations_count_since'),

    /**
     * Count unique active identities (people, not accounts) since a given date
     * Used for: Dashboard "Active Users Today" metric
     * Called: Every dashboard page load
     * Note: Excludes live TV. A merged person with accounts on multiple
     * servers counts once.
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
          inArray(sessions.mediaType, PLAYS_MEDIA_TYPES)
        )
      )
      .prepare('unique_users_since'),

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
        tier: sql<string>`${playbackDecisionSql()}`.as('tier'),
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
export let playsByPlatformSince: Statements['playsByPlatformSince'];
export let qualityStatsSince: Statements['qualityStatsSince'];

/** Create (or recreate) all prepared statements against the current db instance */
export function initPreparedStatements(): void {
  const s = createStatements();
  playsCountSince = s.playsCountSince;
  watchTimeSince = s.watchTimeSince;
  violationsCountSince = s.violationsCountSince;
  uniqueUsersSince = s.uniqueUsersSince;
  playsByPlatformSince = s.playsByPlatformSince;
  qualityStatsSince = s.qualityStatsSince;
}

// ============================================================================
// Type exports for execute results
// ============================================================================

export type PlaysCountResult = Awaited<ReturnType<typeof playsCountSince.execute>>;
export type WatchTimeResult = Awaited<ReturnType<typeof watchTimeSince.execute>>;
export type ViolationsCountResult = Awaited<ReturnType<typeof violationsCountSince.execute>>;
export type PlaysByPlatformResult = Awaited<ReturnType<typeof playsByPlatformSince.execute>>;
export type QualityStatsResult = Awaited<ReturnType<typeof qualityStatsSince.execute>>;
