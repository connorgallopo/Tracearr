import { normalizePlexGuid } from '../../utils/plexGuid.js';
import { showTitleOf } from '../library/importedPlayIdentity.js';
import { normalizeTitle } from '../library/mediaMatchKey.js';
import type { ImportKeyFields, SessionIdentity } from '../../jobs/poller/database.js';

interface TitledPlay {
  mediaType: string;
  title: string | null | undefined;
  year: number | null | undefined;
}

export interface KeyedPlay extends TitledPlay {
  grandparentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  guid?: string | null;
}

export interface KeyedItem {
  mediaType: string;
  title: string | null;
  year: number | null;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  plexGuid: string | null;
  showTvdbId: number | null;
  showTmdbId: number | null;
  imdbId: string | null;
  tmdbId: number | null;
}

export interface LinkedMedia {
  mediaType: string;
  title: string | null;
  year: number | null;
  showTitle: string | null;
  /** Every (season, episode) pair the linked episode's library items carry, plus a title-path match key's. */
  numbers: ReadonlyArray<readonly [number, number]>;
}

export type RepairClause = 'numbers' | 'titles' | 'movie';

/** External ids from a Plex legacy agent guid; a modern plex:// guid carries none. */
export function parseHistoryGuid(guid: string | null | undefined): {
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
} {
  if (!guid) return {};
  const [, agent, rawId] =
    /^com\.plexapp\.agents\.(thetvdb|themoviedb|imdb):\/\/([^/?]+)/.exec(guid) ?? [];
  if (!rawId) return {};
  if (agent === 'imdb') return rawId.startsWith('tt') ? { imdbId: rawId } : {};
  const numeric = parseInt(rawId, 10);
  if (Number.isNaN(numeric)) return {};
  if (agent === 'thetvdb') return { tvdbId: numeric };
  if (agent === 'themoviedb') return { tmdbId: numeric };
  return {};
}

// Postgres lowercases and NFKC-normalizes these blocks the way Node does: checked code point by
// code point on Postgres 15 (glibc, C.UTF-8) and 18 (musl). Outside them a character Node maps
// can be newer than the database's Unicode tables.
const FOLD_STABLE_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x052f],
  [0x1e00, 0x2bff],
  [0x3000, 0x33ff],
  [0xac00, 0xd7af],
  [0xf900, 0xfdff],
  [0xfe30, 0xfeff],
  [0xff00, 0xffef],
];

/** Whether Postgres may lowercase or normalize the character differently from Node. */
export function foldsUnreliably(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  if (FOLD_STABLE_BLOCKS.some(([from, to]) => cp >= from && cp <= to)) return false;
  return char.normalize('NFKC').toLowerCase() !== char;
}

/**
 * A title as the key rules compare it: normalized, or empty (unknown) when the SQL form of the
 * rules could not normalize it the same way. Final sigma folds to sigma: Node lowers a capital
 * sigma by its place in the word, Postgres one character at a time.
 */
export function comparableTitle(title: string | null | undefined): string {
  const text = title ?? '';
  for (const char of text) if (foldsUnreliably(char)) return '';
  return normalizeTitle(text).replaceAll('ς', 'σ');
}

/** A show title as a library names it: a trailing "(YYYY)" dropped, then normalized. */
export function normalizeShowTitle(title: string | null | undefined): string {
  return comparableTitle(showTitleOf(title ?? '').base);
}

// A title that normalizes to empty is unknown: it neither agrees nor disagrees.
function agree(a: string, b: string): boolean {
  return a !== '' && a === b;
}

function differ(a: string, b: string): boolean {
  return a !== '' && b !== '' && a !== b;
}

function yearGap(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null || b == null ? null : Math.abs(a - b);
}

function numbersOf(
  season: number | null | undefined,
  episode: number | null | undefined
): readonly [number, number] | null {
  return season == null || episode == null ? null : [season, episode];
}

/**
 * An imported play's rating key is only evidence while the key still names the same item.
 * The key is taken as reused only when that is provable: the item is of another media type,
 * or both the normalized title and the year disagree beyond the resolver's own tolerance of
 * a year either way. A renamed item or a year off by one still stamps by key.
 */
export function libraryKeyProvablyReused(item: TitledPlay, play: TitledPlay): boolean {
  const typed = (mediaType: string) => mediaType === 'movie' || mediaType === 'episode';
  if (typed(item.mediaType) && typed(play.mediaType) && item.mediaType !== play.mediaType) {
    return true;
  }
  if (normalizeTitle(item.title ?? '') === normalizeTitle(play.title ?? '')) return false;
  if (item.year == null || play.year == null) return false;
  return Math.abs(item.year - play.year) > 1;
}

