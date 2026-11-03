/**
 * Viewers are identities with at least one counted play (2 minutes, or marked watched), so a
 * viewer count never exceeds the play count. Every surface that counts viewers of a title, and
 * the person page's per-viewer server baseline, must agree on that rule against a real database.
 *
 * Run with: pnpm --filter @tracearr/server test:integration viewerRule
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { eq, sql } from 'drizzle-orm';
import type {
  AuthUser,
  CatalogResponse,
  ShelvesResponse,
  TopMoviesResponse,
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
import { media } from '../../src/db/schema.js';
import { libraryShelvesRoute } from '../../src/routes/library/shelves.js';
import { libraryCatalogRoute } from '../../src/routes/library/catalog.js';
import { libraryTopContentRoute } from '../../src/routes/library/topContent.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { getMediaStats, getMediaWatchers } from '../../src/services/library/mediaDetailService.js';
import {
  queryIdentityRangeStats,
  resolveIdentityWindow,
} from '../../src/services/stats/peopleStats.js';
import { permissionGuard } from '../../src/lib/scope.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function buildApp(): Promise<FastifyInstance> {
  const authUser: AuthUser = {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [],
  };
  const instance = Fastify({ logger: false });
  await instance.register(sensible);
  instance.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  instance.decorate('requirePermission', permissionGuard(instance));
  instance.decorate('redis', createMockRedis() as unknown as Redis);
  await instance.register(libraryShelvesRoute, { prefix: '/library' });
  await instance.register(libraryCatalogRoute, { prefix: '/library' });
  await instance.register(libraryTopContentRoute, { prefix: '/library' });
  return instance;
}

async function refreshPlaysAggregate(): Promise<void> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function seedMovie(serverId: string, ratingKey: string, title: string): Promise<string> {
  const mediaId = await resolveMediaForItem({
    mediaType: 'movie',
    tmdbId: 930_001,
    title,
    year: 2020,
    serverId,
    ratingKey,
  });
  await createTestLibraryItem({
    serverId,
    ratingKey,
    title,
    mediaType: 'movie',
    year: 2020,
    mediaId,
  });
  await db.update(media).set({ latestAddedAt: new Date() }).where(eq(media.id, mediaId));
  return mediaId;
}

interface PlayOptions {
  serverId: string;
  serverUserId: string;
  mediaId?: string | null;
  ratingKey: string;
  durationMs: number;
  startedAt: Date;
  watched?: boolean;
}

async function play(opts: PlayOptions): Promise<void> {
  await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    mediaId: opts.mediaId ?? null,
    ratingKey: opts.ratingKey,
    mediaType: 'movie',
    state: 'stopped',
    referenceId: null,
    durationMs: opts.durationMs,
    totalDurationMs: 7_200_000,
    progressMs: opts.durationMs,
    watched: opts.watched ?? false,
    startedAt: opts.startedAt,
    stoppedAt: new Date(opts.startedAt.getTime() + opts.durationMs),
  });
}

async function identity(serverId: string): Promise<string> {
  const user = await createTestUser();
  const account = await createTestServerUser({ serverId, userId: user.id });
  return account.id;
}

describe('one viewer rule', () => {
  it('counts only people with a counted play as viewers on every surface', async () => {
    const server = await createTestServer({ type: 'plex' });
    const movieId = await seedMovie(server.id, 'viewer-rule', 'Viewer Rule Movie');
    const startedAt = new Date(Date.now() - DAY_MS);
    const common = { serverId: server.id, mediaId: movieId, ratingKey: 'viewer-rule', startedAt };
    await play({ ...common, serverUserId: await identity(server.id), durationMs: 300_000 });
    // Opened for 20 seconds: not a play, so not a viewer.
    await play({ ...common, serverUserId: await identity(server.id), durationMs: 20_000 });
    // Marked watched with no recorded duration: a counted play.
    await play({
      ...common,
      serverUserId: await identity(server.id),
      durationMs: 0,
      watched: true,
    });
    await refreshPlaysAggregate();
    app = await buildApp();

    const shelves = (
      await app.inject({ method: 'GET', url: '/library/shelves?period=month' })
    ).json<ShelvesResponse>();
    const shelfRow = shelves.mostPopularMovies.find((r) => r.mediaId === movieId);
    expect.soft(shelfRow?.plays).toBe(2);
    expect.soft(shelfRow?.viewers).toBe(2);

    const catalog = (
      await app.inject({ method: 'GET', url: '/library/catalog?type=movie&pageSize=60' })
    ).json<CatalogResponse>();
    const catalogRow = catalog.data.find((r) => r.mediaId === movieId);
    expect.soft(catalogRow?.plays).toBe(2);
    expect.soft(catalogRow?.viewers).toBe(2);

    const stats = await getMediaStats(
      { kind: 'media', aliases: [movieId], seasonNumber: null, showAliases: [] },
      undefined,
      'all'
    );
    expect.soft(stats.last_30.combined.plays).toBe(2);
    expect.soft(stats.last_30.combined.unique_users).toBe(2);

    const top = (
      await app.inject({ method: 'GET', url: '/library/top-movies?period=30d' })
    ).json<TopMoviesResponse>();
    const topRow = top.items.find((r) => r.title === 'Viewer Rule Movie');
    expect.soft(topRow?.totalPlays).toBe(2);
    expect.soft(topRow?.uniqueViewers).toBe(2);
  });

  it('watchers last_watched_day ignores a later sample', async () => {
    const server = await createTestServer({ type: 'plex' });
    const movieId = await seedMovie(server.id, 'last-day', 'Last Day Movie');
    const viewer = await identity(server.id);
    const threeDaysAgo = new Date(startOfTodayUtc().getTime() - 3 * DAY_MS);
    const common = { serverId: server.id, serverUserId: viewer, mediaId: movieId };
    await play({ ...common, ratingKey: 'last-day', durationMs: 300_000, startedAt: threeDaysAgo });
    await play({
      ...common,
      ratingKey: 'last-day',
      durationMs: 20_000,
      startedAt: startOfTodayUtc(),
    });
    await refreshPlaysAggregate();

    const watchers = await getMediaWatchers({
      scope: { kind: 'media', aliases: [movieId], seasonNumber: null, showAliases: [] },
      windowKey: 'last_30',
      serverIds: undefined,
    });
    const row = watchers.find((w) => w.user.server_user_id === viewer);
    expect(row?.last_watched_day).toBe(threeDaysAgo.toISOString().slice(0, 10));
  });

  it('person page server baseline divides counted plays by people with a counted play', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewer = await identity(server.id);
    const sampler = await identity(server.id);
    const today = startOfTodayUtc();
    await play({
      serverId: server.id,
      serverUserId: viewer,
      ratingKey: 'baseline-a',
      durationMs: 300_000,
      startedAt: today,
    });
    await play({
      serverId: server.id,
      serverUserId: sampler,
      ratingKey: 'baseline-b',
      durationMs: 20_000,
      startedAt: today,
    });

    const stats = await queryIdentityRangeStats({
      serverUserIds: [viewer],
      resolvedServerIds: undefined,
      window: resolveIdentityWindow({ period: 'week' }),
    });
    const todayLabel = `${today.toISOString().slice(0, 10)} 00:00:00`;
    expect(stats.serverAvgPlaysByDay.find((p) => p.date === todayLabel)?.count).toBe(1);
  });
});
