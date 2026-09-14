#!/usr/bin/env npx tsx
/**
 * English-regression finder
 *
 * Finds translation values that read as English and uses git history to say why.
 * The case worth fixing is a key that once held a real translation and now does not.
 *
 * Two things make it see more than a diff against today's `en` file. A value counts as
 * English when it matches any string the source has ever shipped, anywhere, so key
 * renames and reworded copy do not read as losses. And history is tracked per key
 * across every file a locale ever had, so a key that moved namespace -- or that exists
 * in two namespaces at once, as `activity.*` does in pages.json and mobile.json --
 * keeps its trail.
 *
 * Tiers:
 *   regression   - this key held a real translation in this file, and now reads English
 *   recoverable  - reads English here, but the same key is translated in another file
 *   possible     - a prior value differed from the source yet appears in English
 *                  elsewhere, so translation and fill cannot be told apart
 *   stale        - an outdated English wording (the source moved on, the locale did not)
 *   untranslated - matches the current English exactly, never had a translation
 *   benign       - letterless or brand-only ("Plex", "{{count}}", "4K")
 *
 * Usage:
 *   pnpm check:english
 *   pnpm check:english --locale=de-DE
 *   pnpm check:english --json=report.json
 *   pnpm check:english --show=regression,recoverable,stale
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(PKG_ROOT, 'src', 'locales');
const BASE_LANG = 'en';
const SKIP_DIRS = new Set([BASE_LANG]);

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: PKG_ROOT,
  encoding: 'utf8',
}).trim();
const REL_LOCALES = path.relative(REPO_ROOT, LOCALES_DIR).split(path.sep).join('/');

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const onlyLocale = argValue('locale');
const jsonOut = argValue('json');
const show = new Set((argValue('show') ?? 'regression').split(',').filter(Boolean));

interface TranslationObject {
  [key: string]: string | TranslationObject;
}

type FlatMap = Map<string, string>;

interface Finding {
  tier: 'regression' | 'recoverable' | 'possible' | 'stale' | 'untranslated' | 'benign';
  locale: string;
  namespace: string;
  key: string;
  value: string;
  englishNow: string;
  lastTranslated?: string;
  lastGoodCommit?: string;
  lastGoodDate?: string;
  lostInCommit?: string;
  lostInDate?: string;
  lostInSubject?: string;
  /** Set when the evidence came from a different namespace than the key lives in today. */
  foundIn?: string;
}

function flatten(obj: TranslationObject, prefix = '', out: FlatMap = new Map()): FlatMap {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out.set(fullKey, value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, fullKey, out);
    }
  }
  return out;
}

function git(gitArgs: string[], input?: string): Buffer {
  return execFileSync('git', gitArgs, { cwd: REPO_ROOT, input, maxBuffer: 512 * 1024 * 1024 });
}

interface CommitMeta {
  sha: string;
  date: string;
  subject: string;
}

function historyOf(relPath: string): CommitMeta[] {
  const raw = git([
    'log',
    '--full-history',
    '--format=%H%x00%ad%x00%s',
    '--date=short',
    '--',
    relPath,
  ]).toString('utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', date = '', subject = ''] = line.split('\0');
      return { sha, date, subject };
    });
}

/** Resolves `<commit>:<path>` refs to blob shas. cat-file echoes one line per input, in order. */
function resolveBlobs(refs: string[]): (string | null)[] {
  if (refs.length === 0) return [];
  const out = git(['cat-file', '--batch-check'], `${refs.join('\n')}\n`).toString('utf8');
  const lines = out.split('\n').filter((l) => l.length > 0);
  return refs.map((_, i) => {
    const line = lines[i];
    if (!line || line.endsWith(' missing') || line.endsWith(' ambiguous')) return null;
    const [sha, type] = line.split(' ');
    return type === 'blob' && sha ? sha : null;
  });
}

const blobCache = new Map<string, FlatMap | null>();

function loadBlobs(shas: (string | null)[]): void {
  const wanted = [...new Set(shas.filter((s): s is string => s !== null && !blobCache.has(s)))];
  if (wanted.length === 0) return;

  const buf = git(['cat-file', '--batch'], `${wanted.join('\n')}\n`);
  let pos = 0;
  for (const sha of wanted) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    if (header.endsWith(' missing')) {
      blobCache.set(sha, null);
      continue;
    }
    const size = Number(header.split(' ')[2]);
    const body = buf.toString('utf8', pos, pos + size);
    pos += size + 1;
    try {
      blobCache.set(sha, flatten(JSON.parse(body) as TranslationObject));
    } catch {
      blobCache.set(sha, null);
    }
  }
}

