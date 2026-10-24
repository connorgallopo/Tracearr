/**
 * Public API v2 /history and /streams integration tests
 *
 * Real token auth, real database, real Redis-backed session cache. History
 * records are resume chains: the cursor pages at chain grain, so a chain whose
 * continuation lands between other chains' start times must appear exactly
 * once with its full summed duration.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- publicV2Api
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_STREAM_DETAILS, REDIS_KEYS, type ActiveSession } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { countedSessionSql } from '../../src/db/sessions/rules.js';
import { db } from '../../src/db/client.js';
import { users, media, sessions, libraryItems } from '../../src/db/schema.js';
import authPlugin from '../../src/plugins/auth.js';
import { publicV2Routes } from '../../src/routes/publicV2/index.js';
import { decodeCursor } from '../../src/utils/cursor.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { createCacheService, type CacheService } from '../../src/services/cache.js';
import {
  resolveMediaForItem,
  mergeMediaRows,
} from '../../src/services/library/mediaResolutionService.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(fastifyCookie, { secret: 'test-cookie-secret-32-chars-long!' });
  app.decorate('redis', getRedis());
  await app.register(authPlugin);
  await app.register(publicV2Routes, { prefix: '/api/v2/public' });
  return app;
}

async function seedOwnerToken(): Promise<string> {
  const owner = await createTestUser({ role: 'owner' });
  const token = `trr_pub_${randomUUID().replace(/-/g, '')}`;
  await db.update(users).set({ apiToken: token }).where(eq(users.id, owner.id));
  return token;
}

function fakeActiveSession(overrides: {
  id: string;
  serverId: string;
  serverName: string;
  serverType: 'plex' | 'jellyfin' | 'emby';
  serverUserId: string;
  username: string;
  ratingKey?: string | null;
}): ActiveSession {
  return {
    ...DEFAULT_STREAM_DETAILS,
    id: overrides.id,
    serverId: overrides.serverId,
    serverUserId: overrides.serverUserId,
    sessionKey: `sk-${overrides.id}`,
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Cached Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2020,
    thumbPath: null,
    ratingKey: overrides.ratingKey ?? null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    mediaId: null,
    showMediaId: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    externalSessionId: null,
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7_200_000,
    progressMs: 60_000,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '10.0.0.1',
    geoCity: null,
    geoRegion: null,
    geoCountry: null,
    geoContinent: null,
    geoPostal: null,
    geoLat: null,
    geoLon: null,
    geoAsnNumber: null,
    geoAsnOrganization: null,
    playerName: 'Test Player',
    deviceId: 'dev-1',
    product: 'Test Web',
    device: 'Chrome',
    platform: 'Web',
    quality: null,
    isTranscode: false,
    videoDecision: null,
    audioDecision: null,
    bitrate: 1000,
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    user: {
      id: overrides.serverUserId,
      username: overrides.username,
      thumbUrl: null,
      identityName: null,
    },
    server: { id: overrides.serverId, name: overrides.serverName, type: overrides.serverType },
    canTerminate: true,
  };
}

interface HistoryRecord {
  id: string;
  server_id: string;
  server_type: string;
  media_id: string | null;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  rating_key: string | null;
  library_id: string | null;
  percent_complete: number | null;
  watched: boolean;
  duration_ms: number | null;
  segment_count: number;
  genres: string[] | null;
  user: { id: string; username: string | null };
}

describe('public API v2 /history and /streams', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    token = await seedOwnerToken();
  });

  afterEach(async () => {
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  it('returns one record per play with identity fields via imdb_id filter, excluding short sessions', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser({ role: 'member' });
    const suA = await createTestServerUser({ userId: user.id, serverId: serverA.id });
    const suB = await createTestServerUser({ userId: user.id, serverId: serverB.id });

    // Asymmetric provider ids: server A knows imdb+tmdb, server B only imdb
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt1375666',
      tmdbId: 27205,
      title: 'Inception',
      year: 2010,
      serverId: serverA.id,
      ratingKey: 'rk-a',
    });
    const mediaIdB = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt1375666',
      title: 'Inception',
      year: 2010,
      serverId: serverB.id,
      ratingKey: 'rk-b',
    });
    expect(mediaIdB).toBe(mediaId);

    await db
      .update(media)
      .set({ genres: ['Action', 'Sci-Fi'] })
      .where(eq(media.id, mediaId));
    await createTestLibraryItem({
      serverId: serverA.id,
      ratingKey: 'rk-a',
      libraryId: 'lib-42',
      mediaId,
      imdbId: 'tt1375666',
    });

    await createTestSession({
      serverId: serverA.id,
      serverUserId: suA.id,
      mediaId,
      imdbId: 'tt1375666',
      tmdbId: 27205,
      ratingKey: 'rk-a',
      state: 'stopped',
      durationMs: 6_000_000,
      totalDurationMs: 7_200_000,
      progressMs: 6_900_000,
      watched: true,
      startedAt: new Date('2026-07-10T20:00:00Z'),
      stoppedAt: new Date('2026-07-10T22:00:00Z'),
    });
    await createTestSession({
      serverId: serverB.id,
      serverUserId: suB.id,
      mediaId,
      imdbId: 'tt1375666',
      ratingKey: 'rk-b',
      state: 'stopped',
      durationMs: 6_500_000,
      totalDurationMs: 7_200_000,
      progressMs: 7_200_000,
      watched: true,
      startedAt: new Date('2026-07-11T20:00:00Z'),
      stoppedAt: new Date('2026-07-11T22:00:00Z'),
    });
    await createTestSession({
      serverId: serverA.id,
      serverUserId: suA.id,
      mediaId,
      imdbId: 'tt1375666',
      ratingKey: 'rk-a',
      durationMs: 60_000,
      shortSession: true,
      startedAt: new Date('2026-07-12T20:00:00Z'),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/history?imdb_id=tt1375666',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: HistoryRecord[]; meta: { nextCursor: string | null } }>();
    expect(body.data).toHaveLength(2);
    expect(body.meta.nextCursor).toBeNull();

    for (const record of body.data) {
      expect(record.media_id).toBe(mediaId);
      expect(record.imdb_id).toBe('tt1375666');
      expect(record.watched).toBe(true);
      expect(record.genres).toEqual(['Action', 'Sci-Fi']);
    }

    const recordB = body.data[0]!;
    expect(recordB.server_id).toBe(serverB.id);
    expect(recordB.server_type).toBe('jellyfin');
    expect(recordB.library_id).toBeNull();
    expect(recordB.percent_complete).toBe(100);

    const recordA = body.data[1]!;
    expect(recordA.server_id).toBe(serverA.id);
    expect(recordA.server_type).toBe('plex');
    expect(recordA.library_id).toBe('lib-42');
    expect(recordA.tmdb_id).toBe(27205);
    expect(recordA.rating_key).toBe('rk-a');
    expect(recordA.percent_complete).toBe(95.8);
  });

  it('filters by user_id at the identity level', async () => {
    const server = await createTestServer({ type: 'plex' });
    const userOne = await createTestUser({ role: 'member' });
    const userTwo = await createTestUser({ role: 'member' });
    const suOne = await createTestServerUser({ userId: userOne.id, serverId: server.id });
    const suTwo = await createTestServerUser({ userId: userTwo.id, serverId: server.id });

    await createTestSession({
      serverId: server.id,
      serverUserId: suOne.id,
      durationMs: 600_000,
      startedAt: new Date('2026-07-10T20:00:00Z'),
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: suTwo.id,
      durationMs: 600_000,
      startedAt: new Date('2026-07-11T20:00:00Z'),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/history?user_id=${userOne.id}`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: HistoryRecord[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.user.id).toBe(userOne.id);
  });

  it('expands media_id filter through merged aliases', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const winnerId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0111161',
      title: 'The Shawshank Redemption',
      year: 1994,
      serverId: server.id,
      ratingKey: 'rk-w',
    });
    const loserId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 278,
      title: 'Shawshank',
      year: 1996,
      serverId: server.id,
      ratingKey: 'rk-l',
    });
    expect(loserId).not.toBe(winnerId);
    await mergeMediaRows(winnerId, loserId);

    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaId: loserId,
      ratingKey: 'rk-l',
      durationMs: 600_000,
      startedAt: new Date('2026-07-10T20:00:00Z'),
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/history?media_id=${winnerId}`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: HistoryRecord[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.media_id).toBe(loserId);
  });

  it('cursor walks pages of 1 at chain grain without overlap or gaps', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    // Chain A starts 10:00 and continues 11:30, straddling chain B's 11:00 start
    const chainAStart = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Chain A',
      ratingKey: 'rk-chain',
      durationMs: 600_000,
      startedAt: new Date('2026-07-10T10:00:00Z'),
      stoppedAt: new Date('2026-07-10T10:10:00Z'),
      state: 'stopped',
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Chain A',
      ratingKey: 'rk-chain',
      referenceId: chainAStart.id,
      durationMs: 600_000,
      startedAt: new Date('2026-07-10T11:30:00Z'),
      stoppedAt: new Date('2026-07-10T11:40:00Z'),
      state: 'stopped',
    });
    const chainB = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Chain B',
      durationMs: 600_000,
      startedAt: new Date('2026-07-10T11:00:00Z'),
    });
    const chainC = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Chain C',
      durationMs: 600_000,
      startedAt: new Date('2026-07-10T12:00:00Z'),
    });

    const seen: HistoryRecord[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const url: string = `/api/v2/public/history?pageSize=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const res = await app.inject({ method: 'GET', url, headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: HistoryRecord[]; meta: { nextCursor: string | null } }>();
      if (body.data.length === 0) {
        expect(body.meta.nextCursor).toBeNull();
        break;
      }
      seen.push(...body.data);
      cursor = body.meta.nextCursor;
      if (!cursor) break;
    }

    expect(seen.map((r) => r.id)).toEqual([chainC.id, chainB.id, chainAStart.id]);
    const chainARecord = seen[2]!;
    expect(chainARecord.duration_ms).toBe(1_200_000);
    expect(chainARecord.segment_count).toBe(2);
  });

  it('page 2 matches the pre-windowing single-aggregate implementation (correctness parity)', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    // 25 distinct, unchained, qualifying plays spread one per hour - no
    // filters on the request, matching the unbounded default GET /history
    // shape the windowed implementation has to get right.
    for (let i = 0; i < 25; i++) {
      await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        mediaTitle: `Parity Play ${i}`,
        ratingKey: `rk-parity-${i}`,
        durationMs: 600_000,
        watched: true,
        state: 'stopped',
        startedAt: new Date(Date.UTC(2026, 6, 10, i, 0, 0)),
        stoppedAt: new Date(Date.UTC(2026, 6, 10, i, 10, 0)),
      });
    }

    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v2/public/history?pageSize=10',
      headers: authHeaders(),
    });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json<{ data: HistoryRecord[]; meta: { nextCursor: string | null } }>();
    expect(page1Body.meta.nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v2/public/history?pageSize=10&cursor=${encodeURIComponent(page1Body.meta.nextCursor!)}`,
      headers: authHeaders(),
    });
    expect(page2.statusCode).toBe(200);
    const page2Body = page2.json<{ data: HistoryRecord[]; meta: { nextCursor: string | null } }>();
    expect(page2Body.data).toHaveLength(10);

    // The pre-windowing implementation: one unbounded chains CTE aggregating
    // every session, no candidate-set restriction - exactly what runHistoryPage
    // replaced. Same cursor, same page size, same (absence of) filters.
    const cursorValue = decodeCursor(page1Body.meta.nextCursor!)!;
    const oldPage2 = await db.execute(sql`
      WITH chains AS (
        SELECT
          COALESCE(s.reference_id, s.id) as chain_id,
          MIN(s.started_at) as chain_started_at
        FROM sessions s
        GROUP BY COALESCE(s.reference_id, s.id)
        HAVING BOOL_OR(${countedSessionSql('s')})
      ),
      page AS (
        SELECT * FROM chains
        WHERE (chain_started_at, chain_id) < (${cursorValue.startedAt}::timestamptz, ${cursorValue.id}::uuid)
        ORDER BY chain_started_at DESC, chain_id DESC
        LIMIT 10
      )
      SELECT chain_id FROM page ORDER BY chain_started_at DESC, chain_id DESC
    `);
    const oldIds = (oldPage2.rows as { chain_id: string }[]).map((r) => r.chain_id);

    expect(page2Body.data.map((r) => r.id)).toEqual(oldIds);
  });

  it('a crowded resume chain does not push a fresher single-row chain out of page 1', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    // Chain's true start (chain_started_at) is old, but it's been resumed
    // recently many times - those recent rows crowd the raw scan window.
    const crowdedStart = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Crowded Chain',
      ratingKey: 'rk-crowd',
      durationMs: 600_000,
      startedAt: new Date('2026-07-01T00:00:00Z'),
      stoppedAt: new Date('2026-07-01T00:10:00Z'),
      state: 'stopped',
    });
    for (let day = 8; day <= 13; day++) {
      const dd = String(day).padStart(2, '0');
      await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        mediaTitle: 'Crowded Chain',
        ratingKey: 'rk-crowd',
        referenceId: crowdedStart.id,
        durationMs: 600_000,
        startedAt: new Date(`2026-07-${dd}T00:00:00Z`),
        stoppedAt: new Date(`2026-07-${dd}T00:10:00Z`),
        state: 'stopped',
      });
    }

    // Single play, newer chain_started_at than the crowded chain but older
    // than every one of its crowding rows - must still rank first.
    const freshSingle = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Fresh Single Play',
      ratingKey: 'rk-fresh',
      durationMs: 600_000,
      startedAt: new Date('2026-07-05T00:00:00Z'),
      stoppedAt: new Date('2026-07-05T00:10:00Z'),
      state: 'stopped',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/history?pageSize=1',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: HistoryRecord[]; meta: { nextCursor: string | null } }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(freshSingle.id);

    const unrestricted = await db.execute(sql`
      WITH chains AS (
        SELECT COALESCE(s.reference_id, s.id) as chain_id, MIN(s.started_at) as chain_started_at
        FROM sessions s
        GROUP BY COALESCE(s.reference_id, s.id)
        HAVING BOOL_OR(${countedSessionSql('s')})
      )
      SELECT chain_id FROM chains ORDER BY chain_started_at DESC, chain_id DESC LIMIT 1
    `);
    expect((unrestricted.rows[0] as { chain_id: string }).chain_id).toBe(freshSingle.id);
  });

  it('two crowded resume chains do not push out a third, fresher chain, and force a window growth', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const chainAStart = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Chain A',
      ratingKey: 'rk-a',
      durationMs: 600_000,
      startedAt: new Date('2026-06-01T00:00:00Z'),
      stoppedAt: new Date('2026-06-01T00:10:00Z'),
      state: 'stopped',
    });
    for (let day = 10; day <= 15; day++) {
      await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        mediaTitle: 'Chain A',
        ratingKey: 'rk-a',
        referenceId: chainAStart.id,
        durationMs: 600_000,
        startedAt: new Date(`2026-07-${day}T00:00:00Z`),
        stoppedAt: new Date(`2026-07-${day}T00:10:00Z`),
        state: 'stopped',
      });
    }

    const chainBStart = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Chain B',
      ratingKey: 'rk-b',
      durationMs: 600_000,
      startedAt: new Date('2026-06-05T00:00:00Z'),
      stoppedAt: new Date('2026-06-05T00:10:00Z'),
      state: 'stopped',
    });
    for (let day = 1; day <= 6; day++) {
      await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        mediaTitle: 'Chain B',
        ratingKey: 'rk-b',
        referenceId: chainBStart.id,
        durationMs: 600_000,
        startedAt: new Date(`2026-07-0${day}T12:00:00Z`),
        stoppedAt: new Date(`2026-07-0${day}T12:10:00Z`),
        state: 'stopped',
      });
    }

    // Single play, chain_started_at newer than both A and B, but its one row
    // is older than every crowding row from A and B combined.
    const chainC = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Chain C',
      ratingKey: 'rk-c',
      durationMs: 600_000,
      startedAt: new Date('2026-06-20T00:00:00Z'),
      stoppedAt: new Date('2026-06-20T00:10:00Z'),
      state: 'stopped',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/history?pageSize=2',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: HistoryRecord[]; meta: { nextCursor: string | null } }>();
    expect(body.data).toHaveLength(2);
    expect(body.data.map((r) => r.id)).toEqual([chainC.id, chainBStart.id]);

    const unrestricted = await db.execute(sql`
      WITH chains AS (
        SELECT COALESCE(s.reference_id, s.id) as chain_id, MIN(s.started_at) as chain_started_at
        FROM sessions s
        GROUP BY COALESCE(s.reference_id, s.id)
        HAVING BOOL_OR(${countedSessionSql('s')})
      )
      SELECT chain_id FROM chains ORDER BY chain_started_at DESC, chain_id DESC LIMIT 2
    `);
    const unrestrictedIds = (unrestricted.rows as { chain_id: string }[]).map((r) => r.chain_id);
    expect(body.data.map((r) => r.id)).toEqual(unrestrictedIds);
  });

  it('watched=true excludes unwatched plays', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const watchedSession = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      durationMs: 6_000_000,
      watched: true,
      startedAt: new Date('2026-07-10T20:00:00Z'),
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      durationMs: 600_000,
      watched: false,
      startedAt: new Date('2026-07-11T20:00:00Z'),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/history?watched=true',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: HistoryRecord[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(watchedSession.id);
    expect(body.data[0]!.watched).toBe(true);
  });

  it('includes a play under 2 minutes once it passed the watched threshold', async () => {
    const server = await createTestServer({ type: 'emby' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const intro = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaType: 'track',
      durationMs: 23_000,
      totalDurationMs: 23_000,
      progressMs: 22_500,
      watched: true,
      shortSession: true,
      state: 'stopped',
      startedAt: new Date('2026-07-10T20:00:00Z'),
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaType: 'track',
      durationMs: 40_000,
      totalDurationMs: 200_000,
      progressMs: 40_000,
      watched: false,
      shortSession: true,
      state: 'stopped',
      startedAt: new Date('2026-07-10T20:01:00Z'),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/history',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: HistoryRecord[] }>().data.map((r) => r.id)).toEqual([intro.id]);
  });

  it('rejects an invalid cursor with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/history?cursor=not-a-cursor',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing token with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/public/history' });
    expect(res.statusCode).toBe(401);
  });

  describe('/streams', () => {
    let cache: CacheService;

    beforeEach(() => {
      cache = createCacheService(getRedis());
    });

    afterEach(async () => {
      await cache.incrementalSyncActiveSessions([], await cache.getActiveSessionIds(), [], false);
    });

    it('carries the identity block per stream, enriched from session rows, with empty rating keys as null', async () => {
      const server = await createTestServer({ type: 'plex' });
      const user = await createTestUser({ role: 'member' });
      const su = await createTestServerUser({ userId: user.id, serverId: server.id });

      const mediaId = await resolveMediaForItem({
        mediaType: 'movie',
        imdbId: 'tt1375666',
        tmdbId: 27205,
        title: 'Inception',
        year: 2010,
        serverId: server.id,
        ratingKey: 'rk-s',
      });
      await db
        .update(media)
        .set({ genres: ['Action'] })
        .where(eq(media.id, mediaId));
      await createTestLibraryItem({
        serverId: server.id,
        ratingKey: 'rk-s',
        libraryId: 'lib-9',
        mediaId,
      });

      const withIdentity = await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        mediaId,
        imdbId: 'tt1375666',
        tmdbId: 27205,
        ratingKey: 'rk-s',
        state: 'playing',
        stoppedAt: null,
      });
      const withoutIdentity = await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        state: 'playing',
        stoppedAt: null,
      });
      // The poller stores '' for absent rating keys; the factory cannot
      await db.update(sessions).set({ ratingKey: '' }).where(eq(sessions.id, withoutIdentity.id));

      await cache.incrementalSyncActiveSessions(
        [
          fakeActiveSession({
            id: withIdentity.id,
            serverId: server.id,
            serverName: server.name,
            serverType: 'plex',
            serverUserId: su.id,
            username: su.username,
            ratingKey: 'rk-s',
          }),
          fakeActiveSession({
            id: withoutIdentity.id,
            serverId: server.id,
            serverName: server.name,
            serverType: 'plex',
            serverUserId: su.id,
            username: su.username,
            ratingKey: '',
          }),
        ],
        [],
        [],
        false
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v2/public/streams',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: {
          id: string;
          server_type: string;
          media_id: string | null;
          imdb_id: string | null;
          tmdb_id: number | null;
          rating_key: string | null;
          library_id: string | null;
          genres: string[] | null;
        }[];
        summary: { total: number; by_server: { server_id: string; total: number }[] };
      }>();

      expect(body.data).toHaveLength(2);
      expect(body.summary.total).toBe(2);
      expect(body.summary.by_server).toEqual([
        expect.objectContaining({ server_id: server.id, total: 2 }),
      ]);

      const enriched = body.data.find((s) => s.id === withIdentity.id)!;
      expect(enriched.media_id).toBe(mediaId);
      expect(enriched.imdb_id).toBe('tt1375666');
      expect(enriched.tmdb_id).toBe(27205);
      expect(enriched.rating_key).toBe('rk-s');
      expect(enriched.library_id).toBe('lib-9');
      expect(enriched.genres).toEqual(['Action']);
      expect(enriched.server_type).toBe('plex');

      const bare = body.data.find((s) => s.id === withoutIdentity.id)!;
      expect(bare.media_id).toBeNull();
      expect(bare.rating_key).toBeNull();
      expect(bare.library_id).toBeNull();
    });
  });
});

interface MediaAvailability {
  server_id: string;
  server_type: string;
  library_id: string;
  rating_key: string;
  added_at: string;
  removed_at: string | null;
  video_resolution: string | null;
  file_size: number | null;
}

interface MediaResource {
  id: string;
  media_type: string;
  title: string;
  year: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  genres: string[] | null;
  show_media_id: string | null;
  merged_ids: string[];
  availability: MediaAvailability[];
  season_count: number | null;
  episode_count: number | null;
}

interface MediaChild {
  id: string;
  media_type: string;
  title: string;
  season_number: number | null;
  episode_count: number | null;
  episode_number: number | null;
  tvdb_id: number | null;
}

describe('public API v2 /media', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    token = await seedOwnerToken();
  });

  afterEach(async () => {
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  it('resolves a shared movie to one canonical id with per-server availability including a tombstone', async () => {
    const s1 = await createTestServer({ type: 'plex' });
    const s2 = await createTestServer({ type: 'jellyfin' });
    const s3 = await createTestServer({ type: 'emby' });

    const idA = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 584,
      title: 'Shared Movie',
      year: 2001,
      serverId: s1.id,
      ratingKey: 'm1',
    });
    const idB = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 584,
      title: 'Shared Movie',
      year: 2001,
      serverId: s2.id,
      ratingKey: 'm2',
    });
    const idC = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 584,
      title: 'Shared Movie',
      year: 2001,
      serverId: s3.id,
      ratingKey: 'm3',
    });
    expect(idB).toBe(idA);
    expect(idC).toBe(idA);

    await createTestLibraryItem({
      serverId: s1.id,
      ratingKey: 'm1',
      libraryId: 'lib-1',
      mediaId: idA,
    });
    await createTestLibraryItem({
      serverId: s2.id,
      ratingKey: 'm2',
      libraryId: 'lib-2',
      mediaId: idA,
    });
    await createTestLibraryItem({
      serverId: s3.id,
      ratingKey: 'm3',
      libraryId: 'lib-3',
      mediaId: idA,
      removedAt: new Date('2026-07-01T00:00:00Z'),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/movie:tmdb:584',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<MediaResource>();
    expect(body.id).toBe(idA);
    expect(body.media_type).toBe('movie');
    expect(body.tmdb_id).toBe(584);
    expect(body.availability).toHaveLength(3);

    const present = body.availability.find((a) => a.server_id === s1.id)!;
    expect(present.removed_at).toBeNull();
    expect(present.server_type).toBe('plex');
    // Internal-only rollup fields must never reach the documented v2 shape.
    expect(present).not.toHaveProperty('episode_file_size');
    expect(present).not.toHaveProperty('episode_resolutions');
    expect(present).not.toHaveProperty('episode_count');

    const removed = body.availability.find((a) => a.server_id === s3.id)!;
    expect(removed.removed_at).not.toBeNull();
    expect(removed.server_type).toBe('emby');
  });

  it('resolves a merged loser uuid to the winner with the loser in merged_ids', async () => {
    const server = await createTestServer({ type: 'plex' });
    const winnerId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0111161',
      title: 'Winner',
      year: 1994,
      serverId: server.id,
      ratingKey: 'w',
    });
    const loserId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 278,
      title: 'Loser Copy',
      year: 1996,
      serverId: server.id,
      ratingKey: 'l',
    });
    expect(loserId).not.toBe(winnerId);
    await mergeMediaRows(winnerId, loserId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${loserId}`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<MediaResource>();
    expect(body.id).toBe(winnerId);
    expect(body.merged_ids).toContain(loserId);
  });

  it('reports hierarchy counts and lists show and season children', async () => {
    const server = await createTestServer({ type: 'plex' });
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 777,
      title: 'My Show',
      serverId: server.id,
      ratingKey: 'show',
    });
    const season1 = await resolveMediaForItem({
      mediaType: 'season',
      showMediaId: showId,
      seasonNumber: 1,
      serverId: server.id,
      ratingKey: 'se1',
    });
    const season2 = await resolveMediaForItem({
      mediaType: 'season',
      showMediaId: showId,
      seasonNumber: 2,
      serverId: server.id,
      ratingKey: 'se2',
    });
    const ep1 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 1,
      tvdbId: 1001,
      title: 'S1E1',
      serverId: server.id,
      ratingKey: 'ep1',
    });
    const ep2 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 2,
      tvdbId: 1002,
      title: 'S1E2',
      serverId: server.id,
      ratingKey: 'ep2',
    });
    const ep3 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 2,
      episodeNumber: 1,
      tvdbId: 2001,
      title: 'S2E1',
      serverId: server.id,
      ratingKey: 'ep3',
    });

    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'se1',
      mediaType: 'season',
      mediaId: season1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'se2',
      mediaType: 'season',
      mediaId: season2,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep1',
      mediaType: 'episode',
      mediaId: ep1,
      parentIndex: 1,
      itemIndex: 1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep2',
      mediaType: 'episode',
      mediaId: ep2,
      parentIndex: 1,
      itemIndex: 2,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep3',
      mediaType: 'episode',
      mediaId: ep3,
      parentIndex: 2,
      itemIndex: 1,
    });

    const showRes = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/show:tvdb:777',
      headers: authHeaders(),
    });
    expect(showRes.statusCode).toBe(200);
    const showBody = showRes.json<MediaResource>();
    expect(showBody.id).toBe(showId);
    expect(showBody.season_count).toBe(2);
    expect(showBody.episode_count).toBe(3);

    const childRes = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/show:tvdb:777/children',
      headers: authHeaders(),
    });
    expect(childRes.statusCode).toBe(200);
    const childBody = childRes.json<{ data: MediaChild[] }>();
    expect(childBody.data).toHaveLength(2);
    expect(childBody.data.map((c) => c.season_number)).toEqual([1, 2]);
    const s1c = childBody.data.find((c) => c.season_number === 1)!;
    expect(s1c.id).toBe(season1);
    expect(s1c.episode_count).toBe(2);
    const s2c = childBody.data.find((c) => c.season_number === 2)!;
    expect(s2c.id).toBe(season2);
    expect(s2c.episode_count).toBe(1);

    const seasonRes = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${season1}/children`,
      headers: authHeaders(),
    });
    expect(seasonRes.statusCode).toBe(200);
    const seasonBody = seasonRes.json<{ data: MediaChild[] }>();
    expect(seasonBody.data).toHaveLength(2);
    expect(seasonBody.data.map((c) => c.id)).toEqual([ep1, ep2]);
    expect(seasonBody.data.map((c) => c.episode_number)).toEqual([1, 2]);
    expect(seasonBody.data[0]!.tvdb_id).toBe(1001);
  });

  it('returns 404 for an unknown ref and for children of a movie', async () => {
    const server = await createTestServer({ type: 'plex' });
    await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 999,
      title: 'Solo',
      year: 2002,
      serverId: server.id,
      ratingKey: 'mv',
    });

    const unknownProvider = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/movie:tmdb:88888888',
      headers: authHeaders(),
    });
    expect(unknownProvider.statusCode).toBe(404);

    const unknownUuid = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${randomUUID()}`,
      headers: authHeaders(),
    });
    expect(unknownUuid.statusCode).toBe(404);

    const movieChildren = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/movie:tmdb:999/children',
      headers: authHeaders(),
    });
    expect(movieChildren.statusCode).toBe(404);
  });
});

interface StatMeasures {
  plays: number;
  watch_time_ms: number;
  unique_users: number;
}

interface StatWindow {
  combined: StatMeasures;
  per_server: (StatMeasures & { server_id: string; server_name: string | null })[];
}

interface MediaStats {
  media_id: string;
  media_type: string;
  windows: { all_time: StatWindow; last_30: StatWindow; last_7: StatWindow };
}

interface WatcherEntry {
  user: {
    server_user_id: string;
    user_id: string;
    username: string | null;
    identity_name: string | null;
  };
  plays: number;
  watch_time_ms: number;
  completion_pct: number | null;
  last_watched_day: string | null;
  distinct_episodes_watched: number | null;
}

interface MediaWatchers {
  media_id: string;
  media_type: string;
  window: string;
  watchers: WatcherEntry[];
}

async function refreshUserMediaPlays(): Promise<void> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
}

describe('public API v2 /media/{ref}/stats, /watchers, /history', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    token = await seedOwnerToken();
  });

  afterEach(async () => {
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  it('rolls a movie watched on three servers into combined and per-server stats', async () => {
    const s1 = await createTestServer({ type: 'plex' });
    const s2 = await createTestServer({ type: 'jellyfin' });
    const s3 = await createTestServer({ type: 'emby' });
    const user = await createTestUser({ role: 'member' });
    const su1 = await createTestServerUser({ userId: user.id, serverId: s1.id });
    const su2 = await createTestServerUser({ userId: user.id, serverId: s2.id });
    const su3 = await createTestServerUser({ userId: user.id, serverId: s3.id });

    let mediaId = '';
    let i = 0;
    for (const [server, su] of [
      [s1, su1],
      [s2, su2],
      [s3, su3],
    ] as const) {
      mediaId = await resolveMediaForItem({
        mediaType: 'movie',
        tmdbId: 584,
        title: 'Triple Feature',
        year: 2001,
        serverId: server.id,
        ratingKey: `rk-${i}`,
      });
      await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        mediaId,
        tmdbId: 584,
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
        progressMs: 7_000_000,
        watched: true,
        state: 'stopped',
      });
      i++;
    }

    await refreshUserMediaPlays();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/movie:tmdb:584/stats',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<MediaStats>();
    expect(body.media_id).toBe(mediaId);
    expect(body.media_type).toBe('movie');

    const all = body.windows.all_time;
    expect(all.combined.plays).toBe(3);
    expect(all.combined.unique_users).toBe(1);
    expect(all.per_server).toHaveLength(3);
    for (const entry of all.per_server) {
      expect(entry.plays).toBe(1);
      expect(entry.unique_users).toBe(1);
    }
    const server1Entry = all.per_server.find((e) => e.server_id === s1.id)!;
    expect(server1Entry.server_name).toBe(s1.name);
  });

  it('excludes a viewer whose only session is under the play threshold from unique_users', async () => {
    const server = await createTestServer({ type: 'plex' });
    const watcher = await createTestUser({ role: 'member' });
    const suWatcher = await createTestServerUser({ userId: watcher.id, serverId: server.id });
    const ghost = await createTestUser({ role: 'member' });
    const suGhost = await createTestServerUser({ userId: ghost.id, serverId: server.id });

    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 585,
      title: 'Threshold Feature',
      year: 2002,
      serverId: server.id,
      ratingKey: 'rk-threshold',
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: suWatcher.id,
      mediaId,
      tmdbId: 585,
      durationMs: 6_000_000,
      totalDurationMs: 7_200_000,
      progressMs: 7_000_000,
      watched: true,
      state: 'stopped',
    });
    // Below the 2-minute play threshold: never counted as a play, and must
    // not count this viewer toward unique_users either.
    await createTestSession({
      serverId: server.id,
      serverUserId: suGhost.id,
      mediaId,
      tmdbId: 585,
      durationMs: 60_000,
      shortSession: true,
      watched: false,
      state: 'stopped',
    });

    await refreshUserMediaPlays();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/movie:tmdb:585/stats',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<MediaStats>();
    const all = body.windows.all_time;
    expect(all.combined.plays).toBe(1);
    expect(all.combined.unique_users).toBe(1);
    expect(all.per_server[0]!.unique_users).toBe(1);
  });

  it('rolls a show up by episode and scopes stats and watchers to a season', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 4242,
      title: 'Binge Show',
      serverId: server.id,
      ratingKey: 'show-r',
    });
    const season1 = await resolveMediaForItem({
      mediaType: 'season',
      showMediaId: showId,
      seasonNumber: 1,
      serverId: server.id,
      ratingKey: 'se1-r',
    });
    const ep1 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 1,
      tvdbId: 5001,
      title: 'S1E1',
      serverId: server.id,
      ratingKey: 'ep1-r',
    });
    const ep2 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 2,
      tvdbId: 5002,
      title: 'S1E2',
      serverId: server.id,
      ratingKey: 'ep2-r',
    });

    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'se1-r',
      mediaType: 'season',
      mediaId: season1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep1-r',
      mediaType: 'episode',
      mediaId: ep1,
      parentIndex: 1,
      itemIndex: 1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep2-r',
      mediaType: 'episode',
      mediaId: ep2,
      parentIndex: 1,
      itemIndex: 2,
    });

    for (const epId of [ep1, ep2]) {
      await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        mediaType: 'episode',
        mediaId: epId,
        showMediaId: showId,
        seasonNumber: 1,
        durationMs: 6_000_000,
        totalDurationMs: 1_500_000,
        progressMs: 1_500_000,
        watched: true,
        state: 'stopped',
      });
    }

    await refreshUserMediaPlays();

    const showWatchers = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${showId}/watchers`,
      headers: authHeaders(),
    });
    expect(showWatchers.statusCode).toBe(200);
    const showWatchersBody = showWatchers.json<MediaWatchers>();
    expect(showWatchersBody.watchers).toHaveLength(1);
    const showWatcher = showWatchersBody.watchers[0]!;
    expect(showWatcher.user.server_user_id).toBe(su.id);
    expect(showWatcher.user.user_id).toBe(user.id);
    expect(showWatcher.distinct_episodes_watched).toBe(2);
    expect(showWatcher.plays).toBe(2);
    // Internal-only watcher fields must never reach the documented v2 shape.
    expect(showWatcher.user).not.toHaveProperty('server_id');
    expect(showWatcher.user).not.toHaveProperty('thumb');

    const childRes = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/show:tvdb:4242/children',
      headers: authHeaders(),
    });
    expect(childRes.statusCode).toBe(200);
    const seasonUuid = childRes
      .json<{ data: { id: string; season_number: number }[] }>()
      .data.find((c) => c.season_number === 1)!.id;
    expect(seasonUuid).toBe(season1);

    const seasonStats = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${seasonUuid}/stats`,
      headers: authHeaders(),
    });
    expect(seasonStats.statusCode).toBe(200);
    const seasonStatsBody = seasonStats.json<MediaStats>();
    expect(seasonStatsBody.media_type).toBe('season');
    expect(seasonStatsBody.windows.all_time.combined.plays).toBe(2);
    expect(seasonStatsBody.windows.all_time.combined.unique_users).toBe(1);

    const seasonWatchers = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${seasonUuid}/watchers`,
      headers: authHeaders(),
    });
    expect(seasonWatchers.statusCode).toBe(200);
    const seasonWatchersBody = seasonWatchers.json<MediaWatchers>();
    expect(seasonWatchersBody.watchers).toHaveLength(1);
    expect(seasonWatchersBody.watchers[0]!.distinct_episodes_watched).toBe(2);
    expect(seasonWatchersBody.watchers[0]!.plays).toBe(2);
  });

  it('excludes a viewer whose only episode session is under the play threshold from season unique_users', async () => {
    const server = await createTestServer({ type: 'plex' });
    const watcher = await createTestUser({ role: 'member' });
    const suWatcher = await createTestServerUser({ userId: watcher.id, serverId: server.id });
    const ghost = await createTestUser({ role: 'member' });
    const suGhost = await createTestServerUser({ userId: ghost.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 4243,
      title: 'Threshold Show',
      serverId: server.id,
      ratingKey: 'show-threshold-r',
    });
    const season1 = await resolveMediaForItem({
      mediaType: 'season',
      showMediaId: showId,
      seasonNumber: 1,
      serverId: server.id,
      ratingKey: 'se1-threshold-r',
    });
    const ep1 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 1,
      tvdbId: 5101,
      title: 'S1E1',
      serverId: server.id,
      ratingKey: 'ep1-threshold-r',
    });

    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'se1-threshold-r',
      mediaType: 'season',
      mediaId: season1,
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep1-threshold-r',
      mediaType: 'episode',
      mediaId: ep1,
      parentIndex: 1,
      itemIndex: 1,
    });

    await createTestSession({
      serverId: server.id,
      serverUserId: suWatcher.id,
      mediaType: 'episode',
      mediaId: ep1,
      showMediaId: showId,
      seasonNumber: 1,
      durationMs: 6_000_000,
      totalDurationMs: 1_500_000,
      progressMs: 1_500_000,
      watched: true,
      state: 'stopped',
    });
    // Below the 2-minute play threshold: never counted as a play, and must
    // not count this viewer toward unique_users either.
    await createTestSession({
      serverId: server.id,
      serverUserId: suGhost.id,
      mediaType: 'episode',
      mediaId: ep1,
      showMediaId: showId,
      seasonNumber: 1,
      durationMs: 60_000,
      shortSession: true,
      watched: false,
      state: 'stopped',
    });

    await refreshUserMediaPlays();

    const childRes = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/show:tvdb:4243/children',
      headers: authHeaders(),
    });
    expect(childRes.statusCode).toBe(200);
    const seasonUuid = childRes
      .json<{ data: { id: string; season_number: number }[] }>()
      .data.find((c) => c.season_number === 1)!.id;

    const seasonStats = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${seasonUuid}/stats`,
      headers: authHeaders(),
    });
    expect(seasonStats.statusCode).toBe(200);
    const seasonStatsBody = seasonStats.json<MediaStats>();
    expect(seasonStatsBody.windows.all_time.combined.plays).toBe(1);
    expect(seasonStatsBody.windows.all_time.combined.unique_users).toBe(1);
  });

  it('returns identical stats for the winner and loser of a merged media pair', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const winnerId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0111161',
      title: 'Winner Cut',
      year: 1994,
      serverId: server.id,
      ratingKey: 'w-r',
    });
    const loserId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 278,
      title: 'Loser Cut',
      year: 1996,
      serverId: server.id,
      ratingKey: 'l-r',
    });
    expect(loserId).not.toBe(winnerId);
    await mergeMediaRows(winnerId, loserId);

    for (const stampedId of [loserId, winnerId]) {
      await createTestSession({
        serverId: server.id,
        serverUserId: su.id,
        mediaId: stampedId,
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
        progressMs: 7_000_000,
        watched: true,
        state: 'stopped',
      });
    }

    await refreshUserMediaPlays();

    const viaWinner = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${winnerId}/stats`,
      headers: authHeaders(),
    });
    const viaLoser = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${loserId}/stats`,
      headers: authHeaders(),
    });

    expect(viaWinner.statusCode).toBe(200);
    expect(viaLoser.statusCode).toBe(200);
    const winnerBody = viaWinner.json<MediaStats>();
    const loserBody = viaLoser.json<MediaStats>();
    expect(winnerBody.media_id).toBe(winnerId);
    expect(winnerBody.windows.all_time.combined.plays).toBe(2);
    expect(loserBody).toEqual(winnerBody);
  });

  it('paginates per-item history at chain grain scoped to the media set', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const targetId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 6001,
      title: 'Scoped Movie',
      year: 2010,
      serverId: server.id,
      ratingKey: 'sc-r',
    });
    const otherId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 6002,
      title: 'Other Movie',
      year: 2011,
      serverId: server.id,
      ratingKey: 'ot-r',
    });

    const target = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaId: targetId,
      ratingKey: 'sc-r',
      durationMs: 6_000_000,
      startedAt: new Date('2026-07-10T20:00:00Z'),
      state: 'stopped',
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaId: otherId,
      ratingKey: 'ot-r',
      durationMs: 6_000_000,
      startedAt: new Date('2026-07-11T20:00:00Z'),
      state: 'stopped',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${targetId}/history`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: HistoryRecord[]; meta: { nextCursor: string | null } }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(target.id);
    expect(body.data[0]!.media_id).toBe(targetId);
  });
});

interface UserAccount {
  server_id: string;
  server_type: string;
  server_user_id: string;
  external_user_id: string;
  username: string;
  removed_at: string | null;
}

interface UserIdentity {
  id: string;
  username: string;
  email: string | null;
  plex_account_id: string | null;
  accounts: UserAccount[];
}

interface UserStats {
  user_id: string;
  windows: {
    all_time: { plays: number; watch_time_ms: number };
    last_30: { plays: number; watch_time_ms: number };
    last_7: { plays: number; watch_time_ms: number };
  };
  top_genres: { genre: string; plays: number }[];
}

describe('public API v2 /users', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    token = await seedOwnerToken();
  });

  afterEach(async () => {
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  it('collapses an identity with accounts on two servers into one entry carrying external ids', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser({
      role: 'member',
      email: 'shared@example.com',
      plexAccountId: 'plex-acct-777',
    });
    await createTestServerUser({
      userId: user.id,
      serverId: serverA.id,
      externalId: 'ext-plex-1',
      username: 'alice_plex',
    });
    await createTestServerUser({
      userId: user.id,
      serverId: serverB.id,
      externalId: 'ext-jf-guid',
      username: 'alice_jf',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/users',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: UserIdentity[]; meta: { nextCursor: string | null } }>();
    expect(body.data).toHaveLength(1);

    const identity = body.data[0]!;
    expect(identity.id).toBe(user.id);
    expect(identity.email).toBe('shared@example.com');
    expect(identity.plex_account_id).toBe('plex-acct-777');
    expect(identity.accounts).toHaveLength(2);

    const byExternal = new Map(identity.accounts.map((a) => [a.external_user_id, a]));
    expect(byExternal.get('ext-plex-1')!.server_type).toBe('plex');
    expect(byExternal.get('ext-plex-1')!.server_id).toBe(serverA.id);
    expect(byExternal.get('ext-jf-guid')!.server_type).toBe('jellyfin');
    expect(byExternal.get('ext-jf-guid')!.server_id).toBe(serverB.id);
  });

  it('sums stats across an identity accounts and surfaces top genres', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const user = await createTestUser({ role: 'member' });
    const suA = await createTestServerUser({ userId: user.id, serverId: serverA.id });
    const suB = await createTestServerUser({ userId: user.id, serverId: serverB.id });

    const mediaA = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 8801,
      title: 'A Feature',
      year: 2015,
      serverId: serverA.id,
      ratingKey: 'ua-1',
    });
    const mediaB = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 8802,
      title: 'B Feature',
      year: 2016,
      serverId: serverB.id,
      ratingKey: 'ub-1',
    });
    await db
      .update(media)
      .set({ genres: ['Drama', 'Thriller'] })
      .where(eq(media.id, mediaA));

    await createTestSession({
      serverId: serverA.id,
      serverUserId: suA.id,
      mediaId: mediaA,
      durationMs: 6_000_000,
      watched: true,
      state: 'stopped',
    });
    await createTestSession({
      serverId: serverA.id,
      serverUserId: suA.id,
      mediaId: mediaA,
      durationMs: 6_000_000,
      watched: true,
      state: 'stopped',
    });
    await createTestSession({
      serverId: serverB.id,
      serverUserId: suB.id,
      mediaId: mediaB,
      durationMs: 6_000_000,
      watched: true,
      state: 'stopped',
    });

    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/users/${user.id}/stats`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<UserStats>();
    expect(body.user_id).toBe(user.id);
    expect(body.windows.all_time.plays).toBe(3);
    expect(body.windows.all_time.watch_time_ms).toBe(18_000_000);

    const drama = body.top_genres.find((g) => g.genre === 'Drama')!;
    expect(drama).toBeDefined();
    expect(drama.plays).toBe(2);
  });

  it('returns 404 for an unknown identity id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/users/${randomUUID()}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });
});

interface RecentlyAddedRecord {
  id: string;
  server_id: string;
  server_type: string;
  library_id: string;
  media_type: string;
  title: string;
  year: number | null;
  added_at: string;
  removed_at: string | null;
  media_id: string | null;
  imdb_id: string | null;
  rating_key: string | null;
}

interface LibraryRollup {
  server_id: string;
  server_type: string;
  library_id: string;
  item_count: number;
  movie_count: number;
  episode_count: number;
  show_count: number;
  track_count: number;
  total_file_size: number;
  resolutions: Record<string, number>;
}

describe('public API v2 /recently-added', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    token = await seedOwnerToken();
  });

  afterEach(async () => {
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  it('cursor-walks pages of 1 through a bulk-sync tie group without skips or duplicates', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    // Three items on serverA stamped with one identical added date (the bulk sync)
    const tied = new Date('2026-07-10T10:00:00Z');
    const tiedIds: string[] = [];
    for (const rk of ['tie-1', 'tie-2', 'tie-3']) {
      const item = await createTestLibraryItem({ serverId: serverA.id, ratingKey: rk });
      await db.update(libraryItems).set({ createdAt: tied }).where(eq(libraryItems.id, item.id));
      tiedIds.push(item.id);
    }

    // A newer item on serverB, and a removed item on serverA newer still
    const newer = await createTestLibraryItem({ serverId: serverB.id, ratingKey: 'newer' });
    await db
      .update(libraryItems)
      .set({ createdAt: new Date('2026-07-11T10:00:00Z') })
      .where(eq(libraryItems.id, newer.id));
    const removed = await createTestLibraryItem({
      serverId: serverA.id,
      ratingKey: 'gone',
      removedAt: new Date('2026-07-13T00:00:00Z'),
    });
    await db
      .update(libraryItems)
      .set({ createdAt: new Date('2026-07-12T10:00:00Z') })
      .where(eq(libraryItems.id, removed.id));

    const tiedDesc = [...tiedIds].sort((a, b) => (a < b ? 1 : -1));
    const expected = [newer.id, ...tiedDesc];

    const seen: RecentlyAddedRecord[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const url: string = `/api/v2/public/recently-added?pageSize=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`;
      const res = await app.inject({ method: 'GET', url, headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: RecentlyAddedRecord[]; meta: { nextCursor: string | null } }>();
      if (body.data.length === 0) {
        expect(body.meta.nextCursor).toBeNull();
        break;
      }
      seen.push(...body.data);
      cursor = body.meta.nextCursor;
      if (!cursor) break;
    }

    expect(seen.map((r) => r.id)).toEqual(expected);
    expect(new Set(seen.map((r) => r.id)).size).toBe(expected.length);
    expect(seen.every((r) => r.removed_at === null)).toBe(true);
  });

  it('hides a soft-deleted item unless include_removed is set, and honors filters', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const present = await createTestLibraryItem({
      serverId: serverA.id,
      libraryId: 'lib-a',
      ratingKey: 'p',
      mediaType: 'movie',
    });
    const removed = await createTestLibraryItem({
      serverId: serverA.id,
      libraryId: 'lib-a',
      ratingKey: 'r',
      mediaType: 'movie',
      removedAt: new Date('2026-07-01T00:00:00Z'),
    });
    await createTestLibraryItem({
      serverId: serverB.id,
      libraryId: 'lib-b',
      ratingKey: 'other',
      mediaType: 'episode',
    });

    const def = await app.inject({
      method: 'GET',
      url: '/api/v2/public/recently-added',
      headers: authHeaders(),
    });
    expect(def.statusCode).toBe(200);
    const defBody = def.json<{ data: RecentlyAddedRecord[] }>();
    const defIds = defBody.data.map((r) => r.id);
    expect(defIds).toContain(present.id);
    expect(defIds).not.toContain(removed.id);

    const withRemoved = await app.inject({
      method: 'GET',
      url: '/api/v2/public/recently-added?include_removed=true',
      headers: authHeaders(),
    });
    const withRemovedIds = withRemoved
      .json<{ data: RecentlyAddedRecord[] }>()
      .data.map((r) => r.id);
    expect(withRemovedIds).toContain(removed.id);

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v2/public/recently-added?server_id=${serverA.id}&library_id=lib-a&media_type=movie`,
      headers: authHeaders(),
    });
    const filteredBody = filtered.json<{ data: RecentlyAddedRecord[] }>();
    expect(filteredBody.data.map((r) => r.id)).toEqual([present.id]);
    expect(filteredBody.data[0]!.server_type).toBe('plex');
  });

  it('rejects an invalid cursor with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/recently-added?cursor=not-a-cursor',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('public API v2 /libraries', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    token = await seedOwnerToken();
    // Shared Redis persists across tests; drop the cached rollup so each run recomputes
    createCacheService(getRedis());
    await getRedis().del(REDIS_KEYS.PUBLIC_MEDIA_STATS('libraries'));
  });

  afterEach(async () => {
    await getRedis().del(REDIS_KEYS.PUBLIC_MEDIA_STATS('libraries'));
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  it('sums sizes and counts per library, excluding tombstones', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const setItem = async (id: string, fileSize: number | null, videoResolution: string | null) => {
      await db
        .update(libraryItems)
        .set({ fileSize, videoResolution })
        .where(eq(libraryItems.id, id));
    };

    const m1 = await createTestLibraryItem({
      serverId: serverA.id,
      libraryId: 'lib-a',
      ratingKey: 'm1',
      mediaType: 'movie',
    });
    await setItem(m1.id, 1000, '4k');
    const m2 = await createTestLibraryItem({
      serverId: serverA.id,
      libraryId: 'lib-a',
      ratingKey: 'm2',
      mediaType: 'movie',
    });
    await setItem(m2.id, 2000, '1080p');
    const tomb = await createTestLibraryItem({
      serverId: serverA.id,
      libraryId: 'lib-a',
      ratingKey: 'm3',
      mediaType: 'movie',
      removedAt: new Date('2026-07-01T00:00:00Z'),
    });
    await setItem(tomb.id, 9999, '4k');

    const ep = await createTestLibraryItem({
      serverId: serverB.id,
      libraryId: 'lib-b',
      ratingKey: 'e1',
      mediaType: 'episode',
    });
    await setItem(ep.id, 500, '720p');
    const trk = await createTestLibraryItem({
      serverId: serverB.id,
      libraryId: 'lib-b',
      ratingKey: 't1',
      mediaType: 'track',
    });
    await setItem(trk.id, 50, null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/libraries',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: LibraryRollup[] }>();

    const libA = body.data.find((r) => r.server_id === serverA.id && r.library_id === 'lib-a')!;
    expect(libA.server_type).toBe('plex');
    expect(libA.item_count).toBe(2);
    expect(libA.movie_count).toBe(2);
    expect(libA.total_file_size).toBe(3000);
    expect(libA.resolutions).toEqual({ '4k': 1, '1080p': 1 });

    const libB = body.data.find((r) => r.server_id === serverB.id && r.library_id === 'lib-b')!;
    expect(libB.item_count).toBe(2);
    expect(libB.episode_count).toBe(1);
    expect(libB.track_count).toBe(1);
    expect(libB.total_file_size).toBe(550);
    expect(libB.resolutions).toEqual({ '720p': 1, unknown: 1 });
  });

  it('rejects a missing token with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v2/public/libraries' });
    expect(res.statusCode).toBe(401);
  });
});

describe('public API v2 max-review regressions', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    token = await seedOwnerToken();
  });

  afterEach(async () => {
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  it('/users cursor does not skip identities sharing a microsecond created_at', async () => {
    const server = await createTestServer({ type: 'plex' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const person = await createTestUser({ role: 'member' });
      await createTestServerUser({ userId: person.id, serverId: server.id });
      ids.push(person.id);
    }
    // Bulk-created identities share one transaction timestamp with microseconds
    await db.execute(sql`
      UPDATE users SET created_at = '2026-01-05 12:00:00.123456+00'::timestamptz
      WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})
    `);

    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v2/public/users?pageSize=2',
      headers: authHeaders(),
    });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json<{ data: { id: string }[]; meta: { nextCursor: string | null } }>();
    expect(body1.data).toHaveLength(2);
    expect(body1.meta.nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v2/public/users?pageSize=2&cursor=${encodeURIComponent(body1.meta.nextCursor!)}`,
      headers: authHeaders(),
    });
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json<{ data: { id: string }[] }>();

    const seen = new Set([...body1.data, ...body2.data].map((u) => u.id));
    expect(seen.size).toBe(3);
    for (const id of ids) expect(seen.has(id)).toBe(true);
  });

  it('/history reports percent_complete null when progress or duration is unknown', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const session = await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaType: 'live',
      mediaTitle: 'Live Channel',
      state: 'stopped',
      durationMs: 600_000,
    });
    await db.execute(
      sql`UPDATE sessions SET total_duration_ms = NULL, progress_ms = NULL WHERE id = ${session.id}`
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v2/public/history',
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const record = res
      .json<{ data: { media_title: string; percent_complete: number | null }[] }>()
      .data.find((r) => r.media_title === 'Live Channel');
    expect(record).toBeDefined();
    expect(record!.percent_complete).toBeNull();
  });

  it('/history?media_id= with a merged-loser id returns the canonical history', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const winnerId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt7777770',
      title: 'Canonical Cut',
      year: 2001,
      serverId: server.id,
      ratingKey: 'canon-1',
    });
    const loserId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 777001,
      title: 'Duplicate Cut',
      year: 2001,
      serverId: server.id,
      ratingKey: 'dup-1',
    });
    expect(loserId).not.toBe(winnerId);
    await mergeMediaRows(winnerId, loserId);

    // Post-merge play stamped with the canonical id only
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaId: winnerId,
      mediaTitle: 'Canonical Cut',
      state: 'stopped',
      durationMs: 1_800_000,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/history?media_id=${loserId}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const records = res.json<{ data: { media_id: string | null }[] }>().data;
    expect(records).toHaveLength(1);
    expect(records[0]!.media_id).toBe(winnerId);
  });

  it('/history?media_id=<show id> returns the episode plays under that show', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 888_001,
      title: 'Scoped Show',
      year: 2019,
      serverId: server.id,
      ratingKey: 'scoped-show',
    });
    const otherShowId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 888_002,
      title: 'Other Show',
      year: 2020,
      serverId: server.id,
      ratingKey: 'other-show',
    });
    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 888_011,
      title: 'Scoped Episode',
      year: 2019,
      serverId: server.id,
      ratingKey: 'scoped-ep-1',
      showMediaId: showId,
    });
    const otherEpisodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 888_021,
      title: 'Other Episode',
      year: 2020,
      serverId: server.id,
      ratingKey: 'other-ep-1',
      showMediaId: otherShowId,
    });

    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaType: 'episode',
      mediaId: episodeId,
      showMediaId: showId,
      ratingKey: 'scoped-ep-1',
      durationMs: 1_800_000,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaType: 'episode',
      mediaId: otherEpisodeId,
      showMediaId: otherShowId,
      ratingKey: 'other-ep-1',
      durationMs: 1_800_000,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/history?media_id=${showId}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const records = res.json<{ data: HistoryRecord[] }>().data;
    expect(records).toHaveLength(1);
    expect(records[0]!.media_id).toBe(episodeId);
    expect(records[0]!.show_media_id).toBe(showId);
  });

  it('/history?media_id= for an id with no matching media returns an empty page, not every session', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaTitle: 'Unrelated Session',
      durationMs: 600_000,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/history?media_id=${randomUUID()}`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: HistoryRecord[] }>().data).toHaveLength(0);
  });

  it('/media/{show}/watchers gates episode counts on qualifying plays and returns plain UTC dates', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 606060,
      title: 'Gated Show',
      serverId: server.id,
      ratingKey: 'gated-show',
    });
    const ep1 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 1,
      tvdbId: 606061,
      title: 'Gated S1E1',
      serverId: server.id,
      ratingKey: 'gated-e1',
    });
    const ep2 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 2,
      tvdbId: 606062,
      title: 'Gated S1E2',
      serverId: server.id,
      ratingKey: 'gated-e2',
    });

    // One full watch, one 60-second browse: the browse materializes a
    // plays=0 rollup row and must not count as a watched episode.
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaType: 'episode',
      mediaId: ep1,
      showMediaId: showId,
      seasonNumber: 1,
      durationMs: 1_500_000,
      totalDurationMs: 1_500_000,
      progressMs: 1_500_000,
      watched: true,
      state: 'stopped',
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: su.id,
      mediaType: 'episode',
      mediaId: ep2,
      showMediaId: showId,
      seasonNumber: 1,
      durationMs: 60_000,
      totalDurationMs: 1_500_000,
      progressMs: 60_000,
      state: 'stopped',
    });

    await refreshUserMediaPlays();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${showId}/watchers`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<MediaWatchers>();
    expect(body.watchers).toHaveLength(1);
    const watcher = body.watchers[0]!;
    expect(watcher.plays).toBe(1);
    expect(watcher.distinct_episodes_watched).toBe(1);
    expect(watcher.last_watched_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('/media/{show}/children lists each season once after a show merge', async () => {
    const server = await createTestServer({ type: 'plex' });

    const winnerShow = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 909091,
      title: 'Merged Show',
      serverId: server.id,
      ratingKey: 'ms-w',
    });
    const loserShow = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 909092,
      title: 'Merged Show Copy',
      serverId: server.id,
      ratingKey: 'ms-l',
    });
    const winnerSeason = await resolveMediaForItem({
      mediaType: 'season',
      showMediaId: winnerShow,
      seasonNumber: 1,
      serverId: server.id,
      ratingKey: 'ms-w-s1',
    });
    const loserSeason = await resolveMediaForItem({
      mediaType: 'season',
      showMediaId: loserShow,
      seasonNumber: 1,
      serverId: server.id,
      ratingKey: 'ms-l-s1',
    });
    expect(loserSeason).not.toBe(winnerSeason);

    await mergeMediaRows(winnerShow, loserShow);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${winnerShow}/children`,
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const seasons = res
      .json<{ data: { id: string; season_number: number | null }[] }>()
      .data.filter((c) => c.season_number === 1);
    expect(seasons).toHaveLength(1);
    expect(seasons[0]!.id).toBe(winnerSeason);
  });
});
