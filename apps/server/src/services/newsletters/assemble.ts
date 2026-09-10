import { sql } from 'drizzle-orm';
import {
  POSTER_IMAGE_SIZE,
  type NewsletterScope,
  type NewsletterSectionCounts,
  type NewsletterSections,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import type { PosterRef } from '../../db/schema.js';
import { posterVersionFor, proxyImage } from '../imageProxy.js';
import { topWatched, type TopWatchedRow } from '../stats/topContent.js';
import { libraryPairs } from './scopeSql.js';

/** Another server's copy of the same title, folded into one card with a link of its own. */
export interface MirrorCopy {
  serverId: string;
  ratingKey: string;
}

export interface LibraryItemRow {
  id: string;
  serverId: string;
  serverName: string;
  serverType: string;
  libraryId: string;
  libraryName: string;
  ratingKey: string;
  mediaId: string | null;
  mediaType: string;
  title: string;
  year: number | null;
  parentTitle: string | null;
  parentRatingKey: string | null;
  parentIndex: number | null;
  grandparentTitle: string | null;
  grandparentRatingKey: string | null;
  itemIndex: number | null;
  thumbPath: string | null;
  genres: string[] | null;
  imdbId: string | null;
  addedAt: Date;
  mirrors: MirrorCopy[];
}

/** What every card needs to build links and resolve a poster. */
export interface DigestCard {
  cardId: string;
  serverId: string;
  serverName: string;
  serverType: string;
  ratingKey: string;
  mediaId: string | null;
  imdbId: string | null;
  thumbPath: string | null;
  mirrors: MirrorCopy[];
}

export interface DigestSeasonGroup {
  number: number | null;
  title: string;
  episodeRange: string;
  episodeCount: number;
  whole: boolean;
}

export interface DigestData {
  movies: (DigestCard & { title: string; year: number | null; genres: string[]; addedAt: Date })[];
  shows: (DigestCard & {
    title: string;
    year: number | null;
    seasons: DigestSeasonGroup[];
    moreSeasons: number;
    episodeCount: number;
    addedAt: Date;
  })[];
  artists: (DigestCard & {
    name: string;
    albums: (DigestCard & { title: string; year: number | null; trackCount: number })[];
  })[];
  mostWatched: (DigestCard & {
    kind: 'movie' | 'show';
    title: string;
    year: number | null;
    plays: number;
  })[];
  counts: { movies: number; shows: number; episodes: number; albums: number; mostWatched: number };
  isEmpty: boolean;
}

/** Cards each section holds, albums counted across artists; the "+N more" lines and the fit loop both read it against `counts`. */
export function sectionItemCounts(data: DigestData): NewsletterSectionCounts {
  return {
    movies: data.movies.length,
    shows: data.shows.length,
    albums: data.artists.reduce((n, artist) => n + artist.albums.length, 0),
    mostWatched: data.mostWatched.length,
  };
}

const pad = (n: number): string => `E${String(n).padStart(2, '0')}`;

export function episodeRange(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] as number) + 1) j += 1;
    parts.push(
      i === j ? pad(sorted[i] as number) : `${pad(sorted[i] as number)}-${pad(sorted[j] as number)}`
    );
    i = j + 1;
  }
  return parts.join(', ');
}

function cardOf(row: LibraryItemRow, cardId = row.id): DigestCard {
  return {
    cardId,
    serverId: row.serverId,
    serverName: row.serverName,
    serverType: row.serverType,
    ratingKey: row.ratingKey,
    mediaId: row.mediaId,
    imdbId: row.imdbId,
    thumbPath: row.thumbPath,
    mirrors: row.mirrors,
  };
}

const newestFirst = <T extends { addedAt: Date }>(a: T, b: T): number =>
  b.addedAt.getTime() - a.addedAt.getTime();

type ParentKey = (serverId: string, ratingKey: string) => string;

