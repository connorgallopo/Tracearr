/**
 * Member library and server-list security tests
 *
 * The library surfaces a member reaches never name or count other people beyond what the owner's
 * memberServerActivity switch allows: media detail panels, browse and shelves look through the
 * member's own lens, library analytics are closed, and the server list and profile carry nothing
 * a member has no business with. The auth plugin is real; the session lookup, Redis, the
 * database and the media detail reads are faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { REDIS_KEYS, type AuthUser } from '@tracearr/shared';
import type { SQL } from 'drizzle-orm';
import type * as MediaDetail from '../services/library/mediaDetailService.js';
import type * as Settings from '../services/settings.js';

const { fakeRedis, activity } = vi.hoisted(() => ({
  fakeRedis: { get: vi.fn(), set: vi.fn(), setex: vi.fn(), del: vi.fn() },
  activity: { on: false },
}));

vi.mock('../lib/sessionResolver.js', () => ({
  resolveBetterAuthUser: vi.fn(),
  resolveBetterAuthUserStrict: vi.fn(),
}));
vi.mock('../lib/redisShared.js', () => ({ getRedis: () => fakeRedis }));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(), selectDistinct: vi.fn(), execute: vi.fn(), update: vi.fn() },
}));
vi.mock('../db/prepared.js', () => ({}));
vi.mock('../services/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Settings>();
  return {
    ...actual,
    getSetting: vi.fn((key: string) =>
      key === 'memberServerActivity'
        ? Promise.resolve(activity.on)
        : actual.getSetting(key as never)
    ),
  };
});
vi.mock('../services/library/mediaDetailService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaDetail>()),
  resolveCanonicalMediaByRef: vi.fn(),
  buildMediaScope: vi.fn(),
  getSeasonHeat: vi.fn(),
  getMediaStats: vi.fn(),
  getMediaWatchers: vi.fn(),
}));
vi.mock('../services/library/mediaWatchedService.js', () => ({
  resolveWatchedStates: vi.fn(),
  fetchEpisodeCounts: vi.fn(),
}));
vi.mock('../services/userService.js', () => ({ getUserById: vi.fn() }));
vi.mock('../services/requests/analytics.js', () => ({ getRequestsAnalytics: vi.fn() }));

import { db } from '../db/client.js';
import { resolveBetterAuthUser } from '../lib/sessionResolver.js';
import authPlugin from '../plugins/auth.js';
import {
  buildMediaScope,
  getMediaStats,
  getMediaWatchers,
  getSeasonHeat,
  resolveCanonicalMediaByRef,
} from '../services/library/mediaDetailService.js';
import {
  fetchEpisodeCounts,
  resolveWatchedStates,
} from '../services/library/mediaWatchedService.js';
import { getRequestsAnalytics } from '../services/requests/analytics.js';
import { getUserById } from '../services/userService.js';
import { queryChain, renderSql } from '../test/helpers.js';
import { registerErrorHandler } from '../utils/errors.js';
import { sessionRoutes as authSessionRoutes } from './auth/session.js';
import { libraryStatsRoutes } from './library/index.js';
import { requestRoutes } from './requests.js';
import { serverRoutes } from './servers.js';
import { usersRoutes as statsUsersRoutes } from './stats/users.js';

const OWN = '11111111-1111-4111-8111-111111111111';
const SERVER = '33333333-3333-4333-8333-333333333333';
const OTHER_SERVER = '55555555-5555-4555-8555-555555555555';
const MEDIA = '66666666-6666-4666-8666-666666666666';

const member: AuthUser = { userId: 'u-member', username: 'mia', role: 'member', serverIds: [] };
const admin: AuthUser = { userId: 'u-admin', username: 'ada', role: 'admin', serverIds: [SERVER] };

let app: FastifyInstance;

async function build(user: AuthUser): Promise<void> {
  vi.mocked(resolveBetterAuthUser).mockResolvedValue(user);
  app = Fastify({ logger: false });
  await app.register(sensible);
  registerErrorHandler(app);
  await app.register(cookie, { secret: 'test-cookie-secret' });
  app.decorate('redis', fakeRedis as never);
  await app.register(authPlugin);
  await app.register(authSessionRoutes, { prefix: '/auth' });
  await app.register(serverRoutes, { prefix: '/servers' });
  await app.register(statsUsersRoutes, { prefix: '/stats' });
  await app.register(libraryStatsRoutes, { prefix: '/library' });
  await app.register(requestRoutes, { prefix: '/requests' });
  await app.ready();
}

function executed(): { text: string; params: unknown[] }[] {
  return vi.mocked(db.execute).mock.calls.map((call) => {
    const rendered = renderSql(call[0] as SQL);
    return { text: rendered.sql.replace(/\s+/g, ' '), params: rendered.params };
  });
}

function cacheWrites(): string[] {
  return fakeRedis.setex.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  activity.on = false;
  fakeRedis.set.mockResolvedValue('OK');
  fakeRedis.get.mockImplementation(async (key: string) =>
    key === REDIS_KEYS.USER_SCOPE('u-member')
      ? JSON.stringify({ serverUserIds: [OWN], serverIds: [SERVER] })
      : null
  );
  vi.mocked(db.select).mockImplementation(() => queryChain(vi.fn, []));
  vi.mocked(db.selectDistinct).mockImplementation(() => queryChain(vi.fn, []));
  vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
  vi.mocked(resolveCanonicalMediaByRef).mockResolvedValue({
    id: MEDIA,
    mediaType: 'show',
  } as never);
  vi.mocked(buildMediaScope).mockResolvedValue({ kind: 'show', aliases: [MEDIA] } as never);
  vi.mocked(getSeasonHeat).mockResolvedValue([]);
  vi.mocked(resolveWatchedStates).mockResolvedValue(new Map([[MEDIA, 'watched']]));
  vi.mocked(fetchEpisodeCounts).mockResolvedValue(new Map());
});

afterEach(async () => {
  await app.close();
});

describe('server list and profile', () => {
  const serverRow = {
    id: SERVER,
    name: 'Basement',
    type: 'jellyfin',
    url: 'http://10.0.0.5:8096',
    publicUrl: 'https://media.example.com',
    machineIdentifier: 'mid',
    displayOrder: 0,
    color: '#ff0000',
    version: '10.11.0',
    latestVersion: '10.11.1',
    historicalAt: null,
    allowMemberLogin: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it("lists a member's own servers without how Tracearr reaches them", async () => {
    await build(member);
    const chain = queryChain(vi.fn, [serverRow]);
    vi.mocked(db.select).mockReturnValue(chain);

    const res = await app.inject({ method: 'GET', url: '/servers' });

    expect(res.statusCode).toBe(200);
    expect(renderSql(chain.where.mock.calls[0][0]).params).toEqual([SERVER]);
    const [listed] = res.json<{ data: Record<string, unknown>[] }>().data;
    expect(listed).toMatchObject({ id: SERVER, name: 'Basement', publicUrl: serverRow.publicUrl });
    for (const field of ['url', 'version', 'latestVersion', 'allowMemberLogin', 'token']) {
      expect(listed).not.toHaveProperty(field);
    }
  });

  it('still gives an admin the full server rows', async () => {
    await build(admin);
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [serverRow]));
    const res = await app.inject({ method: 'GET', url: '/servers' });
    expect(res.json<{ data: Record<string, unknown>[] }>().data[0]).toHaveProperty('url');
  });

  it('gives a member their own servers and no trust score from /auth/me', async () => {
    await build(member);
    vi.mocked(getUserById).mockResolvedValue({
      id: 'u-member',
      role: 'member',
      aggregateTrustScore: 40,
    } as never);

    const body = (await app.inject({ method: 'GET', url: '/auth/me' })).json();

    expect(body.serverIds).toEqual([SERVER]);
    expect(body).not.toHaveProperty('aggregateTrustScore');
  });

  it('gives an admin every server id from /auth/me', async () => {
    await build(admin);
    vi.mocked(getUserById).mockResolvedValue({
      id: 'u-admin',
      role: 'admin',
      aggregateTrustScore: 100,
    } as never);
    vi.mocked(db.select).mockImplementation(() =>
      queryChain(vi.fn, [{ id: SERVER }, { id: OTHER_SERVER }])
    );

    const body = (await app.inject({ method: 'GET', url: '/auth/me' })).json();

    expect(body.serverIds).toEqual([SERVER, OTHER_SERVER]);
    expect(body.aggregateTrustScore).toBe(100);
  });

  it("leaves the trust score off a member's own leaderboard row", async () => {
    await build(member);
    vi.mocked(db.execute).mockResolvedValue({
      rows: [
        {
          user_id: 'u-member',
          aggregate_trust_score: 40,
          server_user_id: OWN,
          play_count: 1,
          watch_time_ms: '0',
        },
      ],
    } as never);

    const res = await app.inject({ method: 'GET', url: '/stats/top-users' });

    expect(res.json<{ data: Record<string, unknown>[] }>().data[0]).not.toHaveProperty(
      'trustScore'
    );
  });
});

describe('library analytics', () => {
  it.each([
    '/library/watch',
    '/library/patterns',
    '/library/completion',
    '/library/roi',
    '/library/stale',
    '/library/top-movies',
    '/library/top-shows',
    '/library/duplicates',
    '/library/codecs',
    '/library/storage',
    '/library/quality',
    '/library/resolution',
  ])('%s is 404 for a member and open to an admin', async (url) => {
    await build(member);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    await app.close();

    await build(admin);
    expect((await app.inject({ method: 'GET', url })).statusCode).not.toBe(404);
  });
});

describe('media detail for a member', () => {
  it('is 404 for a title whose copies sit only in libraries the member cannot open', async () => {
    fakeRedis.get.mockImplementation(async (key: string) =>
      key === REDIS_KEYS.USER_SCOPE('u-member')
        ? JSON.stringify({
            serverUserIds: [OWN],
            serverIds: [SERVER],
            libraryIds: { [SERVER]: ['lib-1'] },
          })
        : null
    );
    vi.mocked(db.execute).mockResolvedValue({ rows: [{ hidden: true }] } as never);
    await build(member);

    for (const path of ['', '/children', '/season-heat']) {
      const res = await app.inject({ method: 'GET', url: `/library/media/${MEDIA}${path}` });
      expect(res.statusCode).toBe(404);
    }
    expect(
      executed().some((q) => q.text.includes('NOT EXISTS') && q.params.includes('lib-1'))
    ).toBe(true);
    expect(getSeasonHeat).not.toHaveBeenCalled();
  });

  it('limits the platforms panel to the member and caches it for them alone', async () => {
    await build(member);

    const res = await app.inject({ method: 'GET', url: `/library/media/${MEDIA}/platforms` });

    expect(res.statusCode).toBe(200);
    expect(
      executed().some((q) => q.text.includes('s.server_user_id IN') && q.params.includes(OWN))
    ).toBe(true);
    expect(cacheWrites().some((key) => key.includes('platforms:member:u-member'))).toBe(true);
  });

  it("marks season heat with the member's own plays", async () => {
    await build(member);

    await app.inject({ method: 'GET', url: `/library/media/${MEDIA}/season-heat` });

    expect(vi.mocked(getSeasonHeat).mock.calls[0]?.[2]).toBe('u-member');
    expect(cacheWrites().some((key) => key.includes('season-heat:member:u-member'))).toBe(true);
  });

  it('shows a member their own title stats unless the owner shows server activity', async () => {
    vi.mocked(getMediaStats).mockResolvedValue({
      all_time: { combined: { plays: 0, watch_time_ms: 0, unique_users: 0 }, per_server: [] },
      last_30: { combined: { plays: 0, watch_time_ms: 0, unique_users: 0 }, per_server: [] },
      last_7: { combined: { plays: 0, watch_time_ms: 0, unique_users: 0 }, per_server: [] },
    });
    await build(member);
    await app.inject({ method: 'GET', url: `/library/media/${MEDIA}/stats` });
    expect(vi.mocked(getMediaStats).mock.calls[0]?.[2]).toMatchObject({ userId: 'u-member' });

    activity.on = true;
    await app.inject({ method: 'GET', url: `/library/media/${MEDIA}/stats` });
    expect(vi.mocked(getMediaStats).mock.calls[1]?.[2]).toBe('all');
  });

  it('counts other watchers as people, and only when the owner shows server activity', async () => {
    const watcher = (serverUserId: string, userId: string) => ({
      user: {
        server_user_id: serverUserId,
        user_id: userId,
        server_id: SERVER,
        username: null,
        identity_name: null,
        thumb: null,
      },
      plays: 1,
      watch_time_ms: 0,
      completion_pct: null,
      last_watched_day: null,
      distinct_episodes_watched: null,
    });
    vi.mocked(getMediaWatchers).mockResolvedValue([
      watcher(OWN, 'u-member'),
      watcher('su-a', 'u-other'),
      watcher('su-b', 'u-other'),
    ]);
    await build(member);

    const hidden = (
      await app.inject({ method: 'GET', url: `/library/media/${MEDIA}/watchers` })
    ).json();
    activity.on = true;
    const shown = (
      await app.inject({ method: 'GET', url: `/library/media/${MEDIA}/watchers` })
    ).json();

    expect(hidden.watchers).toHaveLength(1);
    expect(hidden).not.toHaveProperty('othersCount');
    expect(shown.watchers).toHaveLength(1);
    expect(shown.othersCount).toBe(1);
  });
});

describe('browse and shelves for a member', () => {
  const shelf = (mediaId: string) => ({ mediaId, mediaType: 'movie', watchedState: 'partial' });
  const cachedShelves = {
    period: 'month',
    recentlyAddedMovies: [shelf(MEDIA)],
    recentlyAddedShows: [],
    recentlyUpdated: [shelf(MEDIA)],
    mostPopularMovies: [{ ...shelf(MEDIA), plays: 12, viewers: 4, rank: 1 }],
    mostPopularShows: [],
    deadWeight: [shelf(MEDIA)],
    kpis: {
      hoursWatched: 1,
      watchedInPeriod: { titlesTouched: 2, totalTitles: 5 },
      deadWeight: { count: 1, totalBytes: 10 },
      newlyAdded: { count: 3, totalBytes: 30, playedCount: 2 },
    },
    meta: {},
  };

  it('re-reads watched state through the member lens, keeps Most Popular, drops Recently Updated', async () => {
    await build(member);
    fakeRedis.get.mockImplementation(async (key: string) =>
      key === REDIS_KEYS.USER_SCOPE('u-member')
        ? JSON.stringify({ serverUserIds: [OWN], serverIds: [SERVER] })
        : key.startsWith(REDIS_KEYS.LIBRARY_SHELVES)
          ? JSON.stringify(cachedShelves)
          : null
    );

    const body = (await app.inject({ method: 'GET', url: '/library/shelves' })).json();
    activity.on = true;
    const withActivity = (await app.inject({ method: 'GET', url: '/library/shelves' })).json();

    expect(vi.mocked(resolveWatchedStates).mock.calls[0]?.[0]).toMatchObject({
      lensUserId: 'u-member',
    });
    expect(body.recentlyAddedMovies[0].watchedState).toBe('watched');
    expect(body.mostPopularMovies).toHaveLength(1);
    expect(body.mostPopularMovies[0].watchedState).toBe('watched');
    expect(body.recentlyUpdated).toEqual([]);
    expect(body.kpis).not.toHaveProperty('hoursWatched');
    expect(body.kpis.watchedInPeriod).toEqual({ totalTitles: 5 });
    expect(body.kpis.newlyAdded).toEqual({ count: 3, totalBytes: 30 });
    expect(withActivity.kpis.newlyAdded.playedCount).toBe(2);
    expect(withActivity.kpis).toMatchObject({
      hoursWatched: 1,
      watchedInPeriod: { titlesTouched: 2, totalTitles: 5 },
    });
    for (const shelves of [body, withActivity]) {
      expect(shelves).not.toHaveProperty('deadWeight');
      expect(shelves.kpis).not.toHaveProperty('deadWeight');
      expect(shelves.mostPopularMovies[0]).toMatchObject({ mediaId: MEDIA, rank: 1 });
      expect(shelves.mostPopularMovies[0]).not.toHaveProperty('plays');
      expect(shelves.mostPopularMovies[0]).not.toHaveProperty('viewers');
    }
  });

  it('leaves the play and viewer counts on Most Popular for an admin', async () => {
    await build(admin);
    fakeRedis.get.mockImplementation(async (key: string) =>
      key.startsWith(REDIS_KEYS.LIBRARY_SHELVES) ? JSON.stringify(cachedShelves) : null
    );

    const body = (await app.inject({ method: 'GET', url: '/library/shelves' })).json();

    expect(body.mostPopularMovies[0]).toMatchObject({ plays: 12, viewers: 4, rank: 1 });
  });

  it("counts a member's own plays on the genres page, cached under the member segment", async () => {
    await build(member);

    await app.inject({ method: 'GET', url: '/library/genres?type=show' });

    const engagement = executed().find((q) => q.text.includes('user_media_plays_daily'));
    expect(engagement?.params).toContain(OWN);
    expect(cacheWrites()).toContainEqual(
      expect.stringMatching(new RegExp(`^${REDIS_KEYS.LIBRARY_GENRES}:.*:member:u-member$`))
    );
  });

  it("treats lens=all as the member's own lens, and refuses someone else's", async () => {
    await build(member);
    const lensChain = queryChain(vi.fn, [{ id: OWN }]);
    vi.mocked(db.execute).mockResolvedValue({ rows: [{ '?column?': 1 }] } as never);
    vi.mocked(db.select).mockReturnValue(lensChain);

    const own = await app.inject({
      method: 'GET',
      url: '/library/catalog/letters?type=movie&lens=all&sort=title&watched=watched',
    });
    const other = await app.inject({
      method: 'GET',
      url: `/library/catalog?type=movie&lens=${OTHER_SERVER}`,
    });

    expect(own.statusCode).not.toBe(404);
    expect(executed().some((q) => q.params.includes('u-member'))).toBe(true);
    // The watched candidates sit under the member segment clearScope clears.
    const written = [...cacheWrites(), ...fakeRedis.set.mock.calls.map((call) => String(call[0]))];
    expect(
      written.some(
        (key) =>
          key.startsWith(REDIS_KEYS.LIBRARY_CATALOG_WATCHED) && key.endsWith(':member:u-member')
      )
    ).toBe(true);
    expect(other.statusCode).toBe(404);
  });
});

describe('request analytics for a member', () => {
  it('counts own plays with server activity off, and caches each state apart', async () => {
    vi.mocked(getRequestsAnalytics).mockResolvedValue({
      funnel: { requested: 0, landed: 0, watched: 0 },
      unplayed: [],
      unplayedBytes: 0,
      requesters: [],
    });
    await build(member);

    await app.inject({ method: 'GET', url: '/requests/analytics' });
    activity.on = true;
    await app.inject({ method: 'GET', url: '/requests/requesters' });

    const calls = vi.mocked(getRequestsAnalytics).mock.calls;
    expect(calls[0]?.[1]).toMatchObject({ userId: 'u-member' });
    expect(calls[0]?.[2]).toBe(false);
    expect(calls[1]?.[2]).toBe(true);
    const [offKey, onKey] = cacheWrites();
    expect(offKey).toMatch(/:member:u-member$/);
    expect(onKey).toMatch(/:member:u-member:activity$/);
  });
});
