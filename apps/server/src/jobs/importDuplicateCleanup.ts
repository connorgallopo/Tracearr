import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { getSessionChunkRanges, uncapDecompressionForTx } from '../db/timescale.js';
import { getServerTrackingStart } from '../services/import/trackingCutoff.js';
import {
  byInstant,
  drainWindowsWithBisection,
  sessionWalkWindows,
  ts,
  type BackfillWindow,
} from './sessionWalk.js';

interface DuplicateCleanupServer {
  id: string;
  type: 'plex' | 'jellyfin' | 'emby';
  /** servers.created_at: nothing before it was tracked */
  cutoff: Date;
}

type Window = Required<BackfillWindow> | null;

const NEIGHBOUR_SLACK_MS = 240_000;
const ROOT_SLACK_MS = 120_000;
const BATCH_SIZE = 1000;

const uuids = (ids: string[]) => sql`${sql.param(ids)}::uuid[]`;

function importForm(alias: string, type: DuplicateCleanupServer['type']): SQL {
  const a = sql.raw(alias);
  return type === 'plex'
    ? sql`(${a}.session_key = 'tautulli-' || ${a}.external_session_id)`
    : sql`(${a}.external_session_id IS NOT NULL AND ${a}.session_key = ${a}.external_session_id)`;
}

function near(from: string, to: string): SQL {
  return sql.raw(
    `${to}.server_user_id = ${from}.server_user_id AND ${to}.rating_key = ${from}.rating_key` +
      ` AND (${from}.device_id IS NULL OR ${to}.device_id IS NULL OR ${from}.device_id = ${to}.device_id)` +
      ` AND abs(extract(epoch FROM ${to}.started_at - ${from}.started_at)) <= 120`
  );
}

/** Candidate imports: tracked since the cutoff and inside the window */
function candidateBounds(alias: string, server: DuplicateCleanupServer, window: Window): SQL {
  const a = sql.raw(alias);
  const base = sql`${a}.server_id = ${server.id}::uuid AND ${a}.started_at >= ${ts(server.cutoff)}`;
  if (!window) return base;
  return sql`${base} AND ${a}.started_at >= ${ts(window.start)} AND ${a}.started_at < ${ts(window.end)}`;
}

/** Rows that can sit near a candidate, never before the cutoff */
function neighbourBounds(alias: string, server: DuplicateCleanupServer, window: Window): SQL {
  const a = sql.raw(alias);
  if (!window) {
    return sql`${a}.server_id = ${server.id}::uuid AND ${a}.started_at >= ${ts(server.cutoff)}`;
  }
  const lower = new Date(
    Math.max(server.cutoff.getTime(), window.start.getTime() - NEIGHBOUR_SLACK_MS)
  );
  const upper = new Date(window.end.getTime() + NEIGHBOUR_SLACK_MS);
  return sql`${a}.server_id = ${server.id}::uuid AND ${a}.started_at >= ${ts(lower)} AND ${a}.started_at < ${ts(upper)}`;
}

function exclusivePair(server: DuplicateCleanupServer, window: Window): SQL {
  // No cutoff clamp on the import count: an import that began just before the
  // server was added still makes the tracked row ambiguous.
  const importBounds = window
    ? sql`i2.server_id = ${server.id}::uuid AND i2.started_at >= ${ts(new Date(window.start.getTime() - NEIGHBOUR_SLACK_MS))} AND i2.started_at < ${ts(new Date(window.end.getTime() + NEIGHBOUR_SLACK_MS))}`
    : sql`i2.server_id = ${server.id}::uuid`;
  // IS NOT TRUE, not NOT: on Plex the import predicate is NULL for a tracked row,
  // and stamped tracked rows and Tautulli-keyed rows must count as competitors.
  return sql`(SELECT count(*) FROM sessions x
      WHERE ${neighbourBounds('x', server, window)}
        AND ${importForm('x', server.type)} IS NOT TRUE
        AND ${near('i', 'x')}) = 1
    AND (SELECT count(*) FROM sessions i2
      WHERE ${importBounds}
        AND i2.external_session_id IS NOT NULL
        AND ${near('l', 'i2')}) = 1`;
}

