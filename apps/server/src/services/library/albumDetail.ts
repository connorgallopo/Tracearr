/**
 * The album sheet on an artist page: an album's active copies in scope, its tracks deduped by
 * track number and title across those copies, and plays from user_media_plays_daily joined to
 * each copy's tracks on (server_id, media_id). Plays are chains: a chain across UTC midnight is
 * two daily rows and one play, and it belongs to the window its first day falls in. No library
 * column stores a track's length, so track and album durations are null.
 */

import { sql, type SQL } from 'drizzle-orm';
import { SQUARE_POSTER_SIZE, TIME_MS, type AlbumDetailResponse } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { libraryFragment, scopeFragment, seesServerActivity, type Scope } from '../../lib/scope.js';
import { buildPosterOrderFragment, posterFor } from '../../routes/library/catalog.js';
import { idList } from '../../routes/publicV2/shared.js';
import { personNameSql } from '../../utils/representativeAccount.js';
import { FINISHED_SQL, percent, startOfUtcDay, toIso } from '../stats/windows.js';

export interface AlbumWindow {
  start: Date;
  priorStart: Date;
}

/** The last 30 UTC days, today included, and the 30 before them. */
export function albumWindow(now = new Date()): AlbumWindow {
  const end = startOfUtcDay(now) + TIME_MS.DAY;
  return {
    start: new Date(end - 30 * TIME_MS.DAY),
    priorStart: new Date(end - 60 * TIME_MS.DAY),
  };
}

export interface AlbumQuery {
  aliases: string[];
  serverIds: string[] | undefined;
  scope: Scope;
}

/** `copies`, `tracks` and `chains`: the album's copies in scope, their tracks, and their plays. */
export function albumChainsCte({ aliases, serverIds, scope }: AlbumQuery): SQL {
  return sql`
    copies AS (
      SELECT li.server_id, li.rating_key FROM library_items li
      WHERE li.media_id IN (${idList(aliases)})
        AND li.media_type = 'album' AND li.removed_at IS NULL
        ${libraryFragment(serverIds, scope, 'li')}
    ),
    tracks AS (
      SELECT t.server_id, t.media_id, t.title, lower(t.title) AS title_key, t.item_index
      FROM library_items t
      JOIN copies c ON c.server_id = t.server_id AND c.rating_key = t.parent_rating_key
      WHERE t.media_type = 'track' AND t.removed_at IS NULL
    ),
    track_media AS (
      SELECT DISTINCT ON (server_id, media_id) server_id, media_id, item_index, title_key
      FROM tracks WHERE media_id IS NOT NULL
      ORDER BY server_id, media_id, item_index, title_key
    ),
    chains AS (
      SELECT
        p.chain_id,
        MIN(tm.item_index) AS item_index,
        MIN(tm.title_key) AS title_key,
        MAX(p.server_user_id::text)::uuid AS server_user_id,
        MIN(p.day) AS first_day,
        MAX(p.day) FILTER (WHERE p.counted) AS last_counted_day,
        BOOL_OR(p.counted) AS counted,
        SUM(p.watched_ms) AS watched_ms,
        MAX(p.max_progress_ms) AS max_progress_ms,
        MAX(p.content_duration_ms) AS content_duration_ms
      FROM user_media_plays_daily p
      JOIN track_media tm ON tm.server_id = p.server_id AND tm.media_id = p.media_id
      WHERE p.media_type = 'track' ${scopeFragment(scope, sql`p.server_user_id`)}
      GROUP BY p.chain_id
    )`;
}

export function albumCopiesSql(
  { aliases, serverIds, scope }: AlbumQuery,
  preferredServerId: string | null | undefined
): SQL {
  return sql`
    SELECT
      li.server_id,
      li.rating_key,
      li.year,
      li.parent_title,
      li.thumb_path,
      li.created_at,
      COALESCE(am.merged_into_id, am.id) AS artist_media_id
    FROM library_items li
    LEFT JOIN LATERAL (
      SELECT ar.media_id FROM library_items ar
      WHERE ar.server_id = li.server_id AND ar.rating_key = li.parent_rating_key
        AND ar.media_type = 'artist' AND ar.removed_at IS NULL
      LIMIT 1
    ) ar ON true
    LEFT JOIN media am ON am.id = ar.media_id
    WHERE li.media_id IN (${idList(aliases)})
      AND li.media_type = 'album' AND li.removed_at IS NULL
      ${libraryFragment(serverIds, scope, 'li')}
    ${buildPosterOrderFragment(preferredServerId)}
  `;
}

export function albumSummarySql(q: AlbumQuery, w: AlbumWindow): SQL {
  return sql`
    WITH ${albumChainsCte(q)}
    SELECT
      COUNT(*) FILTER (WHERE counted AND first_day >= ${w.start}::timestamptz)::int AS plays,
      COUNT(*) FILTER (
        WHERE counted AND first_day >= ${w.priorStart}::timestamptz
          AND first_day < ${w.start}::timestamptz
      )::int AS prior_plays,
      COALESCE(SUM(watched_ms) FILTER (WHERE first_day >= ${w.start}::timestamptz), 0)::bigint AS listen_ms,
      COUNT(*) FILTER (WHERE counted)::int AS all_plays,
      COUNT(*) FILTER (WHERE counted AND content_duration_ms > 0 AND (${FINISHED_SQL}))::int AS finished,
      COUNT(*) FILTER (WHERE counted AND content_duration_ms > 0)::int AS judged
    FROM chains
  `;
}

