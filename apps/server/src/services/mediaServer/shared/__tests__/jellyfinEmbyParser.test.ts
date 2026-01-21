/**
 * Unit tests for Jellyfin/Emby library item parser functions
 *
 * Tests parseLibraryItemsResponse and helper functions for parsing
 * library items from Jellyfin/Emby API responses with ProviderIds extraction.
 */

import { describe, it, expect } from 'vitest';
import {
  parseProviderIds,
  mapJellyfinType,
  getResolutionString,
  extractQuality,
  parseLibraryDate,
  parseLibraryItemsResponse,
} from '../jellyfinEmbyParser.js';

// ============================================================================
// parseProviderIds tests
// ============================================================================

describe('parseProviderIds', () => {
  it('extracts IMDB ID from capitalized key (Imdb)', () => {
    const result = parseProviderIds({ Imdb: 'tt1234567' });
    expect(result.imdbId).toBe('tt1234567');
  });

  it('extracts IMDB ID from lowercase key (imdb)', () => {
    const result = parseProviderIds({ imdb: 'tt9876543' });
    expect(result.imdbId).toBe('tt9876543');
  });

  it('extracts IMDB ID from uppercase key (IMDB)', () => {
    const result = parseProviderIds({ IMDB: 'tt1111111' });
    expect(result.imdbId).toBe('tt1111111');
  });

  it('parses TMDB as number from string', () => {
    const result = parseProviderIds({ Tmdb: '123456' });
    expect(result.tmdbId).toBe(123456);
  });

  it('parses TMDB when already a number', () => {
    const result = parseProviderIds({ tmdb: 654321 });
    expect(result.tmdbId).toBe(654321);
  });

  it('parses TVDB as number from string', () => {
    const result = parseProviderIds({ Tvdb: '789012' });
    expect(result.tvdbId).toBe(789012);
  });

  it('parses TVDB when already a number', () => {
    const result = parseProviderIds({ tvdb: 210987 });
    expect(result.tvdbId).toBe(210987);
  });

  it('returns empty object for undefined input', () => {
    const result = parseProviderIds(undefined);
    expect(result).toEqual({});
  });

  it('returns empty object for null input', () => {
    const result = parseProviderIds(null);
    expect(result).toEqual({});
  });

  it('returns empty object for non-object input', () => {
    const result = parseProviderIds('not an object');
    expect(result).toEqual({});
  });

  it('handles missing individual provider IDs gracefully', () => {
    const result = parseProviderIds({ Imdb: 'tt1234567' });
    expect(result.imdbId).toBe('tt1234567');
    expect(result.tmdbId).toBeUndefined();
    expect(result.tvdbId).toBeUndefined();
  });

  it('ignores empty string IMDB ID', () => {
    const result = parseProviderIds({ Imdb: '' });
    expect(result.imdbId).toBeUndefined();
  });

  it('ignores invalid TMDB value', () => {
    const result = parseProviderIds({ Tmdb: 'not-a-number' });
    expect(result.tmdbId).toBeUndefined();
  });

  it('extracts all IDs when present', () => {
    const result = parseProviderIds({
      Imdb: 'tt1234567',
      Tmdb: '123456',
      Tvdb: '789012',
    });
    expect(result).toEqual({
      imdbId: 'tt1234567',
      tmdbId: 123456,
      tvdbId: 789012,
    });
  });
});

// ============================================================================
// mapJellyfinType tests
// ============================================================================

