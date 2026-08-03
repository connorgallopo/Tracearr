/**
 * Shared Activity Query Functions
 *
 * Extracted SQL queries used by both the internal stats routes and the public API.
 * Each function executes a single query against the sessions table and returns
 * typed rows. Auth, validation, and response shaping remain in the route handlers.
 *
 * All play-counting queries use engagement-based filtering (>= 2 min sessions)
 * and deduplicate via COALESCE(reference_id, id) to avoid counting resume chains
 * as separate plays.
 */

import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';

// Sessions shorter than 2 minutes are not counted as intentional plays
const MIN_PLAY_DURATION_MS = 120000;

// ============================================================================
// Plays Over Time
// ============================================================================

export interface PlaysOverTimeRow {
  date: string;
  count: number;
  serverId: string;
}

/**
 * Play counts bucketed over time with timezone-aware grouping, broken out per server.
 * Queries sessions directly so server_id is always available in the GROUP BY.
 * The daily_content_engagement view only exposes server_id at the aggregate level,
 * so querying sessions directly avoids a more complex join while keeping the same
 * >= 2 min engagement threshold and COALESCE(reference_id, id) deduplication.
 */
export async function queryPlaysOverTime(params: {
  rangeStart: Date | null;
  timezone: string;
  bucketInterval: string;
  serverFilter: SQL;
  endDate?: Date;
  mediaTypeFilter?: SQL;
}): Promise<PlaysOverTimeRow[]> {
  const { rangeStart, timezone, bucketInterval, serverFilter, endDate, mediaTypeFilter } = params;

  const baseWhere = rangeStart
    ? sql`WHERE started_at >= ${rangeStart} AND duration_ms >= ${MIN_PLAY_DURATION_MS}`
    : sql`WHERE duration_ms >= ${MIN_PLAY_DURATION_MS}`;

  const result = await db.execute(sql`
    SELECT
      time_bucket(${bucketInterval}::interval, started_at AT TIME ZONE ${timezone})::text AS date,
      server_id::text AS "serverId",
      COUNT(DISTINCT COALESCE(reference_id, id))::int AS count
    FROM sessions
    ${baseWhere}
    ${MEDIA_TYPE_SQL_FILTER}
    ${mediaTypeFilter ?? sql``}
    ${endDate ? sql`AND started_at < ${endDate}` : sql``}
    ${serverFilter}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);

  return result.rows as unknown as PlaysOverTimeRow[];
}

// ============================================================================
// Plays By Day of Week
// ============================================================================

export interface DayOfWeekRow {
  day: number;
  count: number;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Play counts grouped by day of week (0 = Sunday, 6 = Saturday).
 * Returns all 7 days, filling missing days with count 0.
 */
export async function queryPlaysByDayOfWeek(params: {
  rangeStart: Date | null;
  timezone: string;
  serverFilter: SQL;
  endDate?: Date;
}): Promise<{ day: number; name: string; count: number }[]> {
  const { rangeStart, timezone, serverFilter, endDate } = params;

  const baseWhere = rangeStart
    ? sql`WHERE started_at >= ${rangeStart} AND duration_ms >= ${MIN_PLAY_DURATION_MS}`
    : sql`WHERE duration_ms >= ${MIN_PLAY_DURATION_MS}`;

  const result = await db.execute(sql`
    SELECT
      EXTRACT(DOW FROM started_at AT TIME ZONE ${timezone})::int AS day,
      COUNT(DISTINCT COALESCE(reference_id, id))::int AS count
    FROM sessions
    ${baseWhere}
    ${MEDIA_TYPE_SQL_FILTER}
    ${endDate ? sql`AND started_at < ${endDate}` : sql``}
    ${serverFilter}
    GROUP BY 1
    ORDER BY 1
  `);

  const dayStats = result.rows as unknown as DayOfWeekRow[];
  const dayMap = new Map(dayStats.map((d) => [d.day, d.count]));

  return Array.from({ length: 7 }, (_, i) => ({
    day: i,
    name: DAY_NAMES[i]!,
    count: dayMap.get(i) ?? 0,
  }));
}

// ============================================================================
// Plays By Hour of Day
// ============================================================================

/**
 * Play counts grouped by hour of day (0-23).
 * Returns all 24 hours, filling missing hours with count 0.
 */
export async function queryPlaysByHourOfDay(params: {
  rangeStart: Date | null;
  timezone: string;
  serverFilter: SQL;
  endDate?: Date;
}): Promise<{ hour: number; count: number }[]> {
  const { rangeStart, timezone, serverFilter, endDate } = params;

  const baseWhere = rangeStart
    ? sql`WHERE started_at >= ${rangeStart} AND duration_ms >= ${MIN_PLAY_DURATION_MS}`
    : sql`WHERE duration_ms >= ${MIN_PLAY_DURATION_MS}`;

  const result = await db.execute(sql`
    SELECT
      EXTRACT(HOUR FROM started_at AT TIME ZONE ${timezone})::int AS hour,
      COUNT(DISTINCT COALESCE(reference_id, id))::int AS count
    FROM sessions
    ${baseWhere}
    ${MEDIA_TYPE_SQL_FILTER}
    ${endDate ? sql`AND started_at < ${endDate}` : sql``}
    ${serverFilter}
    GROUP BY 1
    ORDER BY 1
  `);

  const hourStats = result.rows as unknown as { hour: number; count: number }[];
  const hourMap = new Map(hourStats.map((h) => [h.hour, h.count]));

  return Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    count: hourMap.get(i) ?? 0,
  }));
}

// ============================================================================
// Concurrent Streams
// ============================================================================

export interface ConcurrentRow {
  hour: string;
  total: number;
  direct: number;
  directStream: number;
  transcode: number;
}

/**
 * Peak concurrent streams per time bucket using an event-based algorithm.
 * Treats each session start as +1 and stop as -1, calculates running totals
 * via window functions, then takes the peak per bucket.
 */
export async function queryConcurrentStreams(params: {
  rangeStart: Date;
  rangeEnd: Date;
  bucketInterval: string;
  serverFilter: SQL;
}): Promise<ConcurrentRow[]> {
  const { rangeStart, rangeEnd, bucketInterval, serverFilter } = params;

  const result = await db.execute(sql`
    WITH filtered_sessions AS (
      SELECT started_at, stopped_at, is_transcode, video_decision, audio_decision
      FROM sessions
      WHERE stopped_at IS NOT NULL
        ${MEDIA_TYPE_SQL_FILTER}
        ${serverFilter}
        AND stopped_at >= ${rangeStart}
        AND started_at <= ${rangeEnd}
    ),
    events AS (
      SELECT started_at AS event_time,
        CASE WHEN is_transcode = false AND COALESCE(video_decision, 'directplay') != 'copy' AND COALESCE(audio_decision, 'directplay') != 'copy' THEN 1 ELSE 0 END AS direct_delta,
        CASE WHEN is_transcode = false AND (COALESCE(video_decision, 'directplay') = 'copy' OR COALESCE(audio_decision, 'directplay') = 'copy') THEN 1 ELSE 0 END AS copy_delta,
        CASE WHEN is_transcode = true THEN 1 ELSE 0 END AS transcode_delta
      FROM filtered_sessions
      UNION ALL
      SELECT stopped_at AS event_time,
        CASE WHEN is_transcode = false AND COALESCE(video_decision, 'directplay') != 'copy' AND COALESCE(audio_decision, 'directplay') != 'copy' THEN -1 ELSE 0 END AS direct_delta,
        CASE WHEN is_transcode = false AND (COALESCE(video_decision, 'directplay') = 'copy' OR COALESCE(audio_decision, 'directplay') = 'copy') THEN -1 ELSE 0 END AS copy_delta,
        CASE WHEN is_transcode = true THEN -1 ELSE 0 END AS transcode_delta
      FROM filtered_sessions
    ),
    running AS (
      SELECT
        event_time,
        SUM(direct_delta) OVER (ORDER BY event_time) AS direct,
        SUM(copy_delta) OVER (ORDER BY event_time) AS copy,
        SUM(transcode_delta) OVER (ORDER BY event_time) AS transcode
      FROM events
    ),
    with_total AS (
      SELECT event_time, direct, copy, transcode,
        (direct + copy + transcode) AS total
      FROM running
      WHERE event_time >= ${rangeStart}
    ),
    ranked AS (
      SELECT
        time_bucket(${bucketInterval}::interval, event_time) AS bucket,
        direct, copy, transcode, total,
        ROW_NUMBER() OVER (
          PARTITION BY time_bucket(${bucketInterval}::interval, event_time)
          ORDER BY total DESC, event_time
        ) AS rn
      FROM with_total
    )
    SELECT
      bucket::text AS hour,
      total::int,
      direct::int,
      copy::int AS direct_stream,
      transcode::int
    FROM ranked
    WHERE rn = 1
    ORDER BY bucket
  `);

  return (
    result.rows as unknown as {
      hour: string;
      total: number;
      direct: number;
      direct_stream: number;
      transcode: number;
    }[]
  ).map((r) => ({
    hour: r.hour,
    total: r.total,
    direct: r.direct,
    directStream: r.direct_stream,
    transcode: r.transcode,
  }));
}

// ============================================================================
// Platforms
// ============================================================================

export interface PlatformRow {
  platform: string | null;
  count: number;
  watchTimeHours: number;
}

/**
 * Session counts grouped by client platform, sorted by count descending.
 * Does not apply engagement filtering - counts all sessions in the range.
 */
export async function queryPlatforms(params: {
  rangeStart: Date | null;
  serverFilter: SQL;
}): Promise<PlatformRow[]> {
  const { rangeStart, serverFilter } = params;

  const result = await db.execute(sql`
    SELECT
      platform,
      COUNT(DISTINCT COALESCE(reference_id, id))::int AS count,
      ROUND(COALESCE(SUM(duration_ms), 0) / 3600000.0, 1)::float AS "watchTimeHours"
    FROM sessions
    WHERE true
    ${MEDIA_TYPE_SQL_FILTER}
    ${serverFilter}
    ${rangeStart ? sql`AND started_at >= ${rangeStart}` : sql``}
    GROUP BY platform
    ORDER BY count DESC
  `);

  return result.rows as unknown as PlatformRow[];
}

// ============================================================================
// Quality Breakdown
// ============================================================================

export interface QualityRow {
  tier: string;
  count: number;
}

export interface QualityBreakdown {
  directPlay: number;
  directStream: number;
  transcode: number;
  total: number;
  directPlayPercent: number;
  directStreamPercent: number;
  transcodePercent: number;
}

/**
 * Compute quality breakdown with percentages from raw tier counts.
 * Shared between the raw SQL path and the prepared statement path in quality.ts.
 */
export function computeQualityBreakdown(qualityRows: QualityRow[]): QualityBreakdown {
  const directPlay = qualityRows.find((q) => q.tier === 'directplay')?.count ?? 0;
  const directStream = qualityRows.find((q) => q.tier === 'copy')?.count ?? 0;
  const transcode = qualityRows.find((q) => q.tier === 'transcode')?.count ?? 0;
  const total = directPlay + directStream + transcode;

  return {
    directPlay,
    directStream,
    transcode,
    total,
    directPlayPercent: total > 0 ? Math.round((directPlay / total) * 100) : 0,
    directStreamPercent: total > 0 ? Math.round((directStream / total) * 100) : 0,
    transcodePercent: total > 0 ? Math.round((transcode / total) * 100) : 0,
  };
}

/**
 * Direct play / direct stream / transcode breakdown with percentages.
 * Does not apply engagement filtering - counts all sessions in the range.
 */
export async function queryQualityBreakdown(params: {
  rangeStart: Date | null;
  serverFilter: SQL;
}): Promise<QualityBreakdown> {
  const { rangeStart, serverFilter } = params;

  const result = await db.execute(sql`
    SELECT
      CASE
        WHEN is_transcode = true THEN 'transcode'
        WHEN video_decision = 'copy' OR audio_decision = 'copy' THEN 'copy'
        ELSE 'directplay'
      END AS tier,
      COUNT(DISTINCT COALESCE(reference_id, id))::int AS count
    FROM sessions
    WHERE true
    ${MEDIA_TYPE_SQL_FILTER}
    ${serverFilter}
    ${rangeStart ? sql`AND started_at >= ${rangeStart}` : sql``}
    GROUP BY tier
  `);

  return computeQualityBreakdown(result.rows as unknown as QualityRow[]);
}
