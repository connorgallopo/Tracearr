/**
 * Jellyfin Parser Tests
 *
 * Tests the pure parsing functions that convert raw Jellyfin API responses
 * into typed MediaSession, MediaUser, and MediaLibrary objects.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSession,
  parseSessionsResponse,
  parseUser,
  parseUsersResponse,
  parseLibrary,
  parseLibrariesResponse,
  parseWatchHistoryItem,
  parseWatchHistoryResponse,
  parseActivityLogItem,
  parseActivityLogResponse,
  parseAuthResponse,
} from '../jellyfin/parser.js';

// ============================================================================
// Session Parsing Tests
// ============================================================================

describe('Jellyfin Session Parser', () => {
  describe('parseSession', () => {
    it('should parse a movie session', () => {
      const rawSession = {
        Id: 'session-123',
        UserId: 'user-456',
        UserName: 'John',
        UserPrimaryImageTag: 'avatar-tag',
        DeviceName: "John's TV",
        DeviceId: 'device-uuid-789',
        Client: 'Jellyfin Web',
        DeviceType: 'TV',
        RemoteEndPoint: '203.0.113.50',
        NowPlayingItem: {
          Id: 'item-abc',
          Name: 'Inception',
          Type: 'Movie',
          RunTimeTicks: 90000000000, // 150 minutes in ticks (10000 ticks/ms)
          ProductionYear: 2010,
          ImageTags: { Primary: 'poster-tag' },
        },
        PlayState: {
          PositionTicks: 36000000000, // 60 minutes
          IsPaused: false,
        },
        TranscodingInfo: {
          IsVideoDirect: true,
          Bitrate: 20000000,
        },
      };

      const session = parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.sessionKey).toBe('session-123');
      expect(session!.mediaId).toBe('item-abc');
      expect(session!.user.id).toBe('user-456');
      expect(session!.user.username).toBe('John');
      expect(session!.media.title).toBe('Inception');
      expect(session!.media.type).toBe('movie');
      expect(session!.media.durationMs).toBe(9000000); // 150 minutes in ms
      expect(session!.media.year).toBe(2010);
      expect(session!.playback.state).toBe('playing');
      expect(session!.playback.positionMs).toBe(3600000); // 60 minutes in ms
      expect(session!.playback.progressPercent).toBe(40);
      expect(session!.player.name).toBe("John's TV");
      expect(session!.player.deviceId).toBe('device-uuid-789');
      expect(session!.network.ipAddress).toBe('203.0.113.50');
      expect(session!.quality.isTranscode).toBe(false);
    });

    it('should parse an episode session with show metadata', () => {
      const rawSession = {
        Id: 'session-ep',
        UserId: 'user-1',
        UserName: 'Jane',
        DeviceName: 'iPhone',
        DeviceId: 'iphone-123',
        Client: 'Jellyfin iOS',
        RemoteEndPoint: '192.168.1.100',
        NowPlayingItem: {
          Id: 'episode-id',
          Name: 'Pilot',
          Type: 'Episode',
          RunTimeTicks: 36000000000, // 60 minutes
          SeriesName: 'Breaking Bad',
          SeriesId: 'series-bb',
          ParentIndexNumber: 1,
          IndexNumber: 1,
          SeasonName: 'Season 1',
          SeriesPrimaryImageTag: 'series-poster-tag',
        },
        PlayState: {
          PositionTicks: 18000000000, // 30 minutes
          IsPaused: true,
        },
        TranscodingInfo: {
          IsVideoDirect: false,
          Bitrate: 5000000,
        },
      };

      const session = parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.media.type).toBe('episode');
      expect(session!.playback.state).toBe('paused');
      expect(session!.playback.progressPercent).toBe(50);
      expect(session!.quality.isTranscode).toBe(true);
      expect(session!.episode).toBeDefined();
      expect(session!.episode?.showTitle).toBe('Breaking Bad');
      expect(session!.episode?.showId).toBe('series-bb');
      expect(session!.episode?.seasonNumber).toBe(1);
      expect(session!.episode?.episodeNumber).toBe(1);
      expect(session!.episode?.seasonName).toBe('Season 1');
    });

    it('should return null for session without NowPlayingItem', () => {
      const rawSession = {
        Id: 'session-idle',
        UserId: 'user-1',
        UserName: 'John',
        // No NowPlayingItem - user is idle
      };

      const session = parseSession(rawSession);
      expect(session).toBeNull();
    });

    it('should handle missing optional fields gracefully', () => {
      const rawSession = {
        Id: 'minimal',
        NowPlayingItem: {
          Id: 'item-1',
          Name: 'Test',
          Type: 'Movie',
        },
      };

      const session = parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.user.id).toBe('');
      expect(session!.user.thumb).toBeUndefined();
      expect(session!.media.durationMs).toBe(0);
      expect(session!.playback.positionMs).toBe(0);
    });

    it('should get bitrate from MediaSources when no transcoding', () => {
      const rawSession = {
        Id: 'session-direct',
        NowPlayingItem: {
          Id: 'item-1',
          Name: 'Movie',
          Type: 'Movie',
          MediaSources: [{ Bitrate: 30000000 }], // 30000000 bps = 30000 kbps
        },
        PlayState: {},
      };

      const session = parseSession(rawSession);
      // Parser normalizes Jellyfin bps to kbps for consistency with Plex
      expect(session!.quality.bitrate).toBe(30000);
    });
  });

  describe('parseSessionsResponse', () => {
    it('should filter sessions to only those with active playback', () => {
      const sessions = [
        {
          Id: '1',
          UserId: 'u1',
          NowPlayingItem: { Id: 'i1', Name: 'Playing', Type: 'Movie' },
        },
        {
          Id: '2',
          UserId: 'u2',
          // No NowPlayingItem - idle session
        },
        {
          Id: '3',
          UserId: 'u3',
          NowPlayingItem: { Id: 'i3', Name: 'Also Playing', Type: 'Episode' },
        },
      ];

      const parsed = parseSessionsResponse(sessions);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]!.sessionKey).toBe('1');
      expect(parsed[1]!.sessionKey).toBe('3');
    });

    it('should return empty array for non-array input', () => {
      expect(parseSessionsResponse(null as unknown as unknown[])).toEqual([]);
      expect(parseSessionsResponse('not an array' as unknown as unknown[])).toEqual([]);
    });
  });
});

// ============================================================================
// User Parsing Tests
// ============================================================================

describe('Jellyfin User Parser', () => {
  describe('parseUser', () => {
    it('should parse user with admin policy', () => {
      const rawUser = {
        Id: 'admin-123',
        Name: 'Administrator',
        PrimaryImageTag: 'avatar-tag',
        HasPassword: true,
        Policy: {
          IsAdministrator: true,
          IsDisabled: false,
        },
        LastLoginDate: '2024-01-15T10:30:00.000Z',
        LastActivityDate: '2024-01-15T12:45:00.000Z',
      };

      const user = parseUser(rawUser);

      expect(user.id).toBe('admin-123');
      expect(user.username).toBe('Administrator');
      // thumb is now a full path, not just the image tag
      expect(user.thumb).toBe('/Users/admin-123/Images/Primary');
      expect(user.isAdmin).toBe(true);
      expect(user.isDisabled).toBe(false);
      expect(user.lastLoginAt).toEqual(new Date('2024-01-15T10:30:00.000Z'));
      expect(user.lastActivityAt).toEqual(new Date('2024-01-15T12:45:00.000Z'));
    });

    it('should parse regular user', () => {
      const rawUser = {
        Id: 'user-456',
        Name: 'Regular User',
        HasPassword: false,
        Policy: {
          IsAdministrator: false,
          IsDisabled: false,
        },
      };

      const user = parseUser(rawUser);

      expect(user.isAdmin).toBe(false);
      expect(user.lastLoginAt).toBeUndefined();
    });

    it('should parse disabled user', () => {
      const rawUser = {
        Id: 'disabled-user',
        Name: 'Disabled',
        Policy: {
          IsAdministrator: false,
          IsDisabled: true,
        },
      };

      const user = parseUser(rawUser);

      expect(user.isDisabled).toBe(true);
    });

    it('should handle missing Policy object', () => {
      const rawUser = {
        Id: 'no-policy',
        Name: 'Guest',
      };

      const user = parseUser(rawUser);

      expect(user.isAdmin).toBe(false);
      expect(user.isDisabled).toBe(false);
    });
  });

  describe('parseUsersResponse', () => {
    it('should parse array of users', () => {
      const users = [
        { Id: '1', Name: 'User1', Policy: { IsAdministrator: true } },
        { Id: '2', Name: 'User2', Policy: { IsAdministrator: false } },
      ];

      const parsed = parseUsersResponse(users);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]!.isAdmin).toBe(true);
      expect(parsed[1]!.isAdmin).toBe(false);
    });

    it('should return empty array for non-array input', () => {
      expect(parseUsersResponse(null as unknown as unknown[])).toEqual([]);
    });
  });
});

// ============================================================================
// Library Parsing Tests
// ============================================================================

describe('Jellyfin Library Parser', () => {
  describe('parseLibrary', () => {
    it('should parse virtual folder', () => {
      const rawFolder = {
        ItemId: 'lib-123',
        Name: 'Movies',
        CollectionType: 'movies',
        Locations: ['/media/movies', '/media/movies2'],
      };

      const library = parseLibrary(rawFolder);

      expect(library.id).toBe('lib-123');
      expect(library.name).toBe('Movies');
      expect(library.type).toBe('movies');
      expect(library.locations).toEqual(['/media/movies', '/media/movies2']);
    });

    it('should handle missing CollectionType', () => {
      const rawFolder = {
        ItemId: 'lib-456',
        Name: 'Mixed Content',
      };

      const library = parseLibrary(rawFolder);

      expect(library.type).toBe('unknown');
      expect(library.locations).toEqual([]);
    });
  });

  describe('parseLibrariesResponse', () => {
    it('should parse array of folders', () => {
      const folders = [
        { ItemId: '1', Name: 'Movies', CollectionType: 'movies' },
        { ItemId: '2', Name: 'TV Shows', CollectionType: 'tvshows' },
      ];

      const libraries = parseLibrariesResponse(folders);

      expect(libraries).toHaveLength(2);
      expect(libraries[0]!.name).toBe('Movies');
      expect(libraries[1]!.name).toBe('TV Shows');
    });
  });
});

// ============================================================================
// Watch History Parsing Tests
// ============================================================================

describe('Jellyfin Watch History Parser', () => {
  describe('parseWatchHistoryItem', () => {
    it('should parse movie history item', () => {
      const rawItem = {
        Id: 'movie-123',
        Name: 'The Matrix',
        Type: 'Movie',
        ProductionYear: 1999,
        RunTimeTicks: 81600000000,
        UserData: {
          PlayCount: 3,
          LastPlayedDate: '2024-01-10T20:00:00.000Z',
        },
      };

      const item = parseWatchHistoryItem(rawItem);

      expect(item.mediaId).toBe('movie-123');
      expect(item.title).toBe('The Matrix');
      expect(item.type).toBe('movie');
      expect(item.playCount).toBe(3);
      expect(item.watchedAt).toBe('2024-01-10T20:00:00.000Z');
      expect(item.episode).toBeUndefined();
    });

    it('should parse episode history with show metadata', () => {
      const rawItem = {
        Id: 'ep-456',
        Name: 'Pilot',
        Type: 'Episode',
        SeriesName: 'Lost',
        ParentIndexNumber: 1,
        IndexNumber: 1,
        UserData: {
          PlayCount: 1,
          LastPlayedDate: '2024-01-12T21:00:00.000Z',
        },
      };

      const item = parseWatchHistoryItem(rawItem);

      expect(item.type).toBe('episode');
      expect(item.episode).toBeDefined();
      expect(item.episode?.showTitle).toBe('Lost');
      expect(item.episode?.seasonNumber).toBe(1);
      expect(item.episode?.episodeNumber).toBe(1);
    });
  });

  describe('parseWatchHistoryResponse', () => {
    it('should parse Items from response', () => {
      const response = {
        Items: [
          { Id: '1', Name: 'Item 1', Type: 'Movie', UserData: { PlayCount: 1 } },
          { Id: '2', Name: 'Item 2', Type: 'Episode', SeriesName: 'Show' },
        ],
      };

      const items = parseWatchHistoryResponse(response);

      expect(items).toHaveLength(2);
      expect(items[1]!.episode?.showTitle).toBe('Show');
    });

    it('should return empty array for missing Items', () => {
      expect(parseWatchHistoryResponse({})).toEqual([]);
      expect(parseWatchHistoryResponse(null)).toEqual([]);
    });
  });
});

// ============================================================================
// Activity Log Parsing Tests
// ============================================================================

describe('Jellyfin Activity Log Parser', () => {
  describe('parseActivityLogItem', () => {
    it('should parse activity entry', () => {
      const rawEntry = {
        Id: 12345,
        Name: 'John authenticated successfully',
        Overview: 'User John logged in from 192.168.1.100',
        ShortOverview: 'Login successful',
        Type: 'AuthenticationSucceeded',
        UserId: 'user-123',
        Date: '2024-01-15T10:30:00.000Z',
        Severity: 'Information',
      };

      const entry = parseActivityLogItem(rawEntry);

      expect(entry.id).toBe(12345);
      expect(entry.name).toBe('John authenticated successfully');
      expect(entry.type).toBe('AuthenticationSucceeded');
      expect(entry.userId).toBe('user-123');
      expect(entry.severity).toBe('Information');
    });

    it('should handle playback activity', () => {
      const rawEntry = {
        Id: 67890,
        Name: 'User started playing Movie',
        Type: 'VideoPlayback',
        ItemId: 'item-abc',
        UserId: 'user-456',
        Date: '2024-01-15T20:00:00.000Z',
        Severity: 'Information',
      };

      const entry = parseActivityLogItem(rawEntry);

      expect(entry.type).toBe('VideoPlayback');
      expect(entry.itemId).toBe('item-abc');
    });
  });

  describe('parseActivityLogResponse', () => {
    it('should parse Items array', () => {
      const response = {
        Items: [
          { Id: 1, Name: 'Entry 1', Type: 'Login', Date: '2024-01-15' },
          { Id: 2, Name: 'Entry 2', Type: 'Playback', Date: '2024-01-16' },
        ],
      };

      const entries = parseActivityLogResponse(response);

      expect(entries).toHaveLength(2);
    });
  });
});

// ============================================================================
// Authentication Response Parsing Tests
// ============================================================================

describe('Jellyfin Auth Response Parser', () => {
  describe('parseAuthResponse', () => {
    it('should parse successful auth response', () => {
      const rawResponse = {
        User: {
          Id: 'user-123',
          Name: 'Admin',
          ServerId: 'server-456',
          Policy: {
            IsAdministrator: true,
          },
        },
        AccessToken: 'jwt-token-abc',
        ServerId: 'server-456',
      };

      const result = parseAuthResponse(rawResponse);

      expect(result.id).toBe('user-123');
      expect(result.username).toBe('Admin');
      expect(result.token).toBe('jwt-token-abc');
      expect(result.serverId).toBe('server-456');
      expect(result.isAdmin).toBe(true);
    });

    it('should handle non-admin user', () => {
      const rawResponse = {
        User: {
          Id: 'user-789',
          Name: 'Regular',
          Policy: {
            IsAdministrator: false,
          },
        },
        AccessToken: 'token-xyz',
        ServerId: 'server-123',
      };

      const result = parseAuthResponse(rawResponse);

      expect(result.isAdmin).toBe(false);
    });

    it('should handle missing Policy', () => {
      const rawResponse = {
        User: {
          Id: 'guest',
          Name: 'Guest',
        },
        AccessToken: 'guest-token',
        ServerId: 'server',
      };

      const result = parseAuthResponse(rawResponse);

      expect(result.isAdmin).toBe(false);
    });
  });
});

// ============================================================================
// New Features: PlayMethod, LastPausedDate, Trailer Filtering
// ============================================================================

describe('Jellyfin Parser - PlayMethod and Transcode Detection', () => {
  it('should use PlayMethod from PlayState for transcode detection', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        PlayMethod: 'Transcode',
        IsPaused: false,
      },
    });

    expect(session!.quality.isTranscode).toBe(true);
    expect(session!.quality.videoDecision).toBe('transcode');
  });

  it('should detect DirectPlay from PlayMethod', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        PlayMethod: 'DirectPlay',
        IsPaused: false,
      },
    });

    expect(session!.quality.isTranscode).toBe(false);
    expect(session!.quality.videoDecision).toBe('directplay');
  });

  it('should detect DirectStream from PlayMethod', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        PlayMethod: 'DirectStream',
        IsPaused: false,
      },
    });

    expect(session!.quality.isTranscode).toBe(false);
    // DirectStream is normalized to 'copy' (video/audio streams copied, container may change)
    expect(session!.quality.videoDecision).toBe('copy');
  });

  it('should normalize PlayMethod to lowercase', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        PlayMethod: 'DirectPlay', // PascalCase from API
        IsPaused: false,
      },
    });

    // Should be normalized to lowercase for consistency with Plex
    expect(session!.quality.videoDecision).toBe('directplay');
  });

  it('should fall back to TranscodingInfo when PlayMethod not available', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        // No PlayMethod
        IsPaused: false,
      },
      TranscodingInfo: {
        IsVideoDirect: false,
      },
    });

    expect(session!.quality.isTranscode).toBe(true);
    expect(session!.quality.videoDecision).toBe('transcode');
  });
});

describe('Jellyfin Parser - LastPausedDate', () => {
  it('should parse LastPausedDate when session is paused', () => {
    const pauseTime = '2024-01-15T10:30:00.000Z';
    const session = parseSession({
      Id: 'session-1',
      LastPausedDate: pauseTime,
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        IsPaused: true,
      },
    });

    expect(session!.lastPausedDate).toEqual(new Date(pauseTime));
    expect(session!.playback.state).toBe('paused');
  });

  it('should not have lastPausedDate when playing', () => {
    const session = parseSession({
      Id: 'session-1',
      // No LastPausedDate when playing
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        IsPaused: false,
      },
    });

    expect(session!.lastPausedDate).toBeUndefined();
    expect(session!.playback.state).toBe('playing');
  });

  it('should handle null LastPausedDate', () => {
    const session = parseSession({
      Id: 'session-1',
      LastPausedDate: null,
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: { IsPaused: false },
    });

    expect(session!.lastPausedDate).toBeUndefined();
  });
});

describe('Jellyfin Parser - Trailer and Preroll Filtering', () => {
  it('should filter out Trailer sessions', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: {
        Id: 'trailer-1',
        Name: 'Movie Trailer',
        Type: 'Trailer',
      },
    });

    expect(session).toBeNull();
  });

  it('should filter out preroll videos', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: {
        Id: 'preroll-1',
        Name: 'Preroll Video',
        Type: 'Video',
        ProviderIds: {
          'prerolls.video': 'some-id',
        },
      },
    });

    expect(session).toBeNull();
  });

  it('should NOT filter regular movies', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: {
        Id: 'movie-1',
        Name: 'Regular Movie',
        Type: 'Movie',
        ProviderIds: {
          Imdb: 'tt1234567',
        },
      },
    });

    expect(session).not.toBeNull();
    expect(session!.media.title).toBe('Regular Movie');
  });

  it('should NOT filter episodes', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: {
        Id: 'ep-1',
        Name: 'Episode 1',
        Type: 'Episode',
        SeriesName: 'Test Show',
      },
    });

    expect(session).not.toBeNull();
  });

  it('should filter trailer sessions from parseSessionsResponse', () => {
    const sessions = [
      {
        Id: '1',
        NowPlayingItem: { Id: 'movie-1', Name: 'Movie', Type: 'Movie' },
      },
      {
        Id: '2',
        NowPlayingItem: { Id: 'trailer-1', Name: 'Trailer', Type: 'Trailer' },
      },
      {
        Id: '3',
        NowPlayingItem: { Id: 'ep-1', Name: 'Episode', Type: 'Episode' },
      },
    ];

    const parsed = parseSessionsResponse(sessions);

    // Should only have movie and episode, trailer filtered out
    expect(parsed).toHaveLength(2);
    expect(parsed.map((s) => s.sessionKey)).toEqual(['1', '3']);
  });
});

// ============================================================================
// Edge Cases and Type Handling
// ============================================================================

describe('Jellyfin Parser Edge Cases', () => {
  it('should handle media type conversion', () => {
    const makeSession = (type: string) => ({
      NowPlayingItem: { Id: '1', Name: 'Test', Type: type },
    });

    expect(parseSession(makeSession('Movie'))!.media.type).toBe('movie');
    expect(parseSession(makeSession('Episode'))!.media.type).toBe('episode');
    expect(parseSession(makeSession('Audio'))!.media.type).toBe('track');
    expect(parseSession(makeSession('Photo'))!.media.type).toBe('photo');
    expect(parseSession(makeSession('Unknown'))!.media.type).toBe('unknown');
  });

  it('should convert ticks to milliseconds correctly', () => {
    // 1 hour = 3600000 ms = 36000000000 ticks
    const session = parseSession({
      NowPlayingItem: {
        Id: '1',
        Name: 'Test',
        Type: 'Movie',
        RunTimeTicks: 36000000000,
      },
      PlayState: {
        PositionTicks: 18000000000, // 30 minutes
      },
    });

    expect(session!.media.durationMs).toBe(3600000);
    expect(session!.playback.positionMs).toBe(1800000);
    expect(session!.playback.progressPercent).toBe(50);
  });

  it('should handle zero duration gracefully', () => {
    const session = parseSession({
      NowPlayingItem: {
        Id: '1',
        Name: 'Test',
        Type: 'Movie',
        RunTimeTicks: 0,
      },
      PlayState: {
        PositionTicks: 1000000,
      },
    });

    expect(session!.playback.progressPercent).toBe(0);
  });
});
