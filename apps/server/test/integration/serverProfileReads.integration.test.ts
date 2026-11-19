/**
 * Reading server_profiles against the real database: the name and removed flag History and
 * session detail show for a play, the profile filter on History and the map, the filter's
 * options, and the user page's per-profile split.
 *
 * Run with: pnpm --filter @tracearr/server test:integration serverProfileReads
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { HistoryFilterOptions, HistorySessionResponse } from '@tracearr/shared';
import {
  createStoppedSession,
  createTestServer,
  createTestServerUser,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { serverProfiles, sessions } from '../../src/db/schema.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { locationsRoutes } from '../../src/routes/stats/locations.js';
import { resolveProfiles, syncAccountProfiles } from '../../src/services/profiles.js';
import {
  queryIdentityRangeStats,
  resolveIdentityWindow,
} from '../../src/services/stats/peopleStats.js';
import { createOwnerPayload, createTestApp, generateTestToken } from '../../src/test/helpers.js';
import { fakeTofaClient } from '../../src/test/mediaServerFakes.js';

const MORGAN_ACCOUNT = 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14';
const ROBIN = 'd2f8a4c6-3b1e-4a97-8c5d-7e0b2f9a6c13';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** GET as the owner, through the session and map routes */
async function get(url: string) {
  if (!app) {
    app = await createTestApp();
    await app.register(sessionRoutes, { prefix: '/sessions' });
    await app.register(locationsRoutes, { prefix: '/stats' });
  }
  const token = generateTestToken(app, createOwnerPayload({ serverIds: [] }));
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

async function seedAccount() {
  const server = await createTestServer({ type: 'tofa' });
  const user = await createTestUser();
  const account = await createTestServerUser({
    userId: user.id,
    serverId: server.id,
    externalId: MORGAN_ACCOUNT,
  });
  return { serverId: server.id, account };
}

async function storeProfile(profile: typeof serverProfiles.$inferInsert) {
  const [row] = await db.insert(serverProfiles).values(profile).returning();
  if (!row) throw new Error('the profile was not stored');
  return row;
}

/** A stopped play on the account, stored with the profile name and linked to the profile */
async function play(
  serverId: string,
  serverUserId: string,
  profile: { id: string | null; name: string },
  segment: { durationMs?: number; referenceId?: string } = {}
) {
  const created = await createStoppedSession({
    serverId,
    serverUserId,
    durationMs: segment.durationMs ?? 600_000,
    referenceId: segment.referenceId,
  });
  await db
    .update(sessions)
    .set({ profileId: profile.id, profileName: profile.name })
    .where(eq(sessions.id, created.id));
  return created.id;
}

async function historyRows() {
  const response = await get('/sessions/history');
  return response.json<HistorySessionResponse>().data;
}

async function detail(sessionId: string) {
  const response = await get(`/sessions/${sessionId}`);
  return response.json<{
    profileId: string | null;
    profileName: string | null;
    profileRemoved: boolean;
  }>();
}

describe('the profile shown on a play', () => {
  it('shows a renamed profile by its new name on every past play, in History and detail', async () => {
    const { serverId, account } = await seedAccount();
    const robin = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const playId = await play(serverId, account.id, robin);

    await resolveProfiles(
      serverId,
      [{ externalId: ROBIN, serverUserId: account.id, name: 'Robbie' }],
      'refresh'
    );

    const shown = { profileId: robin.id, profileName: 'Robbie', profileRemoved: false };
    expect(await historyRows()).toEqual([expect.objectContaining(shown)]);
    expect(await detail(playId)).toMatchObject(shown);
  });

  it('shows a profile the server no longer lists by its last name, marked removed', async () => {
    const { serverId, account } = await seedAccount();
    const sam = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Sam',
    });
    const playId = await play(serverId, account.id, sam);

    await syncAccountProfiles(serverId, fakeTofaClient(), [MORGAN_ACCOUNT]);

    const shown = { profileId: sam.id, profileName: 'Sam', profileRemoved: true };
    expect(await historyRows()).toEqual([expect.objectContaining(shown)]);
    expect(await detail(playId)).toMatchObject(shown);
  });

  it('shows the name a play stored when it has no profile row', async () => {
    const { serverId, account } = await seedAccount();
    const playId = await play(serverId, account.id, { id: null, name: 'Kids' });

    const shown = { profileId: null, profileName: 'Kids', profileRemoved: false };
    expect(await historyRows()).toEqual([expect.objectContaining(shown)]);
    expect(await detail(playId)).toMatchObject(shown);
  });
});

