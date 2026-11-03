/**
 * Public API v2 - GET /top-media
 *
 * Movies or shows ranked by plays, watch time or viewers over the last `days` UTC days, for
 * clients that build collections from what people watch. Each row's numbers equal the title's
 * /media/{ref}/stats for the same window and server. Pages are computed per request: the key
 * space (days x server x sort) is too wide to cache in a Redis that runs noeviction for BullMQ.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listTopMedia } from '../library/queries.js';
import { decodeRankCursor } from '../../utils/cursor.js';
import { cursorPage, type RouteConfig } from './shared.js';

const querySchema = z.object({
  media_type: z.enum(['movie', 'show']),
  days: z.coerce.number().int().min(1).max(365).default(30),
  server_id: z.uuid().optional(),
  sort: z.enum(['plays', 'watch_time', 'viewers']).default('plays'),
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().positive().max(1000).default(100),
});

export function registerTopMediaRoutes(app: FastifyInstance, routeConfig: RouteConfig): void {
  app.get(
    '/top-media',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const query = querySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');

      const { cursor, pageSize, media_type: kind, days, server_id: serverId, sort } = query.data;

      let after: { value: number; id: string } | null = null;
      if (cursor) {
        after = decodeRankCursor(cursor);
        if (!after || !z.uuid().safeParse(after.id).success) {
          return reply.badRequest('Invalid cursor');
        }
      }

      const { data, nextCursor } = await listTopMedia({
        kind,
        days,
        serverIds: serverId ? [serverId] : undefined,
        sort,
        pageSize,
        after,
      });

      return cursorPage(data, nextCursor, pageSize);
    }
  );
}
