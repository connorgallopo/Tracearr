import { sql, type SQL } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';
import { db } from '../db/client.js';
import {
  getCompressedSessionChunkRanges,
  uncapDecompressionForTx,
  type ChunkTimeRange,
} from '../db/timescale.js';
import { getRedis } from '../lib/redisShared.js';
import {
  keyAgreesSql,
  keyProvablyReusedSql,
  keyReusingServerTypesSql,
  serverTypesSql,
} from '../services/import/keyRuleSql.js';
import { resolveImportedPlays } from '../services/library/importedPlayIdentity.js';
import { IMPORTED_LINK_REPAIR_VERSION } from './importedLinkRepair.js';
import { CONTAINER_MEDIA_TYPES_SQL } from './poller/database.js';
import {
  byInstant,
  drainWindowsWithBisection,
  type BackfillWalkResult,
  type BackfillWindow,
} from './sessionWalk.js';

/**
 * Where each pass (fresh, repair, unlink) continues in the next batch of the
 * same window: an inclusive started_at upper bound, or null once the pass has
 * nothing left to find.
 */
export type IdentityPassBounds = [string | null, string | null, string | null, string | null];

type Pass = 0 | 1 | 2 | 3;

/**
 * Bumped when a pass is added, so an install that upgraded walks its compressed history once
 * for the new pass without waiting for a library change.
 */
export const IDENTITY_PASSES_VERSION = 1;

/**
 * A rating key is only evidence for a tracked play. An import's key may since have been
 * reused by an unrelated item. On a server whose keys can be reused, an imported row takes a
 * library item by key only when the play and the item agree (keyAgreesSql); elsewhere it does
 * unless the reuse is provable: another media type, or a title and a year that both disagree
 * beyond the resolver's tolerance of a year. libraryKeyMatch.ts states both rules for insert time.
 */
function sameTitleForImport(item: string): SQL {
  // The stored media type is evidence only where the import source stated it: a Playback
  // Reporting import (pr-<row> ids) or a Tautulli import. A Jellystat import on Jellyfin or
  // Emby may carry a heuristic type (legacy rows without a SeriesName), whatever the shape of
  // its id, so its type never refuses the key.
  const sourceStatedType = `(s.external_session_id LIKE 'pr-%'
            OR EXISTS (SELECT 1 FROM servers sv WHERE sv.id = s.server_id
              AND sv.type = ANY(${serverTypesSql((profile) => profile.importsTautulliHistory)})))`;
  return sql`(s.external_session_id IS NULL OR CASE
          WHEN EXISTS (SELECT 1 FROM servers sv WHERE sv.id = s.server_id
            AND sv.type = ANY(${keyReusingServerTypesSql()}))
          THEN ${keyAgreesSql(item)}
          ELSE NOT (${sql.raw(keyProvablyReusedSql(item, sourceStatedType))}) END)`;
}

/** The started_at range a server's gone-key rows are confirmed in: before the floor, at or after the floor last handled. */
export interface GoneKeyWindow {
  floor: Date;
  after: Date | null;
}

interface OrphanImportRow {
  id: string;
  started_at: string;
  server_id: string;
  media_type: string;
  media_title: string;
  grandparent_title: string | null;
  year: number | null;
  season_number: number | null;
  episode_number: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
}

type StampedRows = Array<{ started_at: string }>;

/** A row a key pass read: the media and show ids it writes, or the media id its guard checks. */
interface PassRow {
  id: string;
  started_at: string;
  media_id: string | null;
  show_media_id: string | null;
}

/** How a key pass writes one row it read by a point update: its SET list and its guard. */
interface PointWrite {
  set: (row: PassRow) => SQL;
  guard: (row: PassRow) => SQL;
}

function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return byInstant(a, b) >= 0 ? a : b;
}

function oldestOf(rows: StampedRows): string | null {
  return rows.reduce<string | null>(
    (min, r) => (min === null || byInstant(r.started_at, min) < 0 ? r.started_at : min),
    null
  );
}

