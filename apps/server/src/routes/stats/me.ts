/**
 * GET /me - The viewer's own all-time moments: days watched, streaks, first play, biggest binge
 * and top genres. Every role gets their own accounts, never the server's.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  CACHE_TTL,
  REDIS_KEYS,
  statsQuerySchema,
  type MyStats,
  type MyTopTitleRow,
  type MyTopTitlesResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { ownScope, scopeFragment, type Scope } from '../../lib/scope.js';
import { MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';
import { countedSessionSql } from '../../db/sessions/rules.js';
import { buildMultiServerFragment, resolveServerIds } from '../../utils/serverFiltering.js';
import { getSetting } from '../../services/settings.js';
import {
  fetchEpisodeCounts,
  resolveWatchedStates,
} from '../../services/library/mediaWatchedService.js';
import { buildPosterOrderFragment } from '../library/catalog.js';
import { toShelfRowBase, type RawShelfRow } from '../library/shelves.js';

const DAY_MS = 86_400_000;
const TOP_TITLES_LIMIT = 10;

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/**
 * `days` are YYYY-MM-DD dates in the viewer's timezone. A streak that ended yesterday is still
 * current, so it does not read as broken before today's play.
 */
export function computeStreaks(
  days: string[],
  now: Date,
  timezone: string
): Pick<MyStats, 'daysWatched' | 'currentStreak' | 'longestStreak'> {
  const sorted = [...new Set(days)].map(dayNumber).sort((a, b) => a - b);
  let run = 0;
  let longestStreak = 0;
  let last: number | undefined;
  for (const day of sorted) {
    run = last !== undefined && day - last === 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    last = day;
  }
  const today = dayNumber(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  );
  const currentStreak = last !== undefined && today - last <= 1 ? run : 0;
  return { daysWatched: sorted.length, currentStreak, longestStreak };
}

async function computeMyStats(mine: Exclude<Scope, 'all'>, timezone: string): Promise<MyStats> {
  if (mine.serverUserIds.length === 0) {
    return {
      ...computeStreaks([], new Date(), timezone),
      totalWatchTimeMs: 0,
      firstPlay: null,
      biggestBinge: null,
      topGenres: [],
    };
  }

  // Local days, not UTC buckets: an 11 PM play in New York belongs to that evening. A day counts
  // toward the streaks on a movie or episode play that ran 2 minutes or was watched; watch time
  // sums every non-trailer session like the history aggregates do, so all time never reads below
  // last 30 days.
  const [days, first, binge, genres] = await Promise.all([
    db.execute(sql`
      SELECT to_char((started_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day,
             BOOL_OR(${countedSessionSql()} ${MEDIA_TYPE_SQL_FILTER}) AS counts,
             COALESCE(SUM(duration_ms) FILTER (WHERE media_type <> 'trailer'), 0)::bigint AS watched_ms
      FROM sessions
      WHERE true ${scopeFragment(mine)}
      GROUP BY 1
    `),
    db.execute(sql`
      SELECT media_title, grandparent_title, COALESCE(media_id, show_media_id) AS media_id, started_at
      FROM sessions
      WHERE ${countedSessionSql()} ${MEDIA_TYPE_SQL_FILTER} ${scopeFragment(mine)}
      ORDER BY started_at
      LIMIT 1
    `),
    db.execute(sql`
      SELECT show_title,
             MAX(show_media_id::text) AS show_media_id,
             to_char(day AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS binge_day,
             COUNT(DISTINCT rating_key)::int AS episodes
      FROM daily_content_engagement
      WHERE media_type = 'episode'
        AND valid_session_count > 0
        AND show_title IS NOT NULL ${scopeFragment(mine)}
      GROUP BY show_title, day
      HAVING COUNT(DISTINCT rating_key) > 1
      ORDER BY episodes DESC, binge_day DESC
      LIMIT 1
    `),
    // Same fold as routes/library/genres.ts: a merged copy's plays land on the canonical genres.
    db.execute(sql`
      WITH per_media AS (
        SELECT COALESCE(p.show_media_id, p.media_id) AS media_id,
               COUNT(DISTINCT p.chain_id) AS plays
        FROM user_media_plays_daily p
        WHERE p.counted ${scopeFragment(mine, sql`p.server_user_id`)}
        GROUP BY 1
      )
      SELECT genre, SUM(pm.plays)::int AS plays
      FROM per_media pm
      JOIN media pmr ON pmr.id = pm.media_id
      JOIN media canon ON canon.id = COALESCE(pmr.merged_into_id, pmr.id)
      , unnest(canon.genres) AS genre
      WHERE canon.media_type IN ('movie', 'show')
      GROUP BY genre
      ORDER BY plays DESC, genre
      LIMIT 5
    `),
  ]);

  const firstRow = first.rows[0] as
    | {
        media_title: string;
        grandparent_title: string | null;
        media_id: string | null;
        started_at: Date | string;
      }
    | undefined;
  const bingeRow = binge.rows[0] as
    | { show_title: string; show_media_id: string | null; binge_day: string; episodes: number }
    | undefined;

  const dayRows = days.rows as { day: string; counts: boolean; watched_ms: string }[];

  return {
    ...computeStreaks(
      dayRows.filter((r) => r.counts).map((r) => r.day),
      new Date(),
      timezone
    ),
    totalWatchTimeMs: dayRows.reduce((sum, r) => sum + Number(r.watched_ms), 0),
    firstPlay: firstRow
      ? {
          mediaTitle: firstRow.media_title,
          grandparentTitle: firstRow.grandparent_title,
          mediaId: firstRow.media_id,
          startedAt: new Date(firstRow.started_at).toISOString(),
        }
      : null,
    biggestBinge: bingeRow
      ? {
          showTitle: bingeRow.show_title,
          showMediaId: bingeRow.show_media_id,
          episodes: bingeRow.episodes,
          day: bingeRow.binge_day,
        }
      : null,
    topGenres: genres.rows as MyStats['topGenres'],
  };
}

