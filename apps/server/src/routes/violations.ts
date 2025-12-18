/**
 * Violation management routes
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, gte, lte, isNull, isNotNull, sql, inArray } from 'drizzle-orm';
import {
  violationQuerySchema,
  violationIdParamSchema,
  type ViolationSessionInfo,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { violations, rules, serverUsers, sessions, servers, users } from '../db/schema.js';
import { hasServerAccess } from '../utils/serverFiltering.js';
import { getTrustScorePenalty } from '../jobs/poller/violations.js';

export const violationRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /violations - List violations with pagination and filters
   *
   * Violations are filtered by server access. Users only see violations
   * from servers they have access to.
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = violationQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const {
      page = 1,
      pageSize = 50,
      serverId,
      serverUserId,
      ruleId,
      severity,
      acknowledged,
      startDate,
      endDate,
    } = query.data;

    const authUser = request.user;
    const offset = (page - 1) * pageSize;

    // Validate server access if specific server requested
    if (serverId && !hasServerAccess(authUser, serverId)) {
      return reply.forbidden('You do not have access to this server');
    }

    // Build conditions
    const conditions = [];

    // Server filter - either specific server or user's accessible servers
    if (serverId) {
      // Specific server requested
      conditions.push(eq(serverUsers.serverId, serverId));
    } else if (authUser.role !== 'owner') {
      // No specific server, filter by user's accessible servers
      if (authUser.serverIds.length === 0) {
        // No server access - return empty
        return {
          data: [],
          page,
          pageSize,
          total: 0,
          totalPages: 0,
        };
      } else if (authUser.serverIds.length === 1) {
        const serverId = authUser.serverIds[0];
        if (serverId) {
          conditions.push(eq(serverUsers.serverId, serverId));
        }
      } else {
        conditions.push(inArray(serverUsers.serverId, authUser.serverIds));
      }
    }

    if (serverUserId) {
      conditions.push(eq(violations.serverUserId, serverUserId));
    }

    if (ruleId) {
      conditions.push(eq(violations.ruleId, ruleId));
    }

    if (severity) {
      conditions.push(eq(violations.severity, severity));
    }

    if (acknowledged === true) {
      conditions.push(isNotNull(violations.acknowledgedAt));
    } else if (acknowledged === false) {
      conditions.push(isNull(violations.acknowledgedAt));
    }

    if (startDate) {
      conditions.push(gte(violations.createdAt, startDate));
    }

    if (endDate) {
      conditions.push(lte(violations.createdAt, endDate));
    }

    // Query violations with joins, including server info and session details
    const violationData = await db
      .select({
        id: violations.id,
        ruleId: violations.ruleId,
        ruleName: rules.name,
        ruleType: rules.type,
        serverUserId: violations.serverUserId,
        username: serverUsers.username,
        userThumb: serverUsers.thumbUrl,
        identityName: users.name,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        sessionId: violations.sessionId,
        // Session details for context
        mediaTitle: sessions.mediaTitle,
        mediaType: sessions.mediaType,
        grandparentTitle: sessions.grandparentTitle,
        seasonNumber: sessions.seasonNumber,
        episodeNumber: sessions.episodeNumber,
        year: sessions.year,
        ipAddress: sessions.ipAddress,
        geoCity: sessions.geoCity,
        geoRegion: sessions.geoRegion,
        geoCountry: sessions.geoCountry,
        geoLat: sessions.geoLat,
        geoLon: sessions.geoLon,
        playerName: sessions.playerName,
        device: sessions.device,
        deviceId: sessions.deviceId,
        platform: sessions.platform,
        product: sessions.product,
        quality: sessions.quality,
        startedAt: sessions.startedAt,
        severity: violations.severity,
        data: violations.data,
        createdAt: violations.createdAt,
        acknowledgedAt: violations.acknowledgedAt,
      })
      .from(violations)
      .innerJoin(rules, eq(violations.ruleId, rules.id))
      .innerJoin(serverUsers, eq(violations.serverUserId, serverUsers.id))
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .innerJoin(sessions, eq(violations.sessionId, sessions.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(violations.createdAt))
      .limit(pageSize)
      .offset(offset);

    // Get total count with same filters
    // Need to use raw SQL for count with the same joins
    const countConditions = [];

    // Server filter for count query
    if (serverId) {
      countConditions.push(sql`su.server_id = ${serverId}`);
    } else if (authUser.role !== 'owner') {
      if (authUser.serverIds.length === 1) {
        countConditions.push(sql`su.server_id = ${authUser.serverIds[0]}`);
      } else if (authUser.serverIds.length > 1) {
        const serverIdList = authUser.serverIds.map((id: string) => sql`${id}`);
        countConditions.push(sql`su.server_id IN (${sql.join(serverIdList, sql`, `)})`);
      }
    }

    if (serverUserId) {
      countConditions.push(sql`v.server_user_id = ${serverUserId}`);
    }

    if (ruleId) {
      countConditions.push(sql`v.rule_id = ${ruleId}`);
    }

    if (severity) {
      countConditions.push(sql`v.severity = ${severity}`);
    }

    if (acknowledged === true) {
      countConditions.push(sql`v.acknowledged_at IS NOT NULL`);
    } else if (acknowledged === false) {
      countConditions.push(sql`v.acknowledged_at IS NULL`);
    }

    if (startDate) {
      countConditions.push(sql`v.created_at >= ${startDate}`);
    }

    if (endDate) {
      countConditions.push(sql`v.created_at <= ${endDate}`);
    }

    const whereClause =
      countConditions.length > 0 ? sql`WHERE ${sql.join(countConditions, sql` AND `)}` : sql``;

    const countResult = await db.execute(sql`
        SELECT count(*)::int as count
        FROM violations v
        INNER JOIN server_users su ON su.id = v.server_user_id
        ${whereClause}
      `);

    const total = (countResult.rows[0] as { count: number })?.count ?? 0;

    // Identify violations that need historical/related data to batch queries
    const violationsNeedingData = violationData.filter((v) =>
      ['concurrent_streams', 'simultaneous_locations', 'device_velocity'].includes(v.ruleType)
    );

    // Collect all relatedSessionIds from violation data for direct lookup
    const allRelatedSessionIds = new Set<string>();
    for (const v of violationsNeedingData) {
      const vData = v.data as Record<string, unknown> | null;
      const relatedIds = (vData?.relatedSessionIds as string[]) || [];
      for (const id of relatedIds) {
        allRelatedSessionIds.add(id);
      }
    }

    // Batch fetch historical data by serverUserId to avoid N+1 queries
    const historicalDataByUserId = new Map<
      string,
      Array<{
        ipAddress: string;
        deviceId: string | null;
        device: string | null;
        geoCity: string | null;
        geoCountry: string | null;
        startedAt: Date;
      }>
    >();

    // Batch fetch related sessions by (serverUserId, ruleType) to avoid N+1 queries
    const relatedSessionsByViolation = new Map<string, ViolationSessionInfo[]>();

    // Map to store fetched sessions by ID for direct lookup from relatedSessionIds
    const sessionsById = new Map<string, ViolationSessionInfo>();

    // Wrap batching in try-catch to handle errors gracefully (e.g., in tests or when queries fail)
    try {
      if (violationsNeedingData.length > 0) {
        // Group violations by serverUserId and find the oldest violation time for each user
        const userViolationTimes = new Map<string, Date>();
        for (const v of violationsNeedingData) {
          const existing = userViolationTimes.get(v.serverUserId);
          if (!existing || v.createdAt < existing) {
            userViolationTimes.set(v.serverUserId, v.createdAt);
          }
        }

        // Batch fetch historical sessions for each unique serverUserId
        // Go back 30 days from the oldest violation time for each user
        const historicalPromises = Array.from(userViolationTimes.entries()).map(
          async ([serverUserId, oldestViolationTime]) => {
            try {
              const historyWindow = new Date(
                oldestViolationTime.getTime() - 30 * 24 * 60 * 60 * 1000
              );
              const historicalSessions = await db
                .select({
                  ipAddress: sessions.ipAddress,
                  deviceId: sessions.deviceId,
                  device: sessions.device,
                  geoCity: sessions.geoCity,
                  geoCountry: sessions.geoCountry,
                  startedAt: sessions.startedAt,
                })
                .from(sessions)
                .where(
                  and(
                    eq(sessions.serverUserId, serverUserId),
                    gte(sessions.startedAt, historyWindow),
                    lte(sessions.startedAt, oldestViolationTime)
                  )
                )
                .limit(1000); // Get enough to build a good history

              return [serverUserId, historicalSessions] as const;
            } catch (error) {
              // If query fails (e.g., in tests), return empty array for this user
              console.error(
                `[Violations] Failed to fetch historical data for user ${serverUserId}:`,
                error
              );
              const emptyArray: Array<{
                ipAddress: string;
                deviceId: string | null;
                device: string | null;
                geoCity: string | null;
                geoCountry: string | null;
                startedAt: Date;
              }> = [];
              return [serverUserId, emptyArray] as const;
            }
          }
        );

        const historicalResults = await Promise.allSettled(historicalPromises);
        for (const result of historicalResults) {
          if (result.status === 'fulfilled') {
            const [serverUserId, sessions] = result.value;
            historicalDataByUserId.set(serverUserId, sessions);
          }
          // If rejected, that user just won't have historical data (already handled in catch)
        }
      }

      // Batch fetch sessions by ID from relatedSessionIds stored in violation data
      if (allRelatedSessionIds.size > 0) {
        try {
          const relatedSessionsResult = await db
            .select({
              id: sessions.id,
              mediaTitle: sessions.mediaTitle,
              mediaType: sessions.mediaType,
              grandparentTitle: sessions.grandparentTitle,
              seasonNumber: sessions.seasonNumber,
              episodeNumber: sessions.episodeNumber,
              year: sessions.year,
              ipAddress: sessions.ipAddress,
              geoCity: sessions.geoCity,
              geoRegion: sessions.geoRegion,
              geoCountry: sessions.geoCountry,
              geoLat: sessions.geoLat,
              geoLon: sessions.geoLon,
              playerName: sessions.playerName,
              device: sessions.device,
              deviceId: sessions.deviceId,
              platform: sessions.platform,
              product: sessions.product,
              quality: sessions.quality,
              startedAt: sessions.startedAt,
            })
            .from(sessions)
            .where(inArray(sessions.id, Array.from(allRelatedSessionIds)));

          for (const s of relatedSessionsResult) {
            sessionsById.set(s.id, {
              ...s,
              deviceId: s.deviceId ?? null,
            });
          }
        } catch (error) {
          console.error('[Violations] Failed to batch fetch related sessions by ID:', error);
          // Continue without related sessions - fallback to time-based logic
        }
      }

      if (violationsNeedingData.length > 0) {
        // Group violations by (serverUserId, ruleType) and find time ranges
        const violationGroups = new Map<
          string,
          {
            violations: Array<{ id: string; createdAt: Date }>;
            earliestTime: Date;
            latestTime: Date;
          }
        >();

        for (const v of violationsNeedingData) {
          const key = `${v.serverUserId}:${v.ruleType}`;
          const existing = violationGroups.get(key);
          const violationTime = v.createdAt;
          const timeWindow = new Date(violationTime.getTime() - 5 * 60 * 1000); // 5 minutes before violation

          if (existing) {
            existing.violations.push({ id: v.id, createdAt: violationTime });
            if (timeWindow < existing.earliestTime) {
              existing.earliestTime = timeWindow;
            }
            if (violationTime > existing.latestTime) {
              existing.latestTime = violationTime;
            }
          } else {
            violationGroups.set(key, {
              violations: [{ id: v.id, createdAt: violationTime }],
              earliestTime: timeWindow,
              latestTime: violationTime,
            });
          }
        }

        // Batch fetch related sessions for each group
        const relatedSessionsPromises = Array.from(violationGroups.entries()).map(
          async ([key, group]) => {
            const parts = key.split(':');
            const serverUserId = parts[0];
            const ruleType = parts[1];
            if (!serverUserId || !ruleType) {
              console.error(`[Violations] Invalid key format: ${key}`);
              // Mark all violations in this group as having no related sessions
              for (const violation of group.violations) {
                relatedSessionsByViolation.set(violation.id, []);
              }
              return;
            }
            const conditions = [
              eq(sessions.serverUserId, serverUserId),
              gte(sessions.startedAt, group.earliestTime),
              lte(sessions.startedAt, group.latestTime),
            ];

            // Add rule-type-specific conditions
            if (ruleType === 'concurrent_streams') {
              conditions.push(eq(sessions.state, 'playing'));
              conditions.push(isNull(sessions.stoppedAt));
            } else if (ruleType === 'simultaneous_locations') {
              conditions.push(eq(sessions.state, 'playing'));
              conditions.push(isNull(sessions.stoppedAt));
              conditions.push(isNotNull(sessions.geoLat));
              conditions.push(isNotNull(sessions.geoLon));
            }
            // device_velocity has no additional conditions

            try {
              const sessionsResult = await db
                .select({
                  id: sessions.id,
                  mediaTitle: sessions.mediaTitle,
                  mediaType: sessions.mediaType,
                  grandparentTitle: sessions.grandparentTitle,
                  seasonNumber: sessions.seasonNumber,
                  episodeNumber: sessions.episodeNumber,
                  year: sessions.year,
                  ipAddress: sessions.ipAddress,
                  geoCity: sessions.geoCity,
                  geoRegion: sessions.geoRegion,
                  geoCountry: sessions.geoCountry,
                  geoLat: sessions.geoLat,
                  geoLon: sessions.geoLon,
                  playerName: sessions.playerName,
                  device: sessions.device,
                  deviceId: sessions.deviceId,
                  platform: sessions.platform,
                  product: sessions.product,
                  quality: sessions.quality,
                  startedAt: sessions.startedAt,
                })
                .from(sessions)
                .where(and(...conditions))
                .orderBy(desc(sessions.startedAt))
                .limit(100); // Fetch more to cover all violations in the group

              const mappedSessions = sessionsResult.map((s) => ({
                ...s,
                deviceId: s.deviceId ?? null,
              }));

              // Filter sessions to each violation's specific 5-minute window
              for (const violation of group.violations) {
                const violationTime = violation.createdAt;
                const timeWindow = new Date(violationTime.getTime() - 5 * 60 * 1000);
                const violationSessions = mappedSessions
                  .filter((s) => s.startedAt >= timeWindow && s.startedAt <= violationTime)
                  .slice(0, 20); // Limit to 20 per violation
                relatedSessionsByViolation.set(violation.id, violationSessions);
              }
            } catch (error) {
              // If fetching fails, mark all violations in this group as having no related sessions
              console.error(
                `[Violations] Failed to fetch related sessions for group ${key}:`,
                error
              );
              for (const violation of group.violations) {
                relatedSessionsByViolation.set(violation.id, []);
              }
            }
          }
        );

        await Promise.allSettled(relatedSessionsPromises);
        // Errors are already handled in individual try-catch blocks
      }
    } catch (error) {
      // If batching fails (e.g., in tests or when queries fail), continue without extra data
      // This prevents the entire violation list from failing
      console.error('[Violations] Failed to batch fetch historical/related data:', error);
    }

    // Transform flat data into nested structure expected by frontend
    const formattedData = violationData.map((v) => {
      // Fetch related sessions - prioritize using relatedSessionIds from violation data
      // This is more accurate than time-based queries
      const vData = v.data as Record<string, unknown> | null;
      const relatedSessionIdsFromData = (vData?.relatedSessionIds as string[]) || [];

      let relatedSessions: ViolationSessionInfo[] = [];
      if (relatedSessionIdsFromData.length > 0) {
        // Use the stored relatedSessionIds for direct lookup (preferred)
        relatedSessions = relatedSessionIdsFromData
          .map((id) => sessionsById.get(id))
          .filter((s): s is ViolationSessionInfo => s !== undefined);
      } else {
        // Fallback to time-based query results for older violations
        relatedSessions = relatedSessionsByViolation.get(v.id) ?? [];
      }

      // For concurrent_streams, simultaneous_locations, and device_velocity, fetch related sessions
      // Also fetch user's historical data for comparison
      let userHistory: {
        previousIPs: string[];
        previousDevices: string[];
        previousLocations: Array<{ city: string | null; country: string | null; ip: string }>;
      } = {
        previousIPs: [],
        previousDevices: [],
        previousLocations: [],
      };

      if (
        ['concurrent_streams', 'simultaneous_locations', 'device_velocity'].includes(v.ruleType)
      ) {
        const violationTime = v.createdAt;

        // Use batched historical data, filtered to this violation's time window
        const allHistoricalSessions = historicalDataByUserId.get(v.serverUserId) ?? [];
        const historicalSessions = allHistoricalSessions.filter(
          (s) =>
            s.startedAt >= new Date(violationTime.getTime() - 30 * 24 * 60 * 60 * 1000) &&
            s.startedAt <= violationTime
        );

        // Build unique sets of previous values
        const ipSet = new Set<string>();
        const deviceSet = new Set<string>();
        const locationMap = new Map<
          string,
          { city: string | null; country: string | null; ip: string }
        >();

        for (const hist of historicalSessions) {
          if (hist.ipAddress) ipSet.add(hist.ipAddress);
          if (hist.deviceId) deviceSet.add(hist.deviceId);
          if (hist.device) deviceSet.add(hist.device);
          if (hist.geoCity || hist.geoCountry) {
            const locKey = `${hist.geoCity ?? ''}-${hist.geoCountry ?? ''}`;
            if (!locationMap.has(locKey)) {
              locationMap.set(locKey, {
                city: hist.geoCity,
                country: hist.geoCountry,
                ip: hist.ipAddress,
              });
            }
          }
        }

        userHistory = {
          previousIPs: Array.from(ipSet),
          previousDevices: Array.from(deviceSet),
          previousLocations: Array.from(locationMap.values()),
        };
      }

      return {
        id: v.id,
        ruleId: v.ruleId,
        serverUserId: v.serverUserId,
        sessionId: v.sessionId,
        severity: v.severity,
        data: v.data,
        createdAt: v.createdAt,
        acknowledgedAt: v.acknowledgedAt,
        rule: {
          id: v.ruleId,
          name: v.ruleName,
          type: v.ruleType,
        },
        user: {
          id: v.serverUserId,
          username: v.username,
          thumbUrl: v.userThumb,
          serverId: v.serverId,
          identityName: v.identityName,
        },
        server: {
          id: v.serverId,
          name: v.serverName,
        },
        session: {
          id: v.sessionId,
          mediaTitle: v.mediaTitle,
          mediaType: v.mediaType,
          grandparentTitle: v.grandparentTitle,
          seasonNumber: v.seasonNumber,
          episodeNumber: v.episodeNumber,
          year: v.year,
          ipAddress: v.ipAddress,
          geoCity: v.geoCity,
          geoRegion: v.geoRegion,
          geoCountry: v.geoCountry,
          geoLat: v.geoLat,
          geoLon: v.geoLon,
          playerName: v.playerName,
          device: v.device,
          deviceId: v.deviceId ?? null,
          platform: v.platform,
          product: v.product,
          quality: v.quality,
          startedAt: v.startedAt,
        },
        relatedSessions: relatedSessions.length > 0 ? relatedSessions : undefined,
        userHistory:
          Object.keys(userHistory.previousIPs).length > 0 ||
          Object.keys(userHistory.previousDevices).length > 0 ||
          userHistory.previousLocations.length > 0
            ? userHistory
            : undefined,
      };
    });

    return {
      data: formattedData,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });

  /**
   * GET /violations/:id - Get a specific violation
   */
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = violationIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid violation ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Query with server info for access check
    const violationRows = await db
      .select({
        id: violations.id,
        ruleId: violations.ruleId,
        ruleName: rules.name,
        ruleType: rules.type,
        serverUserId: violations.serverUserId,
        username: serverUsers.username,
        userThumb: serverUsers.thumbUrl,
        identityName: users.name,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        sessionId: violations.sessionId,
        mediaTitle: sessions.mediaTitle,
        ipAddress: sessions.ipAddress,
        geoCity: sessions.geoCity,
        geoCountry: sessions.geoCountry,
        playerName: sessions.playerName,
        platform: sessions.platform,
        severity: violations.severity,
        data: violations.data,
        createdAt: violations.createdAt,
        acknowledgedAt: violations.acknowledgedAt,
      })
      .from(violations)
      .innerJoin(rules, eq(violations.ruleId, rules.id))
      .innerJoin(serverUsers, eq(violations.serverUserId, serverUsers.id))
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .innerJoin(sessions, eq(violations.sessionId, sessions.id))
      .where(eq(violations.id, id))
      .limit(1);

    const violation = violationRows[0];
    if (!violation) {
      return reply.notFound('Violation not found');
    }

    // Check server access
    if (!hasServerAccess(authUser, violation.serverId)) {
      return reply.forbidden('You do not have access to this violation');
    }

    return violation;
  });

  /**
   * PATCH /violations/:id - Acknowledge a violation
   */
  app.patch('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = violationIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid violation ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can acknowledge violations
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can acknowledge violations');
    }

    // Check violation exists and get server info for access check
    const violationRows = await db
      .select({
        id: violations.id,
        serverId: serverUsers.serverId,
      })
      .from(violations)
      .innerJoin(serverUsers, eq(violations.serverUserId, serverUsers.id))
      .where(eq(violations.id, id))
      .limit(1);

    const violation = violationRows[0];
    if (!violation) {
      return reply.notFound('Violation not found');
    }

    // Check server access
    if (!hasServerAccess(authUser, violation.serverId)) {
      return reply.forbidden('You do not have access to this violation');
    }

    // Update acknowledgment
    const updated = await db
      .update(violations)
      .set({
        acknowledgedAt: new Date(),
      })
      .where(eq(violations.id, id))
      .returning({
        id: violations.id,
        acknowledgedAt: violations.acknowledgedAt,
      });

    const updatedViolation = updated[0];
    if (!updatedViolation) {
      return reply.internalServerError('Failed to acknowledge violation');
    }

    return {
      success: true,
      acknowledgedAt: updatedViolation.acknowledgedAt,
    };
  });

  /**
   * DELETE /violations/:id - Dismiss (delete) a violation
   */
  app.delete('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = violationIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid violation ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can delete violations
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can dismiss violations');
    }

    // Check violation exists and get info needed for trust score restoration
    const violationRows = await db
      .select({
        id: violations.id,
        severity: violations.severity,
        serverUserId: violations.serverUserId,
        serverId: serverUsers.serverId,
      })
      .from(violations)
      .innerJoin(serverUsers, eq(violations.serverUserId, serverUsers.id))
      .where(eq(violations.id, id))
      .limit(1);

    const violation = violationRows[0];
    if (!violation) {
      return reply.notFound('Violation not found');
    }

    // Check server access
    if (!hasServerAccess(authUser, violation.serverId)) {
      return reply.forbidden('You do not have access to this violation');
    }

    // Calculate trust penalty to restore
    const trustPenalty = getTrustScorePenalty(violation.severity);

    // Delete violation and restore trust score atomically
    await db.transaction(async (tx) => {
      // Delete the violation
      await tx.delete(violations).where(eq(violations.id, id));

      // Restore trust score (capped at 100)
      await tx
        .update(serverUsers)
        .set({
          trustScore: sql`LEAST(100, ${serverUsers.trustScore} + ${trustPenalty})`,
          updatedAt: new Date(),
        })
        .where(eq(serverUsers.id, violation.serverUserId));
    });

    return { success: true };
  });
};
