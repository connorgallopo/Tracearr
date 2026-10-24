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
  servers,
  users,
  automationRuns,
  automations,
  terminationLogs,
  userMergeAudits,
} from '../../db/schema.js';
import { runSession, violationAliasConditions } from '../../services/automations/aliasFilter.js';
import { hasServerAccess } from '../../utils/serverFiltering.js';
import { serverOrderBy } from '../../utils/serverOrder.js';
import {
  identityAccountsWhere,
  queryTerminationHistory,
  queryUserDevices,
  queryUserLocations,
  userHistoryWindow,
  userPlayTotals,
  userRecentPlays,
  userSessionCounts,
} from './queries/index.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';

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
        .where(identityAccountsWhere(authUser, [serverUser.userId]))
        .orderBy(...serverOrderBy(), serverUsers.id);

      const identityIds = identityServerUserRows.map((su) => su.id);

      const window = userHistoryWindow();
      const sessionCounts = await userSessionCounts(tx, identityIds, window);
      const sessionCountOf = (serverUserId: string) => sessionCounts.get(serverUserId) ?? 0;

      // scope=identity fans every scoped panel query out across the whole
      // accessible identity; otherwise they stay anchored on just this account.
      // identityIds always contains at least `id` itself (the anchor already
      // passed the access check above), so this can't come back empty.
      const scopedIds = scope === 'identity' ? identityIds : [id];

      const identityStats =
        identityIds.length > 0 ? await userPlayTotals(tx, identityIds, window) : undefined;

      // 2. Get session stats — count unique plays, not raw rows
      const stats = await userPlayTotals(tx, scopedIds, window);

      // 3. Get recent sessions grouped by play (collapse pause/resume chains)
      const recentSessions = await userRecentPlays(tx, scopedIds, window, {
        limit: sessionsLimit,
      });

      // 4. Get locations
      const locations = await queryUserLocations(tx, scopedIds, window);

      // 5. Get devices (shared query handles dedup and aggregation)
      const devices = await queryUserDevices(tx, scopedIds, window);

      // 6. Get violations (recent, limited)
      const scopedIdArray = uuidArraySql(scopedIds);
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
          stats,
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
          stats: identityStats ?? { totalSessions: 0, totalWatchTime: 0 },
        },
        sessions: {
          data: recentSessions,
          total: stats.totalSessions,
          hasMore: stats.totalSessions > sessionsLimit,
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
