/**
 * Session Mapper Tests
 *
 * Tests for mapping MediaSession to ProcessedSession and database row to Session type.
 * Covers all media types including live TV, music tracks, photo, and unknown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapMediaSession } from '../sessionMapper.js';
import type { MediaSession } from '../../../services/mediaServer/types.js';

// Mock the external dependencies
vi.mock('../../../utils/platformNormalizer.js', () => ({
  normalizeClient: vi.fn(() => ({
    platform: 'Mocked Platform',
    device: 'Mocked Device',
  })),
}));

vi.mock('../../../utils/resolutionNormalizer.js', () => ({
  formatQualityString: vi.fn(() => '1080p'),
}));

/**
 * Create a base MediaSession for testing
 */
function createBaseMediaSession(overrides: Partial<MediaSession> = {}): MediaSession {
  return {
    sessionKey: 'session-123',
    mediaId: 'media-456',
    user: {
      id: 'user-789',
      username: 'testuser',
      thumb: '/user/thumb.jpg',
    },
    media: {
      title: 'Test Media',
      type: 'movie',
      durationMs: 7200000, // 2 hours
      year: 2024,
      thumbPath: '/media/thumb.jpg',
    },
    playback: {
      state: 'playing',
      positionMs: 3600000, // 1 hour
      progressPercent: 50,
    },
    player: {
      name: 'Living Room TV',
      deviceId: 'device-abc',
      product: 'Plex for iOS',
      device: 'iPhone',
      platform: 'iOS',
    },
    network: {
      ipAddress: '192.168.1.100',
      isLocal: true,
    },
    quality: {
      bitrate: 20000,
      isTranscode: false,
      videoDecision: 'directplay',
      audioDecision: 'directplay',
      videoResolution: '1080',
      videoWidth: 1920,
      videoHeight: 1080,
    },
    ...overrides,
  };
}

