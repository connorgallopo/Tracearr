/**
 * Genres aggregate endpoint
 *
 * GET /genres - Per-genre item counts and all-time engagement for the Media
 * genres page. itemCount is canonical-grain (active scoped copies, unnested
 * by the canonical media's genres); plays/watchTimeMs come from the all-time
 * cagg, alias-safe (a merged loser's plays land on the canonical row's genre
 * buckets). A member's plays and watch time are their own. Cached per
 * (sorted serverIds, type, member).
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  serverIdsQuerySchema,
  REDIS_KEYS,
  CACHE_TTL,
  type GenreRow,
  type GenresResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { libraryFragment, memberCacheSegment, scopeFragment, type Scope } from '../../lib/scope.js';
import { buildLibraryCacheKey } from './utils.js';

const genresQuerySchema = z.object({
  type: z.enum(['movie', 'show']),
  serverIds: serverIdsQuerySchema,
});

interface RawItemCountRow {
  genre: string;
  item_count: string | number;
}

interface RawEngagementRow {
  genre: string;
  plays: string | number;
  watch_time_ms: string | number;
}

async function fetchItemCounts(
  type: 'movie' | 'show',
  serverIds: string[] | undefined,
  scope: Scope
): Promise<Map<string, number>> {
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const result = await db.execute(sql`
    SELECT genre, COUNT(DISTINCT m.id)::bigint AS item_count
    FROM media m, unnest(m.genres) AS genre
    WHERE m.merged_into_id IS NULL
      AND m.media_type = ${type}
      AND EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi}
      )
    GROUP BY genre
  `);
  const counts = new Map<string, number>();
  for (const row of result.rows as unknown as RawItemCountRow[]) {
    counts.set(row.genre, Number(row.item_count));
  }
  return counts;
}

/**
 * All-time alias-safe engagement per genre: cagg rows are pre-grouped per
 * media (pm), then joined to their recorded media (pmr) and resolved to the
 * canonical row (canon) via merged_into_id - a merged loser's plays land on
 * the canonical row's genre buckets, never the loser's own (possibly
 * different) genres.
 */
async function fetchEngagement(
  type: 'movie' | 'show',
  serverIds: string[] | undefined,
  scope: Scope
): Promise<Map<string, { plays: number; watchTimeMs: number }>> {
  const mediaCol = type === 'movie' ? sql`p.media_id` : sql`p.show_media_id`;
  const showGuard = type === 'show' ? sql`AND p.show_media_id IS NOT NULL` : sql``;
  const serverFragmentP = buildMultiServerFragment(serverIds, 'p.server_id');
  const scopeFragmentP = scopeFragment(scope, sql`p.server_user_id`);
  const result = await db.execute(sql`
    WITH per_media AS (
      SELECT ${mediaCol} AS media_id,
             COUNT(DISTINCT p.chain_id) FILTER (WHERE p.counted) AS plays,
             SUM(p.watched_ms) AS watch_time_ms
      FROM user_media_plays_daily p
      WHERE ${mediaCol} IN (
        SELECT pmr.id FROM media pmr
        JOIN media canon ON canon.id = COALESCE(pmr.merged_into_id, pmr.id)
        WHERE canon.media_type = ${type}
      ) ${showGuard} ${serverFragmentP} ${scopeFragmentP}
      GROUP BY ${mediaCol}
    )
    SELECT genre,
           SUM(pm.plays)::bigint AS plays,
           SUM(pm.watch_time_ms)::bigint AS watch_time_ms
    FROM per_media pm
    JOIN media pmr ON pmr.id = pm.media_id
    LEFT JOIN media canon ON canon.id = COALESCE(pmr.merged_into_id, pmr.id)
    , unnest(canon.genres) AS genre
    WHERE canon.media_type = ${type}
    GROUP BY genre
  `);
  const engagement = new Map<string, { plays: number; watchTimeMs: number }>();
  for (const row of result.rows as unknown as RawEngagementRow[]) {
    engagement.set(row.genre, {
      plays: Number(row.plays),
      watchTimeMs: Number(row.watch_time_ms),
    });
  }
  return engagement;
}

async function computeGenres(
  type: 'movie' | 'show',
  serverIds: string[] | undefined,
  scope: Scope
): Promise<GenreRow[]> {
  const [itemCounts, engagement] = await Promise.all([
    fetchItemCounts(type, serverIds, scope),
    fetchEngagement(type, serverIds, scope),
  ]);

  const genres = new Set([...itemCounts.keys(), ...engagement.keys()]);
  const rows: GenreRow[] = [...genres].map((genre) => ({
    genre,
    itemCount: itemCounts.get(genre) ?? 0,
    plays: engagement.get(genre)?.plays ?? 0,
    watchTimeMs: engagement.get(genre)?.watchTimeMs ?? 0,
  }));

  return rows.sort((a, b) => a.genre.localeCompare(b.genre));
}

export const libraryGenresRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /genres - Per-genre item counts and all-time plays/watch time,
   * scoped to the caller's accessible servers, cached per (serverIds, type, member).
   */
  app.get<{ Querystring: Record<string, unknown> }>(
    '/genres',
    { preHandler: [app.requirePermission('media', 'read')] },
    async (request, reply) => {
      const query = genresQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { type, serverIds } = query.data;
      const authUser = request.user;

      // Guard: server scope, fail-closed.
      const resolvedIds = resolveServerIds(authUser, undefined, serverIds);

      const serverCacheKey = resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all';
      const cacheKey = `${buildLibraryCacheKey(REDIS_KEYS.LIBRARY_GENRES, serverCacheKey, type)}${memberCacheSegment(request.scope)}`;

      let data: GenreRow[] | null = null;
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          data = JSON.parse(cached) as GenreRow[];
        } catch {
          data = null;
        }
      }
      if (!data) {
        data = await computeGenres(type, resolvedIds, request.scope);
        await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_GENRES, JSON.stringify(data));
      }

      const response: GenresResponse = { data };
      return response;
    }
  );
};