/**
 * Delete imported sessions that duplicate a tracked play, in one bounded batch.
 *
 * A pair is an import and the only non-import row near it, which must be tracked
 * and have no other import near it; deleting such an import can never make
 * another pair exclusive, so reruns find nothing new. The import is deleted
 * only when the tracked chain keeps its watched state, counted play and watch
 * time; the rest are added to `kept` so later batches skip them. Nothing is
 * copied between rows.
 *
 * `count` is the number of pairs selected, so the drain loop's short-batch
 * stop still holds when every pair is kept.
 */
export async function removeImportDuplicatesBatch(
  server: DuplicateCleanupServer,
  limit: number,
  window: Window,
  kept: Set<string>
): Promise<{ count: number; deleted: number; oldest: Date | null }> {
  const { count, keptIds, deletedStarts } = await db.transaction(async (tx) => {
    await uncapDecompressionForTx(tx);

    const selected = await tx.execute(sql`
      SELECT i.id, i.started_at, i.server_user_id, COALESCE(l.reference_id, l.id) AS root_id
      FROM sessions i
      JOIN sessions l
        ON ${neighbourBounds('l', server, window)}
        AND l.external_session_id IS NULL
        AND ${near('i', 'l')}
      WHERE ${candidateBounds('i', server, window)}
        AND ${importForm('i', server.type)}
        AND i.rating_key IS NOT NULL
        AND i.id <> ALL(${uuids([...kept])})
        AND ${exclusivePair(server, window)}
      ORDER BY i.started_at DESC
      LIMIT ${limit}
    `);
    const pairs = selected.rows as Array<{
      id: string;
      started_at: string;
      server_user_id: string;
      root_id: string;
    }>;
    if (pairs.length === 0) return { count: 0, keptIds: [], deletedStarts: [] };

    const pairIds = pairs.map((p) => p.id);
    // An import with a tracked child is kept: repointing that child onto r would
    // add its watch time to r's chain, where a second import could spend it.
    const minPairStarted = pairs.map((p) => p.started_at).sort(byInstant)[0];
    const rootIds = pairs.map((p) => p.root_id);
    const users = [...new Set(pairs.map((p) => p.server_user_id))];
    const rootUpper = window
      ? sql` AND r.started_at < ${ts(new Date(window.end.getTime() + ROOT_SLACK_MS))}`
      : sql``;

    const verdicts = await tx.execute(sql`
      WITH root AS (
        SELECT r.id, r.external_session_id, r.media_id, r.reference_id, r.duration_ms, r.watched, r.started_at
        FROM sessions r
        WHERE r.id = ANY(${uuids(rootIds)}) AND r.server_id = ${server.id}::uuid AND r.server_user_id = ANY(${uuids(users)}) AND r.started_at >= ${ts(server.cutoff)}${rootUpper}
      ),
      chain AS (
        SELECT root.id AS root_id, root.media_id, root.duration_ms, root.watched, root.started_at FROM root
        UNION ALL
        SELECT root.id, c.media_id, c.duration_ms, c.watched, c.started_at
        FROM root
        JOIN sessions c ON c.reference_id = root.id
        WHERE c.reference_id = ANY(${uuids(rootIds)}) AND c.external_session_id IS NULL
          AND c.server_id = ${server.id}::uuid AND c.server_user_id = ANY(${uuids(users)})
          AND c.started_at >= ${ts(server.cutoff)}
      ),
      chain_totals AS (
        SELECT root_id, media_id,
          bool_or(watched) AS any_watched,
          SUM(COALESCE(duration_ms, 0)) AS total_ms,
          SUM(duration_ms) FILTER (WHERE duration_ms >= 120000) AS counted_ms
        FROM chain
        GROUP BY root_id, media_id
      ),
      chain_span AS (
        SELECT root_id, min(started_at) AS chain_start, max(started_at) AS chain_end
        FROM chain
        GROUP BY root_id
      )
      SELECT i.id AS i_id, cs.chain_start, cs.chain_end, (
        r.id IS NOT NULL AND r.external_session_id IS NULL
        AND r.reference_id IS DISTINCT FROM i.id
        AND r.media_id IS NOT DISTINCT FROM i.media_id
        AND (NOT i.watched OR t.any_watched)
        AND (NOT (i.reference_id IS NULL AND COALESCE(i.duration_ms, 0) >= 120000) OR (r.reference_id IS NULL AND r.duration_ms >= 120000 AND (r.started_at AT TIME ZONE 'UTC')::date = (i.started_at AT TIME ZONE 'UTC')::date))
        AND COALESCE(i.duration_ms, 0) <= COALESCE(t.total_ms, 0) + 15000
        AND (COALESCE(i.duration_ms, 0) < 120000 OR i.duration_ms <= COALESCE(t.counted_ms, 0) + 15000)
        AND NOT EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.session_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM termination_logs tl WHERE tl.session_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM sessions lc WHERE lc.server_id = ${server.id}::uuid AND lc.server_user_id = ANY(${uuids(users)}) AND lc.started_at >= ${minPairStarted}::timestamptz AND lc.reference_id = ANY(${uuids(pairIds)}) AND lc.reference_id = i.id AND lc.external_session_id IS NULL)
      ) IS TRUE AS passes
      FROM unnest(${uuids(pairIds)}, ${uuids(rootIds)}) AS p(i_id, root_id)
      JOIN sessions i ON i.id = p.i_id
      LEFT JOIN root r ON r.id = p.root_id
      LEFT JOIN chain_totals t ON t.root_id = r.id AND t.media_id IS NOT DISTINCT FROM i.media_id
      LEFT JOIN chain_span cs ON cs.root_id = r.id
      WHERE ${candidateBounds('i', server, window)}
    `);
    const passed = (
      verdicts.rows as Array<{
        i_id: string;
        passes: boolean;
        chain_start: string | null;
        chain_end: string | null;
      }>
    ).filter((v) => v.passes);
    const shared =
      passed.length > 0 ? await importsSharingChain(tx, server, pairs, passed) : new Set<string>();
    const passing = new Set(passed.map((v) => v.i_id).filter((id) => !shared.has(id)));
    const doomed = pairs.filter((p) => passing.has(p.id));
    const keptIds = pairs.filter((p) => !passing.has(p.id)).map((p) => p.id);
    if (doomed.length === 0) return { count: pairs.length, keptIds, deletedStarts: [] };

    // A root whose reference_id is the import itself is kept by the verdict,
    // so no child below is ever repointed onto its own id.
    const doomedIds = doomed.map((p) => p.id);
    const minStarted = doomed.map((p) => p.started_at).sort(byInstant)[0];

    // No upper bound: a resume child can sit in a later chunk than its root.
    const children = await tx.execute(sql`
      SELECT id, started_at, reference_id FROM sessions
      WHERE server_id = ${server.id}::uuid AND server_user_id = ANY(${uuids([...new Set(doomed.map((p) => p.server_user_id))])})
        AND started_at >= ${minStarted}::timestamptz AND reference_id = ANY(${uuids(doomedIds)})
    `);
    const childRows = children.rows as Array<{
      id: string;
      started_at: string;
      reference_id: string;
    }>;
    if (childRows.length > 0) {
      await repointChildren(tx, server, childRows, doomed);
    }

    const removed = await tx.execute(sql`
      DELETE FROM sessions s
      USING unnest(${uuids(doomedIds)}, ${sql.param(doomed.map((p) => p.started_at))}::timestamptz[]) AS d(id, started_at)
      WHERE s.id = d.id AND s.started_at = d.started_at
        AND ${candidateBounds('s', server, window)}
      RETURNING s.started_at
    `);
    return {
      count: pairs.length,
      keptIds,
      deletedStarts: (removed.rows as Array<{ started_at: string }>).map((r) => r.started_at),
    };
  });

  for (const id of keptIds) kept.add(id);
  const oldest = deletedStarts.sort(byInstant)[0];
  return { count, deleted: deletedStarts.length, oldest: oldest ? new Date(oldest) : null };
}

