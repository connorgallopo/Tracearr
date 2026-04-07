import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';

vi.mock('../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../../services/cache.js', () => ({
  getCacheService: vi.fn(),
}));

vi.mock('../../services/dashboardStats.js', () => ({
  getDashboardStats: vi.fn(),
}));

vi.mock('../../services/imageProxy.js', () => ({
  buildAvatarUrl: vi.fn((serverId: string, path: string | null) =>
    path ? `avatar:${serverId}:${path}` : null
  ),
  buildPosterUrl: vi.fn((serverId: string, path: string | null) =>
    path ? `poster:${serverId}:${path}` : null
  ),
}));

vi.mock('../../services/termination.js', () => ({
  terminateSession: vi.fn(),
}));

vi.mock('../../utils/buildInfo.js', () => ({
  getCurrentVersion: vi.fn(() => '1.0.0-test'),
}));

vi.mock('../stats/queries.js', () => ({
  queryConcurrentStreams: vi.fn(),
  queryPlatforms: vi.fn(),
  queryPlaysByDayOfWeek: vi.fn(),
  queryPlaysByHourOfDay: vi.fn(),
  queryPlaysOverTime: vi.fn(),
  queryQualityBreakdown: vi.fn(),
}));

import { db } from '../../db/client.js';
import { publicRoutes } from '../public.js';
import { generateOpenAPIDocument } from '../public.openapi.js';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate(
    'authenticatePublicApi',
    vi.fn(async (request: unknown) => {
      void request;
    })
  );
  await app.register(publicRoutes, { prefix: '/public' });
  return app;
}

describe('Public API Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns stable media IDs and parent show IDs from /history', async () => {
    app = await buildTestApp();

    const serverId = randomUUID();
    const userId = randomUUID();
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [{ count: 1 }] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: randomUUID(),
            started_at: new Date('2026-04-07T10:00:00.000Z'),
            stopped_at: new Date('2026-04-07T10:25:00.000Z'),
            duration_ms: '1500000',
            progress_ms: 1450000,
            total_duration_ms: 1800000,
            segment_count: '2',
            watched: true,
            state: 'stopped',
            server_id: serverId,
            server_name: 'Main Plex',
            media_type: 'episode',
            media_title: 'Pilot',
            grandparent_title: 'Breaking Bad',
            season_number: 1,
            episode_number: 1,
            year: 2008,
            artist_name: null,
            album_name: null,
            track_number: null,
            disc_number: null,
            thumb_path: '/library/metadata/1/thumb/1',
            rating_key: 'ep-123',
            device: 'Chrome',
            player_name: 'Web',
            product: 'Plex Web',
            platform: 'Chrome',
            is_transcode: false,
            video_decision: 'copy',
            audio_decision: 'copy',
            bitrate: 8000,
            source_video_codec: 'h264',
            source_audio_codec: 'aac',
            source_audio_channels: 2,
            source_video_width: 1920,
            source_video_height: 1080,
            source_video_details: null,
            source_audio_details: null,
            stream_video_codec: 'h264',
            stream_audio_codec: 'aac',
            stream_video_details: null,
            stream_audio_details: null,
            transcode_info: null,
            subtitle_info: null,
            imdb_id: 'tt0959621',
            tmdb_id: 62085,
            tvdb_id: 349232,
            show_rating_key: 'show-456',
            show_imdb_id: 'tt0903747',
            show_tmdb_id: 1396,
            show_tvdb_id: 81189,
            user_id: userId,
            server_username: 'jared',
            user_thumb_url: '/users/1/avatar',
            user_name: 'Jared',
            user_username: 'jared',
          },
        ],
      } as never);

    const response = await app.inject({ method: 'GET', url: '/public/history?page=1&pageSize=25' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta).toEqual({ page: 1, pageSize: 25, total: 1 });
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      ratingKey: 'ep-123',
      imdbId: 'tt0959621',
      tmdbId: 62085,
      tvdbId: 349232,
      showRatingKey: 'show-456',
      showImdbId: 'tt0903747',
      showTmdbId: 1396,
      showTvdbId: 81189,
      showTitle: 'Breaking Bad',
      user: {
        id: userId,
        username: 'Jared',
        avatarUrl: `avatar:${serverId}:/users/1/avatar`,
      },
      posterUrl: `poster:${serverId}:/library/metadata/1/thumb/1`,
    });
  });

  it('returns stable IDs from /library/items', async () => {
    app = await buildTestApp();

    const serverId = randomUUID();
    vi.mocked(db.execute)
      .mockResolvedValueOnce({ rows: [{ count: 1 }] } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: randomUUID(),
            server_id: serverId,
            server_name: 'Main Plex',
            library_id: 'movie-library',
            rating_key: 'movie-123',
            imdb_id: 'tt1375666',
            tmdb_id: 27205,
            tvdb_id: 12345,
            title: 'Inception',
            media_type: 'movie',
            year: 2010,
            grandparent_title: null,
            grandparent_rating_key: null,
            parent_title: null,
            parent_rating_key: null,
            parent_index: null,
            item_index: null,
            created_at: new Date('2026-04-06T00:00:00.000Z'),
            updated_at: new Date('2026-04-07T00:00:00.000Z'),
          },
        ],
      } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/public/library/items?page=1&pageSize=25&mediaType=movie',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.meta).toEqual({ page: 1, pageSize: 25, total: 1 });
    expect(body.data[0]).toMatchObject({
      serverId,
      serverName: 'Main Plex',
      libraryId: 'movie-library',
      ratingKey: 'movie-123',
      imdbId: 'tt1375666',
      tmdbId: 27205,
      tvdbId: 12345,
      title: 'Inception',
      mediaType: 'movie',
      year: 2010,
    });
  });
});

describe('Public API OpenAPI document', () => {
  it('documents the public library items endpoint and stable history IDs', () => {
    const doc = generateOpenAPIDocument() as {
      paths: Record<string, { get?: unknown }>;
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };

    expect(doc.paths['/api/v1/public/library/items']?.get).toBeTruthy();
    expect(doc.paths['/api/v1/public/history']?.get).toBeTruthy();

    const sessionHistoryProperties = doc.components.schemas.SessionHistory?.properties ?? {};
    expect(sessionHistoryProperties).toHaveProperty('ratingKey');
    expect(sessionHistoryProperties).toHaveProperty('imdbId');
    expect(sessionHistoryProperties).toHaveProperty('tmdbId');
    expect(sessionHistoryProperties).toHaveProperty('tvdbId');
    expect(sessionHistoryProperties).toHaveProperty('showRatingKey');
    expect(sessionHistoryProperties).toHaveProperty('showImdbId');
    expect(sessionHistoryProperties).toHaveProperty('showTmdbId');
    expect(sessionHistoryProperties).toHaveProperty('showTvdbId');

    const libraryItemProperties = doc.components.schemas.LibraryItem?.properties ?? {};
    expect(libraryItemProperties).toHaveProperty('ratingKey');
    expect(libraryItemProperties).toHaveProperty('imdbId');
    expect(libraryItemProperties).toHaveProperty('tmdbId');
    expect(libraryItemProperties).toHaveProperty('tvdbId');
  });
});
