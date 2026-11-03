/**
 * Catalog browse endpoint correctness, against a real database.
 *
 * catalog.routes.test.ts mocks db.execute, so it proves handler mechanics but
 * never the SQL itself: keyset pagination across a shared-title boundary,
 * per-sort ordering, merge-aware plays, server/lens scoping, and the
 * watched-filter short-page loop all live in the query and the JS loop that
 * drives it. This suite drives the real route (app.inject) against the
 * per-worker test database and asserts on the actual returned rows.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- catalog
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import type { AuthUser, CatalogResponse, CatalogLettersResponse } from '@tracearr/shared';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { media } from '../../src/db/schema.js';
import { libraryCatalogRoute } from '../../src/routes/library/catalog.js';
import { buildValueRollupCte } from '../../src/routes/library/queries.js';
import {
  resolveMediaForItem,
  mergeMediaRows,
} from '../../src/services/library/mediaResolutionService.js';
import { setSetting } from '../../src/services/settings.js';
import { permissionGuard } from '../../src/lib/scope.js';
import { seedArtistOnTwoServers } from './musicFixtures.js';

async function buildApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('redis', createMockRedis() as unknown as Redis);
  await app.register(libraryCatalogRoute, { prefix: '/library' });
  return app;
}

function ownerFor(serverIds: string[] = []): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds };
}

function viewerFor(serverIds: string[]): AuthUser {
  return { userId: randomUUID(), username: 'viewer', role: 'admin', serverIds };
}

async function refreshPlaysAggregate(): Promise<void> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
}

interface SeedMovieOptions {
  serverId: string;
  ratingKey: string;
  title: string;
  year: number;
  tmdbId: number;
  addedAt?: Date;
  fileSize?: number | null;
  genre?: string;
  thumbPath?: string | null;
  dominantColor?: string | null;
  libraryId?: string;
  videoDynamicRange?: string | null;
  videoResolution?: string | null;
}

/** Resolves a canonical movie row, gives it one library copy, and stamps the
 * browse-relevant columns (latest_added_at, genres, file_size) that no
 * factory or sync path sets for a bare test seed. A distinct ratingKey with
 * the same tmdbId (same or different serverId) adds another copy of the same
 * canonical media instead of a new one. fileSize defaults to 0 when omitted;
 * pass null explicitly to leave the column NULL. */
async function seedMovie(opts: SeedMovieOptions): Promise<string> {
  const mediaId = await resolveMediaForItem({
    mediaType: 'movie',
    tmdbId: opts.tmdbId,
    title: opts.title,
    year: opts.year,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
  });
  const genres = opts.genre ? [opts.genre] : null;
  const item = await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'movie',
    year: opts.year,
    mediaId,
    genres,
    libraryId: opts.libraryId,
  });
  const addedAt = opts.addedAt ?? new Date();
  const fileSize = opts.fileSize === undefined ? 0 : opts.fileSize;
  await db.execute(sql`
    UPDATE library_items SET created_at = ${addedAt.toISOString()}::timestamptz,
      file_size = ${fileSize},
      thumb_path = ${opts.thumbPath ?? null},
      dominant_color = ${opts.dominantColor ?? null},
      video_dynamic_range = ${opts.videoDynamicRange ?? null},
      video_resolution = ${opts.videoResolution ?? null}
    WHERE id = ${item.id}
  `);
  // Keep the factory's version row in step: version-grain queries (facets,
  // size dedupe) read library_item_versions, not the flat columns
  await db.execute(sql`
    UPDATE library_item_versions SET
      file_size = ${fileSize},
      video_dynamic_range = ${opts.videoDynamicRange ?? null},
      video_resolution = ${opts.videoResolution ?? null}
    WHERE library_item_id = ${item.id}
  `);
  await db.update(media).set({ latestAddedAt: addedAt, genres }).where(eq(media.id, mediaId));
  return mediaId;
}

interface SeedShowOptions {
  serverId: string;
  ratingKey: string;
  title: string;
  year: number;
  tvdbId: number;
  addedAt?: Date;
  fileSize?: number | null;
}

/** Resolves a canonical show row and gives it one library copy (the show
 * container item itself, not an episode). fileSize defaults to 0 when
 * omitted; pass null explicitly to leave the column NULL. */
async function seedShow(opts: SeedShowOptions): Promise<string> {
  const showId = await resolveMediaForItem({
    mediaType: 'show',
    tvdbId: opts.tvdbId,
    title: opts.title,
    year: opts.year,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
  });
  const item = await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'show',
    year: opts.year,
    mediaId: showId,
  });
  const addedAt = opts.addedAt ?? new Date();
  const fileSize = opts.fileSize === undefined ? 0 : opts.fileSize;
  await db.execute(sql`
    UPDATE library_items SET created_at = ${addedAt.toISOString()}::timestamptz,
      file_size = ${fileSize}
    WHERE id = ${item.id}
  `);
  await db.update(media).set({ latestAddedAt: addedAt }).where(eq(media.id, showId));
  return showId;
}

interface SeedEpisodeOptions {
  serverId: string;
  ratingKey: string;
  title: string;
  year: number;
  tvdbId: number;
  showMediaId: string;
  fileSize?: number | null;
}

/** A distinct ratingKey with the same tvdbId (same or different serverId)
 * adds another copy of the same canonical episode instead of a new one.
 * fileSize defaults to 0 when omitted; pass null explicitly to leave the
 * column NULL. */
async function seedEpisode(opts: SeedEpisodeOptions): Promise<string> {
  const episodeId = await resolveMediaForItem({
    mediaType: 'episode',
    tvdbId: opts.tvdbId,
    title: opts.title,
    year: opts.year,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    showMediaId: opts.showMediaId,
  });
  const item = await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'episode',
    mediaId: episodeId,
  });
  const fileSize = opts.fileSize === undefined ? 0 : opts.fileSize;
  await db.execute(sql`
    UPDATE library_items SET file_size = ${fileSize} WHERE id = ${item.id}
  `);
  await db.execute(sql`
    UPDATE library_item_versions v SET
      file_size = li.file_size,
      video_resolution = li.video_resolution,
      video_dynamic_range = li.video_dynamic_range
    FROM library_items li
    WHERE li.id = v.library_item_id AND li.id = ${item.id}
  `);
  return episodeId;
}

interface SeedSessionOptions {
  serverId: string;
  serverUserId: string;
  mediaId: string;
  ratingKey: string;
  durationMs: number;
  startedAt?: Date;
}

/** A session that counts as a play in user_media_plays_daily when durationMs >= 2 minutes. */
async function seedSession(opts: SeedSessionOptions): Promise<void> {
  const startedAt = opts.startedAt ?? new Date();
  await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    mediaId: opts.mediaId,
    ratingKey: opts.ratingKey,
    mediaType: 'movie',
    state: 'stopped',
    referenceId: null,
    durationMs: opts.durationMs,
    totalDurationMs: Math.max(opts.durationMs, 7_200_000),
    progressMs: opts.durationMs,
    watched: opts.durationMs >= 120_000,
    startedAt,
    stoppedAt: startedAt,
  });
}

async function fetchCatalog(
  app: FastifyInstance,
  query: string
): Promise<{ statusCode: number; body: CatalogResponse }> {
  const res = await app.inject({ method: 'GET', url: `/library/catalog?${query}` });
  return { statusCode: res.statusCode, body: res.json<CatalogResponse>() };
}

async function fetchLetters(
  app: FastifyInstance,
  query: string
): Promise<{ statusCode: number; body: CatalogLettersResponse }> {
  const res = await app.inject({ method: 'GET', url: `/library/catalog/letters?${query}` });
  return { statusCode: res.statusCode, body: res.json<CatalogLettersResponse>() };
}

