/**
 * Public API v2 /top-media against a real database: the ranking, its cursor,
 * and that every row's numbers equal the title's media stats for the same
 * window and server.
 *
 * Run with: pnpm --filter @tracearr/server test:integration publicV2TopMedia
 */

import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { media } from '../../src/db/schema.js';
import { listTopMedia } from '../../src/routes/library/queries.js';
import { decodeRankCursor } from '../../src/utils/cursor.js';
import { buildMediaScope, getMediaStats } from '../../src/services/library/mediaDetailService.js';
import {
  mergeMediaRows,
  resolveMediaForItem,
} from '../../src/services/library/mediaResolutionService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HALF_HOUR = 30 * MINUTE_MS;

async function refreshPlaysAggregate(): Promise<void> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
}

function daysAgoAtNoon(days: number): Date {
  return new Date(new Date().setUTCHours(12, 0, 0, 0) - days * DAY_MS);
}

async function identity(serverId: string): Promise<string> {
  const user = await createTestUser();
  const account = await createTestServerUser({ serverId, userId: user.id });
  return account.id;
}

async function movie(serverId: string, key: string, tmdbId: number): Promise<string> {
  return resolveMediaForItem({
    mediaType: 'movie',
    tmdbId,
    title: `Movie ${key}`,
    year: 2021,
    serverId,
    ratingKey: key,
  });
}

interface PlayOptions {
  serverId: string;
  serverUserId: string;
  mediaId: string;
  showMediaId?: string;
  ratingKey: string;
  durationMs: number;
  startedAt: Date;
}

async function play(opts: PlayOptions): Promise<void> {
  await createTestSession({
    serverId: opts.serverId,
    serverUserId: opts.serverUserId,
    mediaId: opts.mediaId,
    showMediaId: opts.showMediaId ?? null,
    ratingKey: opts.ratingKey,
    mediaType: opts.showMediaId ? 'episode' : 'movie',
    state: 'stopped',
    referenceId: null,
    durationMs: opts.durationMs,
    totalDurationMs: 7_200_000,
    progressMs: opts.durationMs,
    watched: opts.durationMs >= 120_000,
    startedAt: opts.startedAt,
    stoppedAt: new Date(opts.startedAt.getTime() + opts.durationMs),
  });
}

async function statsFor(mediaId: string) {
  const [row] = await db.select().from(media).where(eq(media.id, mediaId));
  if (!row) throw new Error(`no media row ${mediaId}`);
  const scope = await buildMediaScope(row);
  if (!scope) throw new Error(`no scope for ${mediaId}`);
  return getMediaStats(scope, undefined, 'all');
}

const firstPage = { serverIds: undefined, pageSize: 100, after: null } as const;

function pick(row: { plays: number; watch_time_ms: number; unique_users: number } | undefined) {
  return {
    plays: row?.plays,
    watch_time_ms: row?.watch_time_ms,
    unique_users: row?.unique_users,
  };
}

