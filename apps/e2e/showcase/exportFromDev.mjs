#!/usr/bin/env node
/**
 * Pulls poster artwork and title metadata out of a real Tracearr install so
 * the showcase seed can render a library that looks lived-in. Reads the dev
 * database and the server's poster cache (data/image-cache), never a media
 * server. Output lands in apps/e2e/showcase/assets/ (git-ignored):
 *
 *   assets/titles.json       [{ type, title, year, genres, resolution, dynamicRange, fileSize, poster }]
 *   assets/posters/<n>.webp  360x540 poster already resized by the proxy
 *
 *   node apps/e2e/showcase/exportFromDev.mjs [--movies 80] [--shows 30]
 *
 * DEV_DATABASE_URL defaults to the root .env DATABASE_URL, DEV_SERVER_ID to
 * the first plex server, DEV_IMAGE_CACHE to apps/server/data/image-cache.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
try {
  process.loadEnvFile(resolve(repoRoot, '.env'));
} catch {
  // .env is optional when DEV_DATABASE_URL is given
}

/**
 * @typedef {{ type: 'movie' | 'show', title: string, year: number, genres: string[] | null,
 *   resolution: string | null, dynamicRange: string | null, fileSize: string | null,
 *   thumbPath: string, ratingKey: string }} ItemRow
 * @typedef {Omit<ItemRow, 'thumbPath' | 'ratingKey' | 'fileSize' | 'genres'> &
 *   { genres: string[], fileSize: number | null, poster: string }} Title
 */

const args = process.argv.slice(2);
/** @param {string} name @param {number} fallback */
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const movieCount = arg('movies', 80);
const showCount = arg('shows', 30);

const databaseUrl = process.env.DEV_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DEV_DATABASE_URL or DATABASE_URL is required');
  process.exit(1);
}
const cacheDir = process.env.DEV_IMAGE_CACHE ?? resolve(repoRoot, 'apps/server/data/image-cache');
const outDir = resolve(here, 'assets');
const posterDir = resolve(outDir, 'posters');
mkdirSync(posterDir, { recursive: true });

// Mirrors apps/server/src/services/imageProxy.ts: key is the first 16 hex of
// sha256(server:path:width:height), sharded by its first two chars, and
// posters carry a version suffix of the first 8 hex of sha1(path).
/** @param {string} serverId @param {string} thumbPath */
function cachedPosterPath(serverId, thumbPath) {
  const key = createHash('sha256')
    .update(`${serverId}:${thumbPath}:360:540`)
    .digest('hex')
    .slice(0, 16);
  const version = createHash('sha1').update(thumbPath).digest('hex').slice(0, 8);
  return resolve(cacheDir, key.slice(0, 2), `${key}:v${version}.webp`);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const serverId =
    process.env.DEV_SERVER_ID ??
    /** @type {{ rows: { id: string }[] }} */ (
      await client.query(
        `SELECT id FROM servers WHERE type = 'plex' ORDER BY display_order LIMIT 1`
      )
    ).rows[0]?.id;
  if (!serverId) throw new Error('no plex server in the dev database');

  const { rows } = /** @type {{ rows: ItemRow[] }} */ (
    await client.query(
      `SELECT media_type AS type, title, year, genres, video_resolution AS resolution,
            video_dynamic_range AS "dynamicRange", file_size AS "fileSize", thumb_path AS "thumbPath",
            rating_key AS "ratingKey"
     FROM library_items
     WHERE server_id = $1 AND media_type IN ('movie', 'show') AND thumb_path IS NOT NULL
       AND removed_at IS NULL AND year IS NOT NULL
     ORDER BY created_at DESC`,
      [serverId]
    )
  );

  /** @type {{ movie: Title[], show: Title[] }} */
  const picked = { movie: [], show: [] };
  const limits = { movie: movieCount, show: showCount };
  const seenTitles = new Set();
  let n = 0;
  for (const row of rows) {
    if (picked[row.type].length >= limits[row.type]) continue;
    const key = `${row.type}:${row.title}:${row.year}`;
    if (seenTitles.has(key)) continue;
    const source = cachedPosterPath(serverId, row.thumbPath);
    if (!existsSync(source)) continue;
    seenTitles.add(key);
    n += 1;
    const poster = `${n}.webp`;
    copyFileSync(source, resolve(posterDir, poster));
    picked[row.type].push({
      type: row.type,
      title: row.title,
      year: row.year,
      genres: row.genres ?? [],
      resolution: row.resolution,
      dynamicRange: row.dynamicRange,
      fileSize: row.fileSize === null ? null : Number(row.fileSize),
      poster,
    });
  }

  const titles = [...picked.movie, ...picked.show];
  writeFileSync(resolve(outDir, 'titles.json'), JSON.stringify(titles, null, 2) + '\n');
  console.log(
    `${picked.movie.length} movies and ${picked.show.length} shows with cached posters written to ${outDir}`
  );
} finally {
  await client.end();
}
