/**
 * Public API v2 - Shared helpers
 *
 * Cursor envelope, per-route rate-limit config, and the chain-grain history
 * query reused by /history, /media/{ref}/history, and /users/{id}/history.
 */

import {
  formatAudioChannels,
  formatMediaTech,
  getResolutionLabel,
  type SourceAudioDetails,
  type SourceVideoDetails,
  type StreamAudioDetails,
  type StreamVideoDetails,
  type SubtitleInfo,
  type TranscodeInfo,
} from '@tracearr/shared';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { countedSessionSql } from '../../constants/index.js';
import { db } from '../../db/client.js';
import { buildAvatarUrl, buildPosterUrl } from '../../services/imageProxy.js';
import { encodeCursor } from '../../utils/cursor.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';

// Opts out of the per-route limiter; v2 shares one plugin-level budget per token
export interface RouteConfig {
  rateLimit: false;
}

export interface CursorPage<T> {
  data: T[];
  meta: { nextCursor: string | null; pageSize: number };
}

export function cursorPage<T>(
  data: T[],
  nextCursor: string | null,
  pageSize: number
): CursorPage<T> {
  return { data, meta: { nextCursor, pageSize } };
}

export const cursorPaginationSchema = z.object({
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

// The poller stores '' for a session rating key the server never provided
export const emptyToNull = (value: string | null | undefined): string | null =>
  value ? value : null;

interface StreamCodecData {
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  sourceAudioChannels: number | null;
  sourceVideoWidth: number | null;
  sourceVideoHeight: number | null;
  streamVideoCodec: string | null;
  streamAudioCodec: string | null;
}

export function displayValues(data: StreamCodecData) {
  return {
    resolution: getResolutionLabel(data.sourceVideoWidth, data.sourceVideoHeight),
    source_video_codec_display: data.sourceVideoCodec
      ? formatMediaTech(data.sourceVideoCodec)
      : null,
    source_audio_codec_display: data.sourceAudioCodec
      ? formatMediaTech(data.sourceAudioCodec)
      : null,
    audio_channels_display: formatAudioChannels(data.sourceAudioChannels),
    stream_video_codec_display: data.streamVideoCodec
      ? formatMediaTech(data.streamVideoCodec)
      : null,
    stream_audio_codec_display: data.streamAudioCodec
      ? formatMediaTech(data.streamAudioCodec)
      : null,
  };
}

interface HistoryRow {
  chain_id: string;
  chain_started_at: Date;
  stopped_at: Date | null;
  duration_ms: string | null;
  progress_ms: number | null;
  total_duration_ms: number | null;
  segment_count: string;
  watched: boolean;
  state: string;
  percent_complete: number | null;
  server_id: string;
  server_name: string;
  server_type: string;
  media_type: string;
  media_title: string;
  grandparent_title: string | null;
  season_number: number | null;
  episode_number: number | null;
  year: number | null;
  artist_name: string | null;
  album_name: string | null;
  track_number: number | null;
  disc_number: number | null;
  thumb_path: string | null;
  device: string | null;
  player_name: string | null;
  product: string | null;
  platform: string | null;
  is_transcode: boolean | null;
  video_decision: string | null;
  audio_decision: string | null;
  bitrate: number | null;
  source_video_codec: string | null;
  source_audio_codec: string | null;
  source_audio_channels: number | null;
  source_video_width: number | null;
  source_video_height: number | null;
  source_video_details: SourceVideoDetails | null;
  source_audio_details: SourceAudioDetails | null;
  stream_video_codec: string | null;
  stream_audio_codec: string | null;
  stream_video_details: StreamVideoDetails | null;
  stream_audio_details: StreamAudioDetails | null;
  transcode_info: TranscodeInfo | null;
  subtitle_info: SubtitleInfo | null;
  media_id: string | null;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  rating_key: string | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
  library_id: string | null;
  genres: string[] | null;
  server_user_id: string;
  user_id: string;
  server_username: string;
  user_thumb_url: string | null;
  user_name: string | null;
  user_username: string | null;
}

export function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );
}

// UTC calendar windows: the N most recent UTC days, today inclusive; null = all time
export const STATS_WINDOWS = [
  { key: 'all_time', days: null },
  { key: 'last_30', days: 30 },
  { key: 'last_7', days: 7 },
] as const;

