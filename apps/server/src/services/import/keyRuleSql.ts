/**
 * The key rules of libraryKeyMatch.ts in SQL, for the passes that read imported rows in bulk.
 * Each fragment gives the TS answer for the same row; the shared case table proves it.
 */

import { sql, type SQL } from 'drizzle-orm';
import { SERVER_PROFILES, SERVER_TYPES, type ServerProfile } from '@tracearr/shared';
import { foldsUnreliably } from './libraryKeyMatch.js';

// JS \s, and the line terminators JS `.` stops at, as showTitleOf's pattern reads them.
const SPACE =
  '\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const LINE_END = '\\u000a\\u000d\\u2028\\u2029';
const ASCII_SPACE = '\\u0009-\\u000d\\u0020';
const ASCII_LINE_END = '\\u000a\\u000d';

let charClasses: { kept: string; unreliable: string } | undefined;

/**
 * Bracket bodies for the characters normalizeTitle keeps and those comparableTitle treats as
 * unknown, from Node's own Unicode tables so the database's ctype never decides either.
 */
function classes(): { kept: string; unreliable: string } {
  if (charClasses) return charClasses;
  const kept: Array<[number, number]> = [];
  const unreliable: Array<[number, number]> = [];
  const add = (ranges: Array<[number, number]>, cp: number) => {
    const last = ranges.at(-1);
    if (last && last[1] === cp - 1) last[1] = cp;
    else ranges.push([cp, cp]);
  };
  for (let cp = 1; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const char = String.fromCodePoint(cp);
    if (/^[\p{L}\p{N}]$/u.test(char)) add(kept, cp);
    if (foldsUnreliably(char)) add(unreliable, cp);
  }
  // Regex escapes keep the statement ASCII, so no client encoding conversion can reject it.
  const escaped = (cp: number) =>
    cp <= 0xffff
      ? `\\u${cp.toString(16).padStart(4, '0')}`
      : `\\U${cp.toString(16).padStart(8, '0')}`;
  const body = (ranges: Array<[number, number]>) =>
    ranges
      .map(([from, to]) => (from === to ? escaped(from) : `${escaped(from)}-${escaped(to)}`))
      .join('');
  charClasses = { kept: body(kept), unreliable: body(unreliable) };
  return charClasses;
}

function yearSuffixDropped(expr: string, space: string, lineEnd: string): string {
  return `regexp_replace(${expr}, '^[${space}]*([^${lineEnd}]*[^${space}])[${space}]*\\([0-9]{4}\\)[${space}]*$', '\\1')`;
}

/**
 * ASCII titles fold under the C collation, whatever the database's locale. Any other title
 * needs a UTF8 database whose lower() folds as Node does: elsewhere normalize() fails, a C ctype
 * folds only ASCII and a Turkish one lowers I to dotless i, so there such a title is unknown.
 * Non-ASCII constants go through convert_from(), which is stable: the planner folds immutable
 * calls such as chr() before the encoding test runs, and they fail on other encodings. Its
 * result carries the C collation, so the "ÉI" probe names the default one.
 * Final sigma folds to sigma because Node lowers a capital sigma by its place in the word and
 * Postgres one character at a time (comparableTitle does the same).
 */
function comparableSql(expr: string, stripped: (text: string, ascii: boolean) => string): string {
  const { kept, unreliable } = classes();
  const text = `COALESCE(${expr}, '')`;
  return `(CASE
    WHEN ${text} !~ '[^\\u0001-\\u007f]'
      THEN regexp_replace(lower(${stripped(text, true)} COLLATE "C"), '[^0-9a-z]', '', 'g')
    WHEN getdatabaseencoding() <> 'UTF8' THEN ''
    WHEN lower(convert_from('\\xc38949'::bytea, 'UTF8') COLLATE "default") <> convert_from('\\xc3a969'::bytea, 'UTF8')
      THEN ''
    WHEN ${text} ~ '[${unreliable}]' THEN ''
    ELSE translate(
      regexp_replace(lower(normalize(${stripped(text, false)}, NFKC)), '[^${kept}]', '', 'g'),
      convert_from('\\xcf82'::bytea, 'UTF8'), convert_from('\\xcf83'::bytea, 'UTF8'))
  END)`;
}

/** SQL text normalizing a title the way normalizeTitle does (comparableTitle: unknown is ''). */
export function normalizedTitleSql(expr: string): string {
  return comparableSql(expr, (text) => text);
}

/** The same after dropping a trailing "(YYYY)" (normalizeShowTitle). */
export function normalizedShowTitleSql(expr: string): string {
  return comparableSql(expr, (text, ascii) =>
    ascii
      ? yearSuffixDropped(text, ASCII_SPACE, ASCII_LINE_END)
      : yearSuffixDropped(text, SPACE, LINE_END)
  );
}

/** The server types a profile value picks, as a SQL text[] literal (valid when empty). */
export function serverTypesSql(picks: (profile: ServerProfile) => boolean): string {
  const types = SERVER_TYPES.filter((type) => picks(SERVER_PROFILES[type]));
  return `ARRAY[${types.map((type) => `'${type}'`).join(', ')}]::text[]`;
}

