/**
 * Unlinks imported plays whose current link provably disagrees with the play's own recorded
 * fields, on servers whose item keys can name a different item later. Every cleared value is
 * logged in session_link_repairs in the same transaction, so each unlink can be put back.
 *
 * Candidates are selected read-only. Only a batch with candidates opens a write transaction, and
 * every write to sessions is a point update on constant (id, started_at): a join-driven or
 * array-matched UPDATE decompresses whole compressed windows, a point update one batch per row.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessionLinkRepairs } from '../db/schema.js';
import { uncapDecompressionForTx } from '../db/timescale.js';
import {
  keyReusingServerTypesSql,
  normalizedShowTitleSql,
  repairClauseSql,
} from '../services/import/keyRuleSql.js';
import { byInstant, ts, type BackfillWindow } from './sessionWalk.js';

export const IMPORTED_LINK_REPAIR_VERSION = 1;
export const REPAIR_BREAKER_SHARE = 0.5;
export const REPAIR_BREAKER_FLOOR = 500;

/** Rows unlinked by one batch; `cursor` bounds the next batch of the same window from above. */
export interface UnlinkBatch {
  count: number;
  oldest: Date | null;
  cursor?: string;
}

export interface RepairCount {
  serverId: string;
  candidates: number;
  linked: number;
}

type Clause = 'numbers' | 'titles' | 'movie' | 'fold';

interface Candidate {
  id: string;
  started_at: string;
  server_id: string;
  clause: Clause;
  grandparent_title: string | null;
  media_id: string;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
}

/** Imported rows with a link, on servers whose item keys can be reused. */
const IMPORTED_LINKED_IN_SCOPE = sql`
  JOIN servers sv ON sv.id = s.server_id AND sv.type = ANY(${keyReusingServerTypesSql()})
  WHERE s.external_session_id IS NOT NULL AND s.media_id IS NOT NULL`;

/** The linked media (`em`) and its show (`sh`), both through a merge to the surviving row. */
const CANONICAL_LINK = sql`
  LEFT JOIN media lm ON lm.id = s.media_id
  LEFT JOIN media em ON em.id = COALESCE(lm.merged_into_id, lm.id)
  LEFT JOIN media lsh ON lsh.id = em.show_media_id
  LEFT JOIN media sh ON sh.id = COALESCE(lsh.merged_into_id, lsh.id)`;

const CANDIDATE_COLUMNS = sql`s.id, s.started_at, s.server_id, s.grandparent_title, s.media_id,
  s.show_media_id, s.imdb_id, s.tmdb_id, s.tvdb_id, s.parent_rating_key, s.grandparent_rating_key`;

function inWindow(window: BackfillWindow | null, cursor?: string): SQL {
  return sql`${window?.start ? sql`AND s.started_at >= ${ts(window.start)}` : sql``}
    ${window?.end ? sql`AND s.started_at < ${ts(window.end)}` : sql``}
    ${cursor ? sql`AND s.started_at <= ${cursor}::timestamptz` : sql``}`;
}

const onServers = (serverIds: string[]) =>
  sql`AND s.server_id = ANY(${sql.param(serverIds)}::uuid[])`;

/** Whether any server in scope has an imported row with a link; nothing to repair otherwise. */
export async function hasRepairableRows(): Promise<boolean> {
  const { rows } = await db.execute(
    sql`SELECT 1 FROM sessions s ${IMPORTED_LINKED_IN_SCOPE} LIMIT 1`
  );
  return rows.length > 0;
}

/** Per server in scope: its imported linked rows, and how many of them the rule would unlink. */
export async function countRepairCandidates(
  windows: Required<BackfillWindow>[] | null
): Promise<RepairCount[]> {
  const totals = new Map<string, RepairCount>();
  for (const window of windows ?? [null]) {
    const { rows } = await db.execute(sql`
      SELECT s.server_id::text AS server_id,
        count(*) FILTER (WHERE ${repairClauseSql()} IS NOT NULL)::int AS candidates,
        count(*)::int AS linked
      FROM sessions s ${CANONICAL_LINK}
      ${IMPORTED_LINKED_IN_SCOPE} ${inWindow(window)}
      GROUP BY s.server_id
    `);
    for (const row of rows as Array<{ server_id: string; candidates: number; linked: number }>) {
      const total = totals.get(row.server_id) ?? {
        serverId: row.server_id,
        candidates: 0,
        linked: 0,
      };
      total.candidates += row.candidates;
      total.linked += row.linked;
      totals.set(row.server_id, total);
    }
  }
  return [...totals.values()];
}

/** A server whose count looks like more than a rebuild's worth of bad links is held. */
export function breakerTrips(count: RepairCount): boolean {
  return count.candidates > Math.max(REPAIR_BREAKER_FLOOR, REPAIR_BREAKER_SHARE * count.linked);
}

/**
 * Clears the seven linked columns of each candidate and logs the values it cleared, in one
 * transaction. A row whose cleared columns changed since it was read is left alone, so the log
 * holds exactly what was cleared. Rows already unlinked no longer match a select, so the next
 * batch may start at the oldest row read, ties included.
 */
