/**
 * Merged-identity stats integration tests
 *
 * Confirms every leaderboard and user-count surface treats a merged person
 * (one identity, multiple server accounts) as ONE human, not one per account.
 *
 * Run with: pnpm --filter @tracearr/server test:integration mergedIdentityStats
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { PersonRow } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { peopleRoutes } from '../../src/routes/stats/people.js';
import { bandwidthRoutes } from '../../src/routes/stats/bandwidth.js';
import { contentRoutes } from '../../src/routes/stats/content.js';
import { engagementRoutes } from '../../src/routes/stats/engagement.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { libraryTopContentRoute } from '../../src/routes/library/topContent.js';
import { mergeUsers } from '../../src/services/mergeService.js';
import {
  resolveMediaForItem,
  mergeMediaRows,
} from '../../src/services/library/mediaResolutionService.js';
import { getDashboardStats } from '../../src/services/dashboardStats.js';
import { initPreparedStatements } from '../../src/db/prepared.js';
import { sql } from 'drizzle-orm';
import { permissionGuard } from '../../src/lib/scope.js';

function ownerAuth(userId: string) {
  return { userId, username: 'owner', role: 'owner' as const, serverIds: [] as string[] };
}

async function buildApp(plugin: Parameters<typeof Fastify.prototype.register>[0]) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  app.decorate('authenticate', async (request: any) => {
    request.user = ownerAuth(request.headers['x-test-user-id'] ?? 'owner');
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (request.user.role !== 'owner') return reply.forbidden('Owner access required');
  });
  await app.register(plugin as any);
  return app;
}

describe('merged identity stats', () => {
  beforeAll(() => {
    // Dashboard stats' no-filter branch uses prepared statements, which are
    // only created by server startup in production - initialize them here.
    initPreparedStatements();
  });

  describe('GET /people ranked by plays', () => {
    // user_media_plays_daily only holds sessions stamped with a media id
    const rankedMovie = (serverId: string) =>
      resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: 551,
        title: 'Ranked Movie',
        year: 2020,
        serverId,
        ratingKey: 'ranked-rk',
      });

    it('returns one entry for a merged person with plays/watch time summed, identity trust, and a representative serverUserId', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const mediaId = await rankedMovie(serverA.id);

      const target = await createTestUser({ role: 'member', name: 'Merged Person' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({
        userId: target.id,
        serverId: serverA.id,
        trustScore: 90,
        lastActivityAt: new Date('2026-06-01T00:00:00Z'),
      });
      const sourceSu = await createTestServerUser({
        userId: source.id,
        serverId: serverB.id,
        trustScore: 50,
        lastActivityAt: new Date('2026-06-02T00:00:00Z'),
      });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        mediaId,
        durationMs: 600_000,
        totalDurationMs: 7_200_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        mediaId,
        durationMs: 900_000,
        totalDurationMs: 7_200_000,
      });

      const unmerged = await createTestUser({ role: 'member', name: 'Solo Person' });
      const unmergedSu = await createTestServerUser({ userId: unmerged.id, serverId: serverA.id });
      await createTestSession({
        serverId: serverA.id,
        serverUserId: unmergedSu.id,
        mediaId,
        durationMs: 300_000,
        totalDurationMs: 7_200_000,
      });

      await mergeUsers(source.id, target.id, admin.id);
      await db.execute(
        sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
      );

      const app = await buildApp(peopleRoutes);
      const response = await app.inject({ method: 'GET', url: '/people?period=all&rank=plays' });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const rows = body.data as PersonRow[];

      const mergedRows = rows.filter((r) => r.userId === target.id);
      expect(mergedRows).toHaveLength(1);
      const mergedRow = mergedRows[0];
      expect(mergedRow?.watchMs).toBe(1_500_000);
      expect(mergedRow?.plays).toBe(2);
      // Representative account chosen by session count tiebreak (source has 30 > target's 10)
      expect(mergedRow?.serverUserId).toBe(sourceSu.id);
      // Identity aggregate trust is the worst account: min(90, 50) = 50,
      // not the representative account's own score
      expect(mergedRow?.trustScore).toBe(50);
      expect(mergedRow?.identityServers?.map((s) => s.id).sort()).toEqual(
        [serverA.id, serverB.id].sort()
      );

      const unmergedRows = rows.filter((r) => r.userId === unmerged.id);
      expect(unmergedRows).toHaveLength(1);
      expect(unmergedRows[0]?.plays).toBe(1);
      expect(unmergedRows[0]?.serverUserId).toBe(unmergedSu.id);
    });

    it('only counts sessions on the selected servers when serverIds narrows the request', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const mediaId = await rankedMovie(serverA.id);

      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        mediaId,
        durationMs: 600_000,
        totalDurationMs: 7_200_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        mediaId,
        durationMs: 900_000,
        totalDurationMs: 7_200_000,
      });

      await mergeUsers(source.id, target.id, admin.id);
      await db.execute(
        sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
      );

      const app = await buildApp(peopleRoutes);
      const response = await app.inject({
        method: 'GET',
        url: `/people?period=all&rank=plays&serverIds=${serverA.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const rows = body.data as PersonRow[];
      const row = rows.find((r) => r.userId === target.id);

      expect(row).toBeDefined();
      // Only serverA's session counts - not the 900_000ms serverB session
      expect(row?.plays).toBe(1);
      expect(row?.watchMs).toBe(600_000);
    });
  });

  describe('dashboard active users', () => {
    it('counts a merged person once with no server filter (prepared-statement branch)', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      // must stay within the current UTC day for activeUsersToday to count it deterministically
      const since = new Date();
      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        startedAt: since,
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        startedAt: since,
        durationMs: 600_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const stats = await getDashboardStats({
        serverIds: undefined,
        scope: 'all',
        timezone: 'UTC',
      });
      expect(stats.activeUsersToday).toBe(1);
    });

    it('counts a merged person once when scoped to specific servers (dynamic-query branch)', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      // must stay within the current UTC day for activeUsersToday to count it deterministically
      const since = new Date();
      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        startedAt: since,
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        startedAt: since,
        durationMs: 600_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const stats = await getDashboardStats({
        serverIds: [serverA.id, serverB.id],
        scope: 'all',
        timezone: 'UTC',
      });
      expect(stats.activeUsersToday).toBe(1);
    });
  });

  describe('GET /sessions/history/aggregates', () => {
    it('counts unique users by identity, not by account', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      const solo = await createTestUser({ role: 'member' });
      const soloSu = await createTestServerUser({ userId: solo.id, serverId: serverA.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverA.id,
        serverUserId: soloSu.id,
        durationMs: 600_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const app = await buildApp(sessionRoutes);
      const response = await app.inject({ method: 'GET', url: '/history/aggregates' });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Merged person (1) + solo person (1) = 2, not 3 accounts
      expect(body.uniqueUsers).toBe(2);
    });

    it('counts a title merged after the fact once, even under different titles/rating keys', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const viewerA = await createTestUser({ role: 'member' });
      const viewerB = await createTestUser({ role: 'member' });
      const viewerASu = await createTestServerUser({ userId: viewerA.id, serverId: serverA.id });
      const viewerBSu = await createTestServerUser({ userId: viewerB.id, serverId: serverB.id });

      const winnerId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: Math.floor(Math.random() * 1_000_000),
        title: 'Aggregate Winner',
        year: 2020,
        serverId: serverA.id,
        ratingKey: 'agg-winner',
      });
      const loserId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: Math.floor(Math.random() * 1_000_000),
        title: 'Aggregate Loser',
        year: 2020,
        serverId: serverB.id,
        ratingKey: 'agg-loser',
      });
      await mergeMediaRows(winnerId, loserId);

      await createTestSession({
        serverId: serverA.id,
        serverUserId: viewerASu.id,
        mediaTitle: 'Aggregate Winner',
        ratingKey: 'agg-winner',
        mediaId: winnerId,
        state: 'stopped',
        durationMs: 600_000,
      });
      // Stamped with the pre-merge loser id, as historical sessions stay after a merge
      await createTestSession({
        serverId: serverB.id,
        serverUserId: viewerBSu.id,
        mediaTitle: 'Aggregate Loser',
        ratingKey: 'agg-loser',
        mediaId: loserId,
        state: 'stopped',
        durationMs: 600_000,
      });

      const app = await buildApp(sessionRoutes);
      const response = await app.inject({
        method: 'GET',
        url: `/history/aggregates?serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.playCount).toBe(2);
      // Different titles/rating keys on each server - only the merge fold collapses this to 1
      expect(body.uniqueContent).toBe(1);
    });

    it('counts an unstamped CJK-titled play on two servers as one unique title, not two', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const viewerA = await createTestUser({ role: 'member' });
      const viewerB = await createTestUser({ role: 'member' });
      const viewerASu = await createTestServerUser({ userId: viewerA.id, serverId: serverA.id });
      const viewerBSu = await createTestServerUser({ userId: viewerB.id, serverId: serverB.id });

      // No mediaId (unstamped) and a title that ASCII-strips to '' - the ASCII
      // title tier can't dedupe this pair, only the raw-title fallback can.
      await createTestSession({
        serverId: serverA.id,
        serverUserId: viewerASu.id,
        mediaTitle: '千と千尋の神隠し',
        ratingKey: 'cjk-a',
        state: 'stopped',
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: viewerBSu.id,
        mediaTitle: '千と千尋の神隠し',
        ratingKey: 'cjk-b',
        state: 'stopped',
        durationMs: 600_000,
      });

      const app = await buildApp(sessionRoutes);
      const response = await app.inject({
        method: 'GET',
        url: `/history/aggregates?serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.playCount).toBe(2);
      expect(body.uniqueContent).toBe(1);
    });

    it('excludes plays with neither a usable title nor a rating key from the unique-titles count', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const viewerA = await createTestUser({ role: 'member' });
      const viewerB = await createTestUser({ role: 'member' });
      const viewerASu = await createTestServerUser({ userId: viewerA.id, serverId: serverA.id });
      const viewerBSu = await createTestServerUser({ userId: viewerB.id, serverId: serverB.id });

      // Two different, unidentified movies: no title, no rating key, on different servers.
      await createTestSession({
        serverId: serverA.id,
        serverUserId: viewerASu.id,
        mediaTitle: '',
        ratingKey: '',
        state: 'stopped',
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: viewerBSu.id,
        mediaTitle: '',
        ratingKey: '',
        state: 'stopped',
        durationMs: 600_000,
      });

      const app = await buildApp(sessionRoutes);
      const response = await app.inject({
        method: 'GET',
        url: `/history/aggregates?serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.playCount).toBe(2);
      expect(body.uniqueContent).toBe(0);
    });
  });

  describe('GET /bandwidth/top-users and /bandwidth/summary', () => {
    it('returns one bandwidth row for a merged person and counts unique users by identity', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        durationMs: 600_000,
        bitrate: 5000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        durationMs: 600_000,
        bitrate: 8000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      const app = await buildApp(bandwidthRoutes);

      const topUsersResponse = await app.inject({
        method: 'GET',
        url: '/bandwidth/top-users?period=all',
      });
      const summaryResponse = await app.inject({
        method: 'GET',
        url: '/bandwidth/summary?period=all',
      });
      await app.close();

      expect(topUsersResponse.statusCode).toBe(200);
      const topUsersBody = topUsersResponse.json();
      const rows = topUsersBody.data as { serverUserId: string; totalBytes: number }[];
      const mergedRows = rows.filter(
        (r) => r.serverUserId === targetSu.id || r.serverUserId === sourceSu.id
      );
      expect(mergedRows).toHaveLength(1);
      expect(mergedRows[0]?.totalBytes).toBeGreaterThan(0);

      expect(summaryResponse.statusCode).toBe(200);
      const summaryBody = summaryResponse.json();
      expect(summaryBody.uniqueUsers).toBe(1);
    });
  });

  describe('GET /library/top-movies (multi-server)', () => {
    it('collapses a movie merged after the fact into one row with summed plays', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const viewerA = await createTestUser({ role: 'member' });
      const viewerB = await createTestUser({ role: 'member' });
      const viewerASu = await createTestServerUser({ userId: viewerA.id, serverId: serverA.id });
      const viewerBSu = await createTestServerUser({ userId: viewerB.id, serverId: serverB.id });

      const winnerId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: Math.floor(Math.random() * 1_000_000),
        title: 'Top Winner Movie',
        year: 2021,
        serverId: serverA.id,
        ratingKey: 'top-winner',
      });
      const loserId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: Math.floor(Math.random() * 1_000_000),
        title: 'Top Loser Movie',
        year: 2021,
        serverId: serverB.id,
        ratingKey: 'top-loser',
      });
      await mergeMediaRows(winnerId, loserId);

      await createTestSession({
        serverId: serverA.id,
        serverUserId: viewerASu.id,
        mediaTitle: 'Top Winner Movie',
        ratingKey: 'top-winner',
        year: 2021,
        mediaId: winnerId,
        durationMs: 7_200_000,
        totalDurationMs: 7_200_000,
      });
      // Stamped with the pre-merge loser id, as historical sessions stay after a merge
      await createTestSession({
        serverId: serverB.id,
        serverUserId: viewerBSu.id,
        mediaTitle: 'Top Loser Movie',
        ratingKey: 'top-loser',
        year: 2021,
        mediaId: loserId,
        durationMs: 7_200_000,
        totalDurationMs: 7_200_000,
      });

      await db.execute(
        sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
      );

      const app = await buildApp(libraryTopContentRoute);
      const response = await app.inject({
        method: 'GET',
        url: `/top-movies?period=all&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const items = body.items as { title: string; totalPlays: number; serverIds: string[] }[];
      // Different titles/rating keys on each server - only the merge fold collapses this to 1
      const matches = items.filter(
        (i) => i.title === 'Top Winner Movie' || i.title === 'Top Loser Movie'
      );

      expect(matches).toHaveLength(1);
      expect(matches[0]?.totalPlays).toBe(2);
      expect(matches[0]?.serverIds.sort()).toEqual([serverA.id, serverB.id].sort());
    });

    it('counts a person watching the same title on two servers as one unique viewer', async () => {
      const admin = await createTestUser({ role: 'owner' });
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const target = await createTestUser({ role: 'member' });
      const source = await createTestUser({ role: 'member' });
      const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
      const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });

      const sharedTitle = 'Cross Server Movie';
      // Cross-server dedup keys on the media identity stamped on sessions
      const mediaId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: 550,
        title: sharedTitle,
        year: 2020,
        serverId: serverA.id,
        ratingKey: 'a-rk-1',
      });
      await createTestSession({
        serverId: serverA.id,
        serverUserId: targetSu.id,
        mediaTitle: sharedTitle,
        ratingKey: 'a-rk-1',
        mediaId,
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: sourceSu.id,
        mediaTitle: sharedTitle,
        ratingKey: 'b-rk-1',
        mediaId,
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
      });

      await mergeUsers(source.id, target.id, admin.id);

      // The engagement continuous aggregate only reflects data after a refresh.
      await db.execute(
        sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
      );

      const app = await buildApp(libraryTopContentRoute);
      const response = await app.inject({
        method: 'GET',
        url: `/top-movies?period=all&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const items = body.items as { title: string; uniqueViewers: number; serverIds: string[] }[];
      const merged = items.find((i) => i.title === sharedTitle);

      expect(merged).toBeDefined();
      expect(merged?.serverIds.sort()).toEqual([serverA.id, serverB.id].sort());
      expect(merged?.uniqueViewers).toBe(1);
    });
  });

  describe('GET /stats/top-content (multi-server)', () => {
    it('counts a movie merged after the fact once, with plays summed', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const viewerA = await createTestUser({ role: 'member' });
      const viewerB = await createTestUser({ role: 'member' });
      const viewerASu = await createTestServerUser({ userId: viewerA.id, serverId: serverA.id });
      const viewerBSu = await createTestServerUser({ userId: viewerB.id, serverId: serverB.id });

      const winnerId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: Math.floor(Math.random() * 1_000_000),
        title: 'Content Winner Movie',
        year: 2022,
        serverId: serverA.id,
        ratingKey: 'content-winner',
      });
      const loserId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: Math.floor(Math.random() * 1_000_000),
        title: 'Content Loser Movie',
        year: 2022,
        serverId: serverB.id,
        ratingKey: 'content-loser',
      });
      await mergeMediaRows(winnerId, loserId);

      await createTestSession({
        serverId: serverA.id,
        serverUserId: viewerASu.id,
        mediaTitle: 'Content Winner Movie',
        ratingKey: 'content-winner',
        year: 2022,
        mediaId: winnerId,
        state: 'stopped',
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: viewerBSu.id,
        mediaTitle: 'Content Loser Movie',
        ratingKey: 'content-loser',
        year: 2022,
        mediaId: loserId,
        state: 'stopped',
        durationMs: 600_000,
      });

      const app = await buildApp(contentRoutes);
      const response = await app.inject({
        method: 'GET',
        url: `/top-content?period=week&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const movies = body.movies as { title: string; playCount: number }[];
      const matches = movies.filter(
        (m) => m.title === 'Content Winner Movie' || m.title === 'Content Loser Movie'
      );

      expect(matches).toHaveLength(1);
      expect(matches[0]?.playCount).toBe(2);
    });

    it('counts an unstamped CJK-titled movie on two servers as one row, not a split per server', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const viewerA = await createTestUser({ role: 'member' });
      const viewerB = await createTestUser({ role: 'member' });
      const viewerASu = await createTestServerUser({ userId: viewerA.id, serverId: serverA.id });
      const viewerBSu = await createTestServerUser({ userId: viewerB.id, serverId: serverB.id });

      // No mediaId (unstamped) and a title that ASCII-strips to '' - the ASCII
      // title tier can't dedupe this pair, only the raw-title fallback can.
      await createTestSession({
        serverId: serverA.id,
        serverUserId: viewerASu.id,
        mediaTitle: '千と千尋の神隠し',
        ratingKey: 'cjk-content-a',
        year: 2001,
        state: 'stopped',
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: viewerBSu.id,
        mediaTitle: '千と千尋の神隠し',
        ratingKey: 'cjk-content-b',
        year: 2001,
        state: 'stopped',
        durationMs: 600_000,
      });

      const app = await buildApp(contentRoutes);
      const response = await app.inject({
        method: 'GET',
        url: `/top-content?period=week&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const movies = response.json().movies as { title: string; playCount: number }[];
      const matches = movies.filter((m) => m.title === '千と千尋の神隠し');
      expect(matches).toHaveLength(1);
      expect(matches[0]?.playCount).toBe(2);
    });

    it('excludes sessions with neither a usable title nor a rating key, without merging them into a phantom row', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const viewerA = await createTestUser({ role: 'member' });
      const viewerB = await createTestUser({ role: 'member' });
      const viewerASu = await createTestServerUser({ userId: viewerA.id, serverId: serverA.id });
      const viewerBSu = await createTestServerUser({ userId: viewerB.id, serverId: serverB.id });

      // Two different, unidentified movies: no title, no rating key, no mediaId.
      await createTestSession({
        serverId: serverA.id,
        serverUserId: viewerASu.id,
        mediaTitle: '',
        ratingKey: '',
        state: 'stopped',
        durationMs: 600_000,
      });
      await createTestSession({
        serverId: serverB.id,
        serverUserId: viewerBSu.id,
        mediaTitle: '',
        ratingKey: '',
        state: 'stopped',
        durationMs: 600_000,
      });

      const app = await buildApp(contentRoutes);
      const response = await app.inject({
        method: 'GET',
        url: `/top-content?period=week&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const movies = response.json().movies as { title: string; playCount: number }[];
      expect(movies.filter((m) => m.title === '')).toHaveLength(0);
    });
  });

  describe('GET /stats/shows (multi-server, date-filtered)', () => {
    it('counts a show merged after the fact once, with episode views summed', async () => {
      const serverA = await createTestServer({ type: 'plex' });
      const serverB = await createTestServer({ type: 'jellyfin' });
      const viewerA = await createTestUser({ role: 'member' });
      const viewerB = await createTestUser({ role: 'member' });
      const viewerASu = await createTestServerUser({ userId: viewerA.id, serverId: serverA.id });
      const viewerBSu = await createTestServerUser({ userId: viewerB.id, serverId: serverB.id });

      const winnerId = await resolveMediaForItem({
        mediaType: 'show',
        tvdbId: Math.floor(Math.random() * 1_000_000),
        title: 'Shows Winner',
        serverId: serverA.id,
        ratingKey: 'shows-winner',
      });
      const loserId = await resolveMediaForItem({
        mediaType: 'show',
        tvdbId: Math.floor(Math.random() * 1_000_000),
        title: 'Shows Loser',
        serverId: serverB.id,
        ratingKey: 'shows-loser',
      });
      await mergeMediaRows(winnerId, loserId);

      await createTestSession({
        serverId: serverA.id,
        serverUserId: viewerASu.id,
        mediaType: 'episode',
        grandparentTitle: 'Shows Winner',
        showMediaId: winnerId,
        ratingKey: 'shows-winner-e1',
        seasonNumber: 1,
        episodeNumber: 1,
        state: 'stopped',
        watched: true,
        durationMs: 1_800_000,
        totalDurationMs: 1_800_000,
        progressMs: 1_800_000,
      });
      // Stamped with the pre-merge loser id, as historical sessions stay after a merge
      await createTestSession({
        serverId: serverB.id,
        serverUserId: viewerBSu.id,
        mediaType: 'episode',
        grandparentTitle: 'Shows Loser',
        showMediaId: loserId,
        ratingKey: 'shows-loser-e1',
        seasonNumber: 1,
        episodeNumber: 1,
        state: 'stopped',
        watched: true,
        durationMs: 1_800_000,
        totalDurationMs: 1_800_000,
        progressMs: 1_800_000,
      });

      await db.execute(
        sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
      );

      const app = await buildApp(engagementRoutes);
      const response = await app.inject({
        method: 'GET',
        url: `/shows?period=week&serverIds=${serverA.id}&serverIds=${serverB.id}`,
      });
      await app.close();

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const shows = body.data as { showTitle: string; totalEpisodeViews: number }[];
      const matches = shows.filter(
        (s) => s.showTitle === 'Shows Winner' || s.showTitle === 'Shows Loser'
      );

      expect(matches).toHaveLength(1);
      expect(matches[0]?.totalEpisodeViews).toBe(2);
    });
  });
});
