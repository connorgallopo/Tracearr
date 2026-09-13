/**
 * Library command center endpoint correctness, against a real database.
 *
 * shelves.routes.test.ts mocks db.execute, so it proves handler mechanics but
 * never the SQL itself: window parameterization, type-split shelves (movie vs
 * show, episode plays rolling up to their show), KPI math, dead-weight
 * ordering, and the versioned cache contract all live in the query and
 * caching logic exercised here.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- shelves
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import type { AuthUser, ShelvesResponse } from '@tracearr/shared';
import { REDIS_KEYS } from '@tracearr/shared';
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
import { libraryShelvesRoute } from '../../src/routes/library/shelves.js';
import { buildLibraryCacheKey } from '../../src/routes/library/utils.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { setSetting } from '../../src/services/settings.js';
import {
  initLibrarySyncQueue,
  invalidateLibraryCaches,
  shutdownLibrarySyncQueue,
} from '../../src/jobs/librarySyncQueue.js';

async function buildApp(authUser: AuthUser): Promise<{ app: FastifyInstance; redis: Redis }> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  const redis = createMockRedis() as unknown as Redis;
  app.decorate('redis', redis);
  await app.register(libraryShelvesRoute, { prefix: '/library' });
  return { app, redis };
}

function ownerFor(serverIds: string[] = []): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds };
}

async function refreshPlaysAggregate(): Promise<void> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface SeedMovieOptions {
  serverId: string;
  ratingKey: string;
  title: string;
  year: number;
  tmdbId: number;
  addedAt?: Date;
  fileSize?: number | null;
  thumbPath?: string | null;
}

/** A distinct ratingKey with the same tmdbId (same or different serverId)
 * adds another copy of the same canonical media instead of a new one.
 * fileSize defaults to 0 when omitted; pass null explicitly to leave the
 * column NULL. */
async function seedMovie(opts: SeedMovieOptions): Promise<string> {
  const mediaId = await resolveMediaForItem({
    mediaType: 'movie',
    tmdbId: opts.tmdbId,
    title: opts.title,
    year: opts.year,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
  });
  const item = await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'movie',
    year: opts.year,
    mediaId,
  });
  const addedAt = opts.addedAt ?? new Date();
  const fileSize = opts.fileSize === undefined ? 0 : opts.fileSize;
  await db.execute(sql`
    UPDATE library_items SET created_at = ${addedAt.toISOString()}::timestamptz,
      file_size = ${fileSize},
      thumb_path = ${opts.thumbPath ?? null}
    WHERE id = ${item.id}
  `);
  await db.execute(sql`
    UPDATE library_item_versions v SET
      file_size = li.file_size,
      video_resolution = li.video_resolution,
      video_dynamic_range = li.video_dynamic_range
    FROM library_items li
    WHERE li.id = v.library_item_id AND li.id = ${item.id}
  `);
  await db.update(media).set({ latestAddedAt: addedAt }).where(eq(media.id, mediaId));
  return mediaId;
}

interface SeedShowOptions {
  serverId: string;
  ratingKey: string;
  title: string;
  year: number;
  tvdbId: number;
  addedAt?: Date;
  fileSize?: number;
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
  const item = await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'show',
    year: opts.year,
    mediaId: showId,
  });
  const addedAt = opts.addedAt ?? new Date();
  await db.execute(sql`
    UPDATE library_items SET created_at = ${addedAt.toISOString()}::timestamptz,
      file_size = ${opts.fileSize ?? 0}
    WHERE id = ${item.id}
  `);
  await db.execute(sql`
    UPDATE library_item_versions v SET
      file_size = li.file_size,
      video_resolution = li.video_resolution,
      video_dynamic_range = li.video_dynamic_range
    FROM library_items li
    WHERE li.id = v.library_item_id AND li.id = ${item.id}
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
  addedAt?: Date;
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
  const addedAt = opts.addedAt ?? new Date();
  const fileSize = opts.fileSize === undefined ? 0 : opts.fileSize;
  await db.execute(sql`
    UPDATE library_items SET created_at = ${addedAt.toISOString()}::timestamptz,
      file_size = ${fileSize}
    WHERE id = ${item.id}
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
  showMediaId?: string;
  ratingKey: string;
  mediaType?: 'movie' | 'episode';
  durationMs: number;
  startedAt?: Date;
  watched?: boolean;
}

async function seedSession(opts: SeedSessionOptions): Promise<void> {
  const startedAt = opts.startedAt ?? new Date();
  await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    mediaId: opts.mediaId,
    showMediaId: opts.showMediaId ?? null,
    ratingKey: opts.ratingKey,
    mediaType: opts.mediaType ?? 'movie',
    state: 'stopped',
    referenceId: null,
    durationMs: opts.durationMs,
    totalDurationMs: Math.max(opts.durationMs, 7_200_000),
    progressMs: opts.durationMs,
    watched: opts.watched ?? opts.durationMs >= 120_000,
    startedAt,
    stoppedAt: startedAt,
  });
}

async function fetchShelves(
  app: FastifyInstance,
  query = ''
): Promise<{ statusCode: number; body: ShelvesResponse }> {
  const res = await app.inject({ method: 'GET', url: `/library/shelves${query}` });
  return { statusCode: res.statusCode, body: res.json<ShelvesResponse>() };
}

