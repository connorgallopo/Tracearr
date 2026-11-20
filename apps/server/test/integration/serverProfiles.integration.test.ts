/**
 * Writing server_profiles against the real database: the profiles plays name, resolved to
 * their rows, and each account's profile list from the user sync.
 *
 * Run with: pnpm --filter @tracearr/server test:integration serverProfiles
 */

import { describe, it, expect, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createStoppedSession,
  createTestServer,
  createTestServerProfile,
  createTestServerUser,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { serverProfiles, sessions } from '../../src/db/schema.js';
import { invalidateServersCache } from '../../src/jobs/poller/database.js';
import { mergeUsers } from '../../src/services/mergeService.js';
import {
  registerProfileCacheInvalidation,
  resolveProfiles,
  syncAccountProfiles,
} from '../../src/services/profiles.js';
import { fakeTofaClient } from '../../src/test/mediaServerFakes.js';

const MORGAN_ACCOUNT = 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14';
const MORGAN = 'd2f6a1b8-3c47-4e59-9a0d-7b8c1e4f6a23';
const ROBIN = 'd2f8a4c6-3b1e-4a97-8c5d-7e0b2f9a6c13';
const CASEY = '6f3a9d1e-2b84-4c57-a0e6-9d4b7c2e1f83';

async function addAccount(serverId: string, externalId?: string) {
  const user = await createTestUser();
  return createTestServerUser({ userId: user.id, serverId, externalId });
}

async function seed() {
  const server = await createTestServer({ type: 'tofa' });
  return { serverId: server.id, account: await addAccount(server.id, MORGAN_ACCOUNT) };
}

/** The fixture's lists, with the given account listing Casey */
function listsWithCasey(caseysAccount: string) {
  const listed = fakeTofaClient().getAccountProfiles;
  return vi.fn(async (accountExternalId: string) =>
    accountExternalId === caseysAccount
      ? [{ id: CASEY, name: 'Casey', thumb: null, isPrimary: true, isChild: false }]
      : listed(accountExternalId)
  );
}

async function storedProfile(id: string) {
  const [row] = await db
    .select({
      name: serverProfiles.name,
      serverUserId: serverProfiles.serverUserId,
      removedAt: serverProfiles.removedAt,
      version: sql<string>`xmin::text`,
    })
    .from(serverProfiles)
    .where(eq(serverProfiles.id, id));
  return row;
}

describe('resolveProfiles', () => {
  it('takes the name a live play gives and clears a removal', async () => {
    const { serverId, account } = await seed();
    const stored = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
      removedAt: new Date('2026-11-01T00:00:00Z'),
    });

    const resolved = await resolveProfiles(
      serverId,
      [{ externalId: ROBIN, serverUserId: account.id, name: 'Robbie' }],
      'refresh'
    );

    expect(resolved).toEqual(new Map([[ROBIN, { id: stored.id }]]));
    expect(await storedProfile(stored.id)).toMatchObject({ name: 'Robbie', removedAt: null });
  });

  it('adds a profile a past play names, but never renames or restores a stored one', async () => {
    const { serverId, account } = await seed();
    const removedAt = new Date('2026-11-01T00:00:00Z');
    const stored = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
      removedAt,
    });

    const resolved = await resolveProfiles(
      serverId,
      [
        { externalId: ROBIN, serverUserId: account.id, name: 'Robbie' },
        { externalId: MORGAN, serverUserId: account.id, name: 'Morgan' },
      ],
      'insertMissing'
    );

    const added = await db
      .select()
      .from(serverProfiles)
      .where(eq(serverProfiles.externalId, MORGAN));
    expect(added).toEqual([
      expect.objectContaining({ serverId, serverUserId: account.id, name: 'Morgan' }),
    ]);
    expect(resolved).toEqual(
      new Map([
        [ROBIN, { id: stored.id }],
        [MORGAN, { id: added[0]?.id }],
      ])
    );
    expect(await storedProfile(stored.id)).toMatchObject({ name: 'Robin', removedAt });
  });

  it('writes nothing for a profile seen again unchanged', async () => {
    const { serverId, account } = await seed();
    const stored = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const before = await storedProfile(stored.id);

    const resolved = await resolveProfiles(
      serverId,
      [{ externalId: ROBIN, serverUserId: account.id, name: 'Robin' }],
      'refresh'
    );

    expect(resolved).toEqual(new Map([[ROBIN, { id: stored.id }]]));
    expect(await storedProfile(stored.id)).toEqual(before);
  });

  it('sends no statement for a profile a live poll stored as sighted, and writes a rename', async () => {
    const { serverId, account } = await seed();
    const thumbUrl = '/api/v1/profiles/avatars/kaiju.png';
    const stored = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
      thumbUrl,
      isPrimary: false,
    });
    const sighting = { externalId: ROBIN, serverUserId: account.id, name: 'Robin' };
    await resolveProfiles(serverId, [sighting], 'refresh');
    const execute = vi.spyOn(db, 'execute');

    const resolved = await resolveProfiles(serverId, [sighting], 'refresh');
    const nonMainProfile = { name: 'Robin', thumbUrl, removed: false };
    expect(resolved).toEqual(new Map([[ROBIN, { id: stored.id, nonMainProfile }]]));
    expect(execute).not.toHaveBeenCalled();

    await resolveProfiles(serverId, [{ ...sighting, name: 'Robbie' }], 'refresh');
    expect(execute).toHaveBeenCalledOnce();
    expect(await storedProfile(stored.id)).toMatchObject({ name: 'Robbie' });
  });

  it('writes a sighted profile again once the servers cache is invalidated', async () => {
    registerProfileCacheInvalidation();
    const { serverId, account } = await seed();
    await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const sighting = { externalId: ROBIN, serverUserId: account.id, name: 'Robin' };
    await resolveProfiles(serverId, [sighting], 'refresh');
    const execute = vi.spyOn(db, 'execute');

    invalidateServersCache();
    await resolveProfiles(serverId, [sighting], 'refresh');

    expect(execute).toHaveBeenCalledOnce();
  });

  it('clears a removal the user sync made when a live play names the profile again', async () => {
    const { serverId, account } = await seed();
    const casey = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: CASEY,
      name: 'Casey',
    });
    const sighting = { externalId: CASEY, serverUserId: account.id, name: 'Casey' };
    await resolveProfiles(serverId, [sighting], 'refresh');
    await syncAccountProfiles(serverId, fakeTofaClient(), [MORGAN_ACCOUNT]);
    expect(await storedProfile(casey.id)).toMatchObject({ removedAt: expect.any(Date) });

    await resolveProfiles(serverId, [sighting], 'refresh');

    expect(await storedProfile(casey.id)).toMatchObject({ removedAt: null });
  });

  it('keeps a profile on its stored account when another account plays it, warning and writing once', async () => {
    const { serverId, account } = await seed();
    const other = await addAccount(serverId);
    const stored = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const execute = vi.spyOn(db, 'execute');
    const sighting = { externalId: ROBIN, serverUserId: other.id, name: 'Robin' };

    await resolveProfiles(serverId, [sighting], 'refresh');
    const resolved = await resolveProfiles(serverId, [sighting], 'refresh');

    expect(resolved).toEqual(new Map([[ROBIN, { id: stored.id }]]));
    expect(await storedProfile(stored.id)).toMatchObject({ serverUserId: account.id });
    expect(warn).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('finds a profile another transaction stores while the write waits on it', async () => {
    const { serverId, account } = await seed();
    const sighting = { externalId: ROBIN, serverUserId: account.id, name: 'Robin' };
    let resolved: ReturnType<typeof resolveProfiles> | undefined;

    const stored = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(serverProfiles)
        .values({ serverId, serverUserId: account.id, externalId: ROBIN, name: 'Robin' })
        .returning({ id: serverProfiles.id });
      resolved = resolveProfiles(serverId, [sighting], 'refresh');
      // Commits only once the write waits on this row, so the write's snapshot predates it
      await vi.waitFor(async () => {
        const { rows } = await db.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO server_profiles%'
        `);
        expect(rows[0]?.waiting).toBe(1);
      });
      return row;
    });

    expect(await resolved).toEqual(new Map([[ROBIN, { id: stored?.id }]]));
  });
});

describe('syncAccountProfiles', () => {
  it('marks removed a profile the account no longer lists, its plays still linked to it', async () => {
    const { serverId, account } = await seed();
    const gone = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: '0b9e2c4d-6a71-4f38-9d25-1c8e7a3f5b60',
      name: 'Sam',
    });
    const play = await createStoppedSession({
      serverId,
      serverUserId: account.id,
      profileId: gone.id,
    });

    expect(await syncAccountProfiles(serverId, fakeTofaClient(), [MORGAN_ACCOUNT])).toBe(true);

    const profiles = await db
      .select()
      .from(serverProfiles)
      .where(eq(serverProfiles.serverUserId, account.id));
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: MORGAN, name: 'Morgan', removedAt: null }),
        expect.objectContaining({ externalId: ROBIN, isChild: true, removedAt: null }),
        expect.objectContaining({ id: gone.id, name: 'Sam', removedAt: expect.any(Date) }),
      ])
    );
    expect(profiles).toHaveLength(3);
    const [linked] = await db
      .select({ profileId: sessions.profileId })
      .from(sessions)
      .where(eq(sessions.id, play.id));
    expect(linked?.profileId).toBe(gone.id);
  });

  it('leaves the profiles of an account whose list fails, still syncs the others, and says it fell short', async () => {
    const { serverId, account } = await seed();
    const failing = await addAccount(serverId);
    const kept = await createTestServerProfile({
      serverId,
      serverUserId: failing.id,
      externalId: CASEY,
      name: 'Casey',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const listed = fakeTofaClient().getAccountProfiles;
    const client = fakeTofaClient({
      getAccountProfiles: vi.fn(async (accountExternalId: string) => {
        if (accountExternalId === failing.externalId) throw new Error('tofa answered 503');
        return listed(accountExternalId);
      }),
    });

    const complete = await syncAccountProfiles(serverId, client, [
      failing.externalId,
      MORGAN_ACCOUNT,
    ]);

    expect(complete).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(await storedProfile(kept.id)).toMatchObject({ name: 'Casey', removedAt: null });
    const synced = await db
      .select({ externalId: serverProfiles.externalId })
      .from(serverProfiles)
      .where(eq(serverProfiles.serverUserId, account.id));
    expect(synced.map((profile) => profile.externalId).sort()).toEqual([MORGAN, ROBIN].sort());
  });

  it('marks removed the profiles of an account the server no longer reports', async () => {
    const { serverId } = await seed();
    const user = await createTestUser();
    const gone = await createTestServerUser({ userId: user.id, serverId, removedAt: new Date() });
    const profile = await createTestServerProfile({ serverId, serverUserId: gone.id });

    await syncAccountProfiles(serverId, fakeTofaClient(), [MORGAN_ACCOUNT]);

    expect(await storedProfile(profile.id)).toMatchObject({ removedAt: expect.any(Date) });
  });

  it("keeps the profiles a same-server merge folded in, reading the folded account's list too", async () => {
    const { serverId, account } = await seed();
    const folded = await addAccount(serverId);
    const admin = await createTestUser({ role: 'owner' });
    const client = fakeTofaClient({ getAccountProfiles: listsWithCasey(folded.externalId) });
    await syncAccountProfiles(serverId, client, [MORGAN_ACCOUNT, folded.externalId]);

    await mergeUsers(folded.userId, account.userId, admin.id, { confirmSameServerCombine: true });
    await syncAccountProfiles(serverId, client, [MORGAN_ACCOUNT, folded.externalId]);

    const profiles = await db
      .select({ externalId: serverProfiles.externalId, removedAt: serverProfiles.removedAt })
      .from(serverProfiles)
      .where(eq(serverProfiles.serverUserId, account.id));
    expect(profiles).toHaveLength(3);
    expect(profiles.every((profile) => profile.removedAt === null)).toBe(true);
  });

  it('keeps a profile stored under one account and listed under another, whichever list is read first', async () => {
    const { serverId, account } = await seed();
    const lister = await addAccount(serverId);
    const stored = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: CASEY,
      name: 'Casey',
    });
    const client = fakeTofaClient({ getAccountProfiles: listsWithCasey(lister.externalId) });

    for (const order of [
      [MORGAN_ACCOUNT, lister.externalId],
      [lister.externalId, MORGAN_ACCOUNT],
    ]) {
      await syncAccountProfiles(serverId, client, order);
      expect(await storedProfile(stored.id)).toMatchObject({
        serverUserId: account.id,
        removedAt: null,
      });
    }
  });
});
