/**
 * Content Statistics Routes
 *
 * GET /top-content - Top movies and shows by play count
 * GET /libraries - Per-library plays + watch time ranking (last 30 days)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { statsQuerySchema, serverIdFilterSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveDateRange } from './utils.js';
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { scopedServerFragment, viewScope } from '../../lib/scope.js';
import { MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';
import { countedSessionSql } from '../../db/sessions/rules.js';

export const contentRoutes: FastifyPluginAsync = async (app) => {
  const readStats = { preHandler: [app.requirePermission('stats', 'read')] };
  /**
   * GET /top-content - Top movies and shows by play count
   *
   * Returns separate arrays for movies and TV shows:
   * - Single-server: grouped by raw title (movies) / grandparent_title (shows),
   *   matching main exactly.
   * - Multi-server: grouped by canonical media identity - a merged-loser id
   *   folds to its winner via media.merged_into_id (mirrors value_rollup's
   *   alias fold in catalog.ts) - falling back to a normalized title (+ year
   *   for movies, to keep remakes apart) for sessions stamped before identity
   *   tracking existed, so the same movie/show on two servers counts once.
   */
  app.get('/top-content', readStats, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = scopedServerFragment(resolvedIds, await viewScope(request));
    const singleServer = resolvedIds?.length === 1;

    // For all-time queries, we need a base WHERE clause
    const startDateFilter = dateRange.start ? sql`started_at >= ${dateRange.start}` : sql`true`;
    const customEndFilter = period === 'custom' ? sql`AND started_at < ${dateRange.end}` : sql``;

    // Run both queries in parallel for better performance
    const [moviesResult, showsResult] = await Promise.all([
      // Query top movies (media_type = 'movie')
      singleServer
        ? db.execute(sql`
          SELECT
            media_title,
            year,
            COUNT(DISTINCT COALESCE(reference_id, id))::int as play_count,
            COALESCE(SUM(duration_ms), 0)::bigint as total_watch_ms,
            MAX(thumb_path) as thumb_path,
            MAX(server_id::text) as server_id,
            MAX(rating_key) as rating_key
          FROM sessions
          WHERE ${startDateFilter} AND media_type = 'movie'
          ${customEndFilter}
          ${serverFilter}
          GROUP BY media_title, year
          ORDER BY play_count DESC
          LIMIT 10
        `)
        : db.execute(sql`
          WITH movie_base AS (
            SELECT
              s.media_title,
              s.year,
              s.rating_key,
              s.server_id,
              s.reference_id,
              s.id,
              s.duration_ms,
              s.thumb_path,
              COALESCE(am.merged_into_id, s.media_id) AS canonical_id
            FROM sessions s
            LEFT JOIN media am ON am.id = s.media_id
            WHERE ${startDateFilter} AND s.media_type = 'movie'
              AND (am.id IS NULL OR am.media_type = 'movie')
            ${customEndFilter}
            ${serverFilter}
          ),
          with_key AS (
            SELECT
              mb.*,
              -- Raw-title tier (mirrors the show query below) catches non-Latin titles the ASCII strip empties out.
              COALESCE(
                mb.canonical_id::text,
                'title:' || NULLIF(LOWER(REGEXP_REPLACE(COALESCE(mb.media_title, ''), '[^a-zA-Z0-9]', '', 'g')), '') || ':' || COALESCE(mb.year::text, ''),
                'raw:' || NULLIF(mb.media_title, ''),
                'rk:' || mb.server_id::text || ':' || NULLIF(mb.rating_key, '')
              ) AS dedup_key
            FROM movie_base mb
          )
          SELECT
            MAX(media_title) as media_title,
            MAX(year) as year,
            COUNT(DISTINCT COALESCE(reference_id, id))::int as play_count,
            COALESCE(SUM(duration_ms), 0)::bigint as total_watch_ms,
            MAX(thumb_path) as thumb_path,
            MAX(server_id::text) as server_id,
            MAX(rating_key) as rating_key
          FROM with_key
          WHERE dedup_key IS NOT NULL -- unidentifiable rows are excluded, not grouped as one phantom row
          GROUP BY dedup_key
          ORDER BY play_count DESC
          LIMIT 10
        `),
      // Query top TV shows (aggregate by series using grandparent_title)
      singleServer
        ? db.execute(sql`
          SELECT
            grandparent_title,
            MAX(year) as year,
            COUNT(DISTINCT COALESCE(reference_id, id))::int as play_count,
            COUNT(DISTINCT media_title)::int as episode_count,
            COALESCE(SUM(duration_ms), 0)::bigint as total_watch_ms,
            MAX(thumb_path) as thumb_path,
            MAX(server_id::text) as server_id,
            MAX(rating_key) as rating_key
          FROM sessions
          WHERE ${startDateFilter} AND media_type = 'episode' AND grandparent_title IS NOT NULL
          ${customEndFilter}
          ${serverFilter}
          GROUP BY grandparent_title
          ORDER BY play_count DESC
          LIMIT 10
        `)
        : db.execute(sql`
          WITH episode_base AS (
            SELECT
              s.grandparent_title,
              s.media_title,
              s.year,
              s.rating_key,
              s.server_id,
              s.reference_id,
              s.id,
              s.duration_ms,
              s.thumb_path,
              COALESCE(am.merged_into_id, s.show_media_id) AS canonical_show_id
            FROM sessions s
            LEFT JOIN media am ON am.id = s.show_media_id
            WHERE ${startDateFilter} AND s.media_type = 'episode' AND s.grandparent_title IS NOT NULL
              AND (am.id IS NULL OR am.media_type = 'show')
            ${customEndFilter}
            ${serverFilter}
          ),
          with_key AS (
            SELECT
              eb.*,
              COALESCE(
                eb.canonical_show_id::text,
                'title:' || NULLIF(LOWER(REGEXP_REPLACE(eb.grandparent_title, '[^a-zA-Z0-9]', '', 'g')), ''),
                'raw:' || NULLIF(eb.grandparent_title, '')
              ) AS dedup_key
            FROM episode_base eb
          )
          SELECT
            MAX(grandparent_title) as grandparent_title,
            MAX(year) as year,
            COUNT(DISTINCT COALESCE(reference_id, id))::int as play_count,
            COUNT(DISTINCT media_title)::int as episode_count,
            COALESCE(SUM(duration_ms), 0)::bigint as total_watch_ms,
            MAX(thumb_path) as thumb_path,
            MAX(server_id::text) as server_id,
            MAX(rating_key) as rating_key
          FROM with_key
          WHERE dedup_key IS NOT NULL -- unidentifiable rows are excluded, not grouped as one phantom row
          GROUP BY dedup_key
          ORDER BY play_count DESC
          LIMIT 10
        `),
    ]);

    const movies = (
      moviesResult.rows as {
        media_title: string;
        year: number | null;
        play_count: number;
        total_watch_ms: string;
        thumb_path: string | null;
        server_id: string | null;
        rating_key: string | null;
      }[]
    ).map((m) => ({
      title: m.media_title,
      type: 'movie' as const,
      year: m.year,
      playCount: m.play_count,
      watchTimeHours: Math.round((Number(m.total_watch_ms) / (1000 * 60 * 60)) * 10) / 10,
      thumbPath: m.thumb_path,
      serverId: m.server_id,
      ratingKey: m.rating_key,
    }));

    const shows = (
      showsResult.rows as {
        grandparent_title: string;
        year: number | null;
        play_count: number;
        episode_count: number;
        total_watch_ms: string;
        thumb_path: string | null;
        server_id: string | null;
        rating_key: string | null;
      }[]
    ).map((s) => ({
      title: s.grandparent_title, // Series name
      type: 'episode' as const,
      year: s.year,
      playCount: s.play_count,
      episodeCount: s.episode_count, // Number of unique episodes watched
      watchTimeHours: Math.round((Number(s.total_watch_ms) / (1000 * 60 * 60)) * 10) / 10,
      thumbPath: s.thumb_path,
      serverId: s.server_id,
      ratingKey: s.rating_key,
    }));

    return { movies, shows };
  });

  /**
   * GET /libraries - Per-library plays + watch time ranking (last 30 days)
   *
   * Joins engagement-qualifying sessions (>= 2 min) to their library_items row
   * on (rating_key, server_id) and rolls up by (server_id, library_id).
   * Ordered by plays desc. Libraries with no qualifying plays in the window
   * are omitted.
   */
  app.get('/libraries', readStats, async (request, reply) => {
    const query = serverIdFilterSchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { serverId, serverIds } = query.data;
    const authUser = request.user;
    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = scopedServerFragment(resolvedIds, request.scope);

    const result = await db.execute(sql`
      WITH recent_sessions AS (
        SELECT rating_key, server_id, reference_id, id, duration_ms
        FROM sessions
        WHERE started_at >= now() - interval '30 days'
          AND ${countedSessionSql()}
          ${MEDIA_TYPE_SQL_FILTER}
          ${serverFilter}
      )
      SELECT
        li.server_id::text AS server_id,
        li.library_id,
        COUNT(DISTINCT COALESCE(rs.reference_id, rs.id))::int AS plays,
        COALESCE(SUM(rs.duration_ms), 0)::bigint AS watch_time_ms
      FROM recent_sessions rs
      JOIN library_items li ON li.rating_key = rs.rating_key AND li.server_id = rs.server_id
      WHERE li.removed_at IS NULL
      GROUP BY li.server_id, li.library_id
      ORDER BY plays DESC
    `);

    const data = (
      result.rows as {
        server_id: string;
        library_id: string;
        plays: number;
        watch_time_ms: string;
      }[]
    ).map((row) => ({
      serverId: row.server_id,
      libraryId: row.library_id,
      plays: row.plays,
      watchTimeMs: Number(row.watch_time_ms),
    }));

    return { data };
  });
};
