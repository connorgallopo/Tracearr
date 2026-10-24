/**
 * Library Watch Patterns Route
 *
 * GET /patterns - Binge behavior, peak times and the viewing trend within the selected window.
 *
 * Reads raw sessions, since hour of day and gaps between episodes need timestamps. A session
 * belongs to its media identity, not the library row it was played from, so plays of a
 * re-added or removed title still count. Binge shows are keyed by show identity (a merged
 * alias folds into its winner), so one show on two servers is one row and two shows that
 * share a title stay apart. `primaryServerId` is the server with the most episodes watched.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  TIME_MS,
  libraryPatternsQuerySchema,
  type BingeShow,
  type HourlyDistribution,
  type LibraryPatternsQueryInput,
  type PatternsResponse,
  type TrendBucket,
  type TrendPoint,
} from '@tracearr/shared';
import { countedSessionSql, playCountSql } from '../../db/sessions/rules.js';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey, ceilToUtcDay, resolveLibraryWindow } from './utils.js';

interface RawBingeRow {
  show_media_id: string;
  show_title: string;
  primary_server_id: string;
  thumb_path: string | null;
  total_episode_watches: string;
  consecutive_episodes: string;
  consecutive_pct: string | null;
  avg_gap_minutes: string | null;
  max_episodes_in_one_day: string | null;
  binge_score: string;
  server_ids: string[];
}

interface RawHourlyRow {
  hour: string;
  watch_count: string;
  total_watch_ms: string;
  pct_of_total: string;
}

interface RawTrendRow {
  start: string;
  watch_count: string;
  total_watch_hours: string;
}

interface RawSummaryRow {
  total_watch_sessions: string;
  avg_sessions_per_day: string;
  binge_sessions_pct: string;
}

type Window = { startDate: Date | null; endDate: Date; lastDay: Date };

function trendBucket(window: Window): TrendBucket {
  if (!window.startDate) return 'month';
  const days = (window.endDate.getTime() - window.startDate.getTime()) / TIME_MS.DAY;
  return days <= 31 ? 'day' : days <= 183 ? 'week' : 'month';
}

// Counted sessions with a media identity, started within the window, on the selected servers
// and, when one is given, in a library that holds that title. Sessions are aliased sess.
function sessionScopeSql(
  window: Window,
  serverIds: string[] | undefined,
  libraryId: string | undefined
): SQL {
  const lower = window.startDate
    ? sql`AND sess.started_at >= ${window.startDate}::timestamptz`
    : sql``;
  const library = libraryId
    ? sql`AND EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.media_id = sess.media_id AND li.library_id = ${libraryId}
          AND li.server_id = sess.server_id
      )`
    : sql``;
  return sql`${countedSessionSql('sess')} AND sess.media_id IS NOT NULL
    ${lower} AND sess.started_at < ${window.endDate}::timestamptz
    ${buildMultiServerFragment(serverIds, 'sess.server_id')}
    ${library}`;
}

// Gaps only see sessions inside the window, so a binge that began before it starts fresh.
function buildBingeQuery(scope: SQL, bingeThreshold: number, limit: number): SQL {
  return sql`
    WITH eps AS (
      SELECT sess.server_user_id, sess.server_id, sess.media_id, sess.started_at, sess.thumb_path,
        COALESCE(sh.merged_into_id, sess.show_media_id) AS show_id,
        EXTRACT(EPOCH FROM (sess.started_at - LAG(sess.stopped_at) OVER (
          PARTITION BY sess.server_user_id, COALESCE(sh.merged_into_id, sess.show_media_id)
          ORDER BY sess.started_at
        ))) / 60 AS gap_minutes
      FROM sessions sess
      LEFT JOIN media sh ON sh.id = sess.show_media_id
      WHERE ${scope}
        AND sess.media_type = 'episode'
        AND sess.show_media_id IS NOT NULL
        AND sess.stopped_at IS NOT NULL
    ),
    per_user AS (
      SELECT server_user_id, show_id,
        COUNT(*) AS total_episode_watches,
        COUNT(*) FILTER (WHERE gap_minutes <= 30) AS consecutive_episodes,
        100.0 * COUNT(*) FILTER (WHERE gap_minutes <= 30) / NULLIF(COUNT(*) - 1, 0) AS consecutive_pct,
        AVG(gap_minutes) FILTER (WHERE gap_minutes <= 480) AS avg_gap_minutes
      FROM eps
      GROUP BY server_user_id, show_id
      HAVING COUNT(*) >= 2 AND COUNT(*) FILTER (WHERE gap_minutes <= 30) >= ${bingeThreshold}
    ),
    per_user_day AS (
      SELECT server_user_id, show_id, MAX(episodes) AS max_episodes_in_one_day
      FROM (
        SELECT eps.server_user_id, eps.show_id,
          COUNT(DISTINCT COALESCE(em.merged_into_id, eps.media_id)) AS episodes
        FROM eps
        LEFT JOIN media em ON em.id = eps.media_id
        GROUP BY eps.server_user_id, eps.show_id, date_trunc('day', eps.started_at AT TIME ZONE 'UTC')
      ) d
      GROUP BY server_user_id, show_id
    ),
    binge_eps AS (
      SELECT e.* FROM eps e JOIN per_user u USING (server_user_id, show_id)
    ),
    server_counts AS (
      SELECT show_id, server_id, COUNT(*) AS episodes FROM binge_eps GROUP BY show_id, server_id
    ),
    per_show AS (
      SELECT u.show_id,
        SUM(u.total_episode_watches) AS total_episode_watches,
        SUM(u.consecutive_episodes) AS consecutive_episodes,
        ROUND(AVG(u.consecutive_pct)::numeric, 1) AS consecutive_pct,
        ROUND(AVG(u.avg_gap_minutes)::numeric, 1) AS avg_gap_minutes,
        MAX(d.max_episodes_in_one_day) AS max_episodes_in_one_day
      FROM per_user u
      JOIN per_user_day d USING (server_user_id, show_id)
      GROUP BY u.show_id
    ),
    scored AS (
      SELECT ps.*,
        ROUND(
          LEAST(ps.consecutive_episodes * 5, 40) +
          LEAST(COALESCE(ps.consecutive_pct, 0), 30) +
          LEAST(COALESCE(ps.max_episodes_in_one_day, 1) * 6, 30)
        , 1) AS binge_score
      FROM per_show ps
    )
    SELECT
      s.show_id::text AS show_media_id,
      shm.title AS show_title,
      (SELECT sc.server_id::text FROM server_counts sc WHERE sc.show_id = s.show_id
        ORDER BY sc.episodes DESC, sc.server_id LIMIT 1) AS primary_server_id,
      (SELECT be.thumb_path FROM binge_eps be WHERE be.show_id = s.show_id
        ORDER BY be.thumb_path IS NULL, be.started_at DESC LIMIT 1) AS thumb_path,
      s.total_episode_watches::text AS total_episode_watches,
      s.consecutive_episodes::text AS consecutive_episodes,
      s.consecutive_pct::text AS consecutive_pct,
      s.avg_gap_minutes::text AS avg_gap_minutes,
      COALESCE(s.max_episodes_in_one_day, 1)::text AS max_episodes_in_one_day,
      (SELECT array_agg(sc.server_id::text ORDER BY sc.server_id::text) FROM server_counts sc
        WHERE sc.show_id = s.show_id) AS server_ids,
      s.binge_score::text AS binge_score
    FROM scored s
    JOIN media shm ON shm.id = s.show_id
    ORDER BY s.binge_score DESC, shm.title ASC, s.show_id
    LIMIT ${limit}`;
}

// One point per bucket from the window's start (or the first session for all time) to its
// last day, zero-filled, with buckets cut in the request timezone.
function buildTrendQuery(scope: SQL, window: Window, bucket: TrendBucket, tz: string): SQL {
  const unit = sql.raw(`'${bucket}'`);
  const local = (ts: SQL) => sql`date_trunc(${unit}, ${ts} AT TIME ZONE ${tz})`;
  const first = window.startDate
    ? local(sql`${window.startDate}::timestamptz`)
    : sql`(SELECT MIN(bucket) FROM buckets)`;
  return sql`
    WITH buckets AS (
      SELECT ${local(sql`sess.started_at`)} AS bucket,
        ${playCountSql('sess')} AS watch_count,
        SUM(sess.duration_ms) AS watch_ms
      FROM sessions sess
      WHERE ${scope}
      GROUP BY 1
    ),
    series AS (
      SELECT generate_series(
        ${first},
        ${local(sql`${window.lastDay}::timestamptz`)},
        ${sql.raw(`INTERVAL '1 ${bucket}'`)}
      ) AS bucket
    )
    SELECT to_char(s.bucket, 'YYYY-MM-DD') AS start,
      COALESCE(b.watch_count, 0)::text AS watch_count,
      ROUND(COALESCE(b.watch_ms, 0) / 3600000.0, 2)::text AS total_watch_hours
    FROM series s
    LEFT JOIN buckets b ON b.bucket = s.bucket
    ORDER BY s.bucket`;
}

/** The earliest bucket with the most plays and the earliest with the fewest; null with no plays. */
function busiestAndQuietest(points: TrendPoint[]): {
  busiest: string | null;
  quietest: string | null;
} {
  if (points.every((point) => point.watchCount === 0)) return { busiest: null, quietest: null };
  let busiest: TrendPoint | undefined;
  let quietest: TrendPoint | undefined;
  for (const point of points) {
    if (!busiest || point.watchCount > busiest.watchCount) busiest = point;
    if (!quietest || point.watchCount < quietest.watchCount) quietest = point;
  }
  return { busiest: busiest?.start ?? null, quietest: quietest?.start ?? null };
}