describe('catalog browse endpoint against a real database', () => {
  it('tiles offset windows across a shared-title boundary without a duplicate or a skipped row', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());

    const expectedIds = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const id = await seedMovie({
        serverId: server.id,
        ratingKey: `dup-${i}`,
        title: 'Same Title',
        year: 2020,
        tmdbId: 900_000 + i,
      });
      expectedIds.add(id);
    }

    // Seven rows share one sort_title, so every window boundary falls inside
    // the tie - only the stable (sort_title, id) ordering keeps consecutive
    // windows from repeating or dropping a row.
    const seenIds: string[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < total; offset += 3) {
      const { statusCode, body } = await fetchCatalog(
        app,
        `type=movie&sort=title&pageSize=3&offset=${offset}`
      );
      expect(statusCode).toBe(200);
      total = body.meta.totalItems;
      seenIds.push(...body.data.map((row) => row.mediaId));
    }

    expect(new Set(seenIds).size).toBe(seenIds.length);
    expect(new Set(seenIds)).toEqual(expectedIds);
  });

  it('orders each sort by its own metric, with unplayed rows tailing the plays sort', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());

    const userA = await createTestUser();
    const userB1 = await createTestUser();
    const userB2 = await createTestUser();
    const userB3 = await createTestUser();
    const userC1 = await createTestUser();
    const userC2 = await createTestUser();
    const suA = await createTestServerUser({ serverId: server.id, userId: userA.id });
    const suB1 = await createTestServerUser({ serverId: server.id, userId: userB1.id });
    const suB2 = await createTestServerUser({ serverId: server.id, userId: userB2.id });
    const suB3 = await createTestServerUser({ serverId: server.id, userId: userB3.id });
    const suC1 = await createTestServerUser({ serverId: server.id, userId: userC1.id });
    const suC2 = await createTestServerUser({ serverId: server.id, userId: userC2.id });

    const alpha = await seedMovie({
      serverId: server.id,
      ratingKey: 'sort-alpha',
      title: 'Alpha Movie',
      year: 2010,
      tmdbId: 910_001,
      addedAt: new Date('2026-06-11T00:00:00Z'),
    });
    const bravo = await seedMovie({
      serverId: server.id,
      ratingKey: 'sort-bravo',
      title: 'Bravo Movie',
      year: 1995,
      tmdbId: 910_002,
      addedAt: new Date('2026-06-21T00:00:00Z'),
    });
    const charlie = await seedMovie({
      serverId: server.id,
      ratingKey: 'sort-charlie',
      title: 'Charlie Movie',
      year: 2020,
      tmdbId: 910_003,
      addedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const delta = await seedMovie({
      serverId: server.id,
      ratingKey: 'sort-delta',
      title: 'Delta Movie',
      year: 2005,
      tmdbId: 910_004,
      addedAt: new Date('2026-06-30T00:00:00Z'),
    });

    // Alpha: 1 play, 1 viewer, 500_000ms watch time.
    await seedSession({
      serverId: server.id,
      serverUserId: suA.id,
      mediaId: alpha,
      ratingKey: 'sort-alpha',
      durationMs: 500_000,
    });
    // Bravo: 2 plays (2 long sessions) + 1 short session, which is not a play and so not a
    // viewer -> 2 viewers, 300_000ms.
    await seedSession({
      serverId: server.id,
      serverUserId: suB1.id,
      mediaId: bravo,
      ratingKey: 'sort-bravo',
      durationMs: 150_000,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: suB2.id,
      mediaId: bravo,
      ratingKey: 'sort-bravo',
      durationMs: 150_000,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: suB3.id,
      mediaId: bravo,
      ratingKey: 'sort-bravo',
      durationMs: 50_000,
    });
    // Charlie: 4 plays across 2 viewers, 800_000ms.
    for (let i = 0; i < 3; i++) {
      await seedSession({
        serverId: server.id,
        serverUserId: suC1.id,
        mediaId: charlie,
        ratingKey: 'sort-charlie',
        durationMs: 200_000,
      });
    }
    await seedSession({
      serverId: server.id,
      serverUserId: suC2.id,
      mediaId: charlie,
      ratingKey: 'sort-charlie',
      durationMs: 200_000,
    });
    // Delta: never watched.

    await refreshPlaysAggregate();

    const { body: titleBody } = await fetchCatalog(app, 'type=movie&sort=title&pageSize=60');
    expect(titleBody.data.map((r) => r.mediaId)).toEqual([alpha, bravo, charlie, delta]);

    const { body: addedBody } = await fetchCatalog(app, 'type=movie&sort=added&pageSize=60');
    expect(addedBody.data.map((r) => r.mediaId)).toEqual([delta, bravo, alpha, charlie]);

    const { body: yearBody } = await fetchCatalog(app, 'type=movie&sort=year&pageSize=60');
    expect(yearBody.data.map((r) => r.mediaId)).toEqual([charlie, alpha, delta, bravo]);

    const { body: playsBody } = await fetchCatalog(app, 'type=movie&sort=plays&pageSize=60');
    expect(playsBody.data.map((r) => r.mediaId)).toEqual([charlie, bravo, alpha, delta]);
    expect(playsBody.data.map((r) => r.plays)).toEqual([4, 2, 1, 0]);
    const tailRow = playsBody.data[playsBody.data.length - 1]!;
    expect(tailRow.mediaId).toBe(delta);
    expect(tailRow.plays).toBe(0);

    const { body: watchTimeBody } = await fetchCatalog(
      app,
      'type=movie&sort=watch_time&pageSize=60'
    );
    expect(watchTimeBody.data.map((r) => r.mediaId)).toEqual([charlie, alpha, bravo, delta]);

    const { body: viewersBody } = await fetchCatalog(app, 'type=movie&sort=viewers&pageSize=60');
    // Bravo and Charlie tie on 2 viewers; the sort breaks ties on media id, descending.
    const tied = [bravo, charlie].sort().reverse();
    expect(viewersBody.data.map((r) => r.mediaId)).toEqual([...tied, alpha, delta]);
    expect(viewersBody.data.map((r) => r.viewers)).toEqual([2, 2, 1, 0]);
  });

  it('folds a merged loser movies plays, viewers and watched state onto the winner row', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const app = await buildApp(ownerFor());

    const winnerId = await seedMovie({
      serverId: server.id,
      ratingKey: 'merge-winner',
      title: 'Merge Winner',
      year: 2015,
      tmdbId: 920_001,
    });
    const loserId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 920_002,
      title: 'Merge Loser',
      year: 2015,
      serverId: server.id,
      ratingKey: 'merge-loser',
    });

    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: loserId,
      ratingKey: 'merge-loser',
      durationMs: 300_000,
    });

    await mergeMediaRows(winnerId, loserId);
    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchCatalog(app, 'type=movie&pageSize=60');
    expect(statusCode).toBe(200);
    const row = body.data.find((r) => r.mediaId === winnerId);
    expect(row).toBeDefined();
    expect(row!.plays).toBe(1);
    expect(row!.viewers).toBe(1);
    expect(row!.watchedState).toBe('watched');
    // The loser must never surface as its own row: it is merged away.
    expect(body.data.find((r) => r.mediaId === loserId)).toBeUndefined();
  });

  it('scopes plays/viewers and the servers list to the requested server, hiding another servers plays', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });
    // Kept in scope purely so the identity has an account within server A's
    // scope (the lens access guard requires it); never queried directly.
    await createTestServerUser({ serverId: serverA.id, userId: person.id });
    const suB = await createTestServerUser({ serverId: serverB.id, userId: person.id });

    const movieId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 930_001,
      title: 'Cross Server Movie',
      year: 2018,
      serverId: serverA.id,
      ratingKey: 'scope-a',
    });
    await createTestLibraryItem({
      serverId: serverA.id,
      ratingKey: 'scope-a',
      title: 'Cross Server Movie',
      mediaType: 'movie',
      mediaId: movieId,
    });
    const movieOnB = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 930_001,
      title: 'Cross Server Movie',
      year: 2018,
      serverId: serverB.id,
      ratingKey: 'scope-b',
    });
    expect(movieOnB).toBe(movieId);
    await createTestLibraryItem({
      serverId: serverB.id,
      ratingKey: 'scope-b',
      title: 'Cross Server Movie',
      mediaType: 'movie',
      mediaId: movieId,
    });

    // The identity's only play happened on server B.
    await seedSession({
      serverId: serverB.id,
      serverUserId: suB.id,
      mediaId: movieId,
      ratingKey: 'scope-b',
      durationMs: 300_000,
    });
    await refreshPlaysAggregate();

    // (b) serverId=A scopes the servers[] list to server A's copy only.
    const owner = ownerFor();
    const appOwner = await buildApp(owner);
    const { statusCode: scopedAStatus, body: scopedA } = await fetchCatalog(
      appOwner,
      `type=movie&serverId=${serverA.id}&pageSize=60`
    );
    expect(scopedAStatus).toBe(200);
    const rowA = scopedA.data.find((r) => r.mediaId === movieId)!;
    expect(rowA.servers).toHaveLength(1);
    expect(rowA.servers[0]!.serverId).toBe(serverA.id);
    // Server B's play is invisible from server A's scope.
    expect(rowA.plays).toBe(0);
    expect(rowA.viewers).toBe(0);
    expect(rowA.watchedState).toBe('unwatched');

    const { statusCode: scopedBStatus, body: scopedB } = await fetchCatalog(
      appOwner,
      `type=movie&serverId=${serverB.id}&pageSize=60`
    );
    expect(scopedBStatus).toBe(200);
    const rowB = scopedB.data.find((r) => r.mediaId === movieId)!;
    expect(rowB.servers).toHaveLength(1);
    expect(rowB.servers[0]!.serverId).toBe(serverB.id);
    expect(rowB.plays).toBe(1);
    expect(rowB.viewers).toBe(1);
    expect(rowB.watchedState).toBe('watched');

    // (a) lens on the identity, scoped to server A: the identity has an
    // account within scope (suA) but their only play is on B, so it must
    // stay invisible; lensing with no scope restores it.
    const viewer = viewerFor([serverA.id, serverB.id]);
    const appViewer = await buildApp(viewer);
    const { statusCode: lensScopedStatus, body: lensScoped } = await fetchCatalog(
      appViewer,
      `type=movie&lens=${person.id}&serverId=${serverA.id}&pageSize=60`
    );
    expect(lensScopedStatus).toBe(200);
    const lensScopedRow = lensScoped.data.find((r) => r.mediaId === movieId)!;
    expect(lensScopedRow.plays).toBe(0);
    expect(lensScopedRow.watchedState).toBe('unwatched');

    const { statusCode: lensAllStatus, body: lensAll } = await fetchCatalog(
      appViewer,
      `type=movie&lens=${person.id}&pageSize=60`
    );
    expect(lensAllStatus).toBe(200);
    const lensAllRow = lensAll.data.find((r) => r.mediaId === movieId)!;
    expect(lensAllRow.plays).toBe(1);
    expect(lensAllRow.watchedState).toBe('watched');
  });

  it('the watched filter yields exact windows over the filtered set, with no drop and no phantom total', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const app = await buildApp(ownerFor());

    // Titles a..f sort in that order; a and b are watched (filtered out by
    // watched=unwatched), c-f survive. totalItems must be the filtered count
    // (4, not 6), and offset addresses positions within the filtered set -
    // the window at offset 3 is exactly the last surviving row.
    const letters = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
    const ids: Record<(typeof letters)[number], string> = {} as never;
    for (const letter of letters) {
      ids[letter] = await seedMovie({
        serverId: server.id,
        ratingKey: `watched-loop-${letter}`,
        title: `Movie ${letter.toUpperCase()}`,
        year: 2000,
        tmdbId: 940_000 + letters.indexOf(letter),
      });
    }
    for (const letter of ['a', 'b'] as const) {
      await seedSession({
        serverId: server.id,
        serverUserId: account.id,
        mediaId: ids[letter],
        ratingKey: `watched-loop-${letter}`,
        durationMs: 300_000,
      });
    }
    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchCatalog(
      app,
      'type=movie&sort=title&watched=unwatched&pageSize=3'
    );
    expect(statusCode).toBe(200);
    expect(body.meta.totalItems).toBe(4);
    expect(body.data.map((row) => row.mediaId)).toEqual([ids.c, ids.d, ids.e]);
    expect(body.data.every((row) => row.watchedState === 'unwatched')).toBe(true);

    const { body: tail } = await fetchCatalog(
      app,
      'type=movie&sort=title&watched=unwatched&pageSize=3&offset=3'
    );
    expect(tail.data.map((row) => row.mediaId)).toEqual([ids.f]);
    expect(tail.meta.totalItems).toBe(4);
  });

  it('scopes a shows known-episode count to the requested servers, resolving to watched within scope', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });
    const accountA = await createTestServerUser({ serverId: serverA.id, userId: person.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 970_001,
      title: 'Cross Scope Show',
      year: 2019,
      serverId: serverA.id,
      ratingKey: 'show-cross-a',
    });
    const showOnB = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 970_001,
      title: 'Cross Scope Show',
      year: 2019,
      serverId: serverB.id,
      ratingKey: 'show-cross-b',
    });
    expect(showOnB).toBe(showId);
    await createTestLibraryItem({
      serverId: serverA.id,
      ratingKey: 'show-cross-a',
      title: 'Cross Scope Show',
      mediaType: 'show',
      year: 2019,
      mediaId: showId,
    });
    await createTestLibraryItem({
      serverId: serverB.id,
      ratingKey: 'show-cross-b',
      title: 'Cross Scope Show',
      mediaType: 'show',
      year: 2019,
      mediaId: showId,
    });

    // Two episodes live on server A, a third only on server B.
    const episodeAIds: string[] = [];
    for (const [i, ratingKey] of ['ep-a-1', 'ep-a-2'].entries()) {
      const episodeId = await resolveMediaForItem({
        mediaType: 'episode',
        tvdbId: 970_011 + i,
        title: `Cross Scope Episode A${i + 1}`,
        year: 2019,
        serverId: serverA.id,
        ratingKey,
        showMediaId: showId,
      });
      await createTestLibraryItem({
        serverId: serverA.id,
        ratingKey,
        title: `Cross Scope Episode A${i + 1}`,
        mediaType: 'episode',
        mediaId: episodeId,
      });
      episodeAIds.push(episodeId);
    }
    const episodeBId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 970_021,
      title: 'Cross Scope Episode B1',
      year: 2019,
      serverId: serverB.id,
      ratingKey: 'ep-b-1',
      showMediaId: showId,
    });
    await createTestLibraryItem({
      serverId: serverB.id,
      ratingKey: 'ep-b-1',
      title: 'Cross Scope Episode B1',
      mediaType: 'episode',
      mediaId: episodeBId,
    });

    // person watches every episode server A has, and never touches server B's.
    for (const [i, episodeId] of episodeAIds.entries()) {
      await createTestSession({
        serverId: serverA.id,
        serverUserId: accountA.id,
        mediaType: 'episode',
        mediaId: episodeId,
        showMediaId: showId,
        ratingKey: `ep-a-${i + 1}`,
        durationMs: 1_800_000,
        totalDurationMs: 1_800_000,
        referenceId: null,
        watched: true,
      });
    }

    await refreshPlaysAggregate();

    // Scoped to server A only: the two episodes available there are both
    // watched, so the show must resolve to watched even though server B
    // holds a third episode this scope can never see.
    const viewer = viewerFor([serverA.id]);
    const appViewer = await buildApp(viewer);
    const { statusCode: scopedStatus, body: scoped } = await fetchCatalog(
      appViewer,
      'type=show&pageSize=60'
    );
    expect(scopedStatus).toBe(200);
    const scopedRow = scoped.data.find((r) => r.mediaId === showId);
    expect(scopedRow).toBeDefined();
    expect(scopedRow!.watchedState).toBe('watched');

    // Owner/all-servers view still sees all 3 episodes, so the same show
    // stays partial there since person never watched server B's episode.
    const appOwner = await buildApp(ownerFor());
    const { statusCode: ownerStatus, body: ownerBody } = await fetchCatalog(
      appOwner,
      'type=show&pageSize=60'
    );
    expect(ownerStatus).toBe(200);
    const ownerRow = ownerBody.data.find((r) => r.mediaId === showId);
    expect(ownerRow).toBeDefined();
    expect(ownerRow!.watchedState).toBe('partial');
  });

  it('excludes a removed episodes plays from the watched count but keeps it partial via has_plays', async () => {
    const server = await createTestServer({ type: 'plex' });
    const person = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ serverId: server.id, userId: person.id });

    const showId = await seedShow({
      serverId: server.id,
      ratingKey: 'show-retention',
      title: 'Rolling Retention Show',
      year: 2020,
      tvdbId: 970_201,
    });
    const activeEpisode1 = await seedEpisode({
      serverId: server.id,
      ratingKey: 'ep-retention-active-1',
      title: 'Active Episode 1',
      year: 2020,
      tvdbId: 970_211,
      showMediaId: showId,
    });
    const activeEpisode2 = await seedEpisode({
      serverId: server.id,
      ratingKey: 'ep-retention-active-2',
      title: 'Active Episode 2',
      year: 2020,
      tvdbId: 970_212,
      showMediaId: showId,
    });
    const removedEpisode = await seedEpisode({
      serverId: server.id,
      ratingKey: 'ep-retention-removed',
      title: 'Removed Episode',
      year: 2020,
      tvdbId: 970_213,
      showMediaId: showId,
    });
    await db.execute(
      sql`UPDATE library_items SET removed_at = now() WHERE media_id = ${removedEpisode}`
    );

    // Only the now-removed episode was ever played.
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaType: 'episode',
      mediaId: removedEpisode,
      showMediaId: showId,
      ratingKey: 'ep-retention-removed',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });
    await refreshPlaysAggregate();

    const app = await buildApp(ownerFor());
    const { statusCode: partialStatus, body: partialBody } = await fetchCatalog(
      app,
      'type=show&pageSize=60'
    );
    expect(partialStatus).toBe(200);
    const partialRow = partialBody.data.find((r) => r.mediaId === showId);
    expect(partialRow).toBeDefined();
    expect(partialRow!.watchedState).toBe('partial');

    // Now watch both still-active episodes; the show should flip to watched.
    for (const [i, episodeId] of [activeEpisode1, activeEpisode2].entries()) {
      await createTestSession({
        serverId: server.id,
        serverUserId: account.id,
        mediaType: 'episode',
        mediaId: episodeId,
        showMediaId: showId,
        ratingKey: `ep-retention-active-${i + 1}`,
        durationMs: 1_800_000,
        totalDurationMs: 1_800_000,
        referenceId: null,
        watched: true,
      });
    }
    await refreshPlaysAggregate();

    const { statusCode: watchedStatus, body: watchedBody } = await fetchCatalog(
      app,
      'type=show&pageSize=60'
    );
    expect(watchedStatus).toBe(200);
    const watchedRow = watchedBody.data.find((r) => r.mediaId === showId);
    expect(watchedRow).toBeDefined();
    expect(watchedRow!.watchedState).toBe('watched');
  });

  it('the serverIds query param narrows to the selected subset and combines across it, never leaking an inaccessible server', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });
    const suA = await createTestServerUser({ serverId: serverA.id, userId: person.id });
    const suB = await createTestServerUser({ serverId: serverB.id, userId: person.id });

    const movieId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 990_001,
      title: 'Selector Scoped Movie',
      year: 2019,
      serverId: serverA.id,
      ratingKey: 'selector-a',
    });
    await createTestLibraryItem({
      serverId: serverA.id,
      ratingKey: 'selector-a',
      title: 'Selector Scoped Movie',
      mediaType: 'movie',
      mediaId: movieId,
    });
    const movieOnB = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 990_001,
      title: 'Selector Scoped Movie',
      year: 2019,
      serverId: serverB.id,
      ratingKey: 'selector-b',
    });
    expect(movieOnB).toBe(movieId);
    await createTestLibraryItem({
      serverId: serverB.id,
      ratingKey: 'selector-b',
      title: 'Selector Scoped Movie',
      mediaType: 'movie',
      mediaId: movieId,
    });

    // The same identity plays this movie once on A and once on B.
    await seedSession({
      serverId: serverA.id,
      serverUserId: suA.id,
      mediaId: movieId,
      ratingKey: 'selector-a',
      durationMs: 300_000,
    });
    await seedSession({
      serverId: serverB.id,
      serverUserId: suB.id,
      mediaId: movieId,
      ratingKey: 'selector-b',
      durationMs: 300_000,
    });
    await refreshPlaysAggregate();

    const owner = ownerFor();
    const appOwner = await buildApp(owner);

    // serverIds=[A] scopes to A alone: only A's play is visible.
    const { statusCode: aStatus, body: aBody } = await fetchCatalog(
      appOwner,
      `type=movie&serverIds=${serverA.id}&pageSize=60`
    );
    expect(aStatus).toBe(200);
    const aRow = aBody.data.find((r) => r.mediaId === movieId)!;
    expect(aRow.plays).toBe(1);
    expect(aRow.servers).toHaveLength(1);
    expect(aRow.servers[0]!.serverId).toBe(serverA.id);

    // serverIds=[A,B] combines the selected subset: both plays are visible.
    const { statusCode: abStatus, body: abBody } = await fetchCatalog(
      appOwner,
      `type=movie&serverIds=${serverA.id}&serverIds=${serverB.id}&pageSize=60`
    );
    expect(abStatus).toBe(200);
    const abRow = abBody.data.find((r) => r.mediaId === movieId)!;
    expect(abRow.plays).toBe(2);
    expect(abRow.servers).toHaveLength(2);

    // No serverIds param at all: full accessible scope, same as today.
    const { statusCode: allStatus, body: allBody } = await fetchCatalog(
      appOwner,
      'type=movie&pageSize=60'
    );
    expect(allStatus).toBe(200);
    const allRow = allBody.data.find((r) => r.mediaId === movieId)!;
    expect(allRow.plays).toBe(2);
    expect(allRow.servers).toHaveLength(2);

    // A non-owner scoped to A alone requesting serverIds=[B] (a server they
    // cannot access) gets it intersected away, not leaked: the result is
    // identical to an empty scope, never server B's data.
    const viewer = viewerFor([serverA.id]);
    const appViewer = await buildApp(viewer);
    const { statusCode: leakStatus, body: leakBody } = await fetchCatalog(
      appViewer,
      `type=movie&serverIds=${serverB.id}&pageSize=60`
    );
    expect(leakStatus).toBe(200);
    const leakRow = leakBody.data.find((r) => r.mediaId === movieId);
    expect(leakRow).toBeUndefined();
  });

  it('totals reflect exactly the seeded set matching the filter predicate', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());

    const actionSizes = [1_000_000, 2_000_000, 3_000_000];
    let expectedTotalSize = 0;
    for (const [i, size] of actionSizes.entries()) {
      await seedMovie({
        serverId: server.id,
        ratingKey: `totals-action-${i}`,
        title: `Action Movie ${i}`,
        year: 2000 + i,
        tmdbId: 950_000 + i,
        fileSize: size,
        genre: 'Action',
      });
      expectedTotalSize += size;
    }
    await seedMovie({
      serverId: server.id,
      ratingKey: 'totals-drama',
      title: 'Drama Movie',
      year: 2010,
      tmdbId: 950_100,
      fileSize: 9_999_999,
      genre: 'Drama',
    });

    const { statusCode, body } = await fetchCatalog(app, 'type=movie&genre=Action&pageSize=60');
    expect(statusCode).toBe(200);
    expect(body.data).toHaveLength(actionSizes.length);
    expect(body.meta.totalItems).toBe(actionSizes.length);
    expect(body.meta.totalFileSize).toBe(expectedTotalSize);
  });

  it('matches a display-cased resolution filter against the lowercase-stored value', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());

    const fourK = await seedMovie({
      serverId: server.id,
      ratingKey: 'res-4k',
      title: '4K Movie',
      year: 2020,
      tmdbId: 951_000,
      videoResolution: '4k',
    });
    await seedMovie({
      serverId: server.id,
      ratingKey: 'res-sd',
      title: 'SD Movie',
      year: 2020,
      tmdbId: 951_001,
      videoResolution: 'sd',
    });

    const { statusCode, body } = await fetchCatalog(app, 'type=movie&resolution=4K&pageSize=60');
    expect(statusCode).toBe(200);
    expect(body.data.map((row) => row.mediaId)).toEqual([fourK]);
    expect(body.meta.totalItems).toBe(1);

    // The letter rail and the page window must agree on the same filter set.
    const { statusCode: lettersStatus, body: lettersBody } = await fetchLetters(
      app,
      'type=movie&resolution=4K'
    );
    expect(lettersStatus).toBe(200);
    expect(lettersBody.letters.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });

  it('a punctuation-only search normalizes to no filter, not a match-nothing LIKE pattern', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());

    const alpha = await seedMovie({
      serverId: server.id,
      ratingKey: 'punct-search-a',
      title: 'Search Alpha',
      year: 2020,
      tmdbId: 952_000,
    });
    const bravo = await seedMovie({
      serverId: server.id,
      ratingKey: 'punct-search-b',
      title: 'Search Bravo',
      year: 2020,
      tmdbId: 952_001,
    });

    const { statusCode, body } = await fetchCatalog(app, 'type=movie&search=...&pageSize=60');
    expect(statusCode).toBe(200);
    expect(new Set(body.data.map((row) => row.mediaId))).toEqual(new Set([alpha, bravo]));
    expect(body.meta.totalItems).toBe(2);
  });

  it('excludes episode plays from the movie value rollup candidate list', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    // An episode with a well-watched play count and no show linkage - the
    // scenario a resolution bug (or any future regression) produces.
    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      title: 'Leaked Episode',
      year: null,
      serverId: server.id,
      ratingKey: 'ep-leak-1',
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: episodeId,
      mediaType: 'episode',
      ratingKey: 'ep-leak-1',
      state: 'stopped',
      referenceId: null,
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      progressMs: 1_800_000,
      watched: true,
    });
    // Three separate plays, so this would rank #1 in a movie "most watched"
    // rollup if it ever leaked in.
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: episodeId,
      mediaType: 'episode',
      ratingKey: 'ep-leak-1',
      state: 'stopped',
      referenceId: null,
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      progressMs: 1_800_000,
      watched: true,
      startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      stoppedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await refreshPlaysAggregate();

    const cte = buildValueRollupCte('movie', undefined, undefined);
    const rows = await db.execute(
      sql`WITH ${cte} SELECT canonical_id::text AS canonical_id, plays FROM value_rollup`
    );
    const canonicalIds = (rows.rows as { canonical_id: string }[]).map((r) => r.canonical_id);
    expect(canonicalIds).not.toContain(episodeId);
  });

  describe('totals dedupe mirrored copies across servers (identical file_size = same physical file)', () => {
    const GB = 1_000_000_000;

    /** Seeds the same seven canonical-media scenarios the shelves suite uses,
     * so both surfaces are proven against the identical mirror/rendition mix. */
    async function seedSizeScenarios(serverA: string, serverB: string): Promise<void> {
      // M1 mirror: identical size on both servers counts once.
      await seedMovie({
        serverId: serverA,
        ratingKey: 'cat-m1-a',
        title: 'Catalog M1 Mirror',
        year: 2001,
        tmdbId: 970_001,
        fileSize: 10 * GB,
      });
      await seedMovie({
        serverId: serverB,
        ratingKey: 'cat-m1-b',
        title: 'Catalog M1 Mirror',
        year: 2001,
        tmdbId: 970_001,
        fileSize: 10 * GB,
      });

      // M2 renditions: different sizes on each server both count.
      await seedMovie({
        serverId: serverA,
        ratingKey: 'cat-m2-a',
        title: 'Catalog M2 Rendition',
        year: 2002,
        tmdbId: 970_002,
        fileSize: 4 * GB,
      });
      await seedMovie({
        serverId: serverB,
        ratingKey: 'cat-m2-b',
        title: 'Catalog M2 Rendition',
        year: 2002,
        tmdbId: 970_002,
        fileSize: 20 * GB,
      });

      // M3 same-server editions: two files on one server both count.
      await seedMovie({
        serverId: serverA,
        ratingKey: 'cat-m3-a1',
        title: 'Catalog M3 Editions',
        year: 2003,
        tmdbId: 970_003,
        fileSize: 8 * GB,
      });
      await seedMovie({
        serverId: serverA,
        ratingKey: 'cat-m3-a2',
        title: 'Catalog M3 Editions',
        year: 2003,
        tmdbId: 970_003,
        fileSize: 9 * GB,
      });

      // M4 both renditions on both servers: two distinct sizes, not four.
      await seedMovie({
        serverId: serverA,
        ratingKey: 'cat-m4-a1',
        title: 'Catalog M4 Both',
        year: 2004,
        tmdbId: 970_004,
        fileSize: 4 * GB,
      });
      await seedMovie({
        serverId: serverA,
        ratingKey: 'cat-m4-a2',
        title: 'Catalog M4 Both',
        year: 2004,
        tmdbId: 970_004,
        fileSize: 20 * GB,
      });
      await seedMovie({
        serverId: serverB,
        ratingKey: 'cat-m4-b1',
        title: 'Catalog M4 Both',
        year: 2004,
        tmdbId: 970_004,
        fileSize: 4 * GB,
      });
      await seedMovie({
        serverId: serverB,
        ratingKey: 'cat-m4-b2',
        title: 'Catalog M4 Both',
        year: 2004,
        tmdbId: 970_004,
        fileSize: 20 * GB,
      });

      // M5 zero-byte ghost copy: a real 0 is still its own distinct size.
      await seedMovie({
        serverId: serverA,
        ratingKey: 'cat-m5-a',
        title: 'Catalog M5 Ghost',
        year: 2005,
        tmdbId: 970_005,
        fileSize: 12 * GB,
      });
      await seedMovie({
        serverId: serverB,
        ratingKey: 'cat-m5-b',
        title: 'Catalog M5 Ghost',
        year: 2005,
        tmdbId: 970_005,
        fileSize: 0,
      });

      // M6 null file_size: a copy with unknown size never counts.
      await seedMovie({
        serverId: serverA,
        ratingKey: 'cat-m6-a',
        title: 'Catalog M6 Null',
        year: 2006,
        tmdbId: 970_006,
        fileSize: null,
      });
      await seedMovie({
        serverId: serverB,
        ratingKey: 'cat-m6-b',
        title: 'Catalog M6 Null',
        year: 2006,
        tmdbId: 970_006,
        fileSize: 5 * GB,
      });

      // M7 single copy: regression guard, unaffected by the DISTINCT change.
      await seedMovie({
        serverId: serverA,
        ratingKey: 'cat-m7-a',
        title: 'Catalog M7 Single',
        year: 2007,
        tmdbId: 970_007,
        fileSize: 7 * GB,
      });
    }

    it('all-server scope: sums each canonical medias DISTINCT file sizes across every copy', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const app = await buildApp(ownerFor());
      await seedSizeScenarios(serverA.id, serverB.id);

      const { statusCode, body } = await fetchCatalog(app, 'type=movie&pageSize=60');
      expect(statusCode).toBe(200);
      expect(body.meta.totalItems).toBe(7);
      // 10 + 24 + 17 + 24 + 12 + 5 + 7 = 99 GB
      expect(body.meta.totalFileSize).toBe(99 * GB);
    });

    it('server-scoped request sees only that servers own copies, not cross-server mirrors', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const app = await buildApp(ownerFor());
      await seedSizeScenarios(serverA.id, serverB.id);

      const { statusCode, body } = await fetchCatalog(
        app,
        `type=movie&serverIds=${serverA.id}&pageSize=60`
      );
      expect(statusCode).toBe(200);
      expect(body.meta.totalItems).toBe(7);
      // 10 + 4 + 17 + 24 + 12 + 0 + 7 = 74 GB
      expect(body.meta.totalFileSize).toBe(74 * GB);
    });
  });

  describe('type=show totals roll up episode files', () => {
    const GB = 1_000_000_000;

    it('all-server scope: a shows total sums each episodes DISTINCT-mirrored size across every copy', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const app = await buildApp(ownerFor());

      // Show 1: two episodes mirrored at equal size on both servers. 3 + 4 = 7 GB.
      const show1 = await seedShow({
        serverId: serverA.id,
        ratingKey: 'cat-tv-show1',
        title: 'Catalog TV Mirrored Episodes',
        year: 2010,
        tvdbId: 980_001,
      });
      await seedEpisode({
        serverId: serverA.id,
        ratingKey: 'cat-tv-show1-ep1-a',
        title: 'Episode 1',
        year: 2010,
        tvdbId: 980_011,
        showMediaId: show1,
        fileSize: 3 * GB,
      });
      await seedEpisode({
        serverId: serverB.id,
        ratingKey: 'cat-tv-show1-ep1-b',
        title: 'Episode 1',
        year: 2010,
        tvdbId: 980_011,
        showMediaId: show1,
        fileSize: 3 * GB,
      });
      await seedEpisode({
        serverId: serverA.id,
        ratingKey: 'cat-tv-show1-ep2-a',
        title: 'Episode 2',
        year: 2010,
        tvdbId: 980_012,
        showMediaId: show1,
        fileSize: 4 * GB,
      });
      await seedEpisode({
        serverId: serverB.id,
        ratingKey: 'cat-tv-show1-ep2-b',
        title: 'Episode 2',
        year: 2010,
        tvdbId: 980_012,
        showMediaId: show1,
        fileSize: 4 * GB,
      });

      // Show 2: one episode with a distinct rendition on each server. 4 + 20 = 24 GB.
      const show2 = await seedShow({
        serverId: serverA.id,
        ratingKey: 'cat-tv-show2',
        title: 'Catalog TV Rendition Episode',
        year: 2011,
        tvdbId: 980_002,
      });
      await seedEpisode({
        serverId: serverA.id,
        ratingKey: 'cat-tv-show2-ep1-a',
        title: 'Episode 1',
        year: 2011,
        tvdbId: 980_021,
        showMediaId: show2,
        fileSize: 4 * GB,
      });
      await seedEpisode({
        serverId: serverB.id,
        ratingKey: 'cat-tv-show2-ep1-b',
        title: 'Episode 1',
        year: 2011,
        tvdbId: 980_021,
        showMediaId: show2,
        fileSize: 20 * GB,
      });

      // Empty show: no episodes at all, contributes 0.
      await seedShow({
        serverId: serverA.id,
        ratingKey: 'cat-tv-show3',
        title: 'Catalog TV Empty Show',
        year: 2012,
        tvdbId: 980_003,
      });

      const { statusCode, body } = await fetchCatalog(app, 'type=show&pageSize=60');
      expect(statusCode).toBe(200);
      expect(body.meta.totalItems).toBe(3);
      // 7 + 24 + 0 = 31 GB
      expect(body.meta.totalFileSize).toBe(31 * GB);
    });

    it('server-scoped request sees only that servers own episode copies, not cross-server mirrors', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const app = await buildApp(ownerFor());

      const mirroredShow = await seedShow({
        serverId: serverA.id,
        ratingKey: 'cat-tv-scope-show1',
        title: 'Catalog TV Scoped Mirrored',
        year: 2013,
        tvdbId: 980_101,
      });
      await seedEpisode({
        serverId: serverA.id,
        ratingKey: 'cat-tv-scope-show1-ep1-a',
        title: 'Episode 1',
        year: 2013,
        tvdbId: 980_111,
        showMediaId: mirroredShow,
        fileSize: 3 * GB,
      });
      await seedEpisode({
        serverId: serverB.id,
        ratingKey: 'cat-tv-scope-show1-ep1-b',
        title: 'Episode 1',
        year: 2013,
        tvdbId: 980_111,
        showMediaId: mirroredShow,
        fileSize: 3 * GB,
      });
      await seedEpisode({
        serverId: serverA.id,
        ratingKey: 'cat-tv-scope-show1-ep2-a',
        title: 'Episode 2',
        year: 2013,
        tvdbId: 980_112,
        showMediaId: mirroredShow,
        fileSize: 4 * GB,
      });
      await seedEpisode({
        serverId: serverB.id,
        ratingKey: 'cat-tv-scope-show1-ep2-b',
        title: 'Episode 2',
        year: 2013,
        tvdbId: 980_112,
        showMediaId: mirroredShow,
        fileSize: 4 * GB,
      });

      const renditionShow = await seedShow({
        serverId: serverA.id,
        ratingKey: 'cat-tv-scope-show2',
        title: 'Catalog TV Scoped Rendition',
        year: 2014,
        tvdbId: 980_102,
      });
      await seedEpisode({
        serverId: serverA.id,
        ratingKey: 'cat-tv-scope-show2-ep1-a',
        title: 'Episode 1',
        year: 2014,
        tvdbId: 980_121,
        showMediaId: renditionShow,
        fileSize: 4 * GB,
      });
      await seedEpisode({
        serverId: serverB.id,
        ratingKey: 'cat-tv-scope-show2-ep1-b',
        title: 'Episode 1',
        year: 2014,
        tvdbId: 980_121,
        showMediaId: renditionShow,
        fileSize: 20 * GB,
      });

      const { statusCode, body } = await fetchCatalog(
        app,
        `type=show&serverIds=${serverA.id}&pageSize=60`
      );
      expect(statusCode).toBe(200);
      expect(body.meta.totalItems).toBe(2);
      // Show 1: 3 + 4 = 7 GB (both episodes present on server A). Show 2: 4 GB (only the 1080p copy).
      expect(body.meta.totalFileSize).toBe(11 * GB);
    });

    it('a movies total is unaffected by a shows episode rollup', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const app = await buildApp(ownerFor());

      await seedMovie({
        serverId: serverA.id,
        ratingKey: 'cat-tv-regression-movie-a',
        title: 'Catalog TV Regression Movie',
        year: 2015,
        tmdbId: 980_201,
        fileSize: 10 * GB,
      });
      await seedMovie({
        serverId: serverB.id,
        ratingKey: 'cat-tv-regression-movie-b',
        title: 'Catalog TV Regression Movie',
        year: 2015,
        tmdbId: 980_201,
        fileSize: 10 * GB,
      });

      const show = await seedShow({
        serverId: serverA.id,
        ratingKey: 'cat-tv-regression-show',
        title: 'Catalog TV Regression Show',
        year: 2016,
        tvdbId: 980_202,
      });
      await seedEpisode({
        serverId: serverA.id,
        ratingKey: 'cat-tv-regression-show-ep1',
        title: 'Episode 1',
        year: 2016,
        tvdbId: 980_211,
        showMediaId: show,
        fileSize: 50 * GB,
      });

      const { statusCode, body } = await fetchCatalog(app, 'type=movie&pageSize=60');
      expect(statusCode).toBe(200);
      expect(body.meta.totalItems).toBe(1);
      expect(body.meta.totalFileSize).toBe(10 * GB);
    });
  });

  describe('preferred poster source', () => {
    it('unset (null): newest copy with a poster wins, same as before the setting existed', async () => {
      await setSetting('preferredPosterServerId', null);
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const app = await buildApp(ownerFor());

      const movieId = await seedMovie({
        serverId: serverA.id,
        ratingKey: 'poster-null-a',
        title: 'Poster Null Movie',
        year: 2022,
        tmdbId: 980_001,
        addedAt: new Date('2026-01-01T00:00:00Z'),
        thumbPath: '/a/thumb.jpg',
        dominantColor: '#aaaaaa',
      });
      const sameId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: 980_001,
        title: 'Poster Null Movie',
        year: 2022,
        serverId: serverB.id,
        ratingKey: 'poster-null-b',
      });
      expect(sameId).toBe(movieId);
      const itemB = await createTestLibraryItem({
        serverId: serverB.id,
        ratingKey: 'poster-null-b',
        title: 'Poster Null Movie',
        mediaType: 'movie',
        mediaId: movieId,
      });
      await db.execute(sql`
        UPDATE library_items SET created_at = ${'2026-02-01T00:00:00Z'}::timestamptz,
          thumb_path = '/b/thumb.jpg', dominant_color = '#bbbbbb'
        WHERE id = ${itemB.id}
      `);

      const { statusCode, body } = await fetchCatalog(app, 'type=movie&pageSize=60');
      expect(statusCode).toBe(200);
      const row = body.data.find((r) => r.mediaId === movieId)!;
      expect(row.dominantColor).toBe('#bbbbbb');
      expect(row.posterUrl).toContain(`server=${serverB.id}`);
    });

    it('prefers the chosen servers poster even when a newer copy elsewhere would otherwise win', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const app = await buildApp(ownerFor());

      const movieId = await seedMovie({
        serverId: serverA.id,
        ratingKey: 'poster-pref-a',
        title: 'Poster Preference Movie',
        year: 2022,
        tmdbId: 980_002,
        addedAt: new Date('2026-01-01T00:00:00Z'),
        thumbPath: '/a/thumb.jpg',
        dominantColor: '#aaaaaa',
      });
      const itemB = await createTestLibraryItem({
        serverId: serverB.id,
        ratingKey: 'poster-pref-b',
        title: 'Poster Preference Movie',
        mediaType: 'movie',
        mediaId: movieId,
      });
      await db.execute(sql`
        UPDATE library_items SET created_at = ${'2026-02-01T00:00:00Z'}::timestamptz,
          thumb_path = '/b/thumb.jpg', dominant_color = '#bbbbbb'
        WHERE id = ${itemB.id}
      `);

      await setSetting('preferredPosterServerId', serverA.id);

      const { statusCode, body } = await fetchCatalog(app, 'type=movie&pageSize=60');
      expect(statusCode).toBe(200);
      const row = body.data.find((r) => r.mediaId === movieId)!;
      expect(row.dominantColor).toBe('#aaaaaa');
      expect(row.posterUrl).toContain(`server=${serverA.id}`);

      await setSetting('preferredPosterServerId', null);
    });

    it('falls back to the newest copy when the preferred server has no poster', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const app = await buildApp(ownerFor());

      // Preferred server (A) has no poster at all - its copy is older too, so
      // an unfiltered "prefer A" ordering would still put a null-poster A row
      // first if the thumb_path IS NOT NULL guard didn't already exclude it.
      const movieId = await seedMovie({
        serverId: serverA.id,
        ratingKey: 'poster-fallback-a',
        title: 'Poster Fallback Movie',
        year: 2022,
        tmdbId: 980_003,
        addedAt: new Date('2026-01-01T00:00:00Z'),
        thumbPath: null,
        dominantColor: null,
      });
      const itemB = await createTestLibraryItem({
        serverId: serverB.id,
        ratingKey: 'poster-fallback-b',
        title: 'Poster Fallback Movie',
        mediaType: 'movie',
        mediaId: movieId,
      });
      await db.execute(sql`
        UPDATE library_items SET created_at = ${'2026-02-01T00:00:00Z'}::timestamptz,
          thumb_path = '/b/thumb.jpg', dominant_color = '#bbbbbb'
        WHERE id = ${itemB.id}
      `);

      await setSetting('preferredPosterServerId', serverA.id);

      const { statusCode, body } = await fetchCatalog(app, 'type=movie&pageSize=60');
      expect(statusCode).toBe(200);
      const row = body.data.find((r) => r.mediaId === movieId)!;
      expect(row.dominantColor).toBe('#bbbbbb');
      expect(row.posterUrl).toContain(`server=${serverB.id}`);

      await setSetting('preferredPosterServerId', null);
    });
  });
});