/** All-time counted chains per person, each account folded into its identity. */
export function albumListenersSql(q: AlbumQuery): SQL {
  return sql`
    WITH ${albumChainsCte(q)}
    SELECT ${personNameSql()} AS name, COUNT(*)::int AS plays
    FROM chains c
    JOIN server_users su ON su.id = c.server_user_id
    JOIN users u ON u.id = su.user_id
    WHERE c.counted
    GROUP BY u.id, u.name
    ORDER BY plays DESC, name
  `;
}

/** One row per distinct (track number, title) across the copies, all-time plays, album order. */
export function albumTracksSql(q: AlbumQuery): SQL {
  return sql`
    WITH ${albumChainsCte(q)},
    title_plays AS (
      SELECT item_index, title_key, COUNT(*) FILTER (WHERE counted)::int AS plays,
        MAX(last_counted_day) AS last_played
      FROM chains GROUP BY item_index, title_key
    )
    SELECT
      t.item_index AS track_index,
      (ARRAY_AGG(t.title ORDER BY t.server_id, t.title))[1] AS title,
      COALESCE(MAX(tp.plays), 0)::int AS plays,
      MAX(tp.last_played) AS last_played
    FROM tracks t
    LEFT JOIN title_plays tp ON tp.title_key = t.title_key
      AND tp.item_index IS NOT DISTINCT FROM t.item_index
    GROUP BY t.item_index, t.title_key
    ORDER BY track_index ASC NULLS LAST, title
  `;
}

interface CopyRow {
  server_id: string;
  rating_key: string;
  year: number | null;
  parent_title: string | null;
  thumb_path: string | null;
  created_at: Date | string;
  artist_media_id: string | null;
}

interface SummaryRow {
  plays: number;
  prior_plays: number;
  listen_ms: string | number;
  all_plays: number;
  finished: number;
  judged: number;
}

interface TrackRow {
  track_index: number | null;
  title: string;
  plays: number;
  last_played: Date | string | null;
}

export interface AlbumDetailInput extends AlbumQuery {
  album: { id: string; title: string; year: number | null };
  preferredServerId: string | null | undefined;
  now?: Date;
}

/** Null when the album has no active copy in scope. */
export async function getAlbumDetail(input: AlbumDetailInput): Promise<AlbumDetailResponse | null> {
  const copiesResult = await db.execute(albumCopiesSql(input, input.preferredServerId));
  const copies = copiesResult.rows as unknown as CopyRow[];
  const first = copies[0];
  if (!first) return null;

  const w = albumWindow(input.now);
  const [summaryResult, listenersResult, tracksResult, showListeners] = await Promise.all([
    db.execute(albumSummarySql(input, w)),
    db.execute(albumListenersSql(input)),
    db.execute(albumTracksSql(input)),
    seesServerActivity(input.scope),
  ]);
  const summary = summaryResult.rows[0] as SummaryRow | undefined;
  const allPlays = summary?.all_plays ?? 0;
  const listeners = showListeners
    ? (listenersResult.rows as unknown as { name: string; plays: number }[]).map((row) => ({
        name: row.name,
        plays: row.plays,
        share: percent(row.plays, allPlays) ?? 0,
      }))
    : [];
  const tracks = (tracksResult.rows as unknown as TrackRow[]).map((row) => ({
    index: row.track_index,
    title: row.title,
    durationMs: null,
    plays: row.plays,
    lastPlayedAt: toIso(row.last_played),
  }));
  const poster = copies.find((copy) => copy.thumb_path);
  const addedAt = Math.min(...copies.map((copy) => new Date(copy.created_at).getTime()));

  return {
    album: {
      id: input.album.id,
      title: input.album.title,
      artistTitle: copies.find((copy) => copy.parent_title)?.parent_title ?? null,
      artistMediaId: copies.find((copy) => copy.artist_media_id)?.artist_media_id ?? null,
      year: input.album.year ?? copies.find((copy) => copy.year !== null)?.year ?? null,
      trackCount: tracks.length,
      durationMs: null,
      addedAt: new Date(addedAt).toISOString(),
      ...posterFor(poster?.server_id, poster?.thumb_path, SQUARE_POSTER_SIZE),
      copies: copies.map((copy) => ({ serverId: copy.server_id, ratingKey: copy.rating_key })),
    },
    last30: {
      plays: summary?.plays ?? 0,
      priorPlays: summary?.prior_plays ?? 0,
      listenMs: Number(summary?.listen_ms ?? 0),
    },
    allTime: {
      plays: allPlays,
      listeners,
      finishedRate: percent(summary?.finished ?? 0, summary?.judged ?? 0),
    },
    tracks,
  };
}
