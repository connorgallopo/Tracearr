/**
 * Engagement Statistics Routes
 *
 * GET /engagement - Comprehensive engagement metrics with Netflix-style play counting
 * GET /shows - Show-level stats with episode rollup
 *
 * These endpoints use the engagement tracking system which:
 * - Filters sessions < 2 minutes (Netflix "intent" threshold)
 * - Calculates plays as cumulative_time / content_duration
 * - Groups sessions into engagement tiers (abandoned -> rewatched)
 * - Provides show-level aggregation for TV series
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  engagementQuerySchema,
  showsQuerySchema,
  type EngagementTier,
  type UserBehaviorType,
  type TopContentEngagement,
  type ShowEngagement,
  type EngagementTierBreakdown,
  type UserEngagementProfile,
  type EngagementStats,
  type ShowStatsResponse,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveDateRange } from './utils.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';

// UUID validation regex for defensive checks
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build SQL server filter fragment for raw queries.
 * Note: serverId should be pre-validated by schema (uuidSchema) but we add defensive checks.
 */
function buildServerFilterSql(
  serverId: string | undefined,
  authUser: { role: string; serverIds: string[] }
): ReturnType<typeof sql> {
  if (serverId) {
    if (!UUID_REGEX.test(serverId)) {
      return sql`AND false`; // Invalid UUID, return no results
    }
    return sql`AND server_id = ${serverId}::uuid`;
  }
  if (authUser.role !== 'owner') {
    // Filter to only valid UUIDs from auth context
    const validServerIds = authUser.serverIds.filter((id) => UUID_REGEX.test(id));
    if (validServerIds.length === 0) {
      return sql`AND false`;
    } else if (validServerIds.length === 1) {
      return sql`AND server_id = ${validServerIds[0]}::uuid`;
    } else {
      const serverIdList = validServerIds.map((id) => sql`${id}::uuid`);
      return sql`AND server_id IN (${sql.join(serverIdList, sql`, `)})`;
    }
  }
  return sql``;
}

