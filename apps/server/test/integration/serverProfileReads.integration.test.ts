/**
 * Reading server_profiles against the real database: the name and removed flag History and
 * session detail show for a play, the profile filter on History, the filter's options, the
 * user page's per-profile split, the profile on public API v2 history rows, and the profile on
 * download rows.
 *
 * Run with: pnpm --filter @tracearr/server test:integration serverProfileReads
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  HistoryFilterOptions,
  HistorySessionResponse,
  NonMainProfile,
  Session,
} from '@tracearr/shared';
import {
  createStoppedSession,
  createTestServer,
  createTestServerProfile,
  createTestServerUser,
  createTestUser,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { mediaDownloads } from '../../src/db/schema.js';
import { invalidateServersCache } from '../../src/jobs/poller/database.js';
import { runHistoryPage } from '../../src/routes/publicV2/shared.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { listDownloadRows } from '../../src/services/downloads/queries.js';
import { resolveProfiles, syncAccountProfiles } from '../../src/services/profiles.js';
import {
  queryIdentityRangeStats,
  resolveIdentityWindow,
} from '../../src/services/stats/peopleStats.js';
import { createOwnerPayload, createTestApp, generateTestToken } from '../../src/test/helpers.js';
import { fakeTofaClient } from '../../src/test/mediaServerFakes.js';

const MORGAN_ACCOUNT = 'b1e4c7a2-5d38-4f91-8a6c-2e7f0d3b9c14';
const ROBIN = 'd2f8a4c6-3b1e-4a97-8c5d-7e0b2f9a6c13';
const KIDS: NonMainProfile = { name: 'Kids', thumbUrl: null, removed: false };

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** GET as the owner, through the session routes */
async function get(url: string) {
  if (!app) {
    app = await createTestApp();
    await app.register(sessionRoutes, { prefix: '/sessions' });
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
  return { serverId: server.id, serverName: server.name, account };
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
    profileId: profile.id,
    profileName: profile.name,
  });
  return created.id;
}

async function historyRows() {
  const response = await get('/sessions/history');
  return response.json<HistorySessionResponse>().data;
}

async function detail(sessionId: string) {
  const response = await get(`/sessions/${sessionId}`);
  return response.json<Pick<Session, 'profileId' | 'profileName' | 'nonMainProfile'>>();
}

describe('the profile shown on a play', () => {
  it('shows a renamed profile by its new name on every past play, in History and detail', async () => {
    const { serverId, account } = await seedAccount();
    const robin = await createTestServerProfile({
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

    const shown = { profileId: robin.id, profileName: 'Robbie' };
    expect(await historyRows()).toEqual([expect.objectContaining(shown)]);
    expect(await detail(playId)).toMatchObject(shown);
  });

  it('shows a profile the server no longer lists by its last name, marked removed', async () => {
    const { serverId, account } = await seedAccount();
    const sam = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Sam',
      isPrimary: false,
    });
    const playId = await play(serverId, account.id, sam);

    await syncAccountProfiles(serverId, fakeTofaClient(), [MORGAN_ACCOUNT]);

    const shown = {
      profileId: sam.id,
      profileName: 'Sam',
      nonMainProfile: { name: 'Sam', thumbUrl: null, removed: true },
    };
    expect(await historyRows()).toEqual([expect.objectContaining(shown)]);
    expect(await detail(playId)).toMatchObject(shown);
  });

  it('shows the name a play stored when it has no profile row', async () => {
    const { serverId, account } = await seedAccount();
    const playId = await play(serverId, account.id, { id: null, name: 'Kids' });

    const shown = { profileId: null, profileName: 'Kids' };
    expect(await historyRows()).toEqual([expect.objectContaining(shown)]);
    expect(await detail(playId)).toMatchObject(shown);
  });

  it('shows a non-main profile with its picture, and leaves a main one, said or not, to the account', async () => {
    const { serverId, account } = await seedAccount();
    const profile = (name: string, isPrimary: boolean | null, thumbUrl: string | null = null) =>
      createTestServerProfile({
        serverId,
        serverUserId: account.id,
        externalId: randomUUID(),
        name,
        isPrimary,
        thumbUrl,
      });
    const thumbUrl = '/api/v1/profiles/avatars/kaiju.png';
    const morganPlay = await play(serverId, account.id, await profile('Morgan', true));
    const unsaidPlay = await play(serverId, account.id, await profile('Casey', null));
    const robinPlay = await play(serverId, account.id, await profile('Robin', false, thumbUrl));

    const rows = await historyRows();

    expect(new Map(rows.map((row) => [row.id, row.nonMainProfile]))).toEqual(
      new Map([
        [morganPlay, undefined],
        [unsaidPlay, undefined],
        [robinPlay, { name: 'Robin', thumbUrl, removed: false }],
      ])
    );
    expect(await detail(robinPlay)).toMatchObject({
      nonMainProfile: { name: 'Robin', thumbUrl, removed: false },
    });
  });

  it('leaves a non-main profile with a blank name to the account', async () => {
    const { serverId, account } = await seedAccount();
    const blank = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: '  ',
      isPrimary: false,
    });
    const playId = await play(serverId, account.id, blank);

    expect(await detail(playId)).not.toHaveProperty('nonMainProfile');
  });
});

