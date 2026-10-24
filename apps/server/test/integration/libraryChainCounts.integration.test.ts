/**
 * Library analytics chain-count integration tests
 *
 * A play is one resume chain (COALESCE(reference_id, id)) gated at 2 minutes,
 * and titles dedup on media identity. A paused-and-resumed watch that lands as
 * two session rows must count once in /library/watch, /library/roi and
 * /library/stale, and the same movie on two servers must collapse to one title
 * in /sessions/history/aggregates and /library/top-movies.
 *
 * Run with: pnpm --filter @tracearr/server test:integration libraryChainCounts
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
import { libraryWatchRoute } from '../../src/routes/library/watch.js';
import { libraryRoiRoute } from '../../src/routes/library/roi.js';
import { libraryStaleRoute } from '../../src/routes/library/stale.js';
import { libraryTopContentRoute } from '../../src/routes/library/topContent.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { permissionGuard } from '../../src/lib/scope.js';

const THIRTY_MIN = 1_800_000;
const TWO_HOURS = 7_200_000;

async function buildApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (request.user.role !== 'owner') return reply.forbidden('Owner access required');
  });
  app.decorate('redis', getRedis() as never);
  await app.register(libraryWatchRoute, { prefix: '/library' });
  await app.register(libraryRoiRoute, { prefix: '/library' });
  await app.register(libraryStaleRoute, { prefix: '/library' });
  await app.register(libraryTopContentRoute, { prefix: '/library' });
  await app.register(sessionRoutes, { prefix: '/sessions' });
  return app;
}

function ownerFor(serverIds: string[]): AuthUser {
  return { userId: crypto.randomUUID(), username: 'owner', role: 'owner', serverIds };
}

interface ChainOptions {
  serverId: string;
  serverUserId: string;
  ratingKey: string;
  mediaId?: string | null;
  mediaTitle?: string;
  daysAgo?: number;
  segmentDurationMs?: number;
}

/** Insert a two-segment resume chain (second row references the first). */
async function seedChain(opts: ChainOptions): Promise<string> {
  const daysAgo = opts.daysAgo ?? 3;
  const startedAt = new Date(Date.now() - daysAgo * 86_400_000);
  const segmentMs = opts.segmentDurationMs ?? THIRTY_MIN;
  const first = await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    ratingKey: opts.ratingKey,
    mediaId: opts.mediaId ?? null,
    mediaTitle: opts.mediaTitle,
    state: 'stopped',
    startedAt,
    stoppedAt: new Date(startedAt.getTime() + segmentMs),
    durationMs: segmentMs,
    totalDurationMs: TWO_HOURS,
  });
  await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    ratingKey: opts.ratingKey,
    mediaId: opts.mediaId ?? null,
    mediaTitle: opts.mediaTitle,
    state: 'stopped',
    startedAt: new Date(startedAt.getTime() + segmentMs + 600_000),
    stoppedAt: new Date(startedAt.getTime() + 2 * segmentMs + 600_000),
    durationMs: segmentMs,
    totalDurationMs: TWO_HOURS,
    referenceId: first.id,
  });
  return first.id;
}

interface EpisodeOptions {
  serverId: string;
  serverUserId: string;
  ratingKey: string;
  showTitle: string;
  showMediaId?: string | null;
  mediaId?: string | null;
  seasonNumber?: number;
  episodeNumber?: number;
  daysAgo?: number;
}

/** Insert a single watched episode session that lands in daily_content_engagement. */
async function seedEpisode(opts: EpisodeOptions): Promise<void> {
  const startedAt = new Date(Date.now() - (opts.daysAgo ?? 3) * 86_400_000);
  await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    ratingKey: opts.ratingKey,
    mediaType: 'episode',
    grandparentTitle: opts.showTitle,
    showMediaId: opts.showMediaId ?? null,
    mediaId: opts.mediaId ?? null,
    seasonNumber: opts.seasonNumber ?? 1,
    episodeNumber: opts.episodeNumber ?? 1,
    state: 'stopped',
    watched: true,
    startedAt,
    stoppedAt: new Date(startedAt.getTime() + THIRTY_MIN),
    durationMs: THIRTY_MIN,
    totalDurationMs: THIRTY_MIN,
    progressMs: THIRTY_MIN,
  });
}