/** A parent whose copy on this server was dropped as a mirror resolves to the copy that was kept, so its children land on one card. */
function parentKeys(rows: LibraryItemRow[]): ParentKey {
  const kept = new Map<string, string>();
  for (const row of rows) {
    for (const mirror of row.mirrors) {
      kept.set(`${mirror.serverId}:${mirror.ratingKey}`, `${row.serverId}:${row.ratingKey}`);
    }
  }
  return (serverId, ratingKey) => {
    const key = `${serverId}:${ratingKey}`;
    return kept.get(key) ?? key;
  };
}

interface ShowAccumulator {
  card: DigestCard;
  title: string;
  year: number | null;
  addedAt: Date;
  seasons: Map<
    string,
    { number: number | null; title: string; episodes: number[]; whole: boolean }
  >;
  episodeCount: number;
}

function groupShows(rows: LibraryItemRow[], parentKey: ParentKey): ShowAccumulator[] {
  const shows = new Map<string, ShowAccumulator>();
  const ensure = (row: LibraryItemRow, key: string, title: string): ShowAccumulator => {
    const mapKey = parentKey(row.serverId, key);
    let show = shows.get(mapKey);
    if (!show) {
      show = {
        card: {
          ...cardOf(row, `show-${row.serverId}-${key}`),
          ratingKey: key,
          thumbPath: null,
          mediaId: null,
          imdbId: null,
          mirrors: [],
        },
        title,
        year: null,
        addedAt: row.addedAt,
        seasons: new Map(),
        episodeCount: 0,
      };
      shows.set(mapKey, show);
    }
    if (row.addedAt > show.addedAt) show.addedAt = row.addedAt;
    return show;
  };
  for (const row of rows) {
    if (row.mediaType === 'show') {
      const show = ensure(row, row.ratingKey, row.title);
      show.card = { ...cardOf(row), ratingKey: row.ratingKey };
      show.year = row.year;
      show.title = row.title;
      continue;
    }
    if (row.mediaType === 'season' && row.parentRatingKey) {
      const show = ensure(row, row.parentRatingKey, row.parentTitle ?? row.title);
      const key = `s-${row.parentIndex ?? row.title}`;
      const season = show.seasons.get(key) ?? {
        number: row.parentIndex,
        title: row.title,
        episodes: [],
        whole: false,
      };
      season.whole = true;
      show.seasons.set(key, season);
      continue;
    }
    if (row.mediaType === 'episode' && row.grandparentRatingKey) {
      const show = ensure(row, row.grandparentRatingKey, row.grandparentTitle ?? row.title);
      const key = `s-${row.parentIndex ?? row.parentTitle ?? 'x'}`;
      const season = show.seasons.get(key) ?? {
        number: row.parentIndex,
        title:
          row.parentTitle ?? (row.parentIndex === null ? 'Episodes' : `Season ${row.parentIndex}`),
        episodes: [],
        whole: false,
      };
      if (row.itemIndex !== null) season.episodes.push(row.itemIndex);
      show.seasons.set(key, season);
      show.episodeCount += 1;
    }
  }
  return [...shows.values()];
}

interface ArtistAccumulator {
  card: DigestCard;
  name: string;
  addedAt: Date;
  albums: Map<string, { card: DigestCard; title: string; year: number | null; trackCount: number }>;
}

