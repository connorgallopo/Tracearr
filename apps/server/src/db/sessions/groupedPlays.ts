import { sql, type SQL } from 'drizzle-orm';

// Display-only bound for the segments breakdown; core aggregation has no such cap.
const CHAIN_WINDOW_DAYS = 30;
const CHAIN_WINDOW_INTERVAL = sql.raw(`INTERVAL '${CHAIN_WINDOW_DAYS} days'`);

function whereClause(where: SQL[]): SQL {
  return where.length > 0 ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;
}

/**
 * The body of a CTE with one row per play (a reference_id chain or a lone session) over
 * sessions aliased s: play_id, started_at, stopped_at, duration_ms, paused_duration_ms,
 * progress_ms, total_duration_ms, segment_count, watched, first_session_id, state.
 */
export function groupedPlaysCte(opts: { where: SQL[]; having?: SQL; orderLimit?: SQL }): SQL {
  return sql`
    SELECT
      COALESCE(s.reference_id, s.id) as play_id,
      MIN(s.started_at) as started_at,
      MAX(s.stopped_at) as stopped_at,
      SUM(COALESCE(s.duration_ms, 0)) as duration_ms,
      SUM(COALESCE(s.paused_duration_ms, 0)) as paused_duration_ms,
      MAX(s.progress_ms) as progress_ms,
      MAX(s.total_duration_ms) as total_duration_ms,
      COUNT(*) as segment_count,
      BOOL_OR(s.watched) as watched,
      (array_agg(s.id ORDER BY s.started_at))[1] as first_session_id,
      (array_agg(s.state ORDER BY s.started_at DESC))[1] as state
    FROM sessions s
    ${whereClause(opts.where)}
    GROUP BY COALESCE(s.reference_id, s.id)
    ${opts.having ? sql`HAVING ${opts.having}` : sql``}
    ${opts.orderLimit ?? sql``}
  `;
}

/**
 * Join from the plays aliased `alias` back to each play's first segment as s. The InitPlan
 * bounds read `startColumn` from `boundsFrom` and let TimescaleDB exclude chunks at runtime,
 * but the planner still plans every chunk for them; the window conditions, re-applied verbatim,
 * are what drop chunks at plan time. A play's first segment always sits inside the window.
 */
export function firstSegmentJoin(
  plays: { alias: string; boundsFrom: string; startColumn?: string },
  windowConditions: SQL[]
): SQL {
  const alias = sql.raw(plays.alias);
  const from = sql.raw(plays.boundsFrom);
  const start = sql.raw(plays.startColumn ?? 'started_at');
  const window = sql.join(
    windowConditions.map((condition) => sql`AND ${condition}`),
    sql` `
  );
  return sql`
    JOIN sessions s ON s.id = ${alias}.first_session_id AND s.started_at = ${alias}.${start}
      AND s.started_at >= (SELECT MIN(${start}) FROM ${from})
      AND s.started_at <= (SELECT MAX(${start}) FROM ${from})
      ${window}
  `;
}

/** History's per-play segments breakdown as lat.segments, up to 20 segments of a chain. */
export function playSegmentsLateral(alias: string, startDate: Date | undefined): SQL {
  const c = sql.raw(alias);
  const segmentWindow = startDate
    ? sql`AND s2.started_at >= ${startDate}::timestamptz - ${CHAIN_WINDOW_INTERVAL}`
    : sql``;
  return sql`
    LEFT JOIN LATERAL (
      SELECT json_agg(sub ORDER BY sub.started_at) AS segments
      FROM (
        SELECT s2.started_at, s2.stopped_at, s2.duration_ms, s2.paused_duration_ms
        FROM sessions s2
        WHERE COALESCE(s2.reference_id, s2.id) = ${c}.play_id
          AND ${c}.segment_count > 1
          AND s2.started_at >= ${c}.started_at - ${CHAIN_WINDOW_INTERVAL}
          ${segmentWindow}
        ORDER BY s2.started_at
        LIMIT 20
      ) sub
    ) lat ON true
  `;
}

export function playCountQuery(where: SQL[]): SQL {
  return sql`
    SELECT COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as count
    FROM sessions s
    ${whereClause(where)}
  `;
}