interface RawTopTitleRow extends RawShelfRow {
  plays: number;
  watched_ms: string;
  episodes: number;
}

/**
 * The viewer's most watched movies and shows of the last 30 days, hydrated like a shelf row so
 * the web renders them with the same poster card as Browse. Watched state is the viewer's own.
 */
async function computeTopTitles(
  mine: Exclude<Scope, 'all'>,
  serverIds: string[] | undefined
): Promise<MyTopTitleRow[]> {
  if (mine.serverUserIds.length === 0) return [];

  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  const posterOrderFragment = buildPosterOrderFragment(await getSetting('preferredPosterServerId'));
  // Same canonical fold as the genres query above: a merged copy's plays land on the winner.
  const result = await db.execute(sql`
    WITH per_media AS (
      SELECT COALESCE(p.show_media_id, p.media_id) AS media_id,
             COUNT(DISTINCT p.chain_id) FILTER (WHERE p.counted)::int AS plays,
             COALESCE(SUM(p.watched_ms), 0)::bigint AS watched_ms,
             COUNT(DISTINCT p.media_id) FILTER (WHERE p.show_media_id IS NOT NULL AND p.counted)::int AS episodes
      FROM user_media_plays_daily p
      WHERE p.day >= now() - interval '30 days'
        ${scopeFragment(mine, sql`p.server_user_id`)}
        ${buildMultiServerFragment(serverIds, 'p.server_id')}
      GROUP BY 1
    )
    SELECT canon.id, canon.media_type, canon.title, canon.year, canon.genres,
           canon.normalized_title, canon.latest_added_at,
           SUM(pm.plays)::int AS plays,
           SUM(pm.watched_ms)::bigint AS watched_ms,
           SUM(pm.episodes)::int AS episodes,
      (SELECT json_agg(json_build_object(
          'serverId', li.server_id, 'addedAt', li.created_at,
          'videoResolution', li.video_resolution, 'fileSize', li.file_size,
          'versionCount', li.version_count)
          ORDER BY li.created_at DESC)
       FROM library_items li
       WHERE li.media_id = canon.id AND li.removed_at IS NULL ${serverFragmentLi}) AS servers,
      (SELECT json_build_object('thumbPath', li.thumb_path, 'dominantColor', li.dominant_color,
                                'serverId', li.server_id)
       FROM library_items li
       WHERE li.media_id = canon.id AND li.removed_at IS NULL AND li.thumb_path IS NOT NULL ${serverFragmentLi}
       ${posterOrderFragment} LIMIT 1) AS poster_copy
    FROM per_media pm
    JOIN media pmr ON pmr.id = pm.media_id
    JOIN media canon ON canon.id = COALESCE(pmr.merged_into_id, pmr.id)
    WHERE canon.media_type IN ('movie', 'show')
      AND EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.media_id = canon.id AND li.removed_at IS NULL ${serverFragmentLi}
      )
    GROUP BY canon.id
    HAVING SUM(pm.plays) > 0
    ORDER BY watched_ms DESC, plays DESC
    LIMIT ${TOP_TITLES_LIMIT}
  `);
  const rows = result.rows as unknown as RawTopTitleRow[];
  if (rows.length === 0) return [];

  const showIds = rows.filter((row) => row.media_type === 'show').map((row) => row.id);
  const watchedStates = await resolveWatchedStates({
    movieIds: rows.filter((row) => row.media_type === 'movie').map((row) => row.id),
    showIds,
    serverIds,
    lensUserId: mine.userId,
    episodeCounts: await fetchEpisodeCounts(showIds, serverIds),
  });

  return rows.map((row, index) => ({
    ...toShelfRowBase(row),
    watchedState: watchedStates.get(row.id) ?? 'unwatched',
    plays: row.plays,
    watchTimeMs: Number(row.watched_ms),
    episodes: row.media_type === 'show' ? row.episodes : null,
    rank: index + 1,
  }));
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/me/titles',
    { preHandler: [app.requirePermission('stats', 'read')] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { userId } = request.user;
      const serverIds = resolveServerIds(request.user, query.data.serverId, query.data.serverIds);
      const serverKey = serverIds ? [...serverIds].sort().join(',') : 'all';

      const cacheKey = `${REDIS_KEYS.MY_STATS}:member:${userId}:titles:${serverKey}`;
      const cached = await app.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as MyTopTitlesResponse;

      const scope = await ownScope(userId, request.scope);
      const response: MyTopTitlesResponse = { data: await computeTopTitles(scope, serverIds) };
      await app.redis.setex(cacheKey, CACHE_TTL.MY_STATS, JSON.stringify(response));
      return response;
    }
  );

  app.get(
    '/me',
    { preHandler: [app.requirePermission('stats', 'read')] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const timezone = query.data.timezone ?? 'UTC';
      const { userId } = request.user;

      // The member segment for every role, so clearScope takes the owner's and admin's too.
      const cacheKey = `${REDIS_KEYS.MY_STATS}:member:${userId}:${timezone}`;
      const cached = await app.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as MyStats;

      const stats = await computeMyStats(await ownScope(userId, request.scope), timezone);
      await app.redis.setex(cacheKey, CACHE_TTL.MY_STATS, JSON.stringify(stats));
      return stats;
    }
  );
};