describe('library analytics count resume chains once', () => {
  let app: FastifyInstance | undefined;

  // Owner-all cache keys do not vary by server id, so stale entries leak across tests
  beforeEach(async () => {
    await getRedis().flushdb();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('/library/watch single-server counts a two-session chain as one play', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 990_002,
      title: 'Chain Movie',
      year: 2020,
      serverId: server.id,
      ratingKey: 'rk-watch',
    });
    await createTestLibraryItem({ serverId: server.id, ratingKey: 'rk-watch', mediaId });

    await seedChain({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'rk-watch',
      mediaId,
    });
    // Sub-2-minute stray session must not add a play
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'rk-watch',
      mediaId,
      state: 'stopped',
      startedAt: new Date(Date.now() - 86_400_000),
      stoppedAt: new Date(Date.now() - 86_400_000 + 60_000),
      durationMs: 60_000,
    });
    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    app = await buildApp(ownerFor([server.id]));
    const res = await app.inject({ method: 'GET', url: `/library/watch?serverId=${server.id}` });
    expect(res.statusCode).toBe(200);
    const { summary } = JSON.parse(res.body);
    expect(summary.totalItems).toBe(1);
    expect(summary.avgPlaysPerItem).toBe(1);
    expect(summary.totalWatchMs).toBe(2 * THIRTY_MIN);
  });

  it('/library/watch multi-server merges by media identity and counts one play per chain', async () => {
    const server1 = await createTestServer({ type: 'plex' });
    const server2 = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser();
    const account1 = await createTestServerUser({ serverId: server1.id, userId: user.id });
    const account2 = await createTestServerUser({ serverId: server2.id, userId: user.id });

    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 27205,
      title: 'Inception',
      year: 2010,
      serverId: server1.id,
      ratingKey: 'rk-m1',
    });

    await createTestLibraryItem({
      serverId: server1.id,
      ratingKey: 'rk-m1',
      title: 'Inception',
      mediaId,
    });
    await createTestLibraryItem({
      serverId: server2.id,
      ratingKey: 'rk-m2',
      title: 'Inception (Remux)',
      mediaId,
    });

    await seedChain({
      serverId: server1.id,
      serverUserId: account1.id,
      ratingKey: 'rk-m1',
      mediaId,
    });
    await seedChain({
      serverId: server2.id,
      serverUserId: account2.id,
      ratingKey: 'rk-m2',
      mediaId,
    });

    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    app = await buildApp(ownerFor([server1.id, server2.id]));
    const res = await app.inject({
      method: 'GET',
      url: `/library/watch?serverIds=${server1.id}&serverIds=${server2.id}`,
    });
    expect(res.statusCode).toBe(200);
    const { summary } = JSON.parse(res.body);
    expect(summary.totalItems).toBe(1);
    expect(summary.watchedCount).toBe(1);
    expect(summary.avgPlaysPerItem).toBe(2);
  });

  it('/library/roi counts a two-session chain as one play', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 990_001,
      title: 'Chain Movie',
      year: 2020,
      serverId: server.id,
      ratingKey: 'rk-roi',
    });
    // Size flows through the version row: the roi sizing reads versions
    // (identity-deduped), not the flat column
    const item = await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'rk-roi',
      mediaId,
      fileSize: 5368709120,
    });

    await seedChain({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'rk-roi',
      mediaId,
    });
    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    app = await buildApp(ownerFor([server.id]));
    const res = await app.inject({ method: 'GET', url: `/library/roi?serverId=${server.id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const row = body.items.find((i: { id: string }) => i.id === item.id);
    expect(row).toBeDefined();
    expect(row.watchCount).toBe(1);
    expect(row.totalWatchHours).toBeCloseTo(1, 5);
  });

  it('/library/stale reports one play for a two-session chain', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });
    const item = await createTestLibraryItem({ serverId: server.id, ratingKey: 'rk-stale' });

    await seedChain({
      serverId: server.id,
      serverUserId: account.id,
      ratingKey: 'rk-stale',
      daysAgo: 10,
    });

    app = await buildApp(ownerFor([server.id]));
    const res = await app.inject({
      method: 'GET',
      url: `/library/stale?serverId=${server.id}&staleDays=1`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const row = body.items.find((i: { id: string }) => i.id === item.id);
    expect(row).toBeDefined();
    expect(row.category).toBe('stale');
    expect(row.watchCount).toBe(1);
  });

  it('/sessions/history/aggregates dedups unique titles on media identity', async () => {
    const server1 = await createTestServer({ type: 'plex' });
    const server2 = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser();
    const account1 = await createTestServerUser({ serverId: server1.id, userId: user.id });
    const account2 = await createTestServerUser({ serverId: server2.id, userId: user.id });

    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 27205,
      title: 'Inception',
      year: 2010,
      serverId: server1.id,
      ratingKey: 'rk-agg-1',
    });

    // Same movie on both servers under different titles: one unique title
    await seedChain({
      serverId: server1.id,
      serverUserId: account1.id,
      ratingKey: 'rk-agg-1',
      mediaId,
      mediaTitle: 'Inception',
    });
    const soloStart = new Date(Date.now() - 2 * 86_400_000);
    await createTestSession({
      serverId: server2.id,
      serverUserId: account2.id,
      ratingKey: 'rk-agg-2',
      mediaId,
      mediaTitle: 'Inception 4K',
      state: 'stopped',
      startedAt: soloStart,
      stoppedAt: new Date(soloStart.getTime() + THIRTY_MIN),
      durationMs: THIRTY_MIN,
    });

    // Two unidentified sessions with empty rating keys and distinct titles:
    // the empty string must not collapse them into one 'rk:' key
    const alpha = await createTestSession({
      serverId: server1.id,
      serverUserId: account1.id,
      mediaTitle: 'Alpha Movie',
      state: 'stopped',
      startedAt: soloStart,
      stoppedAt: new Date(soloStart.getTime() + THIRTY_MIN),
      durationMs: THIRTY_MIN,
    });
    const beta = await createTestSession({
      serverId: server1.id,
      serverUserId: account1.id,
      mediaTitle: 'Beta Movie',
      state: 'stopped',
      startedAt: soloStart,
      stoppedAt: new Date(soloStart.getTime() + THIRTY_MIN),
      durationMs: THIRTY_MIN,
    });
    await db.execute(
      sql`UPDATE sessions SET rating_key = '' WHERE id IN (${alpha.id}, ${beta.id})`
    );

    app = await buildApp(ownerFor([server1.id, server2.id]));
    const res = await app.inject({ method: 'GET', url: '/sessions/history/aggregates' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.playCount).toBe(4);
    expect(body.uniqueContent).toBe(3);
  });

  it('/library/top-movies multi-server merges the same movie by media identity', async () => {
    const server1 = await createTestServer({ type: 'plex' });
    const server2 = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser();
    const account1 = await createTestServerUser({ serverId: server1.id, userId: user.id });
    const account2 = await createTestServerUser({ serverId: server2.id, userId: user.id });

    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 27205,
      title: 'Inception',
      year: 2010,
      serverId: server1.id,
      ratingKey: 'rk-top-1',
    });

    const startedAt = new Date(Date.now() - 3 * 86_400_000);
    for (const [serverId, accountId, ratingKey, title] of [
      [server1.id, account1.id, 'rk-top-1', 'Inception'],
      [server2.id, account2.id, 'rk-top-2', 'Inception (Remux)'],
    ] as const) {
      await createTestSession({
        serverId,
        serverUserId: accountId,
        ratingKey,
        mediaId,
        mediaTitle: title,
        mediaType: 'movie',
        state: 'stopped',
        startedAt,
        stoppedAt: new Date(startedAt.getTime() + 6_600_000),
        durationMs: 6_600_000,
        totalDurationMs: TWO_HOURS,
        progressMs: 6_600_000,
      });
    }

    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    app = await buildApp(ownerFor([server1.id, server2.id]));
    const res = await app.inject({ method: 'GET', url: '/library/top-movies' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rows = body.items.filter((i: { serverIds: string[] }) =>
      i.serverIds.some((s) => s === server1.id || s === server2.id)
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].totalPlays).toBe(2);
    expect(rows[0].serverIds.sort()).toEqual([server1.id, server2.id].sort());
    expect(body.summary.totalMovies).toBe(1);
  });

  it('/library/top-shows multi-server dedups by show identity, in both the all-servers and the single-server path', async () => {
    const server1 = await createTestServer({ type: 'plex' });
    const server2 = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser();
    const account1 = await createTestServerUser({ serverId: server1.id, userId: user.id });
    const account2 = await createTestServerUser({ serverId: server2.id, userId: user.id });

    // Identity-matched show: same show_media_id on both servers under different
    // titles, so only the media identity (not the title) can collapse them.
    const showMediaId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 81189,
      title: 'Breaking Bad',
      serverId: server1.id,
      ratingKey: 'sa-show-plex',
    });

    const episodeId = async (serverId: string, ratingKey: string, episodeNumber: number) =>
      resolveMediaForItem({
        mediaType: 'episode',
        tvdbId: 811_890 + episodeNumber,
        title: `Episode ${episodeNumber}`,
        serverId,
        ratingKey,
        showMediaId,
      });
    await seedEpisode({
      serverId: server1.id,
      serverUserId: account1.id,
      ratingKey: 'sa-s1e1',
      showTitle: 'Breaking Bad',
      showMediaId,
      mediaId: await episodeId(server1.id, 'sa-s1e1', 1),
      episodeNumber: 1,
    });
    await seedEpisode({
      serverId: server1.id,
      serverUserId: account1.id,
      ratingKey: 'sa-s1e2',
      showTitle: 'Breaking Bad',
      showMediaId,
      mediaId: await episodeId(server1.id, 'sa-s1e2', 2),
      episodeNumber: 2,
    });
    await seedEpisode({
      serverId: server2.id,
      serverUserId: account2.id,
      ratingKey: 'sa-s2e1',
      showTitle: 'Breaking Bad (Remux)',
      showMediaId,
      mediaId: await episodeId(server2.id, 'sa-s2e1', 1),
      episodeNumber: 1,
    });

    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    app = await buildApp(ownerFor([server1.id, server2.id]));
    const res = await app.inject({ method: 'GET', url: '/library/top-shows' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    const identityRows = body.items.filter((i: { showTitle: string }) =>
      i.showTitle.startsWith('Breaking Bad')
    );
    expect(identityRows).toHaveLength(1);
    const identityShow = identityRows[0];
    expect(identityShow.serverIds.sort()).toEqual([server1.id, server2.id].sort());
    expect(identityShow.totalEpisodeViews).toBe(3);
    expect(identityShow.totalWatchHours).toBeCloseTo(1.5, 5);
    expect(identityShow.uniqueViewers).toBe(1);
    expect(typeof identityShow.showTitle).toBe('string');

    expect(body.summary.totalShows).toBe(1);

    const singleRes = await app.inject({
      method: 'GET',
      url: `/library/top-shows?serverId=${server1.id}`,
    });
    expect(singleRes.statusCode).toBe(200);
    const singleBody = JSON.parse(singleRes.body);
    const singleIdentity = singleBody.items.find((i: { showTitle: string }) =>
      i.showTitle.startsWith('Breaking Bad')
    );
    expect(singleIdentity).toBeDefined();
    expect(singleIdentity.serverIds).toEqual([server1.id]);
    expect(singleIdentity.totalEpisodeViews).toBe(2);
    expect(singleIdentity.totalWatchHours).toBeCloseTo(1.0, 5);
  });
});

describe('library analytics max-review regressions', () => {
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    await getRedis().flushdb();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('/sessions/history/aggregates collapses the same unstamped title across servers', async () => {
    const server1 = await createTestServer({ type: 'plex' });
    const server2 = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser();
    const account1 = await createTestServerUser({ serverId: server1.id, userId: user.id });
    const account2 = await createTestServerUser({ serverId: server2.id, userId: user.id });

    // No media_id and no library_items row on either server: only the
    // normalized-title fallback can collapse them into one unique title.
    const startedAt = new Date(Date.now() - 2 * 86_400_000);
    for (const [serverId, accountId, ratingKey, title] of [
      [server1.id, account1.id, 'orphan-a', 'Orphan Film'],
      [server2.id, account2.id, 'orphan-b', 'orphan film!'],
    ] as const) {
      await createTestSession({
        serverId,
        serverUserId: accountId,
        ratingKey,
        mediaTitle: title,
        state: 'stopped',
        startedAt,
        stoppedAt: new Date(startedAt.getTime() + THIRTY_MIN),
        durationMs: THIRTY_MIN,
      });
    }

    app = await buildApp(ownerFor([server1.id, server2.id]));
    const res = await app.inject({ method: 'GET', url: '/sessions/history/aggregates' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.playCount).toBe(2);
    expect(body.uniqueContent).toBe(1);
  });

  it('/library/top-movies keeps different movies sharing a rating key across servers separate', async () => {
    const server1 = await createTestServer({ type: 'plex' });
    const server2 = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser();
    const account1 = await createTestServerUser({ serverId: server1.id, userId: user.id });
    const account2 = await createTestServerUser({ serverId: server2.id, userId: user.id });

    // Plex rating keys are small sequential integers, so unrelated movies on
    // two servers can share one; they must not merge into a single entry.
    const startedAt = new Date(Date.now() - 3 * 86_400_000);
    for (const [serverId, accountId, title, tmdbId] of [
      [server1.id, account1.id, 'First Feature', 990_101],
      [server2.id, account2.id, 'Second Feature', 990_102],
    ] as const) {
      const mediaId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId,
        title,
        year: 2020,
        serverId,
        ratingKey: '12345',
      });
      await createTestSession({
        serverId,
        serverUserId: accountId,
        ratingKey: '12345',
        mediaId,
        mediaTitle: title,
        mediaType: 'movie',
        state: 'stopped',
        startedAt,
        stoppedAt: new Date(startedAt.getTime() + 6_600_000),
        durationMs: 6_600_000,
        totalDurationMs: TWO_HOURS,
        progressMs: 6_600_000,
      });
    }

    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    app = await buildApp(ownerFor([server1.id, server2.id]));
    const res = await app.inject({ method: 'GET', url: '/library/top-movies' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rows = body.items.filter((i: { serverIds: string[] }) =>
      i.serverIds.some((s: string) => s === server1.id || s === server2.id)
    );
    expect(rows).toHaveLength(2);
    const titles = rows.map((r: { title: string }) => r.title).sort();
    expect(titles).toEqual(['First Feature', 'Second Feature']);
    for (const row of rows) {
      expect(row.totalPlays).toBe(1);
      expect(row.serverIds).toHaveLength(1);
    }
    expect(body.summary.totalMovies).toBe(2);
  });
});