/**
 * Imports whose tracked chain has another import near any of its rows. Each pair
 * is checked against its whole chain, so two imports near different rows of
 * one chain could otherwise both be deleted on the strength of the same tracked
 * watch time. Chain rows can sit in later chunks than the window, so the
 * bounds come from the chain itself; like the exclusivity count, no cutoff
 * clamp applies to the other import.
 */
async function importsSharingChain(
  tx: { execute: (query: SQL) => Promise<{ rows: unknown[] }> },
  server: DuplicateCleanupServer,
  pairs: Array<{ id: string; server_user_id: string; root_id: string }>,
  passed: Array<{ i_id: string; chain_start: string | null; chain_end: string | null }>
): Promise<Set<string>> {
  const passedIds = new Set(passed.map((v) => v.i_id));
  const checked = pairs.filter((p) => passedIds.has(p.id));
  const starts = passed.flatMap((v) => (v.chain_start ? [v.chain_start] : [])).sort(byInstant);
  const ends = passed.flatMap((v) => (v.chain_end ? [v.chain_end] : [])).sort(byInstant);
  const chainStart = starts[0];
  const chainEnd = ends[ends.length - 1];
  if (!chainStart || !chainEnd) return new Set(passedIds);

  const rootIds = checked.map((p) => p.root_id);
  const users = [...new Set(checked.map((p) => p.server_user_id))];
  const result = await tx.execute(sql`
    SELECT DISTINCT p.i_id
    FROM unnest(${uuids(checked.map((p) => p.id))}, ${uuids(rootIds)}) AS p(i_id, root_id)
    JOIN sessions ch
      ON (ch.id = p.root_id OR (ch.reference_id = p.root_id AND ch.external_session_id IS NULL))
    JOIN sessions y
      ON y.external_session_id IS NOT NULL AND y.id <> p.i_id AND ${near('ch', 'y')}
    WHERE ch.server_id = ${server.id}::uuid AND ch.server_user_id = ANY(${uuids(users)}) AND ch.started_at >= ${chainStart}::timestamptz AND ch.started_at <= ${chainEnd}::timestamptz
      AND (ch.id = ANY(${uuids(rootIds)}) OR ch.reference_id = ANY(${uuids(rootIds)}))
      AND y.server_id = ${server.id}::uuid AND y.server_user_id = ANY(${uuids(users)}) AND y.started_at >= ${ts(new Date(new Date(chainStart).getTime() - NEIGHBOUR_SLACK_MS))} AND y.started_at <= ${ts(new Date(new Date(chainEnd).getTime() + NEIGHBOUR_SLACK_MS))}
  `);
  return new Set((result.rows as Array<{ i_id: string }>).map((r) => r.i_id));
}

