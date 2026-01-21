/**
 * Library Watch Patterns Route
 *
 * GET /patterns - Analyze viewing patterns including binge behavior, peak times, and seasonal trends
 *
 * Uses episode_continuity_stats view for binge detection and sessions table for time distribution.
 * Returns composite analysis useful for content scheduling and library curation decisions.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryPatternsQuerySchema,
  type LibraryPatternsQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';
import { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';

/** Show with binge metrics */
interface BingeShow {
  showTitle: string;
  serverId: string;
  thumbPath: string | null;
  totalEpisodeWatches: number;
  consecutiveEpisodes: number;
  consecutivePct: number;
  avgGapMinutes: number;
  bingeScore: number; // 0-100 composite score
  maxEpisodesInOneDay: number;
}

/** Hourly viewing distribution */
interface HourlyDistribution {
  hour: number; // 0-23
  watchCount: number;
  totalWatchMs: number;
  pctOfTotal: number;
}

/** Monthly viewing trends */
interface MonthlyTrend {
  month: string; // YYYY-MM format
  watchCount: number;
  totalWatchMs: number;
  uniqueItems: number;
  avgWatchesPerDay: number;
}

/** Full patterns response */
interface PatternsResponse {
  bingeShows: BingeShow[];
  peakTimes: {
    hourlyDistribution: HourlyDistribution[];
    peakHour: number;
    peakDayOfWeek: number; // 0=Sunday
  };
  seasonalTrends: {
    monthlyTrends: MonthlyTrend[];
    busiestMonth: string;
    quietestMonth: string;
  };
  summary: {
    totalWatchSessions: number;
    avgSessionsPerDay: number;
    bingeSessionsPct: number;
  };
}

/** Raw binge row from database */
interface RawBingeRow {
  show_title: string;
  server_id: string;
  thumb_path: string | null;
  total_episode_watches: string;
  consecutive_episodes: string;
  consecutive_pct: string | null;
  avg_gap_minutes: string | null;
  max_episodes_in_one_day: string | null;
  binge_score: string;
}

/** Raw hourly row from database */
interface RawHourlyRow {
  hour: string;
  watch_count: string;
  total_watch_ms: string;
  pct_of_total: string;
}

/** Raw peak row from database */
interface _RawPeakRow {
  peak_hour: string;
  peak_day_of_week: string;
}

/** Raw monthly row from database */
interface RawMonthlyRow {
  month: string;
  watch_count: string;
  total_watch_ms: string;
  unique_items: string;
  avg_watches_per_day: string;
}

/** Raw summary row from database */
interface RawSummaryRow {
  total_watch_sessions: string;
  avg_sessions_per_day: string;
  binge_sessions_pct: string;
}

