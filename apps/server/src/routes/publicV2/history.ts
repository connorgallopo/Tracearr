/**
 * Public API v2 - GET /history
 */

import { booleanStringSchema } from '@tracearr/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { historyMediaTypeDefault } from '../../db/sessions/rules.js';
import {
  buildMediaScope,
  resolveCanonicalMediaByRef,
  scopeSessionConditions,
} from '../../services/library/mediaDetailService.js';
import { decodeCursor } from '../../utils/cursor.js';
import { cursorPage, cursorPaginationSchema, runHistoryPage, type RouteConfig } from './shared.js';

export function registerHistoryRoutes(app: FastifyInstance, routeConfig: RouteConfig): void {
  /**
   * GET /history - Watch history as plays (resume chains) with media identity
   *
   * The cursor pages at chain grain, never over raw session rows: a chain's
   * segments can straddle any raw-row boundary, so chains are collected first
   * and the keyset predicate applies to (chain_started_at, chain_id).
   */
  app.get(
    '/history',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const querySchema = cursorPaginationSchema.extend({
        user_id: z.uuid().optional(),
        server_id: z.uuid().optional(),
        media_id: z.uuid().optional(),
        rating_key: z.string().min(1).max(255).optional(),
        imdb_id: z.string().min(1).max(20).optional(),
        tmdb_id: z.coerce.number().int().optional(),
        tvdb_id: z.coerce.number().int().optional(),
        media_type: z
          .enum(['movie', 'episode', 'track', 'live', 'photo', 'trailer', 'unknown'])
          .optional(),
        watched: booleanStringSchema.optional(),
        since: z.coerce.date().optional(),
        until: z.coerce.date().optional(),
      });

      const query = querySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { cursor, pageSize, since, until, watched } = query.data;
      const {
        user_id: userId,
        server_id: serverId,
        media_id: mediaId,
        rating_key: ratingKey,
        imdb_id: imdbId,
        tmdb_id: tmdbId,
        tvdb_id: tvdbId,
        media_type: mediaType,
      } = query.data;

      let cursorValue: { startedAt: Date; id: string } | null = null;
      if (cursor) {
        cursorValue = decodeCursor(cursor);
        if (!cursorValue || !z.uuid().safeParse(cursorValue.id).success) {
          return reply.badRequest('Invalid cursor');
        }
      }
      if (since && until && since > until) {
        return reply.badRequest('since must be before or equal to until');
      }

      const conditions: SQL[] = [];
      if (serverId) conditions.push(sql`s.server_id = ${serverId}`);
      if (userId) {
        conditions.push(
          sql`s.server_user_id IN (SELECT su.id FROM server_users su WHERE su.user_id = ${userId})`
        );
      }
      if (mediaId) {
        // Show/season ids match on show_media_id, not media_id - same scope as /media/{ref}/history.
        const canonical = await resolveCanonicalMediaByRef(mediaId);
        const scope = canonical ? await buildMediaScope(canonical) : null;
        if (!scope) {
          conditions.push(sql`false`);
        } else {
          conditions.push(...scopeSessionConditions(scope));
        }
      }
      if (ratingKey) conditions.push(sql`s.rating_key = ${ratingKey}`);
      if (imdbId) conditions.push(sql`s.imdb_id = ${imdbId}`);
      if (tmdbId !== undefined) conditions.push(sql`s.tmdb_id = ${tmdbId}`);
      if (tvdbId !== undefined) conditions.push(sql`s.tvdb_id = ${tvdbId}`);
      conditions.push(mediaType ? sql`s.media_type = ${mediaType}` : historyMediaTypeDefault());
      if (since) conditions.push(sql`s.started_at >= ${since}`);
      if (until) conditions.push(sql`s.started_at <= ${until}`);

      const { data, nextCursor } = await runHistoryPage(
        conditions,
        pageSize,
        cursorValue,
        watched,
        { since, until }
      );
      return cursorPage(data, nextCursor, pageSize);
    }
  );
}