const BRAND_WORDS = new Set([
  'plex',
  'jellyfin',
  'emby',
  'tracearr',
  'tautulli',
  'overseerr',
  'jellyseerr',
  'sonarr',
  'radarr',
  'tailscale',
  'discord',
  'slack',
  'telegram',
  'ntfy',
  'gotify',
  'pushover',
  'pushbullet',
  'webhook',
  'webhooks',
  'api',
  'url',
  'urls',
  'uri',
  'id',
  'ip',
  'ok',
  'http',
  'https',
  'json',
  'yaml',
  'smtp',
  'imap',
  'tmdb',
  'tvdb',
  'imdb',
  'trakt',
  'ui',
  'cpu',
  'ram',
  'gpu',
  'db',
  'sql',
  'sso',
  'oidc',
  'oauth',
  'totp',
  'qr',
  'pin',
  'csv',
  'png',
  'jpg',
  'jpeg',
  'svg',
  'pdf',
  'gb',
  'mb',
  'kb',
  'tb',
  'ms',
  'fps',
  'hdr',
  'sdr',
  'dolby',
  'vision',
  'atmos',
  'dts',
  'aac',
  'ac3',
  'h264',
  'h265',
  'hevc',
  'av1',
  'vp9',
  'mkv',
  'mp4',
  'redis',
  'postgres',
  'postgresql',
  'docker',
  'github',
  'gitlab',
  'android',
  'ios',
  'chrome',
  'firefox',
  'safari',
  'roku',
  'chromecast',
  'nvidia',
  'shield',
  'xbox',
  'playstation',
  'apple',
  'tv',
  'lan',
  'vpn',
  'dns',
  'ssl',
  'tls',
  'utc',
  'rss',
  'cron',
  'beta',
  'alpha',
  'rc',
  'n',
  'a',
  'k',
]);

/** Strips interpolation, i18next refs and markup so only prose letters remain. */
function proseTokens(value: string): string[] {
  const stripped = value
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/\$t\([^)]*\)/g, ' ')
    .replace(/<[^>]*>/g, ' ');
  return stripped.match(/\p{L}+/gu) ?? [];
}

function isBenign(value: string): boolean {
  const tokens = proseTokens(value);
  return tokens.length === 0 || tokens.every((t) => BRAND_WORDS.has(t.toLowerCase()));
}

function readJson(file: string): TranslationObject | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TranslationObject;
  } catch {
    return null;
  }
}

const namespaces = fs
  .readdirSync(path.join(LOCALES_DIR, BASE_LANG))
  .filter((f) => f.endsWith('.json'))
  .sort();

const locales = fs
  .readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
  .map((d) => d.name)
  .filter((l) => (onlyLocale ? l === onlyLocale : true))
  .sort();

// ---- English corpus ----
// Every string the source has ever shipped, and every wording each key has held. A
// locale value found in the corpus is English text, not a translation, whatever key it
// now sits under -- which is what makes this survive key renames and namespace moves.
const englishCorpus = new Set<string>();
const englishByKey = new Map<string, Set<string>>();
const englishNow = new Map<string, FlatMap>();

for (const ns of namespaces) {
  const current = readJson(path.join(LOCALES_DIR, BASE_LANG, ns));
  if (current) englishNow.set(ns, flatten(current));
}

const sourcePaths = [
  ...new Set(
    git(['log', '--full-history', '--format=', '--name-only', '--', `${REL_LOCALES}/${BASE_LANG}`])
      .toString('utf8')
      .split('\n')
      .filter((f) => f.endsWith('.json') && !f.includes('*'))
  ),
];

function recordEnglish(map: FlatMap): void {
  for (const [key, value] of map) {
    englishCorpus.add(value);
    const seen = englishByKey.get(key);
    if (seen) seen.add(value);
    else englishByKey.set(key, new Set([value]));
  }
}

for (const rel of sourcePaths) {
  const commits = historyOf(rel);
  const shas = resolveBlobs(commits.map((c) => `${c.sha}:${rel}`));
  loadBlobs(shas);
  for (const sha of shas) {
    const snapshot = sha ? blobCache.get(sha) : null;
    if (snapshot) recordEnglish(snapshot);
  }
}
for (const map of englishNow.values()) recordEnglish(map);

process.stderr.write(
  `english corpus: ${englishCorpus.size} strings across ${englishByKey.size} keys` +
    ` and ${sourcePaths.length} source files\n`
);

// ---- per-locale value history, keyed by key rather than by file ----

interface Change {
  value: string;
  namespace: string;
  /** Newest commit that still held this value. */
  since: CommitMeta;
  /** Commit that replaced it, if any. */
  until?: CommitMeta;
}

interface LocaleHistory {
  /** key -> changes, newest first, across every file this locale ever had. */
  anyFile: Map<string, Change[]>;
}