export type StatsWindowKey = (typeof STATS_WINDOWS)[number]['key'];

// Compares col directly so the bound stays sargable and can exclude chunks.
export function windowDayFilter(col: SQL, days: number | null): SQL {
  if (days === null) return sql``;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return sql` AND ${col} >= ${start}`;
}

function mapHistoryRow(row: HistoryRow) {
  return {
    id: row.chain_id,
    server_id: row.server_id,
    server_name: row.server_name,
    server_type: row.server_type,
    state: row.state,
    media_type: row.media_type,
    media_title: row.media_title,
    show_title: row.grandparent_title,
    season_number: row.season_number,
    episode_number: row.episode_number,
    year: row.year,
    artist_name: row.artist_name,
    album_name: row.album_name,
    track_number: row.track_number,
    disc_number: row.disc_number,
    thumb_path: row.thumb_path,
    poster_url: buildPosterUrl(row.server_id, row.thumb_path),
    duration_ms: row.duration_ms !== null ? Number(row.duration_ms) : null,
    progress_ms: row.progress_ms,
    total_duration_ms: row.total_duration_ms,
    percent_complete: row.percent_complete,
    started_at: new Date(row.chain_started_at).toISOString(),
    stopped_at: row.stopped_at ? new Date(row.stopped_at).toISOString() : null,
    watched: row.watched,
    segment_count: Number(row.segment_count),
    device: row.device,
    player: row.player_name,
    product: row.product,
    platform: row.platform,
    is_transcode: row.is_transcode,
    video_decision: row.video_decision,
    audio_decision: row.audio_decision,
    bitrate: row.bitrate,
    source_video_codec: row.source_video_codec,
    source_audio_codec: row.source_audio_codec,
    source_audio_channels: row.source_audio_channels,
    source_video_width: row.source_video_width,
    source_video_height: row.source_video_height,
    source_video_details: row.source_video_details,
    source_audio_details: row.source_audio_details,
    stream_video_codec: row.stream_video_codec,
    stream_audio_codec: row.stream_audio_codec,
    stream_video_details: row.stream_video_details,
    stream_audio_details: row.stream_audio_details,
    transcode_info: row.transcode_info,
    subtitle_info: row.subtitle_info,
    ...displayValues({
      sourceVideoCodec: row.source_video_codec,
      sourceAudioCodec: row.source_audio_codec,
      sourceAudioChannels: row.source_audio_channels,
      sourceVideoWidth: row.source_video_width,
      sourceVideoHeight: row.source_video_height,
      streamVideoCodec: row.stream_video_codec,
      streamAudioCodec: row.stream_audio_codec,
    }),
    media_id: row.media_id,
    show_media_id: row.show_media_id,
    imdb_id: row.imdb_id,
    tmdb_id: row.tmdb_id,
    tvdb_id: row.tvdb_id,
    rating_key: emptyToNull(row.rating_key),
    parent_rating_key: emptyToNull(row.parent_rating_key),
    grandparent_rating_key: emptyToNull(row.grandparent_rating_key),
    library_id: row.library_id,
    reference_id: row.chain_id,
    genres: row.genres,
    user: {
      id: row.user_id,
      server_user_id: row.server_user_id,
      username: row.user_name ?? row.server_username ?? row.user_username,
      thumb_url: row.user_thumb_url,
      avatar_url: buildAvatarUrl(row.server_id, row.user_thumb_url),
    },
  };
}

// Two-phase paging keeps per-page cost bounded instead of re-aggregating every
// matching session on every page (the default GET /history has no time bound,
// so an unqualified aggregate would scan the whole hypertable including
// decompressed chunks). Phase 1 (findCandidateChainIds) walks raw sessions
// ordered by started_at DESC to find a bounded window of candidate chain
// keys - cheap because chain segments cluster tightly in time (a resume must
// land within 1 day of the prior segment's stop, see sessionLifecycle.ts's
// resume-tracking step). Phase 2 (aggregateChainPage) aggregates only those
// chains. If a window doesn't produce a full page and hasn't exhausted the
// table, the window grows; past the hard cap it falls back to the original
// unrestricted aggregation, so correctness never depends on the clustering
// assumption holding.
const RAW_WINDOW_INITIAL_MULTIPLIER = 6;
const RAW_WINDOW_GROWTH_FACTOR = 4;
const RAW_WINDOW_MAX = 20_000;