/**
 * Per server, the earliest completed full scan among its libraries, for servers whose every
 * library has one on record. A play that started before that time and whose key no library
 * item has ever held was not on the server when it was last listed in full. Only the marker
 * a full scan writes counts; the full-scan-due clock is seeded by incremental syncs too.
 */
export async function fullScanFloors(): Promise<Map<string, Date>> {
  const rows = (await db.execute(sql`SELECT server_id, library_id FROM libraries`)).rows as Array<{
    server_id: string;
    library_id: string;
  }>;
  const redis = getRedis();
  const floors = new Map<string, Date | null>();
  for (const row of rows) {
    const at = await redis.get(
      REDIS_KEYS.LIBRARY_SYNC_FULL_SCAN_DONE(row.server_id, row.library_id)
    );
    const prev = floors.get(row.server_id);
    if (!at || prev === null) {
      floors.set(row.server_id, null);
      continue;
    }
    const scanned = new Date(at);
    floors.set(row.server_id, prev === undefined || scanned < prev ? scanned : prev);
  }
  return new Map([...floors].filter((entry): entry is [string, Date] => entry[1] !== null));
}

/**
 * A tracked play may take the title path only once its key is confirmed gone: no library
 * item on its server has ever held the key, and every library of the server has completed
 * a full scan after the play. Anything else could still sync and is stamped by exact key.
 */
function confirmedAbsentSql(floors: Map<string, GoneKeyWindow>): SQL {
  if (floors.size === 0) return sql`false`;
  // Only rows the title pass can resolve: a movie needs a title or a provider id, an episode
  // its show title and both numbers (importedPlayIdentity.ts). Plain trimmed emptiness, not the
  // normalizer's alphanumeric test, so no database ctype narrows what resolves.
  return sql`(
    (s.media_type = 'movie' AND (trim(s.media_title) <> '' OR s.imdb_id IS NOT NULL
      OR s.tmdb_id IS NOT NULL OR s.tvdb_id IS NOT NULL))
    OR (s.media_type = 'episode' AND s.season_number >= 0 AND s.episode_number IS NOT NULL
      AND trim(COALESCE(s.grandparent_title, '')) <> '')
  ) AND EXISTS (
    SELECT 1 FROM (VALUES ${sql.join(
      [...floors].map(
        ([serverId, w]) =>
          sql`(${serverId}::uuid, ${w.floor.toISOString()}::timestamptz, ${w.after ? w.after.toISOString() : null}::timestamptz)`
      ),
      sql`, `
    )}) AS f(server_id, scanned_at, handled_at)
    WHERE f.server_id = s.server_id AND s.started_at < f.scanned_at
      AND (f.handled_at IS NULL OR s.started_at >= f.handled_at)
  ) AND NOT EXISTS (
    SELECT 1 FROM library_items li3
    WHERE li3.server_id = s.server_id AND li3.rating_key = s.rating_key
  )`;
}

const GONE_KEYS_HANDLED_TTL = 30 * 24 * 60 * 60;

/** Each server's floor with the floor last handled for it; rows older than that were already attempted. */
export async function goneKeyWindows(
  floors: Map<string, Date>
): Promise<Map<string, GoneKeyWindow>> {
  const redis = getRedis();
  const windows = new Map<string, GoneKeyWindow>();
  for (const [serverId, floor] of floors) {
    const handled = await redis.get(REDIS_KEYS.LIBRARY_SYNC_GONE_KEYS_HANDLED(serverId));
    windows.set(serverId, { floor, after: handled ? new Date(handled) : null });
  }
  return windows;
}

/** The windows the sync tail has not handled yet: no record for the server, or a floor that advanced since. */
export async function unhandledGoneKeyFloors(
  floors: Map<string, Date>
): Promise<Map<string, GoneKeyWindow>> {
  const windows = await goneKeyWindows(floors);
  return new Map([...windows].filter(([, w]) => !w.after || w.after < w.floor));
}