describe('mapJellyfinType', () => {
  it('maps movie -> movie', () => {
    expect(mapJellyfinType('Movie')).toBe('movie');
    expect(mapJellyfinType('movie')).toBe('movie');
  });

  it('maps series -> show', () => {
    expect(mapJellyfinType('Series')).toBe('show');
    expect(mapJellyfinType('series')).toBe('show');
  });

  it('maps season -> season', () => {
    expect(mapJellyfinType('Season')).toBe('season');
    expect(mapJellyfinType('season')).toBe('season');
  });

  it('maps episode -> episode', () => {
    expect(mapJellyfinType('Episode')).toBe('episode');
    expect(mapJellyfinType('episode')).toBe('episode');
  });

  it('maps MusicArtist -> artist', () => {
    expect(mapJellyfinType('MusicArtist')).toBe('artist');
    expect(mapJellyfinType('musicartist')).toBe('artist');
  });

  it('maps MusicAlbum -> album', () => {
    expect(mapJellyfinType('MusicAlbum')).toBe('album');
    expect(mapJellyfinType('musicalbum')).toBe('album');
  });

  it('maps Audio -> track', () => {
    expect(mapJellyfinType('Audio')).toBe('track');
    expect(mapJellyfinType('audio')).toBe('track');
  });

  it('maps unknown type -> movie (default)', () => {
    expect(mapJellyfinType('Unknown')).toBe('movie');
    expect(mapJellyfinType('SomeNewType')).toBe('movie');
    expect(mapJellyfinType('')).toBe('movie');
  });

  it('handles non-string input', () => {
    expect(mapJellyfinType(null)).toBe('movie');
    expect(mapJellyfinType(undefined)).toBe('movie');
    expect(mapJellyfinType(123)).toBe('movie');
  });
});

// ============================================================================
// getResolutionString tests
// ============================================================================

describe('getResolutionString', () => {
  it('returns 4k for width >= 3840', () => {
    expect(getResolutionString(3840, 2160)).toBe('4k');
    expect(getResolutionString(4096, 2160)).toBe('4k');
  });

  it('returns 1080p for width >= 1920', () => {
    expect(getResolutionString(1920, 1080)).toBe('1080p');
    expect(getResolutionString(2560, 1440)).toBe('1080p');
  });

  it('returns 720p for width >= 1280', () => {
    expect(getResolutionString(1280, 720)).toBe('720p');
    expect(getResolutionString(1366, 768)).toBe('720p');
  });

  it('returns 480p for width >= 720', () => {
    expect(getResolutionString(720, 480)).toBe('480p');
    expect(getResolutionString(854, 480)).toBe('480p');
  });

  it('returns sd for width < 720', () => {
    expect(getResolutionString(640, 480)).toBe('sd');
    expect(getResolutionString(320, 240)).toBe('sd');
  });

  it('returns undefined for missing width', () => {
    expect(getResolutionString(undefined, 1080)).toBeUndefined();
  });

  it('returns undefined for zero width', () => {
    expect(getResolutionString(0, 1080)).toBeUndefined();
  });

  it('returns undefined for negative width', () => {
    expect(getResolutionString(-1920, 1080)).toBeUndefined();
  });
});

// ============================================================================
// extractQuality tests
// ============================================================================

