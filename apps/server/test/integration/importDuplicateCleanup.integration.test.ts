/**
 * Every scenario compresses its chunk and lowers the decompression cap to 10
 * tuples, so a batch that deletes or repoints without lifting the cap fails.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- importDuplicateCleanup
 */

import { describe, it, expect } from 'vitest';
import type { Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db, recreatePool } from '../../src/db/client.js';
import { media } from '../../src/db/schema.js';
import {
  runImportDuplicateCleanup,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const HISTORY_AGE_DAYS = 20;
const FILLER_SESSIONS = 40;
// Midday UTC so no scenario straddles a UTC day boundary.
const BASE = new Date(
  Math.floor((Date.now() - HISTORY_AGE_DAYS * DAY_MS) / DAY_MS) * DAY_MS + DAY_MS / 2
);

const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs);

function fakeJob(): Job<MaintenanceJobData> {
  return {
    id: 'test-remove-import-duplicates',
    token: 'test-token',
    data: { type: 'remove_import_duplicates', userId: 'owner' },
    updateProgress: async () => undefined,
    extendLock: async () => undefined,
  } as unknown as Job<MaintenanceJobData>;
}

async function setup(type: 'plex' | 'jellyfin' = 'plex', createdAt = at(-60 * MIN_MS)) {
  const server = await createTestServer({ type });
  await db.execute(
    sql`UPDATE servers SET created_at = ${createdAt.toISOString()}::timestamptz WHERE id = ${server.id}::uuid`
  );
  const user = await createTestUser();
  const account = await createTestServerUser({ serverId: server.id, userId: user.id });
  const [row] = await db
    .insert(media)
    .values({
      mediaType: 'movie',
      matchKey: `movie:dedup:${server.id}`,
      title: 'Dedup Movie',
      normalizedTitle: 'dedup movie',
      year: 2020,
    })
    .returning({ id: media.id });
  // Unrelated plays in the same compressed segment, so deleting or repointing
  // one row decompresses more tuples than the lowered cap allows.
  for (let i = 0; i < FILLER_SESSIONS; i++) {
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      state: 'stopped',
      ratingKey: `rk-filler-${i}`,
      startedAt: at(4 * 60 * MIN_MS + i * 10 * MIN_MS),
      durationMs: 5 * MIN_MS,
    });
  }
  return { server, account, mediaId: row!.id };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

interface Row {
  startedAt: Date;
  durationMs: number;
  mediaId?: string | null;
  watched?: boolean;
  deviceId?: string;
  referenceId?: string | null;
  ratingKey?: string;
}

async function insertRow(
  ctx: Ctx,
  row: Row,
  keys: { sessionKey: string; externalSessionId: string | null }
) {
  const session = await createTestSession({
    serverId: ctx.server.id,
    serverUserId: ctx.account.id,
    state: 'stopped',
    sessionKey: keys.sessionKey,
    ratingKey: row.ratingKey ?? 'rk-dedup',
    startedAt: row.startedAt,
    stoppedAt: new Date(row.startedAt.getTime() + row.durationMs),
    durationMs: row.durationMs,
    watched: row.watched ?? false,
    deviceId: row.deviceId ?? 'device-a',
    referenceId: row.referenceId ?? null,
  });
  await db.execute(sql`
    UPDATE sessions
    SET external_session_id = ${keys.externalSessionId},
        media_id = ${row.mediaId === undefined ? ctx.mediaId : row.mediaId}::uuid
    WHERE id = ${session.id}::uuid
  `);
  return session.id;
}

let keySeq = 0;
const tracked = (ctx: Ctx, row: Row) =>
  insertRow(ctx, row, { sessionKey: `tracked-${++keySeq}`, externalSessionId: null });
const tautulliImport = (ctx: Ctx, row: Row) => {
  const ref = String(90_000 + ++keySeq);
  return insertRow(ctx, row, { sessionKey: `tautulli-${ref}`, externalSessionId: ref });
};

async function existing(ids: string[]): Promise<string[]> {
  const { rows } = await db.execute(
    sql`SELECT id FROM sessions WHERE id = ANY(${sql.param(ids)}::uuid[])`
  );
  return (rows as Array<{ id: string }>).map((r) => r.id).sort();
}

