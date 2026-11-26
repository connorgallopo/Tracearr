/**
 * Imported history linking against a compressed sessions chunk, with the
 * decompression cap lowered beneath what the batch needs, so a link written
 * without lifting the cap fails.
 *
 * Run with: pnpm --filter @tracearr/server test:integration importedHistoryLinking
 */

import { describe, it, expect } from 'vitest';
import type { Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { db, recreatePool } from '../../src/db/client.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';
import { libraries, media } from '../../src/db/schema.js';
import { getRedis } from '../../src/lib/redisShared.js';
import {
  listLinkingServers,
  runImportedHistoryLinkingWalk,
} from '../../src/jobs/importedHistoryLinking.js';
import { MAX_POINT_UPDATES_PER_PASS } from '../../src/db/timescale.js';
import {
  runImportedHistoryLinking,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';
import {
  getImportedHistoryLinkState,
  getSetting,
  rearmImportedHistoryLink,
  resetSettingsCache,
} from '../../src/services/settings.js';

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const CHUNK_AGE_DAYS = 120;
const FILLER_SESSIONS = 40;
const MACHINE_ID = 'pms-linking-test';
const OLD_RATING_KEY = 'rk-rekeyed-away';

async function plexServerWithSyncedLibrary(libraryId: string) {
  const server = await createTestServer({ type: 'plex' });
  await db.execute(
    sql`UPDATE servers SET machine_identifier = ${MACHINE_ID} WHERE id = ${server.id}::uuid`
  );
  await db
    .insert(libraries)
    .values({ serverId: server.id, libraryId, name: 'Movies', mediaType: 'movie' });
  return server;
}

function fakeJob(): Job<MaintenanceJobData> {
  return {
    id: 'test-link-imported-history',
    token: 'test-token',
    data: { type: 'link_imported_history', userId: 'owner' },
    updateProgress: async () => undefined,
    extendLock: async () => undefined,
  } as unknown as Job<MaintenanceJobData>;
}

describe('link_imported_history on a compressed chunk', { timeout: 120_000 }, () => {
  it('links an orphaned import through its Tautulli guid and reference id, leaving the tracked row and an unreturned import under the same key alone', async () => {
    const server = await plexServerWithSyncedLibrary('lib-movies');
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });

    const [mediaRow] = await db
      .insert(media)
      .values({
        mediaType: 'movie',
        matchKey: `movie:linking:${server.id}`,
        title: 'Linked Movie',
        normalizedTitle: 'linked movie',
        year: 2019,
      })
      .returning({ id: media.id });
    const mediaId = mediaRow!.id;
    const item = await createTestLibraryItem({
      serverId: server.id,
      libraryId: 'lib-movies',
      ratingKey: 'rk-current',
      mediaId,
      fileSize: 1000,
    });
    await db.execute(
      sql`UPDATE library_items SET plex_guid = 'plex://movie/5d776b59ad5437001f79c6f8' WHERE id = ${item.id}::uuid`
    );
    await getRedis().set(REDIS_KEYS.LIBRARY_SYNC_SCAN_VERSION(server.id, 'lib-movies'), '2');

    const base = new Date(
      Math.floor((Date.now() - CHUNK_AGE_DAYS * DAY_MS) / DAY_MS) * DAY_MS + DAY_MS / 2
    );
    for (let i = 0; i < FILLER_SESSIONS; i++) {
      await createTestSession({
        serverId: server.id,
        serverUserId: account.id,
        state: 'stopped',
        ratingKey: `rk-filler-${i}`,
        startedAt: new Date(base.getTime() + (i + 3) * 10 * MIN_MS),
        durationMs: 5 * MIN_MS,
      });
    }
    const imported = await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      state: 'stopped',
      sessionKey: 'tautulli-4242',
      externalSessionId: '4242',
      ratingKey: OLD_RATING_KEY,
      startedAt: base,
      stoppedAt: new Date(base.getTime() + 30 * MIN_MS),
      durationMs: 30 * MIN_MS,
    });
    const unreturned = await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      state: 'stopped',
      sessionKey: 'tautulli-5151',
      externalSessionId: '5151',
      ratingKey: OLD_RATING_KEY,
      startedAt: new Date(base.getTime() + 2 * MIN_MS),
      stoppedAt: new Date(base.getTime() + 20 * MIN_MS),
      durationMs: 18 * MIN_MS,
    });
    const tracked = await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      state: 'stopped',
      sessionKey: 'tracked-under-old-key',
      ratingKey: OLD_RATING_KEY,
      startedAt: new Date(base.getTime() + 60 * MIN_MS),
      stoppedAt: new Date(base.getTime() + 90 * MIN_MS),
      durationMs: 30 * MIN_MS,
    });
    await db.execute(
      sql`UPDATE sessions SET external_session_id = NULL WHERE id = ${tracked.id}::uuid`
    );

    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );
    const plays = async () =>
      (
        (
          await db.execute(sql`
            SELECT COUNT(DISTINCT chain_id) FILTER (WHERE counted)::int AS plays FROM user_media_plays_daily
            WHERE server_id = ${server.id}::uuid AND media_id = ${mediaId}::uuid
          `)
        ).rows[0] as { plays: number }
      ).plays;
    expect(await plays()).toBe(0);

    const compressed = await compressSessionChunks(CHUNK_AGE_DAYS - 30);
    expect(compressed.length).toBeGreaterThanOrEqual(1);

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
      await runImportedHistoryLinking(fakeJob(), {
        tautulli: {
          getPmsIdentifier: async () => MACHINE_ID,
          getGuidsByRatingKey: async (keys) =>
            new Map(
              keys
                .filter((key) => key === OLD_RATING_KEY)
                .map((key) => [
                  key,
                  {
                    guids: new Set(['plex://movie/5d776b59ad5437001f79c6f8?lang=en']),
                    referenceIds: new Set(['4242']),
                  },
                ])
            ),
        },
        trigger: 'manual',
        hasPendingLibrarySync: async () => false,
      });
    } finally {
      await db.execute(
        sql.raw(
          `ALTER DATABASE "${dbName}" RESET timescaledb.max_tuples_decompressed_per_dml_transaction`
        )
      );
      await recreatePool();
    }

    const rows = (
      await db.execute(sql`
        SELECT id, media_id FROM sessions
        WHERE id = ANY(${sql.param([imported.id, unreturned.id, tracked.id])}::uuid[])
      `)
    ).rows as Array<{ id: string; media_id: string | null }>;
    expect(rows.find((r) => r.id === imported.id)?.media_id).toBe(mediaId);
    expect(rows.find((r) => r.id === unreturned.id)?.media_id).toBeNull();
    expect(rows.find((r) => r.id === tracked.id)?.media_id).toBeNull();
    expect(await plays()).toBe(1);
    expect(await getSetting('importedHistoryLink')).toEqual({
      state: 'done',
      providerPassDoneServers: [server.id],
      autoAttempts: 0,
      generation: 0,
      armedAt: expect.any(String),
    });
  });

  describe('imports that started after the server was added', () => {
    const GUID = 'plex://movie/5d776b59ad5437001f79c6f9';
    const IMDB_ID = 'tt0111161';

    async function trackedPlayWithLaterImport() {
      const server = await plexServerWithSyncedLibrary('lib-movies');
      const user = await createTestUser();
      const account = await createTestServerUser({ serverId: server.id, userId: user.id });
      const trackedStart = new Date(
        Math.floor((Date.now() - 10 * DAY_MS) / DAY_MS) * DAY_MS + DAY_MS / 2
      );
      await db.execute(
        sql`UPDATE servers SET created_at = ${new Date(trackedStart.getTime() - DAY_MS).toISOString()}::timestamptz WHERE id = ${server.id}::uuid`
      );

      const [mediaRow] = await db
        .insert(media)
        .values({
          mediaType: 'movie',
          matchKey: `movie:linking-cutoff:${server.id}`,
          title: 'Tracked Movie',
          normalizedTitle: 'tracked movie',
          year: 1994,
          imdbId: IMDB_ID,
        })
        .returning({ id: media.id });
      const mediaId = mediaRow!.id;
      const item = await createTestLibraryItem({
        serverId: server.id,
        libraryId: 'lib-movies',
        ratingKey: 'rk-new',
        mediaId,
        fileSize: 1000,
      });
      await db.execute(
        sql`UPDATE library_items SET plex_guid = ${GUID} WHERE id = ${item.id}::uuid`
      );
      await getRedis().set(REDIS_KEYS.LIBRARY_SYNC_SCAN_VERSION(server.id, 'lib-movies'), '2');

      const tracked = await createTestSession({
        serverId: server.id,
        serverUserId: account.id,
        state: 'stopped',
        sessionKey: 'tracked',
        ratingKey: 'rk-old',
        mediaId,
        watched: true,
        startedAt: trackedStart,
        stoppedAt: new Date(trackedStart.getTime() + 30 * MIN_MS),
        durationMs: 30 * MIN_MS,
      });
      await db.execute(
        sql`UPDATE sessions SET external_session_id = NULL WHERE id = ${tracked.id}::uuid`
      );
      const importStart = new Date(trackedStart.getTime() + 3000);
      const imported = await createTestSession({
        serverId: server.id,
        serverUserId: account.id,
        state: 'stopped',
        sessionKey: 'tautulli-4242',
        externalSessionId: '4242',
        ratingKey: 'rk-old',
        imdbId: IMDB_ID,
        startedAt: importStart,
        stoppedAt: new Date(importStart.getTime() + 40 * MIN_MS),
        durationMs: 40 * MIN_MS,
      });

      const plays = async () => {
        await db.execute(
          sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
        );
        const result = await db.execute(sql`
          SELECT COUNT(DISTINCT chain_id) FILTER (WHERE counted)::int AS plays FROM user_media_plays_daily
          WHERE server_user_id = ${account.id}::uuid AND media_id = ${mediaId}::uuid
            AND day = time_bucket('1 day', ${trackedStart.toISOString()}::timestamptz)
        `);
        return (result.rows[0] as { plays: number }).plays;
      };
      const importMediaId = async () =>
        (
          (await db.execute(sql`SELECT media_id FROM sessions WHERE id = ${imported.id}::uuid`))
            .rows[0] as { media_id: string | null }
        ).media_id;

      return { plays, importMediaId };
    }

    it('leaves an import beside a tracked play unlinked when its Tautulli guid resolves', async () => {
      const { plays, importMediaId } = await trackedPlayWithLaterImport();
      expect(await plays()).toBe(1);

      await runImportedHistoryLinking(fakeJob(), {
        tautulli: {
          getPmsIdentifier: async () => MACHINE_ID,
          getGuidsByRatingKey: async (keys) =>
            new Map(
              keys
                .filter((key) => key === 'rk-old')
                .map((key) => [key, { guids: new Set([GUID]), referenceIds: new Set(['4242']) }])
            ),
        },
        trigger: 'manual',
        hasPendingLibrarySync: async () => false,
      });

      expect(await importMediaId()).toBeNull();
      expect(await plays()).toBe(1);
    });

    it('leaves an import beside a tracked play unlinked when its IMDb id matches and Tautulli is not configured', async () => {
      const { plays, importMediaId } = await trackedPlayWithLaterImport();
      expect(await plays()).toBe(1);

      await runImportedHistoryLinking(fakeJob(), {
        tautulli: null,
        trigger: 'manual',
        hasPendingLibrarySync: async () => false,
      });

      expect(await importMediaId()).toBeNull();
      expect(await plays()).toBe(1);
    });
  });

  it('keeps the provider ids an import already had when the matched movie lacks them', async () => {
    const server = await plexServerWithSyncedLibrary('lib-movies');
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });

    const [mediaRow] = await db
      .insert(media)
      .values({
        mediaType: 'movie',
        matchKey: `movie:linking-keeps-ids:${server.id}`,
        title: 'The Matrix',
        normalizedTitle: 'the matrix',
        year: 1999,
        tmdbId: 603,
      })
      .returning({ id: media.id });
    const mediaId = mediaRow!.id;
    await createTestLibraryItem({
      serverId: server.id,
      libraryId: 'lib-movies',
      ratingKey: 'rk-new',
      mediaId,
      fileSize: 1000,
    });
    await getRedis().set(REDIS_KEYS.LIBRARY_SYNC_SCAN_VERSION(server.id, 'lib-movies'), '2');

    const importStart = new Date(Date.now() - 10 * DAY_MS);
    const imported = await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      state: 'stopped',
      sessionKey: 'tautulli-603',
      externalSessionId: '603',
      ratingKey: 'rk-old',
      imdbId: 'tt0133093',
      tmdbId: 603,
      tvdbId: 169,
      startedAt: importStart,
      stoppedAt: new Date(importStart.getTime() + 40 * MIN_MS),
      durationMs: 40 * MIN_MS,
    });

    await runImportedHistoryLinking(fakeJob(), {
      tautulli: null,
      trigger: 'manual',
      hasPendingLibrarySync: async () => false,
    });

    const result = await db.execute(
      sql`SELECT media_id, imdb_id, tmdb_id, tvdb_id FROM sessions WHERE id = ${imported.id}::uuid`
    );
    expect(result.rows[0]).toEqual({
      media_id: mediaId,
      imdb_id: 'tt0133093',
      tmdb_id: 603,
      tvdb_id: 169,
    });
  });

  it('lists only Plex servers for linking', async () => {
    const plex = await createTestServer({ type: 'plex' });
    await createTestServer({ type: 'jellyfin' });
    await createTestServer({ type: 'emby' });

    expect((await listLinkingServers()).map((s) => s.id)).toEqual([plex.id]);
  });

  it('drops its state write when a re-arm with identical values lands mid-run', async () => {
    await plexServerWithSyncedLibrary('lib-movies');
    await rearmImportedHistoryLink({ keepProviderPass: false });

    await runImportedHistoryLinking(fakeJob(), {
      tautulli: {
        getPmsIdentifier: async () => {
          await rearmImportedHistoryLink({ keepProviderPass: false });
          return MACHINE_ID;
        },
        getGuidsByRatingKey: async () => new Map(),
      },
      trigger: 'manual',
      hasPendingLibrarySync: async () => false,
    });

    const stored = await db.execute(
      sql`SELECT value FROM settings WHERE name = 'importedHistoryLink'`
    );
    expect(stored.rows).toEqual([
      {
        value: {
          state: 'pending',
          providerPassDoneServers: [],
          autoAttempts: 0,
          generation: 2,
          armedAt: expect.any(String),
        },
      },
    ]);
  });

  it('moves armedAt to now on a re-arm', async () => {
    const old = new Date(Date.now() - 20 * DAY_MS).toISOString();
    await db.execute(sql`
      INSERT INTO settings (name, value)
      VALUES ('importedHistoryLink', ${JSON.stringify({ state: 'done', providerPassDoneServers: [], autoAttempts: 3, generation: 4, armedAt: old })}::jsonb)
    `);
    resetSettingsCache();
    const before = Date.now();

    await rearmImportedHistoryLink({ keepProviderPass: true });
    resetSettingsCache();

    const state = await getImportedHistoryLinkState();
    expect(state).toMatchObject({ state: 'pending', autoAttempts: 0, generation: 5 });
    expect(Date.parse(state.armedAt)).toBeGreaterThanOrEqual(before);
  });

  it('reads and writes a stored state without a generation or armedAt as generation 0, armed now', async () => {
    const server = await plexServerWithSyncedLibrary('lib-movies');
    await db.execute(sql`
      INSERT INTO settings (name, value)
      VALUES ('importedHistoryLink', '{"state":"pending","providerPassDoneServers":[],"autoAttempts":0}'::jsonb)
    `);
    resetSettingsCache();
    const before = Date.now();

    await runImportedHistoryLinking(fakeJob(), {
      tautulli: null,
      trigger: 'manual',
      hasPendingLibrarySync: async () => false,
    });

    const stored = await db.execute(
      sql`SELECT value FROM settings WHERE name = 'importedHistoryLink'`
    );
    expect(stored.rows).toEqual([
      {
        value: {
          state: 'done',
          providerPassDoneServers: [server.id],
          autoAttempts: 0,
          generation: 0,
          armedAt: expect.any(String),
        },
      },
    ]);
    const { armedAt } = (stored.rows[0] as { value: { armedAt: string } }).value;
    expect(Date.parse(armedAt)).toBeGreaterThanOrEqual(before);
  });
});

