/**
 * Media identity for imported plays, through the resolver library sync uses, with the same
 * precedence: provider ids, then normalized title and year for a movie, the show's media id
 * plus season and episode number for an episode. A title the library holds shares its media
 * row; one it never held gets a row of its own.
 *
 * The resolver is keyed by (server, rating key) and reads its stored-identity cache from
 * library_items under that key. An import's rating key may be dead, or reused by an
 * unrelated current item, so imports never hand it their rating key: every input carries a
 * synthetic key no library item has, which makes the cache a guaranteed miss and keeps a
 * reused key from cross-linking. Shows are found by normalized title alone, since an
 * imported episode's year is the episode's air year, not the show's; two existing shows with
 * one title are not guessed between. A special (season 0) takes the resolver's per-server
 * local key, as a library special does.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { buildMediaMatchKey, normalizeTitle, type MatchKeyInput } from './mediaMatchKey.js';
import { resolveMediaBatch, resolveMediaForItem } from './mediaResolutionService.js';

export interface ImportedPlay {
  serverId: string;
  mediaType?: string | null;
  mediaTitle: string;
  grandparentTitle?: string | null;
  year?: number | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
}

export interface ImportedIdentity {
  mediaId: string;
  showMediaId: string | null;
}

export interface ImportedResolution<T> {
  identities: Map<T, ImportedIdentity>;
  /** Episode plays whose show title names more than one known show. */
  ambiguousShows: number;
}

const IMPORT_KEY = 'import';

function movieKey(play: ImportedPlay): string | null {
  const title = normalizeTitle(play.mediaTitle);
  if (!title && !play.imdbId && !play.tmdbId && !play.tvdbId) return null;
  return [
    play.serverId,
    title,
    play.year ?? '',
    play.imdbId ?? '',
    play.tmdbId ?? '',
    play.tvdbId ?? '',
  ].join('|');
}

async function resolveMovies<T extends ImportedPlay>(
  plays: T[],
  identities: Map<T, ImportedIdentity>
): Promise<void> {
  const groups = new Map<string, T[]>();
  for (const play of plays) {
    const key = movieKey(play);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), play]);
  }
  if (groups.size === 0) return;
  const entries = [...groups.values()].map((group, index) => ({
    group,
    first: group[0] as T,
    ratingKey: `${IMPORT_KEY}:movie:${index}`,
  }));
  const resolved = await resolveMediaBatch(
    entries.map(({ first, ratingKey }) => ({
      mediaType: 'movie',
      serverId: first.serverId,
      ratingKey,
      title: first.mediaTitle,
      year: first.year ?? null,
      imdbId: first.imdbId ?? null,
      tmdbId: first.tmdbId ?? null,
      tvdbId: first.tvdbId ?? null,
    }))
  );
  for (const { group, ratingKey } of entries) {
    const mediaId = resolved.get(ratingKey);
    if (!mediaId) continue;
    for (const play of group) identities.set(play, { mediaId, showMediaId: null });
  }
}

interface ShowTitle {
  /** The title as the play carries it. */
  title: string;
  /** The title with a trailing "(YYYY)" removed, as a library names the show. */
  base: string;
  year: number | null;
}

/** Plex history names a show "Title (2021)" where the library item is "Title"; split the two. */
function showTitleOf(raw: string): ShowTitle {
  const title = raw.trim();
  const [, base, year] = /^(.*\S)\s*\((\d{4})\)$/.exec(title) ?? [];
  return base && year ? { title, base, year: Number(year) } : { title, base: title, year: null };
}

interface ShowCandidate {
  id: string;
  year: number | null;
}

/**
 * The known show rows per normalized title. A title with a year suffix is looked up as
 * written and then without the suffix.
 */