export async function markGoneKeyFloorsHandled(floors: Map<string, GoneKeyWindow>): Promise<void> {
  const redis = getRedis();
  for (const [serverId, w] of floors) {
    await redis.set(
      REDIS_KEYS.LIBRARY_SYNC_GONE_KEYS_HANDLED(serverId),
      w.floor.toISOString(),
      'EX',
      GONE_KEYS_HANDLED_TTL
    );
  }
}

/** Whether any tracked play still unlinked sits on a confirmed-gone key, optionally only before `before`. */
export async function hasConfirmedAbsentTrackedRows(
  floors: Map<string, GoneKeyWindow>,
  before?: Date | null
): Promise<boolean> {
  if (floors.size === 0) return false;
  // The windows' outer bounds as plain started_at predicates, so chunk exclusion applies:
  // after the first handling the probe reads one scan cycle of chunks, not the whole table.
  const windows = [...floors.values()];
  const newest = new Date(Math.max(...windows.map((w) => w.floor.getTime())));
  const afters = windows.map((w) => w.after);
  const oldest = afters.every((a): a is Date => a !== null)
    ? new Date(Math.min(...afters.map((a) => a.getTime())))
    : null;
  const { rows } = await db.execute(sql`
    SELECT 1 FROM sessions s
    WHERE s.media_id IS NULL AND s.rating_key IS NOT NULL AND s.external_session_id IS NULL
      AND s.media_type IN ('movie', 'episode')
      AND s.started_at < ${newest.toISOString()}::timestamptz
      ${oldest ? sql`AND s.started_at >= ${oldest.toISOString()}::timestamptz` : sql``}
      ${before ? sql`AND s.started_at < ${before.toISOString()}::timestamptz` : sql``}
      AND ${confirmedAbsentSql(floors)}
    LIMIT 1
  `);
  return rows.length > 0;
}

/**
 * Above this many rows a pass over a compressed chunk writes with one window-bounded statement
 * instead of point updates. A point update costs about a millisecond and decompresses the batch
 * holding its row, while the window statement decompresses the whole window once whatever it
 * writes. On TimescaleDB 2.31 over a 40,000-row chunk with the changed rows spread across it,
 * the two cost the same at about 60 rows; 2.28 crosses later.
 */
export const MAX_POINT_UPDATES_PER_PASS = 50;

/**
 * Runs one key pass. `select` reads its rows (id, started_at, media_id, show_media_id); the window
 * statement selects and writes them in one statement. A window with no
 * compressed chunk takes that statement directly, under the default decompression cap, so a chunk
 * compressed after the check fails the statement instead of decompressing, and the next batch
 * retries. Over a compressed chunk the select runs read-only first and nothing is written when it
 * finds nothing: the window statement's constant bounds decompress every batch they reach, even
 * with nothing to write. Up to MAX_POINT_UPDATES_PER_PASS rows then each take a point update on
 * constant (id, started_at), which decompresses only the batch holding the row and skips a row
 * the guard says changed since the read; a join-driven UPDATE on a partially compressed chunk
 * without constant bounds would reach only the rows already outside its compressed batches. More
 * rows take the window statement.
 */
async function runPass(
  select: SQL,
  windowWrite: SQL,
  compressed: boolean,
  point: PointWrite
): Promise<{ read: StampedRows; written: StampedRows }> {
  if (!compressed) {
    const written = (await db.execute(windowWrite)).rows as unknown as StampedRows;
    return { read: written, written };
  }
  // Raw db.execute results carry timestamptz columns as Postgres text, not Date.
  const rows = (await db.execute(select)).rows as unknown as PassRow[];
  if (rows.length === 0) return { read: [], written: [] };
  return db.transaction(async (tx) => {
    await uncapDecompressionForTx(tx);
    if (rows.length > MAX_POINT_UPDATES_PER_PASS) {
      const written = (await tx.execute(windowWrite)).rows as unknown as StampedRows;
      return { read: written, written };
    }
    const written: StampedRows = [];
    for (const row of rows) {
      const { rows: one } = await tx.execute(sql`
        UPDATE sessions s SET ${point.set(row)}
        WHERE s.id = ${row.id}::uuid AND s.started_at = ${row.started_at}::timestamptz
          AND ${point.guard(row)}
        RETURNING s.started_at
      `);
      written.push(...(one as unknown as StampedRows));
    }
    return { read: rows, written };
  });
}