async function unlink(candidates: Candidate[]): Promise<UnlinkBatch> {
  if (candidates.length === 0) return { count: 0, oldest: null };
  const cursor = candidates.reduce((min, row) =>
    byInstant(row.started_at, min.started_at) < 0 ? row : min
  ).started_at;
  const done = await db.transaction(async (tx) => {
    await uncapDecompressionForTx(tx);
    const unlinked: Candidate[] = [];
    for (const row of candidates) {
      const { rows } = await tx.execute(sql`
        UPDATE sessions s
        SET media_id = NULL, show_media_id = NULL, imdb_id = NULL, tmdb_id = NULL, tvdb_id = NULL,
          parent_rating_key = NULL, grandparent_rating_key = NULL
        WHERE s.id = ${row.id}::uuid AND s.started_at = ${row.started_at}::timestamptz
          AND s.media_id = ${row.media_id}::uuid
          AND s.show_media_id IS NOT DISTINCT FROM ${row.show_media_id}::uuid
          AND s.imdb_id IS NOT DISTINCT FROM ${row.imdb_id}::text
          AND s.tmdb_id IS NOT DISTINCT FROM ${row.tmdb_id}::int
          AND s.tvdb_id IS NOT DISTINCT FROM ${row.tvdb_id}::int
          AND s.parent_rating_key IS NOT DISTINCT FROM ${row.parent_rating_key}::text
          AND s.grandparent_rating_key IS NOT DISTINCT FROM ${row.grandparent_rating_key}::text
        RETURNING s.id
      `);
      if (rows.length > 0) unlinked.push(row);
    }
    if (unlinked.length > 0) {
      await tx
        .insert(sessionLinkRepairs)
        .values(
          unlinked.map((row) => ({
            sessionId: row.id,
            startedAt: sql`${row.started_at}::timestamptz`,
            repairVersion: IMPORTED_LINK_REPAIR_VERSION,
            serverId: row.server_id,
            clause: row.clause,
            grandparentTitle: row.grandparent_title,
            mediaId: row.media_id,
            showMediaId: row.show_media_id,
            imdbId: row.imdb_id,
            tmdbId: row.tmdb_id,
            tvdbId: row.tvdb_id,
            parentRatingKey: row.parent_rating_key,
            grandparentRatingKey: row.grandparent_rating_key,
          }))
        )
        .onConflictDoNothing();
    }
    return unlinked;
  });
  const oldest = done.reduce<Date | null>((min, row) => {
    const at = new Date(row.started_at);
    return min === null || at < min ? at : min;
  }, null);
  return { count: done.length, oldest, cursor };
}

/** One batch of the newest rows in the window whose link the disagreement rule refuses. */
export async function unlinkByRule(
  serverIds: string[],
  window: BackfillWindow | null,
  limit: number,
  cursor?: string
): Promise<UnlinkBatch> {
  if (serverIds.length === 0) return { count: 0, oldest: null };
  const { rows } = await db.execute(sql`
    SELECT * FROM (
      SELECT ${CANDIDATE_COLUMNS}, ${repairClauseSql()} AS clause
      FROM sessions s ${CANONICAL_LINK}
      ${IMPORTED_LINKED_IN_SCOPE} ${onServers(serverIds)} ${inWindow(window, cursor)}
    ) c
    WHERE c.clause IS NOT NULL
    ORDER BY c.started_at DESC
    LIMIT ${limit}
  `);
  return unlink(rows as unknown as Candidate[]);
}

/**
 * One batch of the newest imported episodes in the window filed under a show that a row the rule
 * unlinked, with the same show title, was filed under: the show-title fold files later plays of
 * that title under the show the wrong link gave it, with their own numbers and titles, so the
 * rule keeps them. A row whose show title matches its show is never taken, whatever the log holds,
 * and neither is one whose own rating key names its linked media on its server: a renamed show's
 * plays linked by key stay, while the fold's landings, on a title-path episode or on a library
 * episode at the same numbers, are never backed by the play's key.
 */
export async function unlinkFoldPairs(
  serverIds: string[],
  window: BackfillWindow | null,
  limit: number,
  cursor?: string
): Promise<UnlinkBatch> {
  if (serverIds.length === 0) return { count: 0, oldest: null };
  const pairs = (
    await db.execute(sql`
      SELECT DISTINCT p.title, p.show_id FROM (
        SELECT ${sql.raw(normalizedShowTitleSql('r.grandparent_title'))} AS title,
          COALESCE(m.merged_into_id, m.id)::text AS show_id
        FROM session_link_repairs r
        JOIN media m ON m.id = r.show_media_id
        WHERE r.repair_version = ${IMPORTED_LINK_REPAIR_VERSION} AND r.clause <> 'fold'
      ) p
      WHERE p.title <> ''
    `)
  ).rows as Array<{ title: string; show_id: string }>;
  if (pairs.length === 0) return { count: 0, oldest: null };

  const playShow = sql.raw(normalizedShowTitleSql('s.grandparent_title'));
  const { rows } = await db.execute(sql`
    WITH pair (title, show_id) AS (
      SELECT * FROM unnest(${sql.param(pairs.map((p) => p.title))}::text[],
        ${sql.param(pairs.map((p) => p.show_id))}::uuid[])
    )
    SELECT ${CANDIDATE_COLUMNS}, 'fold' AS clause
    FROM sessions s
    JOIN media lm ON lm.id = s.media_id
    JOIN media lsh ON lsh.id = s.show_media_id
    JOIN media sh ON sh.id = COALESCE(lsh.merged_into_id, lsh.id)
    ${IMPORTED_LINKED_IN_SCOPE} ${onServers(serverIds)} ${inWindow(window, cursor)}
      AND s.media_type = 'episode'
      AND EXISTS (SELECT 1 FROM pair WHERE pair.show_id = sh.id AND pair.title = ${playShow})
      AND ${sql.raw(normalizedShowTitleSql('sh.title'))} NOT IN ('', ${playShow})
      AND NOT EXISTS (SELECT 1 FROM library_items li
        JOIN media km ON km.id = li.media_id
        WHERE li.server_id = s.server_id AND li.rating_key = s.rating_key
          AND COALESCE(km.merged_into_id, km.id) = COALESCE(lm.merged_into_id, lm.id))
    ORDER BY s.started_at DESC
    LIMIT ${limit}
  `);
  return unlink(rows as unknown as Candidate[]);
}
