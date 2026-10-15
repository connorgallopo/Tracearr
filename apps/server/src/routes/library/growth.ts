/**
 * Library Growth Route
 *
 * GET /growth - Time-series library growth data points
 *
 * Uses library_stats_daily continuous aggregate for efficient growth tracking.
 * This avoids lock exhaustion from scanning 1000+ raw library_snapshots chunks.
 *
 * Each returned data point carries a serverId discriminator so the frontend can
 * aggregate across servers by media type for the stacked view, or split by server.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  TIME_MS,
  libraryGrowthQuerySchema,
  type LibraryGrowthQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { libraryCacheSegment, libraryFragment } from '../../lib/scope.js';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Single data point in growth timeline (per media type, per server) */
interface GrowthDataPoint {
  day: string;
  total: number;
  additions: number;
  serverId: string;
}

/** Library growth response shape with separate series per media type */
interface LibraryGrowthResponse {
  period: string;
  movies: GrowthDataPoint[];
  episodes: GrowthDataPoint[];
  music: GrowthDataPoint[];
}

/**
 * Calculate start date based on period string.
 * Returns null for 'all' which triggers dynamic earliest date lookup.
 */
function getStartDate(period: '7d' | '30d' | '90d' | '1y' | 'all'): Date | null {
  const now = new Date();
  switch (period) {
    case '7d':
      return new Date(now.getTime() - 7 * TIME_MS.DAY);
    case '30d':
      return new Date(now.getTime() - 30 * TIME_MS.DAY);
    case '90d':
      return new Date(now.getTime() - 90 * TIME_MS.DAY);
    case '1y':
      return new Date(now.getTime() - 365 * TIME_MS.DAY);
    case 'all':
      return null;
  }
}

