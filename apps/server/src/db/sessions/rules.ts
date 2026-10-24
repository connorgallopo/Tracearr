import { sql, type SQL } from 'drizzle-orm';
import { LOCAL_NETWORK_COUNTRY } from '@tracearr/shared';

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

/** History's default media filter when no type is asked for: everything but trailers. */
export function historyMediaTypeDefault(alias = 's'): SQL {
  return sql.raw(`${alias}.media_type <> 'trailer'`);
}

/** Raw watch time over every row, uncounted ones included: the users pages' total. */
export const RAW_WATCH_TIME = sql<number>`coalesce(sum(duration_ms), 0)::bigint`;
