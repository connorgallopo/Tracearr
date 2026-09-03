/**
 * Public API v2 end-to-end acceptance proof
 *
 * One identity with an account on three media servers watches a shared movie on
 * all three (asymmetric provider ids) plus a two-season show on one, including a
 * resume chain and a short session. The full v2 surface is then exercised in one
 * pass: combined vs per-server media stats, show and season watchers, the season
 * discovery path a series-automation consumer walks, identity-summed user stats,
 * a complete history cursor walk, and recently-added / libraries consistency.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- publicV2EndToEnd
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import sensible from '@fastify/sensible';
import { eq, sql } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { users, media } from '../../src/db/schema.js';
import authPlugin from '../../src/plugins/auth.js';
import { publicV2Routes } from '../../src/routes/publicV2/index.js';
import { getRedis } from '../../src/lib/redisShared.js';
import { createCacheService } from '../../src/services/cache.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { mergeUsers } from '../../src/services/mergeService.js';

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

async function refreshUserMediaPlays(): Promise<void> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
}

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
  user: { server_user_id: string; user_id: string; identity_name: string | null };
  plays: number;
  distinct_episodes_watched: number | null;
}

interface MediaWatchers {
  media_id: string;
  media_type: string;
  watchers: WatcherEntry[];
}

interface HistoryRecord {
  id: string;
  media_id: string | null;
  show_media_id: string | null;
  tmdb_id: number | null;
  segment_count: number;
  user: { id: string };
}

interface SeasonChild {
  id: string;
  season_number: number | null;
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

interface RecentlyAddedRecord {
  id: string;
  server_id: string;
  removed_at: string | null;
}

interface LibraryRollup {
  server_id: string;
  server_type: string;
  library_id: string;
  item_count: number;
  movie_count: number;
  episode_count: number;
}

describe('public API v2 end to end', () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    app = await buildApp();
    token = await seedOwnerToken();
    createCacheService(getRedis());
    await getRedis().del(REDIS_KEYS.PUBLIC_MEDIA_STATS('libraries'));
  });

  afterEach(async () => {
    await getRedis().del(REDIS_KEYS.PUBLIC_MEDIA_STATS('libraries'));
    await app.close();
  });

  const authHeaders = () => ({ authorization: `Bearer ${token}` });

  it('proves the whole v2 surface against one identity across three servers', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const plex = await createTestServer({ type: 'plex' });
    const jelly = await createTestServer({ type: 'jellyfin' });
    const emby = await createTestServer({ type: 'emby' });

    // One person, one account per server. Each account starts life as its own
    // identity, then two fold into the third to make a single merged identity.
    const person = await createTestUser({ role: 'member', name: 'Acceptance Person' });
    const personJelly = await createTestUser({ role: 'member' });
    const personEmby = await createTestUser({ role: 'member' });
    const suPlex = await createTestServerUser({ userId: person.id, serverId: plex.id });
    const suJelly = await createTestServerUser({ userId: personJelly.id, serverId: jelly.id });
    const suEmby = await createTestServerUser({ userId: personEmby.id, serverId: emby.id });
    await mergeUsers(personJelly.id, person.id, admin.id);
    await mergeUsers(personEmby.id, person.id, admin.id);

    // Shared movie, asymmetric provider ids: plex carries imdb+tmdb, jellyfin
    // only tmdb, emby tmdb+tvdb. The shared tmdb:584 collapses all three.
    const moviePlex = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0000584',
      tmdbId: 584,
      title: 'Shared Feature',
      year: 2001,
      serverId: plex.id,
      ratingKey: 'mv-plex',
    });
    const movieJelly = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 584,
      title: 'Shared Feature',
      year: 2001,
      serverId: jelly.id,
      ratingKey: 'mv-jelly',
    });
    const movieEmby = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 584,
      tvdbId: 5840,
      title: 'Shared Feature',
      year: 2001,
      serverId: emby.id,
      ratingKey: 'mv-emby',
    });
    expect(movieJelly).toBe(moviePlex);
    expect(movieEmby).toBe(moviePlex);
    const movieId = moviePlex;
    await db
      .update(media)
      .set({ genres: ['Action', 'Sci-Fi'] })
      .where(eq(media.id, movieId));

    await createTestLibraryItem({
      serverId: plex.id,
      libraryId: 'movies-plex',
      ratingKey: 'mv-plex',
      mediaType: 'movie',
      mediaId: movieId,
    });
    await createTestLibraryItem({
      serverId: jelly.id,
      libraryId: 'movies-jelly',
      ratingKey: 'mv-jelly',
      mediaType: 'movie',
      mediaId: movieId,
    });
    await createTestLibraryItem({
      serverId: emby.id,
      libraryId: 'movies-emby',
      ratingKey: 'mv-emby',
      mediaType: 'movie',
      mediaId: movieId,
    });

    // One full movie play per server by the merged identity.
    const movieWatches = [
      { server: plex, su: suPlex, ratingKey: 'mv-plex', at: '2026-07-10T20:00:00Z' },
      { server: jelly, su: suJelly, ratingKey: 'mv-jelly', at: '2026-07-11T20:00:00Z' },
      { server: emby, su: suEmby, ratingKey: 'mv-emby', at: '2026-07-12T20:00:00Z' },
    ] as const;
    for (const w of movieWatches) {
      await createTestSession({
        serverId: w.server.id,
        serverUserId: w.su.id,
        mediaId: movieId,
        tmdbId: 584,
        ratingKey: w.ratingKey,
        durationMs: 6_000_000,
        totalDurationMs: 7_200_000,
        progressMs: 7_000_000,
        watched: true,
        state: 'stopped',
        startedAt: new Date(w.at),
        stoppedAt: new Date(w.at),
      });
    }

    // Short session on the movie: under the play threshold, so it never counts
    // as a play and never appears in history.
    await createTestSession({
      serverId: plex.id,
      serverUserId: suPlex.id,
      mediaId: movieId,
      tmdbId: 584,
      ratingKey: 'mv-plex',
      durationMs: 60_000,
      shortSession: true,
      startedAt: new Date('2026-07-13T20:00:00Z'),
    });

    // A show with two seasons and three episodes, watched on plex only.
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 4242,
      title: 'Acceptance Show',
      serverId: plex.id,
      ratingKey: 'show-r',
    });
    const season1 = await resolveMediaForItem({
      mediaType: 'season',
      showMediaId: showId,
      seasonNumber: 1,
      serverId: plex.id,
      ratingKey: 'se1-r',
    });
    const season2 = await resolveMediaForItem({
      mediaType: 'season',
      showMediaId: showId,
      seasonNumber: 2,
      serverId: plex.id,
      ratingKey: 'se2-r',
    });
    const ep1 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 1,
      tvdbId: 5001,
      title: 'S1E1',
      serverId: plex.id,
      ratingKey: 'ep1-r',
    });
    const ep2 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 1,
      episodeNumber: 2,
      tvdbId: 5002,
      title: 'S1E2',
      serverId: plex.id,
      ratingKey: 'ep2-r',
    });
    const ep3 = await resolveMediaForItem({
      mediaType: 'episode',
      showMediaId: showId,
      seasonNumber: 2,
      episodeNumber: 1,
      tvdbId: 5003,
      title: 'S2E1',
      serverId: plex.id,
      ratingKey: 'ep3-r',
    });

    await createTestLibraryItem({
      serverId: plex.id,
      libraryId: 'tv-plex',
      ratingKey: 'se1-r',
      mediaType: 'season',
      mediaId: season1,
    });
    await createTestLibraryItem({
      serverId: plex.id,
      libraryId: 'tv-plex',
      ratingKey: 'se2-r',
      mediaType: 'season',
      mediaId: season2,
    });
    await createTestLibraryItem({
      serverId: plex.id,
      libraryId: 'tv-plex',
      ratingKey: 'ep1-r',
      mediaType: 'episode',
      mediaId: ep1,
      parentIndex: 1,
      itemIndex: 1,
    });
    await createTestLibraryItem({
      serverId: plex.id,
      libraryId: 'tv-plex',
      ratingKey: 'ep2-r',
      mediaType: 'episode',
      mediaId: ep2,
      parentIndex: 1,
      itemIndex: 2,
    });
    await createTestLibraryItem({
      serverId: plex.id,
      libraryId: 'tv-plex',
      ratingKey: 'ep3-r',
      mediaType: 'episode',
      mediaId: ep3,
      parentIndex: 2,
      itemIndex: 1,
    });

    // Episode 1 is a resume chain: two segments, the second referencing the
    // first. The continuation is not a separate play.
    const ep1Start = await createTestSession({
      serverId: plex.id,
      serverUserId: suPlex.id,
      mediaType: 'episode',
      mediaId: ep1,
      showMediaId: showId,
      seasonNumber: 1,
      ratingKey: 'ep1-r',
      durationMs: 3_000_000,
      totalDurationMs: 1_500_000,
      progressMs: 1_500_000,
      watched: true,
      state: 'stopped',
      startedAt: new Date('2026-07-14T20:00:00Z'),
      stoppedAt: new Date('2026-07-14T20:50:00Z'),
    });
    await createTestSession({
      serverId: plex.id,
      serverUserId: suPlex.id,
      mediaType: 'episode',
      mediaId: ep1,
      showMediaId: showId,
      seasonNumber: 1,
      ratingKey: 'ep1-r',
      referenceId: ep1Start.id,
      durationMs: 3_000_000,
      totalDurationMs: 1_500_000,
      progressMs: 1_500_000,
      watched: true,
      state: 'stopped',
      startedAt: new Date('2026-07-14T21:00:00Z'),
      stoppedAt: new Date('2026-07-14T21:50:00Z'),
    });
    for (const [epId, at] of [
      [ep2, '2026-07-15T20:00:00Z'],
      [ep3, '2026-07-16T20:00:00Z'],
    ] as const) {
      await createTestSession({
        serverId: plex.id,
        serverUserId: suPlex.id,
        mediaType: 'episode',
        mediaId: epId,
        showMediaId: showId,
        seasonNumber: epId === ep3 ? 2 : 1,
        ratingKey: epId === ep2 ? 'ep2-r' : 'ep3-r',
        durationMs: 3_000_000,
        totalDurationMs: 1_500_000,
        progressMs: 1_500_000,
        watched: true,
        state: 'stopped',
        startedAt: new Date(at),
        stoppedAt: new Date(at),
      });
    }

    await refreshUserMediaPlays();

    // Movie stats: three plays combined, one per server, one distinct identity.
    const movieStatsRes = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/movie:tmdb:584/stats',
      headers: authHeaders(),
    });
    expect(movieStatsRes.statusCode).toBe(200);
    const movieStats = movieStatsRes.json<MediaStats>();
    expect(movieStats.media_id).toBe(movieId);
    const movieAll = movieStats.windows.all_time;
    expect(movieAll.combined.plays).toBe(3);
    expect(movieAll.combined.unique_users).toBe(1);
    expect(movieAll.per_server).toHaveLength(3);
    for (const server of [plex, jelly, emby]) {
      const entry = movieAll.per_server.find((e) => e.server_id === server.id)!;
      expect(entry.plays).toBe(1);
      expect(entry.unique_users).toBe(1);
      expect(entry.server_name).toBe(server.name);
    }

    // Show watchers roll up every episode into one server-account entry.
    const showWatchersRes = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${showId}/watchers`,
      headers: authHeaders(),
    });
    expect(showWatchersRes.statusCode).toBe(200);
    const showWatchers = showWatchersRes.json<MediaWatchers>();
    expect(showWatchers.watchers).toHaveLength(1);
    const showWatcher = showWatchers.watchers[0]!;
    expect(showWatcher.user.server_user_id).toBe(suPlex.id);
    expect(showWatcher.user.user_id).toBe(person.id);
    expect(showWatcher.plays).toBe(3);
    expect(showWatcher.distinct_episodes_watched).toBe(3);

    // The full season discovery path a series-automation consumer walks:
    // show ref -> children -> season uuid -> season watchers.
    const childrenRes = await app.inject({
      method: 'GET',
      url: '/api/v2/public/media/show:tvdb:4242/children',
      headers: authHeaders(),
    });
    expect(childrenRes.statusCode).toBe(200);
    const children = childrenRes.json<{ data: SeasonChild[] }>().data;
    expect(children.map((c) => c.season_number)).toEqual([1, 2]);
    const season1Uuid = children.find((c) => c.season_number === 1)!.id;
    expect(season1Uuid).toBe(season1);

    const seasonStatsRes = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${season1Uuid}/stats`,
      headers: authHeaders(),
    });
    expect(seasonStatsRes.statusCode).toBe(200);
    const seasonStats = seasonStatsRes.json<MediaStats>();
    expect(seasonStats.media_type).toBe('season');
    expect(seasonStats.windows.all_time.combined.plays).toBe(2);
    expect(seasonStats.windows.all_time.combined.unique_users).toBe(1);

    const seasonWatchersRes = await app.inject({
      method: 'GET',
      url: `/api/v2/public/media/${season1Uuid}/watchers`,
      headers: authHeaders(),
    });
    expect(seasonWatchersRes.statusCode).toBe(200);
    const seasonWatchers = seasonWatchersRes.json<MediaWatchers>();
    expect(seasonWatchers.watchers).toHaveLength(1);
    expect(seasonWatchers.watchers[0]!.distinct_episodes_watched).toBe(2);
    expect(seasonWatchers.watchers[0]!.plays).toBe(2);

    // User stats sum every account the identity owns across all three servers.
    const userStatsRes = await app.inject({
      method: 'GET',
      url: `/api/v2/public/users/${person.id}/stats`,
      headers: authHeaders(),
    });
    expect(userStatsRes.statusCode).toBe(200);
    const userStats = userStatsRes.json<UserStats>();
    expect(userStats.user_id).toBe(person.id);
    // Three movie plays + three episode plays; short session and resume
    // continuation excluded.
    expect(userStats.windows.all_time.plays).toBe(6);
    // Movie 3 x 6_000_000 + episodes (ep1 resume 6_000_000, ep2, ep3 each
    // 3_000_000) = 30_000_000.
    expect(userStats.windows.all_time.watch_time_ms).toBe(30_000_000);
    const action = userStats.top_genres.find((g) => g.genre === 'Action')!;
    expect(action.plays).toBe(3);

    // The identity correlation block carries one account per server.
    const identityRes = await app.inject({
      method: 'GET',
      url: `/api/v2/public/users/${person.id}`,
      headers: authHeaders(),
    });
    expect(identityRes.statusCode).toBe(200);
    const identity = identityRes.json<{ accounts: { server_id: string }[] }>();
    expect(identity.accounts.map((a) => a.server_id).sort()).toEqual(
      [plex.id, jelly.id, emby.id].sort()
    );

    // History cursor walk: every play appears exactly once, tagged with the
    // merged identity and a stamped media id; the resume chain is one record.
    const seen: HistoryRecord[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
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

    expect(seen).toHaveLength(6);
    expect(new Set(seen.map((r) => r.id)).size).toBe(6);
    for (const record of seen) {
      expect(record.user.id).toBe(person.id);
      expect(record.media_id).not.toBeNull();
    }
    const ep1Record = seen.find((r) => r.id === ep1Start.id)!;
    expect(ep1Record.segment_count).toBe(2);
    const movieRecord = seen.find((r) => r.media_id === movieId)!;
    expect(movieRecord.tmdb_id).toBe(584);

    // Recently-added reflects the seeded catalog: eight live items, no tombstones.
    const recentRes = await app.inject({
      method: 'GET',
      url: '/api/v2/public/recently-added?pageSize=100',
      headers: authHeaders(),
    });
    expect(recentRes.statusCode).toBe(200);
    const recent = recentRes.json<{ data: RecentlyAddedRecord[] }>().data;
    expect(recent).toHaveLength(8);
    expect(recent.every((r) => r.removed_at === null)).toBe(true);
    expect(recent.filter((r) => r.server_id === plex.id)).toHaveLength(6);

    // Libraries rollup matches the seeded per-library counts.
    const librariesRes = await app.inject({
      method: 'GET',
      url: '/api/v2/public/libraries',
      headers: authHeaders(),
    });
    expect(librariesRes.statusCode).toBe(200);
    const libraries = librariesRes.json<{ data: LibraryRollup[] }>().data;

    const moviesPlex = libraries.find(
      (r) => r.server_id === plex.id && r.library_id === 'movies-plex'
    )!;
    expect(moviesPlex.server_type).toBe('plex');
    expect(moviesPlex.item_count).toBe(1);
    expect(moviesPlex.movie_count).toBe(1);

    const tvPlex = libraries.find((r) => r.server_id === plex.id && r.library_id === 'tv-plex')!;
    // Season container rows (2) are excluded from item_count; only the 3 episodes count.
    expect(tvPlex.item_count).toBe(3);
    expect(tvPlex.episode_count).toBe(3);

    const moviesEmby = libraries.find(
      (r) => r.server_id === emby.id && r.library_id === 'movies-emby'
    )!;
    expect(moviesEmby.server_type).toBe('emby');
    expect(moviesEmby.movie_count).toBe(1);
  });
});
