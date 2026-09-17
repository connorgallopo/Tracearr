import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { uncapDecompressionForTx, type ChunkTimeRange } from '../db/timescale.js';
import { CONTAINER_MEDIA_TYPES_SQL } from './poller/database.js';
import {
  BackfillRangeError,
  drainWindowsWithBisection,
  type BackfillWalkResult,
  type BackfillWindow,
} from './sessionWalk.js';

/**
 * Stamp canonical media identity onto historical sessions in one bounded batch.
 *
 * Three passes, each windowed the same way (ORDER BY started_at DESC LIMIT):
 * - Fresh stamp: joins sessions to library_items on (server_id, rating_key) and
 *   copies the resolved media id, show id, and provider ids. Sessions whose rating
 *   key has no non-container library item pointing at a non-container media row
 *   are excluded so they never re-select.
 * - Show-link repair: sessions that already have media_id but were stamped before
 *   their media row's show_media_id existed (e.g. the show synced later). Re-running
 *   this is safe - a repaired session no longer matches either pass's WHERE clause.
 * - Container unlink: sessions linked to a show, season, artist or album media row
 *   lose their media and provider ids. The fresh stamp refuses container items, so
 *   an unlinked session is never stamped back onto one.
 *
 * The optional started_at window is what keeps this survivable on a compressed
 * hypertable: one transaction per chunk bounds tuple decompression to a single
 * chunk's segments. The per-transaction cap is lifted inside that bound - a
 * busy month-chunk decompresses more tuples than the 100k default even for a
 * 10k-row batch, and tripping the cap turns the walk into a fail-retry loop.
 * The window is the memory guard, not the cap; an unwindowed batch with the
 * cap disabled globally is what once ballooned until the OOM killer took
 * postgres down.
 */
export async function backfillSessionIdentityBatch(
  limit: number,
  window?: BackfillWindow
): Promise<{ updated: number; oldest: Date | null }> {
  const startFilter = window?.start
    ? sql`AND s.started_at >= ${window.start.toISOString()}::timestamptz`
    : sql``;
  const endFilter = window?.end
    ? sql`AND s.started_at < ${window.end.toISOString()}::timestamptz`
    : sql``;

  const rows = await db.transaction(async (tx) => {
    await uncapDecompressionForTx(tx);
    const fresh = await tx.execute(sql`
      WITH batch AS (
        SELECT s.id, s.started_at, s.server_id, s.rating_key
        FROM sessions s
        WHERE s.media_id IS NULL AND s.rating_key IS NOT NULL
          ${startFilter}
          ${endFilter}
          AND EXISTS (
            SELECT 1 FROM library_items li2
            JOIN media m2 ON m2.id = li2.media_id
            WHERE li2.server_id = s.server_id AND li2.rating_key = s.rating_key
              AND li2.media_id IS NOT NULL
              AND li2.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
              AND m2.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
          )
        ORDER BY s.started_at DESC
        LIMIT ${limit}
      )
      UPDATE sessions s
      SET media_id = li.media_id,
          show_media_id = CASE WHEN li.media_type = 'episode' THEN m.show_media_id END,
          imdb_id = li.imdb_id,
          tmdb_id = li.tmdb_id,
          tvdb_id = li.tvdb_id,
          parent_rating_key = li.parent_rating_key,
          grandparent_rating_key = li.grandparent_rating_key
      FROM batch b
      JOIN library_items li ON li.server_id = b.server_id AND li.rating_key = b.rating_key
      JOIN media m ON m.id = li.media_id
      WHERE s.id = b.id AND s.started_at = b.started_at AND li.media_id IS NOT NULL
        AND li.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
        AND m.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
        ${startFilter}
        ${endFilter}
      RETURNING s.started_at
    `);

    const repair = await tx.execute(sql`
      WITH batch AS (
        SELECT s.id, s.started_at, m.show_media_id AS new_show_media_id
        FROM sessions s
        JOIN media m ON m.id = s.media_id
        WHERE s.media_id IS NOT NULL AND s.show_media_id IS NULL AND m.show_media_id IS NOT NULL
          ${startFilter}
          ${endFilter}
        ORDER BY s.started_at DESC
        LIMIT ${limit}
      )
      UPDATE sessions s
      SET show_media_id = b.new_show_media_id
      FROM batch b
      WHERE s.id = b.id AND s.started_at = b.started_at
        ${startFilter}
        ${endFilter}
      RETURNING s.started_at
    `);

    const unlink = await tx.execute(sql`
      WITH batch AS (
        SELECT s.id, s.started_at
        FROM sessions s
        JOIN media m ON m.id = s.media_id
        WHERE m.media_type IN (${CONTAINER_MEDIA_TYPES_SQL})
          ${startFilter}
          ${endFilter}
        ORDER BY s.started_at DESC
        LIMIT ${limit}
      )
      UPDATE sessions s
      SET media_id = NULL, show_media_id = NULL, imdb_id = NULL, tmdb_id = NULL, tvdb_id = NULL
      FROM batch b
      WHERE s.id = b.id AND s.started_at = b.started_at
        ${startFilter}
        ${endFilter}
      RETURNING s.started_at
    `);

    return [...fresh.rows, ...repair.rows, ...unlink.rows];
  });
  // Raw db.execute results carry timestamptz columns as Postgres text, not Date.
  const combined = rows as unknown as Array<{ started_at: string }>;
  const oldestStr = combined.reduce<string | null>(
    (min, r) => (min === null || r.started_at < min ? r.started_at : min),
    null
  );
  return { updated: combined.length, oldest: oldestStr ? new Date(oldestStr) : null };
}

