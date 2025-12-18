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
import { eq, desc, sql } from 'drizzle-orm';
import { userIdParamSchema, type UserLocation, type UserDevice } from '@tracearr/shared';
import { db } from '../../db/client.js';
import {
  serverUsers,
  sessions,
  servers,
  users,
  violations,
  rules,
  terminationLogs,
} from '../../db/schema.js';
import { hasServerAccess } from '../../utils/serverFiltering.js';

export const fullRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /:id/full - Get complete user details in one request
   *
   * Returns user info + stats + recent sessions + locations + devices + violations + terminations
   * All in a single database transaction for consistency.
   */
  app.get('/:id/full', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const { id } = params.data;
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
          sessionCount: serverUsers.sessionCount,
          createdAt: serverUsers.createdAt,
          updatedAt: serverUsers.updatedAt,
          identityName: users.name,
          role: users.role,
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

      // 2. Get session stats (single query)
      const statsResult = await tx
        .select({
          totalSessions: sql<number>`count(*)::int`,
          totalWatchTime: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
        })
        .from(sessions)
        .where(eq(sessions.serverUserId, id));

      const stats = statsResult[0];

      // 3. Get recent sessions (paginated first page)
      const recentSessions = await tx
        .select({
          id: sessions.id,
          serverId: sessions.serverId,
          serverName: servers.name,
          serverUserId: sessions.serverUserId,
          sessionKey: sessions.sessionKey,
          state: sessions.state,
          mediaType: sessions.mediaType,
          mediaTitle: sessions.mediaTitle,
          grandparentTitle: sessions.grandparentTitle,
          seasonNumber: sessions.seasonNumber,
          episodeNumber: sessions.episodeNumber,
          year: sessions.year,
          thumbPath: sessions.thumbPath,
          ratingKey: sessions.ratingKey,
          externalSessionId: sessions.externalSessionId,
          startedAt: sessions.startedAt,
          stoppedAt: sessions.stoppedAt,
          durationMs: sessions.durationMs,
          totalDurationMs: sessions.totalDurationMs,
          progressMs: sessions.progressMs,
          lastPausedAt: sessions.lastPausedAt,
          pausedDurationMs: sessions.pausedDurationMs,
          referenceId: sessions.referenceId,
          watched: sessions.watched,
          ipAddress: sessions.ipAddress,
          geoCity: sessions.geoCity,
          geoRegion: sessions.geoRegion,
          geoCountry: sessions.geoCountry,
          geoLat: sessions.geoLat,
          geoLon: sessions.geoLon,
          playerName: sessions.playerName,
          deviceId: sessions.deviceId,
          product: sessions.product,
          device: sessions.device,
          platform: sessions.platform,
          quality: sessions.quality,
          isTranscode: sessions.isTranscode,
          bitrate: sessions.bitrate,
        })
        .from(sessions)
        .innerJoin(servers, eq(sessions.serverId, servers.id))
        .where(eq(sessions.serverUserId, id))
        .orderBy(desc(sessions.startedAt))
        .limit(sessionsLimit);

      // 4. Get locations (aggregated)
      const locationData = await tx
        .select({
          city: sessions.geoCity,
          region: sessions.geoRegion,
          country: sessions.geoCountry,
          lat: sessions.geoLat,
          lon: sessions.geoLon,
          sessionCount: sql<number>`count(*)::int`,
          lastSeenAt: sql<Date>`max(${sessions.startedAt})`,
          ipAddresses: sql<string[]>`array_agg(distinct ${sessions.ipAddress})`,
        })
        .from(sessions)
        .where(eq(sessions.serverUserId, id))
        .groupBy(
          sessions.geoCity,
          sessions.geoRegion,
          sessions.geoCountry,
          sessions.geoLat,
          sessions.geoLon
        )
        .orderBy(desc(sql`max(${sessions.startedAt})`));

      const locations: UserLocation[] = locationData.map((loc) => ({
        city: loc.city,
        region: loc.region,
        country: loc.country,
        lat: loc.lat,
        lon: loc.lon,
        sessionCount: loc.sessionCount,
        lastSeenAt: loc.lastSeenAt,
        ipAddresses: loc.ipAddresses ?? [],
      }));

      // 5. Get devices (fetch sessions for device aggregation)
      const deviceSessionData = await tx
        .select({
          deviceId: sessions.deviceId,
          playerName: sessions.playerName,
          product: sessions.product,
          device: sessions.device,
          platform: sessions.platform,
          startedAt: sessions.startedAt,
          geoCity: sessions.geoCity,
          geoRegion: sessions.geoRegion,
          geoCountry: sessions.geoCountry,
        })
        .from(sessions)
        .where(eq(sessions.serverUserId, id))
        .orderBy(desc(sessions.startedAt));

      // Aggregate devices in memory (same logic as devices.ts)
      const deviceMap = new Map<
        string,
        {
          deviceId: string | null;
          playerName: string | null;
          product: string | null;
          device: string | null;
          platform: string | null;
          sessionCount: number;
          lastSeenAt: Date;
          locationMap: Map<
            string,
            {
              city: string | null;
              region: string | null;
              country: string | null;
              sessionCount: number;
              lastSeenAt: Date;
            }
          >;
        }
      >();

      for (const session of deviceSessionData) {
        const key =
          session.deviceId ??
          session.playerName ??
          `${session.product ?? 'unknown'}-${session.device ?? 'unknown'}-${session.platform ?? 'unknown'}`;

        const existing = deviceMap.get(key);
        if (existing) {
          existing.sessionCount++;
          if (session.startedAt > existing.lastSeenAt) {
            existing.lastSeenAt = session.startedAt;
            existing.playerName = session.playerName ?? existing.playerName;
            existing.product = session.product ?? existing.product;
            existing.device = session.device ?? existing.device;
            existing.platform = session.platform ?? existing.platform;
          }

          const locKey = `${session.geoCity ?? ''}-${session.geoRegion ?? ''}-${session.geoCountry ?? ''}`;
          const existingLoc = existing.locationMap.get(locKey);
          if (existingLoc) {
            existingLoc.sessionCount++;
            if (session.startedAt > existingLoc.lastSeenAt) {
              existingLoc.lastSeenAt = session.startedAt;
            }
          } else {
            existing.locationMap.set(locKey, {
              city: session.geoCity,
              region: session.geoRegion,
              country: session.geoCountry,
              sessionCount: 1,
              lastSeenAt: session.startedAt,
            });
          }
        } else {
          const locationMap = new Map<
            string,
            {
              city: string | null;
              region: string | null;
              country: string | null;
              sessionCount: number;
              lastSeenAt: Date;
            }
          >();
          const locKey = `${session.geoCity ?? ''}-${session.geoRegion ?? ''}-${session.geoCountry ?? ''}`;
          locationMap.set(locKey, {
            city: session.geoCity,
            region: session.geoRegion,
            country: session.geoCountry,
            sessionCount: 1,
            lastSeenAt: session.startedAt,
          });

          deviceMap.set(key, {
            deviceId: session.deviceId,
            playerName: session.playerName,
            product: session.product,
            device: session.device,
            platform: session.platform,
            sessionCount: 1,
            lastSeenAt: session.startedAt,
            locationMap,
          });
        }
      }

      const devices: UserDevice[] = Array.from(deviceMap.values())
        .map((dev) => ({
          deviceId: dev.deviceId,
          playerName: dev.playerName,
          product: dev.product,
          device: dev.device,
          platform: dev.platform,
          sessionCount: dev.sessionCount,
          lastSeenAt: dev.lastSeenAt,
          locations: Array.from(dev.locationMap.values()).sort(
            (a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()
          ),
        }))
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

      // 6. Get violations (recent, limited)
      const violationData = await tx
        .select({
          id: violations.id,
          ruleId: violations.ruleId,
          ruleName: rules.name,
          ruleType: rules.type,
          serverUserId: violations.serverUserId,
          sessionId: violations.sessionId,
          mediaTitle: sessions.mediaTitle,
          severity: violations.severity,
          data: violations.data,
          createdAt: violations.createdAt,
          acknowledgedAt: violations.acknowledgedAt,
        })
        .from(violations)
        .innerJoin(rules, eq(violations.ruleId, rules.id))
        .innerJoin(sessions, eq(violations.sessionId, sessions.id))
        .where(eq(violations.serverUserId, id))
        .orderBy(desc(violations.createdAt))
        .limit(violationsLimit);

      // Get violations count
      const violationsCountResult = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(violations)
        .where(eq(violations.serverUserId, id));

      const violationsTotal = violationsCountResult[0]?.count ?? 0;

      // 7. Get termination history (recent, limited)
      const terminationData = await tx
        .select({
          id: terminationLogs.id,
          sessionId: terminationLogs.sessionId,
          serverId: terminationLogs.serverId,
          serverUserId: terminationLogs.serverUserId,
          trigger: terminationLogs.trigger,
          triggeredByUserId: terminationLogs.triggeredByUserId,
          triggeredByUsername: users.username,
          ruleId: terminationLogs.ruleId,
          ruleName: rules.name,
          violationId: terminationLogs.violationId,
          reason: terminationLogs.reason,
          success: terminationLogs.success,
          errorMessage: terminationLogs.errorMessage,
          createdAt: terminationLogs.createdAt,
          mediaTitle: sessions.mediaTitle,
          mediaType: sessions.mediaType,
        })
        .from(terminationLogs)
        .leftJoin(users, eq(terminationLogs.triggeredByUserId, users.id))
        .leftJoin(rules, eq(terminationLogs.ruleId, rules.id))
        .leftJoin(sessions, eq(terminationLogs.sessionId, sessions.id))
        .where(eq(terminationLogs.serverUserId, id))
        .orderBy(desc(terminationLogs.createdAt))
        .limit(terminationsLimit);

      // Get terminations count
      const terminationsCountResult = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(terminationLogs)
        .where(eq(terminationLogs.serverUserId, id));

      const terminationsTotal = terminationsCountResult[0]?.count ?? 0;

      return {
        user: {
          ...serverUser,
          stats: {
            totalSessions: stats?.totalSessions ?? 0,
            totalWatchTime: Number(stats?.totalWatchTime ?? 0),
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
