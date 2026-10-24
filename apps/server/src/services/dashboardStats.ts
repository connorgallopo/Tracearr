/**
 * Dashboard Statistics Service
 *
 * Computes dashboard metrics (plays, watch time, alerts, active users).
 * Used by both internal dashboard route and public API stats/today endpoint.
 */

import { sql, gte, and, inArray, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { REDIS_KEYS, TIME_MS, type DashboardStats } from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, serverUsers } from '../db/schema.js';
import {
  playsCountSince,
  watchTimeSince,
  violationsCountSince,
  uniqueUsersSince,
} from '../db/prepared.js';
import { buildMultiServerCondition } from '../utils/serverFiltering.js';
import { VIOLATION_ALIAS_SQL } from './automations/aliasFilter.js';
import { getCacheService } from './cache.js';
import { getStartOfDayInTimezone, getStartOfNextDayInTimezone } from '../routes/stats/utils.js';
import {
  memberCacheSegment,
  scopeSessions,
  scopedServerFragment,
  seesServerActivity,
  type Scope,
} from '../lib/scope.js';
import {
  PLAYS_MEDIA_TYPES,
  PLAYS_MEDIA_TYPE_SQL_FILTER,
  WATCH_AND_LISTEN_MS,
} from '../constants/index.js';
import { countedSessionSql } from '../db/sessions/rules.js';

export interface GetDashboardStatsOptions {
  /** Server IDs to filter by. undefined = all servers */
  serverIds?: string[];
  /** Row scope; a member gets their own counts and othersActive in place of activeUsersToday */
  scope: Scope;
  /** IANA timezone for "today" calculation */
  timezone: string;
  /** Redis client for caching (optional) */
  redis?: Redis;
}

const CACHE_TTL_SECONDS = 60;

/** Milliseconds as hours to one decimal place */
function toHours(ms: number | string | undefined): number {
  return Math.round((Number(ms ?? 0) / TIME_MS.HOUR) * 10) / 10;
}

/**
 * Get dashboard statistics with optional caching.
 */
export async function getDashboardStats(
  options: GetDashboardStatsOptions
): Promise<DashboardStats> {
  const { serverIds, scope, timezone, redis } = options;
  const showOthers = await seesServerActivity(scope);
  const withActivity = (stats: DashboardStats): DashboardStats => {
    if (showOthers) return stats;
    const hidden = { ...stats };
    delete hidden.othersActive;
    return hidden;
  };

  // Build cache key
  const serverSegment = serverIds === undefined ? 'all' : serverIds.sort().join(',');
  const cacheKey = `${REDIS_KEYS.DASHBOARD_STATS}:${serverSegment}${memberCacheSegment(scope)}:${timezone}`;

  // Try cache first
  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return withActivity(JSON.parse(cached) as DashboardStats);
      } catch {
        // Fall through to compute
      }
    }
  }

  // Compute stats
  const stats = await computeDashboardStats(serverIds, scope, timezone);

  // Cache result
  if (redis) {
    await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(stats));
  }

  return withActivity(stats);
}

