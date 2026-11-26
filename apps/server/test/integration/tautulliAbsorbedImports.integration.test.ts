/**
 * Removing imported plays Tautulli has since merged into another play, over a compressed chunk:
 * the cleanup decompresses only the batches of the rows it deletes or detaches.
 *
 * Run with: pnpm --filter @tracearr/server test:integration tautulliAbsorbedImports
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db, recreatePool } from '../../src/db/client.js';
import { MAX_POINT_UPDATES_PER_PASS } from '../../src/jobs/sessionIdentityBackfill.js';
import { TautulliService } from '../../src/services/tautulli.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const FILLER_SESSIONS = 40;

/** Uncompressed heap rows across the compressed-age sessions chunks, and whether each is compressed */
async function oldChunkHeaps() {
  const { rows } = await db.execute(sql`
    SELECT format('%I.%I', chunk_schema, chunk_name) AS name, is_compressed
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'sessions' AND range_end <= now() - interval '30 days'
  `);
  const chunks = rows as Array<{ name: string; is_compressed: boolean }>;
  let heap = 0;
  for (const chunk of chunks) {
    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM ONLY ${sql.raw(chunk.name)}`
    );
    heap += (result.rows[0] as { n: number }).n;
  }
  return { chunks: chunks.length, compressed: chunks.every((c) => c.is_compressed), heap };
}

/**
 * FILLER_SESSIONS Tautulli imports of one account, one a minute, and between them `groups` stored
 * plays each with one later import Tautulli has merged into it: each group in its own account's
 * batch when `lone`, otherwise all in one. The first group's root points at its absorbed play.
 * The database's decompression cap is 10 while it runs, so a write that kept the cap fails.
 */
async function removeThroughCompressedChunk(
  groups: number,
  opts: { lone: boolean; match: boolean }
) {
  const server = await createTestServer({ type: 'plex' });
  const newAccount = async () =>
    createTestServerUser({ serverId: server.id, userId: (await createTestUser()).id });
  const base = new Date(Math.floor((Date.now() - 60 * DAY_MS) / DAY_MS) * DAY_MS + DAY_MS / 4);
  const tautulliImport = (serverUserId: string, ref: string, startedAt: Date) =>
    createTestSession({
      serverId: server.id,
      serverUserId,
      state: 'stopped',
      sessionKey: `tautulli-${ref}`,
      externalSessionId: ref,
      startedAt,
      durationMs: 10_000,
    });
  const filler = await newAccount();
  for (let i = 0; i < FILLER_SESSIONS; i++) {
    await tautulliImport(filler.id, `filler-${i}`, new Date(base.getTime() + i * MIN_MS));
  }
  const shared = await newAccount();
  const absorbing = [];
  for (let i = 0; i < groups; i++) {
    const account = opts.lone ? await newAccount() : shared;
    const started = new Date(
      base.getTime() + MIN_MS / 2 + Math.floor((i * (FILLER_SESSIONS - 1)) / groups) * MIN_MS + i
    );
    const root = await tautulliImport(account.id, `root-${i}`, started);
    const absorbed = await tautulliImport(
      account.id,
      `absorbed-${i}`,
      new Date(started.getTime() + 20_000)
    );
    if (i === 0) {
      await db.execute(
        sql`UPDATE sessions SET reference_id = ${absorbed.id}::uuid WHERE id = ${root.id}::uuid`
      );
    }
    absorbing.push({
      rootExternalId: `root-${i}`,
      serverUserId: account.id,
      started,
      stopped: new Date(started.getTime() + 25_000),
      absorbedIds: [opts.match ? `absorbed-${i}` : `elsewhere-${i}`],
    });
  }
  expect((await compressSessionChunks(30)).length).toBeGreaterThanOrEqual(1);
  expect(await oldChunkHeaps()).toMatchObject({ compressed: true, heap: 0 });

  const dbName = (
    (await db.execute(sql`SELECT current_database() AS db`)).rows[0] as { db: string }
  ).db;
  await db.execute(
    sql.raw(
      `ALTER DATABASE "${dbName}" SET timescaledb.max_tuples_decompressed_per_dml_transaction = 10`
    )
  );
  await recreatePool();
  try {
    const deleted = await TautulliService['deleteAbsorbedImports'](server.id, absorbing);
    const left = await db.execute(sql`
      SELECT count(*) FILTER (WHERE external_session_id LIKE 'absorbed-%')::int AS absorbed,
        count(*) FILTER (WHERE external_session_id LIKE 'root-%')::int AS roots,
        count(reference_id)::int AS references
      FROM sessions WHERE server_id = ${server.id}::uuid
    `);
    return {
      deleted: deleted.length,
      left: left.rows[0] as { absorbed: number; roots: number; references: number },
      after: await oldChunkHeaps(),
    };
  } finally {
    await db.execute(
      sql.raw(
        `ALTER DATABASE "${dbName}" RESET timescaledb.max_tuples_decompressed_per_dml_transaction`
      )
    );
    await recreatePool();
  }
}

describe('removing plays Tautulli merged into another play', { timeout: 120_000 }, () => {
  it('leaves a compressed chunk compressed and untouched when no import matches', async () => {
    const { deleted, left, after } = await removeThroughCompressedChunk(3, {
      lone: true,
      match: false,
    });
    expect(deleted).toBe(0);
    expect(left).toEqual({ absorbed: 3, roots: 3, references: 1 });
    expect(after).toMatchObject({ compressed: true, heap: 0 });
  });

  it('decompresses only the batches of the rows it deletes and detaches', async () => {
    const { deleted, left, after } = await removeThroughCompressedChunk(3, {
      lone: true,
      match: true,
    });
    expect(deleted).toBe(3);
    expect(left).toEqual({ absorbed: 0, roots: 3, references: 0 });
    expect(after.heap).toBe(3);
  });

  it('deletes up to the point-write limit by point writes, decompressing only their batch', async () => {
    // Below the crossover measured on TimescaleDB 2.28 and 2.31; re-measure before moving it.
    expect(MAX_POINT_UPDATES_PER_PASS).toBe(50);
    const { deleted, left, after } = await removeThroughCompressedChunk(
      MAX_POINT_UPDATES_PER_PASS,
      {
        lone: false,
        match: true,
      }
    );
    expect(deleted).toBe(MAX_POINT_UPDATES_PER_PASS);
    expect(left).toEqual({ absorbed: 0, roots: MAX_POINT_UPDATES_PER_PASS, references: 0 });
    expect(after.heap).toBe(MAX_POINT_UPDATES_PER_PASS);
  });

  it('deletes more rows than the point-write limit with one statement, decompressing from the oldest group on', async () => {
    const groups = MAX_POINT_UPDATES_PER_PASS + 1;
    const { deleted, left, after } = await removeThroughCompressedChunk(groups, {
      lone: false,
      match: true,
    });
    expect(deleted).toBe(groups);
    expect(left).toEqual({ absorbed: 0, roots: groups, references: 0 });
    expect(after.heap).toBe(groups + FILLER_SESSIONS);
  });
});
