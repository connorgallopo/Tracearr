/**
 * User Sessions Route
 *
 * GET /:id/sessions - Get user's session history
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, sql } from 'drizzle-orm';
import { userIdParamSchema, paginationSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { serverUsers, sessions, servers } from '../../db/schema.js';

export const sessionsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /:id/sessions - Get user's session history
   */
  app.get('/:id/sessions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const query = paginationSchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { id } = params.data;
    const { page = 1, pageSize = 50 } = query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;

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

    // Get sessions
    const sessionData = await db
      .select({
        id: sessions.id,
        serverId: sessions.serverId,
        serverName: servers.name,
        serverUserId: sessions.serverUserId,
        sessionKey: sessions.sessionKey,
        state: sessions.state,
        mediaType: sessions.mediaType,
        mediaTitle: sessions.mediaTitle,
        // Media metadata for display
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
        // Pause tracking fields
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
      .limit(pageSize)
      .offset(offset);

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(eq(sessions.serverUserId, id));

    const total = countResult[0]?.count ?? 0;

    return {
      data: sessionData,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });
};
