import { sql, type SQL } from 'drizzle-orm';
import { LOCAL_NETWORK_COUNTRY, TIME_MS } from '@tracearr/shared';

export interface LocalSessionFields {
  isLocal?: boolean | null;
  geoCountry: string | null;
  geoCity: string | null;
  geoLat: number | null;
}

/**
 * The flag decides once set. Before the location sync has classified a row its label does:
 * the Local Network sentinel, or the pre-2025-12-22 'Local' city, which never had coordinates.
 */
export function isLocalSession(row: LocalSessionFields): boolean {
  if (row.isLocal != null) return row.isLocal;
  return (
    row.geoCountry === LOCAL_NETWORK_COUNTRY ||
    (row.geoCity?.toLowerCase() === 'local' && row.geoLat === null)
  );
}

// Inlined, not bound: GROUP BY only matches a SELECT expression whose text is identical.
const LOCAL_LABEL = sql.raw(`'${LOCAL_NETWORK_COUNTRY}'`);

/** isLocalSession in SQL. Never NULL, so NOT (...) selects every remote row. */
export function localSessionSql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.is_local IS TRUE OR (${a}.is_local IS NULL AND (${a}.geo_country IS NOT DISTINCT FROM ${LOCAL_LABEL} OR (lower(${a}.geo_city) IS NOT DISTINCT FROM 'local' AND ${a}.geo_lat IS NULL))))`;
}

// Count unique plays: COALESCE(reference_id, id) collapses pause/resume chains into one play
export function playCountSql(alias = ''): SQL {
  const col = alias ? `${alias}.` : '';
  return sql.raw(`count(distinct coalesce(${col}reference_id, ${col}id))`);
}

export const PLAY_COUNT = sql<number>`${playCountSql()}::int`;

// A session counts toward plays and watch time once it runs 2 minutes or passes the
// watched threshold for its media type, so a track or short film played to the end counts.
// Gates on duration, not short_session: the flag is unset on some imported history
export function countedSession(alias = ''): string {
  const col = alias ? `${alias}.` : '';
  return `(COALESCE(${col}duration_ms, 0) >= 120000 OR ${col}watched)`;
}

export const countedSessionSql = (alias?: string): SQL => sql.raw(countedSession(alias));

/**
 * Viewers of a title, show, genre or library: distinct identities with at least one counted
 * play, so viewers never exceed plays. `counted` is the row shape's counted test:
 * countedSessionSql(alias) on sessions, `p.counted` on user_media_plays_daily.
 */
export function countedViewersSql(counted: SQL, userCol: SQL = sql`su.user_id`): SQL {
  return sql`COUNT(DISTINCT ${userCol}) FILTER (WHERE ${counted})`;
}

/** History's default media filter when no type is asked for: everything but trailers. */
export function historyMediaTypeDefault(alias = 's'): SQL {
  return sql.raw(`${alias}.media_type <> 'trailer'`);
}

/** Raw watch time over every row, uncounted ones included: the users pages' total. */
export const RAW_WATCH_TIME = sql<number>`coalesce(sum(duration_ms), 0)::bigint`;

/** The first UTC midnight at or after a date; a date already on a midnight is unchanged. */
export function ceilToUtcDay(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / TIME_MS.DAY) * TIME_MS.DAY);
}

/**
 * A window over a UTC day column. `day` is a UTC bucket, so a preset's start rounds up to the
 * next UTC midnight: N days cover exactly N UTC days ending today, like the show page. A
 * custom start is already a midnight and is exact. Compares the column itself so the bound
 * stays sargable and can exclude chunks.
 */
export function rollupDayWindowSql(
  window: { startDate: Date | null; endDate: Date },
  dayCol: SQL
): SQL {
  const lower = window.startDate
    ? sql` AND ${dayCol} >= ${ceilToUtcDay(window.startDate)}::timestamptz`
    : sql``;
  return sql`${lower} AND ${dayCol} < ${window.endDate}::timestamptz`;
}

/** The last `days` UTC days ending today, for rollupDayWindowSql; null is all time. */
export function lastDaysWindow(
  days: number | null,
  now = new Date()
): { startDate: Date | null; endDate: Date } {
  return {
    startDate: days === null ? null : new Date(now.getTime() - days * TIME_MS.DAY),
    endDate: now,
  };
}