/**
 * One UPDATE per sessions chunk, with that chunk's bounds on the target, so
 * repointing never decompresses more than one chunk at a time.
 */
async function repointChildren(
  tx: { execute: (query: SQL) => Promise<{ rows: unknown[] }> },
  server: DuplicateCleanupServer,
  children: Array<{ id: string; started_at: string; reference_id: string }>,
  doomed: Array<{ id: string; server_user_id: string; root_id: string }>
): Promise<void> {
  const pairById = new Map(doomed.map((p) => [p.id, p]));
  const chunks = await getSessionChunkRanges();
  const groups = new Map<
    number,
    Array<{ id: string; started_at: string; root_id: string; server_user_id: string }>
  >();
  for (const child of children) {
    const pair = pairById.get(child.reference_id);
    if (!pair) continue;
    const at = new Date(child.started_at);
    const key = chunks.findIndex((c) => at >= c.start && at < c.end);
    groups.set(key, [
      ...(groups.get(key) ?? []),
      { ...child, root_id: pair.root_id, server_user_id: pair.server_user_id },
    ]);
  }

  for (const group of groups.values()) {
    const sorted = group.map((c) => c.started_at).sort(byInstant);
    const users = [...new Set(group.map((c) => c.server_user_id))];
    await tx.execute(sql`
      UPDATE sessions s
      SET reference_id = m.root_id
      FROM unnest(${uuids(group.map((c) => c.id))}, ${sql.param(group.map((c) => c.started_at))}::timestamptz[], ${uuids(group.map((c) => c.root_id))}) AS m(id, started_at, root_id)
      WHERE s.id = m.id AND s.started_at = m.started_at
        AND s.server_id = ${server.id}::uuid AND s.server_user_id = ANY(${uuids(users)})
        AND s.started_at >= ${sorted[0]}::timestamptz AND s.started_at <= ${sorted[sorted.length - 1]}::timestamptz
    `);
  }
}