export const engagementRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /engagement - Comprehensive engagement metrics
   *
   * Returns:
   * - topContent: Top content by plays with engagement metrics
   * - topShows: Top shows with episode rollup
   * - engagementBreakdown: Distribution across engagement tiers
   * - userProfiles: User behavior classification
   * - summary: Overall metrics including session inflation percentage
   */
  app.get('/engagement', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = engagementQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, mediaType, limit } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    // Validate server access
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    const serverFilter = buildServerFilterSql(serverId, authUser);
    // Note: The continuous aggregate buckets by UTC day, so we truncate input dates
    // to UTC day boundaries to ensure correct bucket matching
    const dailyStartFilter = dateRange.start
      ? sql`day >= date_trunc('day', ${dateRange.start}::timestamptz)`
      : sql`true`;
    const dailyEndFilter = period === 'custom'
      ? sql`AND day < date_trunc('day', ${dateRange.end}::timestamptz) + interval '1 day'`
      : sql``;
    const mediaTypeFilter = mediaType ? sql`AND media_type = ${mediaType}` : sql``;

    // Run all queries in parallel
    // Note: Queries aggregate from daily_content_engagement to support date filtering
    const [
      topContentResult,
      topShowsResult,
      tierBreakdownResult,
      userProfilesResult,
      summaryResult,
    ] = await Promise.all([
      // Top content by plays (aggregated from daily with date filter)
      db.execute(sql`
          WITH filtered_daily AS (
            SELECT * FROM daily_content_engagement
            WHERE ${dailyStartFilter} ${dailyEndFilter} ${serverFilter}
          ),
          content_agg AS (
            SELECT
              server_user_id,
              rating_key,
              MAX(media_title) AS media_title,
              MAX(show_title) AS show_title,
              MAX(media_type) AS media_type,
              MAX(content_duration_ms) AS content_duration_ms,
              MAX(thumb_path) AS thumb_path,
              MAX(server_id::text)::uuid AS server_id,
              MAX(year) AS year,
              SUM(watched_ms) AS cumulative_watched_ms,
              SUM(valid_session_count) AS valid_sessions,
              SUM(total_session_count) AS total_sessions,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  GREATEST(0, FLOOR(SUM(watched_ms)::float / MAX(content_duration_ms)))::int
                ELSE 0
              END AS plays,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  CASE
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 2.0 THEN 'rewatched'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 1.0 THEN 'finished'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.8 THEN 'completed'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.5 THEN 'engaged'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.2 THEN 'sampled'
                    ELSE 'abandoned'
                  END
                ELSE 'unknown'
              END AS engagement_tier
            FROM filtered_daily
            GROUP BY server_user_id, rating_key
          )
          SELECT
            rating_key,
            media_title,
            show_title,
            media_type,
            thumb_path,
            server_id,
            year,
            SUM(plays) AS total_plays,
            ROUND(SUM(cumulative_watched_ms) / 1000.0 / 60 / 60, 1) AS total_watch_hours,
            COUNT(DISTINCT server_user_id) AS unique_viewers,
            SUM(valid_sessions) AS valid_sessions,
            SUM(total_sessions) AS total_sessions,
            COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished', 'rewatched')) AS completions,
            COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') AS rewatches,
            COUNT(*) FILTER (WHERE engagement_tier = 'abandoned') AS abandonments,
            ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished', 'rewatched'))
                  / NULLIF(COUNT(*), 0), 1) AS completion_rate,
            ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier = 'abandoned')
                  / NULLIF(COUNT(*), 0), 1) AS abandonment_rate
          FROM content_agg
          WHERE true ${mediaTypeFilter}
          GROUP BY rating_key, media_title, show_title, media_type, content_duration_ms, thumb_path, server_id, year
          ORDER BY total_plays DESC
          LIMIT ${limit}
        `),

      // Top shows (aggregated from daily with date filter)
      db.execute(sql`
          WITH filtered_daily AS (
            SELECT * FROM daily_content_engagement
            WHERE ${dailyStartFilter} ${dailyEndFilter} ${serverFilter}
            AND media_type = 'episode' AND show_title IS NOT NULL
          ),
          -- Daily intensity: episodes per user/show/day
          daily_intensity AS (
            SELECT
              server_user_id,
              show_title,
              day,
              COUNT(DISTINCT rating_key) AS episodes_this_day
            FROM filtered_daily
            WHERE valid_session_count > 0
            GROUP BY server_user_id, show_title, day
          ),
          intensity_stats AS (
            SELECT
              server_user_id,
              show_title,
              COUNT(DISTINCT day) AS total_viewing_days,
              MAX(episodes_this_day) AS max_episodes_in_one_day,
              ROUND(AVG(episodes_this_day), 1) AS avg_episodes_per_viewing_day
            FROM daily_intensity
            GROUP BY server_user_id, show_title
          ),
          content_agg AS (
            SELECT
              server_user_id,
              rating_key,
              MAX(show_title) AS show_title,
              MAX(thumb_path) AS thumb_path,
              MAX(server_id::text)::uuid AS server_id,
              MAX(year) AS year,
              MAX(season_number) AS season_number,
              MAX(episode_number) AS episode_number,
              MAX(content_duration_ms) AS content_duration_ms,
              SUM(watched_ms) AS cumulative_watched_ms,
              SUM(valid_session_count) AS valid_sessions,
              SUM(total_session_count) AS total_sessions,
              MIN(day) AS first_day,
              MAX(day) AS last_day,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  GREATEST(0, FLOOR(SUM(watched_ms)::float / MAX(content_duration_ms)))::int
                ELSE 0
              END AS plays,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  CASE
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 2.0 THEN 'rewatched'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 1.0 THEN 'finished'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.8 THEN 'completed'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.5 THEN 'engaged'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.2 THEN 'sampled'
                    ELSE 'abandoned'
                  END
                ELSE 'unknown'
              END AS engagement_tier
            FROM filtered_daily
            GROUP BY server_user_id, rating_key
          ),
          show_agg AS (
            SELECT
              ca.server_user_id,
              ca.show_title,
              MAX(ca.server_id::text)::uuid AS server_id,
              MAX(ca.thumb_path) AS thumb_path,
              MAX(ca.year) AS year,
              COUNT(DISTINCT ca.rating_key) AS unique_episodes_watched,
              SUM(ca.plays) AS total_episode_plays,
              SUM(ca.cumulative_watched_ms) AS total_watched_ms,
              ROUND(SUM(ca.cumulative_watched_ms) / 1000.0 / 60 / 60, 1) AS total_watch_hours,
              SUM(ca.valid_sessions) AS total_valid_sessions,
              SUM(ca.total_sessions) AS total_all_sessions,
              EXTRACT(DAYS FROM (MAX(ca.last_day) - MIN(ca.first_day)))::int AS viewing_span_days,
              COALESCE(ist.avg_episodes_per_viewing_day, 1.0) AS avg_episodes_per_viewing_day,
              COUNT(*) FILTER (WHERE ca.engagement_tier IN ('completed', 'finished', 'rewatched')) AS completed_episodes,
              COUNT(*) FILTER (WHERE ca.engagement_tier = 'abandoned') AS abandoned_episodes,
              ROUND(100.0 * COUNT(*) FILTER (WHERE ca.engagement_tier IN ('completed', 'finished', 'rewatched'))
                    / NULLIF(COUNT(*), 0), 1) AS episode_completion_rate
            FROM content_agg ca
            LEFT JOIN intensity_stats ist ON ca.server_user_id = ist.server_user_id AND ca.show_title = ist.show_title
            GROUP BY ca.server_user_id, ca.show_title, ist.avg_episodes_per_viewing_day
          )
          SELECT
            show_title,
            MAX(thumb_path) AS thumb_path,
            MAX(server_id::text)::uuid AS server_id,
            MAX(year) AS year,
            SUM(unique_episodes_watched) AS total_episode_views,
            SUM(total_watch_hours) AS total_watch_hours,
            COUNT(DISTINCT server_user_id) AS unique_viewers,
            SUM(total_valid_sessions) AS valid_sessions,
            SUM(total_all_sessions) AS total_sessions,
            ROUND(AVG(unique_episodes_watched), 1) AS avg_episodes_per_viewer,
            ROUND(AVG(episode_completion_rate), 1) AS avg_completion_rate,
            -- Enhanced binge score (0-100): Volume×Quality (60%) + Daily Intensity (40%)
            -- Note: Continuity metrics not available in date-filtered queries
            ROUND(
              LEAST(AVG(unique_episodes_watched) * AVG(episode_completion_rate) / 100, 60) +
              LEAST(AVG(avg_episodes_per_viewing_day) * 8, 40),
            1) AS binge_score
          FROM show_agg
          GROUP BY show_title
          ORDER BY total_episode_views DESC
          LIMIT ${limit}
        `),

      // Engagement tier breakdown (from daily with date filter)
      db.execute(sql`
          WITH filtered_daily AS (
            SELECT * FROM daily_content_engagement
            WHERE ${dailyStartFilter} ${dailyEndFilter} ${serverFilter}
          ),
          content_agg AS (
            SELECT
              server_user_id,
              rating_key,
              MAX(content_duration_ms) AS content_duration_ms,
              SUM(watched_ms) AS cumulative_watched_ms,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  CASE
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 2.0 THEN 'rewatched'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 1.0 THEN 'finished'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.8 THEN 'completed'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.5 THEN 'engaged'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.2 THEN 'sampled'
                    ELSE 'abandoned'
                  END
                ELSE 'unknown'
              END AS engagement_tier
            FROM filtered_daily
            GROUP BY server_user_id, rating_key
          )
          SELECT
            engagement_tier as tier,
            COUNT(*)::int as count
          FROM content_agg
          WHERE engagement_tier != 'unknown'
          GROUP BY engagement_tier
        `),

      // User engagement profiles (top 20, from daily with date filter)
      db.execute(sql`
          WITH filtered_daily AS (
            SELECT * FROM daily_content_engagement
            WHERE ${dailyStartFilter} ${dailyEndFilter} ${serverFilter}
          ),
          content_agg AS (
            SELECT
              server_user_id,
              rating_key,
              MAX(media_type) AS media_type,
              MAX(content_duration_ms) AS content_duration_ms,
              SUM(watched_ms) AS cumulative_watched_ms,
              SUM(valid_session_count) AS valid_sessions,
              SUM(total_session_count) AS total_sessions,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  GREATEST(0, FLOOR(SUM(watched_ms)::float / MAX(content_duration_ms)))::int
                ELSE 0
              END AS plays,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  CASE
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 2.0 THEN 'rewatched'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 1.0 THEN 'finished'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.8 THEN 'completed'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.5 THEN 'engaged'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.2 THEN 'sampled'
                    ELSE 'abandoned'
                  END
                ELSE 'unknown'
              END AS engagement_tier
            FROM filtered_daily
            GROUP BY server_user_id, rating_key
          ),
          user_agg AS (
            SELECT
              server_user_id,
              COUNT(DISTINCT rating_key) AS content_started,
              SUM(plays) AS total_plays,
              SUM(cumulative_watched_ms)::bigint AS total_watched_ms,
              ROUND(SUM(cumulative_watched_ms) / 1000.0 / 60 / 60, 1) AS total_watch_hours,
              SUM(valid_sessions) AS valid_session_count,
              SUM(total_sessions) AS total_session_count,
              COUNT(*) FILTER (WHERE engagement_tier = 'abandoned') AS abandoned_count,
              COUNT(*) FILTER (WHERE engagement_tier = 'sampled') AS sampled_count,
              COUNT(*) FILTER (WHERE engagement_tier = 'engaged') AS engaged_count,
              COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished')) AS completed_count,
              COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') AS rewatched_count,
              ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished', 'rewatched'))
                    / NULLIF(COUNT(*), 0), 1) AS completion_rate,
              CASE
                WHEN COUNT(*) = 0 THEN 'inactive'
                WHEN COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') > COUNT(*) * 0.2 THEN 'rewatcher'
                WHEN COUNT(*) FILTER (WHERE engagement_tier IN ('completed', 'finished', 'rewatched')) > COUNT(*) * 0.7 THEN 'completionist'
                WHEN COUNT(*) FILTER (WHERE engagement_tier = 'abandoned') > COUNT(*) * 0.5 THEN 'sampler'
                ELSE 'casual'
              END AS behavior_type,
              MODE() WITHIN GROUP (ORDER BY media_type) AS favorite_media_type
            FROM content_agg
            GROUP BY server_user_id
          )
          SELECT
            u.server_user_id,
            su.username,
            su.thumb_url,
            usr.name as identity_name,
            u.content_started,
            u.total_plays,
            u.total_watch_hours,
            u.valid_session_count,
            u.total_session_count,
            u.abandoned_count,
            u.sampled_count,
            u.engaged_count,
            u.completed_count,
            u.rewatched_count,
            u.completion_rate,
            u.behavior_type,
            u.favorite_media_type
          FROM user_agg u
          JOIN server_users su ON u.server_user_id = su.id
          LEFT JOIN users usr ON su.user_id = usr.id
          ORDER BY u.total_plays DESC
          LIMIT 20
        `),

      // Summary metrics (from daily with date filter)
      db.execute(sql`
          WITH filtered_daily AS (
            SELECT * FROM daily_content_engagement
            WHERE ${dailyStartFilter} ${dailyEndFilter} ${serverFilter}
          ),
          content_agg AS (
            SELECT
              server_user_id,
              rating_key,
              MAX(content_duration_ms) AS content_duration_ms,
              SUM(watched_ms) AS cumulative_watched_ms,
              SUM(valid_session_count) AS valid_sessions,
              SUM(total_session_count) AS total_sessions,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  GREATEST(0, FLOOR(SUM(watched_ms)::float / MAX(content_duration_ms)))::int
                ELSE 0
              END AS plays,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  ROUND(100.0 * SUM(watched_ms) / MAX(content_duration_ms), 1)
                ELSE 0
              END AS completion_pct
            FROM filtered_daily
            GROUP BY server_user_id, rating_key
          )
          SELECT
            COALESCE(SUM(plays), 0)::bigint as total_plays,
            COALESCE(SUM(valid_sessions), 0)::bigint as total_valid_sessions,
            COALESCE(SUM(total_sessions), 0)::bigint as total_all_sessions,
            ROUND(AVG(completion_pct), 1) as avg_completion_rate
          FROM content_agg
        `),
    ]);

    // Transform top content results
    const topContent: TopContentEngagement[] = (
      topContentResult.rows as {
        rating_key: string;
        media_title: string;
        show_title: string | null;
        media_type: string;
        thumb_path: string | null;
        server_id: string | null;
        year: number | null;
        total_plays: string;
        total_watch_hours: string;
        unique_viewers: string;
        valid_sessions: string;
        total_sessions: string;
        completions: string;
        rewatches: string;
        abandonments: string;
        completion_rate: string;
        abandonment_rate: string;
      }[]
    ).map((row) => ({
      ratingKey: row.rating_key,
      title: row.media_title,
      showTitle: row.show_title,
      type: row.media_type as TopContentEngagement['type'],
      thumbPath: row.thumb_path,
      serverId: row.server_id,
      year: row.year,
      totalPlays: Number(row.total_plays),
      totalWatchHours: Number(row.total_watch_hours),
      uniqueViewers: Number(row.unique_viewers),
      validSessions: Number(row.valid_sessions),
      totalSessions: Number(row.total_sessions),
      completions: Number(row.completions),
      rewatches: Number(row.rewatches),
      abandonments: Number(row.abandonments),
      completionRate: Number(row.completion_rate),
      abandonmentRate: Number(row.abandonment_rate),
    }));

    // Transform top shows results
    const topShows: ShowEngagement[] = (
      topShowsResult.rows as {
        show_title: string;
        thumb_path: string | null;
        server_id: string | null;
        year: number | null;
        total_episode_views: string;
        total_watch_hours: string;
        unique_viewers: string;
        avg_episodes_per_viewer: string;
        avg_completion_rate: string;
        binge_score: string;
        valid_sessions: string;
        total_sessions: string;
      }[]
    ).map((row) => ({
      showTitle: row.show_title,
      thumbPath: row.thumb_path,
      serverId: row.server_id,
      year: row.year,
      totalEpisodeViews: Number(row.total_episode_views),
      totalWatchHours: Number(row.total_watch_hours),
      uniqueViewers: Number(row.unique_viewers),
      avgEpisodesPerViewer: Number(row.avg_episodes_per_viewer),
      avgCompletionRate: Number(row.avg_completion_rate),
      bingeScore: Number(row.binge_score),
      validSessions: Number(row.valid_sessions),
      totalSessions: Number(row.total_sessions),
    }));

    // Calculate engagement tier breakdown with percentages
    const tierCounts = tierBreakdownResult.rows as { tier: EngagementTier; count: number }[];
    const totalTierCount = tierCounts.reduce((sum, t) => sum + t.count, 0);
    const engagementBreakdown: EngagementTierBreakdown[] = tierCounts.map((t) => ({
      tier: t.tier,
      count: t.count,
      percentage: totalTierCount > 0 ? Math.round((t.count / totalTierCount) * 1000) / 10 : 0,
    }));

    // Transform user profiles
    const userProfiles: UserEngagementProfile[] = (
      userProfilesResult.rows as {
        server_user_id: string;
        username: string;
        thumb_url: string | null;
        identity_name: string | null;
        content_started: string;
        total_plays: string;
        total_watch_hours: string;
        valid_session_count: string;
        total_session_count: string;
        abandoned_count: string;
        sampled_count: string;
        engaged_count: string;
        completed_count: string;
        rewatched_count: string;
        completion_rate: string;
        behavior_type: UserBehaviorType;
        favorite_media_type: string | null;
      }[]
    ).map((row) => ({
      serverUserId: row.server_user_id,
      username: row.username,
      thumbUrl: row.thumb_url,
      identityName: row.identity_name,
      contentStarted: Number(row.content_started),
      totalPlays: Number(row.total_plays),
      totalWatchHours: Number(row.total_watch_hours),
      validSessionCount: Number(row.valid_session_count),
      totalSessionCount: Number(row.total_session_count),
      abandonedCount: Number(row.abandoned_count),
      sampledCount: Number(row.sampled_count),
      engagedCount: Number(row.engaged_count),
      completedCount: Number(row.completed_count),
      rewatchedCount: Number(row.rewatched_count),
      completionRate: Number(row.completion_rate),
      behaviorType: row.behavior_type,
      favoriteMediaType: row.favorite_media_type as UserEngagementProfile['favoriteMediaType'],
    }));

    // Calculate summary
    const summaryRow = summaryResult.rows[0] as {
      total_plays: string;
      total_valid_sessions: string;
      total_all_sessions: string;
      avg_completion_rate: string | null;
    };

    const totalPlays = Number(summaryRow.total_plays);
    const totalValidSessions = Number(summaryRow.total_valid_sessions);
    const totalAllSessions = Number(summaryRow.total_all_sessions);

    // Session inflation: how much overcounting would occur using raw sessions vs calculated plays
    const sessionInflationPct =
      totalPlays > 0 ? Math.round(((totalAllSessions - totalPlays) / totalPlays) * 1000) / 10 : 0;

    const response: EngagementStats = {
      topContent,
      topShows,
      engagementBreakdown,
      userProfiles,
      summary: {
        totalPlays,
        totalValidSessions,
        totalAllSessions,
        sessionInflationPct,
        avgCompletionRate: Number(summaryRow.avg_completion_rate ?? 0),
      },
    };

    return response;
  });

  /**
   * GET /shows - Show-level engagement stats with episode rollup
   *
   * Returns paginated list of shows with:
   * - Total episode views (not raw sessions)
   * - Watch hours
   * - Average episodes per viewer
   * - Completion rate and binge score
   */
  app.get('/shows', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = showsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, limit, orderBy } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    // Validate server access
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    const serverFilter = buildServerFilterSql(serverId, authUser);

    // Map orderBy to SQL column
    const orderColumn = {
      totalEpisodeViews: sql`total_episode_views`,
      totalWatchHours: sql`total_watch_hours`,
      bingeScore: sql`binge_score`,
      uniqueViewers: sql`unique_viewers`,
    }[orderBy];

    // For date filtering, aggregate from daily_content_engagement directly
    if (dateRange.start) {
      // Build date filters for the day column in daily_content_engagement
      // Note: The continuous aggregate buckets by UTC day, so we truncate input dates
      // to UTC day boundaries to ensure correct bucket matching
      const dailyStartFilter = sql`day >= date_trunc('day', ${dateRange.start}::timestamptz)`;
      const dailyEndFilter =
        period === 'custom' && dateRange.end
          ? sql`AND day <= date_trunc('day', ${dateRange.end}::timestamptz)`
          : sql``;

      const result = await db.execute(sql`
        WITH filtered_daily AS (
          SELECT * FROM daily_content_engagement
          WHERE ${dailyStartFilter} ${dailyEndFilter}
            AND media_type = 'episode'
            AND show_title IS NOT NULL
            ${serverFilter}
        ),
        -- Daily intensity: episodes per user/show/day
        daily_intensity AS (
          SELECT
            server_user_id,
            show_title,
            day,
            COUNT(DISTINCT rating_key) AS episodes_this_day
          FROM filtered_daily
          WHERE valid_session_count > 0
          GROUP BY server_user_id, show_title, day
        ),
        intensity_stats AS (
          SELECT
            server_user_id,
            show_title,
            COUNT(DISTINCT day) AS total_viewing_days,
            MAX(episodes_this_day) AS max_episodes_in_one_day,
            ROUND(AVG(episodes_this_day), 1) AS avg_episodes_per_viewing_day
          FROM daily_intensity
          GROUP BY server_user_id, show_title
        ),
        content_agg AS (
          SELECT
            server_user_id,
            rating_key,
            show_title,
            MAX(server_id::text)::uuid AS server_id,
            MAX(thumb_path) AS thumb_path,
            MAX(year) AS year,
            MAX(season_number) AS season_number,
            MAX(episode_number) AS episode_number,
            SUM(watched_ms) AS cumulative_watched_ms,
            SUM(valid_session_count) AS valid_sessions,
            SUM(total_session_count) AS total_sessions,
            MAX(content_duration_ms) AS content_duration_ms,
            CASE
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 1.5 THEN 'rewatched'
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.9 THEN 'finished'
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.7 THEN 'completed'
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.25 THEN 'engaged'
              WHEN SUM(valid_session_count) >= 1 THEN 'sampled'
              ELSE 'abandoned'
            END AS engagement_tier
          FROM filtered_daily
          GROUP BY server_user_id, rating_key, show_title
        ),
        show_agg AS (
          SELECT
            ca.server_user_id,
            ca.show_title,
            MAX(ca.server_id::text)::uuid AS server_id,
            MAX(ca.thumb_path) AS thumb_path,
            MAX(ca.year) AS year,
            COUNT(DISTINCT ca.rating_key) AS unique_episodes_watched,
            SUM(ca.cumulative_watched_ms) AS total_watched_ms,
            ROUND(SUM(ca.cumulative_watched_ms) / 1000.0 / 60 / 60, 1) AS total_watch_hours,
            SUM(ca.valid_sessions) AS total_valid_sessions,
            SUM(ca.total_sessions) AS total_all_sessions,
            COALESCE(ist.avg_episodes_per_viewing_day, 1.0) AS avg_episodes_per_viewing_day,
            COUNT(*) FILTER (WHERE ca.engagement_tier IN ('completed', 'finished', 'rewatched')) AS completed_episodes,
            ROUND(100.0 * COUNT(*) FILTER (WHERE ca.engagement_tier IN ('completed', 'finished', 'rewatched'))
                  / NULLIF(COUNT(*), 0), 1) AS episode_completion_rate
          FROM content_agg ca
          LEFT JOIN intensity_stats ist ON ca.server_user_id = ist.server_user_id AND ca.show_title = ist.show_title
          GROUP BY ca.server_user_id, ca.show_title, ist.avg_episodes_per_viewing_day
        )
        SELECT
          show_title,
          MAX(server_id::text)::uuid AS server_id,
          MAX(thumb_path) AS thumb_path,
          MAX(year) AS year,
          SUM(unique_episodes_watched)::bigint AS total_episode_views,
          SUM(total_watch_hours)::numeric AS total_watch_hours,
          COUNT(DISTINCT server_user_id)::bigint AS unique_viewers,
          SUM(total_valid_sessions)::bigint AS valid_sessions,
          SUM(total_all_sessions)::bigint AS total_sessions,
          ROUND(AVG(unique_episodes_watched), 1) AS avg_episodes_per_viewer,
          ROUND(AVG(episode_completion_rate), 1) AS avg_completion_rate,
          -- Enhanced binge score (0-100): Volume×Quality (60%) + Daily Intensity (40%)
          ROUND(
            LEAST(AVG(unique_episodes_watched) * AVG(episode_completion_rate) / 100, 60) +
            LEAST(AVG(avg_episodes_per_viewing_day) * 8, 40),
          1) AS binge_score
        FROM show_agg
        GROUP BY show_title
        ORDER BY ${orderColumn} DESC
        LIMIT ${limit}
      `);

      const data: ShowEngagement[] = (
        result.rows as {
          show_title: string;
          thumb_path: string | null;
          server_id: string | null;
          year: number | null;
          total_episode_views: string;
          total_watch_hours: string;
          unique_viewers: string;
          avg_episodes_per_viewer: string;
          avg_completion_rate: string;
          binge_score: string;
          valid_sessions: string;
          total_sessions: string;
        }[]
      ).map((row) => ({
        showTitle: row.show_title,
        thumbPath: row.thumb_path,
        serverId: row.server_id,
        year: row.year,
        totalEpisodeViews: Number(row.total_episode_views),
        totalWatchHours: Number(row.total_watch_hours),
        uniqueViewers: Number(row.unique_viewers),
        avgEpisodesPerViewer: Number(row.avg_episodes_per_viewer),
        avgCompletionRate: Number(row.avg_completion_rate),
        bingeScore: Number(row.binge_score),
        validSessions: Number(row.valid_sessions),
        totalSessions: Number(row.total_sessions),
      }));

      const response: ShowStatsResponse = {
        data,
        total: data.length,
      };

      return response;
    }

    // Use the materialized view for all-time queries
    const result = await db.execute(sql`
      SELECT
        show_title,
        thumb_path,
        server_id,
        year,
        total_episode_views,
        total_watch_hours,
        unique_viewers,
        avg_episodes_per_viewer,
        avg_completion_rate,
        binge_score,
        total_valid_sessions as valid_sessions,
        total_all_sessions as total_sessions
      FROM top_shows_by_engagement
      WHERE show_title IS NOT NULL
      ${serverFilter}
      ORDER BY ${orderColumn} DESC
      LIMIT ${limit}
    `);

    const data: ShowEngagement[] = (
      result.rows as {
        show_title: string;
        thumb_path: string | null;
        server_id: string | null;
        year: number | null;
        total_episode_views: string;
        total_watch_hours: string;
        unique_viewers: string;
        avg_episodes_per_viewer: string;
        avg_completion_rate: string;
        binge_score: string;
        valid_sessions: string;
        total_sessions: string;
      }[]
    ).map((row) => ({
      showTitle: row.show_title,
      thumbPath: row.thumb_path,
      serverId: row.server_id,
      year: row.year,
      totalEpisodeViews: Number(row.total_episode_views),
      totalWatchHours: Number(row.total_watch_hours),
      uniqueViewers: Number(row.unique_viewers),
      avgEpisodesPerViewer: Number(row.avg_episodes_per_viewer),
      avgCompletionRate: Number(row.avg_completion_rate),
      bingeScore: Number(row.binge_score),
      validSessions: Number(row.valid_sessions),
      totalSessions: Number(row.total_sessions),
    }));

    const response: ShowStatsResponse = {
      data,
      total: data.length,
    };

    return response;
  });
};
