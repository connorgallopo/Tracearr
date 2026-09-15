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
  extractVersions,
  parseLibraryDate,
  parseLibraryItemsResponse,
  parseLibraryItem,
  parseItem,
} from '../jellyfinEmbyParser.js';

describe('Live TV EPG normalization contract', () => {
  it('keeps the channel identity independent from the programme title', async () => {
    const { parseSession } = await import('../../jellyfin/../jellyfin/parser.js');
    const session = parseSession({
      Id: 'session-1',
      UserId: 'user-1',
      UserName: 'viewer',
      DeviceName: 'TV',
      DeviceId: 'device-1',
      NowPlayingItem: {
        Id: 'channel-1',
        Type: 'LiveTvChannel',
        Name: 'Morning News',
        ChannelName: 'News 24',
        ChannelId: 'channel-1',
      },
      PlayState: {},
    });

    expect(session?.media.title).toBe('Morning News');
    expect(session?.mediaId).toBe('channel-1');
    expect(session?.live?.channelTitle).toBe('News 24');
    expect(session?.live?.channelIdentifier).toBeUndefined();
  });
});

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

  // Corrupted metadata tests (fixes for real-world Emby data issues)
  it('fixes duplicated TMDB ID (129536129536 -> 129536)', () => {
    const result = parseProviderIds({ Tmdb: '129536129536' });
    expect(result.tmdbId).toBe(129536);
  });

  it('fixes duplicated TVDB ID (405495405495 -> 405495)', () => {
    const result = parseProviderIds({ Tvdb: '405495405495' });
    expect(result.tvdbId).toBe(405495);
  });

  it('accepts valid IDs even if they look like duplicates (123123 is valid)', () => {
    // 123123 is within valid range, so we don't try to "fix" it
    // Only IDs exceeding POSTGRES_INT_MAX get the duplication check
    const result = parseProviderIds({ Tmdb: '123123' });
    expect(result.tmdbId).toBe(123123);
  });

  it('fixes IDs that happen to match duplicate pattern (9999999999 -> 99999)', () => {
    // 9999999999 matches the duplicate pattern (99999+99999) and gets fixed
    // This is acceptable since TMDB IDs of 9.9 billion don't exist
    const result = parseProviderIds({ Tmdb: '9999999999' });
    expect(result.tmdbId).toBe(99999);
  });

  it('rejects IDs exceeding max that are not duplicates (odd length)', () => {
    // 12345678901 (11 digits, odd) exceeds max and can't be a duplicate
    const result = parseProviderIds({ Tmdb: '12345678901' });
    expect(result.tmdbId).toBeUndefined();
  });

  it('rejects unfixable duplicated IDs that are still too large', () => {
    // Even after fixing, this would be 2200000000 which exceeds max
    const result = parseProviderIds({ Tmdb: '22000000002200000000' });
    expect(result.tmdbId).toBeUndefined();
  });

  it('rejects negative IDs', () => {
    const result = parseProviderIds({ Tmdb: '-123456' });
    expect(result.tmdbId).toBeUndefined();
  });

  it('rejects zero IDs', () => {
    const result = parseProviderIds({ Tmdb: '0' });
    expect(result.tmdbId).toBeUndefined();
  });

  it('extracts MusicBrainzTrack for a track item', () => {
    const result = parseProviderIds({ MusicBrainzTrack: 'f3e5c1a0-track' }, 'track');
    expect(result.musicBrainzId).toBe('f3e5c1a0-track');
  });

  it('extracts MusicBrainzAlbum for an album item', () => {
    const result = parseProviderIds({ MusicBrainzAlbum: 'album-mbid' }, 'album');
    expect(result.musicBrainzId).toBe('album-mbid');
  });

  it('extracts MusicBrainzArtist, falling back to MusicBrainzAlbumArtist, for an artist item', () => {
    expect(parseProviderIds({ MusicBrainzArtist: 'artist-mbid' }, 'artist').musicBrainzId).toBe(
      'artist-mbid'
    );
    expect(
      parseProviderIds({ MusicBrainzAlbumArtist: 'album-artist-mbid' }, 'artist').musicBrainzId
    ).toBe('album-artist-mbid');
  });

  it('leaves musicBrainzId undefined for a track with an untagged (empty) ProviderIds object', () => {
    expect(parseProviderIds({}, 'track').musicBrainzId).toBeUndefined();
  });

  it('does not extract a MusicBrainz field for non-music media types', () => {
    const result = parseProviderIds({ MusicBrainzTrack: 'f3e5c1a0-track' }, 'movie');
    expect(result.musicBrainzId).toBeUndefined();
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

  it('maps Photo -> photo', () => {
    expect(mapJellyfinType('Photo')).toBe('photo');
    expect(mapJellyfinType('photo')).toBe('photo');
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
  it('returns 4k for width >= 3800', () => {
    expect(getResolutionString(3840, 2160)).toBe('4k');
    expect(getResolutionString(4096, 2160)).toBe('4k');
  });

  it('returns 1440p for width >= 2500', () => {
    // Previously misclassified as 1080p because the height param was unused
    expect(getResolutionString(2560, 1440)).toBe('1440p');
  });

  it('returns 1080p for width >= 1800', () => {
    expect(getResolutionString(1920, 1080)).toBe('1080p');
  });

  it('returns 720p for width >= 1200', () => {
    expect(getResolutionString(1280, 720)).toBe('720p');
    expect(getResolutionString(1366, 768)).toBe('720p');
  });

  it('returns 480p for width >= 700', () => {
    expect(getResolutionString(720, 480)).toBe('480p');
    expect(getResolutionString(854, 480)).toBe('480p');
  });

  it('returns 480p when height alone crosses the 480p band', () => {
    // 640x480 (VGA/4:3): width is below the 480p band, but height indicates
    // full 480p source - previously misclassified as sd since height was ignored
    expect(getResolutionString(640, 480)).toBe('480p');
  });

  it('returns sd when both width and height are below every band', () => {
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

  it('extracts and normalizes dynamic range from VideoRangeType', () => {
    const mediaSources = [
      {
        MediaStreams: [{ Type: 'Video', Codec: 'hevc', VideoRangeType: 'HDR10' }],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.videoDynamicRange).toBe('hdr10');
  });

  it('normalizes Dolby Vision VideoRangeType variants to one token', () => {
    const mediaSources = [
      {
        MediaStreams: [{ Type: 'Video', Codec: 'hevc', VideoRangeType: 'DOVIWithHDR10' }],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.videoDynamicRange).toBe('dolby vision');
  });

  it('defaults dynamic range to sdr when no HDR signal is present', () => {
    const mediaSources = [
      {
        MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 }],
      },
    ];
    const result = extractQuality(mediaSources);
    expect(result.videoDynamicRange).toBe('sdr');
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

  it('builds thumbPath with a tag query when ImageTags.Primary is present', () => {
    const input = [
      {
        Id: 'jf-item-1',
        Name: 'Tagged Item',
        Type: 'Movie',
        ImageTags: { Primary: 'abc123tag' },
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result[0]!.thumbPath).toBe('/Items/jf-item-1/Images/Primary?tag=abc123tag');
  });

  it('builds thumbPath with no query string when ImageTags is absent (Emby untagged item)', () => {
    const input = [
      {
        Id: 'emby-item-1',
        Name: 'Untagged Item',
        Type: 'Movie',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result[0]!.thumbPath).toBe('/Items/emby-item-1/Images/Primary');
  });

  it('points a track thumbPath at its album so one cover caches once', () => {
    const input = [
      {
        Id: 'track-1',
        Name: 'Track One',
        Type: 'Audio',
        ImageTags: { Primary: 'pertrack1' },
        AlbumId: 'album-9',
        AlbumPrimaryImageTag: 'albumtag',
      },
      {
        Id: 'track-2',
        Name: 'Track Two',
        Type: 'Audio',
        ImageTags: { Primary: 'pertrack2' },
        AlbumId: 'album-9',
        AlbumPrimaryImageTag: 'albumtag',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result[0]!.thumbPath).toBe('/Items/album-9/Images/Primary?tag=albumtag');
    expect(result[1]!.thumbPath).toBe(result[0]!.thumbPath);
  });

  it('keeps a track on its own image when the album has no image of its own', () => {
    const input = [
      {
        Id: 'track-3',
        Name: 'Track',
        Type: 'Audio',
        ImageTags: { Primary: 'own3' },
        AlbumId: 'album-9',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result[0]!.thumbPath).toBe('/Items/track-3/Images/Primary?tag=own3');
  });

  it('keeps a track on its own image when it reports no album', () => {
    const input = [{ Id: 'track-4', Name: 'Track', Type: 'Audio', ImageTags: { Primary: 'own' } }];

    const result = parseLibraryItemsResponse(input);

    expect(result[0]!.thumbPath).toBe('/Items/track-4/Images/Primary?tag=own');
  });

  it('leaves an episode on its own image', () => {
    const input = [
      {
        Id: 'ep-1',
        Name: 'Episode',
        Type: 'Episode',
        ImageTags: { Primary: 'eptag' },
        AlbumId: 'should-be-ignored',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result[0]!.thumbPath).toBe('/Items/ep-1/Images/Primary?tag=eptag');
  });

  it('parses Genres array into genres', () => {
    const input = [
      {
        Id: '1',
        Name: 'X',
        Type: 'Movie',
        Genres: ['Action', 'Crime'],
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result[0]!.genres).toEqual(['Action', 'Crime']);
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
        AlbumArtists: [{ Name: 'Artist Name', Id: 'artist789' }],
        AlbumId: 'album456',
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
    expect(item.grandparentRatingKey).toBe('artist789'); // links to MusicArtist
    expect(item.parentTitle).toBe('Album Name');
    expect(item.parentRatingKey).toBe('album456'); // links to MusicAlbum
    expect(item.itemIndex).toBe(3);
  });

  it('extracts musicBrainzId for a track from ProviderIds.MusicBrainzTrack', () => {
    const input = [
      {
        Id: 'track-mbid',
        Name: 'Song Title',
        Type: 'Audio',
        ProviderIds: { MusicBrainzTrack: 'f3e5c1a0-track' },
        DateCreated: '2024-03-10T08:00:00Z',
      },
    ];

    const [item] = parseLibraryItemsResponse(input);

    expect(item!.musicBrainzId).toBe('f3e5c1a0-track');
  });

  // MusicAlbum items aren't in ALLOWED_LIBRARY_ITEM_TYPES so never reach parseLibraryItemsResponse
  // in production; parseLibraryItem itself is tested directly here.
  it('parses an album item, carrying its own parent artist as parentTitle/parentRatingKey', () => {
    const item = parseLibraryItem({
      Id: 'album456',
      Name: 'Album Name',
      Type: 'MusicAlbum',
      AlbumArtist: 'Artist Name',
      AlbumArtists: [{ Name: 'Artist Name', Id: 'artist789' }],
      ProviderIds: { MusicBrainzAlbum: 'album-mbid' },
      DateCreated: '2024-03-10T08:00:00Z',
    });

    expect(item.mediaType).toBe('album');
    expect(item.parentTitle).toBe('Artist Name');
    expect(item.parentRatingKey).toBe('artist789');
    expect(item.musicBrainzId).toBe('album-mbid');
  });

  it('uses AlbumArtists ID for grandparentRatingKey on compilation albums', () => {
    const input = [
      {
        Id: 'track-compilation',
        Name: 'Where Are U Now',
        Type: 'Audio',
        Album: 'Purpose',
        AlbumArtist: 'Justin Bieber',
        AlbumArtists: [{ Name: 'Justin Bieber', Id: 'artist-bieber' }],
        AlbumId: 'album-purpose',
        Artists: ['Skrillex'],
        ArtistItems: [{ Name: 'Skrillex', Id: 'artist-skrillex' }],
        DateCreated: '2024-03-10T08:00:00Z',
      },
    ];

    const result = parseLibraryItemsResponse(input);
    const item = result[0]!;

    expect(item.grandparentRatingKey).toBe('artist-bieber');
    expect(item.parentRatingKey).toBe('album-purpose');
    expect(item.grandparentTitle).toBe('Justin Bieber');
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

  it('uses cutoff date (2015-01-01) when DateCreated is missing', () => {
    // When DateCreated is missing and year < 2015, fallback to Jan 1, 2015
    // This clusters legacy items at the cutoff rather than polluting current date stats
    const input = [{ Id: 'nodateitem', Name: 'No Date', Type: 'Movie' }];

    const result = parseLibraryItemsResponse(input);

    const item = result[0]!;
    const expectedFallback = new Date(Date.UTC(2015, 0, 1));
    expect(item.addedAt.getTime()).toBe(expectedFallback.getTime());
  });

  it('filters out non-media types using allowlist', () => {
    const input = [
      { Id: '1', Name: 'Actual Movie', Type: 'Movie', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '2', Name: 'Marvel Collection', Type: 'BoxSet', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '3', Name: 'Movie Folder', Type: 'Folder', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '4', Name: 'Action', Type: 'Genre', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '5', Name: 'Tom Hanks', Type: 'Person', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '6', Name: 'Warner Bros', Type: 'Studio', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '7', Name: 'Summer', Type: 'Tag', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '8', Name: 'My Playlist', Type: 'Playlist', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '9', Name: 'Actual Show', Type: 'Series', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '10', Name: 'Season 1', Type: 'Season', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '11', Name: 'Episode 1', Type: 'Episode', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '12', Name: 'Actual Track', Type: 'Audio', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '13', Name: 'Rock', Type: 'MusicGenre', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '14', Name: 'The Beatles', Type: 'MusicArtist', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '15', Name: 'Abbey Road', Type: 'MusicAlbum', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '16', Name: 'User Root', Type: 'UserRootFolder', DateCreated: '2024-01-01T00:00:00Z' },
      { Id: '17', Name: 'User View', Type: 'UserView', DateCreated: '2024-01-01T00:00:00Z' },
      {
        Id: '18',
        Name: 'Collections',
        Type: 'CollectionFolder',
        DateCreated: '2024-01-01T00:00:00Z',
      },
      { Id: '19', Name: 'Aggregate', Type: 'AggregateFolder', DateCreated: '2024-01-01T00:00:00Z' },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result).toHaveLength(6);
    expect(result.map((r) => r.ratingKey)).toEqual(['1', '9', '10', '11', '12', '14']);
    expect(result.map((r) => r.mediaType)).toEqual([
      'movie',
      'show',
      'season',
      'episode',
      'track',
      'artist',
    ]);
  });

  it('excludes extras (trailers, behind-the-scenes) that share Type with primary content', () => {
    const input = [
      { Id: '1', Name: 'Anatomy of a Fall', Type: 'Movie', DateCreated: '2024-01-01T00:00:00Z' },
      {
        Id: '2',
        Name: 'Anatomy of a Fall - Trailer 2',
        Type: 'Movie',
        ExtraType: 'Trailer',
        DateCreated: '2024-01-01T00:00:00Z',
      },
      {
        Id: '3',
        Name: 'The Devil Wears Prada - Behind the Scenes',
        Type: 'Video',
        ExtraType: 'BehindTheScenes',
        DateCreated: '2024-01-01T00:00:00Z',
      },
      {
        Id: '4',
        Name: 'The Devil Wears Prada',
        Type: 'Movie',
        DateCreated: '2024-01-01T00:00:00Z',
      },
    ];

    const result = parseLibraryItemsResponse(input);

    expect(result.map((r) => r.ratingKey)).toEqual(['1', '4']);
    expect(result.map((r) => r.title)).toEqual(['Anatomy of a Fall', 'The Devil Wears Prada']);
  });
});

describe('parseItem', () => {
  it('extracts Type and ExtraType from item', () => {
    const result = parseItem({
      Id: 'abc123',
      Type: 'Audio',
      ExtraType: 'ThemeSong',
    });

    expect(result.Id).toBe('abc123');
    expect(result.Type).toBe('Audio');
    expect(result.ExtraType).toBe('ThemeSong');
  });

  it('returns undefined for missing Type and ExtraType', () => {
    const result = parseItem({
      Id: 'abc123',
    });

    expect(result.Id).toBe('abc123');
    expect(result.Type).toBeUndefined();
    expect(result.ExtraType).toBeUndefined();
  });

  it('extracts all standard fields alongside Type/ExtraType', () => {
    const result = parseItem({
      Id: 'movie-1',
      Type: 'Movie',
      ParentIndexNumber: 1,
      IndexNumber: 5,
      ProductionYear: 2024,
      ImageTags: { Primary: 'tag123' },
      SeriesId: 'series-1',
      SeriesPrimaryImageTag: 'seriestag',
      Album: 'My Album',
      AlbumArtist: 'Artist Name',
      Artists: ['Artist Name'],
      AlbumId: 'album-1',
      AlbumPrimaryImageTag: 'albumtag',
    });

    expect(result.Type).toBe('Movie');
    expect(result.ExtraType).toBeUndefined();
    expect(result.ParentIndexNumber).toBe(1);
    expect(result.IndexNumber).toBe(5);
    expect(result.ProductionYear).toBe(2024);
    expect(result.SeriesId).toBe('series-1');
    expect(result.Album).toBe('My Album');
    expect(result.AlbumArtist).toBe('Artist Name');
  });
});

describe('extractVersions', () => {
  const twoSources = [
    {
      Id: 'src-a',
      Size: 14316046820,
      Container: 'MKV',
      Bitrate: 15512000,
      Path: '/data/a.mkv',
      MediaStreams: [
        { Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 },
        { Type: 'Audio', Codec: 'eac3', Channels: 6 },
      ],
    },
    {
      Id: 'src-b',
      Size: 4100000000,
      Container: 'mp4',
      Bitrate: 10000000,
      MediaStreams: [
        { Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 },
        { Type: 'Audio', Codec: 'aac', Channels: 2 },
      ],
    },
  ];

  it('keeps each MediaSource paired with its own streams', () => {
    const versions = extractVersions(twoSources, undefined, 'item-1');

    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      serverVersionKey: 'src-a',
      videoCodec: 'HEVC',
      videoResolution: '4k',
      audioCodec: 'EAC3',
      audioChannels: 6,
      container: 'mkv',
      fileSize: 14316046820,
      bitrate: 15512,
      filePath: '/data/a.mkv',
    });
    expect(versions[1]).toMatchObject({
      serverVersionKey: 'src-b',
      videoCodec: 'H264',
      videoResolution: '1080p',
      audioCodec: 'AAC',
      fileSize: 4100000000,
      bitrate: 10000,
    });
  });

  it('synthesizes one version from item-level MediaStreams when MediaSources are absent', () => {
    const versions = extractVersions(
      undefined,
      [{ Type: 'Video', Codec: 'hevc', Width: 1920, Height: 1080 }],
      'item-9'
    );

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ serverVersionKey: 'item-9', videoCodec: 'HEVC' });
  });

  it('returns empty for containers with no sources or streams', () => {
    expect(extractVersions(undefined, undefined, 'series-1')).toEqual([]);
    expect(extractVersions([], [], 'series-1')).toEqual([]);
  });
});

describe('parseLibraryItem multi-version', () => {
  it('sums file size and rolls quality up from the best version', () => {
    const item = parseLibraryItem({
      Id: 'merged-1',
      Name: 'Guy Ritchies The Covenant',
      Type: 'Movie',
      ProductionYear: 2023,
      MediaSources: twoSourcesFixture(),
    });

    expect(item.versions).toHaveLength(2);
    expect(item.fileSize).toBe(14316046820 + 4100000000);
    expect(item.videoResolution).toBe('4k');
    expect(item.videoCodec).toBe('HEVC');
    expect(item.versionsFingerprint).toBeTruthy();
  });

  it('fingerprint is stable across MediaSource order', () => {
    const forward = parseLibraryItem({
      Id: 'merged-1',
      Name: 'Test',
      Type: 'Movie',
      MediaSources: twoSourcesFixture(),
    });
    const reversed = parseLibraryItem({
      Id: 'merged-1',
      Name: 'Test',
      Type: 'Movie',
      MediaSources: twoSourcesFixture().reverse(),
    });

    expect(forward.versionsFingerprint).toBe(reversed.versionsFingerprint);
  });
});

function twoSourcesFixture() {
  return [
    {
      Id: 'src-a',
      Size: 14316046820,
      Container: 'mkv',
      MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160 }],
    },
    {
      Id: 'src-b',
      Size: 4100000000,
      Container: 'mp4',
      MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080 }],
    },
  ];
}