interface CandidateWindow {
  chainIds: string[];
  /** True once the raw scan reached the actual end of the matching rows. */
  exhausted: boolean;
  /** Oldest started_at among the scanned raw rows - the window's lower bound (null if nothing scanned). */
  windowLowerBound: Date | null;
}

/** Finds up to `rawLimit` of the most recent matching raw session rows and
 * returns the distinct chain keys among them, plus whether that scan reached
 * the end of the table. A chain's true chain_started_at (MIN over its
 * qualifying rows) is always <= any of its own rows' started_at, so any chain
 * whose true chain_started_at falls within the scanned range is guaranteed to
 * be discovered here - it does not need to be discovered via its earliest row. */
async function findCandidateChainIds(
  conditions: SQL[],
  cursorValue: { startedAt: Date; id: string } | null,
  rawLimit: number
): Promise<CandidateWindow> {
  const rawConditions = cursorValue
    ? [...conditions, sql`s.started_at <= ${cursorValue.startedAt}::timestamptz`]
    : conditions;
  const rawWhereClause =
    rawConditions.length > 0 ? sql`WHERE ${sql.join(rawConditions, sql` AND `)}` : sql``;

  const result = await db.execute(sql`
    SELECT ARRAY_AGG(DISTINCT chain_id) AS chain_ids, COUNT(*) AS raw_row_count,
           MIN(started_at) AS window_lower_bound
    FROM (
      SELECT COALESCE(s.reference_id, s.id) AS chain_id, s.started_at
      FROM sessions s
      ${rawWhereClause}
      ORDER BY s.started_at DESC, s.id DESC
      LIMIT ${rawLimit}
    ) t
  `);
  const row = result.rows[0] as unknown as
    | {
        chain_ids: string[] | null;
        raw_row_count: string;
        window_lower_bound: Date | string | null;
      }
    | undefined;
  return {
    chainIds: row?.chain_ids ?? [],
    exhausted: Number(row?.raw_row_count ?? 0) < rawLimit,
    windowLowerBound: row?.window_lower_bound ? new Date(row.window_lower_bound) : null,
  };
}

/** Aggregates chains matching `conditions` into one keyset page. Pass
 * `conditions` alone for the unrestricted (legacy) shape, or with an extra
 * `COALESCE(s.reference_id, s.id) = ANY(...)` condition to bound the
 * aggregation to a known candidate set. */