function groupArtists(rows: LibraryItemRow[], parentKey: ParentKey): ArtistAccumulator[] {
  const artists = new Map<string, ArtistAccumulator>();
  const ensure = (row: LibraryItemRow, key: string, name: string): ArtistAccumulator => {
    const mapKey = parentKey(row.serverId, key);
    let artist = artists.get(mapKey);
    if (!artist) {
      artist = {
        card: {
          ...cardOf(row, `artist-${row.serverId}-${key}`),
          ratingKey: key,
          thumbPath: null,
          mediaId: null,
          imdbId: null,
          mirrors: [],
        },
        name,
        addedAt: row.addedAt,
        albums: new Map(),
      };
      artists.set(mapKey, artist);
    }
    if (row.addedAt > artist.addedAt) artist.addedAt = row.addedAt;
    return artist;
  };
  for (const row of rows) {
    if (row.mediaType === 'artist') {
      const artist = ensure(row, row.ratingKey, row.title);
      artist.card = { ...cardOf(row), ratingKey: row.ratingKey };
      artist.name = row.title;
      continue;
    }
    if (row.mediaType === 'album' && row.parentRatingKey) {
      const artist = ensure(row, row.parentRatingKey, row.parentTitle ?? row.title);
      const albumKey = parentKey(row.serverId, row.ratingKey);
      const album = artist.albums.get(albumKey) ?? {
        card: cardOf(row),
        title: row.title,
        year: row.year,
        trackCount: 0,
      };
      album.card = cardOf(row);
      album.year = row.year;
      artist.albums.set(albumKey, album);
      continue;
    }
    if (row.mediaType === 'track' && row.grandparentRatingKey && row.parentRatingKey) {
      const artist = ensure(
        row,
        row.grandparentRatingKey,
        row.grandparentTitle ?? 'Unknown artist'
      );
      const albumKey = parentKey(row.serverId, row.parentRatingKey);
      const album = artist.albums.get(albumKey) ?? {
        card: {
          ...cardOf(row, `album-${row.serverId}-${row.parentRatingKey}`),
          ratingKey: row.parentRatingKey,
          thumbPath: null,
        },
        title: row.parentTitle ?? 'Unknown album',
        year: null,
        trackCount: 0,
      };
      album.trackCount += 1;
      artist.albums.set(albumKey, album);
    }
  }
  return [...artists.values()];
}

export function groupDigest(rows: LibraryItemRow[], sections: NewsletterSections): DigestData {
  const movies = sections.movies.enabled
    ? rows
        .filter((r) => r.mediaType === 'movie')
        .sort(newestFirst)
        .map((r) => ({
          ...cardOf(r),
          title: r.title,
          year: r.year,
          genres: r.genres ?? [],
          addedAt: r.addedAt,
        }))
    : [];
  const parentKey = parentKeys(rows);
  const showGroups = sections.shows.enabled ? groupShows(rows, parentKey).sort(newestFirst) : [];
  const shows = showGroups.map((show) => {
    const seasons = [...show.seasons.values()].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const shown = seasons.slice(0, sections.shows.maxSeasonsPerShow);
    return {
      ...show.card,
      title: show.title,
      year: show.year,
      addedAt: show.addedAt,
      seasons: shown.map((s) => ({
        number: s.number,
        title: s.title,
        episodeRange: episodeRange(s.episodes),
        episodeCount: s.episodes.length,
        whole: s.whole,
      })),
      moreSeasons: seasons.length - shown.length,
      episodeCount: show.episodeCount,
    };
  });
  // Not resorted: rows already arrive newest-first from loadWindowItems, and an
  // artist's Map position follows the first track or album encountered for it.
  const artistGroups = sections.music.enabled ? groupArtists(rows, parentKey) : [];
  const artists: DigestData['artists'] = [];
  let albumBudget = sections.music.max;
  let albumTotal = 0;
  for (const artist of artistGroups) {
    const albums = [...artist.albums.values()];
    albumTotal += albums.length;
    if (albums.length === 0 || albumBudget <= 0) continue;
    const taken = albums.slice(0, albumBudget);
    albumBudget -= taken.length;
    artists.push({
      ...artist.card,
      name: artist.name,
      albums: taken.map((a) => ({
        ...a.card,
        title: a.title,
        year: a.year,
        trackCount: a.trackCount,
      })),
    });
  }
  const episodes = rows.filter((r) => r.mediaType === 'episode').length;
  const counts = {
    movies: movies.length,
    shows: shows.length,
    episodes: sections.shows.enabled ? episodes : 0,
    albums: albumTotal,
    mostWatched: 0,
  };
  const data: DigestData = {
    movies: movies.slice(0, sections.movies.max),
    shows: shows.slice(0, sections.shows.max),
    artists,
    mostWatched: [],
    counts,
    isEmpty: movies.length === 0 && shows.length === 0 && artists.length === 0,
  };
  return data;
}

