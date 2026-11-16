/**
 * Album sheet endpoint against a real database.
 *
 * media.routes.test.ts mocks db.execute, so the track join, the number and title dedupe across
 * copies, chain grouping and member scoping are only proven here. The scenario is musicFixtures'
 * artist on two servers: Discovery is held on both, "One More Time" is track 1 on both copies,
 * and server B's copy adds "Digital Love" and a second "One More Time" at track 14, neither
 * played. Account A's play crosses UTC midnight.
 *
 * Run with: pnpm --filter @tracearr/server test:integration albumDetail
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import type { AlbumDetailResponse, AuthUser } from '@tracearr/shared';
import { createTestLibraryItem, createTestSession } from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { libraryMediaRoute } from '../../src/routes/library/media.js';
import { permissionGuard } from '../../src/lib/scope.js';
import { seedArtistOnTwoServers, type MusicScenario } from './musicFixtures.js';

const DAY_MS = 86_400_000;

async function buildApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('redis', createMockRedis() as unknown as Redis);
  await app.register(libraryMediaRoute, { prefix: '/library' });
  return app;
}

async function fetchAlbum(
  authUser: AuthUser,
  albumId: string,
  serverIds: string[] = []
): Promise<{ statusCode: number; body: AlbumDetailResponse }> {
  const app = await buildApp(authUser);
  const query = serverIds.map((id) => `serverIds=${id}`).join('&');
  const response = await app.inject({
    method: 'GET',
    url: `/library/media/${albumId}/album${query ? `?${query}` : ''}`,
  });
  await app.close();
  return { statusCode: response.statusCode, body: response.json<AlbumDetailResponse>() };
}

const owner = (): AuthUser => ({
  userId: randomUUID(),
  username: 'owner',
  role: 'owner',
  serverIds: [],
});

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  const result = await db.execute(query);
  return result.rows[0] as T;
}

interface AlbumScenario extends MusicScenario {
  albumId: string;
  memberUserId: string;
  lastPlayedDay: string;
}

async function seedAlbum(): Promise<AlbumScenario> {
  const music = await seedArtistOnTwoServers();
  const { album_id: albumId } = await one<{ album_id: string }>(sql`
    SELECT media_id AS album_id FROM library_items
    WHERE server_id = ${music.serverA} AND rating_key = 'Discovery-a'
  `);
  await db.execute(sql`
    UPDATE library_items SET item_index = 1
    WHERE rating_key IN ('One More Time-a', 'One More Time-b')
  `);
  for (const [ratingKey, title, index] of [
    ['Digital Love-b', 'Digital Love', 3],
    ['One More Time Reprise-b', 'One More Time', 14],
  ] as const) {
    await createTestLibraryItem({
      serverId: music.serverB,
      ratingKey,
      title,
      mediaType: 'track',
      grandparentRatingKey: 'artist-b',
      parentRatingKey: 'Discovery-b',
      fileSize: 9_000_000,
    });
    await db.execute(sql`
      UPDATE library_items SET item_index = ${index}
      WHERE server_id = ${music.serverB} AND rating_key = ${ratingKey}
    `);
  }

  const recent = await one<{ server_user_id: string; media_id: string; started_at: Date }>(sql`
    SELECT server_user_id, media_id, started_at FROM sessions
    WHERE server_id = ${music.serverB} AND rating_key = 'One More Time-b'
  `);
  const oldStart = new Date(new Date(recent.started_at).getTime() - 40 * DAY_MS);
  await createTestSession({
    serverId: music.serverB,
    serverUserId: recent.server_user_id,
    mediaId: recent.media_id,
    ratingKey: 'One More Time-b',
    grandparentRatingKey: 'artist-b',
    mediaType: 'track',
    playerName: 'Finamp',
    platform: 'Android',
    state: 'stopped',
    durationMs: 200_000,
    totalDurationMs: 320_000,
    progressMs: 200_000,
    watched: true,
    startedAt: oldStart,
    stoppedAt: new Date(oldStart.getTime() + 200_000),
  });
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );

  const { user_id: memberUserId } = await one<{ user_id: string }>(sql`
    SELECT user_id FROM server_users WHERE server_id = ${music.serverA}
  `);
  await db.execute(sql`UPDATE users SET role = 'member' WHERE id = ${memberUserId}`);
  const recentDay = new Date(recent.started_at);
  recentDay.setUTCHours(0, 0, 0, 0);
  return { ...music, albumId, memberUserId, lastPlayedDay: recentDay.toISOString() };
}

describe('GET /library/media/:id/album', () => {
  it('dedupes tracks by number and title across two copies and sums their plays as chains', async () => {
    const s = await seedAlbum();

    const { statusCode, body } = await fetchAlbum(owner(), s.albumId);
    expect(statusCode).toBe(200);
    expect(body.album).toMatchObject({
      id: s.albumId,
      title: 'Discovery',
      artistTitle: 'Daft Punk',
      artistMediaId: s.artistMediaId,
      year: 2001,
      trackCount: 3,
      durationMs: null,
      addedAt: '2024-02-10T00:00:00.000Z',
    });
    expect(body.album.copies).toHaveLength(2);
    expect(body.album.posterUrl).toContain('width=360&height=360');
    expect(body.last30).toEqual({ plays: 2, priorPlays: 1, listenMs: 600_000 });
    expect(body.allTime.plays).toBe(3);
    expect(body.allTime.finishedRate).toBe(33.3);
    expect(body.allTime.listeners.map(({ plays, share }) => ({ plays, share }))).toEqual([
      { plays: 2, share: 66.7 },
      { plays: 1, share: 33.3 },
    ]);
    expect(body.tracks).toEqual([
      {
        index: 1,
        title: 'One More Time',
        durationMs: null,
        plays: 3,
        lastPlayedAt: s.lastPlayedDay,
      },
      { index: 3, title: 'Digital Love', durationMs: null, plays: 0, lastPlayedAt: null },
      { index: 14, title: 'One More Time', durationMs: null, plays: 0, lastPlayedAt: null },
    ]);
  });

  it("narrows to the requested server's copy and its plays", async () => {
    const s = await seedAlbum();

    const { body } = await fetchAlbum(owner(), s.albumId, [s.serverA]);
    expect(body.album.copies).toEqual([{ serverId: s.serverA, ratingKey: 'Discovery-a' }]);
    expect(body.allTime.plays).toBe(1);
    expect(body.tracks.map((track) => track.title)).toEqual(['One More Time']);
  });

  it('names a listener by their Tracearr user, not by the account on the selected server', async () => {
    const s = await seedAlbum();
    await db.execute(sql`
      UPDATE server_users SET username = 'zoe_a', last_activity_at = now()
      WHERE server_id = ${s.serverA}
    `);
    await db.execute(sql`
      UPDATE users SET name = NULL, username = 'zoe'
      WHERE id = (SELECT user_id FROM server_users WHERE server_id = ${s.serverA})
    `);
    await db.execute(sql`
      UPDATE server_users SET username = 'aaron_b', last_activity_at = now() - interval '1 day',
        user_id = (SELECT user_id FROM server_users WHERE server_id = ${s.serverA})
      WHERE server_id = ${s.serverB}
    `);

    const { body } = await fetchAlbum(owner(), s.albumId, [s.serverB]);
    expect(body.allTime.listeners.map(({ name }) => name)).toEqual(['zoe']);
  });

  it('gives a member their own plays and no listener names', async () => {
    const s = await seedAlbum();

    const { statusCode, body } = await fetchAlbum(
      { userId: s.memberUserId, username: 'member', role: 'member', serverIds: [] },
      s.albumId
    );
    expect(statusCode).toBe(200);
    expect(body.last30.plays).toBe(1);
    expect(body.allTime.plays).toBe(1);
    expect(body.allTime.listeners).toEqual([]);
  });

  it('takes the poster from the copy with art over a newer untagged Emby copy', async () => {
    const s = await seedAlbum();
    await db.execute(sql`UPDATE servers SET type = 'emby' WHERE id = ${s.serverB}`);
    await db.execute(sql`
      UPDATE library_items
      SET thumb_path = '/Items/88412/Images/Primary', created_at = '2026-09-28T19:02:00Z'
      WHERE server_id = ${s.serverB} AND rating_key = 'Discovery-b'
    `);
    await db.execute(sql`
      UPDATE library_items
      SET thumb_path = '/library/metadata/38648/thumb/1761199736', created_at = '2025-03-14T08:30:00Z'
      WHERE server_id = ${s.serverA} AND rating_key = 'Discovery-a'
    `);

    const { body } = await fetchAlbum(owner(), s.albumId);
    expect(body.album.copies[0]).toEqual({ serverId: s.serverA, ratingKey: 'Discovery-a' });
    expect(body.album.posterUrl).toContain(`server=${s.serverA}`);
    expect(body.album.posterUrl).toContain(encodeURIComponent('/library/metadata/38648/thumb/'));
  });

  it('404s an artist id', async () => {
    const s = await seedAlbum();

    const { statusCode } = await fetchAlbum(owner(), s.artistMediaId);
    expect(statusCode).toBe(404);
  });
});
