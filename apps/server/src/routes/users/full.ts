/**
 * User Full Detail Route (Aggregate Endpoint)
 *
 * GET /:id/full - Get complete user details with all related data in one request
 *
 * This endpoint combines:
 * - User details
 * - Session stats and recent sessions
 * - Locations
 * - Devices
 * - Violations
 * - Termination history
 *
 * Purpose: Reduce frontend from 6 API calls to 1, eliminating waterfall requests
 * and reducing TimescaleDB query planning overhead.
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { userIdParamSchema, identityScopeQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import {
  serverUsers,
  sessions,
  servers,
  users,
  automationRuns,
  automations,
  terminationLogs,
  userMergeAudits,
} from '../../db/schema.js';
import { runSession, violationAliasConditions } from '../../services/automations/aliasFilter.js';
import { hasServerAccess, buildServerAccessCondition } from '../../utils/serverFiltering.js';
import { serverOrderBy } from '../../utils/serverOrder.js';
import { PLAY_COUNT } from '../../db/sessions/rules.js';
import {
  queryTerminationHistory,
  queryUserDevices,
  queryUserLocations,
  serverUserIdAnyFragment,
  userHistoryWindow,
} from './queries.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import { localSessionSql } from '../../db/sessions/rules.js';

export const fullRoutes: FastifyPluginAsync = async (app) => {
  const readUsers = { preHandler: [app.requirePermission('users', 'read')] };
  /**
   * GET /:id/full - Get complete user details in one request
   *
   * Returns user info + stats + recent sessions + locations + devices + violations + terminations
   * All in a single database transaction for consistency.
   *
   * scope=identity expands sessions/locations/devices/violations/terminations
   * to every account under the same person that the caller can access. The
   * `identity` block (roster, aggregate trust, combined stats) is always
   * identity-wide regardless of scope.
   */
  app.get('/:id/full', readUsers, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = identityScopeQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const { scope } = query.data;
    const authUser = request.user;

    // Limits for embedded data (not paginated, just initial load)
    const sessionsLimit = 10;
    const violationsLimit = 10;
    const terminationsLimit = 10;

    // Use a transaction for consistent reads
    const result = await db.transaction(async (tx) => {
      // 1. Get user details with server info
      const serverUserRows = await tx
        .select({
          id: serverUsers.id,
          serverId: serverUsers.serverId,
          serverName: servers.name,
          userId: serverUsers.userId,
          externalId: serverUsers.externalId,
          username: serverUsers.username,
          email: serverUsers.email,
          thumbUrl: serverUsers.thumbUrl,
          isServerAdmin: serverUsers.isServerAdmin,
          trustScore: serverUsers.trustScore,
          joinedAt: serverUsers.joinedAt,
          lastActivityAt: serverUsers.lastActivityAt,
          removedAt: serverUsers.removedAt,
          createdAt: serverUsers.createdAt,
          updatedAt: serverUsers.updatedAt,
          identityName: users.name,
          identityContactEmail: users.contactEmail,
          role: users.role,
          loginAccess: users.loginAccess,
          lastLoginAt: users.lastLoginAt,
          loginCount: users.loginCount,
          identityAggregateTrustScore: users.aggregateTrustScore,
          identityTotalViolations: users.totalViolations,
        })
        .from(serverUsers)
        .innerJoin(servers, eq(serverUsers.serverId, servers.id))
        .innerJoin(users, eq(serverUsers.userId, users.id))
        .where(eq(serverUsers.id, id))
        .limit(1);

      const serverUser = serverUserRows[0];
      if (!serverUser) {
        return { error: 'notFound' as const };
      }

      // Verify access
      if (!hasServerAccess(authUser, serverUser.serverId)) {
        return { error: 'forbidden' as const };
      }

      // Identity-wide aggregation: every server_user tied to this person's
      // identity that the caller can see, plus combined session stats over
      // that same filtered set. Owners see every sibling; everyone else is
      // scoped to their accessible servers so this can't leak sibling
      // accounts on servers they have no access to.
      const identityServerAccessCondition = buildServerAccessCondition(
        authUser,
        serverUsers.serverId
      );
      const identityWhere = identityServerAccessCondition
        ? and(eq(serverUsers.userId, serverUser.userId), identityServerAccessCondition)
        : eq(serverUsers.userId, serverUser.userId);

      const identityServerUserRows = await tx
        .select({
          id: serverUsers.id,
          serverId: serverUsers.serverId,
          serverName: servers.name,
          serverType: servers.type,
          username: serverUsers.username,
          thumbUrl: serverUsers.thumbUrl,
          trustScore: serverUsers.trustScore,
          removedAt: serverUsers.removedAt,
          mergedIn: sql<boolean>`exists (
            select 1 from ${userMergeAudits}
            where ${userMergeAudits.targetUserId} = ${serverUsers.userId}
              and ${userMergeAudits.undoneAt} is null
              and ${userMergeAudits.movedServerUserIds} @> jsonb_build_array(${serverUsers.id}::text)
          )`,
        })
        .from(serverUsers)
        .innerJoin(servers, eq(serverUsers.serverId, servers.id))
        .where(identityWhere)
        .orderBy(...serverOrderBy(), serverUsers.id);

      const identityIds = identityServerUserRows.map((su) => su.id);

      const { start: tenYearsAgo, end: nowDate } = userHistoryWindow();

      // One grouped read instead of a correlated count per row, so sessions is
      // planned once rather than once per account.
      const sessionCounts = new Map<string, number>();
      if (identityIds.length > 0) {
        const countRows = await tx
          .select({ serverUserId: sessions.serverUserId, count: sql<number>`count(*)::int` })
          .from(sessions)
          .where(
            sql`${sessions.serverUserId} = ANY(${uuidArraySql(identityIds)})
            AND ${sessions.startedAt} >= ${tenYearsAgo}
            AND ${sessions.startedAt} <= ${nowDate}`
          )
          .groupBy(sessions.serverUserId);
        for (const row of countRows) sessionCounts.set(row.serverUserId, row.count);
      }
      const sessionCountOf = (serverUserId: string) => sessionCounts.get(serverUserId) ?? 0;

      // scope=identity fans every scoped panel query out across the whole
      // accessible identity; otherwise they stay anchored on just this account.
      // identityIds always contains at least `id` itself (the anchor already
      // passed the access check above), so this can't come back empty.
      const scopedIds = scope === 'identity' ? identityIds : [id];

      let identityStats: { totalSessions: number; totalWatchTime: number } | undefined;
      if (identityIds.length > 0) {
        const identityIdArray = uuidArraySql(identityIds);
        const identityStatsRows = await tx
          .select({
            totalSessions: PLAY_COUNT,
            totalWatchTime: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
          })
          .from(sessions).where(sql`${sessions.serverUserId} = ANY(${identityIdArray})
            AND ${sessions.startedAt} >= ${tenYearsAgo}
            AND ${sessions.startedAt} <= ${nowDate}`);
        identityStats = identityStatsRows[0];
      }

      // 2. Get session stats — count unique plays, not raw rows
      const scopedIdArray = uuidArraySql(scopedIds);
      const statsResult = await tx
        .select({
          totalSessions: PLAY_COUNT,
          totalWatchTime: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
        })
        .from(sessions).where(sql`${sessions.serverUserId} = ANY(${scopedIdArray})
          AND ${sessions.startedAt} >= ${tenYearsAgo}
          AND ${sessions.startedAt} <= ${nowDate}`);

      const stats = statsResult[0];

      // 3. Get recent sessions grouped by play (collapse pause/resume chains)
      const recentSessionsResult = await tx.execute(sql`
        WITH grouped_sessions AS (
          SELECT
            COALESCE(s.reference_id, s.id) AS play_id,
            MIN(s.started_at) AS started_at,
            MAX(s.stopped_at) AS stopped_at,
            SUM(COALESCE(s.duration_ms, 0)) AS duration_ms,
            SUM(COALESCE(s.paused_duration_ms, 0)) AS paused_duration_ms,
            MAX(s.progress_ms) AS progress_ms,
            MAX(s.total_duration_ms) AS total_duration_ms,
            COUNT(*) AS segment_count,
            BOOL_OR(s.watched) AS watched,
            (array_agg(s.id ORDER BY s.started_at))[1] AS first_session_id,
            (array_agg(s.state ORDER BY s.started_at DESC))[1] AS state
          FROM sessions s
          WHERE ${serverUserIdAnyFragment(scopedIds, 's.server_user_id')}
            AND s.started_at >= ${tenYearsAgo}
            AND s.started_at <= ${nowDate}
          GROUP BY COALESCE(s.reference_id, s.id)
          ORDER BY MIN(s.started_at) DESC
          LIMIT ${sessionsLimit}
        )
        SELECT
          gs.play_id AS id,
          gs.started_at, gs.stopped_at, gs.duration_ms, gs.paused_duration_ms,
          gs.progress_ms, gs.total_duration_ms, gs.segment_count, gs.watched, gs.state,
          s.server_id, sv.name AS server_name, s.server_user_id, s.session_key,
          s.media_type, s.media_title, s.grandparent_title, s.season_number,
          s.episode_number, s.year, s.thumb_path, s.media_id, s.show_media_id,
          s.rating_key, s.external_session_id,
          s.reference_id, s.ip_address, s.geo_city, s.geo_region, s.geo_country,
          s.geo_continent, s.geo_postal, s.geo_lat, s.geo_lon,
          s.geo_asn_number, s.geo_asn_organization,
          ${localSessionSql('s')} AS is_local,
          s.player_name, s.device_id, s.product, s.device, s.platform,
          s.quality, s.is_transcode, s.bitrate, s.last_paused_at
        FROM grouped_sessions gs
        -- gs.started_at is not a planner-time constant: the literal bounds exclude chunks at
        -- plan time, the InitPlan bounds narrow the rest at runtime
        JOIN sessions s ON s.id = gs.first_session_id AND s.started_at = gs.started_at
          AND s.started_at >= ${tenYearsAgo} AND s.started_at <= ${nowDate}
          AND s.started_at >= (SELECT MIN(started_at) FROM grouped_sessions)
          AND s.started_at <= (SELECT MAX(started_at) FROM grouped_sessions)
        JOIN servers sv ON sv.id = s.server_id
        ORDER BY gs.started_at DESC
      `);

      const recentSessions = recentSessionsResult.rows.map((row) => ({
        id: row.id as string,
        serverId: row.server_id as string,
        serverName: row.server_name as string,
        serverUserId: row.server_user_id as string,
        sessionKey: row.session_key as string,
        state: row.state as string,
        mediaType: row.media_type as string,
        mediaTitle: row.media_title as string,
        grandparentTitle: row.grandparent_title as string | null,
        seasonNumber: row.season_number as number | null,
        episodeNumber: row.episode_number as number | null,
        year: row.year as number | null,
        thumbPath: row.thumb_path as string | null,
        mediaId: row.media_id as string | null,
        showMediaId: row.show_media_id as string | null,
        ratingKey: row.rating_key as string | null,
        externalSessionId: row.external_session_id as string | null,
        startedAt: row.started_at as Date,
        stoppedAt: row.stopped_at as Date | null,
        durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
        totalDurationMs: row.total_duration_ms as number | null,
        progressMs: row.progress_ms as number | null,
        lastPausedAt: row.last_paused_at as Date | null,
        pausedDurationMs: row.paused_duration_ms != null ? Number(row.paused_duration_ms) : null,
        referenceId: row.reference_id as string | null,
        watched: row.watched as boolean,
        segmentCount: Number(row.segment_count),
        ipAddress: row.ip_address as string | null,
        geoCity: row.geo_city as string | null,
        geoRegion: row.geo_region as string | null,
        geoCountry: row.geo_country as string | null,
        geoContinent: row.geo_continent as string | null,
        geoPostal: row.geo_postal as string | null,
        geoLat: row.geo_lat as number | null,
        geoLon: row.geo_lon as number | null,
        geoAsnNumber: row.geo_asn_number as number | null,
        geoAsnOrganization: row.geo_asn_organization as string | null,
        isLocal: row.is_local === true,
        playerName: row.player_name as string | null,
        deviceId: row.device_id as string | null,
        product: row.product as string | null,
        device: row.device as string | null,
        platform: row.platform as string | null,
        quality: row.quality as string | null,
        isTranscode: row.is_transcode as boolean | null,
        bitrate: row.bitrate as number | null,
      }));

      // 4. Get locations
      const locations = await queryUserLocations(tx, scopedIds, {
        start: tenYearsAgo,
        end: nowDate,
      });

      // 5. Get devices (shared query handles dedup and aggregation)
      const devices = await queryUserDevices(tx, scopedIds, {
        start: tenYearsAgo,
        end: nowDate,
      });

      // 6. Get violations (recent, limited)
      const runSessionRow = runSession();
      const violationData = await tx
        .select({
          id: automationRuns.id,
          ruleId: automationRuns.automationId,
          ruleName: automations.name,
          // The v1 column is gone; the key stays on the wire, always null.
          ruleType: sql<null>`NULL`,
          serverUserId: automationRuns.serverUserId,
          serverId: serverUsers.serverId,
          serverName: servers.name,
          sessionId: automationRuns.sessionId,
          mediaTitle: runSessionRow.mediaTitle,
          severity: automationRuns.severity,
          data: automationRuns.data,
          createdAt: automationRuns.createdAt,
          acknowledgedAt: automationRuns.acknowledgedAt,
        })
        .from(automationRuns)
        .innerJoin(automations, eq(automationRuns.automationId, automations.id))
        .innerJoin(serverUsers, eq(automationRuns.serverUserId, serverUsers.id))
        .innerJoin(servers, eq(serverUsers.serverId, servers.id))
        .leftJoinLateral(runSessionRow, sql`true`)
        .where(
          and(
            sql`${automationRuns.serverUserId} = ANY(${scopedIdArray})`,
            isNull(automationRuns.dismissedAt),
            ...violationAliasConditions()
          )
        )
        .orderBy(desc(automationRuns.createdAt))
        .limit(violationsLimit);

      // Get violations count
      const violationsCountResult = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(automationRuns)
        .where(
          and(
            sql`${automationRuns.serverUserId} = ANY(${scopedIdArray})`,
            isNull(automationRuns.dismissedAt),
            ...violationAliasConditions()
          )
        );

      const violationsTotal = violationsCountResult[0]?.count ?? 0;

      // 7. Get termination history (recent, limited)
      const terminationData = await queryTerminationHistory(
        tx,
        sql`${terminationLogs.serverUserId} = ANY(${scopedIdArray})`,
        { limit: terminationsLimit }
      );

      // Get terminations count
      const terminationsCountResult = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(terminationLogs)
        .where(sql`${terminationLogs.serverUserId} = ANY(${scopedIdArray})`);

      const terminationsTotal = terminationsCountResult[0]?.count ?? 0;

      const {
        identityAggregateTrustScore,
        identityTotalViolations,
        identityContactEmail,
        ...serverUserFields
      } = serverUser;

      return {
        user: {
          ...serverUserFields,
          sessionCount: sessionCountOf(serverUser.id),
          stats: {
            totalSessions: stats?.totalSessions ?? 0,
            totalWatchTime: Number(stats?.totalWatchTime ?? 0),
          },
        },
        identity: {
          userId: serverUser.userId,
          aggregateTrustScore: identityAggregateTrustScore,
          totalViolations: identityTotalViolations,
          contactEmail: identityContactEmail,
          serverUsers: identityServerUserRows.map((su) => ({
            ...su,
            sessionCount: sessionCountOf(su.id),
          })),
          stats: {
            totalSessions: identityStats?.totalSessions ?? 0,
            totalWatchTime: Number(identityStats?.totalWatchTime ?? 0),
          },
        },
        sessions: {
          data: recentSessions,
          total: stats?.totalSessions ?? 0,
          hasMore: (stats?.totalSessions ?? 0) > sessionsLimit,
        },
        locations,
        devices,
        violations: {
          data: violationData.map((v) => ({
            id: v.id,
            ruleId: v.ruleId,
            rule: {
              name: v.ruleName,
              type: v.ruleType,
            },
            serverUserId: v.serverUserId,
            serverId: v.serverId,
            serverName: v.serverName,
            sessionId: v.sessionId,
            mediaTitle: v.mediaTitle,
            severity: v.severity,
            data: v.data,
            createdAt: v.createdAt,
            acknowledgedAt: v.acknowledgedAt,
          })),
          total: violationsTotal,
          hasMore: violationsTotal > violationsLimit,
        },
        terminations: {
          data: terminationData,
          total: terminationsTotal,
          hasMore: terminationsTotal > terminationsLimit,
        },
      };
    });

    // Handle errors from transaction
    if ('error' in result) {
      if (result.error === 'notFound') {
        return reply.notFound('User not found');
      }
      if (result.error === 'forbidden') {
        return reply.forbidden('You do not have access to this user');
      }
    }

    return result;
  });
};
