/**
 * Genres aggregate endpoint correctness, against a real database.
 *
 * genres.routes.test.ts mocks db.execute, so it proves handler mechanics but
 * never the SQL itself: canonical-grain item counts, the alias-safe merge
 * bucketing (a merged loser's plays land on the canonical row's genre
 * buckets), chain grouping, server scoping, the type filter and the artist
 * roll-up through track rows all live in the query.
 * This suite drives the real route (app.inject) against the per-worker test
 * database and asserts on the actual returned rows.
 *
 * Run with: pnpm --filter @tracearr/server test:integration genres
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import type { AuthUser, GenreDetailResponse, GenresResponse } from '@tracearr/shared';
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
import { libraryGenresRoute } from '../../src/routes/library/genres.js';
import {
  resolveMediaForItem,
  mergeMediaRows,
} from '../../src/services/library/mediaResolutionService.js';
import { permissionGuard } from '../../src/lib/scope.js';
import { seedArtistOnTwoServers } from './musicFixtures.js';

async function buildApp(authUser: AuthUser): Promise<{ app: FastifyInstance; redis: Redis }> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  const redis = createMockRedis() as unknown as Redis;
  app.decorate('redis', redis);
  await app.register(libraryGenresRoute, { prefix: '/library' });
  return { app, redis };
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
  genres?: string[] | null;
}

async function seedMovie(opts: SeedMovieOptions): Promise<string> {
  const mediaId = await resolveMediaForItem({
    mediaType: 'movie',
    tmdbId: opts.tmdbId,
    title: opts.title,
    year: opts.year,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
  });
  const genres = opts.genres ?? null;
  await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'movie',
    year: opts.year,
    mediaId,
    genres,
  });
  await db.update(media).set({ genres }).where(eq(media.id, mediaId));
  return mediaId;
}

interface SeedShowOptions {
  serverId: string;
  ratingKey: string;
  title: string;
  year: number;
  tvdbId: number;
  genres?: string[] | null;
}

async function seedShow(opts: SeedShowOptions): Promise<string> {
  const showId = await resolveMediaForItem({
    mediaType: 'show',
    tvdbId: opts.tvdbId,
    title: opts.title,
    year: opts.year,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
  });
  const genres = opts.genres ?? null;
  await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'show',
    year: opts.year,
    mediaId: showId,
    genres,
  });
  await db.update(media).set({ genres }).where(eq(media.id, showId));
  return showId;
}

interface SeedEpisodeOptions {
  serverId: string;
  ratingKey: string;
  title: string;
  year: number;
  tvdbId: number;
  showMediaId: string;
  genres?: string[] | null;
}

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
  const genres = opts.genres ?? null;
  await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'episode',
    mediaId: episodeId,
    genres,
  });
  await db.update(media).set({ genres }).where(eq(media.id, episodeId));
  return episodeId;
}

interface SeedSessionOptions {
  serverId: string;
  serverUserId: string;
  mediaId: string;
  showMediaId?: string;
  ratingKey: string;
  mediaType?: 'movie' | 'episode' | 'track';
  durationMs: number;
  startedAt?: Date;
  referenceId?: string;
}

async function seedSession(opts: SeedSessionOptions): Promise<string> {
  const startedAt = opts.startedAt ?? new Date();
  const session = await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    mediaId: opts.mediaId,
    showMediaId: opts.showMediaId ?? null,
    ratingKey: opts.ratingKey,
    mediaType: opts.mediaType ?? 'movie',
    state: 'stopped',
    referenceId: opts.referenceId ?? null,
    durationMs: opts.durationMs,
    totalDurationMs: Math.max(opts.durationMs, 7_200_000),
    progressMs: opts.durationMs,
    watched: opts.durationMs >= 120_000,
    startedAt,
    stoppedAt: startedAt,
  });
  return session.id;
}

interface SeedTrackOptions {
  serverId: string;
  ratingKey: string;
  title: string;
  artistRatingKey: string;
  fileSize: number;
}

async function seedTrack(opts: SeedTrackOptions): Promise<string> {
  const mediaId = await resolveMediaForItem({
    mediaType: 'track',
    title: opts.title,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    grandparentRatingKey: opts.artistRatingKey,
  });
  await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'track',
    grandparentRatingKey: opts.artistRatingKey,
    mediaId,
    fileSize: opts.fileSize,
  });
  return mediaId;
}

async function seedArtist(opts: {
  serverId: string;
  ratingKey: string;
  title: string;
  genres: string[];
}): Promise<string> {
  const mediaId = await resolveMediaForItem({
    mediaType: 'artist',
    title: opts.title,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
  });
  await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'artist',
    mediaId,
    genres: opts.genres,
    withoutVersion: true,
  });
  await db.update(media).set({ genres: opts.genres }).where(eq(media.id, mediaId));
  return mediaId;
}

async function fetchGenres(
  app: FastifyInstance,
  type: 'movie' | 'show' | 'artist',
  extraQuery = ''
): Promise<{ statusCode: number; body: GenresResponse }> {
  const res = await app.inject({ method: 'GET', url: `/library/genres?type=${type}${extraQuery}` });
  return { statusCode: res.statusCode, body: res.json<GenresResponse>() };
}

async function fetchGenre(
  app: FastifyInstance,
  type: 'movie' | 'show' | 'artist',
  genre: string
): Promise<{ statusCode: number; body: GenreDetailResponse }> {
  const res = await app.inject({
    method: 'GET',
    url: `/library/genres/${encodeURIComponent(genre)}?type=${type}`,
  });
  return { statusCode: res.statusCode, body: res.json<GenreDetailResponse>() };
}

describe('genres aggregate endpoint against a real database', () => {
  it('lands a merged loser plays on the canonical genre bucket, counting the item once', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    // Plain Action movie, unrelated to the merge.
    await seedMovie({
      serverId: server.id,
      ratingKey: 'merge-plain-action',
      title: 'Plain Action Movie',
      year: 2001,
      tmdbId: 900_001,
      genres: ['Action'],
    });

    // Winner already carries genres, so the merge cannot overwrite them with
    // the loser's - the canonical bucket for the loser's plays must be
    // Action, never the loser's own Drama tag.
    const winner = await seedMovie({
      serverId: server.id,
      ratingKey: 'merge-winner-action',
      title: 'Winner Action Movie',
      year: 2002,
      tmdbId: 900_002,
      genres: ['Action'],
    });
    const loser = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 900_003,
      title: 'Loser Drama Movie',
      year: 2002,
      serverId: server.id,
      ratingKey: 'merge-loser-drama',
    });
    await db
      .update(media)
      .set({ genres: ['Drama'] })
      .where(eq(media.id, loser));

    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: loser,
      ratingKey: 'merge-loser-drama',
      durationMs: 600_000,
    });

    await mergeMediaRows(winner, loser);
    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchGenres(app, 'movie');
    expect(statusCode).toBe(200);

    const action = body.data.find((row) => row.genre === 'Action');
    const drama = body.data.find((row) => row.genre === 'Drama');

    // Two canonical Action items (the plain movie + the winner); the loser is
    // merged away and must not be double-counted.
    expect(action?.itemCount).toBe(2);
    // The loser's play (10 minutes) lands on the winner's Action bucket.
    expect(action?.plays).toBe(1);
    expect(action?.watchTimeMs).toBe(600_000);
    // Drama has no canonical representative left - the loser's own genre
    // must never surface a bucket of its own.
    expect(drama).toBeUndefined();
  });

  it('scopes item counts and plays to the caller server, hiding another servers activity', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const userA = await createTestUser();
    const userB = await createTestUser();
    const accountA = await createTestServerUser({ serverId: serverA.id, userId: userA.id });
    const accountB = await createTestServerUser({ serverId: serverB.id, userId: userB.id });

    const movieA = await seedMovie({
      serverId: serverA.id,
      ratingKey: 'scope-horror-a',
      title: 'Scope Horror A',
      year: 2011,
      tmdbId: 901_001,
      genres: ['Horror'],
    });
    await seedSession({
      serverId: serverA.id,
      serverUserId: accountA.id,
      mediaId: movieA,
      ratingKey: 'scope-horror-a',
      durationMs: 300_000,
    });

    const movieB = await seedMovie({
      serverId: serverB.id,
      ratingKey: 'scope-horror-b',
      title: 'Scope Horror B',
      year: 2012,
      tmdbId: 901_002,
      genres: ['Horror'],
    });
    await seedSession({
      serverId: serverB.id,
      serverUserId: accountB.id,
      mediaId: movieB,
      ratingKey: 'scope-horror-b',
      durationMs: 300_000,
    });

    await refreshPlaysAggregate();

    const { app } = await buildApp(viewerFor([serverA.id]));
    const { statusCode, body } = await fetchGenres(app, 'movie');
    expect(statusCode).toBe(200);

    const horror = body.data.find((row) => row.genre === 'Horror');
    expect(horror?.itemCount).toBe(1);
    expect(horror?.plays).toBe(1);
  });

  it('excludes show plays from a movie-genre bucket and vice versa', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });

    const movie = await seedMovie({
      serverId: server.id,
      ratingKey: 'type-scifi-movie',
      title: 'SciFi Movie',
      year: 2015,
      tmdbId: 902_001,
      genres: ['SciFi'],
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: movie,
      ratingKey: 'type-scifi-movie',
      durationMs: 400_000,
    });

    const show = await seedShow({
      serverId: server.id,
      ratingKey: 'type-scifi-show',
      title: 'SciFi Show',
      year: 2016,
      tvdbId: 902_101,
      genres: ['SciFi'],
    });
    // The episode's own media row carries genres too, as Jellyfin/Emby
    // episodes legitimately do - its plays must never leak into the movie
    // SciFi bucket via the media_type-less join.
    const episode = await seedEpisode({
      serverId: server.id,
      ratingKey: 'type-scifi-show-e1',
      title: 'SciFi Show E1',
      year: 2016,
      tvdbId: 902_111,
      showMediaId: show,
      genres: ['SciFi'],
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: episode,
      showMediaId: show,
      ratingKey: 'type-scifi-show-e1',
      mediaType: 'episode',
      durationMs: 500_000,
    });

    await refreshPlaysAggregate();

    const { app } = await buildApp(ownerFor());

    const { body: movieBody } = await fetchGenres(app, 'movie');
    const movieSciFi = movieBody.data.find((row) => row.genre === 'SciFi');
    expect(movieSciFi?.itemCount).toBe(1);
    expect(movieSciFi?.plays).toBe(1);
    expect(movieSciFi?.watchTimeMs).toBe(400_000);

    const { body: showBody } = await fetchGenres(app, 'show');
    const showSciFi = showBody.data.find((row) => row.genre === 'SciFi');
    expect(showSciFi?.itemCount).toBe(1);
    expect(showSciFi?.plays).toBe(1);
    expect(showSciFi?.watchTimeMs).toBe(500_000);
  });

  it('caches the computed genres per (scope, type), missing a later item until invalidated', async () => {
    const server = await createTestServer({ type: 'plex' });
    const { app } = await buildApp(ownerFor());

    await seedMovie({
      serverId: server.id,
      ratingKey: 'cache-comedy-1',
      title: 'Cache Comedy One',
      year: 2018,
      tmdbId: 903_001,
      genres: ['Comedy'],
    });

    const { statusCode: firstStatus, body: firstBody } = await fetchGenres(app, 'movie');
    expect(firstStatus).toBe(200);
    const comedy = firstBody.data.find((row) => row.genre === 'Comedy');
    expect(comedy?.itemCount).toBe(1);

    // A second Comedy item added after the cache was populated must not
    // surface on a repeat call for the same scope+type if the cache is
    // actually being hit.
    await seedMovie({
      serverId: server.id,
      ratingKey: 'cache-comedy-2',
      title: 'Cache Comedy Two (added after cache)',
      year: 2019,
      tmdbId: 903_002,
      genres: ['Comedy'],
    });

    const { statusCode: secondStatus, body: secondBody } = await fetchGenres(app, 'movie');
    expect(secondStatus).toBe(200);
    const secondComedy = secondBody.data.find((row) => row.genre === 'Comedy');
    expect(secondComedy?.itemCount).toBe(1);
    expect(secondBody).toEqual(firstBody);
  });

  it('the serverIds query param narrows to the selected subset, combines across it, and never leaks an inaccessible server', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const { app: appOwner } = await buildApp(ownerFor());

    await seedMovie({
      serverId: serverA.id,
      ratingKey: 'selector-thriller-a',
      title: 'Selector Thriller A',
      year: 2011,
      tmdbId: 904_001,
      genres: ['Thriller'],
    });
    await seedMovie({
      serverId: serverB.id,
      ratingKey: 'selector-thriller-b',
      title: 'Selector Thriller B',
      year: 2012,
      tmdbId: 904_002,
      genres: ['Thriller'],
    });

    const { statusCode: aStatus, body: aBody } = await fetchGenres(
      appOwner,
      'movie',
      `&serverIds=${serverA.id}`
    );
    expect(aStatus).toBe(200);
    expect(aBody.data.find((row) => row.genre === 'Thriller')?.itemCount).toBe(1);

    const { statusCode: abStatus, body: abBody } = await fetchGenres(
      appOwner,
      'movie',
      `&serverIds=${serverA.id}&serverIds=${serverB.id}`
    );
    expect(abStatus).toBe(200);
    expect(abBody.data.find((row) => row.genre === 'Thriller')?.itemCount).toBe(2);

    const { statusCode: allStatus, body: allBody } = await fetchGenres(appOwner, 'movie');
    expect(allStatus).toBe(200);
    expect(allBody.data.find((row) => row.genre === 'Thriller')?.itemCount).toBe(2);

    const viewer = viewerFor([serverA.id]);
    const { app: appViewer } = await buildApp(viewer);
    const { statusCode: leakStatus, body: leakBody } = await fetchGenres(
      appViewer,
      'movie',
      `&serverIds=${serverB.id}`
    );
    expect(leakStatus).toBe(200);
    expect(leakBody.data.find((row) => row.genre === 'Thriller')).toBeUndefined();
  });

  it('counts a show chain spanning two UTC days once and lists the genre sheet', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor([server.id]));

    const show = await seedShow({
      serverId: server.id,
      ratingKey: 'chain-western-show',
      title: 'Chain Western Show',
      year: 2020,
      tvdbId: 905_101,
      genres: ['Western'],
    });
    const episode = await seedEpisode({
      serverId: server.id,
      ratingKey: 'chain-western-show-e1',
      title: 'Chain Western Show E1',
      year: 2020,
      tvdbId: 905_111,
      showMediaId: show,
    });
    const unplayed = await seedShow({
      serverId: server.id,
      ratingKey: 'chain-western-unplayed',
      title: 'Unplayed Western Show',
      year: 2021,
      tvdbId: 905_201,
      genres: ['Western'],
    });

    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const first = await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: episode,
      showMediaId: show,
      ratingKey: 'chain-western-show-e1',
      mediaType: 'episode',
      durationMs: 600_000,
      startedAt: new Date(midnight.getTime() - 10 * 60_000),
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: episode,
      showMediaId: show,
      ratingKey: 'chain-western-show-e1',
      mediaType: 'episode',
      durationMs: 600_000,
      startedAt: new Date(midnight.getTime() + 10 * 60_000),
      referenceId: first,
    });
    await refreshPlaysAggregate();

    const { body } = await fetchGenres(app, 'show');
    const western = body.data.find((row) => row.genre === 'Western');
    expect(western).toMatchObject({
      itemCount: 2,
      plays: 1,
      watchTimeMs: 1_200_000,
      neverPlayed: { count: 1, bytes: 0 },
      topViewer: { userId: user.id, serverUserId: account.id, share: 100 },
    });
    expect(western?.trend.reduce((sum, n) => sum + n, 0)).toBe(1);

    const { statusCode, body: sheet } = await fetchGenre(app, 'show', 'Western');
    expect(statusCode).toBe(200);
    expect(sheet.kpis).toMatchObject({ plays: 1, itemCount: 2 });
    expect(sheet.topTitles.map((title) => title.mediaId)).toEqual([show]);
    expect(sheet.neverPlayed.map((title) => title.mediaId)).toEqual([unplayed]);
    expect(sheet.topViewers).toEqual([
      expect.objectContaining({
        serverUserId: account.id,
        serverId: server.id,
        thumbUrl: account.thumbUrl ?? null,
      }),
    ]);

    expect((await fetchGenre(app, 'show', 'Polka')).statusCode).toBe(404);
  });

  it('names a viewer by their Tracearr user, not by the account on the selected server', async () => {
    const emby = await createTestServer({ type: 'emby' });
    const tofa = await createTestServer({ type: 'tofa' });
    const user = await createTestUser({ name: null, username: 'zoe' });
    await createTestServerUser({
      serverId: emby.id,
      userId: user.id,
      username: 'zoe_emby',
      lastActivityAt: new Date(),
    });
    const tofaAccount = await createTestServerUser({
      serverId: tofa.id,
      userId: user.id,
      username: 'aaron_tofa',
      lastActivityAt: new Date(Date.now() - 86_400_000),
    });
    const movie = await seedMovie({
      serverId: tofa.id,
      ratingKey: 'viewer-name-noir',
      title: 'Viewer Name Noir',
      year: 2019,
      tmdbId: 906_001,
      genres: ['Noir'],
    });
    await seedSession({
      serverId: tofa.id,
      serverUserId: tofaAccount.id,
      mediaId: movie,
      ratingKey: 'viewer-name-noir',
      durationMs: 600_000,
    });
    await refreshPlaysAggregate();

    const { app } = await buildApp(ownerFor());
    const { body } = await fetchGenres(app, 'movie', `&serverIds=${tofa.id}`);
    expect(body.data.find((row) => row.genre === 'Noir')?.topViewer).toMatchObject({
      serverUserId: tofaAccount.id,
      name: 'zoe',
    });
  });

  it('rolls track plays and sizes up to the artist genre, dropping a track with no artist row', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor([server.id]));

    await seedArtist({
      serverId: server.id,
      ratingKey: 'artist-rock-1',
      title: 'Rock Artist One',
      genres: ['Rock'],
    });
    const track = await seedTrack({
      serverId: server.id,
      ratingKey: 'artist-rock-1-t1',
      title: 'Rock Track One',
      artistRatingKey: 'artist-rock-1',
      fileSize: 5_000_000,
    });
    const orphan = await seedTrack({
      serverId: server.id,
      ratingKey: 'orphan-track-1',
      title: 'Orphan Track One',
      artistRatingKey: 'artist-missing',
      fileSize: 7_000_000,
    });
    for (const [mediaId, ratingKey] of [
      [track, 'artist-rock-1-t1'],
      [orphan, 'orphan-track-1'],
    ] as const) {
      await seedSession({
        serverId: server.id,
        serverUserId: account.id,
        mediaId,
        ratingKey,
        mediaType: 'track',
        durationMs: 200_000,
      });
    }
    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchGenres(app, 'artist');
    expect(statusCode).toBe(200);
    expect(body.data.find((row) => row.genre === 'Rock')).toMatchObject({
      itemCount: 1,
      sizeBytes: 5_000_000,
      plays: 1,
      neverPlayed: { count: 0, bytes: 0 },
    });
    expect(body.totals.plays).toBe(1);
    expect(body.hourly.reduce((sum, hour) => sum + hour.count, 0)).toBe(1);

    const { body: sheet } = await fetchGenre(app, 'artist', 'Rock');
    expect(sheet.kpis).toMatchObject({ plays: 1, playShare: 100, itemShare: 100 });
    expect(sheet.topTitles).toEqual([
      expect.objectContaining({ title: 'Rock Artist One', plays: 1, sizeBytes: 5_000_000 }),
    ]);
  });

  it('counts an artist held on two servers once, with its mirrored tracks sized once', async () => {
    const music = await seedArtistOnTwoServers();
    await db
      .update(media)
      .set({ genres: ['Electronic'] })
      .where(eq(media.id, music.artistMediaId));
    await createTestLibraryItem({
      serverId: music.serverA,
      ratingKey: 'artist-unresolved',
      title: 'Unresolved Artist',
      mediaType: 'artist',
      genres: ['Electronic'],
      withoutVersion: true,
    });
    const { app } = await buildApp(ownerFor());

    const { statusCode, body } = await fetchGenres(app, 'artist');
    expect(statusCode).toBe(200);
    expect(body.data.find((row) => row.genre === 'Electronic')).toMatchObject({
      itemCount: 1,
      sizeBytes: 18_000_000,
      plays: 3,
      neverPlayed: { count: 0, bytes: 0 },
    });

    const { body: sheet } = await fetchGenre(app, 'artist', 'Electronic');
    expect(sheet.topTitles).toEqual([
      expect.objectContaining({ title: 'Daft Punk', plays: 3, sizeBytes: 18_000_000 }),
    ]);
  });
});