interface RawItemRow {
  id: string;
  server_id: string;
  server_name: string;
  server_type: string;
  library_id: string;
  library_name: string;
  rating_key: string;
  media_id: string | null;
  media_type: string;
  title: string;
  year: number | null;
  parent_title: string | null;
  parent_rating_key: string | null;
  parent_index: number | null;
  grandparent_title: string | null;
  grandparent_rating_key: string | null;
  item_index: number | null;
  thumb_path: string | null;
  genres: string[] | null;
  imdb_id: string | null;
  added_at: string | Date;
}

const ITEM_TYPES = ['movie', 'show', 'season', 'episode', 'artist', 'album', 'track'];
const WINDOW_ROW_LIMIT = 5000;

function mapItemRow(r: RawItemRow): LibraryItemRow {
  return {
    id: r.id,
    serverId: r.server_id,
    serverName: r.server_name,
    serverType: r.server_type,
    libraryId: r.library_id,
    libraryName: r.library_name,
    ratingKey: r.rating_key,
    mediaId: r.media_id,
    mediaType: r.media_type,
    title: r.title,
    year: r.year,
    parentTitle: r.parent_title,
    parentRatingKey: r.parent_rating_key,
    parentIndex: r.parent_index,
    grandparentTitle: r.grandparent_title,
    grandparentRatingKey: r.grandparent_rating_key,
    itemIndex: r.item_index,
    thumbPath: r.thumb_path,
    genres: r.genres,
    imdbId: r.imdb_id,
    addedAt: new Date(r.added_at),
    mirrors: [],
  };
}

/** Position in the newsletter's server list; a server the list does not name sorts last. */
export function serverRank(serverIds: readonly string[]): (serverId: string) => number {
  return (serverId) => {
    const i = serverIds.indexOf(serverId);
    return i === -1 ? serverIds.length : i;
  };
}

