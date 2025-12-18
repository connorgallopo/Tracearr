/**
 * User Devices Route
 *
 * GET /:id/devices - Get user's unique devices (aggregated from sessions)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { userIdParamSchema, type UserDevice } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { serverUsers, sessions } from '../../db/schema.js';

export const devicesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /:id/devices - Get user's unique devices (aggregated from sessions)
   */
  app.get('/:id/devices', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Verify server user exists and access
    const serverUserRows = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    if (!authUser.serverIds.includes(serverUser.serverId)) {
      return reply.forbidden('You do not have access to this user');
    }

    // Aggregate devices from sessions with location data
    // Use deviceId as primary key (fallback to playerName if deviceId is null)
    // Aggregate locations where each device has been used
    const sessionData = await db
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

    // Group by deviceId (or playerName as fallback)
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

    for (const session of sessionData) {
      // Use deviceId as key, or playerName as fallback, or generate a hash from metadata
      const key =
        session.deviceId ??
        session.playerName ??
        `${session.product ?? 'unknown'}-${session.device ?? 'unknown'}-${session.platform ?? 'unknown'}`;

      const existing = deviceMap.get(key);
      if (existing) {
        existing.sessionCount++;
        // Update lastSeenAt if this session is more recent
        if (session.startedAt > existing.lastSeenAt) {
          existing.lastSeenAt = session.startedAt;
          // Use most recent values for metadata
          existing.playerName = session.playerName ?? existing.playerName;
          existing.product = session.product ?? existing.product;
          existing.device = session.device ?? existing.device;
          existing.platform = session.platform ?? existing.platform;
        }

        // Aggregate location
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

    // Convert to array and sort by last seen
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

    return { data: devices };
  });
};
