/**
 * Session Management Routes
 *
 * GET /me - Get current user info
 */

import type { FastifyPluginAsync } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { getAllServerIds } from './utils.js';
import { getUserById } from '../../services/userService.js';
import { db } from '../../db/client.js';
import { authAccounts, serverUsers } from '../../db/schema.js';
import { loadScope } from '../../lib/scope.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /me - Get current user info
   */
  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = request.user;

    const user = await getUserById(authUser.userId);

    if (!user) {
      // User in JWT doesn't exist in database - token is invalid
      throw app.httpErrors.unauthorized('User no longer exists');
    }

    const scope = await loadScope(user.id, user.role);
    const serverIds = scope === 'all' ? await getAllServerIds() : scope.serverIds;

    const linked = new Set(
      (
        await db
          .select({ providerId: authAccounts.providerId })
          .from(authAccounts)
          .where(
            and(
              eq(authAccounts.userId, user.id),
              inArray(authAccounts.providerId, ['credential', 'plex', 'tofa'])
            )
          )
      ).map((account) => account.providerId)
    );

    // A picture copied from a server account is a path on that server, loadable only through the
    // image proxy, which needs the server.
    const [pictureAccount] = user.thumbnail
      ? await db
          .select({ serverId: serverUsers.serverId })
          .from(serverUsers)
          .where(and(eq(serverUsers.userId, user.id), eq(serverUsers.thumbUrl, user.thumbnail)))
          .limit(1)
      : [];

    return {
      userId: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      thumbnail: user.thumbnail,
      thumbnailServerId: pictureAccount?.serverId ?? null,
      role: user.role,
      // A member never sees the trust score the owner keeps on them.
      ...(scope === 'all' ? { aggregateTrustScore: user.aggregateTrustScore } : {}),
      serverIds,
      hasPassword: !!user.passwordHash || linked.has('credential'),
      hasPlexLinked: !!user.plexAccountId || linked.has('plex'),
      hasTofaLinked: linked.has('tofa'),
      impersonatedBy: authUser.impersonatedBy,
    };
  });
};