describe('shelves command center endpoint against a real database', () => {
  it('a play inside the week window counts toward mostPopular/kpis; a play outside it does not - "all" includes both', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    const insideMovie = await seedMovie({
      serverId: server.id,
      ratingKey: 'window-inside',
      title: 'Window Inside Movie',
      year: 2020,
      tmdbId: 900_001,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: insideMovie,
      ratingKey: 'window-inside',
      durationMs: 300_000,
      startedAt: new Date(Date.now() - 1 * DAY_MS),
    });

    const outsideMovie = await seedMovie({
      serverId: server.id,
      ratingKey: 'window-outside',
      title: 'Window Outside Movie',
      year: 2020,
      tmdbId: 900_002,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: outsideMovie,
      ratingKey: 'window-outside',
      durationMs: 300_000,
      startedAt: new Date(Date.now() - 10 * DAY_MS),
    });

    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=week');
    expect(statusCode).toBe(200);
    const popularIds = body.mostPopularMovies.map((r) => r.mediaId);
    expect(popularIds).toContain(insideMovie);
    expect(popularIds).not.toContain(outsideMovie);
    expect(body.kpis.watchedInPeriod.titlesTouched).toBe(1);

    const { body: allBody } = await fetchShelves(app, '?period=all');
    const allPopularIds = allBody.mostPopularMovies.map((r) => r.mediaId);
    expect(allPopularIds).toContain(insideMovie);
    expect(allPopularIds).toContain(outsideMovie);
    expect(allBody.kpis.watchedInPeriod.titlesTouched).toBe(2);
  });

  it('period=day counts a play from yesterdays UTC day bucket, not just todays partial bucket', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    // user_media_plays_daily.day is time_bucket('1 day', started_at) - always
    // midnight UTC of the session's calendar date. A session anywhere on
    // "yesterday" (relative to whenever this test runs) buckets to yesterday
    // 00:00 UTC, which sits before "now minus 24h" for any time of day except
    // exactly midnight, so this reliably lands on the wrong side of an
    // unbucketed comparison regardless of when the suite runs.
    const now = new Date();
    const yesterdayNoon = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12, 0, 0)
    );

    const movie = await seedMovie({
      serverId: server.id,
      ratingKey: 'day-bucket-yesterday',
      title: 'Day Bucket Yesterday Movie',
      year: 2020,
      tmdbId: 906_001,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: movie,
      ratingKey: 'day-bucket-yesterday',
      durationMs: 300_000,
      startedAt: yesterdayNoon,
    });

    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=day');
    expect(statusCode).toBe(200);
    expect(body.mostPopularMovies.map((r) => r.mediaId)).toContain(movie);
    expect(body.kpis.watchedInPeriod.titlesTouched).toBe(1);
    expect(body.kpis.hoursWatched).toBeGreaterThan(0);
  });

  it('period=week includes a play at the exact truncated window edge (day-bucket boundary, not a comfortable 1d/10d gap)', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    // Midnight UTC of the day exactly 7 days back. After truncation the
    // window's lower bound is this same instant, so the play lands right on
    // the boundary; before truncation the raw instant threshold (now - 7d)
    // falls later that same day, excluding it.
    const boundaryInstant = new Date(Date.now() - 7 * DAY_MS);
    const boundaryDayStart = new Date(
      Date.UTC(
        boundaryInstant.getUTCFullYear(),
        boundaryInstant.getUTCMonth(),
        boundaryInstant.getUTCDate(),
        0,
        0,
        0
      )
    );

    const movie = await seedMovie({
      serverId: server.id,
      ratingKey: 'week-boundary-edge',
      title: 'Week Boundary Edge Movie',
      year: 2020,
      tmdbId: 906_002,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: movie,
      ratingKey: 'week-boundary-edge',
      durationMs: 300_000,
      startedAt: boundaryDayStart,
    });

    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=week');
    expect(statusCode).toBe(200);
    expect(body.mostPopularMovies.map((r) => r.mediaId)).toContain(movie);
    expect(body.kpis.watchedInPeriod.titlesTouched).toBe(1);
  });

  it('a title played in-window but removed from the library does not surface in mostPopular or count toward titlesTouched', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    const movie = await seedMovie({
      serverId: server.id,
      ratingKey: 'removed-after-play',
      title: 'Removed After Play',
      year: 2020,
      tmdbId: 907_001,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: movie,
      ratingKey: 'removed-after-play',
      durationMs: 300_000,
    });
    await refreshPlaysAggregate();

    await db.execute(sql`UPDATE library_items SET removed_at = now() WHERE media_id = ${movie}`);

    const { statusCode, body } = await fetchShelves(app, '?period=all');
    expect(statusCode).toBe(200);
    expect(body.mostPopularMovies.map((r) => r.mediaId)).not.toContain(movie);
    // No active copy at all in this scope, so totalTitles is 0 too - the bug
    // this guards against is titlesTouched exceeding totalTitles (a ">100%
    // watched" ratio), which only this movie could trigger here.
    expect(body.kpis.watchedInPeriod.titlesTouched).toBe(0);
    expect(body.kpis.watchedInPeriod.totalTitles).toBe(0);
  });

  it('type-split shelves: a movie only appears in movie shelves, a show only in show shelves, an episode play rolls up to its show', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    const movie = await seedMovie({
      serverId: server.id,
      ratingKey: 'split-movie',
      title: 'Split Movie',
      year: 2019,
      tmdbId: 901_001,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: movie,
      ratingKey: 'split-movie',
      durationMs: 300_000,
    });

    const show = await seedShow({
      serverId: server.id,
      ratingKey: 'split-show',
      title: 'Split Show',
      year: 2019,
      tvdbId: 901_101,
    });
    const episode = await seedEpisode({
      serverId: server.id,
      ratingKey: 'split-show-ep1',
      title: 'Split Show E1',
      year: 2019,
      tvdbId: 901_111,
      showMediaId: show,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: episode,
      showMediaId: show,
      ratingKey: 'split-show-ep1',
      mediaType: 'episode',
      durationMs: 1_800_000,
    });

    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=all');
    expect(statusCode).toBe(200);

    expect(body.mostPopularMovies.map((r) => r.mediaId)).toContain(movie);
    expect(body.mostPopularShows.map((r) => r.mediaId)).not.toContain(movie);
    expect(body.mostPopularShows.map((r) => r.mediaId)).toContain(show);
    expect(body.mostPopularMovies.map((r) => r.mediaId)).not.toContain(show);
    // The episode itself never surfaces as its own canonical row - only the show does.
    expect(body.mostPopularShows.map((r) => r.mediaId)).not.toContain(episode);

    for (const row of body.recentlyAddedMovies) expect(row.mediaType).toBe('movie');
    for (const row of body.recentlyAddedShows) expect(row.mediaType).toBe('show');
    for (const row of body.mostPopularMovies) expect(row.mediaType).toBe('movie');
    for (const row of body.mostPopularShows) expect(row.mediaType).toBe('show');
  });

  it('recentlyAddedShows.newEpisodes counts distinct episodes added within the period, not every active episode copy', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const { app } = await buildApp(ownerFor());

    const show = await seedShow({
      serverId: serverA.id,
      ratingKey: 'new-ep-window-show',
      title: 'New Episode Window Show',
      year: 2015,
      tvdbId: 902_001,
    });

    // Three episodes from long before the (default month) window - a show
    // that has aired for years, not freshly added.
    for (let i = 0; i < 3; i++) {
      await seedEpisode({
        serverId: serverA.id,
        ratingKey: `new-ep-window-old-${i}`,
        title: `Old Episode ${i}`,
        year: 2015,
        tvdbId: 902_011 + i,
        showMediaId: show,
        addedAt: new Date(Date.now() - 90 * DAY_MS),
      });
    }

    // One genuinely new episode, mirrored on both servers - the copy on
    // serverB must not double-count it as two "new" episodes.
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'new-ep-window-fresh-a',
      title: 'Fresh Episode',
      year: 2015,
      tvdbId: 902_021,
      showMediaId: show,
      addedAt: new Date(),
    });
    await seedEpisode({
      serverId: serverB.id,
      ratingKey: 'new-ep-window-fresh-b',
      title: 'Fresh Episode',
      year: 2015,
      tvdbId: 902_021,
      showMediaId: show,
      addedAt: new Date(),
    });

    const { statusCode, body } = await fetchShelves(app, '?period=month');
    expect(statusCode).toBe(200);
    const row = body.recentlyAddedShows.find((r) => r.mediaId === show);
    expect(row).toBeDefined();
    expect(row!.newEpisodes).toBe(1);
  });

  it('newlyAdded counts titles added in the window, their bytes, and how many have ever been played', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    const playedRecent = await seedMovie({
      serverId: server.id,
      ratingKey: 'newly-played',
      title: 'Newly Added Played',
      year: 2022,
      tmdbId: 902_001,
      addedAt: new Date(Date.now() - 1 * DAY_MS),
      fileSize: 4_000_000,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: playedRecent,
      ratingKey: 'newly-played',
      durationMs: 300_000,
      startedAt: new Date(Date.now() - 1 * DAY_MS),
    });

    await seedMovie({
      serverId: server.id,
      ratingKey: 'newly-unplayed',
      title: 'Newly Added Unplayed',
      year: 2022,
      tmdbId: 902_002,
      addedAt: new Date(Date.now() - 1 * DAY_MS),
      fileSize: 6_000_000,
    });

    // Added well before the window - must not count toward newlyAdded.
    await seedMovie({
      serverId: server.id,
      ratingKey: 'newly-old',
      title: 'Old Addition',
      year: 2010,
      tmdbId: 902_003,
      addedAt: new Date(Date.now() - 60 * DAY_MS),
      fileSize: 9_000_000,
    });

    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=week');
    expect(statusCode).toBe(200);
    expect(body.kpis.newlyAdded).toEqual({
      count: 2,
      totalBytes: 10_000_000,
      playedCount: 1,
    });
  });

  it('newlyAdded.playedCount only counts plays on/after the titles own added date, not older history under the same canonical id', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    const addedAt = new Date(Date.now() - 2 * DAY_MS);

    // Simulates a re-add (same canonical media id resolved via external ids)
    // or an imported history backfill: the only play predates this title's
    // own library_items row, so it should NOT count as "played since added".
    const staleHistoryOnly = await seedMovie({
      serverId: server.id,
      ratingKey: 'newly-stale-history',
      title: 'Newly Added Stale History Only',
      year: 2021,
      tmdbId: 908_001,
      addedAt,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: staleHistoryOnly,
      ratingKey: 'newly-stale-history',
      durationMs: 300_000,
      startedAt: new Date(Date.now() - 30 * DAY_MS),
    });

    const freshlyWatched = await seedMovie({
      serverId: server.id,
      ratingKey: 'newly-fresh-watch',
      title: 'Newly Added Freshly Watched',
      year: 2021,
      tmdbId: 908_002,
      addedAt,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: freshlyWatched,
      ratingKey: 'newly-fresh-watch',
      durationMs: 300_000,
      startedAt: new Date(Date.now() - 1 * DAY_MS),
    });

    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=week');
    expect(statusCode).toBe(200);
    expect(body.kpis.newlyAdded.count).toBe(2);
    expect(body.kpis.newlyAdded.playedCount).toBe(1);
  });

  it('deadWeight is all-time (unaffected by a narrow window), orders by size desc, and excludes played titles', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    const played = await seedMovie({
      serverId: server.id,
      ratingKey: 'dw-played',
      title: 'Dead Weight Played',
      year: 2005,
      tmdbId: 903_001,
      addedAt: new Date(Date.now() - 90 * DAY_MS),
      fileSize: 50_000_000,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: played,
      ratingKey: 'dw-played',
      durationMs: 300_000,
      startedAt: new Date(Date.now() - 90 * DAY_MS),
    });

    const small = await seedMovie({
      serverId: server.id,
      ratingKey: 'dw-small',
      title: 'Dead Weight Small',
      year: 2006,
      tmdbId: 903_002,
      addedAt: new Date(Date.now() - 90 * DAY_MS),
      fileSize: 1_000_000,
    });
    const big = await seedMovie({
      serverId: server.id,
      ratingKey: 'dw-big',
      title: 'Dead Weight Big',
      year: 2007,
      tmdbId: 903_003,
      addedAt: new Date(Date.now() - 90 * DAY_MS),
      fileSize: 20_000_000,
    });

    await refreshPlaysAggregate();

    // Narrow window (day) - deadWeight totals must still cover all-time never-watched titles.
    const { statusCode, body } = await fetchShelves(app, '?period=day');
    expect(statusCode).toBe(200);
    const deadIds = body.deadWeight.map((r) => r.mediaId);
    expect(deadIds).not.toContain(played);
    expect(deadIds).toContain(big);
    expect(deadIds).toContain(small);
    expect(body.deadWeight.findIndex((r) => r.mediaId === big)).toBeLessThan(
      body.deadWeight.findIndex((r) => r.mediaId === small)
    );
    expect(body.kpis.deadWeight).toEqual({ count: 2, totalBytes: 21_000_000 });
    for (const row of body.deadWeight) expect(row.watchedState).toBe('unwatched');
  });

  it('deadWeight uses the same play test as the watched badge: an abandoned open is not a play', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const { app } = await buildApp(ownerFor());

    const abandoned = await seedMovie({
      serverId: server.id,
      ratingKey: 'dw-abandoned',
      title: 'Dead Weight Abandoned',
      year: 2008,
      tmdbId: 903_010,
      addedAt: new Date(Date.now() - 90 * DAY_MS),
      fileSize: 5_000_000,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: abandoned,
      ratingKey: 'dw-abandoned',
      durationMs: 30_000,
      startedAt: new Date(Date.now() - 80 * DAY_MS),
    });

    const shortFinish = await seedMovie({
      serverId: server.id,
      ratingKey: 'dw-short-finish',
      title: 'Dead Weight Short Finish',
      year: 2009,
      tmdbId: 903_011,
      addedAt: new Date(Date.now() - 90 * DAY_MS),
      fileSize: 6_000_000,
    });
    await seedSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: shortFinish,
      ratingKey: 'dw-short-finish',
      durationMs: 30_000,
      watched: true,
      startedAt: new Date(Date.now() - 80 * DAY_MS),
    });

    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=day');
    expect(statusCode).toBe(200);
    const deadIds = body.deadWeight.map((r) => r.mediaId);
    expect(deadIds).toContain(abandoned);
    expect(deadIds).not.toContain(shortFinish);
  });

  it('reports a null addedAt (not an empty string) for a dead-weight title with no latest_added_at', async () => {
    const server = await createTestServer({ type: 'plex' });
    const { app } = await buildApp(ownerFor());

    const noAddedAt = await seedMovie({
      serverId: server.id,
      ratingKey: 'dw-no-added-at',
      title: 'Dead Weight No Added At',
      year: 2008,
      tmdbId: 903_004,
      fileSize: 5_000_000,
    });
    await db.update(media).set({ latestAddedAt: null }).where(eq(media.id, noAddedAt));

    const { statusCode, body } = await fetchShelves(app, '?period=week');
    expect(statusCode).toBe(200);
    const row = body.deadWeight.find((r) => r.mediaId === noAddedAt);
    expect(row).toBeDefined();
    expect(row!.addedAt).toBeNull();
  });

  it('never serves a v1-shaped cached payload under the legacy key as a current response', async () => {
    const server = await createTestServer({ type: 'plex' });
    const { app, redis } = await buildApp(ownerFor());

    await seedMovie({
      serverId: server.id,
      ratingKey: 'v1-cache-movie',
      title: 'V1 Cache Movie',
      year: 2018,
      tmdbId: 904_001,
    });

    // A stale v1 payload sitting under the OLD unversioned key.
    const legacyKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_SHELVES, 'all');
    await redis.set(
      legacyKey,
      JSON.stringify({ recentlyAdded: [], mostWatched: [], neverWatched: [], meta: {} })
    );

    const { statusCode, body } = await fetchShelves(app, '?period=month');
    expect(statusCode).toBe(200);
    expect(body.kpis).toBeDefined();
    expect(body.recentlyAddedMovies.map((r) => r.title)).toContain('V1 Cache Movie');

    const versionedKey = buildLibraryCacheKey(
      `${REDIS_KEYS.LIBRARY_SHELVES}:v7`,
      'all',
      'month',
      undefined,
      'auto:dw1'
    );
    expect(await redis.get(versionedKey)).not.toBeNull();
    // The legacy key is untouched - proves the route never read or wrote it.
    expect(await redis.get(legacyKey)).not.toBeNull();
  });

  it('caches per (scope, period): a different period never reuses another periods cached shelves', async () => {
    const server = await createTestServer({ type: 'plex' });
    const { app, redis } = await buildApp(ownerFor());

    await seedMovie({
      serverId: server.id,
      ratingKey: 'period-cache-movie-1',
      title: 'Period Cache Movie One',
      year: 2015,
      tmdbId: 905_001,
    });

    const weekKey = buildLibraryCacheKey(
      `${REDIS_KEYS.LIBRARY_SHELVES}:v7`,
      'all',
      'week',
      undefined,
      'auto:dw1'
    );
    const weekKeyDw0 = buildLibraryCacheKey(
      `${REDIS_KEYS.LIBRARY_SHELVES}:v7`,
      'all',
      'week',
      undefined,
      'auto:dw0'
    );
    const yearKey = buildLibraryCacheKey(
      `${REDIS_KEYS.LIBRARY_SHELVES}:v7`,
      'all',
      'year',
      undefined,
      'auto:dw1'
    );
    expect(await redis.get(weekKey)).toBeNull();
    expect(await redis.get(yearKey)).toBeNull();

    await fetchShelves(app, '?period=week');
    expect(await redis.get(weekKey)).not.toBeNull();
    expect(await redis.get(yearKey)).toBeNull();

    // includeDeadWeight=false is a distinct cache entry, not a reuse of the dw1 one.
    expect(await redis.get(weekKeyDw0)).toBeNull();
    await fetchShelves(app, '?period=week&includeDeadWeight=false');
    expect(await redis.get(weekKeyDw0)).not.toBeNull();
    expect(await redis.get(weekKey)).not.toBeNull();

    // A second title added after the week-scoped cache was populated must not
    // surface in a week-period response (proves the week entry is being hit),
    // but a year-period request is a distinct cache entry and recomputes.
    const laterMovie = await seedMovie({
      serverId: server.id,
      ratingKey: 'period-cache-movie-2',
      title: 'Period Cache Movie Two (added after week cache)',
      year: 2016,
      tmdbId: 905_002,
    });

    const { body: weekBody } = await fetchShelves(app, '?period=week');
    expect(weekBody.recentlyAddedMovies.map((r) => r.mediaId)).not.toContain(laterMovie);

    const { body: yearBody } = await fetchShelves(app, '?period=year');
    expect(yearBody.recentlyAddedMovies.map((r) => r.mediaId)).toContain(laterMovie);
    expect(await redis.get(yearKey)).not.toBeNull();
  });

  it('reports meta counts and total size matching exactly the seeded scoped set', async () => {
    const server = await createTestServer({ type: 'plex' });
    const { app } = await buildApp(ownerFor());

    await seedMovie({
      serverId: server.id,
      ratingKey: 'meta-movie-1',
      title: 'Meta Movie One',
      year: 2001,
      tmdbId: 820_001,
      fileSize: 1_000_000,
    });
    await seedMovie({
      serverId: server.id,
      ratingKey: 'meta-movie-2',
      title: 'Meta Movie Two',
      year: 2002,
      tmdbId: 820_002,
      fileSize: 2_000_000,
    });
    await seedShow({
      serverId: server.id,
      ratingKey: 'meta-show-1',
      title: 'Meta Show One',
      year: 2003,
      tvdbId: 820_101,
      fileSize: 0,
    });

    const { statusCode, body } = await fetchShelves(app);
    expect(statusCode).toBe(200);
    expect(body.meta).toEqual({ movies: 2, shows: 1, totalFileSize: 3_000_000 });
    expect(body.kpis.watchedInPeriod.totalTitles).toBe(3);
  });

  it('scopes plays and shelves to the caller server, hiding another servers activity', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const viewer: AuthUser = {
      userId: randomUUID(),
      username: 'viewer',
      role: 'viewer',
      serverIds: [serverA.id],
    };
    const { app } = await buildApp(viewer);

    await seedMovie({
      serverId: serverA.id,
      ratingKey: 'scope-movie-a',
      title: 'Scope Movie A',
      year: 2011,
      tmdbId: 850_001,
    });
    await seedMovie({
      serverId: serverB.id,
      ratingKey: 'scope-movie-b',
      title: 'Scope Movie B',
      year: 2012,
      tmdbId: 850_002,
    });

    const { statusCode, body } = await fetchShelves(app);
    expect(statusCode).toBe(200);
    expect(body.meta.movies).toBe(1);
    const titles = body.recentlyAddedMovies.map((r) => r.title);
    expect(titles).toContain('Scope Movie A');
    expect(titles).not.toContain('Scope Movie B');
  });
});