/** Server types whose item keys can be reused, for `type = ANY(...)`. */
export function keyReusingServerTypesSql(): SQL {
  return sql.raw(serverTypesSql((profile) => profile.reusesItemKeys));
}

/**
 * The provably-reused rule for an imported row (aliased `s`) and the library item aliased `item`: the key is
 * reused when the types differ where `typeStated` holds, or when title and year both disagree
 * beyond a year either way (libraryKeyProvablyReused).
 */
export function keyProvablyReusedSql(item: string, typeStated: string): string {
  const norm = (column: string) =>
    `regexp_replace(lower(COALESCE(${column}, '')), '[^[:alnum:]]', '', 'g')`;
  return `(${typeStated} AND s.media_type IN ('movie', 'episode')
            AND ${item}.media_type IN ('movie', 'episode') AND ${item}.media_type <> s.media_type)
          OR (${norm(`${item}.title`)} <> ${norm('s.media_title')}
            AND ${item}.year IS NOT NULL AND s.year IS NOT NULL
            AND abs(${item}.year - s.year) > 1)`;
}

/**
 * True when an imported row (aliased `s`) may take the library item aliased `item` by key: for
 * episodes the agreement rule's steps 2 to 4 (the guid step needs the play's guid, which
 * sessions do not keep), for anything else the provably-reused rule (keyAgreesWithPlay).
 */
export function keyAgreesSql(item: string): SQL {
  const yearWithinOne = `COALESCE(abs(${item}.year - s.year) <= 1, false)`;
  const titlesAgree = `(n.item_title <> '' AND n.item_title = n.play_title)`;
  const showsAgree = `(n.item_show <> '' AND n.item_show = n.play_show)`;
  return sql.raw(`(CASE WHEN ${item}.media_type = 'episode' AND s.media_type = 'episode' THEN (
      SELECT CASE
        WHEN ${item}.parent_index IS NULL OR ${item}.item_index IS NULL
          OR s.season_number IS NULL OR s.episode_number IS NULL
          THEN ${titlesAgree} OR (${showsAgree} AND ${yearWithinOne})
        WHEN ${item}.parent_index <> s.season_number OR ${item}.item_index <> s.episode_number
          THEN ${titlesAgree}
        ELSE ${showsAgree} OR ${titlesAgree} OR ${yearWithinOne}
      END
      FROM (SELECT ${normalizedTitleSql(`${item}.title`)} AS item_title,
          ${normalizedTitleSql('s.media_title')} AS play_title,
          ${normalizedShowTitleSql(`${item}.grandparent_title`)} AS item_show,
          ${normalizedShowTitleSql('s.grandparent_title')} AS play_show) n)
    ELSE NOT (${keyProvablyReusedSql(item, 'TRUE')}) END)`);
}

/**
 * The repair clause ('numbers' | 'titles' | 'movie') for the row aliased `s`, or NULL
 * (linkDisagreesWithPlay). Expects `em` (linked media, canonical) and `sh` (its show, canonical,
 * NULL when it has none) joined by the caller. The linked episode's numbers are those of every
 * library item of `em` on the row's server, removed ones included, and of a title-path match key.
 */
export function repairClauseSql(): SQL {
  const titlesDiffer = `(n.link_title <> '' AND n.play_title <> '' AND n.link_title <> n.play_title)`;
  const yearsApart = `abs(em.year - s.year) > 1`;
  const numbersDiffer = `(s.season_number IS NOT NULL AND s.episode_number IS NOT NULL AND (
      SELECT NOT bool_or(ln.season = s.season_number AND ln.episode = s.episode_number)
      FROM (
        SELECT li.parent_index AS season, li.item_index AS episode FROM library_items li
        WHERE li.server_id = s.server_id AND li.media_id = em.id
          AND li.parent_index IS NOT NULL AND li.item_index IS NOT NULL
        UNION ALL
        SELECT k[1]::int, k[2]::int
        FROM regexp_match(em.match_key,
          '^episode:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:s([0-9]{1,9})e([0-9]{1,9})$') k
        WHERE k IS NOT NULL
      ) ln) IS TRUE)`;
  return sql.raw(`(SELECT CASE
      WHEN em.media_type IS DISTINCT FROM s.media_type THEN NULL
      WHEN s.media_type = 'movie' THEN CASE WHEN ${titlesDiffer} AND ${yearsApart} THEN 'movie' END
      WHEN s.media_type <> 'episode'
        OR n.link_show = '' OR n.play_show = '' OR n.link_show = n.play_show THEN NULL
      WHEN ${numbersDiffer} AND NOT (n.link_title <> '' AND n.link_title = n.play_title) THEN 'numbers'
      WHEN ${titlesDiffer} AND ${yearsApart} THEN 'titles'
    END
    FROM (SELECT ${normalizedTitleSql('em.title')} AS link_title,
        ${normalizedTitleSql('s.media_title')} AS play_title,
        ${normalizedShowTitleSql('sh.title')} AS link_show,
        ${normalizedShowTitleSql('s.grandparent_title')} AS play_show) n)`);
}
