import { sql } from 'drizzle-orm';
import type { NewsletterScopeLibrary } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { libraryPairs } from '../newsletters/scopeSql.js';

export interface TopWatchedRow {
  title: string;
  year: number | null;
  plays: number;
  serverId: string | null;
  ratingKey: string | null;
  thumbPath: string | null;
}

interface TopWatchedOptions {
  start: Date;
  end: Date;
  serverIds: string[];
  libraries: NewsletterScopeLibrary[];
  limit: number;
}

interface RawRow {
  title: string;
  year: number | null;
  plays: number;
  server_id: string | null;
  rating_key: string | null;
  thumb_path: string | null;
}

function toRow(raw: RawRow): TopWatchedRow {
  return {
    title: raw.title,
    year: raw.year,
    plays: Number(raw.plays),
    serverId: raw.server_id,
    ratingKey: raw.rating_key,
    thumbPath: raw.thumb_path,
  };
}

/**
 * Plays per title in a window, grouped by title across the scoped servers. Sessions carry
 * no library id, so a library scope joins library_items on server and rating key. The play
 * count groups by title alone, but server_id/rating_key/thumb_path come from one row (the
 * title's most recent session in scope) rather than three independent MAX()s, so a title
 * streamed on two servers still points at one real session and not a mixed identity.
 * Distinct from the /stats/top-content route, which folds merged media for the dashboard.
 */
export async function topWatched(opts: TopWatchedOptions): Promise<{
  movies: TopWatchedRow[];
  shows: TopWatchedRow[];
}> {
  const serverFilter =
    opts.serverIds.length === 0 ? sql`` : sql`AND s.server_id IN ${opts.serverIds}`;
  const libraryJoin =
    opts.libraries.length === 0
      ? sql``
      : sql`JOIN library_items li ON li.server_id = s.server_id AND li.rating_key = s.rating_key AND (li.server_id, li.library_id) IN ${libraryPairs(opts.libraries)}`;
  const range = sql`s.started_at >= ${opts.start} AND s.started_at < ${opts.end}`;

  const [movies, shows] = await Promise.all([
    db.execute(sql`
      WITH plays AS (
        SELECT s.media_title AS title, MAX(s.year) AS year,
               COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int AS plays
        FROM sessions s
        ${libraryJoin}
        WHERE ${range} AND s.media_type = 'movie' ${serverFilter}
        GROUP BY s.media_title
        ORDER BY plays DESC, title ASC
        LIMIT ${opts.limit}
      ),
      latest AS (
        SELECT DISTINCT ON (s.media_title) s.media_title AS title,
               s.server_id::text AS server_id, s.rating_key, s.thumb_path
        FROM sessions s
        ${libraryJoin}
        WHERE ${range} AND s.media_type = 'movie' ${serverFilter}
        ORDER BY s.media_title, s.started_at DESC
      )
      SELECT p.title, p.year, p.plays, l.server_id, l.rating_key, l.thumb_path
      FROM plays p JOIN latest l ON l.title = p.title
      ORDER BY p.plays DESC, p.title ASC
    `),
    db.execute(sql`
      WITH plays AS (
        SELECT s.grandparent_title AS title, MAX(s.year) AS year,
               COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int AS plays
        FROM sessions s
        ${libraryJoin}
        WHERE ${range} AND s.media_type = 'episode' AND s.grandparent_title IS NOT NULL ${serverFilter}
        GROUP BY s.grandparent_title
        ORDER BY plays DESC, title ASC
        LIMIT ${opts.limit}
      ),
      latest AS (
        SELECT DISTINCT ON (s.grandparent_title) s.grandparent_title AS title,
               s.server_id::text AS server_id, s.grandparent_rating_key AS rating_key, s.thumb_path
        FROM sessions s
        ${libraryJoin}
        WHERE ${range} AND s.media_type = 'episode' AND s.grandparent_title IS NOT NULL ${serverFilter}
        ORDER BY s.grandparent_title, s.started_at DESC
      )
      SELECT p.title, p.year, p.plays, l.server_id, l.rating_key, l.thumb_path
      FROM plays p JOIN latest l ON l.title = p.title
      ORDER BY p.plays DESC, p.title ASC
    `),
  ]);
  return {
    movies: (movies.rows as unknown as RawRow[]).map(toRow),
    shows: (shows.rows as unknown as RawRow[]).map(toRow),
  };
}