/**
 * Locale dirs were renamed from two-letter to full codes, so a file's history stops at
 * that commit. Git's own rename detection mispairs them because many locales were
 * byte-identical English at the time, so the link is made per namespace by blob
 * identity across the rename. Testing per namespace matters: `pt-PT` was born English
 * and only coincidentally matched `pt` in one file, and inheriting Brazilian history
 * there invents regressions that never happened.
 */
function legacyLinks(locale: string): { dir: string | null; inherited: Set<string> } {
  const dash = locale.indexOf('-');
  const inherited = new Set<string>();
  if (dash === -1) return { dir: null, inherited };
  const legacy = locale.slice(0, dash);

  let tested = 0;
  for (const ns of namespaces) {
    const commits = historyOf(`${REL_LOCALES}/${locale}/${ns}`);
    const earliest = commits[commits.length - 1];
    if (!earliest) continue;
    const [born, before] = resolveBlobs([
      `${earliest.sha}:${REL_LOCALES}/${locale}/${ns}`,
      `${earliest.sha}^:${REL_LOCALES}/${legacy}/${ns}`,
    ]);
    if (before === null) continue;
    tested++;
    if (born !== null && born === before) inherited.add(ns);
  }

  // Retired namespaces come along only for a wholesale rename, not a partial match.
  const wholesale = tested > 0 && inherited.size === tested;
  return {
    dir: inherited.size > 0 ? legacy : null,
    inherited: wholesale ? new Set(['*']) : inherited,
  };
}

function buildHistory(locale: string): LocaleHistory {
  const pathsUnder = (dir: string) =>
    git(['log', '--full-history', '--format=', '--name-only', '--', `${REL_LOCALES}/${dir}`])
      .toString('utf8')
      .split('\n')
      .filter((f) => f.endsWith('.json') && !f.includes('*'));

  const { dir: legacy, inherited } = legacyLinks(locale);
  const paths = [...new Set(pathsUnder(locale))];
  if (legacy) {
    const takeAll = inherited.has('*');
    for (const rel of new Set(pathsUnder(legacy))) {
      const ns = rel.split('/').pop() ?? '';
      if (takeAll || inherited.has(ns)) paths.push(rel);
    }
  }

  const anyFile = new Map<string, Change[]>();

  for (const rel of paths) {
    const ns = rel.split('/').pop() ?? '';
    const commits = historyOf(rel);
    const shas = resolveBlobs(commits.map((c) => `${c.sha}:${rel}`));
    loadBlobs(shas);

    // Newest first: record only the commits where a key's value actually changed.
    const last = new Map<string, Change>();
    for (let i = 0; i < commits.length; i++) {
      const snapshot = shas[i] ? blobCache.get(shas[i] as string) : null;
      const commit = commits[i];
      if (!snapshot || !commit) continue;

      for (const [key, value] of snapshot) {
        const prev = last.get(key);
        if (prev && prev.value === value) {
          prev.since = commit;
          continue;
        }
        const change: Change = { value, namespace: ns, since: commit, until: prev?.since };
        last.set(key, change);

        const anywhere = anyFile.get(key);
        if (anywhere) anywhere.push(change);
        else anyFile.set(key, [change]);
      }
    }
  }

  return { anyFile };
}

// ---- scan ----

const findings: Finding[] = [];

for (const locale of locales) {
  const history = buildHistory(locale);

  for (const ns of namespaces) {
    const file = path.join(LOCALES_DIR, locale, ns);
    if (!fs.existsSync(file)) continue;
    const locNow = readJson(file);
    if (!locNow) {
      process.stderr.write(`  ! unparseable: ${locale}/${ns}\n`);
      continue;
    }
    const enFlatNow = englishNow.get(ns) ?? new Map<string, string>();

    for (const [key, value] of flatten(locNow)) {
      if (value.trim() === '') continue;

      const enCurrent = enFlatNow.get(key) ?? '';
      const readsEnglish =
        value === enCurrent ||
        englishByKey.get(key)?.has(value) === true ||
        englishCorpus.has(value);
      if (!readsEnglish) continue;

      const finding: Finding = {
        tier: isBenign(value) ? 'benign' : value === enCurrent ? 'untranslated' : 'stale',
        locale,
        namespace: ns,
        key,
        value,
        englishNow: enCurrent,
      };

      // Same file first. Keys also move between namespaces (rules.json retired into
      // pages.json) and get duplicated across them, so a translation for this exact key
      // may be sitting in another file -- that is recoverable rather than lost.
      const changes = history.anyFile.get(key) ?? [];
      for (const pass of ['same', 'any'] as const) {
        if (finding.tier === 'regression') break;
        for (const change of changes) {
          const sameFile = change.namespace === ns;
          if (pass === 'same' && !sameFile) continue;
          if (change.value === value) continue;
          if (englishByKey.get(key)?.has(change.value) === true) continue;
          if (englishCorpus.has(change.value)) {
            if (finding.tier === 'untranslated' || finding.tier === 'stale') {
              finding.tier = 'possible';
              finding.lastTranslated = change.value;
              finding.lastGoodCommit = change.since.sha.slice(0, 8);
              finding.lastGoodDate = change.since.date;
            }
            continue;
          }

          finding.tier = sameFile ? 'regression' : 'recoverable';
          finding.lastTranslated = change.value;
          finding.lastGoodCommit = change.since.sha.slice(0, 8);
          finding.lastGoodDate = change.since.date;
          finding.lostInCommit = change.until?.sha.slice(0, 8);
          finding.lostInDate = change.until?.date;
          finding.lostInSubject = change.until?.subject;
          finding.foundIn = sameFile ? undefined : change.namespace;
          if (sameFile) break;
        }
      }

      findings.push(finding);
    }
  }
  process.stderr.write(`  scanned ${locale}\n`);
}

