/**
 * Public API v2 - GET /watched-media
 *
 * The distinct set of media with recorded engagement, which /history cannot
 * give without paging the whole play log. Built for library-matching clients:
 * pull the watched set once, intersect it with a Radarr/Sonarr catalog on
 * tmdb/tvdb/imdb id, and badge the matches. Query body lives in
 * services/library/mediaWatchedService.ts alongside the probe that the
 * library UI uses, so both resolve watched state the same way.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getCacheService } from '../../services/cache.js';
import {
  listWatchedMedia,
  type WatchedMediaRecord,
} from '../../services/library/mediaWatchedService.js';
import { decodeCursor } from '../../utils/cursor.js';
import { cursorPage, STATS_WINDOWS, type CursorPage, type RouteConfig } from './shared.js';

const querySchema = z.object({
  media_type: z.enum(['movie', 'show', 'episode']),
  user_id: z.uuid().optional(),
  server_id: z.uuid().optional(),
  window: z.enum(['all_time', 'last_30', 'last_7']).default('all_time'),
  min_state: z.enum(['watched', 'partial']).default('watched'),
  cursor: z.string().optional(),
  // These rows carry a dozen small scalars against /history's ~40 fields of
  // codec and transcode detail, so the shared cap of 100 would turn a
  // whole-library pull into dozens of round trips for no payload reason.
  pageSize: z.coerce.number().int().positive().max(1000).default(100),
});

export function registerWatchedMediaRoutes(app: FastifyInstance, routeConfig: RouteConfig): void {
  app.get(
    '/watched-media',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const query = querySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');

      const {
        cursor,
        pageSize,
        media_type: kind,
        user_id: lensUserId,
        server_id: serverId,
        window: windowKey,
        min_state: minState,
      } = query.data;

      let cursorValue: { startedAt: Date; id: string } | null = null;
      if (cursor) {
        cursorValue = decodeCursor(cursor);
        if (!cursorValue || !z.uuid().safeParse(cursorValue.id).success) {
          return reply.badRequest('Invalid cursor');
        }
      }

      const windowDays = STATS_WINDOWS.find((w) => w.key === windowKey)?.days ?? null;
      const cache = getCacheService();
      const cacheKey = `watched-media:${kind}:${windowKey}:${minState}:${lensUserId ?? 'all'}:${serverId ?? 'all'}:${pageSize}:${cursor ?? 'first'}`;
      if (cache) {
        const cached = await cache.getMediaStats<CursorPage<WatchedMediaRecord>>(cacheKey);
        if (cached) return cached;
      }

      const { data, nextCursor } = await listWatchedMedia({
        kind,
        lensUserId: lensUserId ?? null,
        serverIds: serverId ? [serverId] : undefined,
        windowDays,
        minState,
        pageSize,
        cursorValue,
      });

      const response = cursorPage(data, nextCursor, pageSize);
      if (cache) await cache.setMediaStats(cacheKey, response);
      return response;
    }
  );
}