describe('shelves size totals dedupe mirrored copies across servers (identical file_size = same physical file)', () => {
  const GB = 1_000_000_000;

  /** Seven canonical movies covering every dedupe case the rule has to get
   * right: a mirrored copy, distinct renditions, same-server editions, a
   * mirror-and-rendition mix, a real zero-byte size, a null size, and an
   * unaffected single copy. None are ever played, so they double as
   * deadWeight candidates; all are added "now", so they double as
   * newlyAdded candidates too. */
  async function seedSizeScenarios(serverA: string, serverB: string): Promise<void> {
    // M1 mirror: identical size on both servers counts once.
    await seedMovie({
      serverId: serverA,
      ratingKey: 'sh-m1-a',
      title: 'Shelf M1 Mirror',
      year: 2001,
      tmdbId: 990_001,
      fileSize: 10 * GB,
    });
    await seedMovie({
      serverId: serverB,
      ratingKey: 'sh-m1-b',
      title: 'Shelf M1 Mirror',
      year: 2001,
      tmdbId: 990_001,
      fileSize: 10 * GB,
    });

    // M2 renditions: different sizes on each server both count.
    await seedMovie({
      serverId: serverA,
      ratingKey: 'sh-m2-a',
      title: 'Shelf M2 Rendition',
      year: 2002,
      tmdbId: 990_002,
      fileSize: 4 * GB,
    });
    await seedMovie({
      serverId: serverB,
      ratingKey: 'sh-m2-b',
      title: 'Shelf M2 Rendition',
      year: 2002,
      tmdbId: 990_002,
      fileSize: 20 * GB,
    });

    // M3 same-server editions: two files on one server both count.
    await seedMovie({
      serverId: serverA,
      ratingKey: 'sh-m3-a1',
      title: 'Shelf M3 Editions',
      year: 2003,
      tmdbId: 990_003,
      fileSize: 8 * GB,
    });
    await seedMovie({
      serverId: serverA,
      ratingKey: 'sh-m3-a2',
      title: 'Shelf M3 Editions',
      year: 2003,
      tmdbId: 990_003,
      fileSize: 9 * GB,
    });

    // M4 both renditions on both servers: two distinct sizes, not four.
    await seedMovie({
      serverId: serverA,
      ratingKey: 'sh-m4-a1',
      title: 'Shelf M4 Both',
      year: 2004,
      tmdbId: 990_004,
      fileSize: 4 * GB,
    });
    await seedMovie({
      serverId: serverA,
      ratingKey: 'sh-m4-a2',
      title: 'Shelf M4 Both',
      year: 2004,
      tmdbId: 990_004,
      fileSize: 20 * GB,
    });
    await seedMovie({
      serverId: serverB,
      ratingKey: 'sh-m4-b1',
      title: 'Shelf M4 Both',
      year: 2004,
      tmdbId: 990_004,
      fileSize: 4 * GB,
    });
    await seedMovie({
      serverId: serverB,
      ratingKey: 'sh-m4-b2',
      title: 'Shelf M4 Both',
      year: 2004,
      tmdbId: 990_004,
      fileSize: 20 * GB,
    });

    // M5 zero-byte ghost copy: a real 0 is still its own distinct size.
    await seedMovie({
      serverId: serverA,
      ratingKey: 'sh-m5-a',
      title: 'Shelf M5 Ghost',
      year: 2005,
      tmdbId: 990_005,
      fileSize: 12 * GB,
    });
    await seedMovie({
      serverId: serverB,
      ratingKey: 'sh-m5-b',
      title: 'Shelf M5 Ghost',
      year: 2005,
      tmdbId: 990_005,
      fileSize: 0,
    });

    // M6 null file_size: a copy with unknown size never counts.
    await seedMovie({
      serverId: serverA,
      ratingKey: 'sh-m6-a',
      title: 'Shelf M6 Null',
      year: 2006,
      tmdbId: 990_006,
      fileSize: null,
    });
    await seedMovie({
      serverId: serverB,
      ratingKey: 'sh-m6-b',
      title: 'Shelf M6 Null',
      year: 2006,
      tmdbId: 990_006,
      fileSize: 5 * GB,
    });

    // M7 single copy: regression guard, unaffected by the DISTINCT change.
    await seedMovie({
      serverId: serverA,
      ratingKey: 'sh-m7-a',
      title: 'Shelf M7 Single',
      year: 2007,
      tmdbId: 990_007,
      fileSize: 7 * GB,
    });
  }

  it('all-server scope: meta, newlyAdded and deadWeight totals all sum each medias DISTINCT file sizes', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const { app } = await buildApp(ownerFor());
    await seedSizeScenarios(serverA.id, serverB.id);
    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=week');
    expect(statusCode).toBe(200);

    // 10 + 24 + 17 + 24 + 12 + 5 + 7 = 99 GB
    expect(body.meta.totalFileSize).toBe(99 * GB);
    expect(body.kpis.newlyAdded.count).toBe(7);
    expect(body.kpis.newlyAdded.totalBytes).toBe(99 * GB);
    expect(body.kpis.deadWeight.count).toBe(7);
    expect(body.kpis.deadWeight.totalBytes).toBe(99 * GB);

    const bytesByTitle = new Map(body.deadWeight.map((r) => [r.title, r.fileBytes]));
    expect(bytesByTitle.get('Shelf M1 Mirror')).toBe(10 * GB);
    expect(bytesByTitle.get('Shelf M2 Rendition')).toBe(24 * GB);
    expect(bytesByTitle.get('Shelf M3 Editions')).toBe(17 * GB);
    expect(bytesByTitle.get('Shelf M4 Both')).toBe(24 * GB);
    expect(bytesByTitle.get('Shelf M5 Ghost')).toBe(12 * GB);
    expect(bytesByTitle.get('Shelf M6 Null')).toBe(5 * GB);
    expect(bytesByTitle.get('Shelf M7 Single')).toBe(7 * GB);
  });

  it('server-scoped request sees only that servers own copies, not cross-server mirrors', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const { app } = await buildApp(ownerFor());
    await seedSizeScenarios(serverA.id, serverB.id);
    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, `?period=week&serverIds=${serverA.id}`);
    expect(statusCode).toBe(200);

    // 10 + 4 + 17 + 24 + 12 + 0 + 7 = 74 GB
    expect(body.meta.totalFileSize).toBe(74 * GB);
    expect(body.kpis.deadWeight.totalBytes).toBe(74 * GB);

    const bytesByTitle = new Map(body.deadWeight.map((r) => [r.title, r.fileBytes]));
    expect(bytesByTitle.get('Shelf M1 Mirror')).toBe(10 * GB);
    expect(bytesByTitle.get('Shelf M2 Rendition')).toBe(4 * GB);
    expect(bytesByTitle.get('Shelf M4 Both')).toBe(24 * GB);
    expect(bytesByTitle.get('Shelf M5 Ghost')).toBe(12 * GB);
    expect(bytesByTitle.get('Shelf M6 Null')).toBe(0);
    expect(bytesByTitle.get('Shelf M7 Single')).toBe(7 * GB);
  });
});