/**
 * Cheap existence probe for identity work remaining below a cutoff - the sync
 * tail uses this to decide whether compressed history still needs the
 * maintenance walk. Mirrors the three passes of backfillSessionIdentityBatch
 * in one statement.
 */
export async function hasStampableSessionsBefore(cutoff: Date): Promise<boolean> {
  const before = cutoff.toISOString();
  const result = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.media_id IS NULL AND s.rating_key IS NOT NULL
        AND s.started_at < ${before}::timestamptz
        AND EXISTS (
          SELECT 1 FROM library_items li
          JOIN media m ON m.id = li.media_id
          WHERE li.server_id = s.server_id AND li.rating_key = s.rating_key
            AND li.media_id IS NOT NULL
            AND li.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
            AND m.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
        )
    ) OR EXISTS (
      SELECT 1 FROM sessions s
      JOIN media m ON m.id = s.media_id
      WHERE s.show_media_id IS NULL AND m.show_media_id IS NOT NULL
        AND s.started_at < ${before}::timestamptz
    ) OR EXISTS (
      SELECT 1 FROM sessions s
      JOIN media m ON m.id = s.media_id
      WHERE m.media_type IN (${CONTAINER_MEDIA_TYPES_SQL})
        AND s.started_at < ${before}::timestamptz
    ) AS stampable
  `);
  return (result.rows[0] as { stampable?: boolean } | undefined)?.stampable === true;
}

/**
 * Drain the whole backlog: the uncompressed region first (everything newer
 * than the newest compressed chunk), then each compressed chunk as its own
 * bounded window, newest first, then one unwindowed sweep for rows in chunks
 * that sit below the horizon without being compressed (e.g. manually
 * decompressed ones - already stamped rows don't match the batch queries, so
 * the sweep only ever touches those stragglers).
 *
 * Compressed chunks go through drainWindowsWithBisection, so a failing chunk
 * is bisected and recorded rather than blocking the rest of history. The sweep
 * is skipped after any failure since it would just re-hit the same rows.
 */
export async function runSessionIdentityBackfillWalk(deps: {
  batchSize: number;
  getCompressedRanges: () => Promise<ChunkTimeRange[]>;
  runBatch?: typeof backfillSessionIdentityBatch;
  /** Called after every batch with the running total (progress + lock extension) */
  onBatch?: (total: number) => Promise<void>;
  /** Called as soon as a batch commits, with its oldest touched started_at */
  onCommit?: (oldest: Date | null) => void;
}): Promise<BackfillWalkResult> {
  const {
    batchSize,
    getCompressedRanges,
    runBatch = backfillSessionIdentityBatch,
    onBatch,
    onCommit,
  } = deps;
  let total = 0;
  let earliest: Date | null = null;

  // Totals accumulate here rather than from each drain's result: a failed
  // sweep rejects its drain, and the batches it committed first must still count.
  const stamp = async (window?: BackfillWindow) => {
    const batch = await runBatch(batchSize, window);
    total += batch.updated;
    if (batch.oldest && (!earliest || batch.oldest < earliest)) earliest = batch.oldest;
    onCommit?.(batch.oldest);
    return { count: batch.updated, oldest: batch.oldest };
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
  await drainWindowsWithBisection(
    null,
    () => stamp(horizon ? { start: horizon } : undefined),
    opts
  );

  const { failedRanges } = await drainWindowsWithBisection(
    compressed,
    (window) => stamp(window ?? undefined),
    opts
  );

  if (compressed.length > 0 && failedRanges.length === 0) {
    try {
      await drainWindowsWithBisection(null, () => stamp(), opts);
    } catch (err) {
      if (!(err instanceof BackfillRangeError)) throw err;
      // A chunk can be compressed mid-walk (a compression job already running
      // survives remove_compression_policy), so the sweep can trip the same cap.
      // Record it instead of discarding the totals the walk already committed.
      failedRanges.push('unwindowed sweep');
      console.error('[SessionIdentityBackfill] Range unwindowed sweep failed:', err.cause);
    }
  }

  return { total, earliest, failedRanges };
}