describe('link_imported_history writes only what it links', { timeout: 120_000 }, () => {
  const IMDB_ID = 'tt0068646';
  const GUID = 'plex://movie/5d7768ba96b655001fdc0408';

  /** Uncompressed heap rows across the old sessions chunks, and whether every one is compressed. */
  async function oldChunkHeaps() {
    const { rows } = await db.execute(sql`
      SELECT format('%I.%I', chunk_schema, chunk_name) AS name, is_compressed
      FROM timescaledb_information.chunks
      WHERE hypertable_name = 'sessions'
        AND range_end <= now() - make_interval(days => ${CHUNK_AGE_DAYS - 30})
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
   * FILLER_SESSIONS linked plays of one account in one compressed batch, then `orphans` imported
   * movie plays carrying IMDB_ID after it: each in its own account's batch when `lone`, otherwise
   * all in one. The library movie carries `libraryImdbId`. Runs the linker by provider id with the
   * database's decompression cap at 10 and returns the plays it linked and left unlinked, and the
   * old chunks' heaps. With `guidListed`, the plays carry no provider id and link through the
   * guid pass instead, Tautulli returning only the first `guidListed` of their reference ids.
   */
  async function linkThroughCompressedChunk(
    orphans: number,
    opts: { lone: boolean; libraryImdbId: string; guidListed?: number }
  ) {
    const server = await plexServerWithSyncedLibrary('lib-movies');
    const newAccount = async () =>
      createTestServerUser({ serverId: server.id, userId: (await createTestUser()).id });
    const [mediaRow] = await db
      .insert(media)
      .values({
        mediaType: 'movie',
        matchKey: `movie:linking-compressed:${server.id}`,
        title: 'The Godfather',
        normalizedTitle: 'the godfather',
        year: 1972,
        imdbId: opts.libraryImdbId,
      })
      .returning({ id: media.id });
    if (!mediaRow) throw new Error('media insert returned nothing');
    const item = await createTestLibraryItem({
      serverId: server.id,
      libraryId: 'lib-movies',
      ratingKey: 'rk-new',
      mediaId: mediaRow.id,
      fileSize: 1000,
    });
    await db.execute(sql`UPDATE library_items SET plex_guid = ${GUID} WHERE id = ${item.id}::uuid`);
    await getRedis().set(REDIS_KEYS.LIBRARY_SYNC_SCAN_VERSION(server.id, 'lib-movies'), '2');

    const base = new Date(
      Math.floor((Date.now() - CHUNK_AGE_DAYS * DAY_MS) / DAY_MS) * DAY_MS + DAY_MS / 4
    );
    const filler = await newAccount();
    for (let i = 0; i < FILLER_SESSIONS; i++) {
      await createTestSession({
        serverId: server.id,
        serverUserId: filler.id,
        state: 'stopped',
        ratingKey: 'rk-new',
        mediaId: mediaRow.id,
        startedAt: new Date(base.getTime() + i * MIN_MS),
        durationMs: MIN_MS,
      });
    }
    const shared = await newAccount();
    for (let i = 0; i < orphans; i++) {
      const account = opts.lone ? await newAccount() : shared;
      await createTestSession({
        serverId: server.id,
        serverUserId: account.id,
        state: 'stopped',
        sessionKey: `tautulli-${i}`,
        externalSessionId: `${i}`,
        ratingKey: 'rk-old',
        imdbId: opts.guidListed === undefined ? IMDB_ID : null,
        tvdbId: 42,
        startedAt: new Date(base.getTime() + (FILLER_SESSIONS + 60 + i) * MIN_MS),
        durationMs: MIN_MS,
      });
    }

    expect((await compressSessionChunks(CHUNK_AGE_DAYS - 30)).length).toBeGreaterThanOrEqual(1);
    const before = await oldChunkHeaps();
    expect(before.chunks).toBeGreaterThanOrEqual(1);
    expect(before).toMatchObject({ compressed: true, heap: 0 });

    const dbName = (
      (await db.execute(sql`SELECT current_database() AS db`)).rows[0] as { db: string }
    ).db;
    await db.execute(
      sql.raw(
        `ALTER DATABASE "${dbName}" SET timescaledb.max_tuples_decompressed_per_dml_transaction = 10`
      )
    );
    await recreatePool();
    let total: number;
    try {
      // The walk, not the job: the job restores the compression policy when it ends, and the
      // policy can recompress the chunk before its heap is read.
      const listed = opts.guidListed;
      ({ total } = await runImportedHistoryLinkingWalk({
        tautulli:
          listed === undefined
            ? null
            : {
                getPmsIdentifier: async () => MACHINE_ID,
                getGuidsByRatingKey: async (keys) =>
                  new Map(
                    keys
                      .filter((key) => key === 'rk-old')
                      .map((key) => [
                        key,
                        {
                          guids: new Set([GUID]),
                          referenceIds: new Set(Array.from({ length: listed }, (_, i) => `${i}`)),
                        },
                      ])
                  ),
              },
        trigger: 'manual',
        hasPendingLibrarySync: async () => false,
        onBatch: async () => undefined,
        onCommit: () => undefined,
      }));
    } finally {
      await db.execute(
        sql.raw(
          `ALTER DATABASE "${dbName}" RESET timescaledb.max_tuples_decompressed_per_dml_transaction`
        )
      );
      await recreatePool();
    }

    const linked = await db.execute(sql`
      SELECT count(*)::int AS n FROM sessions
      WHERE server_id = ${server.id}::uuid AND rating_key = 'rk-old'
        AND media_id = ${mediaRow.id}::uuid AND imdb_id = ${IMDB_ID} AND tvdb_id = 42
    `);
    const count = (linked.rows[0] as { n: number }).n;
    expect(total).toBe(count);
    const unlinked = await db.execute(sql`
      SELECT array_agg(external_session_id ORDER BY external_session_id) AS ids FROM sessions
      WHERE server_id = ${server.id}::uuid AND rating_key = 'rk-old' AND media_id IS NULL
    `);
    return {
      linked: count,
      unlinked: (unlinked.rows[0] as { ids: string[] | null }).ids ?? [],
      after: await oldChunkHeaps(),
    };
  }

  it('leaves a compressed chunk compressed and untouched when nothing links', async () => {
    const { linked, after } = await linkThroughCompressedChunk(3, {
      lone: true,
      libraryImdbId: 'tt0071562',
    });
    expect(linked).toBe(0);
    expect(after).toMatchObject({ compressed: true, heap: 0 });
  });

  it('linking over a compressed chunk decompresses only the rows it links', async () => {
    const { linked, after } = await linkThroughCompressedChunk(3, {
      lone: true,
      libraryImdbId: IMDB_ID,
    });
    expect(linked).toBe(3);
    expect(after.heap).toBe(3);
  });

  it('links through the guid pass inside a compressed chunk, decompressing only the listed rows', async () => {
    const { linked, unlinked, after } = await linkThroughCompressedChunk(4, {
      lone: true,
      libraryImdbId: IMDB_ID,
      guidListed: 3,
    });
    expect(linked).toBe(3);
    expect(unlinked).toEqual(['3']);
    expect(after.heap).toBe(3);
  });

  it('links up to the point-update limit by point updates, decompressing only their batch', async () => {
    // Below the crossover measured on TimescaleDB 2.28 and 2.31; re-measure before moving it.
    expect(MAX_POINT_UPDATES_PER_PASS).toBe(50);
    const { linked, after } = await linkThroughCompressedChunk(MAX_POINT_UPDATES_PER_PASS, {
      lone: false,
      libraryImdbId: IMDB_ID,
    });
    expect(linked).toBe(MAX_POINT_UPDATES_PER_PASS);
    expect(after.heap).toBe(MAX_POINT_UPDATES_PER_PASS);
  });

  it('links more rows than the point-update limit with the window statement, decompressing the window', async () => {
    const { linked, after } = await linkThroughCompressedChunk(MAX_POINT_UPDATES_PER_PASS + 1, {
      lone: false,
      libraryImdbId: IMDB_ID,
    });
    expect(linked).toBe(MAX_POINT_UPDATES_PER_PASS + 1);
    expect(after.heap).toBe(MAX_POINT_UPDATES_PER_PASS + 1 + FILLER_SESSIONS);
  });
});
