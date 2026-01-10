/**
 * Shared Test Factories for Jellyfin/Emby Parser Tests
 *
 * Contains parameterized test suites that run identical tests against
 * both Jellyfin and Emby parsers, reducing ~400 lines of duplication.
 *
 * Platform-specific tests remain in their respective test files.
 */

import { describe, it, expect } from 'vitest';
import type { MediaSession, MediaUser, MediaLibrary, MediaWatchHistoryItem } from '../../types.js';
import type {
  JellyfinEmbyActivityEntry,
  JellyfinEmbyAuthResult,
} from '../../shared/baseMediaServerClient.js';

// ============================================================================
// Types for Parser Functions
// ============================================================================

export interface ParserFunctions {
  parseSession: (raw: Record<string, unknown>) => MediaSession | null;
  parseSessionsResponse: (sessions: unknown[]) => MediaSession[];
  parseUser: (raw: Record<string, unknown>) => MediaUser;
  parseUsersResponse: (users: unknown[]) => MediaUser[];
  parseLibrary: (raw: Record<string, unknown>) => MediaLibrary;
  parseLibrariesResponse: (folders: unknown[]) => MediaLibrary[];
  parseWatchHistoryItem: (raw: Record<string, unknown>) => MediaWatchHistoryItem;
  parseWatchHistoryResponse: (data: unknown) => MediaWatchHistoryItem[];
  parseActivityLogItem: (raw: Record<string, unknown>) => JellyfinEmbyActivityEntry;
  parseActivityLogResponse: (data: unknown) => JellyfinEmbyActivityEntry[];
  parseAuthResponse: (raw: Record<string, unknown>) => JellyfinEmbyAuthResult;
}

// ============================================================================
// Session Parsing Tests
// ============================================================================

export function createSessionParsingTests(
  parsers: ParserFunctions,
  serverType: 'jellyfin' | 'emby'
) {
  const clientName = serverType === 'jellyfin' ? 'Jellyfin Web' : 'Emby Web';

  describe(`${serverType} Session Parser`, () => {
    describe('parseSession', () => {
      it('should parse a movie session', () => {
        const rawSession = {
          Id: 'session-123',
          UserId: 'user-456',
          UserName: 'John',
          UserPrimaryImageTag: 'avatar-tag',
          DeviceName: "John's TV",
          DeviceId: 'device-uuid-789',
          Client: clientName,
          DeviceType: 'TV',
          RemoteEndPoint: '203.0.113.50',
          NowPlayingItem: {
            Id: 'item-abc',
            Name: 'Inception',
            Type: 'Movie',
            RunTimeTicks: 90000000000,
            ProductionYear: 2010,
            ImageTags: { Primary: 'poster-tag' },
          },
          PlayState: {
            PositionTicks: 36000000000,
            IsPaused: false,
            PlayMethod: 'DirectPlay',
          },
          TranscodingInfo: {
            Bitrate: 20000000,
          },
        };

        const session = parsers.parseSession(rawSession);

        expect(session).not.toBeNull();
        expect(session!.sessionKey).toBe('session-123');
        expect(session!.mediaId).toBe('item-abc');
        expect(session!.user.id).toBe('user-456');
        expect(session!.user.username).toBe('John');
        expect(session!.media.title).toBe('Inception');
        expect(session!.media.type).toBe('movie');
        expect(session!.media.durationMs).toBe(9000000);
        expect(session!.media.year).toBe(2010);
        expect(session!.playback.state).toBe('playing');
        expect(session!.playback.positionMs).toBe(3600000);
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
          Client: `${serverType === 'jellyfin' ? 'Jellyfin' : 'Emby'} iOS`,
          RemoteEndPoint: '192.168.1.100',
          NowPlayingItem: {
            Id: 'episode-id',
            Name: 'Pilot',
            Type: 'Episode',
            RunTimeTicks: 36000000000,
            SeriesName: 'Breaking Bad',
            SeriesId: 'series-bb',
            SeriesPrimaryImageTag: 'series-poster-tag',
            ParentIndexNumber: 1,
            IndexNumber: 1,
            SeasonName: 'Season 1',
          },
          PlayState: {
            PositionTicks: 18000000000,
            IsPaused: true,
            PlayMethod: 'Transcode',
          },
          TranscodingInfo: {
            Bitrate: 5000000,
          },
        };

        const session = parsers.parseSession(rawSession);

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
        };

        const session = parsers.parseSession(rawSession);
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

        const session = parsers.parseSession(rawSession);

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
            MediaSources: [{ Bitrate: 30000000 }],
          },
          PlayState: {
            PlayMethod: 'DirectPlay',
          },
        };

        const session = parsers.parseSession(rawSession);
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
          },
          {
            Id: '3',
            UserId: 'u3',
            NowPlayingItem: { Id: 'i3', Name: 'Also Playing', Type: 'Episode' },
          },
        ];

        const parsed = parsers.parseSessionsResponse(sessions);

        expect(parsed).toHaveLength(2);
        expect(parsed[0]!.sessionKey).toBe('1');
        expect(parsed[1]!.sessionKey).toBe('3');
      });

      it('should return empty array for non-array input', () => {
        expect(parsers.parseSessionsResponse(null as unknown as unknown[])).toEqual([]);
        expect(parsers.parseSessionsResponse('not an array' as unknown as unknown[])).toEqual([]);
      });
    });
  });
}

