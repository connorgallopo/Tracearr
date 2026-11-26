/**
 * Identity backfill against a genuinely compressed sessions chunk, with the
 * decompression cap lowered beneath what the batch needs. A busy chunk
 * decompresses more tuples than the default cap even for a modest batch;
 * without the batch lifting the cap via SET LOCAL, the walk fail-retries
 * forever. The chunk window is the memory guard, not the cap.
 *
 * Run with: pnpm --filter @tracearr/server test:integration identityBackfillCompressed
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { db, recreatePool } from '../../src/db/client.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';
import { media } from '../../src/db/schema.js';
import { MAX_POINT_UPDATES_PER_PASS } from '../../src/db/timescale.js';
import { backfillSessionIdentityBatch } from '../../src/jobs/sessionIdentityBackfill.js';

const SESSIONS = 50;
const CHUNK_AGE_DAYS = 120;
const MINUTE_MS = 60_000;

async function insertMedia(values: typeof media.$inferInsert): Promise<string> {
  const [row] = await db.insert(media).values(values).returning({ id: media.id });
  if (!row) throw new Error('media insert returned nothing');
  return row.id;
}

/** Every sessions chunk ending before the age, with its uncompressed heap row count. */
async function oldChunks(ageDays: number) {
  const { rows } = await db.execute(sql`
    SELECT format('%I.%I', chunk_schema, chunk_name) AS name, is_compressed, range_start, range_end
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'sessions' AND range_end <= now() - make_interval(days => ${ageDays})
  `);
  const chunks = rows as Array<{
    name: string;
    is_compressed: boolean;
    range_start: string | Date;
    range_end: string | Date;
  }>;
  return Promise.all(
    chunks.map(async (chunk) => {
      const heap = await db.execute(
        sql`SELECT count(*)::int AS n FROM ONLY ${sql.raw(chunk.name)}`
      );
      return {
        name: chunk.name,
        compressed: chunk.is_compressed,
        heap: (heap.rows[0] as { n: number }).n,
        window: { start: new Date(chunk.range_start), end: new Date(chunk.range_end) },
      };
    })
  );
}

/**
 * A compressed chunk holding one account's linked plays, nothing for any pass to change, in a
 * single compressed batch over its first SESSIONS minutes.
 */
async function linkedHistory() {
  const server = await createTestServer({ type: 'plex' });
  const account = await createTestServerUser({
    serverId: server.id,
    userId: (await createTestUser()).id,
  });
  const showId = await insertMedia({
    mediaType: 'show',
    matchKey: `show:compressed:${server.id}`,
    title: 'Compressed Show',
    normalizedTitle: 'compressed show',
  });
  const seasonId = await insertMedia({
    mediaType: 'season',
    matchKey: `season:compressed:${server.id}`,
    title: 'Season 1',
    showMediaId: showId,
  });
  const episodeId = await insertMedia({
    mediaType: 'episode',
    matchKey: `episode:compressed:${server.id}`,
    title: 'Compressed Episode',
    normalizedTitle: 'compressed episode',
    showMediaId: showId,
  });
  await createTestLibraryItem({
    serverId: server.id,
    ratingKey: 'rk-episode',
    mediaType: 'episode',
    mediaId: episodeId,
  });
  const startedAt = new Date(Date.now() - CHUNK_AGE_DAYS * 86_400_000);
  for (let i = 0; i < SESSIONS; i++) {
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      externalSessionId: null,
      state: 'stopped',
      mediaType: 'episode',
      ratingKey: 'rk-episode',
      mediaId: episodeId,
      showMediaId: showId,
      startedAt: new Date(startedAt.getTime() + i * MINUTE_MS),
    });
  }
  return { server, showId, seasonId, episodeId, startedAt };
}

/**
 * Unlinked plays in one compressed batch after the linked history's batch, stamped with the
 * database's decompression cap at 10. Returns the uncompressed heap rows left in the chunk.
 */