describe('TV show sizes roll up their episode files', () => {
  const GB = 1_000_000_000;

  it('all-server scope: show sizes sum each episodes DISTINCT-mirrored size; empty/null shows contribute zero; movie sizes stay unchanged; totals fold both types together', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const { app } = await buildApp(ownerFor());

    // Show 1: two episodes mirrored at equal size on both servers - each episode once. 3 + 4 = 7 GB.
    const show1 = await seedShow({
      serverId: serverA.id,
      ratingKey: 'tv-show1',
      title: 'TV Rollup Mirrored Episodes',
      year: 2010,
      tvdbId: 991_001,
    });
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'tv-show1-ep1-a',
      title: 'Episode 1',
      year: 2010,
      tvdbId: 991_011,
      showMediaId: show1,
      fileSize: 3 * GB,
    });
    await seedEpisode({
      serverId: serverB.id,
      ratingKey: 'tv-show1-ep1-b',
      title: 'Episode 1',
      year: 2010,
      tvdbId: 991_011,
      showMediaId: show1,
      fileSize: 3 * GB,
    });
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'tv-show1-ep2-a',
      title: 'Episode 2',
      year: 2010,
      tvdbId: 991_012,
      showMediaId: show1,
      fileSize: 4 * GB,
    });
    await seedEpisode({
      serverId: serverB.id,
      ratingKey: 'tv-show1-ep2-b',
      title: 'Episode 2',
      year: 2010,
      tvdbId: 991_012,
      showMediaId: show1,
      fileSize: 4 * GB,
    });

    // Show 2: one episode with a distinct rendition on each server - both count. 4 + 20 = 24 GB.
    const show2 = await seedShow({
      serverId: serverA.id,
      ratingKey: 'tv-show2',
      title: 'TV Rollup Rendition Episode',
      year: 2011,
      tvdbId: 991_002,
    });
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'tv-show2-ep1-a',
      title: 'Episode 1',
      year: 2011,
      tvdbId: 991_021,
      showMediaId: show2,
      fileSize: 4 * GB,
    });
    await seedEpisode({
      serverId: serverB.id,
      ratingKey: 'tv-show2-ep1-b',
      title: 'Episode 1',
      year: 2011,
      tvdbId: 991_021,
      showMediaId: show2,
      fileSize: 20 * GB,
    });

    // Show 3: three distinct episodes at the same size, no mirrors - summed, not deduped against each other. 2*3 = 6 GB.
    const show3 = await seedShow({
      serverId: serverA.id,
      ratingKey: 'tv-show3',
      title: 'TV Rollup Distinct Episodes',
      year: 2012,
      tvdbId: 991_003,
    });
    for (const [index, key] of ['ep1', 'ep2', 'ep3'].entries()) {
      await seedEpisode({
        serverId: serverA.id,
        ratingKey: `tv-show3-${key}`,
        title: `Episode ${index + 1}`,
        year: 2012,
        tvdbId: 991_030 + index + 1,
        showMediaId: show3,
        fileSize: 2 * GB,
      });
    }

    // Show 4: no episodes at all - container has no file_size of its own, so 0.
    await seedShow({
      serverId: serverA.id,
      ratingKey: 'tv-show4',
      title: 'TV Rollup Empty Show',
      year: 2013,
      tvdbId: 991_004,
    });

    // Show 5: one episode with an unknown (NULL) size - never counted.
    const show5 = await seedShow({
      serverId: serverA.id,
      ratingKey: 'tv-show5',
      title: 'TV Rollup Null Episode',
      year: 2014,
      tvdbId: 991_005,
    });
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'tv-show5-ep1',
      title: 'Episode 1',
      year: 2014,
      tvdbId: 991_051,
      showMediaId: show5,
      fileSize: null,
    });

    // Movie regression guard: mirrored on both servers at equal size - the episode rollup must not touch this. 10 GB.
    await seedMovie({
      serverId: serverA.id,
      ratingKey: 'tv-rollup-movie-a',
      title: 'TV Rollup Regression Movie',
      year: 2015,
      tmdbId: 991_101,
      fileSize: 10 * GB,
    });
    await seedMovie({
      serverId: serverB.id,
      ratingKey: 'tv-rollup-movie-b',
      title: 'TV Rollup Regression Movie',
      year: 2015,
      tmdbId: 991_101,
      fileSize: 10 * GB,
    });

    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=week');
    expect(statusCode).toBe(200);

    const bytesByTitle = new Map(body.deadWeight.map((r) => [r.title, r.fileBytes]));
    expect(bytesByTitle.get('TV Rollup Mirrored Episodes')).toBe(7 * GB);
    expect(bytesByTitle.get('TV Rollup Rendition Episode')).toBe(24 * GB);
    expect(bytesByTitle.get('TV Rollup Distinct Episodes')).toBe(6 * GB);
    expect(bytesByTitle.get('TV Rollup Empty Show')).toBe(0);
    expect(bytesByTitle.get('TV Rollup Null Episode')).toBe(0);
    expect(bytesByTitle.get('TV Rollup Regression Movie')).toBe(10 * GB);

    // None of these six titles were ever played, and all were just added - so
    // the header, dead-weight, and newly-added totals must all agree.
    // 7 + 24 + 6 + 0 + 0 + 10 = 47 GB.
    expect(body.meta.totalFileSize).toBe(47 * GB);
    expect(body.kpis.deadWeight.count).toBe(6);
    expect(body.kpis.deadWeight.totalBytes).toBe(47 * GB);
    expect(body.kpis.newlyAdded.count).toBe(6);
    expect(body.kpis.newlyAdded.totalBytes).toBe(47 * GB);
  });

  it('server-scoped request: a shows size only counts episode copies present on the requested server', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const { app } = await buildApp(ownerFor());

    // Mirrored show: both episodes present on server A, so server A alone sees the full 7 GB.
    const mirroredShow = await seedShow({
      serverId: serverA.id,
      ratingKey: 'tv-scope-show1',
      title: 'TV Rollup Scoped Mirrored',
      year: 2016,
      tvdbId: 991_201,
    });
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'tv-scope-show1-ep1-a',
      title: 'Episode 1',
      year: 2016,
      tvdbId: 991_211,
      showMediaId: mirroredShow,
      fileSize: 3 * GB,
    });
    await seedEpisode({
      serverId: serverB.id,
      ratingKey: 'tv-scope-show1-ep1-b',
      title: 'Episode 1',
      year: 2016,
      tvdbId: 991_211,
      showMediaId: mirroredShow,
      fileSize: 3 * GB,
    });
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'tv-scope-show1-ep2-a',
      title: 'Episode 2',
      year: 2016,
      tvdbId: 991_212,
      showMediaId: mirroredShow,
      fileSize: 4 * GB,
    });
    await seedEpisode({
      serverId: serverB.id,
      ratingKey: 'tv-scope-show1-ep2-b',
      title: 'Episode 2',
      year: 2016,
      tvdbId: 991_212,
      showMediaId: mirroredShow,
      fileSize: 4 * GB,
    });

    // Rendition show: the 4k copy only exists on server B, so server A only sees the 1080p 4 GB copy.
    const renditionShow = await seedShow({
      serverId: serverA.id,
      ratingKey: 'tv-scope-show2',
      title: 'TV Rollup Scoped Rendition',
      year: 2017,
      tvdbId: 991_202,
    });
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'tv-scope-show2-ep1-a',
      title: 'Episode 1',
      year: 2017,
      tvdbId: 991_221,
      showMediaId: renditionShow,
      fileSize: 4 * GB,
    });
    await seedEpisode({
      serverId: serverB.id,
      ratingKey: 'tv-scope-show2-ep1-b',
      title: 'Episode 1',
      year: 2017,
      tvdbId: 991_221,
      showMediaId: renditionShow,
      fileSize: 20 * GB,
    });

    const { statusCode, body } = await fetchShelves(app, `?period=week&serverIds=${serverA.id}`);
    expect(statusCode).toBe(200);
    const bytesByTitle = new Map(body.deadWeight.map((r) => [r.title, r.fileBytes]));
    expect(bytesByTitle.get('TV Rollup Scoped Mirrored')).toBe(7 * GB);
    expect(bytesByTitle.get('TV Rollup Scoped Rendition')).toBe(4 * GB);
  });

  it('a shows own container row never contributes bytes, even when it carries a non-zero file_size', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const { app } = await buildApp(ownerFor());

    // The container row itself has a non-zero size (something the app never
    // writes today, but nothing in the schema forbids it). Only the two
    // episodes should count: 5 + 6 = 11 GB, NOT 3 (container) + 11.
    const show = await seedShow({
      serverId: serverA.id,
      ratingKey: 'tv-guard-show1',
      title: 'TV Rollup Container Size Guard',
      year: 2018,
      tvdbId: 991_301,
      fileSize: 3 * GB,
    });
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'tv-guard-show1-ep1',
      title: 'Episode 1',
      year: 2018,
      tvdbId: 991_311,
      showMediaId: show,
      fileSize: 5 * GB,
    });
    await seedEpisode({
      serverId: serverA.id,
      ratingKey: 'tv-guard-show1-ep2',
      title: 'Episode 2',
      year: 2018,
      tvdbId: 991_312,
      showMediaId: show,
      fileSize: 6 * GB,
    });

    await refreshPlaysAggregate();

    const { statusCode, body } = await fetchShelves(app, '?period=week');
    expect(statusCode).toBe(200);
    const bytesByTitle = new Map(body.deadWeight.map((r) => [r.title, r.fileBytes]));
    expect(bytesByTitle.get('TV Rollup Container Size Guard')).toBe(11 * GB);
    expect(body.meta.totalFileSize).toBe(11 * GB);
    expect(body.kpis.deadWeight.totalBytes).toBe(11 * GB);
    expect(body.kpis.newlyAdded.totalBytes).toBe(11 * GB);
  });
});

