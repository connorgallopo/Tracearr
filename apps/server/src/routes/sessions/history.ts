import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  PLAYBACK_DECISIONS,
  type AuthUser,
  type HistoryAggregatesQueryInput,
  type HistoryQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import {
  baseSessionConditions,
  firstSegmentJoin,
  groupedPlaysCte,
  historyMediaTypeDefault,
  localSessionSql,
  playCountQuery,
  playSegmentsLateral,
  startedAtRange,
  whereClause,
} from '../../db/sessions/index.js';
import { playbackDecisionSql, subtitleBurnInSql } from '../../utils/playbackDecisionSql.js';
import type { Scope } from '../../lib/scope.js';
import type { HistoryRow } from './historyRow.js';

/**
 * Result from building history filter conditions.
 * Returns null if user has no server access (caller should return empty result).
 */
type HistoryFilterResult = {
  conditions: SQL[];
  whereClause: SQL;
} | null;

/**
 * Build WHERE clause conditions for history queries.
 * Shared between /history and /history/aggregates endpoints.
 *
 * @returns null if user has no server access (caller should return empty result)
 */
export function buildHistoryFilterConditions(
  params: HistoryAggregatesQueryInput,
  authUser: AuthUser,
  scope: Scope
): HistoryFilterResult {
  const {
    serverUserIds,
    serverId,
    serverIds: rawServerIds,
    state,
    mediaTypes,
    startDate,
    endDate,
    search,
    platforms,
    product,
    device,
    playerName,
    ipAddress,
    geoCountries,
    geoCity,
    geoRegion,
    geoCityMissing,
    geoRegionMissing,
    network,
    transcodeDecisions,
    subtitleBurnIn,
    watched,
    excludeShortSessions,
  } = params;

  const conditions = baseSessionConditions({
    authUser,
    serverId,
    serverIds: rawServerIds,
    scope,
    startDate,
    endDate,
  });
  if (!conditions) return null;

  if (serverUserIds && serverUserIds.length > 0) {
    const ids = serverUserIds as string[];
    if (ids.length === 1) {
      conditions.push(sql`s.server_user_id = ${ids[0]}`);
    } else {
      const userIdList = ids.map((id) => sql`${id}`);
      conditions.push(sql`s.server_user_id IN (${sql.join(userIdList, sql`, `)})`);
    }
  }
  if (state) conditions.push(sql`s.state = ${state}`);
  if (mediaTypes && mediaTypes.length > 0) {
    const types = mediaTypes as string[];
    if (types.length === 1) {
      conditions.push(sql`s.media_type = ${types[0]}`);
    } else {
      const mediaTypeList = types.map((t) => sql`${t}`);
      conditions.push(sql`s.media_type IN (${sql.join(mediaTypeList, sql`, `)})`);
    }
  } else {
    conditions.push(historyMediaTypeDefault());
  }

  // Full-text search across multiple fields
  if (search) {
    const searchPattern = `%${search}%`;
    conditions.push(
      sql`(
          s.media_title ILIKE ${searchPattern}
          OR s.grandparent_title ILIKE ${searchPattern}
          OR s.geo_city ILIKE ${searchPattern}
          OR s.geo_country ILIKE ${searchPattern}
          OR s.ip_address ILIKE ${searchPattern}
          OR s.platform ILIKE ${searchPattern}
          OR s.product ILIKE ${searchPattern}
          OR EXISTS (
            SELECT 1 FROM server_users su_search
            LEFT JOIN users u_search ON u_search.id = su_search.user_id
            WHERE su_search.id = s.server_user_id
            AND (su_search.username ILIKE ${searchPattern} OR u_search.name ILIKE ${searchPattern})
          )
        )`
    );
  }

  if (platforms && platforms.length > 0) {
    const plats = platforms as string[];
    if (plats.length === 1) {
      conditions.push(sql`s.platform = ${plats[0]}`);
    } else {
      const platformList = plats.map((p) => sql`${p}`);
      conditions.push(sql`s.platform IN (${sql.join(platformList, sql`, `)})`);
    }
  }
  if (product) conditions.push(sql`s.product = ${product}`);
  if (device) conditions.push(sql`s.device = ${device}`);
  if (playerName) conditions.push(sql`s.player_name ILIKE ${`%${playerName}%`}`);

  if (ipAddress) conditions.push(sql`s.ip_address = ${ipAddress}`);
  if (geoCountries && geoCountries.length > 0) {
    const countries = geoCountries as string[];
    if (countries.length === 1) {
      conditions.push(sql`s.geo_country = ${countries[0]}`);
    } else {
      const countryList = countries.map((c) => sql`${c}`);
      conditions.push(sql`s.geo_country IN (${sql.join(countryList, sql`, `)})`);
    }
  }
  if (geoCity) conditions.push(sql`s.geo_city = ${geoCity}`);
  if (geoRegion) conditions.push(sql`s.geo_region = ${geoRegion}`);
  if (geoCityMissing) conditions.push(sql`s.geo_city IS NULL`);
  if (geoRegionMissing) conditions.push(sql`s.geo_region IS NULL`);
  if (network === 'local') conditions.push(localSessionSql('s'));
  if (network === 'remote') conditions.push(sql`NOT ${localSessionSql('s')}`);

  if (
    transcodeDecisions &&
    transcodeDecisions.length > 0 &&
    transcodeDecisions.length < PLAYBACK_DECISIONS.length
  ) {
    const decisionList = transcodeDecisions.map((d) => sql`${d}`);
    conditions.push(sql`${playbackDecisionSql('s')} IN (${sql.join(decisionList, sql`, `)})`);
  }

  // Status filters
  if (watched !== undefined) conditions.push(sql`s.watched = ${watched}`);
  if (subtitleBurnIn !== undefined)
    conditions.push(subtitleBurnIn ? subtitleBurnInSql('s') : sql`NOT ${subtitleBurnInSql('s')}`);
  if (excludeShortSessions) conditions.push(sql`s.short_session = false`);

  return { conditions, whereClause: whereClause(conditions) };
}

