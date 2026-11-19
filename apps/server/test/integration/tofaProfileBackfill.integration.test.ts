/**
 * Linking tofa plays stored without a profile to their profiles, against the real database:
 * by tofa's history rows, then by a profile name only one of the account's profiles has, through
 * compressed chunks, once per server, queued by the user sync.
 *
 * Run with: pnpm --filter @tracearr/server test:integration tofaProfileBackfill
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import {
  createStoppedSession,
  createTestServer,
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

async function storeProfile(
  serverId: string,
  serverUserId: string,
  name: string,
  externalId?: string
) {
  const [row] = await db
    .insert(serverProfiles)
    .values({ serverId, serverUserId, externalId: externalId ?? randomUUID(), name })
    .returning({ id: serverProfiles.id });
  if (!row) throw new Error('the profile was not stored');
  return row.id;
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
  });
  await db
    .update(sessions)
    .set({ profileName: play.profileName })
    .where(eq(sessions.id, created.id));
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
      const robin = await storeProfile(ids.serverId, ids.serverUserId, 'Robbie', ROBIN);
      await storeProfile(ids.serverId, ids.serverUserId, 'Robin');
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
    const morgan = await storeProfile(ids.serverId, ids.serverUserId, 'Morgan');
    await storeProfile(ids.serverId, ids.serverUserId, 'Kids');
    await storeProfile(ids.serverId, ids.serverUserId, 'Kids');
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
    await storeProfile(ids.serverId, ids.serverUserId, 'Kids');
    await storeProfile(ids.serverId, ids.serverUserId, 'Kids', ROBIN);
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

  it('is queued by the user sync until the server is done', async () => {
    const ids = await seed();
    initMaintenanceQueue(process.env.REDIS_URL ?? '');
    const queued = async () => (await getAllActiveMaintenanceJobs()).map((job) => job.type);
    try {
      await syncServer(ids.serverId, { syncUsers: true, syncLibraries: false });
      expect(await queued()).toEqual(['backfill_tofa_profiles']);

      await obliterateMaintenanceQueue();
      await setSetting('profileBackfillDoneServers', [ids.serverId]);
      await syncServer(ids.serverId, { syncUsers: true, syncLibraries: false });
      expect(await queued()).toEqual([]);
    } finally {
      await obliterateMaintenanceQueue();
      await shutdownMaintenanceQueue();
    }
  });
});