describe('the profile filter', () => {
  it("keeps History and the map to one profile's plays", async () => {
    const { serverId, account } = await seedAccount();
    const robin = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const morgan = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Morgan',
    });
    const other = await createTestServerUser({ userId: (await createTestUser()).id, serverId });
    const robinPlays = [
      await play(serverId, account.id, robin),
      await play(serverId, account.id, robin),
    ];
    await play(serverId, account.id, morgan);
    await play(serverId, other.id, { id: null, name: 'Robin' });

    const history = await get(`/sessions/history?profileIds=${robin.id}`);
    const map = await get(`/stats/locations?period=all&profileIds=${robin.id}`);

    const rows = history.json<HistorySessionResponse>().data;
    expect(rows.map((row) => row.id).toSorted()).toEqual(robinPlays.toSorted());
    expect(map.json<{ summary: { totalStreams: number } }>().summary.totalStreams).toBe(2);
  });

  it("offers the selected servers' profiles, removed ones included", async () => {
    const { serverId, account } = await seedAccount();
    const elsewhere = await seedAccount();
    const robin = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const sam = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Sam',
      removedAt: new Date('2026-11-01T00:00:00Z'),
    });
    await storeProfile({
      serverId: elsewhere.serverId,
      serverUserId: elsewhere.account.id,
      externalId: randomUUID(),
      name: 'Casey',
    });

    const response = await get(`/sessions/filter-options?serverIds=${serverId}`);

    expect(response.json<HistoryFilterOptions>().profiles).toEqual([
      { id: robin.id, name: 'Robin', serverUserId: account.id, removed: false },
      { id: sam.id, name: 'Sam', serverUserId: account.id, removed: true },
    ]);
  });
});

describe("the user page's profile split", () => {
  it("splits an account's plays and watch time by profile, adding up to its totals", async () => {
    const { serverId, account } = await seedAccount();
    const robin = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const morgan = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Morgan',
    });
    await play(serverId, account.id, robin, { durationMs: 600_000 });
    await play(serverId, account.id, robin, { durationMs: 300_000 });
    await play(serverId, account.id, morgan, { durationMs: 1_200_000 });

    const stats = await queryIdentityRangeStats({
      serverUserIds: [account.id],
      resolvedServerIds: undefined,
      window: resolveIdentityWindow({ period: 'week' }),
    });

    expect(stats.profiles).toEqual([
      { profileId: robin.id, name: 'Robin', removed: false, plays: 2, watchMs: 900_000 },
      { profileId: morgan.id, name: 'Morgan', removed: false, plays: 1, watchMs: 1_200_000 },
    ]);
    expect(stats.profiles.reduce((sum, profile) => sum + profile.plays, 0)).toBe(stats.plays);
    expect(stats.profiles.reduce((sum, profile) => sum + profile.watchMs, 0)).toBe(stats.watchMs);
  });

  it('credits each profile of a chain recorded before profiles split chains with its own segment', async () => {
    const { serverId, account } = await seedAccount();
    const robin = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const morgan = await storeProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Morgan',
    });
    const first = await play(serverId, account.id, robin, { durationMs: 400_000 });
    await play(serverId, account.id, morgan, { durationMs: 200_000, referenceId: first });

    const stats = await queryIdentityRangeStats({
      serverUserIds: [account.id],
      resolvedServerIds: undefined,
      window: resolveIdentityWindow({ period: 'week' }),
    });

    expect(stats).toMatchObject({ plays: 1, watchMs: 600_000 });
    expect(stats.profiles).toEqual([
      { profileId: morgan.id, name: 'Morgan', removed: false, plays: 1, watchMs: 200_000 },
      { profileId: robin.id, name: 'Robin', removed: false, plays: 1, watchMs: 400_000 },
    ]);
  });
});