async function stampsThroughLowCap(sessions: number): Promise<number> {
  const history = await linkedHistory();
  const server = await createTestServer({ type: 'plex' });
  const user = await createTestUser();
  const account = await createTestServerUser({ serverId: server.id, userId: user.id });

  const mediaId = await insertMedia({
    mediaType: 'movie',
    matchKey: `movie:compressed:${server.id}`,
    title: 'Compressed Backfill Movie',
    normalizedTitle: 'compressed backfill movie',
    year: 2020,
  });
  await createTestLibraryItem({
    serverId: server.id,
    ratingKey: 'rk-compressed',
    mediaId,
    fileSize: 1000,
  });

  for (let i = 0; i < sessions; i++) {
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      externalSessionId: null,
      state: 'stopped',
      ratingKey: 'rk-compressed',
      startedAt: new Date(history.startedAt.getTime() + (SESSIONS + 60 + i) * MINUTE_MS),
    });
  }
  await db.execute(sql`
    UPDATE sessions SET media_id = NULL
    WHERE server_id = ${server.id}::uuid AND rating_key = 'rk-compressed'
  `);

  const compressed = await compressSessionChunks(CHUNK_AGE_DAYS - 30);
  expect(compressed.length).toBeGreaterThanOrEqual(1);

  // New connections inherit the database-level cap; without the batch's
  // SET LOCAL this makes the UPDATE trip the decompression limit
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
    const result = await backfillSessionIdentityBatch(1000, {
      end: new Date(Date.now() - (CHUNK_AGE_DAYS - 60) * 86_400_000),
    });
    expect(result.updated).toBe(sessions);

    const stamped = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM sessions
      WHERE server_id = ${server.id}::uuid AND rating_key = 'rk-compressed'
        AND media_id = ${mediaId}::uuid
    `);
    expect((stamped.rows[0] as { c: number }).c).toBe(sessions);
    return (await oldChunks(CHUNK_AGE_DAYS - 30)).reduce((sum, chunk) => sum + chunk.heap, 0);
  } finally {
    await db.execute(
      sql.raw(
        `ALTER DATABASE "${dbName}" RESET timescaledb.max_tuples_decompressed_per_dml_transaction`
      )
    );
    await recreatePool();
  }
}

describe('identity backfill on a compressed chunk', () => {
  it(
    'stamps up to the point-update limit by point updates, decompressing only their batch',
    { timeout: 120_000 },
    async () => {
      // The crossover measured on TimescaleDB 2.31; re-measure before moving it.
      expect(MAX_POINT_UPDATES_PER_PASS).toBe(50);
      expect(await stampsThroughLowCap(MAX_POINT_UPDATES_PER_PASS)).toBe(
        MAX_POINT_UPDATES_PER_PASS
      );
    }
  );

  it(
    'stamps more rows than the point-update limit with the window statement, decompressing the window',
    { timeout: 120_000 },
    async () => {
      expect(await stampsThroughLowCap(MAX_POINT_UPDATES_PER_PASS + 1)).toBe(
        MAX_POINT_UPDATES_PER_PASS + 1 + SESSIONS
      );
    }
  );

  it(
    'a walk with nothing to stamp leaves a compressed chunk untouched',
    { timeout: 120_000 },
    async () => {
      await linkedHistory();
      expect((await compressSessionChunks(CHUNK_AGE_DAYS - 30)).length).toBeGreaterThanOrEqual(1);
      const before = await oldChunks(CHUNK_AGE_DAYS - 30);
      expect(before.length).toBeGreaterThanOrEqual(1);
      expect(before.every((chunk) => chunk.compressed && chunk.heap === 0)).toBe(true);

      for (const chunk of before) {
        const result = await backfillSessionIdentityBatch(5000, chunk.window);
        expect(result.updated).toBe(0);
      }

      expect(await oldChunks(CHUNK_AGE_DAYS - 30)).toEqual(before);
    }
  );

  it(
    'a walk with work decompresses only the batches it changes',
    { timeout: 120_000 },
    async () => {
      const history = await linkedHistory();
      // Each changed row is its account's only play, so its compressed batch is that one row,
      // and it starts after the linked batch ends, so the linked batch's range excludes it.
      const loneRow = async (minutes: number, fields: Record<string, unknown>) => {
        const account = await createTestServerUser({
          serverId: history.server.id,
          userId: (await createTestUser()).id,
        });
        await createTestSession({
          serverId: history.server.id,
          serverUserId: account.id,
          externalSessionId: null,
          state: 'stopped',
          mediaType: 'episode',
          startedAt: new Date(history.startedAt.getTime() + minutes * MINUTE_MS),
          ...fields,
        } as Parameters<typeof createTestSession>[0]);
      };
      await loneRow(SESSIONS + 60, { ratingKey: 'rk-episode' });
      await loneRow(SESSIONS + 120, {
        ratingKey: 'rk-repair',
        mediaId: history.episodeId,
      });
      await loneRow(SESSIONS + 180, {
        ratingKey: 'rk-season',
        mediaId: history.seasonId,
        showMediaId: history.showId,
      });
      expect((await compressSessionChunks(CHUNK_AGE_DAYS - 30)).length).toBeGreaterThanOrEqual(1);
      const before = await oldChunks(CHUNK_AGE_DAYS - 30);
      expect(before.every((chunk) => chunk.compressed && chunk.heap === 0)).toBe(true);

      let updated = 0;
      for (const chunk of before) {
        updated += (await backfillSessionIdentityBatch(5000, chunk.window)).updated;
      }
      expect(updated).toBe(3);

      const after = await oldChunks(CHUNK_AGE_DAYS - 30);
      expect(after.reduce((sum, chunk) => sum + chunk.heap, 0)).toBe(3);
      const { rows } = await db.execute(sql`
        SELECT rating_key, media_id, show_media_id FROM sessions
        WHERE server_id = ${history.server.id}::uuid AND rating_key IN ('rk-repair', 'rk-season')
        ORDER BY rating_key
      `);
      expect(rows).toEqual([
        { rating_key: 'rk-repair', media_id: history.episodeId, show_media_id: history.showId },
        { rating_key: 'rk-season', media_id: null, show_media_id: null },
      ]);
      const stamped = await db.execute(sql`
        SELECT count(*)::int AS n FROM sessions
        WHERE server_id = ${history.server.id}::uuid AND rating_key = 'rk-episode'
          AND media_id = ${history.episodeId}::uuid AND show_media_id = ${history.showId}::uuid
      `);
      expect((stamped.rows[0] as { n: number }).n).toBe(SESSIONS + 1);
    }
  );
});
