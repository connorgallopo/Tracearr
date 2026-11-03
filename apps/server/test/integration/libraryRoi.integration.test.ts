/**
 * Library ROI against a real database: plays come from user_media_plays_daily by media
 * identity, sizes from the version rows at episode grain.
 *
 * Run with: pnpm --filter @tracearr/server test:integration libraryRoi
 */

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import { REDIS_KEYS, type AuthUser } from '@tracearr/shared';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraries } from '../../src/db/schema.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { backfillSessionIdentityBatch } from '../../src/jobs/sessionIdentityBackfill.js';
import { refreshAggregates } from '../../src/db/timescale.js';
import { permissionGuard } from '../../src/lib/scope.js';
import { buildRoiQuery } from '../../src/routes/library/roi.js';
import { libraryTopContentRoute } from '../../src/routes/library/topContent.js';
import { buildWatchSummaryQuery } from '../../src/routes/library/watch.js';
import { ceilToUtcDay } from '../../src/db/sessions/rules.js';
import { resolveLibraryWindow } from '../../src/routes/library/utils.js';
import { getMediaStats } from '../../src/services/library/mediaDetailService.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { flushInsertBatch } from '../../src/services/import/batchProcessor.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const GB = 1_073_741_824;
const TODAY = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const daysAgo = (days: number) => new Date(TODAY - days * DAY_MS + DAY_MS / 2);

interface RoiRow {
  id: string;
  server_ids: string[];
  title: string;
  media_type: string;
  file_size_bytes: string;
  watch_count: string;
  total_watch_hours: string;
  last_watched_at: string | null;
}

type RoiInput = Parameters<typeof buildRoiQuery>[0];

async function runRoi(overrides: Partial<RoiInput> = {}): Promise<RoiRow[]> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
  const result = await db.execute(
    buildRoiQuery({
      window: resolveLibraryWindow({ period: '30d' }),
      serverIds: undefined,
      libraryId: undefined,
      mediaType: 'all',
      sortBy: 'title',
      sortOrder: 'asc',
      limit: 50,
      offset: 0,
      ...overrides,
    })
  );
  return result.rows as unknown as RoiRow[];
}

async function account(serverId: string): Promise<string> {
  const user = await createTestUser({ role: 'member' });
  return (await createTestServerUser({ userId: user.id, serverId })).id;
}

async function addMovie(opts: {
  serverId: string;
  ratingKey: string;
  title: string;
  tmdbId: number;
  sizeGb: number;
}): Promise<string> {
  const mediaId = await resolveMediaForItem({
    mediaType: 'movie',
    tmdbId: opts.tmdbId,
    title: opts.title,
    year: 2020,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
  });
  await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: opts.title,
    mediaType: 'movie',
    mediaId,
    fileSize: opts.sizeGb * GB,
  });
  return mediaId;
}

async function addShow(serverId: string, ratingKey: string, title: string, tvdbId: number) {
  const showId = await resolveMediaForItem({
    mediaType: 'show',
    tvdbId,
    title,
    year: 2019,
    serverId,
    ratingKey,
  });
  await createTestLibraryItem({
    serverId,
    ratingKey,
    title,
    mediaType: 'show',
    mediaId: showId,
    withoutVersion: true,
  });
  return showId;
}

async function addEpisode(opts: {
  serverId: string;
  ratingKey: string;
  showId: string;
  tvdbId: number;
  sizeGb: number;
}): Promise<string> {
  const episodeId = await resolveMediaForItem({
    mediaType: 'episode',
    tvdbId: opts.tvdbId,
    title: `Episode ${opts.tvdbId}`,
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    showMediaId: opts.showId,
  });
  await createTestLibraryItem({
    serverId: opts.serverId,
    ratingKey: opts.ratingKey,
    title: `Episode ${opts.tvdbId}`,
    mediaType: 'episode',
    mediaId: episodeId,
    fileSize: opts.sizeGb * GB,
  });
  return episodeId;
}

async function play(opts: {
  serverId: string;
  serverUserId: string;
  mediaId: string;
  showMediaId?: string;
  ratingKey: string;
  durationMs: number;
  startedAt: Date;
}): Promise<void> {
  await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    mediaId: opts.mediaId,
    showMediaId: opts.showMediaId ?? null,
    mediaType: opts.showMediaId ? 'episode' : 'movie',
    ratingKey: opts.ratingKey,
    startedAt: opts.startedAt,
    durationMs: opts.durationMs,
    totalDurationMs: 2 * HOUR_MS,
    referenceId: null,
  });
}

