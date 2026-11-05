/**
 * GET /media/:id/season-heat correctness, against a real database.
 *
 * media.routes.test.ts mocks db.select/db.execute, so it proves handler
 * mechanics and grouping shape but never the actual watched-state SQL or
 * server scoping. This pins: mixed watched/partial/unwatched episodes
 * roll up into the right per-season watchedPct, and an episode watched
 * only on server B never counts as watched when scoped to server A.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- mediaSeasonHeat
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import type { AuthUser, MediaSeasonHeatResponse } from '@tracearr/shared';
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

describe('season-heat against a real database', () => {
  it('groups episodes by season with correct watched/partial/unwatched states and season watchedPct', async () => {
    const server = await createTestServer({ type: 'plex' });
    const userA = await createTestUser();
    const userB = await createTestUser();
    const accountA = await createTestServerUser({ serverId: server.id, userId: userA.id });
    const accountB = await createTestServerUser({ serverId: server.id, userId: userB.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 700_001,
      title: 'Heat Show',
      year: 2019,
      serverId: server.id,
      ratingKey: 'heat-show',
    });

    await resolveMediaForItem({
      mediaType: 'season',
      title: 'Season 1',
      year: 2019,
      serverId: server.id,
      ratingKey: 'heat-show-s1',
      showMediaId: showId,
      seasonNumber: 1,
    });

    const ep1Id = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 700_011,
      title: 'Watched Episode',
      year: 2019,
      serverId: server.id,
      ratingKey: 'heat-ep-1',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const ep2Id = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 700_012,
      title: 'Partial Episode',
      year: 2019,
      serverId: server.id,
      ratingKey: 'heat-ep-2',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 2,
    });
    const ep3Id = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 700_013,
      title: 'Unwatched Episode',
      year: 2019,
      serverId: server.id,
      ratingKey: 'heat-ep-3',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 3,
    });

    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'heat-ep-1',
      title: 'Watched Episode',
      mediaType: 'episode',
      mediaId: ep1Id,
      parentIndex: 1,
      itemIndex: 1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'heat-ep-2',
      title: 'Partial Episode',
      mediaType: 'episode',
      mediaId: ep2Id,
      parentIndex: 1,
      itemIndex: 2,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'heat-ep-3',
      title: 'Unwatched Episode',
      mediaType: 'episode',
      mediaId: ep3Id,
      parentIndex: 1,
      itemIndex: 3,
    });

    // ep1: fully watched by userA
    await createTestSession({
      serverId: server.id,
      serverUserId: accountA.id,
      mediaType: 'episode',
      mediaId: ep1Id,
      showMediaId: showId,
      ratingKey: 'heat-ep-1',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });
    // ep2: played but never marked watched by userB - partial
    await createTestSession({
      serverId: server.id,
      serverUserId: accountB.id,
      mediaType: 'episode',
      mediaId: ep2Id,
      showMediaId: showId,
      ratingKey: 'heat-ep-2',
      durationMs: 300_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: false,
    });
    // ep3: no sessions at all - unwatched

    await refreshPlaysAggregate();

    const { app } = await buildApp(ownerFor());
    const response = await app.inject({
      method: 'GET',
      url: `/library/media/${showId}/season-heat`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<MediaSeasonHeatResponse>();

    expect(body.mediaId).toBe(showId);
    expect(body.seasons).toHaveLength(1);
    const season = body.seasons[0]!;
    expect(season.seasonNumber).toBe(1);
    expect(season.episodeCount).toBe(3);
    expect(season.watchedCount).toBe(1);
    expect(season.watchedPct).toBeCloseTo((1 / 3) * 100, 5);

    const byNumber = new Map(season.episodes.map((e) => [e.episodeNumber, e.watchedState]));
    expect(byNumber.get(1)).toBe('watched');
    expect(byNumber.get(2)).toBe('partial');
    expect(byNumber.get(3)).toBe('unwatched');
    expect(season.episodes[0]).toMatchObject({ mediaId: ep1Id, title: 'Watched Episode' });
  });

  it('never counts an episode watched on server B as watched when scoped to server A', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const userB = await createTestUser();
    const accountB = await createTestServerUser({ serverId: serverB.id, userId: userB.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 700_101,
      title: 'Scoped Heat Show',
      year: 2021,
      serverId: serverA.id,
      ratingKey: 'scoped-heat-show',
    });
    const sameShowId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 700_101,
      title: 'Scoped Heat Show',
      year: 2021,
      serverId: serverB.id,
      ratingKey: 'scoped-heat-show-b',
    });
    expect(sameShowId).toBe(showId);

    await resolveMediaForItem({
      mediaType: 'season',
      title: 'Season 1',
      year: 2021,
      serverId: serverA.id,
      ratingKey: 'scoped-heat-show-s1',
      showMediaId: showId,
      seasonNumber: 1,
    });

    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 700_111,
      title: 'Cross Server Episode',
      year: 2021,
      serverId: serverB.id,
      ratingKey: 'scoped-heat-ep-b',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 1,
    });

    // The episode is only in server A's library copy of the season, so a
    // server-A-scoped caller sees it, but the only watched play happened
    // on server B.
    await createTestLibraryItem({
      serverId: serverA.id,
      ratingKey: 'scoped-heat-ep-a',
      title: 'Cross Server Episode',
      mediaType: 'episode',
      mediaId: episodeId,
      parentIndex: 1,
      itemIndex: 1,
    });
    await createTestLibraryItem({
      serverId: serverB.id,
      ratingKey: 'scoped-heat-ep-b',
      title: 'Cross Server Episode',
      mediaType: 'episode',
      mediaId: episodeId,
      parentIndex: 1,
      itemIndex: 1,
    });

    await createTestSession({
      serverId: serverB.id,
      serverUserId: accountB.id,
      mediaType: 'episode',
      mediaId: episodeId,
      showMediaId: showId,
      ratingKey: 'scoped-heat-ep-b',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });
    // Server A has no play at all for this episode

    await refreshPlaysAggregate();

    const { app: appOwner } = await buildApp(ownerFor());
    const ownerRes = await appOwner.inject({
      method: 'GET',
      url: `/library/media/${showId}/season-heat`,
    });
    const ownerBody = ownerRes.json<MediaSeasonHeatResponse>();
    const ownerEpisode = ownerBody.seasons[0]!.episodes.find((e) => e.episodeNumber === 1);
    expect(ownerEpisode?.watchedState).toBe('watched');

    const { app: appViewerA } = await buildApp(viewerFor([serverA.id]));
    const scopedRes = await appViewerA.inject({
      method: 'GET',
      url: `/library/media/${showId}/season-heat`,
    });
    expect(scopedRes.statusCode).toBe(200);
    const scopedBody = scopedRes.json<MediaSeasonHeatResponse>();
    const scopedEpisode = scopedBody.seasons[0]!.episodes.find((e) => e.episodeNumber === 1);
    expect(scopedEpisode?.watchedState).toBe('unwatched');
  });

  it('404s for a movie id, and for an episode id, neither of which has seasons', async () => {
    const server = await createTestServer({ type: 'plex' });
    const movieId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 700_201,
      title: 'Season Heat Movie',
      year: 2022,
      serverId: server.id,
      ratingKey: 'heat-movie',
    });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tmdbId: 700_202,
      title: 'Season Heat Episode Parent',
      year: 2022,
      serverId: server.id,
      ratingKey: 'heat-episode-parent',
    });
    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tmdbId: 700_203,
      title: 'Season Heat Episode',
      year: 2022,
      serverId: server.id,
      ratingKey: 'heat-episode',
      showMediaId: showId,
    });

    const { app } = await buildApp(ownerFor());
    const movieRes = await app.inject({
      method: 'GET',
      url: `/library/media/${movieId}/season-heat`,
    });
    expect(movieRes.statusCode).toBe(404);

    const episodeRes = await app.inject({
      method: 'GET',
      url: `/library/media/${episodeId}/season-heat`,
    });
    expect(episodeRes.statusCode).toBe(404);
  });

  it('returns an empty seasons array for a show with no seasons, without dividing by zero', async () => {
    const server = await createTestServer({ type: 'plex' });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tmdbId: 700_301,
      title: 'Season Heat Empty Show',
      year: 2023,
      serverId: server.id,
      ratingKey: 'heat-empty-show',
    });

    const { app } = await buildApp(ownerFor());
    const response = await app.inject({
      method: 'GET',
      url: `/library/media/${showId}/season-heat`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<MediaSeasonHeatResponse>();
    expect(body.seasons).toEqual([]);
  });
});
