/**
 * Library Watch tab against a real database: the summary reads user_media_plays_daily by media
 * identity within the page's window, patterns read raw sessions within the same window.
 *
 * Run with: pnpm --filter @tracearr/server test:integration libraryWatch
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import type { AuthUser, PatternsResponse, WatchResponse } from '@tracearr/shared';
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
import { libraryWatchRoute } from '../../src/routes/library/watch.js';
import { libraryPatternsRoute } from '../../src/routes/library/patterns.js';
import { getMediaStats } from '../../src/services/library/mediaDetailService.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const TODAY = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const daysAgo = (days: number, offsetMs = 0) =>
  new Date(TODAY - days * DAY_MS + DAY_MS / 2 + offsetMs);

let app: FastifyInstance | undefined;

async function get<T>(url: string): Promise<T> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
  if (!app) {
    const owner: AuthUser = {
      userId: crypto.randomUUID(),
      username: 'owner',
      role: 'owner',
      serverIds: [],
    };
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: FastifyRequest) => {
      (request as FastifyRequest & { user: AuthUser }).user = owner;
    });
    app.decorate('requirePermission', permissionGuard(app));
    app.decorate('redis', getRedis() as never);
    await app.register(libraryWatchRoute, { prefix: '/library' });
    await app.register(libraryPatternsRoute, { prefix: '/library' });
  }
  await getRedis().flushdb();
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as T;
}

const watchSummary = async (query = '') =>
  (await get<WatchResponse>(`/library/watch?${query}`)).summary;

async function account(serverId: string): Promise<string> {
  const user = await createTestUser({ role: 'member' });
  return (await createTestServerUser({ userId: user.id, serverId })).id;
}

async function addMovie(serverId: string, ratingKey: string, title: string, tmdbId: number) {
  const mediaId = await resolveMediaForItem({
    mediaType: 'movie',
    tmdbId,
    title,
    year: 2020,
    serverId,
    ratingKey,
  });
  await createTestLibraryItem({ serverId, ratingKey, title, mediaType: 'movie', mediaId });
  return mediaId;
}

async function addShow(serverId: string, title: string, tvdbId: number) {
  return resolveMediaForItem({
    mediaType: 'show',
    tvdbId,
    title,
    year: 2019,
    serverId,
    ratingKey: `show-${tvdbId}`,
  });
}

async function addEpisode(serverId: string, showId: string, tvdbId: number, inLibrary = true) {
  const ratingKey = `ep-${tvdbId}`;
  const mediaId = await resolveMediaForItem({
    mediaType: 'episode',
    tvdbId,
    title: `Episode ${tvdbId}`,
    serverId,
    ratingKey,
    showMediaId: showId,
  });
  if (inLibrary) {
    await createTestLibraryItem({
      serverId,
      ratingKey,
      title: `Episode ${tvdbId}`,
      mediaType: 'episode',
      mediaId,
    });
  }
  return mediaId;
}

async function play(opts: {
  serverId: string;
  serverUserId: string;
  mediaId: string;
  showMediaId?: string;
  ratingKey: string;
  startedAt: Date;
  durationMs: number;
  progressMs?: number;
  watched?: boolean;
  referenceId?: string;
}): Promise<string> {
  const session = await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    mediaId: opts.mediaId,
    showMediaId: opts.showMediaId ?? null,
    mediaType: opts.showMediaId ? 'episode' : 'movie',
    ratingKey: opts.ratingKey,
    state: 'stopped',
    startedAt: opts.startedAt,
    stoppedAt: new Date(opts.startedAt.getTime() + opts.durationMs),
    durationMs: opts.durationMs,
    totalDurationMs: 2 * HOUR_MS,
    progressMs: opts.progressMs ?? opts.durationMs,
    watched: opts.watched ?? false,
    referenceId: opts.referenceId ?? null,
  });
  return session.id;
}

/** Episodes played back to back, 25 minutes each, starting every 30 minutes. */
async function binge(opts: {
  serverId: string;
  serverUserId: string;
  showId: string;
  episodes: string[];
  startedAt: Date;
}): Promise<void> {
  for (const [i, mediaId] of opts.episodes.entries()) {
    await play({
      serverId: opts.serverId,
      serverUserId: opts.serverUserId,
      mediaId,
      showMediaId: opts.showId,
      ratingKey: `rk-${mediaId}`,
      startedAt: new Date(opts.startedAt.getTime() + i * 30 * MIN_MS),
      durationMs: 25 * MIN_MS,
    });
  }
}

