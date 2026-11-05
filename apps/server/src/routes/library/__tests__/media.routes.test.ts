/**
 * Media detail route tests
 *
 * db.select/db.execute are mocked (this suite's convention, see
 * catalog.routes.test.ts), so these prove handler mechanics, camelCase
 * response shape, and the cache contract - not SQL correctness. Real-DB
 * scoping correctness (owner vs non-owner availability/stats/watchers)
 * lives in apps/server/test/integration/mediaDetailScoped.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type {
  AlbumDetailResponse,
  AuthUser,
  MediaDetailResponse,
  MediaChildrenResponse,
  MediaStatsResponse,
  MediaWatchersResponse,
  MediaPlatformBreakdownResponse,
  MediaSeasonHeatResponse,
} from '@tracearr/shared';
import { renderSql } from '../../../test/helpers.js';

const { scopeRedis } = vi.hoisted(() => ({ scopeRedis: { get: vi.fn(), set: vi.fn() } }));

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
    select: vi.fn(),
  },
}));
vi.mock('../../../lib/redisShared.js', () => ({ getRedis: () => scopeRedis }));

vi.mock('../../../services/settings.js', () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../services/downloads/queries.js', () => ({
  queryMediaDownloads: vi.fn().mockResolvedValue([]),
}));

import { db } from '../../../db/client.js';
import { queryMediaDownloads } from '../../../services/downloads/queries.js';
import { libraryMediaRoute } from '../media.js';
import { permissionGuard } from '../../../lib/scope.js';

function createSpyRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
}

async function buildTestApp(
  authUser: AuthUser,
  redis: ReturnType<typeof createSpyRedis>
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('redis', redis as never);
  await app.register(libraryMediaRoute, { prefix: '/library' });
  return app;
}

function createOwnerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

function createViewerUser(serverIds: string[]): AuthUser {
  return { userId: randomUUID(), username: 'viewer', role: 'admin', serverIds };
}

/**
 * Queues rows for successive `db.select(...).from(...)` calls, whether the
 * caller awaits `.from(...)` directly or chains `.where(...)` first - both
 * resolve the same queued rows, since real query builders are awaitable at
 * either point and this mock only needs to hand back one row set per call.
 */
function queueSelect(...results: unknown[][]): void {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: vi.fn(() => {
          const rows = results[i++] ?? [];
          return {
            where: vi.fn(async () => rows),
            then: (resolve: (v: unknown) => void) => resolve(rows),
          };
        }),
      }) as never
  );
}

function rawMediaRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: randomUUID(),
    mediaType: 'movie',
    matchKey: 'movie:tmdb:1',
    imdbId: null,
    tmdbId: 1,
    tvdbId: null,
    title: 'Dune',
    normalizedTitle: 'dune',
    year: 2021,
    parentMediaId: null,
    showMediaId: null,
    genres: ['SciFi'],
    mergedIntoId: null,
    latestAddedAt: new Date('2024-01-01').toISOString(),
    ...overrides,
  };
}