export const libraryPatternsRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: LibraryPatternsQueryInput }>(
    '/patterns',
    { preHandler: [app.requirePermission('insights', 'read')] },
    async (request, reply) => {
      const query = libraryPatternsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        serverIds: rawServerIds,
        libraryId,
        includeBinge,
        includePeakTimes,
        includeSeasonalTrends,
        bingeThreshold,
        limit,
        timezone,
      } = query.data;
      const tz = timezone ?? 'UTC';
      const { startDate, endDate, lastDay, cacheSegment } = resolveLibraryWindow(query.data);
      // Rounded like rollupDayWindowSql, so a preset starts where the watch summary does
      const window = { startDate: startDate && ceilToUtcDay(startDate), endDate, lastDay };
      const bucket = trendBucket(window);

      const resolvedIds = resolveServerIds(request.user, serverId, rawServerIds);
      const scope = sessionScopeSql(window, resolvedIds, libraryId);

      const serverCacheKey = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_PATTERNS,
        serverCacheKey,
        `${libraryId ?? 'all'}-${cacheSegment}-${bingeThreshold}-${limit}-${includeBinge}-${includePeakTimes}-${includeSeasonalTrends}-${tz}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as PatternsResponse;
        } catch {
          // Fall through to compute
        }
      }

      let bingeShows: BingeShow[] = [];
      let hourlyDistribution: HourlyDistribution[] = [];
      let peakHour = 0;
      let peakDayOfWeek = 0;
      let points: TrendPoint[] = [];
      let totalWatchSessions = 0;
      let avgSessionsPerDay = 0;
      let bingeSessionsPct = 0;

      const queries: Promise<void>[] = [];

      if (includeBinge) {
        queries.push(
          (async () => {
            const bingeResult = await db.execute(buildBingeQuery(scope, bingeThreshold, limit));
            bingeShows = (bingeResult.rows as unknown as RawBingeRow[]).map((row) => ({
              showMediaId: row.show_media_id,
              showTitle: row.show_title,
              primaryServerId: row.primary_server_id,
              thumbPath: row.thumb_path,
              totalEpisodeWatches: parseInt(row.total_episode_watches, 10),
              consecutiveEpisodes: parseInt(row.consecutive_episodes, 10),
              consecutivePct: parseFloat(row.consecutive_pct || '0'),
              avgGapMinutes: parseFloat(row.avg_gap_minutes || '0'),
              bingeScore: parseFloat(row.binge_score),
              maxEpisodesInOneDay: parseInt(row.max_episodes_in_one_day || '1', 10),
              serverIds: row.server_ids,
            }));
          })()
        );
      }

      if (includePeakTimes) {
        queries.push(
          (async () => {
            const hourlyResult = await db.execute(sql`
              WITH hourly AS (
                SELECT
                  EXTRACT(HOUR FROM sess.started_at AT TIME ZONE ${tz})::int AS hour,
                  ${playCountSql('sess')} AS watch_count,
                  SUM(sess.duration_ms) AS total_watch_ms
                FROM sessions sess
                WHERE ${scope}
                GROUP BY 1
              ),
              total AS (
                SELECT SUM(watch_count) AS total FROM hourly
              )
              SELECT
                h.hour::text AS hour,
                h.watch_count::text AS watch_count,
                h.total_watch_ms::text AS total_watch_ms,
                ROUND((100.0 * h.watch_count / NULLIF(t.total, 0))::numeric, 1)::text AS pct_of_total
              FROM hourly h
              CROSS JOIN total t
              ORDER BY h.hour
            `);

            hourlyDistribution = (hourlyResult.rows as unknown as RawHourlyRow[]).map((row) => ({
              hour: parseInt(row.hour, 10),
              watchCount: parseInt(row.watch_count, 10),
              totalWatchMs: parseInt(row.total_watch_ms, 10),
              pctOfTotal: parseFloat(row.pct_of_total || '0'),
            }));

            if (hourlyDistribution.length > 0) {
              peakHour = hourlyDistribution.reduce((max, h) =>
                h.watchCount > max.watchCount ? h : max
              ).hour;
            }

            const peakResult = await db.execute(sql`
              SELECT
                (SELECT EXTRACT(DOW FROM sess.started_at AT TIME ZONE ${tz})::int AS day_of_week
                 FROM sessions sess
                 WHERE ${scope}
                 GROUP BY 1
                 ORDER BY ${playCountSql('sess')} DESC
                 LIMIT 1
                )::text AS peak_day_of_week
            `);

            const peakRow = peakResult.rows[0] as unknown as { peak_day_of_week: string | null };
            peakDayOfWeek = parseInt(peakRow?.peak_day_of_week || '0', 10);
          })()
        );
      }

      if (includeSeasonalTrends) {
        queries.push(
          (async () => {
            const trendResult = await db.execute(buildTrendQuery(scope, window, bucket, tz));
            points = (trendResult.rows as unknown as RawTrendRow[]).map((row) => ({
              start: row.start,
              watchCount: parseInt(row.watch_count, 10),
              totalWatchHours: parseFloat(row.total_watch_hours),
            }));
          })()
        );
      }

      queries.push(
        (async () => {
          const summaryResult = await db.execute(sql`
            SELECT
              COUNT(*)::text AS total_watch_sessions,
              ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT DATE(sess.started_at)), 0), 1)::text
                AS avg_sessions_per_day,
              ROUND((100.0 * COUNT(*) FILTER (
                WHERE sess.media_type = 'episode'
                  AND (sess.stopped_at - sess.started_at) < INTERVAL '30 minutes'
              ) / NULLIF(COUNT(*), 0))::numeric, 1)::text AS binge_sessions_pct
            FROM sessions sess
            WHERE ${scope}
          `);

          const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow | undefined;
          if (summaryRow) {
            totalWatchSessions = parseInt(summaryRow.total_watch_sessions || '0', 10);
            avgSessionsPerDay = parseFloat(summaryRow.avg_sessions_per_day || '0');
            bingeSessionsPct = parseFloat(summaryRow.binge_sessions_pct || '0');
          }
        })()
      );

      await Promise.all(queries);

      const response: PatternsResponse = {
        bingeShows,
        peakTimes: {
          hourlyDistribution,
          peakHour,
          peakDayOfWeek,
        },
        trend: { bucket, points, ...busiestAndQuietest(points) },
        summary: {
          totalWatchSessions,
          avgSessionsPerDay,
          bingeSessionsPct,
        },
      };

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_PATTERNS, JSON.stringify(response));
      return response;
    }
  );
};
