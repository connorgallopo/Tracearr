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
import {
  PLAYS_MEDIA_GROUPS,
  type DayOfWeekStats,
  type HourOfDayStats,
  type PlayStats,
  type PlaysMediaGroup,
  type QualityStats,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { MEDIA_TYPE_SQL_FILTER, PLAYS_MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';
import { countedSessionSql } from '../../db/sessions/rules.js';
import { playbackDecisionSql } from '../../utils/playbackDecisionSql.js';

/** Movies and episodes only, unless the caller counts every media type like the plays aggregate. */
function primaryMediaFilter(allMediaTypes: boolean | undefined): SQL {
  return allMediaTypes ? sql`` : MEDIA_TYPE_SQL_FILTER;
}

/**
 * The pieces groupBy=mediaType adds to an Activity query: a media_group column, the filter
 * widened to music, and media_group as the last GROUP BY and ORDER BY key. Without it the
 * column and key are empty and the filter is the usual one, so that SQL is unchanged.
 */
function mediaGroupFragments(
  groupByMediaType: boolean | undefined,
  allMediaTypes: boolean | undefined
): { column: SQL; filter: SQL; key: SQL } {
  if (!groupByMediaType) {
    return { column: sql``, filter: primaryMediaFilter(allMediaTypes), key: sql`` };
  }
  return {
    column: sql`,
      CASE media_type WHEN 'movie' THEN 'movie' WHEN 'episode' THEN 'show' ELSE 'music' END AS media_group`,
    filter: PLAYS_MEDIA_TYPE_SQL_FILTER,
    key: sql`, media_group`,
  };
}

interface MediaGroupCount {
  count: number;
  media_group?: PlaysMediaGroup;
}

/** One zero-filled set of slots, or one set per media group when the rows are grouped. */
function fillSlots<R extends MediaGroupCount, T extends object>(
  rows: R[],
  slotOf: (row: R) => number,
  groupByMediaType: boolean | undefined,
  slots: (countAt: (slot: number) => number) => T[]
): (T & { mediaType?: PlaysMediaGroup })[] {
  const groups = groupByMediaType ? PLAYS_MEDIA_GROUPS : [undefined];
  return groups.flatMap((mediaType) => {
    const counts = new Map(
      rows.filter((row) => row.media_group === mediaType).map((row) => [slotOf(row), row.count])
    );
    const filled = slots((slot) => counts.get(slot) ?? 0);
    return mediaType ? filled.map((row) => ({ ...row, mediaType })) : filled;
  });
}

// ============================================================================
// Plays Over Time
// ============================================================================

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
  allMediaTypes?: boolean;
  groupByMediaType?: boolean;
}): Promise<PlayStats[]> {
  const { rangeStart, timezone, bucketInterval, serverFilter, endDate, mediaTypeFilter } = params;
  const group = mediaGroupFragments(params.groupByMediaType, params.allMediaTypes);

  const baseWhere = rangeStart
    ? sql`WHERE started_at >= ${rangeStart} AND ${countedSessionSql()}`
    : sql`WHERE ${countedSessionSql()}`;

  const result = await db.execute(sql`
    SELECT
      time_bucket(${bucketInterval}::interval, started_at AT TIME ZONE ${timezone})::text AS date,
      server_id::text AS "serverId",
      COUNT(DISTINCT COALESCE(reference_id, id))::int AS count${group.column}
    FROM sessions
    ${baseWhere}
    ${group.filter}
    ${mediaTypeFilter ?? sql``}
    ${endDate ? sql`AND started_at < ${endDate}` : sql``}
    ${serverFilter}
    GROUP BY 1, 2${group.key}
    ORDER BY 1, 2${group.key}
  `);

  const rows = result.rows as unknown as (PlayStats & MediaGroupCount)[];
  if (!params.groupByMediaType) return rows;
  return rows.map(({ media_group, ...row }) => ({ ...row, mediaType: media_group }));
}

// ============================================================================
// Plays By Day of Week
// ============================================================================

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
  allMediaTypes?: boolean;
  groupByMediaType?: boolean;
}): Promise<DayOfWeekStats[]> {
  const { rangeStart, timezone, serverFilter, endDate } = params;
  const group = mediaGroupFragments(params.groupByMediaType, params.allMediaTypes);

  const baseWhere = rangeStart
    ? sql`WHERE started_at >= ${rangeStart} AND ${countedSessionSql()}`
    : sql`WHERE ${countedSessionSql()}`;

  const result = await db.execute(sql`
    SELECT
      EXTRACT(DOW FROM started_at AT TIME ZONE ${timezone})::int AS day,
      COUNT(DISTINCT COALESCE(reference_id, id))::int AS count${group.column}
    FROM sessions
    ${baseWhere}
    ${group.filter}
    ${endDate ? sql`AND started_at < ${endDate}` : sql``}
    ${serverFilter}
    GROUP BY 1${group.key}
    ORDER BY 1${group.key}
  `);

  return fillSlots(
    result.rows as unknown as (MediaGroupCount & { day: number })[],
    (row) => row.day,
    params.groupByMediaType,
    (countAt) => DAY_NAMES.map((name, day) => ({ day, name, count: countAt(day) }))
  );
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
  allMediaTypes?: boolean;
  groupByMediaType?: boolean;
}): Promise<HourOfDayStats[]> {
  const { rangeStart, timezone, serverFilter, endDate } = params;
  const group = mediaGroupFragments(params.groupByMediaType, params.allMediaTypes);

  const baseWhere = rangeStart
    ? sql`WHERE started_at >= ${rangeStart} AND ${countedSessionSql()}`
    : sql`WHERE ${countedSessionSql()}`;

  const result = await db.execute(sql`
    SELECT
      EXTRACT(HOUR FROM started_at AT TIME ZONE ${timezone})::int AS hour,
      COUNT(DISTINCT COALESCE(reference_id, id))::int AS count${group.column}
    FROM sessions
    ${baseWhere}
    ${group.filter}
    ${endDate ? sql`AND started_at < ${endDate}` : sql``}
    ${serverFilter}
    GROUP BY 1${group.key}
    ORDER BY 1${group.key}
  `);

  return fillSlots(
    result.rows as unknown as (MediaGroupCount & { hour: number })[],
    (row) => row.hour,
    params.groupByMediaType,
    (countAt) => Array.from({ length: 24 }, (_, hour) => ({ hour, count: countAt(hour) }))
  );
}