describe('the profile filter', () => {
  it("keeps History to one profile's plays", async () => {
    const { serverId, account } = await seedAccount();
    const robin = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const morgan = await createTestServerProfile({
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

    const rows = history.json<HistorySessionResponse>().data;
    expect(rows.map((row) => row.id).toSorted()).toEqual(robinPlays.toSorted());
  });

  it("offers the selected servers' profiles, removed ones included, named by their account and marked main", async () => {
    const { serverId, serverName, account } = await seedAccount();
    const elsewhere = await seedAccount();
    const robin = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const sam = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Sam',
      isPrimary: false,
      removedAt: new Date('2026-11-01T00:00:00Z'),
    });
    await createTestServerProfile({
      serverId: elsewhere.serverId,
      serverUserId: elsewhere.account.id,
      externalId: randomUUID(),
      name: 'Casey',
    });

    const response = await get(`/sessions/filter-options?serverIds=${serverId}`);

    expect(response.json<HistoryFilterOptions>().profiles).toEqual([
      {
        id: robin.id,
        name: 'Robin',
        serverUserId: account.id,
        accountUsername: account.username,
        serverName,
        main: true,
        removed: false,
      },
      {
        id: sam.id,
        name: 'Sam',
        serverUserId: account.id,
        accountUsername: account.username,
        serverName,
        main: false,
        removed: true,
      },
    ]);
  });
});

describe("the user page's profile split", () => {
  it("splits an account's plays and watch time by profile, adding up to its totals", async () => {
    const { serverId, account } = await seedAccount();
    const robin = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const morgan = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Morgan',
      isPrimary: false,
    });
    await play(serverId, account.id, robin, { durationMs: 600_000 });
    await play(serverId, account.id, robin, { durationMs: 300_000 });
    await play(serverId, account.id, morgan, { durationMs: 1_200_000 });

    const stats = await queryIdentityRangeStats({
      serverUserIds: [account.id],
      hasProfiles: true,
      resolvedServerIds: undefined,
      window: resolveIdentityWindow({ period: 'week' }),
    });

    const shown = { removed: false, accountUsername: account.username };
    expect(stats.profiles).toEqual([
      { ...shown, profileId: robin.id, name: 'Robin', main: true, plays: 2, watchMs: 900_000 },
      { ...shown, profileId: morgan.id, name: 'Morgan', main: false, plays: 1, watchMs: 1_200_000 },
    ]);
    expect(stats.profiles.reduce((sum, profile) => sum + profile.plays, 0)).toBe(stats.plays);
    expect(stats.profiles.reduce((sum, profile) => sum + profile.watchMs, 0)).toBe(stats.watchMs);
  });

  it('credits each profile of a chain recorded before profiles split chains with its own segment', async () => {
    const { serverId, account } = await seedAccount();
    const robin = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: ROBIN,
      name: 'Robin',
    });
    const morgan = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Morgan',
    });
    const first = await play(serverId, account.id, robin, { durationMs: 400_000 });
    await play(serverId, account.id, morgan, { durationMs: 200_000, referenceId: first });

    const stats = await queryIdentityRangeStats({
      serverUserIds: [account.id],
      hasProfiles: true,
      resolvedServerIds: undefined,
      window: resolveIdentityWindow({ period: 'week' }),
    });

    expect(stats).toMatchObject({ plays: 1, watchMs: 600_000 });
    expect(stats.profiles).toEqual([
      expect.objectContaining({ profileId: morgan.id, plays: 1, watchMs: 200_000 }),
      expect.objectContaining({ profileId: robin.id, plays: 1, watchMs: 400_000 }),
    ]);
  });
});

describe('profiles in the public API', () => {
  it('names a non-main profile on a v2 history row and leaves a Plex play null', async () => {
    const { serverId, account } = await seedAccount();
    const kids = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Kids',
      isPrimary: false,
    });
    const kidsPlay = await play(serverId, account.id, kids);
    const plex = await createTestServer({ type: 'plex' });
    const plexAccount = await createTestServerUser({
      userId: (await createTestUser()).id,
      serverId: plex.id,
    });
    const { id: plexPlay } = await createStoppedSession({
      serverId: plex.id,
      serverUserId: plexAccount.id,
      durationMs: 600_000,
    });
    invalidateServersCache();

    const { data } = await runHistoryPage([], 10, null, undefined);

    expect(new Map(data.map((row) => [row.id, row.profile]))).toEqual(
      new Map([
        [kidsPlay, { name: 'Kids', thumb_url: null, removed: false }],
        [plexPlay, null],
      ])
    );
  });
});

describe('profiles on downloads', () => {
  it('names a non-main profile on a download row', async () => {
    const { serverId, account } = await seedAccount();
    const kids = await createTestServerProfile({
      serverId,
      serverUserId: account.id,
      externalId: randomUUID(),
      name: 'Kids',
      isPrimary: false,
    });
    const seenAt = new Date();
    await db.insert(mediaDownloads).values({
      serverId,
      serverUserId: account.id,
      profileId: kids.id,
      title: 'Bluey',
      source: 'tofa',
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    });

    const [row] = await listDownloadRows(undefined, 10);

    expect(row).toMatchObject({ title: 'Bluey', nonMainProfile: KIDS });
    expect(row).not.toHaveProperty('profileId');
  });
});
