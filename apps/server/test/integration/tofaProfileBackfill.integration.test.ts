/**
 * Linking tofa plays stored without a profile to their profiles, against the real database:
 * by tofa's history rows, then by a profile name only one of the account's profiles has, through
 * compressed chunks, once per server, queued by the user sync.
 *
 * Run with: pnpm --filter @tracearr/server test:integration tofaProfileBackfill
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import {
  createStoppedSession,
  createTestServer,
  createTestServerProfile,
  createTestServerUser,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db, recreatePool } from '../../src/db/client.js';
import { serverProfiles, sessions } from '../../src/db/schema.js';
import { compressSessionChunks } from '../../src/test/compressChunks.js';
import tofa from '../../src/test/mediaServerResponses/tofa.json' with { type: 'json' };

const { getWatchHistoryPage } = vi.hoisted(() => ({ getWatchHistoryPage: vi.fn() }));
vi.mock('../../src/services/mediaServer/tofa/client.js', async () => {
  const { fakeTofaClient } = await import('../../src/test/mediaServerFakes.js');
  return {
    TofaClient: class {
      constructor() {
        return { ...fakeTofaClient(), getAccountLinks: async () => [], getWatchHistoryPage };
      }
    },
  };
});

import {
  getAllActiveMaintenanceJobs,
  initMaintenanceQueue,
  obliterateMaintenanceQueue,
  processBackfillTofaProfilesJob,
  shutdownMaintenanceQueue,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';
import {
  linkTofaPlayProfiles,
  MAX_POINT_UPDATES_PER_PROFILE_PASS,
} from '../../src/jobs/tofaProfileBackfill.js';
import { getSetting, setSetting } from '../../src/services/settings.js';
import { syncServer } from '../../src/services/sync.js';

const MORGAN_ACCOUNT = 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14';
const ROBIN = 'd2f8a4c6-3b1e-4a97-8c5d-7e0b2f9a6c13';
const [page] = tofa.watchHistoryPages;
const [imported, captured] = page?.items ?? [];
if (!imported?.session_id || !captured?.session_id) throw new Error('fixture has no plays');

function backfillJob(serverId: string): Job<MaintenanceJobData> {
  return {
    id: 'test-backfill-tofa-profiles',
    token: 'test-token',
    data: { type: 'backfill_tofa_profiles', userId: 'system', options: { serverId } },
    updateProgress: async () => undefined,
    extendLock: async () => undefined,
  } as unknown as Job<MaintenanceJobData>;
}

async function seed() {
  const server = await createTestServer({ type: 'tofa' });
  const user = await createTestUser();
  const account = await createTestServerUser({
    userId: user.id,
    serverId: server.id,
    externalId: MORGAN_ACCOUNT,
  });
  return { serverId: server.id, serverUserId: account.id };
}

async function storePlay(
  ids: { serverId: string; serverUserId: string },
  play: { profileName: string; startedAt?: string; sessionKey?: string; externalSessionId?: string }
) {
  const created = await createStoppedSession({
    ...ids,
    sessionKey: play.sessionKey,
    externalSessionId: play.externalSessionId ?? null,
    startedAt: new Date(play.startedAt ?? '2025-03-01T12:00:00Z'),
    profileName: play.profileName,
  });
  return created.id;
}

async function profileOf(playId: string) {
  const [row] = await db
    .select({ profileId: sessions.profileId })
    .from(sessions)
    .where(eq(sessions.id, playId));
  return row?.profileId;
}

beforeEach(() => {
  getWatchHistoryPage.mockReset();
  getWatchHistoryPage.mockResolvedValue({ items: [], has_more: false });
});

describe('backfill_tofa_profiles', () => {
  it(
    'links plays by their history rows over a name another profile has since taken, through a compressed chunk',
    { timeout: 120_000 },
    async () => {
      const ids = await seed();
      const robin = (await createTestServerProfile({ ...ids, name: 'Robbie', externalId: ROBIN }))
        .id;
      await createTestServerProfile({ ...ids, name: 'Robin' });
      const importedPlay = await storePlay(ids, {
        profileName: 'Robin',
        startedAt: imported.started_at,
        sessionKey: `tofa-${imported.id}`,
        externalSessionId: imported.id,
      });
      const capturedPlay = await storePlay(ids, {
        profileName: 'Robin',
        startedAt: captured.started_at,
        sessionKey: captured.session_id,
      });
      getWatchHistoryPage.mockResolvedValue({ items: [imported, captured], has_more: false });
      expect((await compressSessionChunks(30)).length).toBeGreaterThanOrEqual(1);

      // New connections take the database's cap; a statement that kept it fails on these chunks
      const { rows } = await db.execute<{ db: string }>(sql`SELECT current_database() AS db`);
      const dbName = rows[0]?.db;
      await db.execute(
        sql.raw(
          `ALTER DATABASE "${dbName}" SET timescaledb.max_tuples_decompressed_per_dml_transaction = 1`
        )
      );
      await recreatePool();
      try {
        const result = await processBackfillTofaProfilesJob(backfillJob(ids.serverId));

        expect(result).toMatchObject({ success: true, updated: 2 });
        expect([await profileOf(importedPlay), await profileOf(capturedPlay)]).toEqual([
          robin,
          robin,
        ]);
      } finally {
        await db.execute(
          sql.raw(
            `ALTER DATABASE "${dbName}" RESET timescaledb.max_tuples_decompressed_per_dml_transaction`
          )
        );
        await recreatePool();
      }
    }
  );

  it("links a play tofa no longer lists by a name only one of the account's profiles has, and leaves one two profiles share", async () => {
    const ids = await seed();
    const morgan = (await createTestServerProfile({ ...ids, name: 'Morgan' })).id;
    await createTestServerProfile({ ...ids, name: 'Kids' });
    await createTestServerProfile({ ...ids, name: 'Kids' });
    const named = await storePlay(ids, { profileName: 'Morgan' });
    const shared = await storePlay(ids, { profileName: 'Kids' });

    await processBackfillTofaProfilesJob(backfillJob(ids.serverId));

    expect(await profileOf(named)).toBe(morgan);
    expect(await profileOf(shared)).toBeNull();
  });

  it('adds a profile the history names that tofa no longer lists, marked removed, so its plays link too', async () => {
    const ids = await seed();
    const play = await storePlay(ids, {
      profileName: 'Robin',
      startedAt: imported.started_at,
      externalSessionId: imported.id,
    });
    getWatchHistoryPage.mockResolvedValue({ items: [imported], has_more: false });

    await processBackfillTofaProfilesJob(backfillJob(ids.serverId));

    const [added] = await db
      .select()
      .from(serverProfiles)
      .where(eq(serverProfiles.externalId, ROBIN));
    expect(added).toMatchObject({
      serverUserId: ids.serverUserId,
      name: 'Robin',
      removedAt: expect.any(Date),
    });
    expect(await profileOf(play)).toBe(added?.id);
  });

  it('stops reading history once a page is older than the oldest unlinked play', async () => {
    const ids = await seed();
    await storePlay(ids, { profileName: 'Robin', startedAt: '2025-06-01T00:00:00Z' });
    getWatchHistoryPage.mockResolvedValue({ items: [imported], has_more: true });

    await processBackfillTofaProfilesJob(backfillJob(ids.serverId));

    expect(getWatchHistoryPage).toHaveBeenCalledOnce();
  });

  it('does nothing on a second run for the server', async () => {
    const ids = await seed();
    await createTestServerProfile({ ...ids, name: 'Kids' });
    await createTestServerProfile({ ...ids, name: 'Kids', externalId: ROBIN });
    const play = await storePlay(ids, {
      profileName: 'Kids',
      startedAt: imported.started_at,
      externalSessionId: imported.id,
    });

    await processBackfillTofaProfilesJob(backfillJob(ids.serverId));
    getWatchHistoryPage.mockResolvedValue({ items: [imported], has_more: false });
    const second = await processBackfillTofaProfilesJob(backfillJob(ids.serverId));

    expect(second).toMatchObject({ success: true, updated: 0 });
    expect(getWatchHistoryPage).toHaveBeenCalledOnce();
    expect(await profileOf(play)).toBeNull();
    expect(await getSetting('profileBackfillDoneServers')).toContain(ids.serverId);
  });

  it('counts a run that fails', async () => {
    const ids = await seed();
    await storePlay(ids, { profileName: 'Robin' });
    getWatchHistoryPage.mockRejectedValue(new Error('tofa answered 503'));

    await expect(processBackfillTofaProfilesJob(backfillJob(ids.serverId))).rejects.toThrow(
      'tofa answered 503'
    );

    expect((await getSetting('profileBackfillFailedRuns'))[ids.serverId]).toBe(1);
  });

  it('is queued by the user sync until the server is done or has failed five runs', async () => {
    const ids = await seed();
    initMaintenanceQueue(process.env.REDIS_URL ?? '');
    const queued = async () => (await getAllActiveMaintenanceJobs()).map((job) => job.type);
    try {
      await syncServer(ids.serverId, { syncUsers: true, syncLibraries: false });
      expect(await queued()).toEqual(['backfill_tofa_profiles']);

      await obliterateMaintenanceQueue();
      await setSetting('profileBackfillFailedRuns', { [ids.serverId]: 5 });
      await syncServer(ids.serverId, { syncUsers: true, syncLibraries: false });
      expect(await queued()).toEqual([]);

      await setSetting('profileBackfillFailedRuns', {});
      await setSetting('profileBackfillDoneServers', [ids.serverId]);
      await syncServer(ids.serverId, { syncUsers: true, syncLibraries: false });
      expect(await queued()).toEqual([]);
    } finally {
      await obliterateMaintenanceQueue();
      await shutdownMaintenanceQueue();
    }
  });
});

describe('backfill_tofa_profiles writes only what it links', { timeout: 120_000 }, () => {
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
   * FILLER_SESSIONS plays of one account linked to its profile, one a minute and all on tofa's
   * history, and `unlinked` plays without a profile between them: each in its own account's batch
   * when `lone`, otherwise all in one. Each account has one profile, Main. `by` says how the
   * unlinked plays can link: on the history, by their stored name Main alone, or not at all (named
   * Kids, which two of their account's profiles share). The database's decompression cap is 10
   * while it links, so a write that kept the cap fails.
   */
  async function linkThroughCompressedChunk(
    unlinked: number,
    opts: { lone: boolean; by: 'history' | 'name' | 'nothing' }
  ) {
    const server = await createTestServer({ type: 'tofa' });
    const newAccount = async () => {
      const externalId = `account-${crypto.randomUUID()}`;
      const account = await createTestServerUser({
        userId: (await createTestUser()).id,
        serverId: server.id,
        externalId,
      });
      const profile = await createTestServerProfile({
        serverId: server.id,
        serverUserId: account.id,
        name: 'Main',
        externalId: `profile-${account.id}`,
      });
      if (opts.by === 'nothing') {
        for (const n of [1, 2]) {
          await createTestServerProfile({
            serverId: server.id,
            serverUserId: account.id,
            name: 'Kids',
            externalId: `kids-${n}-${account.id}`,
          });
        }
      }
      return { id: account.id, externalId, profile };
    };
    const base = new Date(Math.floor((Date.now() - 60 * DAY_MS) / DAY_MS) * DAY_MS + DAY_MS / 4);
    const history: NonNullable<typeof imported>[] = [];
    const play = async (
      account: Awaited<ReturnType<typeof newAccount>>,
      key: string,
      startedAt: Date,
      linked: boolean
    ) => {
      await createStoppedSession({
        serverId: server.id,
        serverUserId: account.id,
        sessionKey: `tofa-${key}`,
        externalSessionId: key,
        startedAt,
        profileId: linked ? account.profile.id : null,
        profileName: opts.by === 'nothing' && !linked ? 'Kids' : 'Main',
      });
      if (linked || opts.by === 'history') {
        history.push({
          ...imported,
          id: key,
          session_id: null,
          user_id: account.externalId,
          profile_id: account.profile.externalId,
          profile_name: 'Main',
          started_at: startedAt.toISOString(),
        });
      }
    };
    const filler = await newAccount();
    for (let i = 0; i < FILLER_SESSIONS; i++) {
      await play(filler, `filler-${i}`, new Date(base.getTime() + i * MIN_MS), true);
    }
    const shared = await newAccount();
    for (let i = 0; i < unlinked; i++) {
      const at = MIN_MS / 2 + Math.floor((i * (FILLER_SESSIONS - 1)) / unlinked) * MIN_MS + i;
      await play(
        opts.lone ? await newAccount() : shared,
        `play-${i}`,
        new Date(base.getTime() + at),
        false
      );
    }
    history.sort((a, b) => b.started_at.localeCompare(a.started_at));
    getWatchHistoryPage.mockImplementation(async (before: string | null, limit: number) => {
      const older = history.filter((row) => before === null || row.started_at < before);
      return { items: older.slice(0, limit), has_more: older.length > limit };
    });
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
    const sent = vi.spyOn(pg.Client.prototype, 'query');
    try {
      // The function, not the job: the job restores the compression policy when it ends, and the
      // policy can recompress the chunk before its heap is read.
      const linked = await linkTofaPlayProfiles(server.id, async () => undefined);
      const statements = sent.mock.calls.flatMap(([query]) =>
        typeof query === 'string'
          ? [query]
          : typeof query === 'object' && query && 'text' in query
            ? [String(query.text)]
            : []
      );
      return { linked, after: await oldChunkHeaps(), statements };
    } finally {
      sent.mockRestore();
      await db.execute(
        sql.raw(
          `ALTER DATABASE "${dbName}" RESET timescaledb.max_tuples_decompressed_per_dml_transaction`
        )
      );
      await recreatePool();
    }
  }

  it('leaves a compressed chunk compressed and untouched when nothing links', async () => {
    const { linked, after } = await linkThroughCompressedChunk(3, { lone: true, by: 'nothing' });
    expect(linked).toBe(0);
    expect(after).toMatchObject({ compressed: true, heap: 0 });
  });

  it('links by the history over a compressed chunk, decompressing only the batches it links', async () => {
    const { linked, after, statements } = await linkThroughCompressedChunk(3, {
      lone: true,
      by: 'history',
    });
    expect(linked).toBe(3);
    expect(after.heap).toBe(3);
    const updates = statements.filter((text) => text.startsWith('update "sessions"'));
    expect(updates).toHaveLength(3);
    expect(updates[0]).toBe(
      'update "sessions" set "profile_id" = $1 where ("sessions"."id" = $2 and "sessions"."started_at" = $3::timestamptz and (("sessions"."server_id" = $4 and "sessions"."started_at" >= $5 and "sessions"."started_at" <= $6 and "sessions"."external_session_id" in ($7)) and "sessions"."server_user_id" in ($8) and "sessions"."profile_id" is null))'
    );
  });

  it('links by a unique name over a compressed chunk, decompressing only the batches it links', async () => {
    const { linked, after, statements } = await linkThroughCompressedChunk(3, {
      lone: true,
      by: 'name',
    });
    expect(linked).toBe(3);
    expect(after.heap).toBe(3);
    const updates = statements.filter((text) => text.startsWith('update "sessions"'));
    expect(updates).toHaveLength(3);
    expect(updates[0]).toBe(
      'update "sessions" set "profile_id" = "named_profile_id" from (select (array_agg("id"))[1] as "named_profile_id", "server_user_id", "name" from "server_profiles" where "server_profiles"."server_id" = $1 group by "server_profiles"."server_user_id", "server_profiles"."name" having count(*) = 1) "unique_names" where ("sessions"."id" = $2 and "sessions"."started_at" = $3::timestamptz and ("sessions"."server_id" = $4 and "sessions"."profile_id" is null and "sessions"."profile_name" is not null and "sessions"."server_user_id" = "unique_names"."server_user_id" and "sessions"."profile_name" = "unique_names"."name" and "sessions"."started_at" >= $5 and "sessions"."started_at" < $6))'
    );
  });

  it("links a play two profiles' history rows both match to the first profile on the page, through a compressed chunk", async () => {
    const ids = await seed();
    const first = (await createTestServerProfile({ ...ids, name: 'One', externalId: 'p-one' })).id;
    await createTestServerProfile({ ...ids, name: 'Two', externalId: 'p-two' });
    const play = await storePlay(ids, {
      profileName: 'Robin',
      startedAt: imported.started_at,
      sessionKey: 'session-shared',
      externalSessionId: 'history-one',
    });
    const row = { ...imported, user_id: MORGAN_ACCOUNT, started_at: imported.started_at };
    getWatchHistoryPage.mockResolvedValue({
      items: [
        { ...row, id: 'history-one', session_id: null, profile_id: 'p-one', profile_name: 'One' },
        {
          ...row,
          id: 'history-two',
          session_id: 'session-shared',
          profile_id: 'p-two',
          profile_name: 'Two',
        },
      ],
      has_more: false,
    });
    expect((await compressSessionChunks(30)).length).toBeGreaterThanOrEqual(1);

    expect(await linkTofaPlayProfiles(ids.serverId, async () => undefined)).toBe(1);

    expect(await profileOf(play)).toBe(first);
  });

  it('opens no transaction for a history page with no play it can link', async () => {
    const ids = await seed();
    await createTestServerProfile({ ...ids, name: 'Kids' });
    await createTestServerProfile({ ...ids, name: 'Kids' });
    const play = await storePlay(ids, { profileName: 'Kids', startedAt: imported.started_at });
    getWatchHistoryPage.mockResolvedValue({
      items: [{ ...imported, user_id: 'an-account-tracearr-never-saw' }],
      has_more: false,
    });
    expect((await compressSessionChunks(30)).length).toBeGreaterThanOrEqual(1);
    const transactions = vi.spyOn(db, 'transaction');

    expect(await linkTofaPlayProfiles(ids.serverId, async () => undefined)).toBe(0);

    expect(transactions).not.toHaveBeenCalled();
    expect(await profileOf(play)).toBeNull();
  });

  it('pins the point-update limit below the measured crossover', () => {
    // Below the crossover measured on TimescaleDB 2.28 and 2.31; re-measure before moving it.
    expect(MAX_POINT_UPDATES_PER_PROFILE_PASS).toBe(40);
  });

  for (const by of ['history', 'name'] as const) {
    it(`links up to the point-update limit by ${by} with point updates, decompressing only their batch`, async () => {
      const { linked, after } = await linkThroughCompressedChunk(
        MAX_POINT_UPDATES_PER_PROFILE_PASS,
        { lone: false, by }
      );
      expect(linked).toBe(MAX_POINT_UPDATES_PER_PROFILE_PASS);
      expect(after.heap).toBe(MAX_POINT_UPDATES_PER_PROFILE_PASS);
    });

    it(`links more plays than the point-update limit by ${by} with its statements, decompressing their span`, async () => {
      const { linked, after } = await linkThroughCompressedChunk(
        MAX_POINT_UPDATES_PER_PROFILE_PASS + 1,
        { lone: false, by }
      );
      expect(linked).toBe(MAX_POINT_UPDATES_PER_PROFILE_PASS + 1);
      expect(after.heap).toBe(MAX_POINT_UPDATES_PER_PROFILE_PASS + 1 + FILLER_SESSIONS);
    });
  }
});