async function aggregateChainPage(
  conditions: SQL[],
  watchedFilter: SQL,
  cursorFilter: SQL,
  pageSize: number
) {
  const whereClause =
    conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  return db.execute(sql`
    WITH chains AS (
      SELECT
        COALESCE(s.reference_id, s.id) as chain_id,
        MIN(s.started_at) as chain_started_at,
        MAX(s.stopped_at) as stopped_at,
        SUM(COALESCE(s.duration_ms, 0)) as duration_ms,
        MAX(s.progress_ms) as progress_ms,
        MAX(s.total_duration_ms) as total_duration_ms,
        COUNT(*) as segment_count,
        BOOL_OR(s.watched) as watched,
        (array_agg(s.id ORDER BY s.started_at))[1] as first_session_id,
        (array_agg(s.state ORDER BY s.started_at DESC))[1] as state
      FROM sessions s
      ${whereClause}
      GROUP BY COALESCE(s.reference_id, s.id)
      HAVING BOOL_OR(${countedSessionSql('s')})${watchedFilter}
    ),
    page AS (
      SELECT * FROM chains
      ${cursorFilter}
      ORDER BY chain_started_at DESC, chain_id DESC
      LIMIT ${pageSize}
    )
    SELECT
      p.chain_id,
      p.chain_started_at,
      p.stopped_at,
      p.duration_ms,
      p.progress_ms,
      p.total_duration_ms,
      p.segment_count,
      p.watched,
      p.state,
      CASE WHEN p.progress_ms IS NULL OR COALESCE(p.total_duration_ms, 0) = 0 THEN NULL
           ELSE ROUND(LEAST(p.progress_ms::numeric * 100 / p.total_duration_ms, 100), 1)::float8
      END as percent_complete,
      s.server_id,
      sv.name as server_name,
      sv.type as server_type,
      s.media_type,
      s.media_title,
      s.grandparent_title,
      s.season_number,
      s.episode_number,
      s.year,
      s.artist_name,
      s.album_name,
      s.track_number,
      s.disc_number,
      s.thumb_path,
      s.device,
      s.player_name,
      s.product,
      s.platform,
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
      s.subtitle_info,
      s.media_id,
      s.show_media_id,
      s.imdb_id,
      s.tmdb_id,
      s.tvdb_id,
      s.rating_key,
      s.parent_rating_key,
      s.grandparent_rating_key,
      li.library_id,
      m.genres,
      su.id as server_user_id,
      su.user_id,
      su.username as server_username,
      su.thumb_url as user_thumb_url,
      u.name as user_name,
      u.username as user_username
    FROM page p
    -- p.chain_started_at is not a planner-time constant; the InitPlan bounds are what let
    -- TimescaleDB exclude chunks at runtime
    JOIN sessions s ON s.id = p.first_session_id AND s.started_at = p.chain_started_at
      AND s.started_at >= (SELECT MIN(chain_started_at) FROM page)
      AND s.started_at <= (SELECT MAX(chain_started_at) FROM page)
    JOIN server_users su ON su.id = s.server_user_id
    JOIN servers sv ON sv.id = s.server_id
    LEFT JOIN users u ON u.id = su.user_id
    LEFT JOIN media m ON m.id = s.media_id
    LEFT JOIN library_items li ON li.server_id = s.server_id AND li.rating_key = s.rating_key
    ORDER BY p.chain_started_at DESC, p.chain_id DESC
  `);
}

export async function runHistoryPage(
  conditions: SQL[],
  pageSize: number,
  cursorValue: { startedAt: Date; id: string } | null,
  watched: boolean | undefined
): Promise<{ data: ReturnType<typeof mapHistoryRow>[]; nextCursor: string | null }> {
  const watchedFilter = watched === undefined ? sql`` : sql` AND BOOL_OR(s.watched) = ${watched}`;
  const cursorFilter = cursorValue
    ? sql`WHERE (chain_started_at, chain_id) < (${cursorValue.startedAt}::timestamptz, ${cursorValue.id}::uuid)`
    : sql``;

  let rawLimit = pageSize * RAW_WINDOW_INITIAL_MULTIPLIER;
  let rows: HistoryRow[] = [];

  for (;;) {
    const { chainIds, exhausted, windowLowerBound } = await findCandidateChainIds(
      conditions,
      cursorValue,
      rawLimit
    );
    if (chainIds.length === 0) break;

    const windowed = await aggregateChainPage(
      [...conditions, sql`COALESCE(s.reference_id, s.id) = ANY(${uuidArraySql(chainIds)})`],
      watchedFilter,
      cursorFilter,
      pageSize
    );
    rows = windowed.rows as unknown as HistoryRow[];

    // Completeness guard: a chain entirely outside the scanned window sorts after this page only if its (necessarily older) chain_started_at is below the window's lower bound.
    const lastRow = rows[rows.length - 1];
    const pageComplete =
      rows.length >= pageSize &&
      windowLowerBound !== null &&
      lastRow !== undefined &&
      new Date(lastRow.chain_started_at) >= windowLowerBound;
    if (pageComplete || exhausted) break;

    if (rawLimit >= RAW_WINDOW_MAX) {
      // Pathological spread (chains resumed far apart in time): fall back to
      // the unrestricted aggregation so correctness never depends on the
      // clustering assumption above.
      const fallback = await aggregateChainPage(conditions, watchedFilter, cursorFilter, pageSize);
      rows = fallback.rows as unknown as HistoryRow[];
      break;
    }
    rawLimit = Math.min(rawLimit * RAW_WINDOW_GROWTH_FACTOR, RAW_WINDOW_MAX);
  }

  const data = rows.map(mapHistoryRow);
  const lastRow = rows.length === pageSize ? rows[rows.length - 1] : undefined;
  const nextCursor = lastRow
    ? encodeCursor(new Date(lastRow.chain_started_at), lastRow.chain_id)
    : null;
  return { data, nextCursor };
}
