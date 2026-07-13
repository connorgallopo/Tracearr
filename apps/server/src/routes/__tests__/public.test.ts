/**
 * Public API route tests
 *
 * Focused coverage for external integration contracts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  getCacheService: vi.fn(() => null),
}));

vi.mock('../../services/dashboardStats.js', () => ({
  getDashboardStats: vi.fn(),
}));

vi.mock('../../services/imageProxy.js', () => ({
  buildAvatarUrl: vi.fn((serverId: string, thumbUrl: string | null) =>
    thumbUrl ? `/avatar/${serverId}` : null
  ),
  buildPosterUrl: vi.fn((serverId: string, thumbPath: string | null) =>
    thumbPath ? `/poster/${serverId}` : null
  ),
}));

vi.mock('../../services/termination.js', () => ({
  terminateSession: vi.fn(),
}));

vi.mock('../../utils/buildInfo.js', () => ({
  getCurrentVersion: vi.fn(() => 'test-version'),
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

  app.decorate('authenticatePublicApi', async () => undefined);
  app.decorate('redis', {} as never);

  await app.register(publicRoutes, { prefix: '/public' });

  return app;
}

function createHistoryRow(overrides: Record<string, unknown> = {}) {
  const serverId = randomUUID();
  const startedAt = new Date('2026-07-10T10:00:00.000Z');
  const stoppedAt = new Date('2026-07-10T11:00:00.000Z');

  return {
    id: randomUUID(),
    started_at: startedAt,
    stopped_at: stoppedAt,
    duration_ms: '3600000',
    progress_ms: 3_600_000,
    total_duration_ms: 7_200_000,
    segment_count: '1',
    watched: false,
    state: 'stopped',
    server_id: serverId,
    server_name: 'Main Plex',
    media_type: 'movie',
    media_title: 'Test Movie',
    rating_key: '25314',
    grandparent_title: null,
    season_number: null,
    episode_number: null,
    year: 2010,
    artist_name: null,
    album_name: null,
    track_number: null,
    disc_number: null,
    thumb_path: '/library/metadata/25314/thumb',
    device: 'Apple TV',
    player_name: 'Plex for Apple TV',
    product: 'Plex',
    platform: 'tvOS',
    is_transcode: false,
    video_decision: 'directplay',
    audio_decision: 'directplay',
    bitrate: 12_000,
    source_video_codec: 'h264',
    source_audio_codec: 'aac',
    source_audio_channels: 6,
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
    imdb_id: 'tt1375666',
    tmdb_id: 27205,
    tvdb_id: 12345,
    grandparent_rating_key: '110397',
    user_id: randomUUID(),
    server_username: 'plexuser',
    user_thumb_url: '/avatar.jpg',
    user_name: 'Plex User',
    user_username: 'plexuser',
    ...overrides,
  };
}

describe('Public Routes', () => {
  let app: FastifyInstance;
  let mockDb: typeof db;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDb = db;
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /public/history', () => {
    it('returns Reclaimerr-friendly media identifiers and progress fields', async () => {
      const startedAt = new Date('2026-07-11T10:00:00.000Z');
      const rowWithoutLibraryMatch = createHistoryRow({
        id: randomUUID(),
        started_at: startedAt,
        stopped_at: null,
        progress_ms: 1_000,
        total_duration_ms: null,
        rating_key: '99999',
        imdb_id: null,
        tmdb_id: null,
        tvdb_id: null,
        grandparent_rating_key: null,
      });

      vi.mocked(mockDb.execute)
        .mockResolvedValueOnce({ rows: [{ count: 2 }] } as never)
        .mockResolvedValueOnce({
          rows: [createHistoryRow(), rowWithoutLibraryMatch],
        } as never);

      const response = await app.inject({
        method: 'GET',
        url: '/public/history',
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.meta).toEqual({ total: 2, page: 1, pageSize: 25 });

      expect(body.data[0]).toMatchObject({
        ratingKey: '25314',
        grandparentRatingKey: '110397',
        imdbId: 'tt1375666',
        tmdbId: 27205,
        tvdbId: 12345,
        watchedAt: '2026-07-10T11:00:00.000Z',
        percentComplete: 50,
      });

      expect(body.data[1]).toMatchObject({
        ratingKey: '99999',
        grandparentRatingKey: null,
        imdbId: null,
        tmdbId: null,
        tvdbId: null,
        watchedAt: '2026-07-11T10:00:00.000Z',
        percentComplete: null,
      });
    });
  });

  describe('OpenAPI document', () => {
    it('documents public history media identifiers', () => {
      const spec = generateOpenAPIDocument() as {
        components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> };
      };

      const sessionHistoryProperties = spec.components?.schemas?.SessionHistory?.properties;

      expect(sessionHistoryProperties).toEqual(
        expect.objectContaining({
          ratingKey: expect.any(Object),
          grandparentRatingKey: expect.any(Object),
          imdbId: expect.any(Object),
          tmdbId: expect.any(Object),
          tvdbId: expect.any(Object),
          watchedAt: expect.any(Object),
          percentComplete: expect.any(Object),
        })
      );
    });
  });
});