/**
 * Stamp canonical media identity onto historical sessions in one bounded batch.
 *
 * Four passes, each windowed the same way (ORDER BY started_at DESC LIMIT):
 * - Fresh stamp: joins sessions to library_items on (server_id, rating_key) and
 *   fills the resolved media id and show id. Nothing else on a row is written:
 *   history keeps its own provider ids, keys and titles. Sessions whose rating
 *   key has no non-container library item pointing at a non-container media row
 *   are excluded so they never re-select; an imported row also needs the item to
 *   carry its title (sameTitleForImport), since its key may have been reused.
 * - Show-link repair: sessions that already have media_id but were stamped before
 *   their media row's show_media_id existed (e.g. the show synced later). Re-running
 *   this is safe - a repaired session no longer matches either pass's WHERE clause.
 * - Container unlink: sessions linked to a show, season, artist or album media row
 *   lose their media and provider ids. The fresh stamp refuses container items, so
 *   an unlinked session is never stamped back onto one.
 * - Imported plays still without identity after the key passes resolve through
 *   the media resolver by title, year and episode numbers (importedPlayIdentity.ts),
 *   as a fresh import does at insert. A tracked play takes this path only when its
 *   rating key is confirmed gone from the server (fullScanFloors): otherwise what is
 *   playing exists there, its key is exact and the sync of the item stamps it.
 *   A row the fresh stamp could still take by key is left to it,
 *   so a batch limit never sends a keyed row down the title path. Every row the
 *   pass reads is handled, linked or not, so its bound moves past rows that
 *   cannot resolve instead of re-reading them.
 *
 * The optional started_at window is what keeps this survivable on a compressed
 * hypertable. Over a compressed chunk each pass reads its rows first and writes
 * only those (runPass), so a window with nothing to change decompresses nothing,
 * a few changed rows decompress a batch each and more decompress the window. The
 * per-transaction cap is lifted inside that bound - a compressed batch holds up
 * to 1,000 rows, so about a hundred changed rows reach the 100k default, and
 * tripping the cap turns the walk into a fail-retry loop.
 * The window is the memory guard, not the cap; an unwindowed batch with the
 * cap disabled globally is what once ballooned until the OOM killer took
 * postgres down.
 *
 * `bounds` is the cursor the previous batch of the same window returned. Each
 * pass picks its newest rows first, so a pass that filled its limit has
 * written every match newer than its oldest row, and one that came back short
 * has written every match below its bound. A written row stops matching its
 * own pass, which is why the bound can be inclusive without an id tiebreak:
 * only unwritten ties come back. The passes feed each other, though. A fresh
 * stamp can create repair work in the same batch, and an unlink can create
 * fresh work for the next one, so a pass's next bound also covers the rows the
 * pass feeding it wrote or will write.
 */