/** One show on two servers: episodes 1 and 2 on A, a mirror of episode 1 on B. */
async function seedShowOnTwoServers() {
  const serverA = await createTestServer({ type: 'plex' });
  const serverB = await createTestServer({ type: 'jellyfin' });
  const userA = await account(serverA.id);
  const userB = await account(serverB.id);

  const showId = await addShow(serverA.id, 'show-a', 'Harbor Lights', 7001);
  expect(await addShow(serverB.id, 'show-b', 'Harbor Lights', 7001)).toBe(showId);
  const ep1 = await addEpisode({
    serverId: serverA.id,
    ratingKey: 'ep1-a',
    showId,
    tvdbId: 7101,
    sizeGb: 1,
  });
  const ep2 = await addEpisode({
    serverId: serverA.id,
    ratingKey: 'ep2-a',
    showId,
    tvdbId: 7102,
    sizeGb: 2,
  });
  await addEpisode({ serverId: serverB.id, ratingKey: 'ep1-b', showId, tvdbId: 7101, sizeGb: 1 });

  const common = { showMediaId: showId, startedAt: daysAgo(2) };
  await play({
    ...common,
    serverId: serverA.id,
    serverUserId: userA,
    mediaId: ep1,
    ratingKey: 'ep1-a',
    durationMs: HOUR_MS / 2,
  });
  await play({
    ...common,
    serverId: serverA.id,
    serverUserId: userA,
    mediaId: ep2,
    ratingKey: 'ep2-a',
    durationMs: HOUR_MS,
  });
  await play({
    ...common,
    serverId: serverB.id,
    serverUserId: userB,
    mediaId: ep1,
    ratingKey: 'ep1-b',
    durationMs: (3 * HOUR_MS) / 4,
  });

  return { serverA, serverB, showId };
}

interface TopContentBody {
  items: Array<Record<string, unknown>>;
  summary: Record<string, number>;
}

async function topContent(path: '/top-movies' | '/top-shows'): Promise<TopContentBody> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('redis', { get: async () => null, setex: async () => 'OK' } as never);
  await app.register(libraryTopContentRoute);
  const response = await app.inject({ method: 'GET', url: path, query: { period: '30d' } });
  await app.close();
  return response.json() as TopContentBody;
}