// ============================================================================
// User Parsing Tests
// ============================================================================

export function createUserParsingTests(parsers: ParserFunctions, serverType: 'jellyfin' | 'emby') {
  describe(`${serverType} User Parser`, () => {
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

        const user = parsers.parseUser(rawUser);

        expect(user.id).toBe('admin-123');
        expect(user.username).toBe('Administrator');
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

        const user = parsers.parseUser(rawUser);

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

        const user = parsers.parseUser(rawUser);

        expect(user.isDisabled).toBe(true);
      });

      it('should handle missing Policy object', () => {
        const rawUser = {
          Id: 'no-policy',
          Name: 'Guest',
        };

        const user = parsers.parseUser(rawUser);

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

        const parsed = parsers.parseUsersResponse(users);

        expect(parsed).toHaveLength(2);
        expect(parsed[0]!.isAdmin).toBe(true);
        expect(parsed[1]!.isAdmin).toBe(false);
      });

      it('should return empty array for non-array input', () => {
        expect(parsers.parseUsersResponse(null as unknown as unknown[])).toEqual([]);
      });
    });
  });
}

// ============================================================================
// Library Parsing Tests
// ============================================================================

export function createLibraryParsingTests(
  parsers: ParserFunctions,
  serverType: 'jellyfin' | 'emby'
) {
  describe(`${serverType} Library Parser`, () => {
    describe('parseLibrary', () => {
      it('should parse virtual folder', () => {
        const rawFolder = {
          ItemId: 'lib-123',
          Name: 'Movies',
          CollectionType: 'movies',
          Locations: ['/media/movies', '/media/movies2'],
        };

        const library = parsers.parseLibrary(rawFolder);

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

        const library = parsers.parseLibrary(rawFolder);

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

        const libraries = parsers.parseLibrariesResponse(folders);

        expect(libraries).toHaveLength(2);
        expect(libraries[0]!.name).toBe('Movies');
        expect(libraries[1]!.name).toBe('TV Shows');
      });
    });
  });
}

// ============================================================================
// Watch History Parsing Tests
// ============================================================================

export function createWatchHistoryParsingTests(
  parsers: ParserFunctions,
  serverType: 'jellyfin' | 'emby'
) {
  describe(`${serverType} Watch History Parser`, () => {
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

        const item = parsers.parseWatchHistoryItem(rawItem);

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

        const item = parsers.parseWatchHistoryItem(rawItem);

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

        const items = parsers.parseWatchHistoryResponse(response);

        expect(items).toHaveLength(2);
        expect(items[1]!.episode?.showTitle).toBe('Show');
      });

      it('should return empty array for missing Items', () => {
        expect(parsers.parseWatchHistoryResponse({})).toEqual([]);
        expect(parsers.parseWatchHistoryResponse(null)).toEqual([]);
      });
    });
  });
}

// ============================================================================
// Activity Log Parsing Tests
// ============================================================================

export function createActivityLogParsingTests(
  parsers: ParserFunctions,
  serverType: 'jellyfin' | 'emby'
) {
  describe(`${serverType} Activity Log Parser`, () => {
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

        const entry = parsers.parseActivityLogItem(rawEntry);

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

        const entry = parsers.parseActivityLogItem(rawEntry);

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

        const entries = parsers.parseActivityLogResponse(response);

        expect(entries).toHaveLength(2);
      });
    });
  });
}

// ============================================================================
// Authentication Response Parsing Tests
// ============================================================================