describe('sessionMapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mapMediaSession', () => {
    describe('media type mapping', () => {
      it('should map movie type correctly', () => {
        const session = createBaseMediaSession({
          media: { title: 'Test Movie', type: 'movie', durationMs: 7200000 },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.mediaType).toBe('movie');
      });

      it('should map episode type correctly', () => {
        const session = createBaseMediaSession({
          media: { title: 'Test Episode', type: 'episode', durationMs: 3600000 },
          episode: {
            showTitle: 'Test Show',
            seasonNumber: 2,
            episodeNumber: 5,
            showThumbPath: '/show/thumb.jpg',
          },
        });

        const result = mapMediaSession(session, 'jellyfin');

        expect(result.mediaType).toBe('episode');
        expect(result.grandparentTitle).toBe('Test Show');
        expect(result.seasonNumber).toBe(2);
        expect(result.episodeNumber).toBe(5);
      });

      it('should map track type correctly', () => {
        const session = createBaseMediaSession({
          media: { title: 'Test Track', type: 'track', durationMs: 240000 },
          music: {
            artistName: 'Test Artist',
            albumName: 'Test Album',
            trackNumber: 3,
            discNumber: 1,
          },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.mediaType).toBe('track');
        expect(result.artistName).toBe('Test Artist');
        expect(result.albumName).toBe('Test Album');
        expect(result.trackNumber).toBe(3);
        expect(result.discNumber).toBe(1);
      });

      it('should map live type correctly', () => {
        const session = createBaseMediaSession({
          media: { title: 'Live Stream', type: 'live', durationMs: 0 },
          live: {
            channelTitle: 'HBO',
            channelIdentifier: '501',
            channelThumb: '/channel/hbo.jpg',
          },
        });

        const result = mapMediaSession(session, 'jellyfin');

        expect(result.mediaType).toBe('live');
        expect(result.channelTitle).toBe('HBO');
        expect(result.channelIdentifier).toBe('501');
        expect(result.channelThumb).toBe('/channel/hbo.jpg');
      });

      it('should map photo type correctly', () => {
        const session = createBaseMediaSession({
          media: { title: 'Photo Album', type: 'photo', durationMs: 0 },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.mediaType).toBe('photo');
      });

      it('should map unknown type correctly', () => {
        const session = createBaseMediaSession({
          media: { title: 'Unknown Content', type: 'unknown', durationMs: 1000 },
        });

        const result = mapMediaSession(session, 'emby');

        expect(result.mediaType).toBe('unknown');
      });

      it('should default to unknown for unmapped types and log warning', () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const session = createBaseMediaSession();
        // Force an unexpected type by casting
        (session.media as { type: string }).type = 'podcast';

        const result = mapMediaSession(session, 'plex');

        expect(result.mediaType).toBe('unknown');
        expect(consoleSpy).toHaveBeenCalledWith(
          '[sessionMapper] Unexpected media type encountered: "podcast", defaulting to "unknown"'
        );
        consoleSpy.mockRestore();
      });
    });

    describe('thumb path resolution', () => {
      it('should use showThumbPath for episodes', () => {
        const session = createBaseMediaSession({
          media: {
            title: 'Episode',
            type: 'episode',
            durationMs: 3600000,
            thumbPath: '/episode/thumb.jpg',
          },
          episode: {
            showTitle: 'Show',
            seasonNumber: 1,
            episodeNumber: 1,
            showThumbPath: '/show/poster.jpg',
          },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.thumbPath).toBe('/show/poster.jpg');
      });

      it('should use channelThumb for live TV', () => {
        const session = createBaseMediaSession({
          media: { title: 'Live', type: 'live', durationMs: 0, thumbPath: '/media/thumb.jpg' },
          live: {
            channelTitle: 'ESPN',
            channelThumb: '/channel/espn.jpg',
          },
        });

        const result = mapMediaSession(session, 'jellyfin');

        expect(result.thumbPath).toBe('/channel/espn.jpg');
      });

      it('should fallback to media thumbPath for live TV without channelThumb', () => {
        const session = createBaseMediaSession({
          media: { title: 'Live', type: 'live', durationMs: 0, thumbPath: '/media/thumb.jpg' },
          live: {
            channelTitle: 'ESPN',
          },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.thumbPath).toBe('/media/thumb.jpg');
      });

      it('should use media thumbPath for movies', () => {
        const session = createBaseMediaSession({
          media: {
            title: 'Movie',
            type: 'movie',
            durationMs: 7200000,
            thumbPath: '/movie/poster.jpg',
          },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.thumbPath).toBe('/movie/poster.jpg');
      });

      it('should use media thumbPath for tracks', () => {
        const session = createBaseMediaSession({
          media: { title: 'Track', type: 'track', durationMs: 240000, thumbPath: '/album/art.jpg' },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.thumbPath).toBe('/album/art.jpg');
      });

      it('should use media thumbPath for photos', () => {
        const session = createBaseMediaSession({
          media: { title: 'Photo', type: 'photo', durationMs: 0, thumbPath: '/photo/thumb.jpg' },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.thumbPath).toBe('/photo/thumb.jpg');
      });

      it('should use media thumbPath for unknown types', () => {
        const session = createBaseMediaSession({
          media: {
            title: 'Unknown',
            type: 'unknown',
            durationMs: 1000,
            thumbPath: '/unknown/thumb.jpg',
          },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.thumbPath).toBe('/unknown/thumb.jpg');
      });

      it('should return empty string when no thumbPath available', () => {
        const session = createBaseMediaSession({
          media: { title: 'Movie', type: 'movie', durationMs: 7200000 },
        });
        delete (session.media as Record<string, unknown>).thumbPath;

        const result = mapMediaSession(session, 'plex');

        expect(result.thumbPath).toBe('');
      });
    });

    describe('live TV metadata', () => {
      it('should include all live TV fields when present', () => {
        const session = createBaseMediaSession({
          media: { title: 'Live Show', type: 'live', durationMs: 0 },
          live: {
            channelTitle: 'HBO Max',
            channelIdentifier: '500-HD',
            channelThumb: '/channels/hbo-max.jpg',
          },
        });

        const result = mapMediaSession(session, 'jellyfin');

        expect(result.channelTitle).toBe('HBO Max');
        expect(result.channelIdentifier).toBe('500-HD');
        expect(result.channelThumb).toBe('/channels/hbo-max.jpg');
      });

      it('should handle missing live metadata gracefully', () => {
        const session = createBaseMediaSession({
          media: { title: 'Live Show', type: 'live', durationMs: 0 },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.channelTitle).toBeNull();
        expect(result.channelIdentifier).toBeNull();
        expect(result.channelThumb).toBeNull();
      });

      it('should handle partial live metadata', () => {
        const session = createBaseMediaSession({
          media: { title: 'Live Show', type: 'live', durationMs: 0 },
          live: {
            channelTitle: 'CNN',
          },
        });

        const result = mapMediaSession(session, 'jellyfin');

        expect(result.channelTitle).toBe('CNN');
        expect(result.channelIdentifier).toBeNull();
        expect(result.channelThumb).toBeNull();
      });
    });

    describe('music track metadata', () => {
      it('should include all music fields when present', () => {
        const session = createBaseMediaSession({
          media: { title: 'Song Title', type: 'track', durationMs: 210000 },
          music: {
            artistName: 'Artist Name',
            albumName: 'Album Name',
            trackNumber: 5,
            discNumber: 2,
          },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.artistName).toBe('Artist Name');
        expect(result.albumName).toBe('Album Name');
        expect(result.trackNumber).toBe(5);
        expect(result.discNumber).toBe(2);
      });

      it('should handle missing music metadata gracefully', () => {
        const session = createBaseMediaSession({
          media: { title: 'Unknown Track', type: 'track', durationMs: 180000 },
        });

        const result = mapMediaSession(session, 'jellyfin');

        expect(result.artistName).toBeNull();
        expect(result.albumName).toBeNull();
        expect(result.trackNumber).toBeNull();
        expect(result.discNumber).toBeNull();
      });

      it('should handle partial music metadata', () => {
        const session = createBaseMediaSession({
          media: { title: 'Song', type: 'track', durationMs: 200000 },
          music: {
            artistName: 'Solo Artist',
            trackNumber: 1,
          },
        });

        const result = mapMediaSession(session, 'emby');

        expect(result.artistName).toBe('Solo Artist');
        expect(result.albumName).toBeNull();
        expect(result.trackNumber).toBe(1);
        expect(result.discNumber).toBeNull();
      });
    });

    describe('playback state mapping', () => {
      it('should map playing state', () => {
        const session = createBaseMediaSession({
          playback: { state: 'playing', positionMs: 1000, progressPercent: 10 },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.state).toBe('playing');
      });

      it('should map paused state', () => {
        const session = createBaseMediaSession({
          playback: { state: 'paused', positionMs: 1000, progressPercent: 10 },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.state).toBe('paused');
      });

      it('should map buffering as playing', () => {
        const session = createBaseMediaSession({
          playback: { state: 'buffering', positionMs: 1000, progressPercent: 10 },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.state).toBe('playing');
      });
    });

    describe('core field mapping', () => {
      it('should map all core fields correctly', () => {
        const session = createBaseMediaSession({
          sessionKey: 'unique-session-key',
          mediaId: 'rating-key-123',
          plexSessionId: 'plex-session-id',
          user: {
            id: 'user-external-id',
            username: 'testuser123',
            thumb: '/users/thumb.jpg',
          },
          media: {
            title: 'Test Movie Title',
            type: 'movie',
            durationMs: 5400000,
            year: 2023,
            thumbPath: '/media/poster.jpg',
          },
          playback: {
            state: 'playing',
            positionMs: 2700000,
            progressPercent: 50,
          },
          network: {
            ipAddress: '8.8.8.8',
            isLocal: false,
          },
          quality: {
            bitrate: 15000,
            isTranscode: true,
            videoDecision: 'transcode',
            audioDecision: 'copy',
          },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.sessionKey).toBe('unique-session-key');
        expect(result.ratingKey).toBe('rating-key-123');
        expect(result.plexSessionId).toBe('plex-session-id');
        expect(result.externalUserId).toBe('user-external-id');
        expect(result.username).toBe('testuser123');
        expect(result.userThumb).toBe('/users/thumb.jpg');
        expect(result.mediaTitle).toBe('Test Movie Title');
        expect(result.year).toBe(2023);
        expect(result.totalDurationMs).toBe(5400000);
        expect(result.progressMs).toBe(2700000);
        expect(result.ipAddress).toBe('8.8.8.8');
        expect(result.isTranscode).toBe(true);
        expect(result.videoDecision).toBe('transcode');
        expect(result.audioDecision).toBe('copy');
        expect(result.bitrate).toBe(15000);
      });

      it('should handle missing optional user thumb', () => {
        const session = createBaseMediaSession({
          user: {
            id: 'user-id',
            username: 'noavatar',
          },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.userThumb).toBe('');
      });

      it('should default username to Unknown when empty', () => {
        const session = createBaseMediaSession({
          user: {
            id: 'user-id',
            username: '',
          },
        });

        const result = mapMediaSession(session, 'plex');

        expect(result.username).toBe('Unknown');
      });

      it('should include lastPausedDate when provided', () => {
        const pauseDate = new Date('2024-01-15T10:30:00Z');
        const session = createBaseMediaSession({
          lastPausedDate: pauseDate,
        });

        const result = mapMediaSession(session, 'jellyfin');

        expect(result.lastPausedDate).toEqual(pauseDate);
      });
    });

    describe('server type handling', () => {
      it('should work with plex server type', () => {
        const session = createBaseMediaSession();
        const result = mapMediaSession(session, 'plex');
        expect(result.sessionKey).toBe('session-123');
      });

      it('should work with jellyfin server type', () => {
        const session = createBaseMediaSession();
        const result = mapMediaSession(session, 'jellyfin');
        expect(result.sessionKey).toBe('session-123');
      });

      it('should work with emby server type', () => {
        const session = createBaseMediaSession();
        const result = mapMediaSession(session, 'emby');
        expect(result.sessionKey).toBe('session-123');
      });
    });
  });
});