export async function backfillSessionIdentityBatch(
  limit: number,
  window?: BackfillWindow,
  bounds?: IdentityPassBounds,
  options?: {
    /**
     * Whether the imported-play resolver pass runs. The sync tail leaves it to the
     * maintenance walk, or a tail with a library change would re-read and re-resolve
     * the same unresolvable recent imports every time; imports resolve at insert.
     */
    resolveImports?: boolean;
    /** The gone-key windows per server, when the caller already read them. */
    absentKeyFloors?: Map<string, GoneKeyWindow>;
  }
): Promise<{
  updated: number;
  /** Rows the import pass read, linked or not; what keeps a window draining. */
  examined: number;
  oldest: Date | null;
  cursor: IdentityPassBounds;
}> {
  if (bounds?.every((bound) => bound === null)) {
    return { updated: 0, examined: 0, oldest: null, cursor: bounds };
  }
  const startFilter = window?.start
    ? sql`AND s.started_at >= ${window.start.toISOString()}::timestamptz`
    : sql``;
  const endFilter = window?.end
    ? sql`AND s.started_at < ${window.end.toISOString()}::timestamptz`
    : sql``;
  const range = (pass: Pass): SQL => {
    const bound = bounds?.[pass];
    return bound
      ? sql`${startFilter} ${endFilter} AND s.started_at <= ${bound}::timestamptz`
      : sql`${startFilter} ${endFilter}`;
  };
  const skip = (pass: Pass) => bounds?.[pass] === null;
  const resolveByTitle = !skip(3) && options?.resolveImports !== false;
  const confirmedAbsent = confirmedAbsentSql(
    resolveByTitle
      ? (options?.absentKeyFloors ?? (await goneKeyWindows(await fullScanFloors())))
      : new Map<string, GoneKeyWindow>()
  );

  const compressed = (await getCompressedSessionChunkRanges()).some(
    (chunk) =>
      (!window?.start || chunk.end > window.start) && (!window?.end || chunk.start < window.end)
  );
  const none = { read: [], written: [] };
  const pass = (n: Pass, select: SQL, windowWrite: SQL, point: PointWrite) =>
    skip(n) ? none : runPass(select, windowWrite, compressed, point);

  const fresh = await pass(
    0,
    sql`
      SELECT s.id, s.started_at, li.media_id,
        CASE WHEN li.media_type = 'episode' THEN m.show_media_id END AS show_media_id
      FROM sessions s
      JOIN library_items li ON li.server_id = s.server_id AND li.rating_key = s.rating_key
      JOIN media m ON m.id = li.media_id
      WHERE s.media_id IS NULL AND s.rating_key IS NOT NULL
        ${range(0)}
        AND li.media_id IS NOT NULL
        AND li.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
        AND m.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
        AND ${sameTitleForImport('li')}
      ORDER BY s.started_at DESC
      LIMIT ${limit}
    `,
    sql`
      WITH batch AS (
        SELECT s.id, s.started_at, s.server_id, s.rating_key
        FROM sessions s
        WHERE s.media_id IS NULL AND s.rating_key IS NOT NULL
          ${range(0)}
          AND EXISTS (
            SELECT 1 FROM library_items li2
            JOIN media m2 ON m2.id = li2.media_id
            WHERE li2.server_id = s.server_id AND li2.rating_key = s.rating_key
              AND li2.media_id IS NOT NULL
              AND li2.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
              AND m2.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
              AND ${sameTitleForImport('li2')}
          )
        ORDER BY s.started_at DESC
        LIMIT ${limit}
      )
      UPDATE sessions s
      SET media_id = li.media_id,
          show_media_id = CASE WHEN li.media_type = 'episode' THEN m.show_media_id END
      FROM batch b
      JOIN library_items li ON li.server_id = b.server_id AND li.rating_key = b.rating_key
      JOIN media m ON m.id = li.media_id
      WHERE s.id = b.id AND s.started_at = b.started_at AND li.media_id IS NOT NULL
        AND li.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
        AND m.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
        AND ${sameTitleForImport('li')}
        ${range(0)}
      RETURNING s.started_at
    `,
    {
      set: (row) =>
        sql`media_id = ${row.media_id}::uuid, show_media_id = ${row.show_media_id}::uuid`,
      guard: () => sql`s.media_id IS NULL`,
    }
  );

  // Read after the fresh stamp commits: a row it stamped without a show can be repair work.
  const repairSelect = sql`
    SELECT s.id, s.started_at, s.media_id, m.show_media_id
    FROM sessions s
    JOIN media m ON m.id = s.media_id
    WHERE s.media_id IS NOT NULL AND s.show_media_id IS NULL AND m.show_media_id IS NOT NULL
      ${range(1)}
    ORDER BY s.started_at DESC
    LIMIT ${limit}
  `;
  const repair = await pass(
    1,
    repairSelect,
    sql`
      WITH batch AS (${repairSelect})
      UPDATE sessions s
      SET show_media_id = b.show_media_id
      FROM batch b
      WHERE s.id = b.id AND s.started_at = b.started_at
        ${range(1)}
      RETURNING s.started_at
    `,
    {
      set: (row) => sql`show_media_id = ${row.show_media_id}::uuid`,
      guard: (row) => sql`s.show_media_id IS NULL AND s.media_id = ${row.media_id}::uuid`,
    }
  );

  const unlinkSelect = sql`
    SELECT s.id, s.started_at, s.media_id, NULL::uuid AS show_media_id
    FROM sessions s
    JOIN media m ON m.id = s.media_id
    WHERE m.media_type IN (${CONTAINER_MEDIA_TYPES_SQL})
      ${range(2)}
    ORDER BY s.started_at DESC
    LIMIT ${limit}
  `;
  const unlinkSet = sql`media_id = NULL, show_media_id = NULL, imdb_id = NULL, tmdb_id = NULL, tvdb_id = NULL`;
  const unlink = await pass(
    2,
    unlinkSelect,
    sql`
      WITH batch AS (${unlinkSelect})
      UPDATE sessions s
      SET ${unlinkSet}
      FROM batch b
      WHERE s.id = b.id AND s.started_at = b.started_at
        ${range(2)}
      RETURNING s.started_at
    `,
    {
      set: () => unlinkSet,
      guard: () => sql`EXISTS (
        SELECT 1 FROM media m
        WHERE m.id = s.media_id AND m.media_type IN (${CONTAINER_MEDIA_TYPES_SQL}))`,
    }
  );

  // A play the imported link repair unlinked and could not place stays unlinked: the title
  // path would file it by the same fields the repair refused.
  const orphanRows = !resolveByTitle
    ? []
    : ((
        await db.execute(sql`
      SELECT s.id, s.started_at, s.server_id, s.media_type, s.media_title, s.grandparent_title,
        s.year, s.season_number, s.episode_number, s.imdb_id, s.tmdb_id, s.tvdb_id
      FROM sessions s
      WHERE s.media_id IS NULL AND s.rating_key IS NOT NULL
        AND (s.external_session_id IS NOT NULL OR ${confirmedAbsent})
        AND s.media_type IN ('movie', 'episode')
        AND NOT EXISTS (
          SELECT 1 FROM library_items li2
          JOIN media m2 ON m2.id = li2.media_id
          WHERE li2.server_id = s.server_id AND li2.rating_key = s.rating_key
            AND li2.media_id IS NOT NULL
            AND li2.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
            AND m2.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
            AND ${sameTitleForImport('li2')}
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_link_repairs r
          WHERE r.session_id = s.id AND r.started_at = s.started_at
            AND r.repair_version = ${IMPORTED_LINK_REPAIR_VERSION} AND r.relinked_at IS NULL
        )
        ${range(3)}
      ORDER BY s.started_at DESC
      LIMIT ${limit}
    `)
      ).rows as unknown as OrphanImportRow[]);

  // The resolver runs its own short transactions; keeping it outside the key passes' transaction
  // keeps that transaction as short as the key passes alone, so the maintenance walk and the
  // sync tail never hold session rows across a resolver round trip.
  const importRows: StampedRows = [];
  if (orphanRows.length > 0) {
    const plays = orphanRows.map((row) => ({
      row,
      serverId: row.server_id,
      mediaType: row.media_type,
      mediaTitle: row.media_title,
      grandparentTitle: row.grandparent_title,
      year: row.year,
      seasonNumber: row.season_number,
      episodeNumber: row.episode_number,
      imdbId: row.imdb_id,
      tmdbId: row.tmdb_id,
      tvdbId: row.tvdb_id,
    }));
    const { identities } = await resolveImportedPlays(plays);
    if (identities.size > 0) {
      await db.transaction(async (tx) => {
        await uncapDecompressionForTx(tx);
        // One point update per row, newest first as read: TimescaleDB applies a join-driven
        // UPDATE to a partially compressed chunk only for the rows already outside its
        // compressed segments, while constant bounds reach every row.
        for (const [play, identity] of identities) {
          const written = (
            await tx.execute(sql`
      UPDATE sessions s
      SET media_id = ${identity.mediaId}::uuid, show_media_id = ${identity.showMediaId}::uuid
      WHERE s.id = ${play.row.id}::uuid AND s.started_at = ${play.row.started_at}::timestamptz
        AND s.media_id IS NULL
      RETURNING s.started_at
    `)
          ).rows as unknown as StampedRows;
          importRows.push(...written);
        }
      });
    }
  }

  const own = (rows: StampedRows) => (rows.length >= limit ? oldestOf(rows) : null);
  const newestUnlinked = unlink.written.reduce<string | null>(
    (max, r) => laterOf(max, r.started_at),
    null
  );
  const nextFresh = laterOf(own(fresh.read), newestUnlinked);
  const oldest = oldestOf([...fresh.written, ...repair.written, ...unlink.written, ...importRows]);
  return {
    updated:
      fresh.written.length + repair.written.length + unlink.written.length + importRows.length,
    examined: orphanRows.length,
    oldest: oldest ? new Date(oldest) : null,
    cursor: [
      nextFresh,
      laterOf(own(repair.read), nextFresh),
      own(unlink.read),
      laterOf(own(orphanRows), newestUnlinked),
    ],
  };
}

