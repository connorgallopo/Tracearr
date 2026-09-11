import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { MappedRequest } from './mapping.js';

export type ResolutionInput = Pick<
  MappedRequest,
  | 'remoteId'
  | 'mediaType'
  | 'tmdbId'
  | 'tvdbId'
  | 'ratingKey'
  | 'remotePlexId'
  | 'remoteJellyfinUserId'
>;

export interface Resolved {
  mediaId: string | null;
  serverUserId: string | null;
  title: string | null;
  year: number | null;
}

interface MediaHit {
  id: string;
  title: string;
  year: number | null;
}

function uniqueNumbers(values: (number | null | undefined)[]): number[] {
  return [...new Set(values.filter((v): v is number => v != null))];
}

function uniqueStrings(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

async function moviesByTmdb(ids: number[]): Promise<Map<number, MediaHit>> {
  const out = new Map<number, MediaHit>();
  const result = await db.execute(sql`
    SELECT tmdb_id, id, title, year FROM media
    WHERE media_type = 'movie' AND merged_into_id IS NULL AND tmdb_id = ANY(${ids}::int[])
  `);
  for (const row of result.rows as {
    tmdb_id: number;
    id: string;
    title: string;
    year: number | null;
  }[]) {
    out.set(row.tmdb_id, { id: row.id, title: row.title, year: row.year });
  }
  return out;
}

async function showsByIds(
  tvdbIds: number[],
  tmdbIds: number[]
): Promise<{ byTvdb: Map<number, MediaHit>; byTmdb: Map<number, MediaHit> }> {
  const byTvdb = new Map<number, MediaHit>();
  const byTmdb = new Map<number, MediaHit>();
  const result = await db.execute(sql`
    SELECT tmdb_id, tvdb_id, id, title, year FROM media
    WHERE media_type = 'show' AND merged_into_id IS NULL
      AND (tvdb_id = ANY(${tvdbIds}::int[]) OR tmdb_id = ANY(${tmdbIds}::int[]))
  `);
  for (const row of result.rows as {
    tmdb_id: number | null;
    tvdb_id: number | null;
    id: string;
    title: string;
    year: number | null;
  }[]) {
    const hit = { id: row.id, title: row.title, year: row.year };
    if (row.tvdb_id != null && !byTvdb.has(row.tvdb_id)) byTvdb.set(row.tvdb_id, hit);
    if (row.tmdb_id != null && !byTmdb.has(row.tmdb_id)) byTmdb.set(row.tmdb_id, hit);
  }
  return { byTvdb, byTmdb };
}

async function byRatingKey(serverId: string, keys: string[]): Promise<Map<string, MediaHit>> {
  const out = new Map<string, MediaHit>();
  const result = await db.execute(sql`
    SELECT li.rating_key, m.id AS media_id, m.title, m.year
    FROM library_items li
    JOIN media m ON m.id = COALESCE((SELECT merged_into_id FROM media WHERE id = li.media_id), li.media_id)
    WHERE li.server_id = ${serverId} AND li.rating_key = ANY(${keys}::text[])
  `);
  for (const row of result.rows as {
    rating_key: string;
    media_id: string;
    title: string;
    year: number | null;
  }[]) {
    out.set(row.rating_key, { id: row.media_id, title: row.title, year: row.year });
  }
  return out;
}

async function requesters(
  serverId: string,
  serverType: 'plex' | 'jellyfin' | 'emby',
  keys: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const column = serverType === 'plex' ? sql`plex_account_id` : sql`external_id`;
  const result = await db.execute(sql`
    SELECT ${column} AS key, id FROM server_users
    WHERE server_id = ${serverId} AND ${column} = ANY(${keys}::text[])
  `);
  for (const row of result.rows as { key: string; id: string }[]) out.set(row.key, row.id);
  return out;
}

export async function resolveRequests(
  _serviceId: string,
  serverId: string,
  serverType: 'plex' | 'jellyfin' | 'emby',
  rows: ResolutionInput[]
): Promise<Map<number, Resolved>> {
  const movies = rows.filter((r) => r.mediaType === 'movie');
  const shows = rows.filter((r) => r.mediaType === 'show');
  const requesterKey = (r: ResolutionInput) =>
    serverType === 'plex' ? r.remotePlexId : r.remoteJellyfinUserId;

  const movieHits = await moviesByTmdb(uniqueNumbers(movies.map((r) => r.tmdbId)));
  const showHits = await showsByIds(
    uniqueNumbers(shows.map((r) => r.tvdbId)),
    uniqueNumbers(shows.map((r) => r.tmdbId))
  );
  const keyHits = await byRatingKey(serverId, uniqueStrings(rows.map((r) => r.ratingKey)));
  const userHits = await requesters(serverId, serverType, uniqueStrings(rows.map(requesterKey)));

  const out = new Map<number, Resolved>();
  for (const row of rows) {
    let hit: MediaHit | undefined;
    if (row.mediaType === 'movie') {
      hit = row.tmdbId != null ? movieHits.get(row.tmdbId) : undefined;
    } else {
      hit =
        (row.tvdbId != null ? showHits.byTvdb.get(row.tvdbId) : undefined) ??
        (row.tmdbId != null ? showHits.byTmdb.get(row.tmdbId) : undefined);
    }
    hit ??= row.ratingKey ? keyHits.get(row.ratingKey) : undefined;
    const key = requesterKey(row);
    out.set(row.remoteId, {
      mediaId: hit?.id ?? null,
      serverUserId: key ? (userHits.get(key) ?? null) : null,
      title: hit?.title ?? null,
      year: hit?.year ?? null,
    });
  }
  return out;
}