describe('GET /library/media/:id and sub-resources', () => {
  let app: FastifyInstance;
  const dbExecute = vi.mocked(db.execute);

  beforeEach(() => {
    dbExecute.mockReset();
    dbExecute.mockResolvedValue({ rows: [] } as never);
    vi.mocked(db.select).mockReset();
    vi.mocked(queryMediaDownloads).mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('rejects a provider ref, accepting a media uuid only', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const response = await app.inject({ method: 'GET', url: '/library/media/movie:tmdb:584' });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('hands out square art for an artist', async () => {
    app = await buildTestApp(createOwnerUser(), createSpyRedis());
    const row = rawMediaRow({ mediaType: 'artist', matchKey: 'artist:title:daft punk' });

    queueSelect([row], [{ id: row.id }]);
    dbExecute.mockResolvedValueOnce({ rows: [] } as never);
    dbExecute.mockResolvedValueOnce({
      rows: [
        { thumb_path: '/library/metadata/41/thumb', dominant_color: null, server_id: 'srv-1' },
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}` });
    expect(response.statusCode).toBe(200);
    const body: MediaDetailResponse = response.json();
    expect(body.mediaType).toBe('artist');
    expect(body.posterUrl).toContain('width=360&height=360');
  });

  it('shapes the detail response in camelCase and caches it', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const row = rawMediaRow();

    queueSelect([row], [{ id: row.id }]);
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          server_id: randomUUID(),
          server_type: 'plex',
          library_id: 'lib-1',
          library_name: 'Movies',
          rating_key: 'rk-1',
          added_at: new Date('2024-01-01').toISOString(),
          removed_at: null,
          video_resolution: '1080p',
          file_size: '123456',
        },
      ],
    } as never);
    dbExecute.mockResolvedValueOnce({
      rows: [{ thumb_path: '/library/thumb/1', dominant_color: '#334455', server_id: 'srv-1' }],
    } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}` });
    expect(response.statusCode).toBe(200);
    const body: MediaDetailResponse = response.json();
    expect(body).toMatchObject({
      id: row.id,
      mediaType: 'movie',
      title: 'Dune',
      showMediaId: null,
      mergedIds: [],
      seasonCount: null,
      episodeCount: null,
      dominantColor: '#334455',
    });
    expect(body.posterUrl).toContain('server=srv-1');
    expect(body.posterUrl).toContain('width=360&height=540');
    expect(body.posterUrl).toContain(`v=${body.posterVersion}`);
    expect(body.availability).toEqual([
      {
        serverId: expect.any(String),
        serverType: 'plex',
        libraryId: 'lib-1',
        libraryName: 'Movies',
        ratingKey: 'rk-1',
        addedAt: new Date('2024-01-01').toISOString(),
        removedAt: null,
        videoResolution: '1080p',
        fileSize: 123456,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
        replaces: null,
      },
    ]);
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  it('returns the downloads for the media and its merged ids, outside the cache', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const row = rawMediaRow();
    const mergedId = randomUUID();
    const download = { id: randomUUID(), title: 'Dune' };
    vi.mocked(queryMediaDownloads).mockResolvedValue([download] as never);

    queueSelect([row], [{ id: row.id }, { id: mergedId }]);
    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json<MediaDetailResponse>().downloads).toEqual([download]);
    expect(queryMediaDownloads).toHaveBeenCalledWith([row.id, mergedId], undefined);
    expect(redis.setex.mock.calls[0]?.[2]).toContain('"downloads":[]');
  });

  it("reads a cache hit's downloads with its merged ids, without resolving aliases again", async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const row = rawMediaRow();
    const mergedId = randomUUID();

    queueSelect([row], [{ id: row.id }, { id: mergedId }], [row]);
    await app.inject({ method: 'GET', url: `/library/media/${row.id}` });
    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}` });

    expect(response.statusCode).toBe(200);
    expect(redis.setex).toHaveBeenCalledTimes(1);
    expect(db.select).toHaveBeenCalledTimes(3);
    expect(queryMediaDownloads).toHaveBeenLastCalledWith([row.id, mergedId], undefined);
  });

  it('returns no downloads to a member', async () => {
    const userId = randomUUID();
    const serverId = randomUUID();
    scopeRedis.get.mockResolvedValue(
      JSON.stringify({ serverUserIds: [randomUUID()], serverIds: [serverId], libraryIds: {} })
    );
    app = await buildTestApp(
      { userId, username: 'member', role: 'member', serverIds: [] },
      createSpyRedis()
    );
    const row = rawMediaRow();
    queueSelect([row], [{ id: row.id }]);
    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json<MediaDetailResponse>().downloads).toEqual([]);
    expect(queryMediaDownloads).not.toHaveBeenCalled();
  });

  it('lists two same-server copies separately, each with its own library name', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const row = rawMediaRow();
    const serverId = randomUUID();

    queueSelect([row], [{ id: row.id }]);
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          server_id: serverId,
          server_type: 'plex',
          library_id: 'lib-4k',
          library_name: '4K Movies',
          rating_key: 'rk-4k',
          added_at: new Date('2024-01-01').toISOString(),
          removed_at: null,
          video_resolution: '4k',
          file_size: '50000000000',
        },
        {
          server_id: serverId,
          server_type: 'plex',
          library_id: 'lib-1080p',
          library_name: '1080p Movies',
          rating_key: 'rk-1080p',
          added_at: new Date('2024-01-02').toISOString(),
          removed_at: null,
          video_resolution: '1080p',
          file_size: '8000000000',
        },
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}` });
    expect(response.statusCode).toBe(200);
    const body: MediaDetailResponse = response.json();
    expect(body.availability).toEqual([
      expect.objectContaining({
        serverId,
        libraryId: 'lib-4k',
        libraryName: '4K Movies',
        videoResolution: '4k',
      }),
      expect.objectContaining({
        serverId,
        libraryId: 'lib-1080p',
        libraryName: '1080p Movies',
        videoResolution: '1080p',
      }),
    ]);
  });

  it('enriches show availability rows with the per-server+library episode rollup', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const show = rawMediaRow({ mediaType: 'show' });
    const serverA = randomUUID();
    const serverB = randomUUID();

    queueSelect([show], [{ id: show.id }]);
    dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            server_id: serverA,
            server_type: 'plex',
            library_id: 'lib-a',
            library_name: 'TV',
            rating_key: 'rk-a',
            added_at: new Date('2024-01-01').toISOString(),
            removed_at: null,
            video_resolution: null,
            file_size: null,
            episode_file_size: null,
            episode_resolutions: null,
            episode_count: null,
          },
          {
            server_id: serverB,
            server_type: 'jellyfin',
            library_id: 'lib-b',
            library_name: 'Shows',
            rating_key: 'rk-b',
            added_at: new Date('2024-01-02').toISOString(),
            removed_at: null,
            video_resolution: null,
            file_size: null,
            episode_file_size: null,
            episode_resolutions: null,
            episode_count: null,
          },
        ],
      } as never) // availability
      .mockResolvedValueOnce({
        rows: [
          {
            server_id: serverA,
            library_id: 'lib-a',
            episode_file_size: '10000000000',
            episode_count: 3,
            episode_resolutions: ['1080p', '4k'],
          },
          // serverB has no active episode files, so its row stays null.
        ],
      } as never) // episode rollup
      .mockResolvedValueOnce({
        rows: [{ season_count: '1', episode_count: '3' }],
      } as never); // season/episode counts

    const response = await app.inject({ method: 'GET', url: `/library/media/${show.id}` });
    expect(response.statusCode).toBe(200);
    const body: MediaDetailResponse = response.json();
    expect(body.availability).toEqual([
      expect.objectContaining({
        serverId: serverA,
        fileSize: null,
        episodeFileSize: 10_000_000_000,
        episodeResolutions: ['1080p', '4k'],
        episodeCount: 3,
      }),
      expect.objectContaining({
        serverId: serverB,
        fileSize: null,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
      }),
    ]);
  });

  it('answers an empty list for a show that has no library items', async () => {
    app = await buildTestApp(createOwnerUser(), createSpyRedis());
    const show = rawMediaRow({ mediaType: 'show', showMediaId: null });

    queueSelect([show], []);

    const response = await app.inject({ method: 'GET', url: `/library/media/${show.id}/children` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as MediaChildrenResponse).data).toEqual([]);
  });

  it('shapes the children response in camelCase for a show', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const show = rawMediaRow({ mediaType: 'show', showMediaId: null });
    const season = { id: randomUUID(), matchKey: `season:${show.id}:s1`, title: 'Season 1' };

    queueSelect([show], [season]);
    dbExecute.mockResolvedValueOnce({
      rows: [{ season_number: 1, episode_count: '3' }],
    } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${show.id}/children` });
    expect(response.statusCode).toBe(200);
    const body: MediaChildrenResponse = response.json();
    expect(body.data).toEqual([
      {
        id: season.id,
        mediaType: 'season',
        title: 'Season 1',
        seasonNumber: 1,
        episodeCount: 3,
        episodeNumber: null,
        imdbId: null,
        tmdbId: null,
        tvdbId: null,
        showMediaId: show.id,
        genres: null,
      },
    ]);
  });

  it("lists an artist's albums per server copy with their track counts", async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const artist = rawMediaRow({ mediaType: 'artist', matchKey: 'artist:mbid:1', tmdbId: null });
    const albumId = randomUUID();
    const serverId = randomUUID();

    queueSelect([artist], [{ id: artist.id }]);
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          id: albumId,
          title: 'Discovery',
          year: 2001,
          genres: ['Electronic'],
          thumb_path: '/library/metadata/20/thumb/1',
          server_id: serverId,
          added_at: '2023-04-05T06:07:08.000Z',
          track_count: 14,
        },
      ],
    } as never);

    const response = await app.inject({
      method: 'GET',
      url: `/library/media/${artist.id}/children`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<MediaChildrenResponse>().data).toEqual([
      {
        id: albumId,
        mediaType: 'album',
        title: 'Discovery',
        seasonNumber: null,
        episodeCount: null,
        episodeNumber: null,
        imdbId: null,
        tmdbId: null,
        tvdbId: null,
        showMediaId: null,
        genres: ['Electronic'],
        year: 2001,
        thumbPath: '/library/metadata/20/thumb/1',
        serverId,
        addedAt: '2023-04-05T06:07:08.000Z',
        trackCount: 14,
      },
    ]);
    const { sql: albumSql } = renderSql(dbExecute.mock.calls[0]![0] as never);
    expect(albumSql).toContain("a.media_type = 'album'");
    expect(albumSql).toContain('t.parent_rating_key = a.rating_key');
  });

  it('404s the album sheet for an id that is not an album', async () => {
    app = await buildTestApp(createOwnerUser(), createSpyRedis());
    const artist = rawMediaRow({ mediaType: 'artist', matchKey: 'artist:mbid:1', tmdbId: null });

    queueSelect([artist]);
    const response = await app.inject({ method: 'GET', url: `/library/media/${artist.id}/album` });
    expect(response.statusCode).toBe(404);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('404s the album sheet when the album has no active copy in scope', async () => {
    app = await buildTestApp(createOwnerUser(), createSpyRedis());
    const album = rawMediaRow({ mediaType: 'album', matchKey: 'album:mbid:1', tmdbId: null });

    queueSelect([album], [{ id: album.id }]);
    const response = await app.inject({ method: 'GET', url: `/library/media/${album.id}/album` });
    expect(response.statusCode).toBe(404);
  });

  it('shapes the album sheet response and caches it', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const album = rawMediaRow({
      mediaType: 'album',
      matchKey: 'album:mbid:1',
      tmdbId: null,
      title: 'The Click',
      year: 2017,
    });
    const serverId = randomUUID();

    queueSelect([album], [{ id: album.id }]);
    dbExecute
      .mockResolvedValueOnce({
        rows: [
          {
            server_id: serverId,
            rating_key: '9001',
            year: 2017,
            parent_title: 'AJR',
            thumb_path: '/library/metadata/9001/thumb/1731801600',
            created_at: '2024-11-17T20:00:00.000Z',
            artist_media_id: 'artist-1',
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        rows: [
          { plays: 3, prior_plays: 1, listen_ms: '600000', all_plays: 4, finished: 3, judged: 4 },
        ],
      } as never)
      .mockResolvedValueOnce({ rows: [{ name: 'Becca', plays: 4 }] } as never)
      .mockResolvedValueOnce({
        rows: [
          { track_index: 1, title: 'Overture', plays: 4, last_played: '2026-10-18T00:00:00.000Z' },
        ],
      } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${album.id}/album` });
    expect(response.statusCode).toBe(200);
    expect(response.json<AlbumDetailResponse>()).toEqual({
      album: {
        id: album.id,
        title: 'The Click',
        artistTitle: 'AJR',
        artistMediaId: 'artist-1',
        year: 2017,
        trackCount: 1,
        durationMs: null,
        addedAt: '2024-11-17T20:00:00.000Z',
        posterUrl: expect.stringContaining('width=360&height=360'),
        posterVersion: expect.any(String),
        copies: [{ serverId, ratingKey: '9001' }],
      },
      last30: { plays: 3, priorPlays: 1, listenMs: 600000 },
      allTime: { plays: 4, listeners: [{ name: 'Becca', plays: 4, share: 100 }], finishedRate: 75 },
      tracks: [
        {
          index: 1,
          title: 'Overture',
          durationMs: null,
          plays: 4,
          lastPlayedAt: '2026-10-18T00:00:00.000Z',
        },
      ],
    });
    expect(redis.setex).toHaveBeenCalledTimes(1);
    const { sql: copiesSql } = renderSql(dbExecute.mock.calls[0]![0] as never);
    expect(copiesSql.replace(/\s+/g, ' ')).toContain(
      "ORDER BY (li.thumb_path IS NOT NULL AND (li.thumb_path NOT LIKE '/Items/%' OR li.thumb_path LIKE '%?tag=%')) DESC, li.created_at DESC"
    );
  });

  it('scopes artist stats to track sessions under the artist copies', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const artist = rawMediaRow({ mediaType: 'artist', matchKey: 'artist:mbid:1', tmdbId: null });

    queueSelect([artist], [{ id: artist.id }], []);
    dbExecute.mockResolvedValue({ rows: [] } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${artist.id}/stats` });
    expect(response.statusCode).toBe(200);
    expect(response.json<MediaStatsResponse>().mediaType).toBe('artist');
    expect(dbExecute).toHaveBeenCalledTimes(3);
    for (const [query] of dbExecute.mock.calls) {
      const { sql: text, params } = renderSql(query as never);
      expect(text).toContain("s.media_type = 'track'");
      expect(text).toContain('(s.server_id, s.grandparent_rating_key) IN');
      expect(params).toContain(artist.id);
    }
  });

  it('shapes the stats response in camelCase across all three windows', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const row = rawMediaRow();

    queueSelect([row], [{ id: row.id }], []); // canonical, aliases, servers lookup
    dbExecute
      .mockResolvedValueOnce({ rows: [] } as never) // all_time
      .mockResolvedValueOnce({ rows: [] } as never) // last_30
      .mockResolvedValueOnce({ rows: [] } as never); // last_7

    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}/stats` });
    expect(response.statusCode).toBe(200);
    const body: MediaStatsResponse = response.json();
    expect(body.mediaId).toBe(row.id);
    expect(body.windows.all_time).toEqual({
      combined: { plays: 0, watchTimeMs: 0, uniqueUsers: 0 },
      perServer: [],
    });
    expect(body.windows.last_30.combined.plays).toBe(0);
    expect(body.windows.last_7.combined.plays).toBe(0);
  });

  it('shapes the watchers response in camelCase', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const row = rawMediaRow();

    queueSelect([row], [{ id: row.id }]);
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          server_user_id: randomUUID(),
          user_id: randomUUID(),
          server_id: randomUUID(),
          username: 'alice',
          identity_name: 'Alice',
          thumb: 'https://plex.tv/users/alice/avatar',
          plays: '2',
          watch_time_ms: '600000',
          completion_pct: 85.5,
          last_watched_day: '2024-01-02',
          distinct_episodes_watched: 0,
        },
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}/watchers` });
    expect(response.statusCode).toBe(200);
    const body: MediaWatchersResponse = response.json();
    expect(body.window).toBe('all_time');
    expect(body.watchers).toEqual([
      {
        user: {
          serverUserId: expect.any(String),
          userId: expect.any(String),
          serverId: expect.any(String),
          username: 'alice',
          identityName: 'Alice',
          thumb: 'https://plex.tv/users/alice/avatar',
        },
        plays: 2,
        watchTimeMs: 600000,
        completionPct: 85.5,
        lastWatchedDay: '2024-01-02',
        distinctEpisodesWatched: null,
      },
    ]);
  });

  it('paginates history with a camelCase cursor envelope, never caching it', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const row = rawMediaRow();

    queueSelect([row], [{ id: row.id }]);
    dbExecute.mockResolvedValueOnce({ rows: [] } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}/history` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [], meta: { nextCursor: null, pageSize: 25 } });
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('returns the account id alongside the identity id on history rows', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const row = rawMediaRow();
    const chainId = randomUUID();
    const serverUserId = randomUUID();
    const identityId = randomUUID();
    const startedAt = new Date('2024-03-04T05:06:07.000Z');

    queueSelect([row], [{ id: row.id }]);
    dbExecute.mockResolvedValueOnce({
      rows: [{ chain_ids: [chainId], raw_row_count: '1', window_lower_bound: startedAt }],
    } as never);
    dbExecute.mockResolvedValueOnce({
      rows: [
        {
          chain_id: chainId,
          chain_started_at: startedAt,
          server_id: randomUUID(),
          server_name: 'Plex',
          server_type: 'plex',
          state: 'stopped',
          media_type: 'movie',
          media_title: 'Arrival',
          segment_count: '1',
          watched: true,
          server_user_id: serverUserId,
          user_id: identityId,
          server_username: 'alice',
          user_thumb_url: null,
          user_name: 'Alice',
          user_username: 'alice',
        },
      ],
    } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}/history` });
    expect(response.statusCode).toBe(200);
    const play = response.json().data[0];
    expect(play.user.server_user_id).toBe(serverUserId);
    expect(play.user.id).toBe(identityId);
  });

  it('shapes the platform breakdown response in camelCase', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const row = rawMediaRow();

    queueSelect([row], [{ id: row.id }]);
    dbExecute.mockResolvedValueOnce({
      rows: [{ platform: 'iOS', player: 'Tracearr iOS', plays: '5', watch_time_ms: '900000' }],
    } as never);

    const response = await app.inject({ method: 'GET', url: `/library/media/${row.id}/platforms` });
    expect(response.statusCode).toBe(200);
    const body: MediaPlatformBreakdownResponse = response.json();
    expect(body.data).toEqual([
      { platform: 'iOS', player: 'Tracearr iOS', plays: 5, watchTimeMs: 900000 },
    ]);
  });

  it('shapes the season-heat response in camelCase, grouping episodes by season', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const show = rawMediaRow({ mediaType: 'show', showMediaId: null });
    const season1Id = randomUUID();
    const season2Id = randomUUID();
    const ep1Id = randomUUID();
    const ep2Id = randomUUID();

    // canonical resolve, then getShowSeasons' season-row select
    queueSelect(
      [show],
      [
        { id: season1Id, matchKey: `season:${show.id}:s1`, title: 'Season 1', year: 2020 },
        { id: season2Id, matchKey: `season:${show.id}:s2`, title: 'Season 2', year: 2021 },
      ]
    );
    dbExecute
      .mockResolvedValueOnce({ rows: [{ season_number: 1, episode_count: '2' }] } as never) // getShowSeasons counts
      .mockResolvedValueOnce({
        rows: [
          {
            id: ep1Id,
            title: 'Pilot',
            imdb_id: null,
            tmdb_id: null,
            tvdb_id: null,
            show_media_id: show.id,
            genres: null,
            episode_number: 1,
          },
          {
            id: ep2Id,
            title: 'Episode 2',
            imdb_id: null,
            tmdb_id: null,
            tvdb_id: null,
            show_media_id: show.id,
            genres: null,
            episode_number: 2,
          },
        ],
      } as never) // season 1 episodes
      .mockResolvedValueOnce({ rows: [] } as never) // season 2 episodes (none)
      .mockResolvedValueOnce({
        rows: [{ canonical_id: ep1Id, watched: true, has_plays: true }],
      } as never); // resolveWatchedStates - ep2 absent, so unwatched

    const response = await app.inject({
      method: 'GET',
      url: `/library/media/${show.id}/season-heat`,
    });
    expect(response.statusCode).toBe(200);
    const body: MediaSeasonHeatResponse = response.json();
    expect(body.mediaId).toBe(show.id);
    expect(body.seasons).toEqual([
      {
        seasonNumber: 1,
        title: 'Season 1',
        year: 2020,
        episodeCount: 2,
        watchedCount: 1,
        watchedPct: 50,
        episodes: [
          { mediaId: ep1Id, title: 'Pilot', episodeNumber: 1, watchedState: 'watched' },
          { mediaId: ep2Id, title: 'Episode 2', episodeNumber: 2, watchedState: 'unwatched' },
        ],
      },
      {
        seasonNumber: 2,
        title: 'Season 2',
        year: 2021,
        episodeCount: 0,
        watchedCount: 0,
        watchedPct: 0,
        episodes: [],
      },
    ]);
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  it('returns an empty seasons array for a show with no seasons, never dividing by zero', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const show = rawMediaRow({ mediaType: 'show', showMediaId: null });

    queueSelect([show], []); // canonical resolve, then no season rows
    dbExecute.mockResolvedValueOnce({ rows: [] } as never); // getShowSeasons counts

    const response = await app.inject({
      method: 'GET',
      url: `/library/media/${show.id}/season-heat`,
    });
    expect(response.statusCode).toBe(200);
    const body: MediaSeasonHeatResponse = response.json();
    expect(body.seasons).toEqual([]);
  });

  it('404s season-heat for a movie id, which has no seasons', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const movie = rawMediaRow({ mediaType: 'movie' });

    queueSelect([movie]);
    const response = await app.inject({
      method: 'GET',
      url: `/library/media/${movie.id}/season-heat`,
    });
    expect(response.statusCode).toBe(404);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('404s season-heat for an episode id, which has no seasons', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const episode = rawMediaRow({ mediaType: 'episode', showMediaId: randomUUID() });

    queueSelect([episode]);
    const response = await app.inject({
      method: 'GET',
      url: `/library/media/${episode.id}/season-heat`,
    });
    expect(response.statusCode).toBe(404);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('uses a distinct cache entry per accessible-server scope for the same media id', async () => {
    const redisA = createSpyRedis();
    const redisB = createSpyRedis();
    const serverA = randomUUID();
    const serverB = randomUUID();
    const row = rawMediaRow();

    const appA = await buildTestApp(createViewerUser([serverA]), redisA);
    queueSelect([row], [{ id: row.id }]);
    dbExecute.mockResolvedValueOnce({ rows: [] } as never);
    await appA.inject({ method: 'GET', url: `/library/media/${row.id}` });
    await appA.close();

    dbExecute.mockReset();
    dbExecute.mockResolvedValue({ rows: [] } as never);
    const appB = await buildTestApp(createViewerUser([serverB]), redisB);
    queueSelect([row], [{ id: row.id }]);
    dbExecute.mockResolvedValueOnce({ rows: [] } as never);
    await appB.inject({ method: 'GET', url: `/library/media/${row.id}` });
    await appB.close();

    expect(redisA.setex).toHaveBeenCalledTimes(1);
    expect(redisB.setex).toHaveBeenCalledTimes(1);
    const keyA = redisA.setex.mock.calls[0]![0];
    const keyB = redisB.setex.mock.calls[0]![0];
    expect(keyA).not.toBe(keyB);
  });
});
