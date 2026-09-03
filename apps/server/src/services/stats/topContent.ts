import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

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
  libraryIds: string[];
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
 * no library id, so a library scope joins library_items on server and rating key.
 * Distinct from the /stats/top-content route, which folds merged media for the dashboard.
 */
export async function topWatched(opts: TopWatchedOptions): Promise<{
  movies: TopWatchedRow[];
  shows: TopWatchedRow[];
}> {
  const serverFilter =
    opts.serverIds.length === 0 ? sql`` : sql`AND s.server_id IN ${opts.serverIds}`;
  const libraryJoin =
    opts.libraryIds.length === 0
      ? sql``
      : sql`JOIN library_items li ON li.server_id = s.server_id AND li.rating_key = s.rating_key AND li.library_id IN ${opts.libraryIds}`;
  const range = sql`s.started_at >= ${opts.start} AND s.started_at < ${opts.end}`;

  const [movies, shows] = await Promise.all([
    db.execute(sql`
      SELECT s.media_title AS title,
             MAX(s.year) AS year,
             COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int AS plays,
             MAX(s.server_id::text) AS server_id,
             MAX(s.rating_key) AS rating_key,
             MAX(s.thumb_path) AS thumb_path
      FROM sessions s
      ${libraryJoin}
      WHERE ${range} AND s.media_type = 'movie' AND s.media_title IS NOT NULL ${serverFilter}
      GROUP BY s.media_title
      ORDER BY plays DESC, title ASC
      LIMIT ${opts.limit}
    `),
    db.execute(sql`
      SELECT s.grandparent_title AS title,
             MAX(s.year) AS year,
             COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int AS plays,
             MAX(s.server_id::text) AS server_id,
             MAX(s.grandparent_rating_key) AS rating_key,
             MAX(s.thumb_path) AS thumb_path
      FROM sessions s
      ${libraryJoin}
      WHERE ${range} AND s.media_type = 'episode' AND s.grandparent_title IS NOT NULL ${serverFilter}
      GROUP BY s.grandparent_title
      ORDER BY plays DESC, title ASC
      LIMIT ${opts.limit}
    `),
  ]);
  return {
    movies: (movies.rows as unknown as RawRow[]).map(toRow),
    shows: (shows.rows as unknown as RawRow[]).map(toRow),
  };
}