/** One row per (media type, media id) across servers: the copy on the first-ranked server is kept with the others as mirrors; a null media id and a second copy on the same server stand alone. */
export function collapseMirrors(
  rows: LibraryItemRow[],
  rank: (serverId: string) => number
): LibraryItemRow[] {
  const groups = new Map<string, LibraryItemRow[]>();
  for (const row of rows) {
    if (row.mediaId === null) continue;
    const key = `${row.mediaType}:${row.mediaId}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const replaced = new Map<LibraryItemRow, LibraryItemRow>();
  const dropped = new Set<LibraryItemRow>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const [first, ...rest] = [...list].sort((a, b) => rank(a.serverId) - rank(b.serverId)) as [
      LibraryItemRow,
      ...LibraryItemRow[],
    ];
    const mirrored = new Set([first.serverId, ...first.mirrors.map((m) => m.serverId)]);
    const mirrors: MirrorCopy[] = [];
    for (const copy of rest) {
      if (copy.serverId === first.serverId) continue;
      dropped.add(copy);
      const carried = [{ serverId: copy.serverId, ratingKey: copy.ratingKey }, ...copy.mirrors];
      for (const mirror of carried) {
        if (mirrored.has(mirror.serverId)) continue;
        mirrored.add(mirror.serverId);
        mirrors.push(mirror);
      }
    }
    replaced.set(first, { ...first, mirrors: [...first.mirrors, ...mirrors] });
  }
  return rows.flatMap((row) => (dropped.has(row) ? [] : [replaced.get(row) ?? row]));
}

/** Items first seen inside the window; the server-reported added date only decides the card's display order. */
export async function loadWindowItems(
  scope: NewsletterScope,
  window: { start: Date; end: Date }
): Promise<LibraryItemRow[]> {
  const serverFilter =
    scope.serverIds.length === 0 ? sql`` : sql`AND li.server_id IN ${scope.serverIds}`;
  const libraryFilter =
    scope.libraries.length === 0
      ? sql``
      : sql`AND (li.server_id, li.library_id) IN ${libraryPairs(scope.libraries)}`;
  const seen = sql`COALESCE(li.first_seen_at, li.created_at)`;
  const result = await db.execute(sql`
    SELECT li.id, li.server_id, s.name AS server_name, s.type AS server_type,
           li.library_id, COALESCE(l.name, li.library_id) AS library_name,
           li.rating_key, li.media_id, li.media_type, li.title, li.year,
           li.parent_title, li.parent_rating_key, li.parent_index,
           li.grandparent_title, li.grandparent_rating_key, li.item_index,
           li.thumb_path, li.genres, li.imdb_id, li.created_at AS added_at
    FROM library_items li
    JOIN servers s ON s.id = li.server_id
    LEFT JOIN libraries l ON l.server_id = li.server_id AND l.library_id = li.library_id
    WHERE li.removed_at IS NULL
      AND ${seen} >= ${window.start} AND ${seen} < ${window.end}
      AND li.media_type IN ${ITEM_TYPES}
      ${serverFilter} ${libraryFilter}
    ORDER BY ${seen} DESC
    LIMIT ${WINDOW_ROW_LIMIT}
  `);
  return (result.rows as unknown as RawItemRow[]).map(mapItemRow);
}

/** (server_id, rating_key) alone is unique on library_items; the media type filter rejects a key whose item is no longer the type the caller expects. */
export async function loadItemRows(
  keys: { serverId: string; ratingKey: string }[],
  mediaType: 'movie' | 'show'
): Promise<LibraryItemRow[]> {
  if (keys.length === 0) return [];
  const byServer = new Map<string, string[]>();
  for (const k of keys) {
    let ratingKeys = byServer.get(k.serverId);
    if (!ratingKeys) {
      ratingKeys = [];
      byServer.set(k.serverId, ratingKeys);
    }
    ratingKeys.push(k.ratingKey);
  }
  const rows: LibraryItemRow[] = [];
  for (const [serverId, ratingKeys] of byServer) {
    const result = await db.execute(sql`
      SELECT li.id, li.server_id, s.name AS server_name, s.type AS server_type,
             li.library_id, COALESCE(l.name, li.library_id) AS library_name,
             li.rating_key, li.media_id, li.media_type, li.title, li.year,
             li.parent_title, li.parent_rating_key, li.parent_index,
             li.grandparent_title, li.grandparent_rating_key, li.item_index,
             li.thumb_path, li.genres, li.imdb_id, li.created_at AS added_at
      FROM library_items li
      JOIN servers s ON s.id = li.server_id
      LEFT JOIN libraries l ON l.server_id = li.server_id AND l.library_id = li.library_id
      WHERE li.removed_at IS NULL AND li.media_type = ${mediaType}
        AND li.server_id = ${serverId} AND li.rating_key IN ${ratingKeys}
    `);
    for (const r of result.rows as unknown as RawItemRow[]) {
      rows.push(mapItemRow(r));
    }
  }
  return rows;
}

async function warmPosters(cards: DigestCard[]): Promise<Record<string, PosterRef>> {
  const posters: Record<string, PosterRef> = {};
  const withPoster = cards.filter((c) => c.thumbPath !== null && c.thumbPath !== '');
  const CONCURRENCY = 4;
  for (let i = 0; i < withPoster.length; i += CONCURRENCY) {
    await Promise.all(
      withPoster.slice(i, i + CONCURRENCY).map(async (card) => {
        const thumbPath = card.thumbPath as string;
        const version = posterVersionFor(thumbPath);
        try {
          const result = await proxyImage({
            serverId: card.serverId,
            imagePath: thumbPath,
            ...POSTER_IMAGE_SIZE,
            fallback: 'poster',
            version,
          });
          if (result.contentType.startsWith('image/') && !result.contentType.includes('svg')) {
            posters[card.cardId] = { serverId: card.serverId, thumbPath, version };
          }
        } catch {
          // A cold or unreachable server means no poster for this card, never a failed run.
        }
      })
    );
  }
  return posters;
}

export async function assembleDigest(
  newsletter: { scope: NewsletterScope; sections: NewsletterSections },
  window: { start: Date; end: Date },
  opts: { posters?: boolean } = {}
): Promise<{ data: DigestData; posters: Record<string, PosterRef> }> {
  const rank = serverRank(newsletter.scope.serverIds);
  const rows = collapseMirrors(await loadWindowItems(newsletter.scope, window), rank);
  let showRows: LibraryItemRow[] = [];
  if (newsletter.sections.shows.enabled) {
    const missingShows = new Map<string, { serverId: string; ratingKey: string }>();
    const presentShows = new Set(
      rows.filter((r) => r.mediaType === 'show').map((r) => `${r.serverId}:${r.ratingKey}`)
    );
    for (const r of rows) {
      const key =
        r.mediaType === 'episode'
          ? r.grandparentRatingKey
          : r.mediaType === 'season'
            ? r.parentRatingKey
            : null;
      if (key && !presentShows.has(`${r.serverId}:${key}`))
        missingShows.set(`${r.serverId}:${key}`, { serverId: r.serverId, ratingKey: key });
    }
    showRows = await loadItemRows([...missingShows.values()], 'show');
  }
  const data = groupDigest(collapseMirrors([...rows, ...showRows], rank), newsletter.sections);

  if (newsletter.sections.mostWatched.enabled) {
    const top = await topWatched({
      start: window.start,
      end: window.end,
      serverIds: newsletter.scope.serverIds,
      libraries: newsletter.scope.libraries,
      limit: newsletter.sections.mostWatched.max,
    });
    const keysFor = (list: TopWatchedRow[]): { serverId: string; ratingKey: string }[] =>
      list.flatMap((t) =>
        t.serverId && t.ratingKey ? [{ serverId: t.serverId, ratingKey: t.ratingKey }] : []
      );
    const [movieItems, showItems] = await Promise.all([
      loadItemRows(keysFor(top.movies), 'movie'),
      loadItemRows(keysFor(top.shows), 'show'),
    ]);
    const itemByKey = new Map<string, LibraryItemRow>();
    for (const r of [...movieItems, ...showItems]) itemByKey.set(`${r.serverId}:${r.ratingKey}`, r);

    const rowsFor = (kind: 'movie' | 'show', list: typeof top.movies) =>
      list.map((t, i) => {
        const item =
          t.serverId && t.ratingKey ? itemByKey.get(`${t.serverId}:${t.ratingKey}`) : undefined;
        return {
          cardId: `watched-${kind}-${i}`,
          serverId: t.serverId ?? '',
          serverName: item?.serverName ?? '',
          serverType: '',
          ratingKey: t.ratingKey ?? '',
          mediaId: item?.mediaId ?? null,
          imdbId: item?.imdbId ?? null,
          thumbPath: t.serverId && t.thumbPath ? t.thumbPath : null,
          mirrors: [],
          kind,
          title: t.title,
          year: t.year,
          plays: t.plays,
        };
      });
    data.mostWatched = [...rowsFor('movie', top.movies), ...rowsFor('show', top.shows)]
      .sort((a, b) => b.plays - a.plays)
      .slice(0, newsletter.sections.mostWatched.max);
    data.counts.mostWatched = data.mostWatched.length;
    data.isEmpty = data.isEmpty && data.mostWatched.length === 0;
  }

  // An artist card shows its first album's cover; a most-watched row carries its session's thumb.
  const covers = data.artists.flatMap((artist) => (artist.albums[0] ? [artist.albums[0]] : []));
  const posters =
    opts.posters === false
      ? {}
      : await warmPosters([...data.movies, ...data.shows, ...covers, ...data.mostWatched]);
  return { data, posters };
}
