/** Per-user play reads: totals, per-account counts and the recent plays page. */

import { sql, type SQL } from 'drizzle-orm';
import type { db as defaultDb } from '../../../db/client.js';
import { sessions } from '../../../db/schema.js';
import { uuidArraySql } from '../../../utils/sqlArrays.js';
import { firstSegmentJoin, groupedPlaysCte } from '../../../db/sessions/groupedPlays.js';
import { localSessionSql, PLAY_COUNT, RAW_WATCH_TIME } from '../../../db/sessions/rules.js';

// Accept either the default db or a transaction context
type DbOrTx = typeof defaultDb;

/**
 * Build a `<columnRef> = ANY(...)` SQL fragment for a raw query.
 */
export function serverUserIdAnyFragment(ids: string[], columnRef = 'server_user_id') {
  return sql`${sql.raw(columnRef)} = ANY(${uuidArraySql(ids)})`;
}

export interface StartedAtWindow {
  start: Date;
  end: Date;
}

/**
 * The User pages' history horizon. A literal started_at range is a plan-time bound,
 * so TimescaleDB excludes chunks instead of planning the whole hypertable.
 */
export function userHistoryWindow(): StartedAtWindow {
  const end = new Date();
  return { start: new Date(end.getTime() - 10 * 365 * 24 * 60 * 60 * 1000), end };
}

function accountsInWindow(serverUserIds: string[], window: StartedAtWindow): SQL {
  return sql`${sessions.serverUserId} = ANY(${uuidArraySql(serverUserIds)})
    AND ${sessions.startedAt} >= ${window.start}
    AND ${sessions.startedAt} <= ${window.end}`;
}

/** Raw session rows per account, one grouped read instead of a count per account. */
export async function userSessionCounts(
  dbOrTx: DbOrTx,
  serverUserIds: string[],
  window: StartedAtWindow
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (serverUserIds.length === 0) return counts;
  const rows = await dbOrTx
    .select({ serverUserId: sessions.serverUserId, count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(accountsInWindow(serverUserIds, window))
    .groupBy(sessions.serverUserId);
  for (const row of rows) counts.set(row.serverUserId, row.count);
  return counts;
}

/** Plays (not raw rows) and watch time across the accounts. */
export async function userPlayTotals(
  dbOrTx: DbOrTx,
  serverUserIds: string[],
  window: StartedAtWindow
): Promise<{ totalSessions: number; totalWatchTime: number }> {
  const [row] = await dbOrTx
    .select({
      totalSessions: PLAY_COUNT,
      totalWatchTime: RAW_WATCH_TIME,
    })
    .from(sessions)
    .where(accountsInWindow(serverUserIds, window));
  return {
    totalSessions: row?.totalSessions ?? 0,
    totalWatchTime: Number(row?.totalWatchTime ?? 0),
  };
}

interface UserPlaySqlRow {
  id: string;
  started_at: Date;
  stopped_at: Date | null;
  duration_ms: string | null;
  progress_ms: number | null;
  total_duration_ms: number | null;
  segment_count: string;
  watched: boolean;
  state: string;
  server_id: string;
  server_name: string;
  server_user_id: string;
  session_key: string;
  media_type: string;
  media_title: string;
  grandparent_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  year: number | null;
  thumb_path: string | null;
  media_id: string | null;
  show_media_id: string | null;
  rating_key: string | null;
  external_session_id: string | null;
  reference_id: string | null;
  ip_address: string | null;
  geo_city: string | null;
  geo_region: string | null;
  geo_country: string | null;
  geo_continent: string | null;
  geo_postal: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
  geo_asn_number: number | null;
  geo_asn_organization: string | null;
  is_local: boolean;
  player_name: string | null;
  device_id: string | null;
  product: string | null;
  device: string | null;
  platform: string | null;
  quality: string | null;
  is_transcode: boolean | null;
  bitrate: number | null;
  last_paused_at: Date | null;
  paused_duration_ms: string | null;
}

function mapUserPlayRow(row: UserPlaySqlRow) {
  return {
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    serverUserId: row.server_user_id,
    sessionKey: row.session_key,
    state: row.state,
    mediaType: row.media_type,
    mediaTitle: row.media_title,
    grandparentTitle: row.grandparent_title,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    year: row.year,
    thumbPath: row.thumb_path,
    mediaId: row.media_id,
    showMediaId: row.show_media_id,
    ratingKey: row.rating_key,
    externalSessionId: row.external_session_id,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    totalDurationMs: row.total_duration_ms,
    progressMs: row.progress_ms,
    lastPausedAt: row.last_paused_at,
    pausedDurationMs: row.paused_duration_ms != null ? Number(row.paused_duration_ms) : null,
    referenceId: row.reference_id,
    watched: row.watched,
    segmentCount: Number(row.segment_count),
    ipAddress: row.ip_address,
    geoCity: row.geo_city,
    geoRegion: row.geo_region,
    geoCountry: row.geo_country,
    geoContinent: row.geo_continent,
    geoPostal: row.geo_postal,
    geoLat: row.geo_lat,
    geoLon: row.geo_lon,
    geoAsnNumber: row.geo_asn_number,
    geoAsnOrganization: row.geo_asn_organization,
    isLocal: row.is_local === true,
    playerName: row.player_name,
    deviceId: row.device_id,
    product: row.product,
    device: row.device,
    platform: row.platform,
    quality: row.quality,
    isTranscode: row.is_transcode,
    bitrate: row.bitrate,
  };
}

export type UserPlayRow = ReturnType<typeof mapUserPlayRow>;

/** The accounts' plays newest first, pause/resume chains collapsed to one row. */
export async function userRecentPlays(
  dbOrTx: DbOrTx,
  serverUserIds: string[],
  window: StartedAtWindow,
  page: { limit: number; offset?: number }
): Promise<UserPlayRow[]> {
  const bounds = [sql`s.started_at >= ${window.start}`, sql`s.started_at <= ${window.end}`];
  const result = await dbOrTx.execute(sql`
    WITH grouped_sessions AS (${groupedPlaysCte({
      where: [serverUserIdAnyFragment(serverUserIds, 's.server_user_id'), ...bounds],
      orderLimit: sql`ORDER BY MIN(s.started_at) DESC LIMIT ${page.limit} OFFSET ${page.offset ?? 0}`,
    })})
    SELECT
      gs.play_id AS id,
      gs.started_at, gs.stopped_at, gs.duration_ms, gs.paused_duration_ms,
      gs.progress_ms, gs.total_duration_ms, gs.segment_count, gs.watched, gs.state,
      s.server_id, sv.name AS server_name, s.server_user_id, s.session_key,
      s.media_type, s.media_title, s.grandparent_title, s.season_number,
      s.episode_number, s.year, s.thumb_path, s.media_id, s.show_media_id,
      s.rating_key, s.external_session_id,
      s.reference_id, s.ip_address, s.geo_city, s.geo_region, s.geo_country,
      s.geo_continent, s.geo_postal, s.geo_lat, s.geo_lon,
      s.geo_asn_number, s.geo_asn_organization,
      ${localSessionSql('s')} AS is_local,
      s.player_name, s.device_id, s.product, s.device, s.platform,
      s.quality, s.is_transcode, s.bitrate, s.last_paused_at
    FROM grouped_sessions gs
    ${firstSegmentJoin({ alias: 'gs', boundsFrom: 'grouped_sessions' }, bounds)}
    JOIN servers sv ON sv.id = s.server_id
    ORDER BY gs.started_at DESC
  `);
  return (result.rows as unknown as UserPlaySqlRow[]).map(mapUserPlayRow);
}