describe('catalog letter index and offset windows against a real database', () => {
  it('bucket counts line up with the rows a cumulative-offset letter jump actually returns', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());

    // A x2, B x1, F x3 (C-E stay at zero), two digit-leading titles, plus a
    // "The"-prefixed title that must bucket and sort under its stripped form
    // (sort_title drops a leading article: 'The Zebra Movie' lives in Z).
    const seeds: { title: string; tmdbId: number }[] = [
      { title: 'Apple Movie', tmdbId: 991_001 },
      { title: 'Avocado Movie', tmdbId: 991_002 },
      { title: 'Banana Movie', tmdbId: 991_003 },
      { title: 'Foxtrot Alpha', tmdbId: 991_004 },
      { title: 'Foxtrot Bravo', tmdbId: 991_005 },
      { title: 'Foxtrot Charlie', tmdbId: 991_006 },
      { title: '9 Lives Movie', tmdbId: 991_007 },
      { title: '$100 Movie', tmdbId: 991_008 },
      { title: 'The Zebra Movie', tmdbId: 991_009 },
    ];
    for (const [i, seed] of seeds.entries()) {
      await seedMovie({
        serverId: server.id,
        ratingKey: `letters-${i}`,
        title: seed.title,
        year: 2000 + i,
        tmdbId: seed.tmdbId,
      });
    }

    const { statusCode, body } = await fetchLetters(app, 'type=movie');
    expect(statusCode).toBe(200);
    expect(body.letters).toHaveLength(27);
    // '#' leads: everything sorting below 'a' (digit-leading sort titles)
    // comes before every letter bucket in the catalog ordering.
    expect(body.letters.map((b) => b.letter)).toEqual([
      '#',
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
    ]);
    const byLetter = new Map(body.letters.map((b) => [b.letter, b.count]));
    expect(byLetter.get('A')).toBe(2);
    expect(byLetter.get('B')).toBe(1);
    expect(byLetter.get('C')).toBe(0);
    expect(byLetter.get('F')).toBe(3);
    expect(byLetter.get('#')).toBe(2);
    expect(byLetter.get('T')).toBe(0);
    expect(byLetter.get('Z')).toBe(1);

    // A jump to 'F' is the cumulative count of every bucket before it, and
    // the window at that offset starts exactly at the first Foxtrot row.
    const order = body.letters.map((b) => b.letter);
    const offsetBeforeF = body.letters
      .slice(0, order.indexOf('F'))
      .reduce((sum, b) => sum + b.count, 0);
    expect(offsetBeforeF).toBe(5);
    const { body: fBody } = await fetchCatalog(
      app,
      `type=movie&sort=title&offset=${offsetBeforeF}&pageSize=3`
    );
    expect(fBody.data.map((r) => r.title)).toEqual([
      'Foxtrot Alpha',
      'Foxtrot Bravo',
      'Foxtrot Charlie',
    ]);

    // The Z jump lands on the article-stripped title.
    const offsetBeforeZ = body.letters
      .slice(0, order.indexOf('Z'))
      .reduce((sum, b) => sum + b.count, 0);
    const { body: zBody } = await fetchCatalog(
      app,
      `type=movie&sort=title&offset=${offsetBeforeZ}&pageSize=1`
    );
    expect(zBody.data.map((r) => r.title)).toEqual(['The Zebra Movie']);

    // '#' is offset 0 - the first rows of the ordering.
    const { body: hashBody } = await fetchCatalog(app, 'type=movie&sort=title&offset=0&pageSize=2');
    for (const row of hashBody.data) {
      expect(/^[A-Za-z]/.test(row.title.trim())).toBe(false);
    }
  });

  it('the same genre filter yields consistent counts between letters and the catalog page', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());

    await seedMovie({
      serverId: server.id,
      ratingKey: 'letters-genre-1',
      title: 'Action Alpha',
      year: 2001,
      tmdbId: 992_001,
      genre: 'Action',
    });
    await seedMovie({
      serverId: server.id,
      ratingKey: 'letters-genre-2',
      title: 'Action Bravo',
      year: 2002,
      tmdbId: 992_002,
      genre: 'Action',
    });
    await seedMovie({
      serverId: server.id,
      ratingKey: 'letters-genre-3',
      title: 'Comedy Alpha',
      year: 2003,
      tmdbId: 992_003,
      genre: 'Comedy',
    });

    const { body: lettersBody } = await fetchLetters(app, 'type=movie&genre=Action');
    const totalFromLetters = lettersBody.letters.reduce((sum, b) => sum + b.count, 0);
    expect(totalFromLetters).toBe(2);
    expect(lettersBody.letters.find((b) => b.letter === 'A')!.count).toBe(2);

    const { body: catalogBody } = await fetchCatalog(app, 'type=movie&genre=Action&pageSize=60');
    expect(catalogBody.meta.totalItems).toBe(2);
    expect(catalogBody.data).toHaveLength(2);
  });

  it('library, hdr and size-on-disk filters narrow catalog pages and letters consistently', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());
    const GB = 1024 ** 3;

    const alphaHdr = await seedMovie({
      serverId: server.id,
      ratingKey: 'filters-alpha-hdr',
      title: 'Alpha HDR',
      year: 2011,
      tmdbId: 993_001,
      libraryId: 'lib-a',
      videoDynamicRange: 'hdr10',
      fileSize: 5 * GB,
    });
    await seedMovie({
      serverId: server.id,
      ratingKey: 'filters-alpha-sdr',
      title: 'Alpha SDR',
      year: 2012,
      tmdbId: 993_002,
      libraryId: 'lib-a',
      videoDynamicRange: 'sdr',
      fileSize: 1 * GB,
    });
    await seedMovie({
      serverId: server.id,
      ratingKey: 'filters-alpha-unsynced',
      title: 'Alpha Unsynced',
      year: 2013,
      tmdbId: 993_003,
      libraryId: 'lib-a',
      videoDynamicRange: null,
      fileSize: 2 * GB,
    });
    await seedMovie({
      serverId: server.id,
      ratingKey: 'filters-bravo-dv',
      title: 'Bravo Dolby Vision',
      year: 2014,
      tmdbId: 993_004,
      libraryId: 'lib-b',
      videoDynamicRange: 'dolby vision',
      fileSize: 20 * GB,
    });

    // Library filter: only lib-a's three titles, regardless of dynamic range/size.
    const libraryKey = `${server.id}:lib-a`;
    const { body: libraryCatalog } = await fetchCatalog(
      app,
      `type=movie&libraryKey=${libraryKey}&pageSize=60`
    );
    expect(libraryCatalog.meta.totalItems).toBe(3);
    expect(libraryCatalog.data.map((r) => r.title).sort()).toEqual([
      'Alpha HDR',
      'Alpha SDR',
      'Alpha Unsynced',
    ]);

    // HDR filter: Alpha HDR (hdr10) and Bravo Dolby Vision, not the SDR or
    // never-synced (null dynamic range) titles.
    const { body: hdrCatalog } = await fetchCatalog(app, 'type=movie&hdr=true&pageSize=60');
    expect(hdrCatalog.meta.totalItems).toBe(2);
    expect(hdrCatalog.data.map((r) => r.title).sort()).toEqual(['Alpha HDR', 'Bravo Dolby Vision']);

    // Size filter: only the 5GB-20GB band.
    const { body: sizeCatalog } = await fetchCatalog(
      app,
      'type=movie&sizeGbMin=5&sizeGbMax=20&pageSize=60'
    );
    expect(sizeCatalog.meta.totalItems).toBe(2);
    expect(sizeCatalog.data.map((r) => r.title).sort()).toEqual([
      'Alpha HDR',
      'Bravo Dolby Vision',
    ]);

    // Combined: library + hdr + size narrows to the single title matching all three.
    const combinedQuery = `type=movie&libraryKey=${libraryKey}&hdr=true&sizeGbMin=3&sizeGbMax=10&pageSize=60`;
    const { body: combinedCatalog } = await fetchCatalog(app, combinedQuery);
    expect(combinedCatalog.meta.totalItems).toBe(1);
    expect(combinedCatalog.data[0]!.mediaId).toBe(alphaHdr);

    // Letters must land on the exact same filtered set the page returned.
    const { body: combinedLetters } = await fetchLetters(app, combinedQuery);
    const totalFromLetters = combinedLetters.letters.reduce((sum, b) => sum + b.count, 0);
    expect(totalFromLetters).toBe(1);
    expect(combinedLetters.letters.find((b) => b.letter === 'A')!.count).toBe(1);
  });

  it('a watched filter keeps letters and catalog windows on one shared filtered ordering', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const app = await buildApp(ownerFor());

    // Two A titles and two F titles; one of each gets watched. Under
    // watched=unwatched the rail must count A=1, F=1 and the F jump offset
    // (cumulative count before F = 1) must land exactly on the unwatched
    // Foxtrot row - both endpoints read the same cached candidate list.
    const seeds = [
      { title: 'Apple Watched', tmdbId: 998_001, key: 'aw' },
      { title: 'Avocado Fresh', tmdbId: 998_002, key: 'af' },
      { title: 'Foxtrot Watched', tmdbId: 998_003, key: 'fw' },
      { title: 'Foxtrot Fresh', tmdbId: 998_004, key: 'ff' },
    ] as const;
    const ids: Record<string, string> = {};
    for (const seed of seeds) {
      ids[seed.key] = await seedMovie({
        serverId: server.id,
        ratingKey: `letters-watched-${seed.key}`,
        title: seed.title,
        year: 2010,
        tmdbId: seed.tmdbId,
      });
    }
    for (const key of ['aw', 'fw'] as const) {
      await seedSession({
        serverId: server.id,
        serverUserId: account.id,
        mediaId: ids[key]!,
        ratingKey: `letters-watched-${key}`,
        durationMs: 300_000,
      });
    }
    await refreshPlaysAggregate();

    const { body: lettersBody } = await fetchLetters(app, 'type=movie&watched=unwatched');
    const byLetter = new Map(lettersBody.letters.map((b) => [b.letter, b.count]));
    expect(byLetter.get('A')).toBe(1);
    expect(byLetter.get('F')).toBe(1);

    const order = lettersBody.letters.map((b) => b.letter);
    const offsetBeforeF = lettersBody.letters
      .slice(0, order.indexOf('F'))
      .reduce((sum, b) => sum + b.count, 0);
    expect(offsetBeforeF).toBe(1);

    const { body: fWindow } = await fetchCatalog(
      app,
      `type=movie&sort=title&watched=unwatched&offset=${offsetBeforeF}&pageSize=1`
    );
    expect(fWindow.data.map((r) => r.title)).toEqual(['Foxtrot Fresh']);
    expect(fWindow.meta.totalItems).toBe(2);
  });

  it('a non-title sort returns an empty bucket set', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());
    await seedMovie({
      serverId: server.id,
      ratingKey: 'letters-nontitle',
      title: 'Whatever Movie',
      year: 2020,
      tmdbId: 994_001,
    });

    const { statusCode, body } = await fetchLetters(app, 'type=movie&sort=added');
    expect(statusCode).toBe(200);
    expect(body.letters).toEqual([]);
  });

  it('title ordering ignores leading articles across windows', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());

    // Expected order by article-stripped sort_title:
    // amelie, batman, matrix, office, zebra.
    const seeds = [
      { title: 'The Matrix', tmdbId: 999_001 },
      { title: 'Amelie', tmdbId: 999_002 },
      { title: 'The Office Movie', tmdbId: 999_003 },
      { title: 'A Zebra Tale', tmdbId: 999_004 },
      { title: 'Batman', tmdbId: 999_005 },
    ];
    for (const [i, seed] of seeds.entries()) {
      await seedMovie({
        serverId: server.id,
        ratingKey: `articles-${i}`,
        title: seed.title,
        year: 2000 + i,
        tmdbId: seed.tmdbId,
      });
    }

    const { body } = await fetchCatalog(app, 'type=movie&sort=title&pageSize=60');
    expect(body.data.map((r) => r.title)).toEqual([
      'Amelie',
      'Batman',
      'The Matrix',
      'The Office Movie',
      'A Zebra Tale',
    ]);

    // The same order tiles across windows.
    const { body: window2 } = await fetchCatalog(app, 'type=movie&sort=title&offset=2&pageSize=2');
    expect(window2.data.map((r) => r.title)).toEqual(['The Matrix', 'The Office Movie']);
  });

  it('an offset window past the end returns empty data with the real total', async () => {
    const server = await createTestServer({ type: 'plex' });
    const app = await buildApp(ownerFor());

    for (let i = 0; i < 5; i++) {
      await seedMovie({
        serverId: server.id,
        ratingKey: `offset-totals-${i}`,
        title: `Total Movie ${i}`,
        year: 2000 + i,
        tmdbId: 997_000 + i,
      });
    }

    const { body } = await fetchCatalog(app, 'type=movie&sort=title&offset=2&pageSize=2');
    expect(body.data).toHaveLength(2);
    expect(body.meta.totalItems).toBe(5);

    const { body: past } = await fetchCatalog(app, 'type=movie&sort=title&offset=50&pageSize=2');
    expect(past.data).toEqual([]);
    expect(past.meta.totalItems).toBe(5);
  });
});

describe('catalog artists against a real database', () => {
  it('counts each track chain once toward the artist and folds its albums across servers', async () => {
    const music = await seedArtistOnTwoServers();
    const app = await buildApp(ownerFor());

    for (const sort of ['title', 'plays']) {
      const res = await app.inject({
        method: 'GET',
        url: `/library/catalog?type=artist&sort=${sort}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<CatalogResponse>();
      expect(body.meta.totalItems).toBe(1);
      expect(body.data).toEqual([
        expect.objectContaining({
          mediaId: music.artistMediaId,
          mediaType: 'artist',
          title: 'Daft Punk',
          year: null,
          albumCount: 2,
          plays: 3,
          viewers: 2,
          posterUrl: expect.any(String),
        }),
      ]);
      expect(body.data[0]).not.toHaveProperty('watchedStateSelf');
    }
  });
});