/** The same movie on two servers, played on both, plus a movie only on A. */
async function seedMovieOnTwoServers() {
  const serverA = await createTestServer({ type: 'plex' });
  const serverB = await createTestServer({ type: 'jellyfin' });
  const userA = await account(serverA.id);
  const userB = await account(serverB.id);
  const movieId = await addMovie(serverA.id, 'rk-a', 'Lantern Bay', 9001);
  expect(await addMovie(serverB.id, 'rk-b', 'Lantern Bay', 9001)).toBe(movieId);
  await addMovie(serverA.id, 'rk-a2', 'Gravel Pass', 9002);
  await play({
    serverId: serverA.id,
    serverUserId: userA,
    mediaId: movieId,
    ratingKey: 'rk-a',
    startedAt: daysAgo(2),
    durationMs: 2 * HOUR_MS,
    watched: true,
  });
  await play({
    serverId: serverB.id,
    serverUserId: userB,
    mediaId: movieId,
    ratingKey: 'rk-b',
    startedAt: daysAgo(3),
    durationMs: HOUR_MS / 2,
  });
  return { serverA, serverB };
}

beforeEach(async () => {
  await getRedis().flushdb();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('library watch summary', () => {
  it('counts watch time in the window by media identity and matches getMediaStats', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie(server.id, 'rk-new', 'Paper Kites', 9101);
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'rk-old',
      startedAt: daysAgo(2),
      durationMs: HOUR_MS,
    });
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'rk-new',
      startedAt: daysAgo(45),
      durationMs: 2 * HOUR_MS,
    });

    const summary = await watchSummary();
    const stats = await getMediaStats(
      { kind: 'media', aliases: [movieId], seasonNumber: null, showAliases: [] },
      undefined,
      'all'
    );

    expect(summary.totalWatchMs).toBe(HOUR_MS);
    expect(summary.totalWatchMs).toBe(stats.last_30.combined.watch_time_ms);
    expect(summary.watchedCount).toBe(1);
    expect(summary.avgPlaysPerItem).toBe(1);
    expect(summary.avgPlaysPerItem * summary.totalItems).toBe(stats.last_30.combined.plays);
    expect((await watchSummary('period=all')).totalWatchMs).toBe(3 * HOUR_MS);
  });

  it('covers exactly 30 UTC days ending today for the 30d preset, like the show page', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie(server.id, 'rk-edge', 'Salt Lantern', 9102);
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'rk-edge',
      startedAt: daysAgo(30),
      durationMs: 2 * HOUR_MS,
    });
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'rk-edge',
      startedAt: daysAgo(29),
      durationMs: HOUR_MS,
    });

    const summary = await watchSummary('period=30d');
    const stats = await getMediaStats(
      { kind: 'media', aliases: [movieId], seasonNumber: null, showAliases: [] },
      undefined,
      'all'
    );

    expect(summary.totalWatchMs).toBe(HOUR_MS);
    expect(summary.totalWatchMs).toBe(stats.last_30.combined.watch_time_ms);
    expect(summary.avgPlaysPerItem * summary.totalItems).toBe(stats.last_30.combined.plays);
  });

  it('does not count a short chain seeked past 85% as completed', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie(server.id, 'rk-1', 'Opal Steps', 9251);
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'rk-1',
      startedAt: daysAgo(2),
      durationMs: MIN_MS,
      progressMs: 110 * MIN_MS,
    });

    const summary = await watchSummary();

    expect(summary.watchedCount).toBe(0);
    expect(summary.completion.movie).toEqual({ completed: 0, inProgress: 0, notStarted: 1 });
  });

  it('classifies completed, in progress and not started within the window', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const watched = await addMovie(server.id, 'rk-1', 'Amber Coast', 9201);
    const halfway = await addMovie(server.id, 'rk-2', 'Birch Hollow', 9202);
    const nearEnd = await addMovie(server.id, 'rk-3', 'Cinder Lake', 9203);
    await addMovie(server.id, 'rk-4', 'Dune Street', 9204);
    const showId = await addShow(server.id, 'Echo Valley', 9300);
    const ep1 = await addEpisode(server.id, showId, 9301);
    await addEpisode(server.id, showId, 9302);

    const common = { serverId: server.id, serverUserId: user, startedAt: daysAgo(4) };
    await play({
      ...common,
      mediaId: watched,
      ratingKey: 'rk-1',
      durationMs: HOUR_MS,
      watched: true,
    });
    await play({ ...common, mediaId: halfway, ratingKey: 'rk-2', durationMs: HOUR_MS / 2 });
    await play({
      ...common,
      mediaId: nearEnd,
      ratingKey: 'rk-3',
      durationMs: HOUR_MS,
      progressMs: 110 * MIN_MS,
    });
    await play({
      ...common,
      mediaId: ep1,
      showMediaId: showId,
      ratingKey: 'ep-9301',
      durationMs: HOUR_MS,
      watched: true,
    });

    const summary = await watchSummary();

    expect(summary.totalItems).toBe(6);
    expect(summary.watchedCount).toBe(4);
    expect(summary.watchedPct).toBe(66.7);
    expect(summary.completion.movie).toEqual({ completed: 2, inProgress: 1, notStarted: 1 });
    expect(summary.completion.episode).toEqual({ completed: 1, inProgress: 0, notStarted: 1 });
  });

  it('counts a title whose only play is outside the window as not started', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie(server.id, 'rk-1', 'Frost Meadow', 9401);
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'rk-1',
      startedAt: daysAgo(60),
      durationMs: 2 * HOUR_MS,
      watched: true,
    });

    const ranged = await watchSummary();
    const allTime = await watchSummary('period=all');

    expect(ranged.completion.movie).toEqual({ completed: 0, inProgress: 0, notStarted: 1 });
    expect(ranged.watchedCount).toBe(0);
    expect(ranged.totalWatchMs).toBe(0);
    expect(allTime.completion.movie).toEqual({ completed: 1, inProgress: 0, notStarted: 0 });
  });

  it('keeps totalItems as the unranged inventory', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const played = await addMovie(server.id, 'rk-1', 'Granite Falls', 9501);
    await addMovie(server.id, 'rk-2', 'Hazel Row', 9502);
    await addMovie(server.id, 'rk-3', 'Iris Point', 9503);
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: played,
      ratingKey: 'rk-1',
      startedAt: daysAgo(1),
      durationMs: HOUR_MS,
    });

    const week = await watchSummary('period=7d');
    const allTime = await watchSummary('period=all');
    const past = await watchSummary(
      'startDate=2025-01-01T00:00:00.000Z&endDate=2025-02-01T00:00:00.000Z'
    );

    expect([week.totalItems, allTime.totalItems, past.totalItems]).toEqual([3, 3, 3]);
    expect(week.watchedCount).toBe(1);
    expect(past.watchedCount).toBe(0);
    expect(past.completion.movie.notStarted).toBe(3);
  });

  it("counts a title on two selected servers once in totalItems and sums both servers' plays", async () => {
    const { serverA, serverB } = await seedMovieOnTwoServers();

    const summary = await watchSummary(`serverIds=${serverA.id}&serverIds=${serverB.id}`);

    expect(summary.totalItems).toBe(2);
    expect(summary.watchedCount).toBe(1);
    expect(summary.totalWatchMs).toBe(2.5 * HOUR_MS);
    expect(summary.avgPlaysPerItem).toBe(1);
    expect(summary.completion.movie).toEqual({ completed: 1, inProgress: 0, notStarted: 1 });
  });

  it('narrows every count to one server when one is selected', async () => {
    const { serverA, serverB } = await seedMovieOnTwoServers();

    const onlyB = await watchSummary(`serverIds=${serverB.id}`);
    const onlyA = await watchSummary(`serverIds=${serverA.id}`);

    expect(onlyB.totalItems).toBe(1);
    expect(onlyB.totalWatchMs).toBe(HOUR_MS / 2);
    expect(onlyB.completion.movie).toEqual({ completed: 0, inProgress: 1, notStarted: 0 });
    expect(onlyA.totalItems).toBe(2);
    expect(onlyA.totalWatchMs).toBe(2 * HOUR_MS);
    expect(onlyA.completion.movie).toEqual({ completed: 1, inProgress: 0, notStarted: 1 });
  });
});

