/**
 * Engagement Statistics Routes
 *
 * GET /engagement - Comprehensive engagement metrics with Netflix-style play counting
 *
 * This endpoint uses the engagement tracking system which:
 * - Filters sessions < 2 minutes (Netflix "intent" threshold)
 * - Calculates plays as cumulative_time / content_duration
 * - Groups sessions into engagement tiers (abandoned -> rewatched)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  engagementQuerySchema,
  type EngagementTier,
  type UserBehaviorType,
  type EngagementTierBreakdown,
  type UserEngagementProfile,
  type EngagementStats,
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
   * - engagementBreakdown: Distribution across engagement tiers
   * - userProfiles: User behavior classification
   * - summary: Overall metrics including session inflation percentage
   */
  app.get('/engagement', readStats, async (request, reply) => {
    const query = engagementQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId, serverIds } = query.data;
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

    // One statement computes filtered_daily and content_agg once, then branches into
    // tier_breakdown, user_profiles, and summary as JSON columns.
    const combinedResult = await db.execute(sql`
          WITH filtered_daily AS (
            SELECT * FROM daily_content_engagement
            WHERE ${dailyStartFilter} ${dailyEndFilter} ${serverFilter}
          ),
          content_agg AS (
            SELECT
              server_user_id,
              rating_key,
              MAX(media_type) AS media_type,
              SUM(watched_ms) AS cumulative_watched_ms,
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
            (SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM tier_breakdown_data t) AS tier_breakdown,
            (SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM user_profiles_data t) AS user_profiles,
            (SELECT row_to_json(t) FROM summary_data t) AS summary
        `);

    // Parse combined query results from JSON columns
    const combinedRow = combinedResult.rows[0] as {
      tier_breakdown: unknown;
      user_profiles: unknown;
      summary: unknown;
    };
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
};