describe('extractQuality', () => {
  it('extracts 4k resolution from video stream', () => {
    const mediaSources = [
      {
        Container: 'mkv',
        Size: 12345678901,
        MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 }],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.videoResolution).toBe('4k');
  });

  it('extracts 1080p resolution from video stream', () => {
    const mediaSources = [
      {
        MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 }],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.videoResolution).toBe('1080p');
  });

  it('extracts video codec in uppercase', () => {
    const mediaSources = [
      {
        MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 1920, Height: 1080 }],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.videoCodec).toBe('HEVC');
  });

  it('extracts audio codec in uppercase', () => {
    const mediaSources = [
      {
        MediaStreams: [{ Type: 'Audio', Codec: 'truehd', Channels: 8 }],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.audioCodec).toBe('TRUEHD');
  });

  it('extracts audio channels', () => {
    const mediaSources = [
      {
        MediaStreams: [{ Type: 'Audio', Codec: 'ac3', Channels: 6 }],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.audioChannels).toBe(6);
  });

  it('extracts container in lowercase', () => {
    const mediaSources = [
      {
        Container: 'MKV',
        MediaStreams: [],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.container).toBe('mkv');
  });

  it('extracts file size', () => {
    const mediaSources = [
      {
        Size: 12345678901,
        MediaStreams: [],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.fileSize).toBe(12345678901);
  });

  it('handles missing MediaSources gracefully', () => {
    const result = extractQuality(undefined);
    expect(result.videoResolution).toBeUndefined();
    expect(result.videoCodec).toBeUndefined();
    expect(result.audioCodec).toBeUndefined();
  });

  it('handles empty MediaSources array', () => {
    const result = extractQuality([]);
    expect(result.videoResolution).toBeUndefined();
    expect(result.videoCodec).toBeUndefined();
  });

  it('handles MediaStreams directly when MediaSources unavailable', () => {
    const mediaStreams = [
      { Type: 'Video', Codec: 'h264', Width: 1280, Height: 720 },
      { Type: 'Audio', Codec: 'aac', Channels: 2 },
    ];
    const result = extractQuality(undefined, mediaStreams);
    expect(result.videoResolution).toBe('720p');
    expect(result.videoCodec).toBe('H264');
    expect(result.audioCodec).toBe('AAC');
  });

  it('uses first video and audio streams found', () => {
    const mediaSources = [
      {
        MediaStreams: [
          { Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
          { Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 }, // Should be ignored
          { Type: 'Audio', Codec: 'aac', Channels: 2 },
          { Type: 'Audio', Codec: 'truehd', Channels: 8 }, // Should be ignored
        ],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.videoCodec).toBe('H264');
    expect(result.audioCodec).toBe('AAC');
    expect(result.videoResolution).toBe('1080p');
  });
});

// ============================================================================
// parseLibraryDate tests
// ============================================================================

describe('parseLibraryDate', () => {
  it('parses ISO date string', () => {
    const result = parseLibraryDate('2024-01-15T10:30:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result?.toISOString()).toBe('2024-01-15T10:30:00.000Z');
  });

  it('parses date with timezone offset', () => {
    const result = parseLibraryDate('2024-01-15T10:30:00.0000000Z');
    expect(result).toBeInstanceOf(Date);
  });

  it('returns Date instance as-is if valid', () => {
    const inputDate = new Date('2024-01-15T10:30:00Z');
    const result = parseLibraryDate(inputDate);
    expect(result).toBe(inputDate);
  });

  it('returns undefined for invalid Date instance', () => {
    const result = parseLibraryDate(new Date('invalid'));
    expect(result).toBeUndefined();
  });

  it('parses numeric timestamp', () => {
    const timestamp = Date.now();
    const result = parseLibraryDate(timestamp);
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(timestamp);
  });

  it('returns undefined for null', () => {
    expect(parseLibraryDate(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseLibraryDate(undefined)).toBeUndefined();
  });

  it('returns undefined for invalid date string', () => {
    expect(parseLibraryDate('not-a-date')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseLibraryDate('')).toBeUndefined();
  });
});

// ============================================================================
// parseLibraryItemsResponse integration tests
// ============================================================================

describe('parseLibraryItemsResponse', () => {
  it('parses complete movie item with all fields', () => {
    const input = [
      {
        Id: 'abc123',
        Name: 'Test Movie',
        Type: 'Movie',
        ProviderIds: { Imdb: 'tt1234567', Tmdb: '123456' },
        ProductionYear: 2024,
        DateCreated: '2024-01-15T10:30:00Z',
        Path: '/movies/Test Movie (2024)/Test Movie.mkv',
        MediaSources: [
          {
            Container: 'mkv',
            Size: 8000000000,
            MediaStreams: [
              { Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 },
              { Type: 'Audio', Codec: 'truehd', Channels: 8 },
            ],
          },
        ],
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.ratingKey).toBe('abc123');
    expect(item.title).toBe('Test Movie');
    expect(item.mediaType).toBe('movie');
    expect(item.year).toBe(2024);
    expect(item.imdbId).toBe('tt1234567');
    expect(item.tmdbId).toBe(123456);
    expect(item.videoResolution).toBe('4k');
    expect(item.videoCodec).toBe('HEVC');
    expect(item.audioCodec).toBe('TRUEHD');
    expect(item.audioChannels).toBe(8);
    expect(item.fileSize).toBe(8000000000);
    expect(item.container).toBe('mkv');
    expect(item.filePath).toBe('/movies/Test Movie (2024)/Test Movie.mkv');
    expect(item.addedAt).toBeInstanceOf(Date);
  });

  it('parses episode with series info', () => {
    const input = [
      {
        Id: 'ep456',
        Name: 'Episode Title',
        Type: 'Episode',
        SeriesName: 'Show Title',
        SeriesId: 'series789',
        ParentIndexNumber: 2,
        IndexNumber: 5,
        ProviderIds: { Tvdb: '789012' },
        DateCreated: '2024-02-20T15:00:00Z',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.mediaType).toBe('episode');
    expect(item.grandparentTitle).toBe('Show Title');
    expect(item.grandparentRatingKey).toBe('series789');
    expect(item.parentIndex).toBe(2);
    expect(item.itemIndex).toBe(5);
    expect(item.tvdbId).toBe(789012);
  });

  it('parses music track with artist/album info', () => {
    const input = [
      {
        Id: 'track123',
        Name: 'Song Title',
        Type: 'Audio',
        Album: 'Album Name',
        AlbumArtist: 'Artist Name',
        Artists: ['Artist Name', 'Featured Artist'],
        IndexNumber: 3,
        DateCreated: '2024-03-10T08:00:00Z',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.mediaType).toBe('track');
    expect(item.grandparentTitle).toBe('Artist Name'); // AlbumArtist preferred
    expect(item.parentTitle).toBe('Album Name');
    expect(item.itemIndex).toBe(3);
  });

  it('falls back to Artists array when no AlbumArtist', () => {
    const input = [
      {
        Id: 'track456',
        Name: 'Song Title',
        Type: 'Audio',
        Album: 'Album Name',
        Artists: ['First Artist', 'Second Artist'],
        DateCreated: '2024-03-10T08:00:00Z',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result[0]!.grandparentTitle).toBe('First Artist');
  });

  it('returns empty array for non-array input', () => {
    expect(parseLibraryItemsResponse(null as unknown as unknown[])).toEqual([]);
    expect(parseLibraryItemsResponse(undefined as unknown as unknown[])).toEqual([]);
    expect(parseLibraryItemsResponse('string' as unknown as unknown[])).toEqual([]);
    expect(parseLibraryItemsResponse({} as unknown as unknown[])).toEqual([]);
  });

  it('handles items with missing optional fields', () => {
    const input = [
      {
        Id: 'min123',
        Name: 'Minimal Item',
        Type: 'Movie',
        DateCreated: '2024-01-01T00:00:00Z',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result).toHaveLength(1);
    const item = result[0]!;
    expect(item.ratingKey).toBe('min123');
    expect(item.title).toBe('Minimal Item');
    expect(item.mediaType).toBe('movie');
    expect(item.year).toBeUndefined();
    expect(item.imdbId).toBeUndefined();
    expect(item.tmdbId).toBeUndefined();
    expect(item.tvdbId).toBeUndefined();
    expect(item.videoResolution).toBeUndefined();
    expect(item.videoCodec).toBeUndefined();
    expect(item.audioCodec).toBeUndefined();
    expect(item.filePath).toBeUndefined();
  });

  it('handles series (show) type', () => {
    const input = [
      {
        Id: 'series123',
        Name: 'My Show',
        Type: 'Series',
        ProductionYear: 2020,
        ProviderIds: { Tmdb: '555555', Tvdb: '666666' },
        DateCreated: '2024-01-01T00:00:00Z',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    const item = result[0]!;
    expect(item.mediaType).toBe('show');
    expect(item.tmdbId).toBe(555555);
    expect(item.tvdbId).toBe(666666);
  });

  it('parses multiple items', () => {
    const input = [
      { Id: '1', Name: 'Movie 1', Type: 'Movie', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '2', Name: 'Movie 2', Type: 'Movie', DateCreated: '2024-01-02T00:00:00Z' },
      { Id: '3', Name: 'Movie 3', Type: 'Movie', DateCreated: '2024-01-03T00:00:00Z' },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result).toHaveLength(3);
    expect(result[0]!.ratingKey).toBe('1');
    expect(result[1]!.ratingKey).toBe('2');
    expect(result[2]!.ratingKey).toBe('3');
  });

  it('uses current date when DateCreated is missing', () => {
    const input = [{ Id: 'nodateitem', Name: 'No Date', Type: 'Movie' }];

    const before = new Date();
    const result = parseLibraryItemsResponse(input);
    const after = new Date();

    const item = result[0]!;
    expect(item.addedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(item.addedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