/**
 * Build a short hash fingerprint from filter parameters for cache keys. Dates count to the
 * minute: a preset window starts at the moment the page opened, so at full precision no two
 * visits shared a key and the cache never hit.
 */
export function buildCacheFingerprint(params: Record<string, unknown>): string {
  // Sort keys for stable hashing regardless of parameter order
  const sorted = Object.keys(params)
    .filter((k) => k !== 'cursor' && k !== 'pageSize')
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const val = params[key];
      if (val instanceof Date) {
        acc[key] = val.toISOString().slice(0, 16);
      } else if (val !== undefined && val !== null && val !== '') {
        acc[key] = Array.isArray(val) ? val.slice().sort() : val;
      }
      return acc;
    }, {});
  const raw = JSON.stringify(sorted);
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/** The columns mapHistoryRow reads, over plays gs joined to their first segment s. */
const HISTORY_ROW_COLUMNS = sql`
    gs.play_id as id,
    gs.started_at,
    gs.stopped_at,
    gs.duration_ms,
    gs.paused_duration_ms,
    gs.progress_ms,
    gs.total_duration_ms,
    gs.segment_count,
    gs.watched,
    gs.state,
    s.server_id,
    sv.name as server_name,
    sv.type as server_type,
    s.server_user_id,
    su.username,
    su.thumb_url as user_thumb,
    u.name as identity_name,
    s.session_key,
    s.media_type,
    s.media_title,
    s.grandparent_title,
    s.season_number,
    s.episode_number,
    s.year,
    s.artist_name,
    s.album_name,
    s.thumb_path,
    s.media_id,
    s.show_media_id,
    s.reference_id,
    s.ip_address,
    s.geo_city,
    s.geo_region,
    s.geo_country,
    s.geo_continent,
    s.geo_postal,
    s.geo_lat,
    s.geo_lon,
    s.geo_asn_number,
    s.geo_asn_organization,
    ${localSessionSql('s')} AS is_local,
    s.player_name,
    s.device_id,
    s.product,
    s.device,
    s.platform,
    s.quality,
    s.is_transcode,
    s.video_decision,
    s.audio_decision,
    s.bitrate,
    s.source_video_codec,
    s.source_audio_codec,
    s.source_audio_channels,
    s.source_video_width,
    s.source_video_height,
    s.source_video_details,
    s.source_audio_details,
    s.stream_video_codec,
    s.stream_audio_codec,
    s.stream_video_details,
    s.stream_audio_details,
    s.transcode_info,
    s.subtitle_info
`;