async function computeDashboardStats(
  serverIds: string[] | undefined,
  scope: Scope,
  timezone: string
): Promise<DashboardStats> {
  // Get active streams
  let activeStreams = 0;
  let othersActive = 0;
  const cacheService = getCacheService();
  if (cacheService) {
    try {
      let activeSessions = await cacheService.getAllActiveSessions();
      if (serverIds !== undefined) {
        const idSet = new Set(serverIds);
        activeSessions = activeSessions.filter((s) => idSet.has(s.serverId));
      }
      activeStreams = activeSessions.length;
      if (scope !== 'all') {
        const own = new Set(scope.serverUserIds);
        activeStreams = activeSessions.filter((s) => own.has(s.serverUserId)).length;
        othersActive = activeSessions.length - activeStreams;
      }
    } catch {
      // Ignore cache errors
    }
  }

  const todayStart = getStartOfDayInTimezone(timezone);
  const todayEnd = getStartOfNextDayInTimezone(timezone, todayStart);
  const last24h = new Date(Date.now() - TIME_MS.DAY);

  let todayPlays: number;
  let todaySessions: number;
  let watchTimeHours: number;
  let listenTimeHours: number;
  let alertsLast24h: number;
  let activeUsersToday: number;

  if (serverIds === undefined && scope === 'all') {
    // No server filter - use prepared statements for performance
    const [
      todayPlaysResult,
      watchTimeResult,
      alertsResult,
      activeUsersResult,
      validatedPlaysResult,
    ] = await Promise.all([
      playsCountSince.execute({ since: todayStart }),
      watchTimeSince.execute({ since: todayStart }),
      violationsCountSince.execute({ since: last24h }),
      uniqueUsersSince.execute({ since: todayStart }),
      db.execute(sql`
        SELECT COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        WHERE started_at >= ${todayStart} AND started_at < ${todayEnd}
          AND ${countedSessionSql()}
          ${PLAYS_MEDIA_TYPE_SQL_FILTER}
      `),
    ]);

    todaySessions = todayPlaysResult[0]?.count ?? 0;
    todayPlays = (validatedPlaysResult.rows[0] as { count: number })?.count ?? 0;
    watchTimeHours = toHours(watchTimeResult[0]?.totalMs);
    listenTimeHours = toHours(watchTimeResult[0]?.listenMs);
    alertsLast24h = alertsResult[0]?.count ?? 0;
    activeUsersToday = activeUsersResult[0]?.count ?? 0;
  } else {
    // Server filter - use dynamic queries
    const buildSessionConditions = (since: Date) => {
      const conditions = [
        gte(sessions.startedAt, since),
        inArray(sessions.mediaType, PLAYS_MEDIA_TYPES),
      ];

      const serverCondition = buildMultiServerCondition(serverIds, sessions.serverId);
      if (serverCondition) {
        conditions.push(serverCondition);
      }
      const scopeCondition = scopeSessions(scope);
      if (scopeCondition) {
        conditions.push(scopeCondition);
      }

      return conditions;
    };

    const violationServerFilter = scopedServerFragment(
      serverIds,
      scope,
      'su.server_id',
      sql`v.server_user_id`
    );
    const sessionServerFilter = scopedServerFragment(serverIds, scope);

    const [
      todaySessionsResult,
      watchTimeResult,
      alertsResult,
      activeUsersResult,
      validatedPlaysResult,
    ] = await Promise.all([
      db
        .select({
          count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
        })
        .from(sessions)
        .where(and(...buildSessionConditions(todayStart))),

      db
        .select(WATCH_AND_LISTEN_MS)
        .from(sessions)
        .where(and(...buildSessionConditions(todayStart))),

      db
        .execute(
          sql`
          SELECT count(*)::int as count
          FROM automation_runs v
          INNER JOIN server_users su ON su.id = v.server_user_id
          WHERE v.created_at >= ${last24h}
          AND v.dismissed_at IS NULL
          AND ${VIOLATION_ALIAS_SQL}
          ${violationServerFilter}
        `
        )
        .then((r) => [{ count: (r.rows[0] as { count: number })?.count ?? 0 }]),

      // Distinct identities (people), not accounts - a merged person with
      // accounts on multiple selected servers counts once.
      db
        .select({
          count: sql<number>`count(DISTINCT ${serverUsers.userId})::int`,
        })
        .from(sessions)
        .innerJoin(serverUsers, eq(sessions.serverUserId, serverUsers.id))
        .where(and(...buildSessionConditions(todayStart))),

      db.execute(sql`
        SELECT COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        WHERE started_at >= ${todayStart} AND started_at < ${todayEnd}
          AND ${countedSessionSql()}
          ${PLAYS_MEDIA_TYPE_SQL_FILTER}
        ${sessionServerFilter}
      `),
    ]);

    todaySessions = todaySessionsResult[0]?.count ?? 0;
    todayPlays = (validatedPlaysResult.rows[0] as { count: number })?.count ?? 0;
    watchTimeHours = toHours(watchTimeResult[0]?.totalMs);
    listenTimeHours = toHours(watchTimeResult[0]?.listenMs);
    alertsLast24h = alertsResult[0]?.count ?? 0;
    activeUsersToday = activeUsersResult[0]?.count ?? 0;
  }

  const base = { activeStreams, todayPlays, todaySessions, watchTimeHours, listenTimeHours };
  return scope === 'all' ? { ...base, alertsLast24h, activeUsersToday } : { ...base, othersActive };
}