export const libraryGrowthRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /growth - Library growth timeline
   *
   * Returns time-series data from library_stats_daily continuous aggregate.
   * Rows are grouped by (day, server_id) so the frontend receives a serverId
   * discriminator on every data point.
   */
  app.get<{ Querystring: LibraryGrowthQueryInput }>(
    '/growth',
    { preHandler: [app.requirePermission('media', 'read')] },
    async (request, reply) => {
      const query = libraryGrowthQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        serverIds,
        libraryId,
        period,
        startDate: rawStartDate,
        endDate: rawEndDate,
        timezone,
      } = query.data;
      const authUser = request.user;
      const tz = timezone ?? 'UTC';

      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
      const serverFilter = libraryFragment(resolvedIds, request.scope, 'lsd');

      // Optional library filter
      const libraryFilter = libraryId ? sql`AND lsd.library_id = ${libraryId}` : sql``;

      // Both present -> overrides the period token (custom/day windows).
      const hasCustomRange = Boolean(rawStartDate && rawEndDate);

      // Build cache key - include sorted server IDs so order doesn't cause misses
      const serverCacheKey =
        (resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all') +
        libraryCacheSegment(request.scope);
      const periodCacheKey = hasCustomRange ? `custom:${rawStartDate}:${rawEndDate}` : period;
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_GROWTH,
        serverCacheKey,
        periodCacheKey,
        tz
      );
      const fullCacheKey = libraryId ? `${cacheKey}:${libraryId}` : cacheKey;

      const cached = await app.redis.get(fullCacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryGrowthResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Calculate date range
      let effectiveStartDate: Date;
      let endDate: Date;
      if (rawStartDate && rawEndDate) {
        effectiveStartDate = new Date(rawStartDate);
        endDate = new Date(rawEndDate);
      } else {
        endDate = new Date();
        const startDate = getStartDate(period);
        // For 'all' period, find the earliest date from library_stats_daily aggregate
        if (startDate) {
          effectiveStartDate = startDate;
        } else {
          const earliestResult = await db.execute(sql`
            SELECT MIN(day)::date AS earliest
            FROM library_stats_daily lsd
            WHERE 1=1
              ${serverFilter}
              ${libraryFilter}
          `);
          const earliest = (earliestResult.rows[0] as { earliest: string | null })?.earliest;
          effectiveStartDate = earliest ? new Date(earliest) : new Date('2020-01-01');
        }
      }

      // Query from library_stats_daily continuous aggregate.
      // GROUP BY (day, server_id) so every row carries a serverId discriminator.
      // The frontend aggregates across servers for the stacked view.
      //
      // A server that skips a sync day has no row in daily_by_server for that day.
      // If we only emitted the rows that exist, summing across servers on the
      // frontend would dip on days a server didn't report - not because the
      // library shrank, just because one server's contribution went missing.
      // `grid` covers every (day, server) combo that's actually in scope - the
      // union of days any scoped server reported, crossed with the scoped
      // servers - and `filled` carries each server's last known totals forward
      // into its own gaps. For a single server this grid is identical to that
      // server's own days, so single-server output is unchanged.
      const result = await db.execute(sql`
        WITH day_scope AS (
          SELECT DISTINCT lsd.day::date AS day
          FROM library_stats_daily lsd
          WHERE lsd.day >= ${effectiveStartDate.toISOString()}::date
            AND lsd.day <= ${endDate.toISOString()}::date
            ${serverFilter}
            ${libraryFilter}
        ),
        server_bounds AS (
          -- Bound each server's grid to start at its own first reported day, so a
          -- server never gets phantom zero rows (then a fake "jump" on its real
          -- first day) for dates before it ever synced.
          SELECT lsd.server_id, MIN(lsd.day)::date AS first_day
          FROM library_stats_daily lsd
          WHERE lsd.day >= ${effectiveStartDate.toISOString()}::date
            AND lsd.day <= ${endDate.toISOString()}::date
            ${serverFilter}
            ${libraryFilter}
          GROUP BY lsd.server_id
        ),
        grid AS (
          SELECT ds.day, sb.server_id
          FROM day_scope ds
          JOIN server_bounds sb ON ds.day >= sb.first_day
        ),
        daily_by_server AS (
          SELECT
            lsd.day::date AS day,
            lsd.server_id,
            COALESCE(SUM(lsd.movie_count), 0)::int AS movies,
            COALESCE(SUM(lsd.episode_count), 0)::int AS episodes,
            COALESCE(SUM(lsd.music_count), 0)::int AS music
          FROM library_stats_daily lsd
          WHERE lsd.day >= ${effectiveStartDate.toISOString()}::date
            AND lsd.day <= ${endDate.toISOString()}::date
            ${serverFilter}
            ${libraryFilter}
          GROUP BY lsd.day::date, lsd.server_id
        ),
        filled AS (
          SELECT
            g.day,
            g.server_id,
            COALESCE(dbs.movies, (
              SELECT d2.movies FROM daily_by_server d2
              WHERE d2.server_id = g.server_id AND d2.day < g.day
              ORDER BY d2.day DESC LIMIT 1
            ), 0)::int AS movies,
            COALESCE(dbs.episodes, (
              SELECT d2.episodes FROM daily_by_server d2
              WHERE d2.server_id = g.server_id AND d2.day < g.day
              ORDER BY d2.day DESC LIMIT 1
            ), 0)::int AS episodes,
            COALESCE(dbs.music, (
              SELECT d2.music FROM daily_by_server d2
              WHERE d2.server_id = g.server_id AND d2.day < g.day
              ORDER BY d2.day DESC LIMIT 1
            ), 0)::int AS music
          FROM grid g
          LEFT JOIN daily_by_server dbs ON dbs.day = g.day AND dbs.server_id = g.server_id
        ),
        with_additions AS (
          SELECT
            day,
            server_id,
            movies,
            episodes,
            music,
            GREATEST(0,
              movies - COALESCE(LAG(movies) OVER (PARTITION BY server_id ORDER BY day), movies)
            )::int AS movie_adds,
            GREATEST(0,
              episodes - COALESCE(LAG(episodes) OVER (PARTITION BY server_id ORDER BY day), episodes)
            )::int AS episode_adds,
            GREATEST(0,
              music - COALESCE(LAG(music) OVER (PARTITION BY server_id ORDER BY day), music)
            )::int AS music_adds
          FROM filled
        )
        SELECT
          day::text,
          server_id,
          movies,
          episodes,
          music,
          movie_adds,
          episode_adds,
          music_adds
        FROM with_additions
        ORDER BY day ASC, server_id
      `);

      const rows = result.rows as Array<{
        day: string;
        server_id: string;
        movies: number;
        episodes: number;
        music: number;
        movie_adds: number;
        episode_adds: number;
        music_adds: number;
      }>;

      // Build separate arrays for each media type - include serverId on every point
      const movies: GrowthDataPoint[] = [];
      const episodes: GrowthDataPoint[] = [];
      const music: GrowthDataPoint[] = [];

      for (const row of rows) {
        if (row.movies > 0 || row.movie_adds > 0) {
          movies.push({
            day: row.day,
            total: row.movies,
            additions: row.movie_adds,
            serverId: row.server_id,
          });
        }

        if (row.episodes > 0 || row.episode_adds > 0) {
          episodes.push({
            day: row.day,
            total: row.episodes,
            additions: row.episode_adds,
            serverId: row.server_id,
          });
        }

        if (row.music > 0 || row.music_adds > 0) {
          music.push({
            day: row.day,
            total: row.music,
            additions: row.music_adds,
            serverId: row.server_id,
          });
        }
      }

      const response: LibraryGrowthResponse = {
        period: hasCustomRange ? 'custom' : period,
        movies,
        episodes,
        music,
      };

      await app.redis.setex(fullCacheKey, CACHE_TTL.LIBRARY_GROWTH, JSON.stringify(response));

      return response;
    }
  );
};