// ---- report ----

const byTier = (tier: Finding['tier']) => findings.filter((f) => f.tier === tier);
const regressions = byTier('regression');
const recoverable = byTier('recoverable');
const possible = byTier('possible');
const stale = byTier('stale');
const untranslated = byTier('untranslated');
const benign = byTier('benign');

const tally = (rows: Finding[], pick: (f: Finding) => string) => {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(pick(row), (counts.get(pick(row)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('');
console.log('English-regression scan');
console.log(`  locales:        ${locales.length}`);
console.log(`  namespaces:     ${namespaces.join(', ')}`);
console.log('');
console.log(`  regression:     ${regressions.length}   translation overwritten with English`);
console.log(
  `  recoverable:    ${recoverable.length}   reads English here, the same key is translated in another file`
);
console.log(
  `  possible:       ${possible.length}   prior value differed from the source but reads as English elsewhere`
);
console.log(`  stale:          ${stale.length}   outdated English wording left behind`);
console.log(`  untranslated:   ${untranslated.length}   English placeholder, never translated`);
console.log(`  benign:         ${benign.length}   brand names, placeholders, symbols`);
console.log('');

if (regressions.length > 0) {
  console.log('Commits that dropped translations:');
  for (const [label, count] of tally(regressions, (f) =>
    `${f.lostInCommit ?? '????????'} ${f.lostInDate ?? ''} ${f.lostInSubject ?? ''}`.slice(0, 90)
  )) {
    console.log(`  ${String(count).padStart(5)}  ${label}`);
  }
  console.log('');
  console.log('Regressions per locale:');
  for (const [locale, count] of tally(regressions, (f) => f.locale)) {
    console.log(`  ${locale.padEnd(8)} ${count}`);
  }
  console.log('');
}

if (stale.length > 0) {
  console.log('Stale English per locale:');
  for (const [locale, count] of tally(stale, (f) => f.locale)) {
    console.log(`  ${locale.padEnd(8)} ${count}`);
  }
  console.log('');
}

console.log('Untranslated per locale:');
for (const [locale, count] of tally(untranslated, (f) => f.locale)) {
  console.log(`  ${locale.padEnd(8)} ${count}`);
}
console.log('');

for (const tier of ['regression', 'recoverable', 'possible', 'stale', 'untranslated'] as const) {
  if (!show.has(tier)) continue;
  const rows = byTier(tier);
  if (rows.length === 0) continue;
  console.log(`${tier} detail:`);
  for (const f of rows) {
    console.log(`  ${f.locale}/${f.namespace} ${f.key}`);
    console.log(`      now:      ${JSON.stringify(f.value)}`);
    if (tier === 'stale' || tier === 'possible') {
      console.log(`      en today: ${JSON.stringify(f.englishNow)}`);
    }
    if (f.lastTranslated) {
      console.log(
        `      was:      ${JSON.stringify(f.lastTranslated)}  (${f.lastGoodCommit} ${f.lastGoodDate})`
      );
      console.log(`      lost in:  ${f.lostInCommit} ${f.lostInDate} ${f.lostInSubject}`);
      if (f.foundIn) console.log(`      trail in: ${f.foundIn} (key has since moved)`);
    }
  }
  console.log('');
}

if (jsonOut) {
  const target = path.isAbsolute(jsonOut) ? jsonOut : path.join(process.cwd(), jsonOut);
  fs.writeFileSync(target, `${JSON.stringify(findings, null, 2)}\n`, 'utf8');
  console.log(`Full report written to ${target}`);
}

process.exit(regressions.length > 0 ? 1 : 0);