async function findShowCandidates(
  titles: Map<string, ShowTitle>
): Promise<Map<string, ShowCandidate[]>> {
  const found = new Map<string, ShowCandidate[]>();
  if (titles.size === 0) return found;
  const lookups = new Map<string, string[]>();
  for (const [normalized, show] of titles) {
    const keys = [normalized];
    const base = normalizeTitle(show.base);
    if (base && base !== normalized) keys.push(base);
    lookups.set(normalized, keys);
  }
  const rows = (
    await db.execute(sql`
      SELECT normalized_title, id::text AS id, year
      FROM media
      WHERE media_type = 'show' AND merged_into_id IS NULL
        AND normalized_title = ANY(${sql.param([...new Set([...lookups.values()].flat())])}::text[])
      ORDER BY created_at, id
    `)
  ).rows as Array<{ normalized_title: string; id: string; year: number | null }>;
  const byKey = new Map<string, ShowCandidate[]>();
  for (const row of rows) {
    byKey.set(row.normalized_title, [
      ...(byKey.get(row.normalized_title) ?? []),
      { id: row.id, year: row.year },
    ]);
  }
  for (const [normalized] of titles) {
    const hit = lookups.get(normalized)?.find((key) => byKey.has(key));
    found.set(normalized, (hit ? byKey.get(hit) : undefined) ?? []);
  }
  return found;
}

/**
 * The show a play belongs to among the rows sharing its title: a show that premiered more
 * than a year after the play aired cannot be it (an episode cannot air before its show), so
 * a remake in the library never takes the original's plays. One fitting row wins; among
 * several, the one with a year wins over undated rows; two dated rows are not guessed
 * between (null). No fitting row at all is undefined, for the caller to fold or create.
 */
function pickShow(candidates: ShowCandidate[], playYear: number | null): string | null | undefined {
  const possible = candidates.filter(
    (c) => c.year == null || playYear == null || playYear >= c.year - 1
  );
  if (possible.length === 0) return undefined;
  if (possible.length === 1) return possible[0]?.id;
  const dated = possible.filter((c) => c.year != null);
  return dated.length === 1 ? dated[0]?.id : null;
}

/**
 * The one show that already-linked history carries for a show title: the fold the
 * engagement rollup always made by show title, so a history title spelled unlike the
 * library's (a stylized name) still lands on the show its earlier plays sit on. Two shows
 * behind one history title adopt nothing. One query for the batch's titles not yet seen;
 * grandparent_title has no index, so a hit is remembered for the process and re-read by id
 * on use, so a show merged since the first fold hands out the surviving row.
 */
const FOLD_CACHE_LIMIT = 10_000;
const foldCache = new Map<string, string>();

async function foldedShows(titles: string[]): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  const cached = titles.filter((title) => foldCache.has(title));
  if (cached.length > 0) {
    // A remembered show may have been merged since; hand out the surviving row.
    const canonical = new Map(
      (
        (
          await db.execute(sql`
            SELECT id::text AS id, COALESCE(merged_into_id, id)::text AS canonical
            FROM media WHERE id = ANY(${sql.param([...new Set(cached.map((title) => foldCache.get(title)))])}::uuid[])
          `)
        ).rows as Array<{ id: string; canonical: string }>
      ).map((row) => [row.id, row.canonical])
    );
    for (const title of cached) {
      const id = canonical.get(foldCache.get(title) ?? '');
      if (id) {
        foldCache.set(title, id);
        found.set(title, id);
      } else foldCache.delete(title);
    }
  }
  titles = titles.filter((title) => !found.has(title));
  if (titles.length === 0) return found;
  const rows = (
    await db.execute(sql`
      SELECT trim(s.grandparent_title) AS title,
        min(COALESCE(m.merged_into_id, m.id)::text) AS id,
        count(DISTINCT COALESCE(m.merged_into_id, m.id))::int AS n
      FROM sessions s
      JOIN media m ON m.id = s.show_media_id
      WHERE s.media_type = 'episode' AND s.show_media_id IS NOT NULL
        AND trim(s.grandparent_title) IN (SELECT unnest(${sql.param(titles)}::text[]))
      GROUP BY trim(s.grandparent_title)
    `)
  ).rows as Array<{ title: string; id: string; n: number }>;
  for (const row of rows) {
    found.set(row.title, row.n === 1 ? row.id : null);
    if (row.n === 1) {
      if (foldCache.size >= FOLD_CACHE_LIMIT) foldCache.clear();
      foldCache.set(row.title, row.id);
    }
  }
  return found;
}