export function createAuthParsingTests(parsers: ParserFunctions, serverType: 'jellyfin' | 'emby') {
  describe(`${serverType} Auth Response Parser`, () => {
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
          AccessToken: 'token-abc',
          ServerId: 'server-456',
        };

        const result = parsers.parseAuthResponse(rawResponse);

        expect(result.id).toBe('user-123');
        expect(result.username).toBe('Admin');
        expect(result.token).toBe('token-abc');
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

        const result = parsers.parseAuthResponse(rawResponse);

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

        const result = parsers.parseAuthResponse(rawResponse);

        expect(result.isAdmin).toBe(false);
      });
    });
  });
}

// ============================================================================
// PlayMethod and Transcode Detection Tests (Common)
// ============================================================================

export function createPlayMethodTests(parsers: ParserFunctions, serverType: 'jellyfin' | 'emby') {
  describe(`${serverType} Parser - PlayMethod and Transcode Detection`, () => {
    it('should use PlayMethod from PlayState for transcode detection', () => {
      const session = parsers.parseSession({
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
      const session = parsers.parseSession({
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

    it('should normalize PlayMethod to lowercase', () => {
      const session = parsers.parseSession({
        Id: 'session-1',
        NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
        PlayState: {
          PlayMethod: 'DirectPlay',
          IsPaused: false,
        },
      });

      expect(session!.quality.videoDecision).toBe('directplay');
    });
  });
}

// ============================================================================
// Trailer and Preroll Filtering Tests
// ============================================================================

export function createTrailerFilteringTests(
  parsers: ParserFunctions,
  serverType: 'jellyfin' | 'emby'
) {
  describe(`${serverType} Parser - Trailer and Preroll Filtering`, () => {
    it('should filter out Trailer sessions', () => {
      const session = parsers.parseSession({
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
      const session = parsers.parseSession({
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

    it('should filter out theme songs (ExtraType: ThemeSong)', () => {
      const session = parsers.parseSession({
        Id: 'session-1',
        NowPlayingItem: {
          Id: 'theme-1',
          Name: 'Show Theme Song',
          Type: 'Audio',
          ExtraType: 'ThemeSong',
        },
      });

      expect(session).toBeNull();
    });

    it('should filter out theme videos (ExtraType: ThemeVideo)', () => {
      const session = parsers.parseSession({
        Id: 'session-1',
        NowPlayingItem: {
          Id: 'theme-video-1',
          Name: 'Show Theme Video',
          Type: 'Video',
          ExtraType: 'ThemeVideo',
        },
      });

      expect(session).toBeNull();
    });

    it('should NOT filter regular music tracks (no ExtraType)', () => {
      const session = parsers.parseSession({
        Id: 'session-1',
        NowPlayingItem: {
          Id: 'track-1',
          Name: 'Regular Song',
          Type: 'Audio',
        },
      });

      expect(session).not.toBeNull();
      expect(session!.media.title).toBe('Regular Song');
    });

    it('should NOT filter regular movies', () => {
      const session = parsers.parseSession({
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
      const session = parsers.parseSession({
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

      const parsed = parsers.parseSessionsResponse(sessions);

      expect(parsed).toHaveLength(2);
      expect(parsed.map((s) => s.sessionKey)).toEqual(['1', '3']);
    });
  });
}

// ============================================================================
// Live TV Parsing Tests
// ============================================================================

export function createLiveTVTests(parsers: ParserFunctions, serverType: 'jellyfin' | 'emby') {
  const clientName = serverType === 'jellyfin' ? 'Jellyfin Android TV' : 'Emby Theater';

  describe(`${serverType} Live TV Parser`, () => {
    it('should detect Live TV with Type "LiveTvChannel"', () => {
      const rawSession = {
        Id: 'live-session-1',
        UserId: 'user-1',
        UserName: 'John',
        DeviceName: 'TV',
        DeviceId: 'tv-123',
        Client: clientName,
        RemoteEndPoint: '192.168.1.100',
        NowPlayingItem: {
          Id: 'channel-abc',
          Name: 'CNN Live',
          Type: 'LiveTvChannel',
          ChannelId: 'channel-abc',
          ChannelName: 'CNN',
          ChannelNumber: '202',
        },
        PlayState: {
          IsPaused: false,
        },
      };

      const session = parsers.parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.media.type).toBe('live');
      expect(session!.live).toBeDefined();
      expect(session!.live?.channelTitle).toBe('CNN');
      expect(session!.live?.channelIdentifier).toBe('202');
      expect(session!.live?.channelThumb).toBe('/Items/channel-abc/Images/Primary');
    });

    it('should detect Live TV with Type "TvChannel"', () => {
      const rawSession = {
        Id: 'live-session-2',
        NowPlayingItem: {
          Id: 'channel-xyz',
          Name: 'ESPN',
          Type: 'TvChannel',
          ChannelId: 'channel-xyz',
          ChannelName: 'ESPN',
          ChannelNumber: '206',
        },
        PlayState: {},
      };

      const session = parsers.parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.media.type).toBe('live');
      expect(session!.live).toBeDefined();
      expect(session!.live?.channelTitle).toBe('ESPN');
      expect(session!.live?.channelIdentifier).toBe('206');
    });

    it('should use Name as fallback when ChannelName is missing', () => {
      const rawSession = {
        Id: 'live-session-3',
        NowPlayingItem: {
          Id: 'channel-123',
          Name: 'Local News HD',
          Type: 'LiveTvChannel',
          ChannelId: 'channel-123',
        },
        PlayState: {},
      };

      const session = parsers.parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.live?.channelTitle).toBe('Local News HD');
    });

    it('should handle Live TV case-insensitively', () => {
      const rawSession = {
        Id: 'live-session-4',
        NowPlayingItem: {
          Id: 'ch-1',
          Name: 'Test Channel',
          Type: 'LIVETVCHANNEL',
          ChannelName: 'Test',
        },
        PlayState: {},
      };

      const session = parsers.parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.media.type).toBe('live');
    });

    it('should include Live TV sessions in parseSessionsResponse', () => {
      const sessions = [
        {
          Id: '1',
          NowPlayingItem: { Id: 'movie-1', Name: 'Movie', Type: 'Movie' },
        },
        {
          Id: '2',
          NowPlayingItem: {
            Id: 'channel-1',
            Name: 'CNN',
            Type: 'LiveTvChannel',
            ChannelName: 'CNN',
          },
        },
        {
          Id: '3',
          NowPlayingItem: { Id: 'ep-1', Name: 'Episode', Type: 'Episode' },
        },
      ];

      const parsed = parsers.parseSessionsResponse(sessions);

      expect(parsed).toHaveLength(3);
      expect(parsed[1]!.media.type).toBe('live');
      expect(parsed[1]!.live?.channelTitle).toBe('CNN');
    });
  });
}

// ============================================================================
// Music Track Parsing Tests
// ============================================================================

export function createMusicTrackTests(parsers: ParserFunctions, serverType: 'jellyfin' | 'emby') {
  const clientName = serverType === 'jellyfin' ? 'Jellyfin Mobile' : 'Emby Mobile';

  describe(`${serverType} Music Track Parser`, () => {
    it('should parse music track with full metadata', () => {
      const rawSession = {
        Id: 'music-session-1',
        UserId: 'user-1',
        UserName: 'John',
        DeviceName: 'Phone',
        DeviceId: 'phone-123',
        Client: clientName,
        RemoteEndPoint: '192.168.1.50',
        NowPlayingItem: {
          Id: 'track-123',
          Name: 'Bohemian Rhapsody',
          Type: 'Audio',
          RunTimeTicks: 3540000000,
          AlbumArtist: 'Queen',
          Album: 'A Night at the Opera',
          IndexNumber: 11,
          ParentIndexNumber: 1,
          Artists: ['Queen'],
        },
        PlayState: {
          PositionTicks: 1200000000,
          IsPaused: false,
        },
      };

      const session = parsers.parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.media.type).toBe('track');
      expect(session!.media.title).toBe('Bohemian Rhapsody');
      expect(session!.music).toBeDefined();
      expect(session!.music?.artistName).toBe('Queen');
      expect(session!.music?.albumName).toBe('A Night at the Opera');
      expect(session!.music?.trackNumber).toBe(11);
      expect(session!.music?.discNumber).toBe(1);
    });

    it('should fall back to Artists array when AlbumArtist is missing', () => {
      const rawSession = {
        Id: 'music-session-2',
        NowPlayingItem: {
          Id: 'track-456',
          Name: 'Some Song',
          Type: 'Audio',
          Artists: ['Artist A', 'Artist B'],
          Album: 'Some Album',
        },
        PlayState: {},
      };

      const session = parsers.parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.music?.artistName).toBe('Artist A');
      expect(session!.music?.albumName).toBe('Some Album');
    });

    it('should parse music track with minimal metadata', () => {
      const rawSession = {
        Id: 'music-session-3',
        NowPlayingItem: {
          Id: 'track-789',
          Name: 'Unknown Track',
          Type: 'Audio',
        },
        PlayState: {},
      };

      const session = parsers.parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.media.type).toBe('track');
      expect(session!.music).toBeDefined();
      expect(session!.music?.artistName).toBeUndefined();
      expect(session!.music?.albumName).toBeUndefined();
      expect(session!.music?.trackNumber).toBeUndefined();
      expect(session!.music?.discNumber).toBeUndefined();
    });

    it('should not set music metadata for non-track types', () => {
      const rawSession = {
        Id: 'movie-session',
        NowPlayingItem: {
          Id: 'movie-1',
          Name: 'A Movie',
          Type: 'Movie',
          AlbumArtist: 'Should Be Ignored',
        },
        PlayState: {},
      };

      const session = parsers.parseSession(rawSession);

      expect(session).not.toBeNull();
      expect(session!.media.type).toBe('movie');
      expect(session!.music).toBeUndefined();
    });

    it('should handle music track from parseSessionsResponse', () => {
      const sessions = [
        {
          Id: '1',
          NowPlayingItem: {
            Id: 'track-1',
            Name: 'Song A',
            Type: 'Audio',
            AlbumArtist: 'Artist A',
            Album: 'Album A',
            IndexNumber: 5,
            ParentIndexNumber: 2,
          },
        },
        {
          Id: '2',
          NowPlayingItem: { Id: 'movie-1', Name: 'Movie', Type: 'Movie' },
        },
      ];

      const parsed = parsers.parseSessionsResponse(sessions);

      expect(parsed).toHaveLength(2);
      expect(parsed[0]!.media.type).toBe('track');
      expect(parsed[0]!.music?.artistName).toBe('Artist A');
      expect(parsed[0]!.music?.albumName).toBe('Album A');
      expect(parsed[0]!.music?.trackNumber).toBe(5);
      expect(parsed[0]!.music?.discNumber).toBe(2);
      expect(parsed[1]!.music).toBeUndefined();
    });
  });
}

// ============================================================================
// Edge Cases and Type Handling Tests
// ============================================================================

export function createEdgeCaseTests(parsers: ParserFunctions, serverType: 'jellyfin' | 'emby') {
  describe(`${serverType} Parser Edge Cases`, () => {
    it('should handle media type conversion', () => {
      const makeSession = (type: string) => ({
        NowPlayingItem: { Id: '1', Name: 'Test', Type: type },
      });

      expect(parsers.parseSession(makeSession('Movie'))!.media.type).toBe('movie');
      expect(parsers.parseSession(makeSession('Episode'))!.media.type).toBe('episode');
      expect(parsers.parseSession(makeSession('Audio'))!.media.type).toBe('track');
      expect(parsers.parseSession(makeSession('Photo'))!.media.type).toBe('photo');
      expect(parsers.parseSession(makeSession('Unknown'))!.media.type).toBe('unknown');
    });

    it('should convert ticks to milliseconds correctly', () => {
      const session = parsers.parseSession({
        NowPlayingItem: {
          Id: '1',
          Name: 'Test',
          Type: 'Movie',
          RunTimeTicks: 36000000000,
        },
        PlayState: {
          PositionTicks: 18000000000,
        },
      });

      expect(session!.media.durationMs).toBe(3600000);
      expect(session!.playback.positionMs).toBe(1800000);
      expect(session!.playback.progressPercent).toBe(50);
    });

    it('should handle zero duration gracefully', () => {
      const session = parsers.parseSession({
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
}

// ============================================================================
// Master Test Suite Runner
// ============================================================================

/**
 * Runs all shared parser tests for a given platform
 */
export function createAllSharedParserTests(
  parsers: ParserFunctions,
  serverType: 'jellyfin' | 'emby'
) {
  createSessionParsingTests(parsers, serverType);
  createUserParsingTests(parsers, serverType);
  createLibraryParsingTests(parsers, serverType);
  createWatchHistoryParsingTests(parsers, serverType);
  createActivityLogParsingTests(parsers, serverType);
  createAuthParsingTests(parsers, serverType);
  createPlayMethodTests(parsers, serverType);
  createTrailerFilteringTests(parsers, serverType);
  createLiveTVTests(parsers, serverType);
  createMusicTrackTests(parsers, serverType);
  createEdgeCaseTests(parsers, serverType);
}
