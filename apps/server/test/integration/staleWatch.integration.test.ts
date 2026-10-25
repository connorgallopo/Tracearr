/**
 * Library stale watch state against a real database: plays come from raw sessions by
 * rating key, so an unlinked imported play still marks its title watched, a resume chain
 * counts once, and a play under the counted threshold does not count.
 *
 * Run with: pnpm --filter @tracearr/server test:integration staleWatch
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import type { AuthUser } from '@tracearr/shared';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { permissionGuard } from '../../src/lib/scope.js';
import { libraryStaleRoute } from '../../src/routes/library/stale.js';

const DAY_MS = 86_400_000;
const THIRTY_MIN = 1_800_000;
const LIB_X = crypto.randomUUID();
const LIB_Y = crypto.randomUUID();

interface StaleRow {
  id: string;
  serverName: string;
  libraryName: string;
  category: string;
  watchCount: number;
  lastWatched: string | null;
}

let app: FastifyInstance | undefined;

async function buildApp(authUser: AuthUser): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  instance.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  instance.decorate('requirePermission', permissionGuard(instance));
  instance.decorate('redis', getRedis() as never);
  await instance.register(libraryStaleRoute, { prefix: '/library' });
  return instance;
}

describe('/library/stale watch state', () => {
  beforeEach(async () => {
    await getRedis().flushdb();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('counts unlinked plays and resume chains once, and skips short plays', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });

    const movie = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-movie',
      fileSize: 4_000_000_000,
    });
    const show = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-show',
      mediaType: 'show',
      withoutVersion: true,
    });
    for (const [ratingKey, itemIndex, fileSize] of [
      ['sw-e1', 1, 500_000_000],
      ['sw-e2', 2, 600_000_000],
    ] as const) {
      await createTestLibraryItem({
        serverId: server.id,
        ratingKey,
        mediaType: 'episode',
        grandparentRatingKey: 'sw-show',
        itemIndex,
        fileSize,
      });
    }
    const unwatched = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-unwatched',
      fileSize: 1_000_000_000,
    });

    const movieStart = new Date(Date.now() - 20 * DAY_MS);
    const movieStop = new Date(movieStart.getTime() + 2 * THIRTY_MIN);
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'sw-movie',
      mediaId: null,
      state: 'stopped',
      startedAt: movieStart,
      stoppedAt: movieStop,
      durationMs: 2 * THIRTY_MIN,
    });

    const chainStart = new Date(Date.now() - 10 * DAY_MS);
    const first = await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'sw-e1',
      mediaType: 'episode',
      state: 'stopped',
      startedAt: chainStart,
      stoppedAt: new Date(chainStart.getTime() + THIRTY_MIN),
      durationMs: THIRTY_MIN,
    });
    const resumeStop = new Date(chainStart.getTime() + 2 * THIRTY_MIN + 600_000);
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'sw-e1',
      mediaType: 'episode',
      state: 'stopped',
      startedAt: new Date(chainStart.getTime() + THIRTY_MIN + 600_000),
      stoppedAt: resumeStop,
      durationMs: THIRTY_MIN,
      referenceId: first.id,
    });
    const shortStart = new Date(Date.now() - 5 * DAY_MS);
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'sw-e2',
      mediaType: 'episode',
      state: 'stopped',
      startedAt: shortStart,
      stoppedAt: new Date(shortStart.getTime() + 60_000),
      durationMs: 60_000,
    });

    app = await buildApp({
      userId: crypto.randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [server.id],
    });
    const res = await app.inject({
      method: 'GET',
      url: `/library/stale?serverId=${server.id}&staleDays=1`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rows = new Map<string, StaleRow>(body.items.map((i: StaleRow) => [i.id, i]));

    const movieRow = rows.get(movie.id);
    expect(movieRow?.category).toBe('stale');
    expect(movieRow?.watchCount).toBe(1);
    expect(new Date(movieRow?.lastWatched ?? '').getTime()).toBe(movieStop.getTime());

    const showRow = rows.get(show.id);
    expect(showRow?.category).toBe('stale');
    expect(showRow?.watchCount).toBe(1);
    expect(new Date(showRow?.lastWatched ?? '').getTime()).toBe(resumeStop.getTime());

    const unwatchedRow = rows.get(unwatched.id);
    expect(unwatchedRow?.category).toBe('never_watched');
    expect(unwatchedRow?.watchCount).toBe(0);
    expect(unwatchedRow?.lastWatched).toBeNull();

    const expectedSummary = {
      neverWatched: { count: 1, sizeBytes: 1_000_000_000 },
      stale: { count: 2, sizeBytes: 5_100_000_000 },
      total: { count: 3, sizeBytes: 6_100_000_000 },
      threshold: { days: 1 },
    };
    expect(body.summary).toEqual(expectedSummary);

    // Past the last page the summary comes from the standalone summary query
    const emptyPage = await app.inject({
      method: 'GET',
      url: `/library/stale?serverId=${server.id}&staleDays=1&page=2&pageSize=25`,
    });
    expect(emptyPage.statusCode).toBe(200);
    const emptyBody = JSON.parse(emptyPage.body);
    expect(emptyBody.items).toEqual([]);
    expect(emptyBody.summary).toEqual(expectedSummary);
  });

  it('shows the library name, not the server name', async () => {
    const server = await createTestServer({ type: 'plex', name: 'Basement Plex' });
    await db.execute(sql`
      INSERT INTO libraries (server_id, library_id, name, media_type)
      VALUES (${server.id}, 'lib-1', 'Films', 'movie')
    `);
    const movie = await createTestLibraryItem({ serverId: server.id, ratingKey: 'sw-named' });

    const rows = await fetchStale(server.id);
    expect(rows.get(movie.id)?.libraryName).toBe('Films');
    expect(rows.get(movie.id)?.serverName).toBe('Basement Plex');
  });

  it('counts plays on a merged title for the winner', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });

    const winnerMedia = await insertMedia('show', 'Merged Show');
    const loserMedia = await insertMedia('show', 'Merged Show (dup)');
    await db.execute(
      sql`UPDATE media SET merged_into_id = ${winnerMedia} WHERE id = ${loserMedia}`
    );

    const winner = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-winner',
      mediaType: 'show',
      mediaId: winnerMedia,
      createdAt: new Date(Date.now() - 60 * DAY_MS),
      withoutVersion: true,
    });
    const loser = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-loser',
      mediaType: 'show',
      mediaId: loserMedia,
      withoutVersion: true,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-loser-e1',
      mediaType: 'episode',
      grandparentRatingKey: 'sw-loser',
      itemIndex: 1,
    });
    const start = new Date(Date.now() - 10 * DAY_MS);
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'sw-loser-e1',
      mediaType: 'episode',
      state: 'stopped',
      startedAt: start,
      stoppedAt: new Date(start.getTime() + THIRTY_MIN),
      durationMs: THIRTY_MIN,
    });

    const rows = await fetchStale(server.id);
    expect(rows.get(winner.id)?.watchCount).toBe(1);
    expect(rows.get(winner.id)?.category).toBe('stale');
    expect(rows.has(loser.id)).toBe(false);
  });

  it("counts plays under a re-added title's old rating key", async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });

    const movieMedia = await insertMedia('movie', 'Re-added Movie');
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-old',
      mediaId: movieMedia,
      removedAt: new Date(Date.now() - 30 * DAY_MS),
      removedSource: 'scan',
    });
    const current = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-new',
      mediaId: movieMedia,
    });
    const start = new Date(Date.now() - 40 * DAY_MS);
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'sw-old',
      mediaId: movieMedia,
      state: 'stopped',
      startedAt: start,
      stoppedAt: new Date(start.getTime() + 2 * THIRTY_MIN),
      durationMs: 2 * THIRTY_MIN,
    });

    const rows = await fetchStale(server.id);
    expect(rows.get(current.id)?.watchCount).toBe(1);
    expect(rows.get(current.id)?.category).toBe('stale');
  });

  it("counts a removed copy's plays for the live copy of a moved title", async () => {
    const { server, account } = await seedAccount();
    const media = await insertMedia('movie', 'Moved Movie');
    await createTestLibraryItem({
      serverId: server.id,
      libraryId: LIB_Y,
      ratingKey: 'sw-moved-old',
      mediaId: media,
      removedAt: new Date(Date.now() - 30 * DAY_MS),
      removedSource: 'scan',
    });
    const live = await createTestLibraryItem({
      serverId: server.id,
      libraryId: LIB_X,
      ratingKey: 'sw-moved-new',
      mediaId: media,
    });
    const stoppedAt = await playOnce(server.id, account.id, 'sw-moved-old', 40);

    const rows = await fetchStale(server.id, LIB_X);
    expect(rows.get(live.id)?.category).toBe('stale');
    expect(rows.get(live.id)?.watchCount).toBe(1);
    expect(new Date(rows.get(live.id)?.lastWatched ?? '').getTime()).toBe(stoppedAt.getTime());
  });

  it('does not count plays on a live copy of the title in another library', async () => {
    const { server, account } = await seedAccount();
    const media = await insertMedia('movie', 'Two Copies');
    const copyX = await createTestLibraryItem({
      serverId: server.id,
      libraryId: LIB_X,
      ratingKey: 'sw-copy-x',
      mediaId: media,
    });
    await createTestLibraryItem({
      serverId: server.id,
      libraryId: LIB_Y,
      ratingKey: 'sw-copy-y',
      mediaId: media,
    });
    await playOnce(server.id, account.id, 'sw-copy-y', 5);

    const rows = await fetchStale(server.id, LIB_X);
    expect(rows.get(copyX.id)?.category).toBe('never_watched');
    expect(rows.get(copyX.id)?.watchCount).toBe(0);
    expect(rows.get(copyX.id)?.lastWatched).toBeNull();
  });

  it("counts plays on a re-added show's old episodes", async () => {
    const { server, account } = await seedAccount();
    const media = await insertMedia('show', 'Re-added Show');
    const removedAt = new Date(Date.now() - 30 * DAY_MS);
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-show-old',
      mediaType: 'show',
      mediaId: media,
      removedAt,
      removedSource: 'scan',
      withoutVersion: true,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-show-old-e1',
      mediaType: 'episode',
      grandparentRatingKey: 'sw-show-old',
      itemIndex: 1,
      removedAt,
      removedSource: 'scan',
    });
    const current = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-show-new',
      mediaType: 'show',
      mediaId: media,
      withoutVersion: true,
    });
    await playOnce(server.id, account.id, 'sw-show-old-e1', 40);

    const rows = await fetchStale(server.id);
    expect(rows.get(current.id)?.category).toBe('stale');
    expect(rows.get(current.id)?.watchCount).toBe(1);
  });

  it('folds plays on a removed copy of a merged title into the winner', async () => {
    const { server, account } = await seedAccount();
    const winnerMedia = await insertMedia('movie', 'Merge Winner');
    const loserMedia = await insertMedia('movie', 'Merge Loser');
    await db.execute(
      sql`UPDATE media SET merged_into_id = ${winnerMedia} WHERE id = ${loserMedia}`
    );
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-merge-removed',
      mediaId: loserMedia,
      removedAt: new Date(Date.now() - 30 * DAY_MS),
      removedSource: 'scan',
    });
    const winner = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'sw-merge-winner',
      mediaId: winnerMedia,
    });
    await playOnce(server.id, account.id, 'sw-merge-removed', 40);

    const rows = await fetchStale(server.id);
    expect(rows.get(winner.id)?.category).toBe('stale');
    expect(rows.get(winner.id)?.watchCount).toBe(1);
  });
});

async function seedAccount() {
  const server = await createTestServer({ type: 'plex' });
  const user = await createTestUser();
  const account = await createTestServerUser({ serverId: server.id, userId: user.id });
  return { server, account };
}

async function playOnce(
  serverId: string,
  serverUserId: string,
  ratingKey: string,
  daysAgo: number
): Promise<Date> {
  const startedAt = new Date(Date.now() - daysAgo * DAY_MS);
  const stoppedAt = new Date(startedAt.getTime() + 2 * THIRTY_MIN);
  await createTestSession({
    serverId,
    serverUserId,
    ratingKey,
    state: 'stopped',
    startedAt,
    stoppedAt,
    durationMs: 2 * THIRTY_MIN,
  });
  return stoppedAt;
}

async function insertMedia(mediaType: 'movie' | 'show', title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO media (id, media_type, match_key, title, sort_title)
    VALUES (${id}, ${mediaType}, ${`${mediaType}:title:${id}`}, ${title}, ${title.toLowerCase()})
  `);
  return id;
}

async function fetchStale(serverId: string, libraryId?: string): Promise<Map<string, StaleRow>> {
  app = await buildApp({
    userId: crypto.randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [serverId],
  });
  const res = await app.inject({
    method: 'GET',
    url: `/library/stale?serverId=${serverId}&staleDays=1${libraryId ? `&libraryId=${libraryId}` : ''}`,
  });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  return new Map<string, StaleRow>(body.items.map((i: StaleRow) => [i.id, i]));
}
