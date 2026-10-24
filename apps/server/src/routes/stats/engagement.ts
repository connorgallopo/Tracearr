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
import { resolveServerIds } from '../../utils/serverFiltering.js';
import { scopedServerFragment, viewScope } from '../../lib/scope.js';

export const engagementRoutes: FastifyPluginAsync = async (app) => {
  const readStats = { preHandler: [app.requirePermission('stats', 'read')] };
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
  app.get('/engagement', readStats, async (request, reply) => {
    const query = engagementQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds, mediaType, limit } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const serverFilter = scopedServerFragment(resolvedIds, await viewScope(request));
    // The aggregate buckets by UTC day: the start truncates to its bucket, and the exclusive
    // end keeps every bucket that starts before it
    const dailyStartFilter = dateRange.start
      ? sql`day >= date_trunc('day', ${dateRange.start}::timestamptz)`
      : sql`true`;
    const dailyEndFilter = period === 'custom' ? sql`AND day < ${dateRange.end}` : sql``;
    const mediaTypeFilter = mediaType ? sql`AND media_type = ${mediaType}` : sql``;

    // Run combined + shows queries in parallel (2 instead of 5)
    // The combined query computes filtered_daily and content_agg once, then branches
    // into top_content, tier_breakdown, user_profiles, and summary as JSON columns.
    // Shows query stays separate because it needs the daily_intensity CTE.
    const [combinedResult, topShowsResult] = await Promise.all([
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
              MAX(max_progress_ms) AS max_progress_ms,
              SUM(valid_session_count) AS valid_sessions,
              SUM(total_session_count) AS total_sessions,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  GREATEST(
                    CASE WHEN COALESCE(MAX(max_progress_ms), 0) >= MAX(content_duration_ms) * 0.85 THEN 1
                         WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.85 THEN 1
                         ELSE 0 END,
                    FLOOR(SUM(watched_ms)::float / MAX(content_duration_ms))
                  )::int
                ELSE 0
              END AS plays,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  ROUND(100.0 * GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) / MAX(content_duration_ms), 1)
                ELSE 0
              END AS completion_pct,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  CASE
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 2.0 THEN 'rewatched'
                    WHEN COALESCE(MAX(max_progress_ms), 0) >= MAX(content_duration_ms) * 0.85 THEN 'watched'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.85 THEN 'watched'
                    WHEN GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) >= MAX(content_duration_ms) * 0.5 THEN 'engaged'
                    WHEN GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) >= MAX(content_duration_ms) * 0.2 THEN 'sampled'
                    ELSE 'abandoned'
                  END
                ELSE 'unknown'
              END AS engagement_tier
            FROM filtered_daily
            GROUP BY server_user_id, rating_key
          ),
          top_content_data AS (
            SELECT
              ca.rating_key,
              ca.media_title,
              ca.show_title,
              ca.media_type,
              ca.thumb_path,
              ca.server_id,
              ca.year,
              SUM(ca.plays) AS total_plays,
              ROUND(SUM(ca.cumulative_watched_ms) / 1000.0 / 60 / 60, 1) AS total_watch_hours,
              COUNT(DISTINCT su.user_id) AS unique_viewers,
              SUM(ca.valid_sessions) AS valid_sessions,
              SUM(ca.total_sessions) AS total_sessions,
              COUNT(*) FILTER (WHERE ca.engagement_tier IN ('watched', 'rewatched')) AS completions,
              COUNT(*) FILTER (WHERE ca.engagement_tier = 'rewatched') AS rewatches,
              COUNT(*) FILTER (WHERE ca.engagement_tier = 'abandoned') AS abandonments,
              ROUND(100.0 * COUNT(*) FILTER (WHERE ca.engagement_tier IN ('watched', 'rewatched'))
                    / NULLIF(COUNT(*), 0), 1) AS completion_rate,
              ROUND(100.0 * COUNT(*) FILTER (WHERE ca.engagement_tier = 'abandoned')
                    / NULLIF(COUNT(*), 0), 1) AS abandonment_rate
            FROM content_agg ca
            -- Groups are per rating_key (server-scoped), where an identity has at most one
            -- account, so su.user_id counts match server_user_id counts; the join keeps the
            -- viewer metric identity-based if this ever gains cross-server title dedup.
            JOIN server_users su ON su.id = ca.server_user_id
            WHERE true ${mediaTypeFilter}
            GROUP BY ca.rating_key, ca.media_title, ca.show_title, ca.media_type, ca.content_duration_ms, ca.thumb_path, ca.server_id, ca.year
            ORDER BY total_plays DESC
            LIMIT ${limit}
          ),
          tier_breakdown_data AS (
            SELECT
              engagement_tier AS tier,
              COUNT(*)::int AS count
            FROM content_agg
            WHERE engagement_tier != 'unknown'
            GROUP BY engagement_tier
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
              COUNT(*) FILTER (WHERE engagement_tier = 'watched') AS watched_count,
              COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') AS rewatched_count,
              ROUND(100.0 * COUNT(*) FILTER (WHERE engagement_tier IN ('watched', 'rewatched'))
                    / NULLIF(COUNT(*), 0), 1) AS completion_rate,
              CASE
                WHEN COUNT(*) = 0 THEN 'inactive'
                WHEN COUNT(*) FILTER (WHERE engagement_tier = 'rewatched') > COUNT(*) * 0.2 THEN 'rewatcher'
                WHEN COUNT(*) FILTER (WHERE engagement_tier IN ('watched', 'rewatched')) > COUNT(*) * 0.7 THEN 'completionist'
                WHEN COUNT(*) FILTER (WHERE engagement_tier = 'abandoned') > COUNT(*) * 0.5 THEN 'sampler'
                ELSE 'casual'
              END AS behavior_type,
              MODE() WITHIN GROUP (ORDER BY media_type) AS favorite_media_type
            FROM content_agg
            GROUP BY server_user_id
          ),
          user_profiles_data AS (
            SELECT
              u.server_user_id,
              su.username,
              su.thumb_url,
              usr.name AS identity_name,
              u.content_started,
              u.total_plays,
              u.total_watch_hours,
              u.valid_session_count,
              u.total_session_count,
              u.abandoned_count,
              u.sampled_count,
              u.engaged_count,
              u.watched_count,
              u.rewatched_count,
              u.completion_rate,
              u.behavior_type,
              u.favorite_media_type
            FROM user_agg u
            JOIN server_users su ON u.server_user_id = su.id
            LEFT JOIN users usr ON su.user_id = usr.id
            ORDER BY u.total_plays DESC
            LIMIT 20
          ),
          summary_data AS (
            SELECT
              COALESCE(SUM(plays), 0)::bigint AS total_plays,
              COALESCE(SUM(valid_sessions), 0)::bigint AS total_valid_sessions,
              COALESCE(SUM(total_sessions), 0)::bigint AS total_all_sessions,
              ROUND(AVG(completion_pct), 1) AS avg_completion_rate
            FROM content_agg
          )
          SELECT
            (SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM top_content_data t) AS top_content,
            (SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM tier_breakdown_data t) AS tier_breakdown,
            (SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM user_profiles_data t) AS user_profiles,
            (SELECT row_to_json(t) FROM summary_data t) AS summary
        `),

      // Top shows - separate query (needs daily_intensity CTE)
      db.execute(sql`
          WITH filtered_daily AS (
            -- canonical_show_id folds a merged-loser show id to its winner
            -- (mirrors value_rollup's alias fold in catalog.ts) so a show that
            -- exists on two servers, or was merged after the fact, collapses
            -- below instead of appearing twice. am is only null for unstamped
            -- episodes, which fall back to the normalized-title key.
            SELECT
              d.*,
              COALESCE(am.merged_into_id, d.show_media_id) AS canonical_show_id
            FROM daily_content_engagement d
            LEFT JOIN media am ON am.id = d.show_media_id
            WHERE ${dailyStartFilter} ${dailyEndFilter} ${serverFilter}
            AND d.media_type = 'episode' AND d.show_title IS NOT NULL
            AND (am.id IS NULL OR am.media_type = 'show')
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
              MAX(canonical_show_id::text)::uuid AS canonical_show_id,
              MAX(thumb_path) AS thumb_path,
              MAX(server_id::text)::uuid AS server_id,
              MAX(year) AS year,
              MAX(season_number) AS season_number,
              MAX(episode_number) AS episode_number,
              MAX(content_duration_ms) AS content_duration_ms,
              SUM(watched_ms) AS cumulative_watched_ms,
              MAX(max_progress_ms) AS max_progress_ms,
              SUM(valid_session_count) AS valid_sessions,
              SUM(total_session_count) AS total_sessions,
              MIN(day) AS first_day,
              MAX(day) AS last_day,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  GREATEST(
                    CASE WHEN COALESCE(MAX(max_progress_ms), 0) >= MAX(content_duration_ms) * 0.85 THEN 1
                         WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.85 THEN 1
                         ELSE 0 END,
                    FLOOR(SUM(watched_ms)::float / MAX(content_duration_ms))
                  )::int
                ELSE 0
              END AS plays,
              CASE
                WHEN MAX(content_duration_ms) > 0 THEN
                  CASE
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 2.0 THEN 'rewatched'
                    WHEN COALESCE(MAX(max_progress_ms), 0) >= MAX(content_duration_ms) * 0.85 THEN 'watched'
                    WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.85 THEN 'watched'
                    WHEN GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) >= MAX(content_duration_ms) * 0.5 THEN 'engaged'
                    WHEN GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) >= MAX(content_duration_ms) * 0.2 THEN 'sampled'
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
              MAX(ca.canonical_show_id::text)::uuid AS canonical_show_id,
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
              COUNT(*) FILTER (WHERE ca.engagement_tier IN ('watched', 'rewatched')) AS completed_episodes,
              COUNT(*) FILTER (WHERE ca.engagement_tier = 'abandoned') AS abandoned_episodes,
              ROUND(100.0 * COUNT(*) FILTER (WHERE ca.engagement_tier IN ('watched', 'rewatched'))
                    / NULLIF(COUNT(*), 0), 1) AS episode_completion_rate
            FROM content_agg ca
            LEFT JOIN intensity_stats ist ON ca.server_user_id = ist.server_user_id AND ca.show_title = ist.show_title
            GROUP BY ca.server_user_id, ca.show_title, ist.avg_episodes_per_viewing_day
          ),
          with_dedup_key AS (
            SELECT
              sa.*,
              COALESCE(
                sa.canonical_show_id::text,
                'title:' || NULLIF(LOWER(REGEXP_REPLACE(sa.show_title, '[^a-zA-Z0-9]', '', 'g')), ''),
                'raw:' || sa.show_title
              ) AS dedup_key
            FROM show_agg sa
          )
          SELECT
            MAX(wdk.show_title) AS show_title,
            MAX(wdk.thumb_path) AS thumb_path,
            MAX(wdk.server_id::text)::uuid AS server_id,
            MAX(wdk.year) AS year,
            SUM(wdk.unique_episodes_watched) AS total_episode_views,
            SUM(wdk.total_watch_hours) AS total_watch_hours,
            COUNT(DISTINCT su.user_id) AS unique_viewers,
            SUM(wdk.total_valid_sessions) AS valid_sessions,
            SUM(wdk.total_all_sessions) AS total_sessions,
            ROUND(AVG(wdk.unique_episodes_watched), 1) AS avg_episodes_per_viewer,
            ROUND(AVG(wdk.episode_completion_rate), 1) AS avg_completion_rate,
            -- Enhanced binge score (0-100): Volume×Quality (60%) + Daily Intensity (40%)
            -- Note: Continuity metrics not available in date-filtered queries
            ROUND(
              LEAST(AVG(wdk.unique_episodes_watched) * AVG(wdk.episode_completion_rate) / 100, 60) +
              LEAST(AVG(wdk.avg_episodes_per_viewing_day) * 8, 40),
            1) AS binge_score
          FROM with_dedup_key wdk
          JOIN server_users su ON su.id = wdk.server_user_id
          GROUP BY wdk.dedup_key
          ORDER BY total_episode_views DESC
          LIMIT ${limit}
        `),
    ]);

    // Parse combined query results from JSON columns
    const combinedRow = combinedResult.rows[0] as {
      top_content: unknown;
      tier_breakdown: unknown;
      user_profiles: unknown;
      summary: unknown;
    };
    const topContentRows = combinedRow.top_content as {
      rating_key: string;
      media_title: string;
      show_title: string | null;
      media_type: string;
      thumb_path: string | null;
      server_id: string | null;
      year: number | null;
      total_plays: number;
      total_watch_hours: number;
      unique_viewers: number;
      valid_sessions: number;
      total_sessions: number;
      completions: number;
      rewatches: number;
      abandonments: number;
      completion_rate: number;
      abandonment_rate: number;
    }[];
    const tierRows = combinedRow.tier_breakdown as { tier: EngagementTier; count: number }[];
    const userProfileRows = combinedRow.user_profiles as {
      server_user_id: string;
      username: string;
      thumb_url: string | null;
      identity_name: string | null;
      content_started: number;
      total_plays: number;
      total_watch_hours: number;
      valid_session_count: number;
      total_session_count: number;
      abandoned_count: number;
      sampled_count: number;
      engaged_count: number;
      watched_count: number;
      rewatched_count: number;
      completion_rate: number;
      behavior_type: UserBehaviorType;
      favorite_media_type: string | null;
    }[];
    const summaryRow = combinedRow.summary as {
      total_plays: string;
      total_valid_sessions: string;
      total_all_sessions: string;
      avg_completion_rate: string | null;
    };

    // Transform top content results (already parsed from JSON)
    const topContent: TopContentEngagement[] = topContentRows.map((row) => ({
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
    const tierCounts = tierRows;
    const totalTierCount = tierCounts.reduce((sum, t) => sum + t.count, 0);
    const engagementBreakdown: EngagementTierBreakdown[] = tierCounts.map((t) => ({
      tier: t.tier,
      count: t.count,
      percentage: totalTierCount > 0 ? Math.round((t.count / totalTierCount) * 1000) / 10 : 0,
    }));

    // Transform user profiles (already parsed from JSON)
    const userProfiles: UserEngagementProfile[] = userProfileRows.map((row) => ({
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
      watchedCount: Number(row.watched_count),
      rewatchedCount: Number(row.rewatched_count),
      completionRate: Number(row.completion_rate),
      behaviorType: row.behavior_type,
      favoriteMediaType: row.favorite_media_type as UserEngagementProfile['favoriteMediaType'],
    }));

    // Calculate summary (summaryRow already parsed from JSON above)
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
  app.get('/shows', readStats, async (request, reply) => {
    const query = showsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds, limit, orderBy } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);
    const scope = await viewScope(request);
    const serverFilter = scopedServerFragment(resolvedIds, scope);

    // Map orderBy to SQL column
    const orderColumn = {
      totalEpisodeViews: sql`total_episode_views`,
      totalWatchHours: sql`total_watch_hours`,
      bingeScore: sql`binge_score`,
      uniqueViewers: sql`unique_viewers`,
    }[orderBy];

    // For date filtering, aggregate from daily_content_engagement directly. A member always
    // takes this branch: top_shows_by_engagement has no server_user_id to scope by.
    if (dateRange.start || scope !== 'all') {
      // Same bucket rule as the engagement route above
      const dailyStartFilter = dateRange.start
        ? sql`day >= date_trunc('day', ${dateRange.start}::timestamptz)`
        : sql`true`;
      const dailyEndFilter =
        period === 'custom' && dateRange.end ? sql`AND day < ${dateRange.end}` : sql``;

      const result = await db.execute(sql`
        WITH filtered_daily AS (
          -- canonical_show_id folds a merged-loser show id to its winner
          -- (mirrors value_rollup's alias fold in catalog.ts) so a show that
          -- exists on two servers, or was merged after the fact, collapses
          -- below instead of appearing twice. am is only null for unstamped
          -- episodes, which fall back to the normalized-title key.
          SELECT
            d.*,
            COALESCE(am.merged_into_id, d.show_media_id) AS canonical_show_id
          FROM daily_content_engagement d
          LEFT JOIN media am ON am.id = d.show_media_id
          WHERE ${dailyStartFilter} ${dailyEndFilter}
            AND d.media_type = 'episode'
            AND d.show_title IS NOT NULL
            AND (am.id IS NULL OR am.media_type = 'show')
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
            MAX(canonical_show_id::text)::uuid AS canonical_show_id,
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
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 2.0 THEN 'rewatched'
              WHEN COALESCE(MAX(max_progress_ms), 0) >= MAX(content_duration_ms) * 0.85 THEN 'watched'
              WHEN SUM(watched_ms) >= MAX(content_duration_ms) * 0.85 THEN 'watched'
              WHEN GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) >= MAX(content_duration_ms) * 0.5 THEN 'engaged'
              WHEN GREATEST(COALESCE(MAX(max_progress_ms), 0), SUM(watched_ms)) >= MAX(content_duration_ms) * 0.2 THEN 'sampled'
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
            MAX(ca.canonical_show_id::text)::uuid AS canonical_show_id,
            MAX(ca.server_id::text)::uuid AS server_id,
            MAX(ca.thumb_path) AS thumb_path,
            MAX(ca.year) AS year,
            COUNT(DISTINCT ca.rating_key) AS unique_episodes_watched,
            SUM(ca.cumulative_watched_ms) AS total_watched_ms,
            ROUND(SUM(ca.cumulative_watched_ms) / 1000.0 / 60 / 60, 1) AS total_watch_hours,
            SUM(ca.valid_sessions) AS total_valid_sessions,
            SUM(ca.total_sessions) AS total_all_sessions,
            COALESCE(ist.avg_episodes_per_viewing_day, 1.0) AS avg_episodes_per_viewing_day,
            COUNT(*) FILTER (WHERE ca.engagement_tier IN ('watched', 'rewatched')) AS completed_episodes,
            ROUND(100.0 * COUNT(*) FILTER (WHERE ca.engagement_tier IN ('watched', 'rewatched'))
                  / NULLIF(COUNT(*), 0), 1) AS episode_completion_rate
          FROM content_agg ca
          LEFT JOIN intensity_stats ist ON ca.server_user_id = ist.server_user_id AND ca.show_title = ist.show_title
          GROUP BY ca.server_user_id, ca.show_title, ist.avg_episodes_per_viewing_day
        ),
        with_dedup_key AS (
          SELECT
            sa.*,
            COALESCE(
              sa.canonical_show_id::text,
              'title:' || NULLIF(LOWER(REGEXP_REPLACE(sa.show_title, '[^a-zA-Z0-9]', '', 'g')), ''),
              'raw:' || sa.show_title
            ) AS dedup_key
          FROM show_agg sa
        )
        SELECT
          MAX(wdk.show_title) AS show_title,
          MAX(wdk.server_id::text)::uuid AS server_id,
          MAX(wdk.thumb_path) AS thumb_path,
          MAX(wdk.year) AS year,
          SUM(wdk.unique_episodes_watched)::bigint AS total_episode_views,
          SUM(wdk.total_watch_hours)::numeric AS total_watch_hours,
          COUNT(DISTINCT su.user_id)::bigint AS unique_viewers,
          SUM(wdk.total_valid_sessions)::bigint AS valid_sessions,
          SUM(wdk.total_all_sessions)::bigint AS total_sessions,
          ROUND(AVG(wdk.unique_episodes_watched), 1) AS avg_episodes_per_viewer,
          ROUND(AVG(wdk.episode_completion_rate), 1) AS avg_completion_rate,
          -- Enhanced binge score (0-100): Volume×Quality (60%) + Daily Intensity (40%)
          ROUND(
            LEAST(AVG(wdk.unique_episodes_watched) * AVG(wdk.episode_completion_rate) / 100, 60) +
            LEAST(AVG(wdk.avg_episodes_per_viewing_day) * 8, 40),
          1) AS binge_score
        FROM with_dedup_key wdk
        JOIN server_users su ON su.id = wdk.server_user_id
        GROUP BY wdk.dedup_key
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