function episodeKeyAgrees(item: KeyedItem, play: KeyedPlay): boolean {
  const showAgrees = agree(
    normalizeShowTitle(item.showTitle),
    normalizeShowTitle(play.grandparentTitle)
  );
  const titleAgrees = agree(comparableTitle(item.title), comparableTitle(play.title));
  const gap = yearGap(item.year, play.year);
  const yearAgrees = gap !== null && gap <= 1;
  const itemNumbers = numbersOf(item.seasonNumber, item.episodeNumber);
  const playNumbers = numbersOf(play.seasonNumber, play.episodeNumber);
  const numbersAgree =
    itemNumbers !== null &&
    playNumbers !== null &&
    itemNumbers[0] === playNumbers[0] &&
    itemNumbers[1] === playNumbers[1];

  const itemGuid = normalizePlexGuid(item.plexGuid);
  const playGuid = normalizePlexGuid(play.guid);
  if (itemGuid?.mediaType === 'episode' && playGuid?.mediaType === 'episode') {
    if (itemGuid.guid === playGuid.guid) return true;
    if (!(showAgrees && numbersAgree)) return false;
  }

  if (itemNumbers === null || playNumbers === null) {
    return titleAgrees || (showAgrees && yearAgrees);
  }
  if (!numbersAgree) return titleAgrees;

  // Legacy episode guids carry the series' id, never the episode's.
  const series = parseHistoryGuid(play.guid);
  const seriesAgrees =
    (series.tvdbId !== undefined && series.tvdbId === item.showTvdbId) ||
    (series.tmdbId !== undefined && series.tmdbId === item.showTmdbId);
  return showAgrees || titleAgrees || seriesAgrees || yearAgrees;
}

function movieKeyAgrees(item: KeyedItem, play: KeyedPlay): boolean {
  const itemGuid = normalizePlexGuid(item.plexGuid);
  const playGuid = normalizePlexGuid(play.guid);
  if (itemGuid?.mediaType === 'movie' && playGuid?.mediaType === 'movie') {
    return itemGuid.guid === playGuid.guid;
  }
  const ids = parseHistoryGuid(play.guid);
  if (ids.imdbId !== undefined && item.imdbId !== null) return ids.imdbId === item.imdbId;
  if (ids.tmdbId !== undefined && item.tmdbId !== null) return ids.tmdbId === item.tmdbId;
  return !libraryKeyProvablyReused(item, play);
}

/**
 * Whether a key recorded at play time still names the played item, on a server whose keys can
 * be reused. The burden of proof is on the key: an episode needs its numbers, titles or year
 * to agree, and a guid on both sides decides. Other media keep the provably-reused rule.
 */
export function keyAgreesWithPlay(item: KeyedItem, play: KeyedPlay): boolean {
  if (item.mediaType === 'episode' && play.mediaType === 'episode') {
    return episodeKeyAgrees(item, play);
  }
  if (item.mediaType === 'movie' && play.mediaType === 'movie') {
    return movieKeyAgrees(item, play);
  }
  return !libraryKeyProvablyReused(item, play);
}

/**
 * The clause that proves an imported row's link names another item, or null. The burden of
 * proof is on the repair: unknown values never count, and a renamed or renumbered show keeps
 * its links because its show title still agrees.
 */
export function linkDisagreesWithPlay(link: LinkedMedia, play: KeyedPlay): RepairClause | null {
  if (link.mediaType !== play.mediaType) return null;
  const titlesDiffer = differ(comparableTitle(link.title), comparableTitle(play.title));
  const gap = yearGap(link.year, play.year);
  const yearsDiffer = gap !== null && gap > 1;
  if (play.mediaType === 'movie') return titlesDiffer && yearsDiffer ? 'movie' : null;
  if (play.mediaType !== 'episode') return null;

  const showsDiffer = differ(
    normalizeShowTitle(link.showTitle),
    normalizeShowTitle(play.grandparentTitle)
  );
  if (!showsDiffer) return null;
  const numbers = numbersOf(play.seasonNumber, play.episodeNumber);
  const numbersDiffer =
    numbers !== null &&
    link.numbers.length > 0 &&
    !link.numbers.some(([season, episode]) => season === numbers[0] && episode === numbers[1]);
  if (numbersDiffer && !agree(comparableTitle(link.title), comparableTitle(play.title)))
    return 'numbers';
  return titlesDiffer && yearsDiffer ? 'titles' : null;
}

/**
 * The library identity a rating key gives an imported play, or none when the key cannot be
 * trusted: on a server whose keys are reused the play and the item must agree, elsewhere the
 * key holds unless it is provably reused.
 */
export function importIdentityByKey<I extends SessionIdentity>(
  identity: (I & Partial<ImportKeyFields>) | undefined,
  play: KeyedPlay,
  reusesItemKeys: boolean
): I | undefined {
  if (!identity) return undefined;
  const item: KeyedItem = {
    mediaType: identity.itemMediaType,
    title: identity.itemTitle ?? null,
    year: identity.itemYear ?? null,
    showTitle: identity.itemShowTitle ?? null,
    seasonNumber: identity.itemSeason ?? null,
    episodeNumber: identity.itemEpisode ?? null,
    plexGuid: identity.itemGuid ?? null,
    showTvdbId: identity.showTvdbId ?? null,
    showTmdbId: identity.showTmdbId ?? null,
    imdbId: identity.imdbId,
    tmdbId: identity.tmdbId,
  };
  const trusted = reusesItemKeys
    ? keyAgreesWithPlay(item, play)
    : !libraryKeyProvablyReused(item, play);
  return trusted ? identity : undefined;
}