describe('library ROI', () => {
  it("counts a show's plays across two servers and equals getMediaStats for the same window", async () => {
    const { showId } = await seedShowOnTwoServers();

    const rows = await runRoi();
    const stats = await getMediaStats(
      { kind: 'show', aliases: [showId], seasonNumber: null, showAliases: [] },
      undefined,
      'all'
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total_watch_hours)).toBeCloseTo(2.25, 6);
    expect(Number(rows[0]?.total_watch_hours)).toBeCloseTo(
      stats.last_30.combined.watch_time_ms / HOUR_MS,
      6
    );
    expect(Number(rows[0]?.watch_count)).toBe(3);
  });

  it('counts plays of a movie re-added under a new rating key', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie({
      serverId: server.id,
      ratingKey: 'rk-new',
      title: 'Paper Kites',
      tmdbId: 8001,
      sizeGb: 4,
    });
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'rk-old',
      durationMs: 2 * HOUR_MS,
      startedAt: daysAgo(3),
    });

    const rows = await runRoi();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total_watch_hours)).toBeCloseTo(2, 6);
  });

  it('folds a merged alias into its winner', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const winner = await addMovie({
      serverId: server.id,
      ratingKey: 'rk-win',
      title: 'Copper Field',
      tmdbId: 8101,
      sizeGb: 2,
    });
    const loser = await addMovie({
      serverId: server.id,
      ratingKey: 'rk-lose',
      title: 'Copper Field (Extended)',
      tmdbId: 8102,
      sizeGb: 3,
    });
    await db.execute(sql`UPDATE media SET merged_into_id = ${winner} WHERE id = ${loser}`);
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: winner,
      ratingKey: 'rk-win',
      durationMs: HOUR_MS,
      startedAt: daysAgo(1),
    });
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: loser,
      ratingKey: 'rk-lose',
      durationMs: HOUR_MS,
      startedAt: daysAgo(1),
    });

    const rows = await runRoi();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total_watch_hours)).toBeCloseTo(2, 6);
    expect(Number(rows[0]?.file_size_bytes)).toBe(5 * GB);
  });

  it('keeps two episodes of equal byte size and counts a mirrored file once', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'emby' });
    const showId = await addShow(serverA.id, 'show-a', 'Salt Road', 7201);
    await addShow(serverB.id, 'show-b', 'Salt Road', 7201);
    await addEpisode({
      serverId: serverA.id,
      ratingKey: 'e1-a',
      showId,
      tvdbId: 7211,
      sizeGb: 1.5,
    });
    await addEpisode({
      serverId: serverA.id,
      ratingKey: 'e2-a',
      showId,
      tvdbId: 7212,
      sizeGb: 1.5,
    });
    await addEpisode({
      serverId: serverB.id,
      ratingKey: 'e1-b',
      showId,
      tvdbId: 7211,
      sizeGb: 1.5,
    });

    const rows = await runRoi();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.file_size_bytes)).toBe(3 * GB);
  });

  it('includes the first and last day of a custom range and nothing after; all time has no lower bound', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie({
      serverId: server.id,
      ratingKey: 'rk-range',
      title: 'Quiet Orchard',
      tmdbId: 8201,
      sizeGb: 1,
    });
    const plays: Array<[string, number]> = [
      ['2026-03-09T12:00:00.000Z', HOUR_MS / 4],
      ['2026-03-10T00:30:00.000Z', HOUR_MS / 2],
      ['2026-03-12T23:30:00.000Z', HOUR_MS],
      ['2026-03-13T00:30:00.000Z', 2 * HOUR_MS],
    ];
    for (const [startedAt, durationMs] of plays) {
      await play({
        serverId: server.id,
        serverUserId: user,
        mediaId: movieId,
        ratingKey: 'rk-range',
        durationMs,
        startedAt: new Date(startedAt),
      });
    }

    const custom = await runRoi({
      window: resolveLibraryWindow({
        period: '30d',
        startDate: '2026-03-10T00:00:00.000Z',
        endDate: '2026-03-13T00:00:00.000Z',
      }),
    });
    const allTime = await runRoi({ window: resolveLibraryWindow({ period: 'all' }) });

    expect(Number(custom[0]?.total_watch_hours)).toBeCloseTo(1.5, 6);
    expect(Number(allTime[0]?.total_watch_hours)).toBeCloseTo(3.75, 6);
  });

  it('reports last watched from all time while hours follow the window', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie({
      serverId: server.id,
      ratingKey: 'rk-old-play',
      title: 'Winter Signal',
      tmdbId: 8301,
      sizeGb: 2,
    });
    const playedAt = daysAgo(200);
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'rk-old-play',
      durationMs: HOUR_MS,
      startedAt: playedAt,
    });

    const rows = await runRoi();

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total_watch_hours)).toBe(0);
    expect(rows[0]?.last_watched_at).toBe(playedAt.toISOString().slice(0, 10));
  });

  it('leaves artists out', async () => {
    const server = await createTestServer({ type: 'plex' });
    const artistId = await resolveMediaForItem({
      mediaType: 'artist',
      musicBrainzId: '0f3c8f1e-5d2a-4c1b-9e7a-2b6d4a8c1e90',
      title: 'The Lanterns',
      serverId: server.id,
      ratingKey: 'ar-1',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ar-1',
      title: 'The Lanterns',
      mediaType: 'artist',
      mediaId: artistId,
      fileSize: GB,
    });
    await addMovie({
      serverId: server.id,
      ratingKey: 'rk-film',
      title: 'Glass Harbor',
      tmdbId: 8401,
      sizeGb: 1,
    });

    const rows = await runRoi();

    expect(rows.map((r) => r.media_type)).toEqual(['movie']);
  });

  it('narrows to one server: hours, size and serverIds come from that server only', async () => {
    const { serverB } = await seedShowOnTwoServers();

    const rows = await runRoi({ serverIds: [serverB.id] });

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total_watch_hours)).toBeCloseTo(0.75, 6);
    expect(Number(rows[0]?.file_size_bytes)).toBe(GB);
    expect(rows[0]?.server_ids).toEqual([serverB.id]);
  });

  it('lists every server holding a copy in serverIds when several are selected', async () => {
    const { serverA, serverB } = await seedShowOnTwoServers();

    const rows = await runRoi({ serverIds: [serverA.id, serverB.id] });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.server_ids).toEqual([serverA.id, serverB.id].sort());
    expect(Number(rows[0]?.file_size_bytes)).toBe(3 * GB);
  });

  it('counts an episode with no media link toward its show by grandparent rating key', async () => {
    const server = await createTestServer({ type: 'emby' });
    const user = await account(server.id);
    const showId = await addShow(server.id, 'show-rk', 'Quiet Harbor', 7301);
    const matched = await addEpisode({
      serverId: server.id,
      ratingKey: 'ep-matched',
      showId,
      tvdbId: 7311,
      sizeGb: 1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep-unmatched',
      title: 'Episode 2',
      mediaType: 'episode',
      grandparentRatingKey: 'show-rk',
      fileSize: 2 * GB,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'bare-show',
      title: 'Loose Threads',
      mediaType: 'show',
      withoutVersion: true,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'bare-ep',
      title: 'Episode 1',
      mediaType: 'episode',
      grandparentRatingKey: 'bare-show',
      fileSize: 4 * GB,
    });
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: matched,
      showMediaId: showId,
      ratingKey: 'ep-matched',
      durationMs: HOUR_MS,
      startedAt: daysAgo(2),
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: user,
      mediaId: null,
      mediaType: 'episode',
      ratingKey: 'ep-unmatched',
      startedAt: daysAgo(2),
      durationMs: HOUR_MS,
      totalDurationMs: 2 * HOUR_MS,
      referenceId: null,
    });

    const rows = await runRoi();

    expect(rows.map((row) => row.title)).toEqual(['Loose Threads', 'Quiet Harbor']);
    expect(Number(rows[0]?.file_size_bytes)).toBe(4 * GB);
    expect(Number(rows[0]?.total_watch_hours)).toBe(0);
    expect(Number(rows[1]?.file_size_bytes)).toBe(3 * GB);
    expect(Number(rows[1]?.total_watch_hours)).toBeCloseTo(1, 6);
  });

  it("agrees with Most Watched on a show's hours over a preset, plays at the window edge included", async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const showId = await addShow(server.id, 'show-edge', 'Edge of Dawn', 7401);
    const episodeId = await addEpisode({
      serverId: server.id,
      ratingKey: 'ep-edge',
      showId,
      tvdbId: 7411,
      sizeGb: 1,
    });
    const window = resolveLibraryWindow({ period: '30d' });
    const firstDay = ceilToUtcDay(window.startDate as Date).getTime();
    for (const [startedAt, hours] of [
      [new Date(firstDay - HOUR_MS), 4],
      [new Date(firstDay + HOUR_MS), 1],
      [daysAgo(1), 2],
    ] as const) {
      await createTestSession({
        serverId: server.id,
        serverUserId: user,
        mediaId: episodeId,
        showMediaId: showId,
        mediaType: 'episode',
        mediaTitle: 'Edge of Dawn - S01E01',
        grandparentTitle: 'Edge of Dawn',
        ratingKey: 'ep-edge',
        startedAt,
        durationMs: hours * HOUR_MS,
        totalDurationMs: 5 * HOUR_MS,
        referenceId: null,
      });
    }
    await db.execute(
      sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
    );

    const rows = await runRoi({ window });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total_watch_hours)).toBeCloseTo(3, 6);

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { user: AuthUser }) => {
      request.user = { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
    });
    app.decorate('requirePermission', permissionGuard(app));
    app.decorate('redis', { get: async () => null, setex: async () => 'OK' } as never);
    await app.register(libraryTopContentRoute);
    for (const query of [{ period: '30d' }, { period: '30d', serverId: server.id }] as Array<
      Record<string, string>
    >) {
      const response = await app.inject({ method: 'GET', url: '/top-shows', query });
      const body = response.json() as { items: Array<{ totalWatchHours: number }> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.totalWatchHours).toBe(3);
    }
    await app.close();
  });

  it('reports one play set for a show across Most Watched, the watch summary, ROI and getMediaStats when a play has no media link', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const showId = await addShow(server.id, 'show-lantern', 'Paper Lanterns', 7501);
    const episodeId = await addEpisode({
      serverId: server.id,
      ratingKey: 'ep-lantern-1',
      showId,
      tvdbId: 7511,
      sizeGb: 1,
    });
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: episodeId,
      showMediaId: showId,
      ratingKey: 'ep-lantern-1',
      durationMs: 2 * HOUR_MS,
      startedAt: daysAgo(1),
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: user,
      mediaId: null,
      showMediaId: null,
      mediaType: 'episode',
      mediaTitle: 'Paper Lanterns - S01E02',
      grandparentTitle: 'Paper Lanterns',
      ratingKey: 'ep-lantern-orphan',
      startedAt: daysAgo(1),
      durationMs: 3 * HOUR_MS,
      totalDurationMs: 3 * HOUR_MS,
      referenceId: null,
    });
    await db.execute(
      sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
    );
    const window = resolveLibraryWindow({ period: '30d' });

    const roi = await runRoi({ window });
    expect(roi).toHaveLength(1);
    expect(Number(roi[0]?.watch_count)).toBe(1);
    expect(Number(roi[0]?.total_watch_hours)).toBeCloseTo(2, 6);

    const watch = (
      await db.execute(
        buildWatchSummaryQuery({ window, serverIds: undefined, libraryId: undefined })
      )
    ).rows[0] as { total_plays: string; total_watch_ms: string };
    expect(Number(watch.total_plays)).toBe(1);
    expect(Number(watch.total_watch_ms)).toBe(2 * HOUR_MS);

    const stats = await getMediaStats(
      { kind: 'show', aliases: [showId], seasonNumber: null, showAliases: [] },
      undefined,
      'all'
    );
    expect(stats.last_30.combined).toMatchObject({ plays: 1, watch_time_ms: 2 * HOUR_MS });

    const body = await topContent('/top-shows');
    expect(body.items).toEqual([
      expect.objectContaining({
        showTitle: 'Paper Lanterns',
        totalEpisodeViews: 1,
        totalWatchHours: 2,
      }),
    ]);
    expect(body.summary).toEqual({ totalShows: 1, totalWatchHours: 2 });
  });

  it('leaves an unlinked movie play out of Most Watched, like ROI, the watch summary and getMediaStats', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie({
      serverId: server.id,
      ratingKey: 'movie-drift',
      title: 'Drift Season',
      tmdbId: 7601,
      sizeGb: 1,
    });
    await play({
      serverId: server.id,
      serverUserId: user,
      mediaId: movieId,
      ratingKey: 'movie-drift',
      durationMs: 2 * HOUR_MS,
      startedAt: daysAgo(1),
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: user,
      mediaId: null,
      mediaType: 'movie',
      mediaTitle: 'Drift Season',
      year: 2020,
      ratingKey: 'movie-drift-orphan',
      startedAt: daysAgo(1),
      durationMs: 3 * HOUR_MS,
      totalDurationMs: 3 * HOUR_MS,
      referenceId: null,
    });
    const window = resolveLibraryWindow({ period: '30d' });

    const roi = await runRoi({ window });
    expect(roi.map((r) => [Number(r.watch_count), Number(r.total_watch_hours)])).toEqual([[1, 2]]);
    const watch = (
      await db.execute(
        buildWatchSummaryQuery({ window, serverIds: undefined, libraryId: undefined })
      )
    ).rows[0] as { total_plays: string; total_watch_ms: string };
    expect([Number(watch.total_plays), Number(watch.total_watch_ms)]).toEqual([1, 2 * HOUR_MS]);
    const stats = await getMediaStats(
      { kind: 'media', aliases: [movieId], seasonNumber: null, showAliases: [] },
      undefined,
      'all'
    );
    expect(stats.last_30.combined).toMatchObject({ plays: 1, watch_time_ms: 2 * HOUR_MS });

    const body = await topContent('/top-movies');
    expect(body.items).toEqual([
      expect.objectContaining({ title: 'Drift Season', totalPlays: 1, totalWatchHours: 2 }),
    ]);
    expect(body.summary).toEqual({ totalMovies: 1, totalWatchHours: 2 });
  });

  it('counts a tracked play on a rating key confirmed gone from the server everywhere once it resolves', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    await db
      .insert(libraries)
      .values({ serverId: server.id, libraryId: '1', name: 'Movies', mediaType: 'movie' });
    await getRedis().set(
      REDIS_KEYS.LIBRARY_SYNC_FULL_SCAN_DONE(server.id, '1'),
      new Date().toISOString()
    );
    const movieId = await addMovie({
      serverId: server.id,
      ratingKey: 'rk-current',
      title: 'Harbor Gone',
      tmdbId: 9101,
      sizeGb: 1,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: user,
      externalSessionId: null,
      mediaId: null,
      mediaType: 'movie',
      mediaTitle: 'Harbor Gone',
      year: 2020,
      tmdbId: 9101,
      ratingKey: 'rk-gone',
      startedAt: daysAgo(2),
      durationMs: 2 * HOUR_MS,
      totalDurationMs: 2 * HOUR_MS,
      referenceId: null,
    });

    expect((await backfillSessionIdentityBatch(1000)).updated).toBe(1);
    await refreshAggregates({ startTime: daysAgo(5), endTime: new Date() });
    const window = resolveLibraryWindow({ period: '30d' });

    const roi = await runRoi({ window });
    expect(roi.map((r) => [Number(r.watch_count), Number(r.total_watch_hours)])).toEqual([[1, 2]]);
    const watch = (
      await db.execute(
        buildWatchSummaryQuery({ window, serverIds: undefined, libraryId: undefined })
      )
    ).rows[0] as { total_plays: string; total_watch_ms: string };
    expect([Number(watch.total_plays), Number(watch.total_watch_ms)]).toEqual([1, 2 * HOUR_MS]);
    const stats = await getMediaStats(
      { kind: 'media', aliases: [movieId], seasonNumber: null, showAliases: [] },
      undefined,
      'all'
    );
    expect(stats.last_30.combined).toMatchObject({ plays: 1, watch_time_ms: 2 * HOUR_MS });
    const body = await topContent('/top-movies');
    expect(body.items).toEqual([
      expect.objectContaining({ title: 'Harbor Gone', totalPlays: 1, totalWatchHours: 2 }),
    ]);
  });

  it('sums the Most Watched summary hours over every play before rounding, not over the rounded rows', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    for (const [index, title] of ['Brief One', 'Brief Two', 'Brief Three'].entries()) {
      const mediaId = await addMovie({
        serverId: server.id,
        ratingKey: `rk-brief-${index}`,
        title,
        tmdbId: 8301 + index,
        sizeGb: 1,
      });
      await play({
        serverId: server.id,
        serverUserId: user,
        mediaId,
        ratingKey: `rk-brief-${index}`,
        durationMs: 150_000,
        startedAt: daysAgo(3),
      });
    }
    await refreshAggregates({ startTime: daysAgo(5), endTime: new Date() });

    const body = await topContent('/top-movies');
    expect(body.items.map((item) => item.totalWatchHours)).toEqual([0, 0, 0]);
    expect(body.summary).toEqual({ totalMovies: 3, totalWatchHours: 0.1 });
  });

  it('counts an import that lands after the library sync everywhere, with no further sync and no manual step', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await account(server.id);
    const movieId = await addMovie({
      serverId: server.id,
      ratingKey: 'movie-late',
      title: 'Late Harbor',
      tmdbId: 7602,
      sizeGb: 1,
    });
    await flushInsertBatch([
      {
        serverId: server.id,
        serverUserId: user,
        sessionKey: 'import-late',
        externalSessionId: 'import-late',
        ratingKey: 'movie-late-gone',
        ipAddress: '10.0.0.9',
        state: 'stopped',
        mediaType: 'movie',
        mediaTitle: 'Late Harbor',
        year: 2020,
        startedAt: daysAgo(10),
        lastSeenAt: daysAgo(10),
        durationMs: 2 * HOUR_MS,
        totalDurationMs: 2 * HOUR_MS,
      },
    ]);
    const window = resolveLibraryWindow({ period: '30d' });

    const roi = await runRoi({ window });
    expect(roi.map((r) => [Number(r.watch_count), Number(r.total_watch_hours)])).toEqual([[1, 2]]);
    const watch = (
      await db.execute(
        buildWatchSummaryQuery({ window, serverIds: undefined, libraryId: undefined })
      )
    ).rows[0] as { total_plays: string; total_watch_ms: string };
    expect([Number(watch.total_plays), Number(watch.total_watch_ms)]).toEqual([1, 2 * HOUR_MS]);
    const stats = await getMediaStats(
      { kind: 'media', aliases: [movieId], seasonNumber: null, showAliases: [] },
      undefined,
      'all'
    );
    expect(stats.last_30.combined).toMatchObject({ plays: 1, watch_time_ms: 2 * HOUR_MS });
    const body = await topContent('/top-movies');
    expect(body.items).toEqual([
      expect.objectContaining({ title: 'Late Harbor', totalPlays: 1, totalWatchHours: 2 }),
    ]);
  });
});