/**
 * Existence probe for identity work remaining below a cutoff on one server's
 * rating keys - the sync tail asks it about the keys it upserted to decide
 * whether compressed history still needs the maintenance walk. Mirrors the
 * three passes of backfillSessionIdentityBatch in one statement. The keys go
 * in through unnest, not = ANY: the planner copies an ANY array into every
 * chunk's plan, so planning memory grows with keys times chunks (175 MB for
 * 1,000 keys over 139 chunks), while unnest planned 18k keys there in 64 MB.
 */
export async function hasStampableSessionsBefore(
  cutoff: Date,
  serverId: string,
  ratingKeys: string[]
): Promise<boolean> {
  const before = cutoff.toISOString();
  const scope = sql`s.server_id = ${serverId}::uuid
        AND s.rating_key IN (SELECT unnest(${sql.param(ratingKeys)}::text[]))
        AND s.started_at < ${before}::timestamptz`;
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.media_id IS NULL AND s.rating_key IS NOT NULL
        AND ${scope}
        AND EXISTS (
          SELECT 1 FROM library_items li
          JOIN media m ON m.id = li.media_id
          WHERE li.server_id = s.server_id AND li.rating_key = s.rating_key
            AND li.media_id IS NOT NULL
            AND li.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
            AND m.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
            AND ${sameTitleForImport('li')}
        )
    ) OR EXISTS (
      SELECT 1 FROM sessions s
      JOIN media m ON m.id = s.media_id
      WHERE s.show_media_id IS NULL AND m.show_media_id IS NOT NULL
        AND ${scope}
    ) OR EXISTS (
      SELECT 1 FROM sessions s
      JOIN media m ON m.id = s.media_id
      WHERE m.media_type IN (${CONTAINER_MEDIA_TYPES_SQL})
        AND ${scope}
    ) AS stampable
  `);
  return (result.rows[0] as { stampable?: boolean } | undefined)?.stampable === true;
}

/**
 * Drain the whole backlog: the uncompressed region first (everything newer
 * than the newest compressed chunk), then each compressed chunk as its own
 * bounded window, newest first, then each chunk that sits below the horizon
 * without being compressed (e.g. a manually decompressed one).
 *
 * Every chunk window goes through drainWindowsWithBisection, so a failing
 * chunk is bisected and recorded rather than blocking the rest of history. The
 * uncompressed chunks below the horizon are skipped after any compressed-chunk
 * failure, so a failed walk stops where it failed.
 */
export async function runSessionIdentityBackfillWalk(deps: {
  batchSize: number;
  getCompressedRanges: () => Promise<ChunkTimeRange[]>;
  getChunkRanges: () => Promise<ChunkTimeRange[]>;
  runBatch?: (
    limit: number,
    window?: BackfillWindow,
    bounds?: IdentityPassBounds,
    options?: { absentKeyFloors?: Map<string, GoneKeyWindow> }
  ) => Promise<{
    updated: number;
    examined?: number;
    oldest: Date | null;
    cursor?: IdentityPassBounds;
  }>;
  /** Called after every batch with the running total (progress + lock extension) */
  onBatch?: (total: number) => Promise<void>;
  /** Called as soon as a batch commits, with its oldest touched started_at */
  onCommit?: (oldest: Date | null) => void;
}): Promise<BackfillWalkResult> {
  const {
    batchSize,
    getCompressedRanges,
    getChunkRanges,
    runBatch = backfillSessionIdentityBatch,
    onBatch,
    onCommit,
  } = deps;
  let total = 0;
  let earliest: Date | null = null;
  // Read once, so every window resolves gone keys against the same floors, and marked
  // handled only when the whole walk succeeded.
  const absentKeyFloors = await goneKeyWindows(await fullScanFloors());

  // Totals accumulate here rather than from each drain's result: a drain that
  // rejects still committed the batches before the failure, and they must count.
  const stamp = async (window: BackfillWindow | undefined, bounds?: IdentityPassBounds) => {
    const batch = await runBatch(batchSize, window, bounds, { absentKeyFloors });
    total += batch.updated;
    if (batch.oldest && (!earliest || batch.oldest < earliest)) earliest = batch.oldest;
    onCommit?.(batch.oldest);
    return {
      count: Math.max(batch.updated, batch.examined ?? 0),
      oldest: batch.oldest,
      cursor: batch.cursor,
    };
  };
  const opts = {
    batchSize,
    label: 'SessionIdentityBackfill',
    onBatch: async () => {
      await onBatch?.(total);
    },
  };

  const compressed = await getCompressedRanges();
  const horizon = compressed[0]?.end;
  // Uncaught on purpose: this region is uncompressed, so a failure here is a
  // plain SQL or connectivity fault rather than a decompression-cap trip.
  await drainWindowsWithBisection<IdentityPassBounds>(
    null,
    (_window, bounds) => stamp(horizon ? { start: horizon } : undefined, bounds),
    opts
  );

  const { failedRanges } = await drainWindowsWithBisection<IdentityPassBounds>(
    compressed,
    (window, bounds) => stamp(window ?? undefined, bounds),
    opts
  );

  if (horizon && failedRanges.length === 0) {
    const compressedStarts = new Set(compressed.map((range) => range.start.getTime()));
    const uncompressedBelow = (await getChunkRanges()).filter(
      (range) => range.start < horizon && !compressedStarts.has(range.start.getTime())
    );
    // A chunk compressed after the list was read trips the cap like any
    // compressed chunk would, and is bisected and recorded the same way.
    const sweep = await drainWindowsWithBisection<IdentityPassBounds>(
      uncompressedBelow,
      (window, bounds) => stamp(window ?? undefined, bounds),
      opts
    );
    failedRanges.push(...sweep.failedRanges);
  }
  if (failedRanges.length === 0) await markGoneKeyFloorsHandled(absentKeyFloors);

  return { total, earliest, failedRanges };
}
