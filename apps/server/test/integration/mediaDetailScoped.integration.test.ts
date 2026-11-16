/**
 * Media detail scoping correctness, against a real database.
 *
 * media.routes.test.ts mocks db.select/db.execute, so it proves handler
 * mechanics but never the actual scoping: an owner (all servers) must see
 * every server's availability and rolled-up activity, while a non-owner
 * scoped to one server must see only that server's copy and only that
 * server's plays/watchers/history/platform breakdown - the other server's
 * activity must be entirely invisible, not just filtered display fields.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- mediaDetailScoped
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import type {
  AuthUser,
  MediaDetailResponse,
  MediaStatsResponse,
  MediaWatchersResponse,
  MediaPlatformBreakdownResponse,
  MediaChildrenResponse,
} from '@tracearr/shared';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { libraryMediaRoute } from '../../src/routes/library/media.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
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
  await app.register(libraryMediaRoute, { prefix: '/library' });
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

interface Scenario {
  mediaId: string;
  serverA: { id: string };
  serverB: { id: string };
}

async function seedTwoServerMovie(): Promise<Scenario> {
  const serverA = await createTestServer({ type: 'plex' });
  const serverB = await createTestServer({ type: 'jellyfin' });
  const userA = await createTestUser();
  const userB = await createTestUser();
  const accountA = await createTestServerUser({ serverId: serverA.id, userId: userA.id });
  const accountB = await createTestServerUser({ serverId: serverB.id, userId: userB.id });

  const mediaId = await resolveMediaForItem({
    mediaType: 'movie',
    tmdbId: 950_001,
    title: 'Scoped Detail Movie',
    year: 2020,
    serverId: serverA.id,
    ratingKey: 'scoped-a',
  });
  const sameId = await resolveMediaForItem({
    mediaType: 'movie',
    tmdbId: 950_001,
    title: 'Scoped Detail Movie',
    year: 2020,
    serverId: serverB.id,
    ratingKey: 'scoped-b',
  });
  expect(sameId).toBe(mediaId);

  await createTestLibraryItem({
    serverId: serverA.id,
    ratingKey: 'scoped-a',
    title: 'Scoped Detail Movie',
    mediaType: 'movie',
    year: 2020,
    mediaId,
  });
  await createTestLibraryItem({
    serverId: serverB.id,
    ratingKey: 'scoped-b',
    title: 'Scoped Detail Movie',
    mediaType: 'movie',
    year: 2020,
    mediaId,
  });

  const startedAt = new Date();
  await createTestSession({
    serverId: serverA.id,
    serverUserId: accountA.id,
    mediaId,
    ratingKey: 'scoped-a',
    mediaType: 'movie',
    state: 'stopped',
    durationMs: 600_000,
    totalDurationMs: 7_200_000,
    progressMs: 600_000,
    watched: true,
    platform: 'iOS',
    playerName: 'Tracearr iOS',
    startedAt,
    stoppedAt: startedAt,
  });
  await createTestSession({
    serverId: serverB.id,
    serverUserId: accountB.id,
    mediaId,
    ratingKey: 'scoped-b',
    mediaType: 'movie',
    state: 'stopped',
    durationMs: 900_000,
    totalDurationMs: 7_200_000,
    progressMs: 900_000,
    watched: true,
    platform: 'Android',
    playerName: 'Tracearr Android',
    startedAt,
    stoppedAt: startedAt,
  });

  await refreshPlaysAggregate();
  return { mediaId, serverA, serverB };
}

describe('media detail scoping against a real database', () => {
  it('lets an owner see both servers availability and activity', async () => {
    const { mediaId, serverA, serverB } = await seedTwoServerMovie();
    const { app } = await buildApp(ownerFor());

    const detailRes = await app.inject({ method: 'GET', url: `/library/media/${mediaId}` });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json<MediaDetailResponse>();
    expect(detail.availability).toHaveLength(2);
    const detailServerIds = detail.availability.map((a) => a.serverId).sort();
    expect(detailServerIds).toEqual([serverA.id, serverB.id].sort());

    const statsRes = await app.inject({ method: 'GET', url: `/library/media/${mediaId}/stats` });
    expect(statsRes.statusCode).toBe(200);
    const stats = statsRes.json<MediaStatsResponse>();
    expect(stats.windows.all_time.combined.plays).toBe(2);
    expect(stats.windows.all_time.perServer).toHaveLength(2);

    const watchersRes = await app.inject({
      method: 'GET',
      url: `/library/media/${mediaId}/watchers`,
    });
    const watchers = watchersRes.json<MediaWatchersResponse>();
    expect(watchers.watchers).toHaveLength(2);

    const platformsRes = await app.inject({
      method: 'GET',
      url: `/library/media/${mediaId}/platforms`,
    });
    const platforms = platformsRes.json<MediaPlatformBreakdownResponse>();
    expect(platforms.data.map((p) => p.platform).sort()).toEqual(['Android', 'iOS']);

    const historyRes = await app.inject({
      method: 'GET',
      url: `/library/media/${mediaId}/history`,
    });
    const history = historyRes.json<{ data: unknown[] }>();
    expect(history.data).toHaveLength(2);
  });

  it('scopes a non-owner to their one server, hiding the other servers activity entirely', async () => {
    const { mediaId, serverA, serverB } = await seedTwoServerMovie();
    const { app } = await buildApp(viewerFor([serverA.id]));

    const detailRes = await app.inject({ method: 'GET', url: `/library/media/${mediaId}` });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json<MediaDetailResponse>();
    expect(detail.availability).toHaveLength(1);
    expect(detail.availability[0]!.serverId).toBe(serverA.id);

    const statsRes = await app.inject({ method: 'GET', url: `/library/media/${mediaId}/stats` });
    expect(statsRes.statusCode).toBe(200);
    const stats = statsRes.json<MediaStatsResponse>();
    expect(stats.windows.all_time.combined.plays).toBe(1);
    expect(stats.windows.all_time.combined.watchTimeMs).toBe(600_000);
    expect(stats.windows.all_time.perServer).toEqual([
      {
        serverId: serverA.id,
        serverName: expect.any(String),
        plays: 1,
        watchTimeMs: 600_000,
        uniqueUsers: 1,
      },
    ]);

    const watchersRes = await app.inject({
      method: 'GET',
      url: `/library/media/${mediaId}/watchers`,
    });
    const watchers = watchersRes.json<MediaWatchersResponse>();
    expect(watchers.watchers).toHaveLength(1);

    const platformsRes = await app.inject({
      method: 'GET',
      url: `/library/media/${mediaId}/platforms`,
    });
    const platforms = platformsRes.json<MediaPlatformBreakdownResponse>();
    expect(platforms.data).toEqual([
      { platform: 'iOS', player: 'Tracearr iOS', plays: 1, watchTimeMs: 600_000 },
    ]);

    const historyRes = await app.inject({
      method: 'GET',
      url: `/library/media/${mediaId}/history`,
    });
    const history = historyRes.json<{ data: { server_id: string }[] }>();
    expect(history.data).toHaveLength(1);
    expect(history.data[0]!.server_id).toBe(serverA.id);

    // The out-of-scope server must never leak in, not even as a zero entry.
    expect(detail.availability.some((a) => a.serverId === serverB.id)).toBe(false);
  });

  it('the serverIds query param narrows to the selected subset, combines across it, and never leaks an inaccessible server', async () => {
    const { mediaId, serverA, serverB } = await seedTwoServerMovie();
    const { app: appOwner } = await buildApp(ownerFor());

    // serverIds=[A] alone: only A's copy and A's play.
    const detailA = await appOwner.inject({
      method: 'GET',
      url: `/library/media/${mediaId}?serverIds=${serverA.id}`,
    });
    expect(detailA.statusCode).toBe(200);
    const detailABody = detailA.json<MediaDetailResponse>();
    expect(detailABody.availability).toHaveLength(1);
    expect(detailABody.availability[0]!.serverId).toBe(serverA.id);

    const statsA = await appOwner.inject({
      method: 'GET',
      url: `/library/media/${mediaId}/stats?serverIds=${serverA.id}`,
    });
    expect(statsA.json<MediaStatsResponse>().windows.all_time.combined.plays).toBe(1);

    // serverIds=[A,B] combines the selected subset: both plays are visible,
    // identical to the unscoped owner view.
    const statsAB = await appOwner.inject({
      method: 'GET',
      url: `/library/media/${mediaId}/stats?serverIds=${serverA.id}&serverIds=${serverB.id}`,
    });
    expect(statsAB.json<MediaStatsResponse>().windows.all_time.combined.plays).toBe(2);

    const detailAB = await appOwner.inject({
      method: 'GET',
      url: `/library/media/${mediaId}?serverIds=${serverA.id}&serverIds=${serverB.id}`,
    });
    expect(detailAB.json<MediaDetailResponse>().availability).toHaveLength(2);

    // No serverIds param: full accessible scope, same as today.
    const detailAll = await appOwner.inject({ method: 'GET', url: `/library/media/${mediaId}` });
    expect(detailAll.json<MediaDetailResponse>().availability).toHaveLength(2);

    // A non-owner scoped to A alone requesting serverIds=[B] (inaccessible)
    // gets it intersected away, never leaked: no availability at all rather
    // than server B's data.
    const { app: appViewer } = await buildApp(viewerFor([serverA.id]));
    const detailLeak = await appViewer.inject({
      method: 'GET',
      url: `/library/media/${mediaId}?serverIds=${serverB.id}`,
    });
    expect(detailLeak.statusCode).toBe(200);
    expect(detailLeak.json<MediaDetailResponse>().availability).toHaveLength(0);

    const watchersLeak = await appViewer.inject({
      method: 'GET',
      url: `/library/media/${mediaId}/watchers?serverIds=${serverB.id}`,
    });
    expect(watchersLeak.json<MediaWatchersResponse>().watchers).toHaveLength(0);
  });

  it('rolls a show copy up from its episode files: exact summed bytes and frequency-ordered resolutions per server+library', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 960_001,
      title: 'Rollup Show',
      year: 2021,
      serverId: serverA.id,
      ratingKey: 'rollup-show-a',
    });
    const sameShowId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 960_001,
      title: 'Rollup Show',
      year: 2021,
      serverId: serverB.id,
      ratingKey: 'rollup-show-b',
    });
    expect(sameShowId).toBe(showId);

    const episodeIds: string[] = [];
    for (let n = 1; n <= 3; n++) {
      const epIdA = await resolveMediaForItem({
        mediaType: 'episode',
        tvdbId: 960_010 + n,
        title: `Episode ${n}`,
        year: 2021,
        serverId: serverA.id,
        ratingKey: `rollup-ep-${n}-a`,
        showMediaId: showId,
        seasonNumber: 1,
        episodeNumber: n,
      });
      const epIdB = await resolveMediaForItem({
        mediaType: 'episode',
        tvdbId: 960_010 + n,
        title: `Episode ${n}`,
        year: 2021,
        serverId: serverB.id,
        ratingKey: `rollup-ep-${n}-b`,
        showMediaId: showId,
        seasonNumber: 1,
        episodeNumber: n,
      });
      expect(epIdB).toBe(epIdA);
      episodeIds.push(epIdA);
    }

    // The show's own row on each server: no size, no resolution.
    await createTestLibraryItem({
      serverId: serverA.id,
      libraryId: 'tv-a',
      ratingKey: 'rollup-show-a',
      title: 'Rollup Show',
      mediaType: 'show',
      mediaId: showId,
    });
    await createTestLibraryItem({
      serverId: serverB.id,
      libraryId: 'tv-b',
      ratingKey: 'rollup-show-b',
      title: 'Rollup Show',
      mediaType: 'show',
      mediaId: showId,
    });

    // Server A: 1080p twice, 4k once -> ['1080p', '4k'], 18 GB total.
    const filesA: [number, string][] = [
      [4_000_000_000, '1080p'],
      [6_000_000_000, '1080p'],
      [8_000_000_000, '4k'],
    ];
    // Server B mirrors the episodes with 4k twice, 1080p once -> ['4k', '1080p'], 21 GB total.
    const filesB: [number, string][] = [
      [5_000_000_000, '4k'],
      [7_000_000_000, '4k'],
      [9_000_000_000, '1080p'],
    ];
    for (let i = 0; i < 3; i++) {
      await createTestLibraryItem({
        serverId: serverA.id,
        libraryId: 'tv-a',
        ratingKey: `rollup-ep-${i + 1}-a`,
        mediaType: 'episode',
        mediaId: episodeIds[i]!,
        grandparentRatingKey: 'rollup-show-a',
        parentIndex: 1,
        itemIndex: i + 1,
        fileSize: filesA[i]![0],
        videoResolution: filesA[i]![1],
      });
      await createTestLibraryItem({
        serverId: serverB.id,
        libraryId: 'tv-b',
        ratingKey: `rollup-ep-${i + 1}-b`,
        mediaType: 'episode',
        mediaId: episodeIds[i]!,
        parentIndex: 1,
        itemIndex: i + 1,
        fileSize: filesB[i]![0],
        videoResolution: filesB[i]![1],
      });
    }
    // A removed episode file must not count toward server A's rollup.
    await createTestLibraryItem({
      serverId: serverA.id,
      libraryId: 'tv-a',
      ratingKey: 'rollup-ep-1-a-old',
      mediaType: 'episode',
      mediaId: episodeIds[0]!,
      parentIndex: 1,
      itemIndex: 1,
      fileSize: 99_000_000_000,
      videoResolution: '720p',
      removedAt: new Date('2025-01-01'),
    });

    const { app } = await buildApp(ownerFor());
    const res = await app.inject({ method: 'GET', url: `/library/media/${showId}` });
    expect(res.statusCode).toBe(200);
    const detail = res.json<MediaDetailResponse>();
    expect(detail.availability).toHaveLength(2);

    const rowA = detail.availability.find((a) => a.serverId === serverA.id)!;
    expect(rowA.fileSize).toBeNull();
    expect(rowA.episodeFileSize).toBe(18_000_000_000);
    expect(rowA.episodeResolutions).toEqual(['1080p', '4k']);
    expect(rowA.episodeCount).toBe(3);

    const rowB = detail.availability.find((a) => a.serverId === serverB.id)!;
    expect(rowB.fileSize).toBeNull();
    expect(rowB.episodeFileSize).toBe(21_000_000_000);
    expect(rowB.episodeResolutions).toEqual(['4k', '1080p']);
    expect(rowB.episodeCount).toBe(3);

    // Scoped to server A alone, only A's rollup is visible and unchanged.
    const { app: appViewer } = await buildApp(viewerFor([serverA.id]));
    const scoped = await appViewer.inject({ method: 'GET', url: `/library/media/${showId}` });
    const scopedDetail = scoped.json<MediaDetailResponse>();
    expect(scopedDetail.availability).toHaveLength(1);
    expect(scopedDetail.availability[0]!.episodeFileSize).toBe(18_000_000_000);
    expect(scopedDetail.availability[0]!.episodeResolutions).toEqual(['1080p', '4k']);

    // An episode copy names its show and its place in it; the show copy names neither.
    expect(rowA).toMatchObject({ showRatingKey: null, seasonNumber: null, episodeNumber: null });
    const episode = await appViewer.inject({
      method: 'GET',
      url: `/library/media/${episodeIds[1]!}`,
    });
    expect(episode.json<MediaDetailResponse>().availability[0]).toMatchObject({
      showRatingKey: 'rollup-show-a',
      seasonNumber: 1,
      episodeNumber: 2,
    });
  });
});

describe('artist media detail against a real database', () => {
  it('reads an artist page from the track sessions under each of its copies', async () => {
    const music = await seedArtistOnTwoServers();
    const base = `/library/media/${music.artistMediaId}`;
    const { app } = await buildApp(ownerFor());

    const stats = (
      await app.inject({ method: 'GET', url: `${base}/stats` })
    ).json<MediaStatsResponse>();
    expect(stats.windows.all_time.combined).toMatchObject({ plays: 3, uniqueUsers: 2 });
    expect(stats.windows.all_time.perServer).toHaveLength(2);

    const watchers = (
      await app.inject({ method: 'GET', url: `${base}/watchers` })
    ).json<MediaWatchersResponse>();
    expect(watchers.watchers.map((w) => w.plays).sort()).toEqual([1, 2]);

    const platforms = (
      await app.inject({ method: 'GET', url: `${base}/platforms` })
    ).json<MediaPlatformBreakdownResponse>();
    expect(platforms.data.reduce((sum, p) => sum + p.plays, 0)).toBe(3);

    const history = (await app.inject({ method: 'GET', url: `${base}/history` })).json<{
      data: unknown[];
    }>();
    expect(history.data).toHaveLength(3);

    const children = (
      await app.inject({ method: 'GET', url: `${base}/children` })
    ).json<MediaChildrenResponse>();
    expect(children.data.map((c) => [c.mediaType, c.title, c.year, c.trackCount])).toEqual([
      ['album', 'Discovery', 2001, 1],
      ['album', 'Discovery', 2001, 1],
      ['album', 'Homework', 1997, 1],
      ['album', 'Homework', 1997, 1],
    ]);
    expect(new Set(children.data.map((c) => c.serverId))).toEqual(
      new Set([music.serverA, music.serverB])
    );

    const { app: viewer } = await buildApp(viewerFor([music.serverA]));
    const scoped = (
      await viewer.inject({ method: 'GET', url: `${base}/stats` })
    ).json<MediaStatsResponse>();
    expect(scoped.windows.all_time.combined.plays).toBe(2);
    const scopedChildren = (
      await viewer.inject({ method: 'GET', url: `${base}/children` })
    ).json<MediaChildrenResponse>();
    expect(scopedChildren.data.map((c) => c.serverId)).toEqual([music.serverA, music.serverA]);
  });
});