describe('library watch patterns', () => {
  it('returns no busiest or quietest bucket when the window has no plays', async () => {
    const server = await createTestServer({ type: 'plex' });
    await addMovie(server.id, 'rk-idle', 'Quiet Harbor', 9590);

    const { trend } = await get<PatternsResponse>('/library/patterns?period=7d&timezone=UTC');

    expect(trend.points.length).toBeGreaterThan(0);
    expect(trend.points.every((p) => p.watchCount === 0)).toBe(true);
    expect(trend.busiest).toBeNull();
    expect(trend.quietest).toBeNull();
  });

  it('buckets a 7-day range by day and a 1-year range by month', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie(server.id, 'rk-1', 'Juniper Ridge', 9601);
    for (const days of [1, 3, 3, 100]) {
      await play({
        serverId: server.id,
        serverUserId: user,
        mediaId: movieId,
        ratingKey: 'rk-1',
        startedAt: daysAgo(days),
        durationMs: HOUR_MS,
      });
    }

    const week = (await get<PatternsResponse>('/library/patterns?period=7d&timezone=UTC')).trend;
    const year = (await get<PatternsResponse>('/library/patterns?period=1y&timezone=UTC')).trend;
    const total = (points: PatternsResponse['trend']['points']) =>
      points.reduce((sum, p) => sum + p.watchCount, 0);

    expect(week.bucket).toBe('day');
    expect(total(week.points)).toBe(3);
    expect(week.points.find((p) => p.watchCount > 0)?.start).toBe(
      daysAgo(3).toISOString().slice(0, 10)
    );
    expect(week.busiest).toBe(daysAgo(3).toISOString().slice(0, 10));
    expect(year.bucket).toBe('month');
    expect(total(year.points)).toBe(4);
    expect(year.points.every((p) => p.start.endsWith('-01'))).toBe(true);
  });

  it("excludes sessions after a custom range's end", async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie(server.id, 'rk-1', 'Kestrel Bend', 9701);
    for (const startedAt of ['2026-03-12T23:30:00.000Z', '2026-03-13T00:30:00.000Z']) {
      await play({
        serverId: server.id,
        serverUserId: user,
        mediaId: movieId,
        ratingKey: 'rk-1',
        startedAt: new Date(startedAt),
        durationMs: HOUR_MS,
      });
    }

    const body = await get<PatternsResponse>(
      '/library/patterns?timezone=UTC&startDate=2026-03-10T00:00:00.000Z&endDate=2026-03-13T00:00:00.000Z'
    );

    expect(body.peakTimes.hourlyDistribution).toEqual([
      expect.objectContaining({ hour: 23, watchCount: 1 }),
    ]);
    expect(body.trend.bucket).toBe('day');
    expect(body.trend.points.map((p) => [p.start, p.watchCount])).toEqual([
      ['2026-03-10', 0],
      ['2026-03-11', 0],
      ['2026-03-12', 1],
    ]);
  });

  it('counts plays of a re-added title in the hourly distribution', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie(server.id, 'rk-new', 'Linden Gate', 9801);
    const common = {
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'rk-old',
    };
    const first = await play({ ...common, startedAt: daysAgo(2), durationMs: HOUR_MS / 4 });
    await play({
      ...common,
      startedAt: daysAgo(2, HOUR_MS / 2),
      durationMs: HOUR_MS / 4,
      referenceId: first,
    });

    const body = await get<PatternsResponse>('/library/patterns?timezone=UTC');

    expect(body.peakTimes.hourlyDistribution).toEqual([
      expect.objectContaining({ hour: 12, watchCount: 1, pctOfTotal: 100 }),
    ]);
    expect(body.trend.points.reduce((sum, p) => sum + p.watchCount, 0)).toBe(1);
  });

  it('computes binge numbers from the range only', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const showId = await addShow(server.id, 'Marrow Creek', 9900);
    const episodes: string[] = [];
    for (let n = 1; n <= 9; n++) episodes.push(await addEpisode(server.id, showId, 9900 + n));
    const oldShowId = await addShow(server.id, 'Nettle Hill', 9950);
    const oldEpisodes: string[] = [];
    for (let n = 1; n <= 5; n++) oldEpisodes.push(await addEpisode(server.id, oldShowId, 9950 + n));

    const common = { serverId: server.id, serverUserId: user };
    await binge({ ...common, showId, episodes: episodes.slice(0, 5), startedAt: daysAgo(60) });
    await binge({ ...common, showId, episodes: episodes.slice(5), startedAt: daysAgo(2) });
    await binge({ ...common, showId: oldShowId, episodes: oldEpisodes, startedAt: daysAgo(60) });

    const ranged = await get<PatternsResponse>('/library/patterns?timezone=UTC');
    const allTime = await get<PatternsResponse>('/library/patterns?period=all&timezone=UTC');

    expect(ranged.bingeShows).toHaveLength(1);
    expect(ranged.bingeShows[0]).toMatchObject({
      showTitle: 'Marrow Creek',
      primaryServerId: server.id,
      serverIds: [server.id],
      totalEpisodeWatches: 4,
      consecutiveEpisodes: 3,
      consecutivePct: 75,
      maxEpisodesInOneDay: 4,
      people: 1,
    });
    expect(allTime.bingeShows.map((b) => [b.showTitle, b.totalEpisodeWatches])).toEqual([
      ['Marrow Creek', 9],
      ['Nettle Hill', 5],
    ]);
  });

  it('keeps two shows that share a title apart in binge highlights', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const common = { serverId: server.id, serverUserId: user };
    const showIds: string[] = [];
    for (const [tvdbId, day] of [
      [9960, 2],
      [9970, 3],
    ] as const) {
      const showId = await addShow(server.id, 'Northern Line', tvdbId);
      showIds.push(showId);
      const episodes: string[] = [];
      for (let n = 1; n <= 4; n++) episodes.push(await addEpisode(server.id, showId, tvdbId + n));
      await binge({ ...common, showId, episodes, startedAt: daysAgo(day) });
    }

    const body = await get<PatternsResponse>('/library/patterns?timezone=UTC');

    expect(body.bingeShows.map((b) => [b.showTitle, b.totalEpisodeWatches])).toEqual([
      ['Northern Line', 4],
      ['Northern Line', 4],
    ]);
    expect(body.bingeShows.map((b) => b.showMediaId).sort()).toEqual(showIds.sort());
  });

  /** E1 paused and resumed after 5 minutes, then E2 and E3 each 10 minutes after the last stop. */
  async function seedPausedBinge() {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const showId = await addShow(server.id, 'Copper Sound', 10_100);
    const e1 = await addEpisode(server.id, showId, 10_101);
    const e2 = await addEpisode(server.id, showId, 10_102);
    const e3 = await addEpisode(server.id, showId, 10_103);
    const common = { serverId: server.id, serverUserId: user, showMediaId: showId };
    const at = (minutes: number) => daysAgo(2, minutes * MIN_MS);
    const segment = { ...common, mediaId: e1, ratingKey: 'rk-e1', durationMs: 20 * MIN_MS };
    const first = await play({ ...segment, startedAt: at(0) });
    await play({ ...segment, startedAt: at(25), referenceId: first });
    for (const [mediaId, start] of [
      [e2, 55],
      [e3, 90],
    ] as const) {
      await play({
        ...common,
        mediaId,
        ratingKey: `rk-${mediaId}`,
        startedAt: at(start),
        durationMs: 25 * MIN_MS,
      });
    }
  }

  it('counts a pause and resume as one play, not a consecutive episode', async () => {
    await seedPausedBinge();

    const body = await get<PatternsResponse>('/library/patterns?timezone=UTC&bingeThreshold=2');

    expect(body.bingeShows).toHaveLength(1);
    expect(body.bingeShows[0]).toMatchObject({
      showTitle: 'Copper Sound',
      totalEpisodeWatches: 3,
      consecutiveEpisodes: 2,
      people: 1,
    });
  });

  it('summary reports the share of episode plays that were consecutive', async () => {
    await seedPausedBinge();

    const body = await get<PatternsResponse>('/library/patterns?timezone=UTC&bingeThreshold=2');

    expect(body.summary.consecutivePlaysPct).toBe(Math.round((1000 * 2) / 3) / 10);
  });

  it('counts one person once across two servers and chains their plays', async () => {
    const server1 = await createTestServer({ type: 'plex' });
    const server2 = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });
    const account1 = (await createTestServerUser({ userId: person.id, serverId: server1.id })).id;
    const account2 = (await createTestServerUser({ userId: person.id, serverId: server2.id })).id;
    const showId = await addShow(server1.id, 'Saltmarsh', 10_200);
    expect(await addShow(server2.id, 'Saltmarsh', 10_200)).toBe(showId);
    // E1 on server 1, E2 on server 2 ten minutes after, E3 on server 1 ten minutes after that
    for (const [n, serverId, serverUserId, minutes] of [
      [1, server1.id, account1, 0],
      [2, server2.id, account2, 35],
      [3, server1.id, account1, 70],
    ] as const) {
      const mediaId = await addEpisode(server1.id, showId, 10_200 + n);
      expect(await addEpisode(server2.id, showId, 10_200 + n)).toBe(mediaId);
      await play({
        serverId,
        serverUserId,
        mediaId,
        showMediaId: showId,
        ratingKey: `rk-${mediaId}`,
        startedAt: daysAgo(2, minutes * MIN_MS),
        durationMs: 25 * MIN_MS,
      });
    }

    const body = await get<PatternsResponse>('/library/patterns?timezone=UTC&bingeThreshold=2');

    expect(body.bingeShows).toHaveLength(1);
    expect(body.bingeShows[0]).toMatchObject({
      totalEpisodeWatches: 3,
      consecutiveEpisodes: 2,
      people: 1,
    });
    expect(body.bingeShows[0]?.serverIds.sort()).toEqual([server1.id, server2.id].sort());
  });

  it('ranks binge shows by consecutive plays, then max per day', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const common = { serverId: server.id, serverUserId: user };
    // [title, tvdb id, episodes per day]: 4 consecutive at 3 a day, 3 at 4 a day, 3 at 3 a day
    const shows = [
      ['Fallow Reach', 10_300, [3, 3]],
      ['Gannet Point', 10_400, [4]],
      ['Heron Bight', 10_500, [3, 2]],
    ] as const;
    for (const [title, tvdbId, days] of shows) {
      const showId = await addShow(server.id, title, tvdbId);
      let n = 0;
      for (const [day, count] of days.entries()) {
        const episodes: string[] = [];
        for (let i = 0; i < count; i++) {
          n += 1;
          episodes.push(await addEpisode(server.id, showId, tvdbId + n));
        }
        await binge({ ...common, showId, episodes, startedAt: daysAgo(day + 2) });
      }
    }

    const body = await get<PatternsResponse>('/library/patterns?timezone=UTC');

    expect(
      body.bingeShows.map((b) => [b.showTitle, b.consecutiveEpisodes, b.maxEpisodesInOneDay])
    ).toEqual([
      ['Fallow Reach', 4, 3],
      ['Gannet Point', 3, 4],
      ['Heron Bight', 3, 3],
    ]);
  });
});