/** One page of plays grouped by reference_id, newest first, for GET /sessions. */
export async function fetchSessionPage(
  conditions: SQL[],
  page: { startDate?: Date; endDate?: Date; pageSize: number; offset: number }
): Promise<HistoryRow[]> {
  const { startDate, endDate, pageSize, offset } = page;
  const result = await db.execute(sql`
      WITH grouped_sessions AS (${groupedPlaysCte({
        where: conditions,
        orderLimit: sql`ORDER BY MIN(s.started_at) DESC LIMIT ${pageSize} OFFSET ${offset}`,
      })})
      SELECT ${HISTORY_ROW_COLUMNS}
      FROM grouped_sessions gs
      ${firstSegmentJoin({ alias: 'gs', boundsFrom: 'grouped_sessions' }, startedAtRange(startDate, endDate))}
      JOIN server_users su ON su.id = s.server_user_id
      JOIN servers sv ON sv.id = s.server_id
      LEFT JOIN users u ON u.id = su.user_id
      ORDER BY gs.started_at DESC
    `);
  return result.rows as unknown as HistoryRow[];
}

export async function countPlays(conditions: SQL[]): Promise<number> {
  const countResult = await db.execute(playCountQuery(conditions));
  return (countResult.rows[0] as { count: number })?.count ?? 0;
}

export interface HistoryPageParams {
  conditions: SQL[];
  orderBy: HistoryQueryInput['orderBy'];
  orderDir: HistoryQueryInput['orderDir'];
  pageSize: number;
  cursor: { time: Date; id: string; key: string | number | null } | null;
  startDate?: Date;
  endDate?: Date;
}

type HistoryCursor = NonNullable<HistoryPageParams['cursor']>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cursor: `${startedAtMs}_${playId}`, plus `_${hex(JSON sort key)}` for the Content and
 * Duration sorts so the keyset comparison starts from the key. Undefined when malformed.
 */
export function parseHistoryCursor(
  cursor: string,
  orderBy: HistoryQueryInput['orderBy']
): HistoryCursor | undefined {
  const [timeStr, id, keyHex, ...extra] = cursor.split('_');
  const parsedTime = timeStr ? Number(timeStr) : NaN;
  if (!timeStr || !id || extra.length > 0 || !Number.isInteger(parsedTime) || !UUID.test(id)) {
    return undefined;
  }
  const time = new Date(parsedTime);
  if (orderBy === 'startedAt') {
    return keyHex === undefined ? { time, id, key: null } : undefined;
  }
  if (!keyHex || !/^[0-9a-f]*$/.test(keyHex)) return undefined;
  let parsedKey: unknown;
  try {
    parsedKey = JSON.parse(Buffer.from(keyHex, 'hex').toString('utf8'));
  } catch {
    return undefined;
  }
  if (orderBy === 'durationMs') {
    const asNumber = Number(parsedKey);
    return Number.isInteger(asNumber) ? { time, id, key: asNumber } : undefined;
  }
  return typeof parsedKey === 'string' ? { time, id, key: parsedKey } : undefined;
}