describe('shelves preferred poster source', () => {
  it('folds the preference into the cache key: changing it is never served a stale poster from the auto-key cache', async () => {
    await setSetting('preferredPosterServerId', null);
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const { app, redis } = await buildApp(ownerFor());

    const movieId = await seedMovie({
      serverId: serverA.id,
      ratingKey: 'shelf-poster-pref-a',
      title: 'Shelf Poster Preference Movie',
      year: 2022,
      tmdbId: 906_001,
      addedAt: new Date('2026-01-01T00:00:00Z'),
      thumbPath: '/a/thumb.jpg',
    });
    const itemB = await createTestLibraryItem({
      serverId: serverB.id,
      ratingKey: 'shelf-poster-pref-b',
      title: 'Shelf Poster Preference Movie',
      mediaType: 'movie',
      mediaId: movieId,
    });
    await db.execute(sql`
      UPDATE library_items SET created_at = ${'2026-02-01T00:00:00Z'}::timestamptz,
        thumb_path = '/b/thumb.jpg'
      WHERE id = ${itemB.id}
    `);

    // No preference: the auto key caches server B's (newest) poster.
    const { body: autoBody } = await fetchShelves(app, '?period=year');
    const autoRow = autoBody.recentlyAddedMovies.find((r) => r.mediaId === movieId)!;
    expect(autoRow.posterUrl).toContain(`server=${serverB.id}`);
    expect(autoRow.posterUrl).toContain('width=360');
    expect(autoRow.posterUrl).toContain('height=540');
    expect(autoRow.posterUrl).toContain(`v=${autoRow.posterVersion}`);

    const autoKey = buildLibraryCacheKey(
      `${REDIS_KEYS.LIBRARY_SHELVES}:v7`,
      'all',
      'year',
      undefined,
      'auto:dw1'
    );
    expect(await redis.get(autoKey)).not.toBeNull();

    // Switching the preference to server A must not reuse the auto-key cache
    // entry - it needs its own key, or this request would incorrectly serve
    // back server B's already-cached poster.
    await setSetting('preferredPosterServerId', serverA.id);
    const preferredKey = buildLibraryCacheKey(
      `${REDIS_KEYS.LIBRARY_SHELVES}:v7`,
      'all',
      'year',
      undefined,
      `${serverA.id}:dw1`
    );
    expect(await redis.get(preferredKey)).toBeNull();

    const { body: preferredBody } = await fetchShelves(app, '?period=year');
    const preferredRow = preferredBody.recentlyAddedMovies.find((r) => r.mediaId === movieId)!;
    expect(preferredRow.posterUrl).toContain(`server=${serverA.id}`);
    expect(await redis.get(preferredKey)).not.toBeNull();
    // The earlier auto-key entry is untouched, not overwritten in place.
    expect(await redis.get(autoKey)).not.toBeNull();

    await setSetting('preferredPosterServerId', null);
  });
});

describe('shelves cache invalidation on library sync', () => {
  afterAll(async () => {
    await shutdownLibrarySyncQueue();
  });

  it('a sync invalidates the versioned cached shelves key', async () => {
    initLibrarySyncQueue(process.env.REDIS_URL ?? 'redis://localhost:6380');
    const key = buildLibraryCacheKey(`${REDIS_KEYS.LIBRARY_SHELVES}:v7`, 'all', 'month');
    const { getRedis } = await import('../../src/lib/redisShared.js');
    const redis = getRedis();
    await redis.set(key, JSON.stringify({ marker: true }));
    expect(await redis.get(key)).not.toBeNull();

    await invalidateLibraryCaches(randomUUID());

    expect(await redis.get(key)).toBeNull();
  });
});