/**
 * Shows for titles no known row fits: the history fold first, then a new row under the
 * suffix-less title with the suffix year, so a library sync of the show later lands on it.
 */
async function createShows(misses: Map<string, ShowTitle>): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  const folded = await foldedShows([...misses.values()].map((show) => show.title));
  for (const [normalized, show] of misses) {
    const fold = folded.get(show.title);
    if (fold !== undefined) {
      found.set(normalized, fold);
      continue;
    }
    found.set(
      normalized,
      await resolveMediaForItem({
        mediaType: 'show',
        serverId: IMPORT_KEY,
        ratingKey: `${IMPORT_KEY}:show:${normalized}`,
        title: show.base,
        year: show.year,
      })
    );
  }
  return found;
}

interface EpisodeSlot {
  showMediaId: string;
  seasonNumber: number;
  episodeNumber: number;
}

const slotKey = (slot: EpisodeSlot) =>
  `${slot.showMediaId}:${slot.seasonNumber}:${slot.episodeNumber}`;

/**
 * Episodes the library holds under the show, by season and episode number. The library keys
 * an episode by its own provider id when the server gives one, so the show-and-number key
 * alone would miss it; this is the stored-identity read the resolver does by rating key.
 */
async function findLibraryEpisodes(slots: EpisodeSlot[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (slots.length === 0) return found;
  const rows = (
    await db.execute(sql`
      WITH slot AS (
        SELECT * FROM unnest(
          ${sql.param(slots.map((s) => s.showMediaId))}::uuid[],
          ${sql.param(slots.map((s) => s.seasonNumber))}::int[],
          ${sql.param(slots.map((s) => s.episodeNumber))}::int[]
        ) AS t(show_media_id, season_number, episode_number)
      ),
      show_item AS (
        SELECT li.server_id, li.rating_key, COALESCE(m.merged_into_id, m.id) AS show_media_id
        FROM library_items li
        JOIN media m ON m.id = li.media_id
        WHERE li.media_type = 'show'
          AND COALESCE(m.merged_into_id, m.id) IN (SELECT show_media_id FROM slot)
      )
      SELECT s.show_media_id, s.season_number, s.episode_number,
        min(COALESCE(em.merged_into_id, em.id)::text) AS media_id,
        count(DISTINCT COALESCE(em.merged_into_id, em.id))::int AS n
      FROM slot s
      JOIN show_item sh ON sh.show_media_id = s.show_media_id
      JOIN library_items e ON e.server_id = sh.server_id AND e.grandparent_rating_key = sh.rating_key
        AND e.media_type = 'episode' AND e.parent_index = s.season_number
        AND e.item_index = s.episode_number
      JOIN media em ON em.id = e.media_id AND em.media_type = 'episode'
      GROUP BY s.show_media_id, s.season_number, s.episode_number
    `)
  ).rows as Array<{
    show_media_id: string;
    season_number: number;
    episode_number: number;
    media_id: string;
    n: number;
  }>;
  for (const row of rows) {
    if (row.n !== 1) continue;
    found.set(
      slotKey({
        showMediaId: row.show_media_id,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
      }),
      row.media_id
    );
  }
  return found;
}

/**
 * Episode rows for slots the library does not hold: the rows earlier imports created, read by
 * match key in one query, then one batch insert for the rest. The unique match key keeps a
 * slot to one row against a syncing episode as well; a conflict takes the resolver's locked
 * path. Keyed by the input's rating key.
 */
async function resolveEpisodeRows(inputs: MatchKeyInput[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (inputs.length === 0) return found;
  const byMatchKey = new Map(inputs.map((input) => [buildMediaMatchKey(input), input]));
  const rows = (
    await db.execute(sql`
      SELECT match_key, COALESCE(merged_into_id, id)::text AS id
      FROM media WHERE match_key = ANY(${sql.param([...byMatchKey.keys()])}::text[])
    `)
  ).rows as Array<{ match_key: string; id: string }>;
  for (const row of rows) {
    const input = byMatchKey.get(row.match_key);
    if (input) found.set(input.ratingKey, row.id);
  }
  const misses = inputs.filter((input) => !found.has(input.ratingKey));
  for (const [ratingKey, id] of await resolveMediaBatch(misses)) found.set(ratingKey, id);
  return found;
}

async function resolveEpisodes<T extends ImportedPlay>(
  plays: T[],
  identities: Map<T, ImportedIdentity>
): Promise<number> {
  // Only a play that can attach (season and episode number) names a show, so a show row is
  // never created for plays that would stay unlinked anyway.
  const attachable = plays.filter(
    (play) =>
      play.seasonNumber != null &&
      play.seasonNumber >= 0 &&
      play.episodeNumber != null &&
      normalizeTitle(play.grandparentTitle ?? '') !== ''
  );
  const titles = new Map<string, ShowTitle>();
  for (const play of attachable) {
    const show = showTitleOf(play.grandparentTitle ?? '');
    const normalized = normalizeTitle(show.title);
    titles.getOrInsert(normalized, show);
  }
  const candidates = await findShowCandidates(titles);

  let ambiguousShows = 0;
  const showOf = new Map<T, string>();
  const unfit = new Map<string, ShowTitle>();
  const waiting: T[] = [];
  for (const play of attachable) {
    const normalized = normalizeTitle(play.grandparentTitle ?? '');
    const chosen = pickShow(candidates.get(normalized) ?? [], play.year ?? null);
    const title = titles.get(normalized);
    if (chosen === undefined && title) {
      unfit.set(normalized, title);
      waiting.push(play);
    } else if (!chosen) ambiguousShows++;
    else showOf.set(play, chosen);
  }
  const created = await createShows(unfit);
  for (const play of waiting) {
    const showMediaId = created.get(normalizeTitle(play.grandparentTitle ?? ''));
    if (showMediaId) showOf.set(play, showMediaId);
    else ambiguousShows++;
  }

  const slots = new Map<string, EpisodeSlot & { first: T; plays: T[] }>();
  for (const [play, showMediaId] of showOf) {
    if (play.seasonNumber == null || play.episodeNumber == null) continue;
    const slot = {
      showMediaId,
      seasonNumber: play.seasonNumber,
      episodeNumber: play.episodeNumber,
    };
    const key = slotKey(slot);
    const entry = slots.get(key) ?? { ...slot, first: play, plays: [] };
    entry.plays.push(play);
    slots.set(key, entry);
  }
  if (slots.size === 0) return ambiguousShows;

  const inLibrary = await findLibraryEpisodes([...slots.values()]);
  const resolved = await resolveEpisodeRows(
    [...slots]
      .filter(([key]) => !inLibrary.has(key))
      .map(([key, slot]) => ({
        mediaType: 'episode',
        serverId: slot.first.serverId,
        ratingKey: `${IMPORT_KEY}:episode:${key}`,
        title: slot.first.mediaTitle,
        showMediaId: slot.showMediaId,
        seasonNumber: slot.seasonNumber,
        episodeNumber: slot.episodeNumber,
      }))
  );
  for (const [key, slot] of slots) {
    const mediaId = inLibrary.get(key) ?? resolved.get(`${IMPORT_KEY}:episode:${key}`);
    if (!mediaId) continue;
    for (const play of slot.plays) {
      identities.set(play, { mediaId, showMediaId: slot.showMediaId });
    }
  }
  return ambiguousShows;
}

export async function resolveImportedPlays<T extends ImportedPlay>(
  plays: T[]
): Promise<ImportedResolution<T>> {
  const identities = new Map<T, ImportedIdentity>();
  await resolveMovies(
    plays.filter((p) => p.mediaType === 'movie'),
    identities
  );
  const ambiguousShows = await resolveEpisodes(
    plays.filter((p) => p.mediaType === 'episode'),
    identities
  );
  return { identities, ambiguousShows };
}