/**
 * Candidate imports with a near non-import row that are still not an exclusive
 * pair. Run once a window has drained, when every exclusive pair left is kept.
 */
export async function countAmbiguousImports(
  server: DuplicateCleanupServer,
  window: Window
): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS skipped
    FROM sessions i
    WHERE ${candidateBounds('i', server, window)}
      AND ${importForm('i', server.type)}
      AND i.rating_key IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM sessions x
        WHERE ${neighbourBounds('x', server, window)}
          AND ${importForm('x', server.type)} IS NOT TRUE
          AND ${near('i', 'x')}
      )
      AND NOT EXISTS (
        SELECT 1 FROM sessions l
        WHERE ${neighbourBounds('l', server, window)}
          AND l.external_session_id IS NULL
          AND ${near('i', 'l')}
          AND ${exclusivePair(server, window)}
      )
  `);
  return (result.rows[0] as { skipped?: number } | undefined)?.skipped ?? 0;
}

/**
 * Walk every server's sessions from its cutoff, one chunk window at a time.
 * Totals accumulate per batch rather than from each drain's result, so a
 * window that commits batches and then fails still counts them and still
 * widens the aggregate refresh.
 */
export async function runImportDuplicateCleanupWalk(deps: {
  onBatch: (total: number) => Promise<void>;
  onCommit: (oldest: Date | null) => void;
  batchSize?: number;
  runBatch?: typeof removeImportDuplicatesBatch;
  countSkipped?: typeof countAmbiguousImports;
}): Promise<{ total: number; earliest: Date | null; failedRanges: string[]; details: string }> {
  const {
    onBatch,
    onCommit,
    batchSize = BATCH_SIZE,
    runBatch = removeImportDuplicatesBatch,
    countSkipped = countAmbiguousImports,
  } = deps;
  let total = 0;
  let deleted = 0;
  let keptTotal = 0;
  let skipped = 0;
  let earliest: Date | null = null;
  const failedRanges: string[] = [];

  const rows = await db.select({ id: servers.id, type: servers.type }).from(servers);
  for (const row of rows) {
    // Dispatcharr has no supported history importer or matching import-key format.
    if (row.type === 'dispatcharr') continue;
    const cutoff = await getServerTrackingStart(row.id);
    if (!cutoff) continue;
    const server: DuplicateCleanupServer = { id: row.id, type: row.type, cutoff };
    const kept = new Set<string>();

    const result = await drainWindowsWithBisection(
      await sessionWalkWindows(cutoff),
      async (window) => {
        const batch = await runBatch(server, batchSize, window, kept);
        total += batch.count;
        deleted += batch.deleted;
        if (batch.oldest && (!earliest || batch.oldest < earliest)) earliest = batch.oldest;
        onCommit(batch.oldest);
        if (batch.count < batchSize) skipped += await countSkipped(server, window);
        return { count: batch.count, oldest: batch.oldest };
      },
      {
        batchSize,
        label: 'ImportDuplicateCleanup',
        onBatch: async () => {
          await onBatch(total);
        },
      }
    );
    failedRanges.push(...result.failedRanges);
    keptTotal += kept.size;
  }

  return {
    total,
    earliest,
    failedRanges,
    details: `Removed ${deleted} duplicate imported sessions; kept ${keptTotal} that could not be proven to add nothing; skipped ${skipped} with more than one possible match`,
  };
}