describe('listTopMedia', () => {
  it('ranks movies by each sort', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewers = [
      await identity(server.id),
      await identity(server.id),
      await identity(server.id),
    ];
    const [first, second, third] = viewers;
    if (!first || !second || !third) throw new Error('viewers not seeded');
    const mostPlays = await movie(server.id, 'most-plays', 950_001);
    const mostViewers = await movie(server.id, 'most-viewers', 950_002);
    const mostWatched = await movie(server.id, 'most-watched', 950_003);
    const common = { serverId: server.id, startedAt: daysAgoAtNoon(2) };
    for (let i = 0; i < 4; i++)
      await play({
        ...common,
        serverUserId: first,
        mediaId: mostPlays,
        ratingKey: 'most-plays',
        durationMs: 5 * MINUTE_MS,
      });
    for (const viewer of viewers)
      await play({
        ...common,
        serverUserId: viewer,
        mediaId: mostViewers,
        ratingKey: 'most-viewers',
        durationMs: 10 * MINUTE_MS,
      });
    for (const viewer of [first, second])
      await play({
        ...common,
        serverUserId: viewer,
        mediaId: mostWatched,
        ratingKey: 'most-watched',
        durationMs: 100 * MINUTE_MS,
      });
    await refreshPlaysAggregate();

    const order = async (sort: 'plays' | 'watch_time' | 'viewers') =>
      (await listTopMedia({ ...firstPage, kind: 'movie', days: 30, sort })).data.map(
        (row) => row.media_id
      );

    expect(await order('plays')).toEqual([mostPlays, mostViewers, mostWatched]);
    expect(await order('watch_time')).toEqual([mostWatched, mostViewers, mostPlays]);
    expect(await order('viewers')).toEqual([mostViewers, mostWatched, mostPlays]);
  });

  it('each row equals media stats for the same window', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser();
    const onA = (await createTestServerUser({ serverId: serverA.id, userId: person.id })).id;
    const onB = (await createTestServerUser({ serverId: serverB.id, userId: person.id })).id;
    const sampler = await identity(serverA.id);

    const filmA = await movie(serverA.id, 'stats-a', 951_001);
    const filmB = await movie(serverA.id, 'stats-b', 951_002);
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 951_100,
      title: 'Stats Show',
      year: 2021,
      serverId: serverA.id,
      ratingKey: 'stats-show',
    });
    const episodeId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 951_101,
      title: 'Stats Episode',
      year: 2021,
      serverId: serverA.id,
      ratingKey: 'stats-ep',
      showMediaId: showId,
    });

    const plays: PlayOptions[] = [
      {
        serverId: serverA.id,
        serverUserId: onA,
        mediaId: filmA,
        ratingKey: 'stats-a',
        durationMs: 50 * MINUTE_MS,
        startedAt: daysAgoAtNoon(0),
      },
      {
        serverId: serverB.id,
        serverUserId: onB,
        mediaId: filmA,
        ratingKey: 'stats-a',
        durationMs: 40 * MINUTE_MS,
        startedAt: daysAgoAtNoon(6),
      },
      {
        serverId: serverA.id,
        serverUserId: onA,
        mediaId: filmA,
        ratingKey: 'stats-a',
        durationMs: 30 * MINUTE_MS,
        startedAt: daysAgoAtNoon(7),
      },
      {
        serverId: serverA.id,
        serverUserId: sampler,
        mediaId: filmA,
        ratingKey: 'stats-a',
        durationMs: 20_000,
        startedAt: daysAgoAtNoon(1),
      },
      {
        serverId: serverB.id,
        serverUserId: onB,
        mediaId: filmB,
        ratingKey: 'stats-b',
        durationMs: 90 * MINUTE_MS,
        startedAt: daysAgoAtNoon(29),
      },
      {
        serverId: serverA.id,
        serverUserId: onA,
        mediaId: filmB,
        ratingKey: 'stats-b',
        durationMs: 90 * MINUTE_MS,
        startedAt: daysAgoAtNoon(30),
      },
      {
        serverId: serverA.id,
        serverUserId: onA,
        mediaId: episodeId,
        showMediaId: showId,
        ratingKey: 'stats-ep',
        durationMs: 25 * MINUTE_MS,
        startedAt: daysAgoAtNoon(3),
      },
      {
        serverId: serverA.id,
        serverUserId: sampler,
        mediaId: episodeId,
        showMediaId: showId,
        ratingKey: 'stats-ep',
        durationMs: 20_000,
        startedAt: daysAgoAtNoon(3),
      },
    ];
    for (const p of plays) await play(p);
    await refreshPlaysAggregate();

    const windows = [
      { days: 30, key: 'last_30' },
      { days: 7, key: 'last_7' },
    ] as const;
    let compared = 0;
    for (const { days, key } of windows) {
      for (const kind of ['movie', 'show'] as const) {
        for (const serverId of [undefined, serverA.id, serverB.id]) {
          const { data } = await listTopMedia({
            ...firstPage,
            kind,
            days,
            sort: 'plays',
            serverIds: serverId ? [serverId] : undefined,
          });
          for (const row of data) {
            const window = (await statsFor(row.media_id))[key];
            const expected = serverId
              ? window.per_server.find((s) => s.server_id === serverId)
              : window.combined;
            expect({ days, kind, serverId, id: row.media_id, ...pick(row) }).toEqual({
              days,
              kind,
              serverId,
              id: row.media_id,
              plays: expected?.plays,
              watch_time_ms: expected?.watch_time_ms,
              unique_users: expected?.unique_users,
            });
            compared++;
          }
        }
      }
    }
    // 30 days: both films combined and on B, filmA on A, the show combined and on A (7 rows);
    // 7 days: filmA combined and on each server, the show combined and on A (5 rows).
    expect(compared).toBe(12);
  });

  it('rolls episodes up to the show with show-level ids', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewer = await identity(server.id);
    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 952_100,
      title: 'Rollup Show',
      year: 2020,
      serverId: server.id,
      ratingKey: 'rollup-show',
    });
    for (const n of [1, 2]) {
      const episodeId = await resolveMediaForItem({
        mediaType: 'episode',
        tvdbId: 952_100 + n,
        title: `Rollup Episode ${n}`,
        year: 2020,
        serverId: server.id,
        ratingKey: `rollup-ep-${n}`,
        showMediaId: showId,
      });
      await play({
        serverId: server.id,
        serverUserId: viewer,
        mediaId: episodeId,
        showMediaId: showId,
        ratingKey: `rollup-ep-${n}`,
        durationMs: 30 * MINUTE_MS,
        startedAt: daysAgoAtNoon(1),
      });
    }
    await refreshPlaysAggregate();

    const { data } = await listTopMedia({ ...firstPage, kind: 'show', days: 30, sort: 'plays' });

    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      media_id: showId,
      media_type: 'show',
      title: 'Rollup Show',
      tvdb_id: 952_100,
      plays: 2,
      unique_users: 1,
    });
  });

  it('folds a merged alias into its winner', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewer = await identity(server.id);
    const winner = await movie(server.id, 'alias-winner', 953_001);
    const loser = await movie(server.id, 'alias-loser', 953_002);
    const common = { serverId: server.id, serverUserId: viewer, startedAt: daysAgoAtNoon(2) };
    await play({ ...common, mediaId: winner, ratingKey: 'alias-winner', durationMs: HALF_HOUR });
    await play({ ...common, mediaId: loser, ratingKey: 'alias-loser', durationMs: HALF_HOUR });
    await mergeMediaRows(winner, loser);
    await refreshPlaysAggregate();

    const { data } = await listTopMedia({ ...firstPage, kind: 'movie', days: 30, sort: 'plays' });
    const stats = (await statsFor(winner)).last_30.combined;

    expect(data.map((row) => row.media_id)).toEqual([winner]);
    expect(pick(data[0])).toEqual({
      plays: stats.plays,
      watch_time_ms: stats.watch_time_ms,
      unique_users: stats.unique_users,
    });
    expect(data[0]?.plays).toBe(2);
  });

  it('leaves out titles whose only plays in the window are samples', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewer = await identity(server.id);
    const sampled = await movie(server.id, 'sampled', 954_001);
    const watched = await movie(server.id, 'watched', 954_002);
    const common = { serverId: server.id, serverUserId: viewer };
    await play({
      ...common,
      mediaId: sampled,
      ratingKey: 'sampled',
      durationMs: 20_000,
      startedAt: daysAgoAtNoon(1),
    });
    await play({
      ...common,
      mediaId: sampled,
      ratingKey: 'sampled',
      durationMs: HALF_HOUR,
      startedAt: daysAgoAtNoon(40),
    });
    await play({
      ...common,
      mediaId: watched,
      ratingKey: 'watched',
      durationMs: HALF_HOUR,
      startedAt: daysAgoAtNoon(1),
    });
    await refreshPlaysAggregate();

    const { data } = await listTopMedia({ ...firstPage, kind: 'movie', days: 30, sort: 'plays' });

    expect(data.map((row) => row.media_id)).toEqual([watched]);
  });

  it('pages every title exactly once across equal sort values', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewer = await identity(server.id);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await movie(server.id, `tie-${i}`, 955_001 + i);
      ids.push(id);
      await play({
        serverId: server.id,
        serverUserId: viewer,
        mediaId: id,
        ratingKey: `tie-${i}`,
        durationMs: HALF_HOUR,
        startedAt: daysAgoAtNoon(1),
      });
    }
    await refreshPlaysAggregate();

    const seen: string[] = [];
    let after: { value: number; id: string } | null = null;
    for (let page = 0; page < 5; page++) {
      const result = await listTopMedia({
        kind: 'movie',
        days: 30,
        sort: 'plays',
        serverIds: undefined,
        pageSize: 1,
        after,
      });
      seen.push(...result.data.map((row) => row.media_id));
      if (!result.nextCursor) break;
      after = decodeRankCursor(result.nextCursor);
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('last_watched_day is the last day with a counted play', async () => {
    const server = await createTestServer({ type: 'plex' });
    const viewer = await identity(server.id);
    const id = await movie(server.id, 'last-day', 956_001);
    const common = {
      serverId: server.id,
      serverUserId: viewer,
      mediaId: id,
      ratingKey: 'last-day',
    };
    const threeDaysAgo = daysAgoAtNoon(3);
    await play({ ...common, durationMs: HALF_HOUR, startedAt: threeDaysAgo });
    await play({
      ...common,
      durationMs: 20_000,
      startedAt: new Date(new Date().setUTCHours(0, 0, 0, 0)),
    });
    await refreshPlaysAggregate();

    const { data } = await listTopMedia({ ...firstPage, kind: 'movie', days: 30, sort: 'plays' });

    expect(data[0]?.last_watched_day).toBe(threeDaysAgo.toISOString().slice(0, 10));
  });
});