async function runCleanup() {
  await db.execute(sql`
    SELECT compress_chunk(c, true) FROM show_chunks('sessions') AS c
  `);
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
    return await runImportDuplicateCleanup(fakeJob());
  } finally {
    await db.execute(
      sql.raw(
        `ALTER DATABASE "${dbName}" RESET timescaledb.max_tuples_decompressed_per_dml_transaction`
      )
    );
    await recreatePool();
  }
}

const removed = (deleted: number, kept: number, skipped: number) =>
  `Removed ${deleted} duplicate imported sessions; kept ${kept} that could not be proven to add nothing; skipped ${skipped} with more than one possible match`;

describe('remove_import_duplicates on a compressed chunk', { timeout: 120_000 }, () => {
  it('deletes an import that duplicates a tracked play and drops its play from the aggregate', async () => {
    const ctx = await setup();
    const trackedId = await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const importId = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });
    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );
    const plays = async () =>
      (
        await db.execute(sql`
          SELECT COALESCE(SUM(plays), 0)::int AS plays FROM user_media_plays_daily
          WHERE server_id = ${ctx.server.id}::uuid AND media_id = ${ctx.mediaId}::uuid
        `)
      ).rows[0] as { plays: number };
    expect((await plays()).plays).toBe(2);

    const result = await runCleanup();

    expect(result.message).toBe(removed(1, 0, 0));
    expect(await existing([trackedId, importId])).toEqual([trackedId]);
    expect((await plays()).plays).toBe(1);
  });

  it('keeps a watched import when the tracked chain is unwatched', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const importId = await tautulliImport(ctx, {
      startedAt: at(3000),
      durationMs: 30 * MIN_MS,
      watched: true,
    });

    expect((await runCleanup()).message).toBe(removed(0, 1, 0));
    expect(await existing([importId])).toEqual([importId]);
  });

  it('keeps an import with a counted play when the tracked root runs 90 s', async () => {
    const ctx = await setup();
    const rootId = await tracked(ctx, { startedAt: at(0), durationMs: 90_000 });
    await tracked(ctx, { startedAt: at(10 * MIN_MS), durationMs: 3 * MIN_MS, referenceId: rootId });
    const importId = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 3 * MIN_MS });

    expect((await runCleanup()).message).toBe(removed(0, 1, 0));
    expect(await existing([importId])).toEqual([importId]);
  });

  it('keeps a 30 minute import when the tracked chain holds 25 minutes', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 25 * MIN_MS });
    const importId = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });

    expect((await runCleanup()).message).toBe(removed(0, 1, 0));
    expect(await existing([importId])).toEqual([importId]);
  });

  it('deletes an import 10 s longer than the tracked chain and keeps one 20 s longer', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 20 * MIN_MS, ratingKey: 'rk-a' });
    const within = await tautulliImport(ctx, {
      startedAt: at(3000),
      durationMs: 20 * MIN_MS + 10_000,
      ratingKey: 'rk-a',
    });
    await tracked(ctx, { startedAt: at(DAY_MS / 4), durationMs: 20 * MIN_MS, ratingKey: 'rk-b' });
    const beyond = await tautulliImport(ctx, {
      startedAt: at(DAY_MS / 4 + 3000),
      durationMs: 20 * MIN_MS + 20_000,
      ratingKey: 'rk-b',
    });

    expect((await runCleanup()).message).toBe(removed(1, 1, 0));
    expect(await existing([within, beyond])).toEqual([beyond]);
  });

  it('keeps a 10 minute import when the chain is a 90 s root plus a 9 minute child', async () => {
    const ctx = await setup();
    const importRoot = await tautulliImport(ctx, {
      startedAt: at(-3 * 60 * MIN_MS),
      durationMs: 5 * MIN_MS,
    });
    const rootId = await tracked(ctx, { startedAt: at(0), durationMs: 90_000 });
    await tracked(ctx, { startedAt: at(10 * MIN_MS), durationMs: 9 * MIN_MS, referenceId: rootId });
    // A child import, so only counted watch time (not the play rule) decides.
    const importId = await tautulliImport(ctx, {
      startedAt: at(3000),
      durationMs: 10 * MIN_MS,
      referenceId: importRoot,
    });

    expect((await runCleanup()).message).toBe(removed(0, 1, 0));
    expect(await existing([importId])).toEqual([importId]);
  });

  it('keeps an import with a media_id when the tracked root has none', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS, mediaId: null });
    const importId = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });

    expect((await runCleanup()).message).toBe(removed(0, 1, 0));
    expect(await existing([importId])).toEqual([importId]);
  });

  it('deletes neither of two imports 3 s and 10 s from one tracked row', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const first = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });
    const second = await tautulliImport(ctx, { startedAt: at(10_000), durationMs: 30 * MIN_MS });

    expect((await runCleanup()).message).toBe(removed(0, 0, 2));
    expect(await existing([first, second])).toEqual([first, second].sort());
  });

  it('keeps an import near two tracked rows', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    await tracked(ctx, { startedAt: at(60_000), durationMs: 30 * MIN_MS });
    const importId = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });

    expect((await runCleanup()).message).toBe(removed(0, 0, 1));
    expect(await existing([importId])).toEqual([importId]);
  });

  it('keeps an import on device A when the tracked row is on device B', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS, deviceId: 'device-b' });
    const importId = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });

    expect((await runCleanup()).message).toBe(removed(0, 0, 0));
    expect(await existing([importId])).toEqual([importId]);
  });

  it('keeps an import a termination log references', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const importId = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });
    await db.execute(sql`
      INSERT INTO termination_logs (session_id, server_id, server_user_id, trigger, success)
      VALUES (${importId}::uuid, ${ctx.server.id}::uuid, ${ctx.account.id}::uuid, 'manual', true)
    `);

    expect((await runCleanup()).message).toBe(removed(0, 1, 0));
    expect(await existing([importId])).toEqual([importId]);
  });

  it('repoints a resume child of a deleted import to the tracked root', async () => {
    const ctx = await setup();
    const trackedId = await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const importId = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });
    const childId = await tautulliImport(ctx, {
      startedAt: at(2 * 60 * MIN_MS),
      durationMs: 10 * MIN_MS,
      referenceId: importId,
    });

    expect((await runCleanup()).message).toBe(removed(1, 0, 0));
    expect(await existing([importId, childId])).toEqual([childId]);
    const { rows } = await db.execute(
      sql`SELECT reference_id FROM sessions WHERE id = ${childId}::uuid`
    );
    expect((rows[0] as { reference_id: string }).reference_id).toBe(trackedId);
  });

  it('keeps an import whose only child is tracked', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const importId = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });
    const trackedChild = await tracked(ctx, {
      startedAt: at(2 * 60 * MIN_MS),
      durationMs: 10 * MIN_MS,
      referenceId: importId,
    });

    expect((await runCleanup()).message).toBe(removed(0, 1, 0));
    expect(await existing([importId, trackedChild])).toEqual([importId, trackedChild].sort());
    const { rows } = await db.execute(
      sql`SELECT reference_id FROM sessions WHERE id = ${trackedChild}::uuid`
    );
    expect((rows[0] as { reference_id: string }).reference_id).toBe(importId);
  });

  it('never spends one tracked chain on two imports through a tracked child of an import', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const importI = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS });
    await tracked(ctx, {
      startedAt: at(40 * MIN_MS),
      durationMs: 10 * MIN_MS,
      referenceId: importI,
    });
    const importJ = await tautulliImport(ctx, {
      startedAt: at(40 * MIN_MS + 3000),
      durationMs: 25 * MIN_MS,
    });

    expect((await runCleanup()).message).toBe(removed(0, 2, 0));
    expect((await runCleanup()).message).toBe(removed(0, 2, 0));
    expect(await existing([importI, importJ])).toEqual([importI, importJ].sort());
  });

  it('keeps a tracked row stamped with a numeric external_session_id beside its resume sibling', async () => {
    const ctx = await setup();
    const sibling = await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const stamped = await insertRow(
      ctx,
      { startedAt: at(60_000), durationMs: 30 * MIN_MS, referenceId: sibling },
      { sessionKey: 'plex-tracked-7', externalSessionId: '4242' }
    );

    expect((await runCleanup()).message).toBe(removed(0, 0, 0));
    expect(await existing([stamped, sibling])).toEqual([stamped, sibling].sort());
  });

  it('keeps a Tautulli row keyed on its numeric session_key', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const tautulliRow = await insertRow(
      ctx,
      { startedAt: at(3000), durationMs: 30 * MIN_MS },
      { sessionKey: '12345', externalSessionId: '777' }
    );

    expect((await runCleanup()).message).toBe(removed(0, 0, 0));
    expect(await existing([tautulliRow])).toEqual([tautulliRow]);
  });

  it('keeps an import that started before the server was added', async () => {
    const ctx = await setup('plex', at(0));
    const importId = await tautulliImport(ctx, { startedAt: at(-30_000), durationMs: 30 * MIN_MS });
    await tracked(ctx, { startedAt: at(20_000), durationMs: 30 * MIN_MS });

    expect((await runCleanup()).message).toBe(removed(0, 0, 0));
    expect(await existing([importId])).toEqual([importId]);
  });

  it('deletes neither import when one starts 60 s before the server was added and one 30 s after', async () => {
    const ctx = await setup('plex', at(0));
    const before = await tautulliImport(ctx, { startedAt: at(-60_000), durationMs: 30 * MIN_MS });
    const after = await tautulliImport(ctx, { startedAt: at(30_000), durationMs: 30 * MIN_MS });
    await tracked(ctx, { startedAt: at(40_000), durationMs: 30 * MIN_MS });

    expect((await runCleanup()).message).toBe(removed(0, 0, 1));
    expect(await existing([before, after])).toEqual([before, after].sort());
  });

  it('keeps two imports near different rows of one tracked chain, on a rerun too', async () => {
    const ctx = await setup();
    const rootId = await tracked(ctx, { startedAt: at(0), durationMs: 10 * MIN_MS });
    await tracked(ctx, {
      startedAt: at(15 * MIN_MS),
      durationMs: 10 * MIN_MS,
      referenceId: rootId,
    });
    const importA = await tautulliImport(ctx, { startedAt: at(3000), durationMs: 18 * MIN_MS });
    const importB = await tautulliImport(ctx, {
      startedAt: at(15 * MIN_MS + 3000),
      durationMs: 18 * MIN_MS,
    });

    expect((await runCleanup()).message).toBe(removed(0, 2, 0));
    expect((await runCleanup()).message).toBe(removed(0, 2, 0));
    expect(await existing([importA, importB])).toEqual([importA, importB].sort());
  });

  it('deletes nothing on a rerun', async () => {
    const ctx = await setup();
    await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS, ratingKey: 'rk-a' });
    await tautulliImport(ctx, { startedAt: at(3000), durationMs: 30 * MIN_MS, ratingKey: 'rk-a' });
    await tracked(ctx, { startedAt: at(DAY_MS / 4), durationMs: 30 * MIN_MS, ratingKey: 'rk-b' });
    await tautulliImport(ctx, {
      startedAt: at(DAY_MS / 4 + 3000),
      durationMs: 30 * MIN_MS,
      ratingKey: 'rk-b',
      watched: true,
    });

    expect((await runCleanup()).message).toBe(removed(1, 1, 0));
    expect((await runCleanup()).message).toBe(removed(0, 1, 0));
  });

  it('deletes a Playback Reporting import on Jellyfin that duplicates a tracked play', async () => {
    const ctx = await setup('jellyfin');
    const trackedId = await tracked(ctx, { startedAt: at(0), durationMs: 30 * MIN_MS });
    const importId = await insertRow(
      ctx,
      { startedAt: at(2000), durationMs: 30 * MIN_MS },
      { sessionKey: 'pr-4711', externalSessionId: 'pr-4711' }
    );

    expect((await runCleanup()).message).toBe(removed(1, 0, 0));
    expect(await existing([trackedId, importId])).toEqual([trackedId]);
  });
});