/** One keyset page of plays, with the page's candidate count for hasMore. */
export async function fetchHistoryPage(params: HistoryPageParams): Promise<HistoryRow[]> {
  const { conditions, orderBy, orderDir, pageSize, cursor, startDate, endDate } = params;
  const cursorTime = cursor?.time ?? null;
  const cursorId = cursor?.id ?? null;
  const cursorKey = cursor?.key ?? null;

  const dir = orderDir === 'desc' ? sql`DESC` : sql`ASC`;
  const playIdTiebreak = sql`COALESCE(s.reference_id, s.id)::text`;
  // The key follows the title the table shows: an episode keys on its show's
  // media row, every other type on its own row, and a session with no linked
  // row falls back to that shown title (the show for an episode, else its own).
  const sortKeyExpr =
    orderBy === 'durationMs'
      ? sql`SUM(COALESCE(s.duration_ms, 0))`
      : orderBy === 'mediaTitle'
        ? sql`COALESCE(MIN(m.sort_title), lower(MIN(CASE WHEN s.media_type = 'episode' AND s.grandparent_title <> '' THEN s.grandparent_title ELSE s.media_title END)))`
        : null;
  const mediaJoin =
    orderBy === 'mediaTitle'
      ? sql`LEFT JOIN media m ON m.id = CASE WHEN s.media_type = 'episode' THEN s.show_media_id ELSE s.media_id END`
      : sql``;
  // Every key in one direction so the keyset tuple comparison below is exact.
  const orderByExpr = sortKeyExpr
    ? sql`${sortKeyExpr} ${dir}, MIN(s.started_at) ${dir}, ${playIdTiebreak} ${dir}`
    : sql`MIN(s.started_at) ${dir}, ${playIdTiebreak} ${dir}`;

  const cursorOp = orderDir === 'desc' ? sql`<` : sql`>`;
  const cursorKeyParam =
    orderBy === 'durationMs' ? sql`${cursorKey}::bigint` : sql`${cursorKey}::text`;
  const havingClause =
    cursorTime && cursorId
      ? sortKeyExpr
        ? sql`HAVING (${sortKeyExpr}, MIN(s.started_at), ${playIdTiebreak}) ${cursorOp} (${cursorKeyParam}, ${cursorTime}, ${cursorId})`
        : sql`HAVING (MIN(s.started_at), ${playIdTiebreak}) ${cursorOp} (${cursorTime}, ${cursorId})`
      : sql``;

  // Full per-play aggregation is scoped to this page's play ids and to started_at at or
  // after the page's earliest play (a segment can never start before its own play's start,
  // so this lower bound never drops a segment an unbounded aggregation would count).
  const groupedConditions = [
    ...conditions,
    sql`COALESCE(s.reference_id, s.id) IN (SELECT play_id FROM history_page_ids)`,
    sql`s.started_at >= (SELECT MIN(started_at) FROM history_page_ids)`,
  ];

  const result = await db.execute(sql`
      WITH history_page AS MATERIALIZED (
        SELECT
          COALESCE(s.reference_id, s.id) as play_id,
          MIN(s.started_at) as started_at,
          ${sortKeyExpr ?? sql`NULL`} as sort_key,
          ROW_NUMBER() OVER (ORDER BY ${orderByExpr}) as rn
        FROM sessions s
        ${mediaJoin}
        ${whereClause(conditions)}
        GROUP BY COALESCE(s.reference_id, s.id)
        ${havingClause}
        ORDER BY ${orderByExpr}
        LIMIT ${pageSize + 1}
      ),
      history_page_ids AS MATERIALIZED (
        SELECT play_id, started_at, sort_key, rn FROM history_page WHERE rn <= ${pageSize}
      ),
      grouped_sessions AS (${groupedPlaysCte({ where: groupedConditions })})
      SELECT ${HISTORY_ROW_COLUMNS},
        lat.segments,
        hp.sort_key,
        (SELECT count(*) FROM history_page)::int as page_candidate_count
      FROM grouped_sessions gs
      JOIN history_page_ids hp ON hp.play_id = gs.play_id
      ${firstSegmentJoin({ alias: 'gs', boundsFrom: 'history_page_ids' }, startedAtRange(startDate, endDate))}
      JOIN server_users su ON su.id = s.server_user_id
      JOIN servers sv ON sv.id = s.server_id
      LEFT JOIN users u ON u.id = su.user_id
      ${playSegmentsLateral('gs', startDate)}
      ORDER BY hp.rn
    `);
  return result.rows as unknown as HistoryRow[];
}
