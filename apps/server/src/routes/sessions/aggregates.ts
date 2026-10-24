import { sql } from 'drizzle-orm';
import type { HistoryAggregates } from '@tracearr/shared';
import { db } from '../../db/client.js';

export async function fetchHistoryAggregates(
  whereClause: ReturnType<typeof sql>,
  resolvedIds: string[] | undefined
): Promise<HistoryAggregates> {
  // Unique Titles KPI. Single-server: COUNT(DISTINCT media_title), matching main exactly.
  // Multi-server: dedupe by canonical media identity - a merged-loser id folds to its
  // winner via media.merged_into_id (mirrors value_rollup's alias fold in catalog.ts) -
  // falling back to an ASCII-stripped title+year key, then the raw title (catches non-Latin
  // titles the strip empties out), then the per-server rating key for titleless sessions.
  // A session with none of those resolves to NULL, which COUNT(DISTINCT) already excludes.
  const singleServer = resolvedIds?.length === 1;
  const mediaJoinFragment = singleServer ? sql`` : sql`LEFT JOIN media am ON am.id = s.media_id`;
  const uniqueContentExpr = singleServer
    ? sql`COUNT(DISTINCT s.media_title)`
    : sql`COUNT(DISTINCT
        COALESCE(
          COALESCE(am.merged_into_id, s.media_id)::text,
          'title:' || NULLIF(LOWER(REGEXP_REPLACE(COALESCE(s.media_title, ''), '[^a-zA-Z0-9]', '', 'g')), '') || ':' || COALESCE(s.year::text, ''),
          'raw:' || NULLIF(s.media_title, ''),
          'rk:' || s.server_id || ':' || NULLIF(s.rating_key, '')
        )
      )`;

  // uniqueUsers is counted by identity (server_users.user_id), not by
  // account, so a person merged across two servers in the filtered set
  // counts once - consistent with unique_content's cross-server dedup.
  const aggregateResult = await db.execute(sql`
    SELECT
      COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as play_count,
      COALESCE(SUM(s.duration_ms), 0)::bigint as total_watch_time_ms,
      COALESCE(SUM(s.duration_ms) FILTER (WHERE s.media_type = 'track'), 0)::bigint as listen_time_ms,
      COUNT(DISTINCT su_agg.user_id)::int as unique_users,
      ${uniqueContentExpr}::int as unique_content
    FROM sessions s
    JOIN server_users su_agg ON su_agg.id = s.server_user_id
    ${mediaJoinFragment}
    ${whereClause}
  `);

  const result = aggregateResult.rows[0] as {
    play_count: number;
    total_watch_time_ms: string;
    listen_time_ms: string;
    unique_users: number;
    unique_content: number;
  };

  const aggregates: HistoryAggregates = {
    totalWatchTimeMs: Number(result.total_watch_time_ms),
    listenTimeMs: Number(result.listen_time_ms),
    playCount: result.play_count,
    uniqueUsers: result.unique_users,
    uniqueContent: result.unique_content,
  };

  return aggregates;
}