export const libraryPatternsRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /patterns - Watch pattern analysis
   *
   * Analyzes viewing patterns including:
   * - Binge shows with composite binge scores
   * - Peak viewing times (hour and day of week)
   * - Seasonal trends (monthly patterns)
   */
  app.get<{ Querystring: LibraryPatternsQueryInput }>(
    '/patterns',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryPatternsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        libraryId,
        periodWeeks,
        includeBinge,
        includePeakTimes,
        includeSeasonalTrends,
        bingeThreshold,
        limit,
      } = query.data;
      const authUser = request.user;

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      // Build cache key with all varying params
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_PATTERNS,
        serverId,
        `${libraryId ?? 'all'}-${periodWeeks}-${bingeThreshold}-${limit}-${includeBinge}-${includePeakTimes}-${includeSeasonalTrends}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as PatternsResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build server filter for library_items
      const serverFilter = buildLibraryServerFilter(serverId, authUser, 'li');
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;

      // Initialize response
      let bingeShows: BingeShow[] = [];
      let hourlyDistribution: HourlyDistribution[] = [];
      let peakHour = 0;
      let peakDayOfWeek = 0;
      let monthlyTrends: MonthlyTrend[] = [];
      let busiestMonth = '';
      let quietestMonth = '';
      let totalWatchSessions = 0;
      let avgSessionsPerDay = 0;
      let bingeSessionsPct = 0;

      // Run queries in parallel based on what's requested
      const queries: Promise<void>[] = [];

      // Binge detection query
      if (includeBinge) {
        queries.push(
          (async () => {
            const bingeResult = await db.execute(sql`
              WITH binge_stats AS (
                SELECT
                  ecs.show_title,
                  MAX(ses.server_id::text) AS server_id,
                  MAX(ses.thumb_path) AS thumb_path,
                  SUM(ecs.total_episode_watches) AS total_episode_watches,
                  SUM(ecs.consecutive_episodes) AS consecutive_episodes,
                  ROUND(AVG(ecs.consecutive_pct)::numeric, 1) AS consecutive_pct,
                  ROUND(AVG(ecs.avg_gap_minutes)::numeric, 1) AS avg_gap_minutes,
                  MAX(dsi.max_episodes_in_one_day) AS max_episodes_in_one_day
                FROM episode_continuity_stats ecs
                LEFT JOIN show_engagement_summary ses ON ecs.show_title = ses.show_title
                  AND ecs.server_user_id = ses.server_user_id
                LEFT JOIN (
                  SELECT server_user_id, show_title, MAX(episodes_watched_this_day) AS max_episodes_in_one_day
                  FROM daily_show_intensity
                  GROUP BY server_user_id, show_title
                ) dsi ON ecs.show_title = dsi.show_title AND ecs.server_user_id = dsi.server_user_id
                WHERE ecs.consecutive_episodes >= ${bingeThreshold}
                  AND EXISTS (
                    SELECT 1 FROM sessions s
                    WHERE s.server_user_id = ecs.server_user_id
                      AND s.grandparent_title = ecs.show_title
                      AND s.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                      ${serverId ? sql`AND s.server_id = ${serverId}` : sql``}
                  )
                GROUP BY ecs.show_title
              )
              SELECT
                show_title,
                server_id,
                thumb_path,
                total_episode_watches::text AS total_episode_watches,
                consecutive_episodes::text AS consecutive_episodes,
                consecutive_pct::text AS consecutive_pct,
                avg_gap_minutes::text AS avg_gap_minutes,
                COALESCE(max_episodes_in_one_day, 1)::text AS max_episodes_in_one_day,
                -- Binge score: weighted combination of volume and intensity
                ROUND(
                  LEAST(consecutive_episodes * 5, 40) +
                  LEAST(COALESCE(consecutive_pct, 0), 30) +
                  LEAST(COALESCE(max_episodes_in_one_day, 1) * 6, 30)
                , 1)::text AS binge_score
              FROM binge_stats
              ORDER BY binge_score DESC
              LIMIT ${limit}
            `);

            bingeShows = (bingeResult.rows as unknown as RawBingeRow[]).map((row) => ({
              showTitle: row.show_title,
              serverId: row.server_id,
              thumbPath: row.thumb_path,
              totalEpisodeWatches: parseInt(row.total_episode_watches, 10),
              consecutiveEpisodes: parseInt(row.consecutive_episodes, 10),
              consecutivePct: parseFloat(row.consecutive_pct || '0'),
              avgGapMinutes: parseFloat(row.avg_gap_minutes || '0'),
              bingeScore: parseFloat(row.binge_score),
              maxEpisodesInOneDay: parseInt(row.max_episodes_in_one_day || '1', 10),
            }));
          })()
        );
      }

      // Peak viewing times query
      if (includePeakTimes) {
        queries.push(
          (async () => {
            // Hourly distribution
            const hourlyResult = await db.execute(sql`
              WITH hourly AS (
                SELECT
                  EXTRACT(HOUR FROM sess.started_at AT TIME ZONE 'UTC')::int AS hour,
                  COUNT(*) AS watch_count,
                  SUM(sess.duration_ms) AS total_watch_ms
                FROM sessions sess
                JOIN library_items li ON sess.rating_key = li.rating_key
                  AND sess.server_id = li.server_id
                WHERE sess.duration_ms >= 120000
                  AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                  ${serverFilter}
                  ${libraryFilter}
                GROUP BY EXTRACT(HOUR FROM sess.started_at AT TIME ZONE 'UTC')
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

            // Find peak hour
            if (hourlyDistribution.length > 0) {
              peakHour = hourlyDistribution.reduce((max, h) =>
                h.watchCount > max.watchCount ? h : max
              ).hour;
            }

            // Peak day of week
            const peakResult = await db.execute(sql`
              SELECT
                (SELECT EXTRACT(DOW FROM sess.started_at)::int AS day_of_week
                 FROM sessions sess
                 JOIN library_items li ON sess.rating_key = li.rating_key
                   AND sess.server_id = li.server_id
                 WHERE sess.duration_ms >= 120000
                   AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                   ${serverFilter}
                   ${libraryFilter}
                 GROUP BY EXTRACT(DOW FROM sess.started_at)
                 ORDER BY COUNT(*) DESC
                 LIMIT 1
                )::text AS peak_day_of_week
            `);

            const peakRow = peakResult.rows[0] as unknown as { peak_day_of_week: string | null };
            peakDayOfWeek = parseInt(peakRow?.peak_day_of_week || '0', 10);
          })()
        );
      }

      // Seasonal trends query
      if (includeSeasonalTrends) {
        queries.push(
          (async () => {
            const monthlyResult = await db.execute(sql`
              WITH monthly AS (
                SELECT
                  TO_CHAR(sess.started_at, 'YYYY-MM') AS month,
                  COUNT(*) AS watch_count,
                  SUM(sess.duration_ms) AS total_watch_ms,
                  COUNT(DISTINCT li.id) AS unique_items,
                  COUNT(*)::float / EXTRACT(DAY FROM
                    (DATE_TRUNC('month', sess.started_at) + INTERVAL '1 month' - INTERVAL '1 day')
                  ) AS avg_watches_per_day
                FROM sessions sess
                JOIN library_items li ON sess.rating_key = li.rating_key
                  AND sess.server_id = li.server_id
                WHERE sess.duration_ms >= 120000
                  AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                  ${serverFilter}
                  ${libraryFilter}
                GROUP BY TO_CHAR(sess.started_at, 'YYYY-MM'), DATE_TRUNC('month', sess.started_at)
              )
              SELECT
                month,
                watch_count::text AS watch_count,
                total_watch_ms::text AS total_watch_ms,
                unique_items::text AS unique_items,
                ROUND(avg_watches_per_day::numeric, 1)::text AS avg_watches_per_day
              FROM monthly
              ORDER BY month
            `);

            monthlyTrends = (monthlyResult.rows as unknown as RawMonthlyRow[]).map((row) => ({
              month: row.month,
              watchCount: parseInt(row.watch_count, 10),
              totalWatchMs: parseInt(row.total_watch_ms, 10),
              uniqueItems: parseInt(row.unique_items, 10),
              avgWatchesPerDay: parseFloat(row.avg_watches_per_day),
            }));

            // Find busiest and quietest months
            if (monthlyTrends.length > 0) {
              const sorted = [...monthlyTrends].sort((a, b) => b.watchCount - a.watchCount);
              busiestMonth = sorted[0]?.month ?? '';
              quietestMonth = sorted[sorted.length - 1]?.month ?? '';
            }
          })()
        );
      }

      // Summary query (always run)
      queries.push(
        (async () => {
          const summaryResult = await db.execute(sql`
            WITH session_stats AS (
              SELECT
                COUNT(*) AS total_sessions,
                COUNT(*) FILTER (
                  WHERE li.media_type = 'episode'
                    AND (stopped_at - started_at) < INTERVAL '30 minutes'
                ) AS potential_binge_sessions
              FROM sessions sess
              JOIN library_items li ON sess.rating_key = li.rating_key
                AND sess.server_id = li.server_id
              WHERE sess.duration_ms >= 120000
                AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                ${serverFilter}
                ${libraryFilter}
            ),
            day_count AS (
              SELECT COUNT(DISTINCT DATE(sess.started_at)) AS days
              FROM sessions sess
              JOIN library_items li ON sess.rating_key = li.rating_key
                AND sess.server_id = li.server_id
              WHERE sess.duration_ms >= 120000
                AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                ${serverFilter}
                ${libraryFilter}
            )
            SELECT
              s.total_sessions::text AS total_watch_sessions,
              ROUND((s.total_sessions::numeric / NULLIF(d.days, 0)), 1)::text AS avg_sessions_per_day,
              ROUND((100.0 * s.potential_binge_sessions / NULLIF(s.total_sessions, 0))::numeric, 1)::text AS binge_sessions_pct
            FROM session_stats s
            CROSS JOIN day_count d
          `);

          const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow | undefined;
          if (summaryRow) {
            totalWatchSessions = parseInt(summaryRow.total_watch_sessions || '0', 10);
            avgSessionsPerDay = parseFloat(summaryRow.avg_sessions_per_day || '0');
            bingeSessionsPct = parseFloat(summaryRow.binge_sessions_pct || '0');
          }
        })()
      );

      // Execute all queries in parallel
      await Promise.all(queries);

      const response: PatternsResponse = {
        bingeShows,
        peakTimes: {
          hourlyDistribution,
          peakHour,
          peakDayOfWeek,
        },
        seasonalTrends: {
          monthlyTrends,
          busiestMonth,
          quietestMonth,
        },
        summary: {
          totalWatchSessions,
          avgSessionsPerDay,
          bingeSessionsPct,
        },
      };

      // Cache response
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_PATTERNS, JSON.stringify(response));

      return response;
    }
  );
};
