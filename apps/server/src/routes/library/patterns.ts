/**
 * Library Watch Patterns Route
 *
 * GET /patterns - Binge behavior, peak times and the viewing trend within the selected window.
 *
 * Reads raw sessions, since hour of day and gaps between episodes need timestamps. A session
 * belongs to its media identity, not the library row it was played from, so plays of a
 * re-added or removed title still count. Binge shows are keyed by show identity (a merged
 * alias folds into its winner), so one show on two servers is one row and two shows that
 * share a title stay apart, and plays are counted per person across their accounts.
 * `primaryServerId` is the server with the most of the binge plays.
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
import { serverCacheSegment } from '../../lib/scope.js';

interface RawBingeRow {
  show_media_id: string;
  show_title: string;
  primary_server_id: string;
  thumb_path: string | null;
  total_episode_watches: string;
  consecutive_episodes: string;
  consecutive_pct: string;
  max_episodes_in_one_day: string;
  people: string;
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
  consecutive_plays_pct: string;
}

type Window = { startDate: Date | null; endDate: Date; lastDay: Date };

function trendBucket(window: Window): TrendBucket {
  if (!window.startDate) return 'month';
  const days = (window.endDate.getTime() - window.startDate.getTime()) / TIME_MS.DAY;
  return days <= 31 ? 'day' : days <= 183 ? 'week' : 'month';
}

// Sessions with a media identity, counted or not, started within the window, on the selected
// servers and, when one is given, in a library that holds that title. Sessions are aliased sess.
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
  return sql`sess.media_id IS NOT NULL
    ${lower} AND sess.started_at < ${window.endDate}::timestamptz
    ${buildMultiServerFragment(serverIds, 'sess.server_id')}
    ${library}`;
}

// One row per counted episode play (resume chain) in scope, keyed by person and show identity.
// A play is consecutive when it is a different episode starting 30 minutes or less after the
// same person's previous play of the show ended. A play ends when its last segment stops, so a
// chain reads every segment in scope, counted or not, and is kept when any segment counts.
// Gaps only see plays inside the window, so a binge that began before it starts fresh.
function episodePlaysCtes(segments: SQL): SQL {
  const show = sql`COALESCE(sh.merged_into_id, sess.show_media_id)`;
  const episode = sql`COALESCE(em.merged_into_id, sess.media_id)`;
  return sql`
    chains AS (
      SELECT su.user_id, ${show} AS show_id, ${episode} AS episode,
        MIN(sess.started_at) AS started_at,
        MAX(sess.stopped_at) AS stopped_at,
        (array_agg(sess.server_id ORDER BY sess.started_at))[1] AS server_id,
        (array_agg(sess.thumb_path ORDER BY sess.started_at))[1] AS thumb_path
      FROM sessions sess
      JOIN server_users su ON su.id = sess.server_user_id
      LEFT JOIN media sh ON sh.id = sess.show_media_id AND sh.merged_into_id IS NOT NULL
      LEFT JOIN media em ON em.id = sess.media_id AND em.merged_into_id IS NOT NULL
      WHERE ${segments}
        AND sess.media_type = 'episode'
        AND sess.show_media_id IS NOT NULL
        AND sess.stopped_at IS NOT NULL
      GROUP BY COALESCE(sess.reference_id, sess.id), su.user_id, ${show}, ${episode}
      HAVING BOOL_OR(${countedSessionSql('sess')})
    ),
    plays AS (
      SELECT c.*,
        COALESCE(
          c.started_at - LAG(c.stopped_at) OVER w <= INTERVAL '30 minutes'
            AND c.episode <> LAG(c.episode) OVER w,
          false
        ) AS consecutive
      FROM chains c
      WINDOW w AS (PARTITION BY c.user_id, c.show_id ORDER BY c.started_at)
    )`;
}

function buildBingeQuery(segments: SQL, bingeThreshold: number, limit: number): SQL {
  return sql`
    WITH ${episodePlaysCtes(segments)},
    person_days AS (
      SELECT user_id, show_id, COUNT(*) AS plays,
        COUNT(*) FILTER (WHERE consecutive) AS consecutive,
        COUNT(DISTINCT episode) AS episodes
      FROM plays
      GROUP BY user_id, show_id, (started_at AT TIME ZONE 'UTC')::date
    ),
    per_person AS (
      SELECT user_id, show_id, SUM(plays) AS plays, SUM(consecutive) AS consecutive,
        MAX(episodes) AS max_per_day
      FROM person_days
      GROUP BY user_id, show_id
      HAVING SUM(consecutive) >= ${bingeThreshold}
    ),
    binge_plays AS (
      SELECT p.* FROM plays p JOIN per_person USING (user_id, show_id)
    ),
    server_counts AS (
      SELECT show_id, server_id, COUNT(*) AS plays FROM binge_plays GROUP BY show_id, server_id
    ),
    per_show AS (
      SELECT show_id, SUM(plays) AS plays, SUM(consecutive) AS consecutive,
        MAX(max_per_day) AS max_per_day, COUNT(*) AS people
      FROM per_person
      GROUP BY show_id
    )
    SELECT
      s.show_id::text AS show_media_id,
      shm.title AS show_title,
      (SELECT sc.server_id::text FROM server_counts sc WHERE sc.show_id = s.show_id
        ORDER BY sc.plays DESC, sc.server_id LIMIT 1) AS primary_server_id,
      (SELECT bp.thumb_path FROM binge_plays bp WHERE bp.show_id = s.show_id
        ORDER BY bp.thumb_path IS NULL, bp.started_at DESC LIMIT 1) AS thumb_path,
      s.plays::text AS total_episode_watches,
      s.consecutive::text AS consecutive_episodes,
      ROUND(100.0 * s.consecutive / s.plays, 1)::text AS consecutive_pct,
      s.max_per_day::text AS max_episodes_in_one_day,
      s.people::text AS people,
      (SELECT array_agg(sc.server_id::text ORDER BY sc.server_id::text) FROM server_counts sc
        WHERE sc.show_id = s.show_id) AS server_ids
    FROM per_show s
    JOIN media shm ON shm.id = s.show_id
    ORDER BY s.consecutive DESC, s.max_per_day DESC, shm.title ASC, s.show_id
    LIMIT ${limit}`;
}

// Every counted episode play in scope, with no binge threshold.
function buildConsecutiveShareQuery(segments: SQL): SQL {
  return sql`
    WITH ${episodePlaysCtes(segments)}
    SELECT COALESCE(
      ROUND(100.0 * COUNT(*) FILTER (WHERE consecutive) / NULLIF(COUNT(*), 0), 1), 0
    )::text AS consecutive_plays_pct
    FROM plays`;
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
      const segments = sessionScopeSql(window, resolvedIds, libraryId);
      const scope = sql`${countedSessionSql('sess')} AND ${segments}`;

      const serverCacheKey = serverCacheSegment(resolvedIds);
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
      let consecutivePlaysPct = 0;

      const queries: Promise<void>[] = [];

      if (includeBinge) {
        queries.push(
          (async () => {
            const bingeResult = await db.execute(buildBingeQuery(segments, bingeThreshold, limit));
            bingeShows = (bingeResult.rows as unknown as RawBingeRow[]).map((row) => ({
              showMediaId: row.show_media_id,
              showTitle: row.show_title,
              primaryServerId: row.primary_server_id,
              thumbPath: row.thumb_path,
              totalEpisodeWatches: parseInt(row.total_episode_watches, 10),
              consecutiveEpisodes: parseInt(row.consecutive_episodes, 10),
              consecutivePct: parseFloat(row.consecutive_pct),
              maxEpisodesInOneDay: parseInt(row.max_episodes_in_one_day, 10),
              people: parseInt(row.people, 10),
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
          const summaryResult = await db.execute(buildConsecutiveShareQuery(segments));
          const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow | undefined;
          consecutivePlaysPct = parseFloat(summaryRow?.consecutive_plays_pct ?? '0');
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
        summary: { consecutivePlaysPct },
      };

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_PATTERNS, JSON.stringify(response));
      return response;
    }
  );
};