// ============================================================================
// Concurrent Streams
// ============================================================================

export interface ConcurrentRow {
  hour: string;
  total: number;
  direct: number;
  directStream: number;
  /** Every transcode, audio-only ones included. */
  transcode: number;
  /** The audio-only part of `transcode`. */
  audioTranscode: number;
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
      SELECT started_at, stopped_at, ${playbackDecisionSql()} AS tier
      FROM sessions
      WHERE stopped_at IS NOT NULL
        ${MEDIA_TYPE_SQL_FILTER}
        ${serverFilter}
        AND stopped_at >= ${rangeStart}
        AND started_at < ${rangeEnd}
    ),
    events AS (
      SELECT started_at AS event_time,
        CASE WHEN tier = 'directplay' THEN 1 ELSE 0 END AS direct_delta,
        CASE WHEN tier = 'copy' THEN 1 ELSE 0 END AS copy_delta,
        CASE WHEN tier IN ('transcode', 'audio_transcode') THEN 1 ELSE 0 END AS transcode_delta,
        CASE WHEN tier = 'audio_transcode' THEN 1 ELSE 0 END AS audio_transcode_delta
      FROM filtered_sessions
      UNION ALL
      SELECT stopped_at AS event_time,
        CASE WHEN tier = 'directplay' THEN -1 ELSE 0 END AS direct_delta,
        CASE WHEN tier = 'copy' THEN -1 ELSE 0 END AS copy_delta,
        CASE WHEN tier IN ('transcode', 'audio_transcode') THEN -1 ELSE 0 END AS transcode_delta,
        CASE WHEN tier = 'audio_transcode' THEN -1 ELSE 0 END AS audio_transcode_delta
      FROM filtered_sessions
    ),
    running AS (
      SELECT
        event_time,
        SUM(direct_delta) OVER (ORDER BY event_time) AS direct,
        SUM(copy_delta) OVER (ORDER BY event_time) AS copy,
        SUM(transcode_delta) OVER (ORDER BY event_time) AS transcode,
        SUM(audio_transcode_delta) OVER (ORDER BY event_time) AS audio_transcode
      FROM events
    ),
    with_total AS (
      SELECT event_time, direct, copy, transcode, audio_transcode,
        (direct + copy + transcode) AS total
      FROM running
      WHERE event_time >= ${rangeStart}
    ),
    ranked AS (
      SELECT
        time_bucket(${bucketInterval}::interval, event_time) AS bucket,
        direct, copy, transcode, audio_transcode, total,
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
      transcode::int,
      audio_transcode::int
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
      audio_transcode: number;
    }[]
  ).map((r) => ({
    hour: r.hour,
    total: r.total,
    direct: r.direct,
    directStream: r.direct_stream,
    transcode: r.transcode,
    audioTranscode: r.audio_transcode,
  }));
}

// ============================================================================
// Platforms
// ============================================================================

export interface PlatformRow {
  platform: string | null;
  count: number;
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
      COUNT(DISTINCT COALESCE(reference_id, id))::int AS count
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

export type QualityBreakdown = QualityStats;

/**
 * Compute quality breakdown with percentages from raw tier counts.
 * Shared between the raw SQL path and the prepared statement path in quality.ts.
 */
export function computeQualityBreakdown(qualityRows: QualityRow[]): QualityBreakdown {
  const directPlay = qualityRows.find((q) => q.tier === 'directplay')?.count ?? 0;
  const directStream = qualityRows.find((q) => q.tier === 'copy')?.count ?? 0;
  const audioTranscode = qualityRows.find((q) => q.tier === 'audio_transcode')?.count ?? 0;
  const transcode = (qualityRows.find((q) => q.tier === 'transcode')?.count ?? 0) + audioTranscode;
  const total = directPlay + directStream + transcode;
  const percent = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

  return {
    directPlay,
    directStream,
    transcode,
    audioTranscode,
    total,
    directPlayPercent: percent(directPlay),
    directStreamPercent: percent(directStream),
    transcodePercent: percent(transcode),
    audioTranscodePercent: percent(audioTranscode),
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
      ${playbackDecisionSql()} AS tier,
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
