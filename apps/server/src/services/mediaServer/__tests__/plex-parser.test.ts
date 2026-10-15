/**
 * Plex Parser Tests
 *
 * Tests the pure parsing functions that convert raw Plex API responses
 * into typed MediaSession, MediaUser, and MediaLibrary objects.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSession,
  parseSessionsResponse,
  parseLocalUser,
  parseUsersResponse,
  parseLibrary,
  parseLibrariesResponse,
  parseWatchHistoryItem,
  parseWatchHistoryResponse,
  parseServerConnection,
  parseServerResourcesResponse,
  extractXmlAttribute,
  extractXmlId,
  parseXmlUsersResponse,
  parseSharedServersXml,
  parsePlexTvUser,
  parseMediaMetadataResponse,
  parseLibraryItemsResponse,
  parseStatisticsBandwidthResponse,
  parseStatisticsResourcesResponse,
  getTranscodingSessionRatingKeys,
  findStreamByType,
  STREAM_TYPE,
  type PlexOriginalMedia,
} from '../plex/parser.js';

// ============================================================================
// Session Parsing Tests
// ============================================================================

describe('Plex Session Parser', () => {
  describe('parseSession', () => {
    it('should parse a movie session', () => {
      const rawSession = {
        sessionKey: '12345',
        ratingKey: '67890',
        title: 'Inception',
        type: 'movie',
        duration: 9000000, // 150 minutes in ms
        viewOffset: 3600000, // 60 minutes in ms
        year: 2010,
        thumb: '/library/metadata/67890/thumb/1234',
        User: { id: '1', title: 'John', thumb: '/avatars/1.jpg' },
        Player: {
          title: "John's iPhone",
          machineIdentifier: 'device-uuid-123',
          product: 'Plex for iOS',
          device: 'iPhone',
          platform: 'iOS',
          address: '192.168.1.100',
          remotePublicAddress: '203.0.113.50',
          state: 'playing',
          local: true,
        },
        Media: [{ bitrate: 8000 }],
        TranscodeSession: { videoDecision: 'directplay' },
      };

      const session = parseSession(rawSession);

      expect(session.sessionKey).toBe('12345');
      expect(session.mediaId).toBe('67890');
      expect(session.user.id).toBe('1');
      expect(session.user.username).toBe('John');
      expect(session.media.title).toBe('Inception');
      expect(session.media.type).toBe('movie');
      expect(session.media.durationMs).toBe(9000000);
      expect(session.media.year).toBe(2010);
      expect(session.playback.state).toBe('playing');
      expect(session.playback.positionMs).toBe(3600000);
      expect(session.playback.progressPercent).toBe(40);
      expect(session.player.name).toBe("John's iPhone");
      expect(session.player.deviceId).toBe('device-uuid-123');
      expect(session.network.ipAddress).toBe('192.168.1.100'); // Uses local IP when local=true
      expect(session.network.isLocal).toBe(true);
      expect(session.quality.bitrate).toBe(8000);
      expect(session.quality.isTranscode).toBe(false);
      expect(session.episode).toBeUndefined();
    });

    it('should parse an episode session with show metadata', () => {
      const rawSession = {
        sessionKey: '11111',
        ratingKey: '22222',
        title: 'Pilot',
        type: 'episode',
        duration: 3600000,
        viewOffset: 1800000,
        grandparentTitle: 'Breaking Bad',
        parentTitle: 'Season 1',
        grandparentRatingKey: '33333',
        parentIndex: 1,
        index: 1,
        thumb: '/library/metadata/22222/thumb/456',
        grandparentThumb: '/library/metadata/33333/thumb/789',
        User: { id: '2', title: 'Jane' },
        Player: {
          title: 'Living Room TV',
          machineIdentifier: 'tv-uuid',
          state: 'paused',
          local: false,
          address: '192.168.1.50',
          remotePublicAddress: '198.51.100.25',
        },
        Media: [{ bitrate: 20000 }],
        TranscodeSession: { videoDecision: 'transcode' },
      };

      const session = parseSession(rawSession);

      expect(session.media.type).toBe('episode');
      expect(session.playback.state).toBe('paused');
      expect(session.playback.progressPercent).toBe(50);
      expect(session.quality.isTranscode).toBe(true);
      expect(session.episode).toBeDefined();
      expect(session.episode?.showTitle).toBe('Breaking Bad');
      expect(session.episode?.seasonNumber).toBe(1);
      expect(session.episode?.episodeNumber).toBe(1);
      expect(session.episode?.seasonName).toBe('Season 1');
      expect(session.episode?.showId).toBe('33333');
    });

    it('should parse a Season 0 (Specials) episode with seasonNumber 0, not null', () => {
      const rawSession = {
        sessionKey: 'specials-1',
        ratingKey: '99999',
        title: 'Behind the Scenes',
        type: 'episode',
        duration: 600000,
        viewOffset: 0,
        grandparentTitle: 'Breaking Bad',
        parentTitle: 'Specials',
        parentIndex: 0,
        index: 1,
        User: { id: '2', title: 'Jane' },
        Player: { title: 'TV', machineIdentifier: 'tv-uuid' },
      };

      const session = parseSession(rawSession);

      expect(session.episode?.seasonNumber).toBe(0);
      expect(session.episode?.episodeNumber).toBe(1);
    });

    it('should parse episode index 0 as episodeNumber 0, not null', () => {
      const rawSession = {
        sessionKey: 'episode-zero',
        ratingKey: '88888',
        title: 'Episode Zero',
        type: 'episode',
        grandparentTitle: 'Breaking Bad',
        parentIndex: 1,
        index: 0,
        User: { id: '2', title: 'Jane' },
        Player: { title: 'TV', machineIdentifier: 'tv-uuid' },
      };

      const session = parseSession(rawSession);

      expect(session.episode?.seasonNumber).toBe(1);
      expect(session.episode?.episodeNumber).toBe(0);
    });

    it('should parse a missing parentIndex as null, not 0', () => {
      const rawSession = {
        sessionKey: 'no-season',
        ratingKey: '77777',
        title: 'Mystery Episode',
        type: 'episode',
        grandparentTitle: 'Breaking Bad',
        index: 3,
        User: { id: '2', title: 'Jane' },
        Player: { title: 'TV', machineIdentifier: 'tv-uuid' },
      };

      const session = parseSession(rawSession);

      expect(session.episode?.seasonNumber).toBeNull();
      expect(session.episode?.episodeNumber).toBe(3);
    });

    it('should handle missing optional fields gracefully', () => {
      const rawSession = {
        sessionKey: 'minimal',
        type: 'movie',
        User: {},
        Player: {},
      };

      const session = parseSession(rawSession);

      expect(session.sessionKey).toBe('minimal');
      expect(session.mediaId).toBe('');
      expect(session.user.id).toBe('');
      expect(session.user.username).toBe('');
      expect(session.user.thumb).toBeUndefined();
      expect(session.media.durationMs).toBe(0);
      expect(session.playback.progressPercent).toBe(0);
      expect(session.quality.bitrate).toBe(0);
    });

    it('should use selected Media version when multiple versions exist (issue #117)', () => {
      // When user has 4K and 1080p versions matched together, Plex returns both
      // in the Media array but marks the playing one with selected=1
      const rawSession = {
        sessionKey: 'multi-version',
        ratingKey: '12345',
        title: 'Game of Thrones',
        type: 'episode',
        User: { id: '1', title: 'User' },
        Player: { title: 'TV', machineIdentifier: 'tv-1' },
        Media: [
          {
            // 4K version - NOT selected (first in array)
            videoResolution: '4k',
            width: 3840,
            height: 2160,
            bitrate: 50000,
          },
          {
            // 1080p version - SELECTED (user is watching this one)
            videoResolution: '1080',
            width: 1920,
            height: 1080,
            bitrate: 10000,
            selected: 1,
          },
        ],
      };

      const session = parseSession(rawSession);

      // Should use the selected 1080p version, not the first 4K version
      expect(session.quality.videoResolution).toBe('1080');
      expect(session.quality.videoWidth).toBe(1920);
      expect(session.quality.videoHeight).toBe(1080);
      expect(session.quality.bitrate).toBe(10000);
    });

    it('should fall back to first Media when none are selected', () => {
      const rawSession = {
        sessionKey: 'single-version',
        type: 'movie',
        User: {},
        Player: {},
        Media: [
          {
            videoResolution: '4k',
            width: 3840,
            height: 2160,
            bitrate: 50000,
          },
        ],
      };

      const session = parseSession(rawSession);

      expect(session.quality.videoResolution).toBe('4k');
      expect(session.quality.bitrate).toBe(50000);
    });

    it('should use selected Media when the JSON API sends boolean selected', () => {
      // The JSON API (Accept: application/json) returns selected as boolean
      // true, not the string '1' the XML form uses
      const rawSession = {
        sessionKey: 'multi-version-bool',
        ratingKey: '683',
        type: 'movie',
        User: { id: '1', title: 'User' },
        Player: { title: 'TV', machineIdentifier: 'tv-1' },
        Media: [
          {
            id: 3207,
            videoResolution: '4k',
            width: 3840,
            height: 2160,
            bitrate: 15512,
            Part: [{ Stream: [{ streamType: 1, codec: 'hevc' }] }],
          },
          {
            id: 98869,
            videoResolution: '1080',
            width: 1920,
            height: 1080,
            bitrate: 10000,
            selected: true,
            Part: [{ Stream: [{ streamType: 1, codec: 'h264' }] }],
          },
        ],
      };

      const session = parseSession(rawSession);

      expect(session.quality.videoResolution).toBe('1080');
      expect(session.quality.videoWidth).toBe(1920);
      expect(session.quality.videoHeight).toBe(1080);
      expect(session.quality.bitrate).toBe(10000);
      expect(session.quality.sourceVideoCodec).toBe('H264');
      expect(session.serverVersionKey).toBe('98869');
    });

    it('should fall back to local IP when no public IP available', () => {
      const rawSession = {
        sessionKey: 'local-only',
        Player: {
          address: '192.168.1.100',
          remotePublicAddress: '',
        },
      };

      const session = parseSession(rawSession);
      expect(session.network.ipAddress).toBe('192.168.1.100');
    });

    it('should use public IP for remote streams', () => {
      const rawSession = {
        sessionKey: 'remote',
        Player: {
          address: '192.168.1.100',
          remotePublicAddress: '203.0.113.50',
          local: false, // Remote stream
        },
      };

      const session = parseSession(rawSession);
      expect(session.network.ipAddress).toBe('203.0.113.50'); // Prefers public IP for remote
      expect(session.network.isLocal).toBe(false);
    });

    it('should use local IP for local streams even if public IP available', () => {
      const rawSession = {
        sessionKey: 'local-with-public',
        Player: {
          address: '192.168.1.100',
          remotePublicAddress: '203.0.113.50',
          local: true, // Local stream
        },
      };

      const session = parseSession(rawSession);
      expect(session.network.ipAddress).toBe('192.168.1.100'); // Uses local IP for local streams
      expect(session.network.isLocal).toBe(true);
    });
  });

  describe('parseSession audio profile', () => {
    it('flags Atmos from the audio stream profile', () => {
      const session = parseSession({
        sessionKey: '1',
        ratingKey: '2',
        title: 'Episode',
        type: 'episode',
        duration: 1000,
        viewOffset: 0,
        User: { id: '1', title: 'John' },
        Player: { title: 'TV', machineIdentifier: 'm', state: 'playing' },
        Media: [
          {
            Part: [
              {
                Stream: [
                  {
                    streamType: 2,
                    codec: 'eac3',
                    profile: 'dolby digital plus + dolby atmos',
                  },
                ],
              },
            ],
          },
        ],
      });

      expect(session.quality.sourceAudioDetails?.atmos).toBe(true);
      expect(session.quality.sourceAudioDetails?.profile).toBe('dolby digital plus + dolby atmos');
    });
  });

  describe('parseSessionsResponse', () => {
    it('should parse full MediaContainer response', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              sessionKey: '1',
              title: 'Movie 1',
              type: 'movie',
              User: { id: '1', title: 'User1' },
              Player: { title: 'Device1', machineIdentifier: 'dev1' },
            },
            {
              sessionKey: '2',
              title: 'Movie 2',
              type: 'movie',
              User: { id: '2', title: 'User2' },
              Player: { title: 'Device2', machineIdentifier: 'dev2' },
            },
          ],
        },
      };

      const sessions = parseSessionsResponse(response);

      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.sessionKey).toBe('1');
      expect(sessions[1]!.sessionKey).toBe('2');
    });

    it('drops theme music and non-trailer extras, keeps trailers and prerolls', () => {
      const base = {
        User: { id: '1', title: 'User1' },
        Player: { title: 'TV', machineIdentifier: 'dev1' },
      };
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ...base,
              sessionKey: '1',
              title: 'Theme',
              type: 'track',
              guid: 'library://abc/item/1',
            },
            { ...base, sessionKey: '2', title: 'Movie', type: 'movie' },
            { ...base, sessionKey: '3', title: 'Featurette', type: 'clip', extraType: 10 },
            { ...base, sessionKey: '4', title: 'Trailer', type: 'clip', extraType: 1 },
            { ...base, sessionKey: '5', title: 'Preroll', type: 'clip', guid: 'prerolls://x' },
          ],
        },
      };

      const sessions = parseSessionsResponse(response);

      expect(sessions.map((s) => s.sessionKey)).toEqual(['2', '4', '5']);
      expect(sessions.filter((s) => s.media.type === 'trailer')).toHaveLength(2);
    });

    it('should return empty array when MediaContainer has no Metadata (no active sessions)', () => {
      expect(parseSessionsResponse({ MediaContainer: {} })).toEqual([]);
    });

    it('should throw for a malformed response missing MediaContainer', () => {
      expect(() => parseSessionsResponse({})).toThrow();
      expect(() => parseSessionsResponse(null)).toThrow();
    });

    it('should use composite key to resolve correct media version per session (issue #686)', () => {
      // Two sessions transcoding different versions of the same item (same ratingKey)
      const transcodeSession = { videoDecision: 'transcode', audioDecision: 'copy' };
      const response = {
        MediaContainer: {
          Metadata: [
            {
              sessionKey: 'session-a',
              ratingKey: '100',
              title: 'Movie',
              type: 'movie',
              User: { id: '1', title: 'Alice' },
              Player: { title: 'TV', machineIdentifier: 'tv1' },
              TranscodeSession: transcodeSession,
              Media: [{ id: 200, selected: '1' }],
            },
            {
              sessionKey: 'session-b',
              ratingKey: '100',
              title: 'Movie',
              type: 'movie',
              User: { id: '2', title: 'Bob' },
              Player: { title: 'Phone', machineIdentifier: 'phone1' },
              TranscodeSession: transcodeSession,
              Media: [{ id: 300 }],
            },
          ],
        },
      };

      const originalMedia4K: PlexOriginalMedia = {
        bitrate: 50000,
        videoWidth: 3840,
        videoHeight: 2160,
        videoCodec: 'HEVC',
      };
      const originalMedia1080p: PlexOriginalMedia = {
        bitrate: 10000,
        videoWidth: 1920,
        videoHeight: 1080,
        videoCodec: 'H264',
      };

      const originalMediaMap = new Map<string, PlexOriginalMedia>([
        ['100:200', originalMedia4K],
        ['100:300', originalMedia1080p],
      ]);

      const sessions = parseSessionsResponse(response, originalMediaMap);

      expect(sessions).toHaveLength(2);
      const sessionA = sessions.find((s) => s.sessionKey === 'session-a');
      const sessionB = sessions.find((s) => s.sessionKey === 'session-b');

      expect(sessionA?.quality.videoWidth).toBe(3840);
      expect(sessionB?.quality.videoWidth).toBe(1920);
    });
  });
});

// ============================================================================
// User Parsing Tests
// ============================================================================

describe('Plex User Parser', () => {
  describe('parseLocalUser', () => {
    it('should parse local Plex account', () => {
      const rawUser = {
        id: '1',
        name: 'admin',
        thumb: '/avatars/admin.jpg',
      };

      const user = parseLocalUser(rawUser);

      expect(user.id).toBe('1');
      expect(user.username).toBe('admin');
      expect(user.thumb).toBe('/avatars/admin.jpg');
      expect(user.isAdmin).toBe(true); // id=1 is admin
      expect(user.email).toBeUndefined();
    });

    it('should mark non-admin users correctly', () => {
      const rawUser = { id: '5', name: 'guest' };
      const user = parseLocalUser(rawUser);

      expect(user.isAdmin).toBe(false);
    });
  });

  describe('parseUsersResponse', () => {
    it('should parse MediaContainer Account response', () => {
      const response = {
        MediaContainer: {
          Account: [
            { id: '1', name: 'admin' },
            { id: '2', name: 'guest' },
          ],
        },
      };

      const users = parseUsersResponse(response);

      expect(users).toHaveLength(2);
      expect(users[0]!.isAdmin).toBe(true);
      expect(users[1]!.isAdmin).toBe(false);
    });
  });

  describe('parsePlexTvUser', () => {
    it('should parse plex.tv user with shared libraries', () => {
      const rawUser = {
        id: '12345',
        username: 'plex_user',
        email: 'user@example.com',
        thumb: 'https://plex.tv/avatars/user.jpg',
        home: true,
      };

      const user = parsePlexTvUser(rawUser, ['1', '2', '3']);

      expect(user.id).toBe('12345');
      expect(user.username).toBe('plex_user');
      expect(user.email).toBe('user@example.com');
      expect(user.isHomeUser).toBe(true);
      expect(user.sharedLibraries).toEqual(['1', '2', '3']);
    });
  });
});

// ============================================================================
// Library Parsing Tests
// ============================================================================

describe('Plex Library Parser', () => {
  describe('parseLibrary', () => {
    it('should parse library directory', () => {
      const rawLib = {
        key: '1',
        title: 'Movies',
        type: 'movie',
        agent: 'tv.plex.agents.movie',
        scanner: 'Plex Movie',
        uuid: 'abc-123',
      };

      const library = parseLibrary(rawLib);

      expect(library.id).toBe('1');
      expect(library.name).toBe('Movies');
      expect(library.type).toBe('movie');
      expect(library.agent).toBe('tv.plex.agents.movie');
      expect(library.scanner).toBe('Plex Movie');
    });
  });

  describe('parseLibrariesResponse', () => {
    it('should parse MediaContainer Directory response', () => {
      const response = {
        MediaContainer: {
          Directory: [
            { key: '1', title: 'Movies', type: 'movie' },
            { key: '2', title: 'TV Shows', type: 'show' },
          ],
        },
      };

      const libraries = parseLibrariesResponse(response);

      expect(libraries).toHaveLength(2);
      expect(libraries[0]!.name).toBe('Movies');
      expect(libraries[1]!.name).toBe('TV Shows');
    });
  });
});

// ============================================================================
// Watch History Parsing Tests
// ============================================================================

describe('Plex Watch History Parser', () => {
  describe('parseWatchHistoryItem', () => {
    it('should parse movie history item', () => {
      const rawItem = {
        ratingKey: '12345',
        title: 'The Matrix',
        type: 'movie',
        lastViewedAt: 1700000000,
        accountID: '1',
      };

      const item = parseWatchHistoryItem(rawItem);

      expect(item.mediaId).toBe('12345');
      expect(item.title).toBe('The Matrix');
      expect(item.type).toBe('movie');
      expect(item.watchedAt).toBe(1700000000);
      expect(item.episode).toBeUndefined();
    });

    it('should parse episode history with show metadata', () => {
      const rawItem = {
        ratingKey: '67890',
        title: 'Pilot',
        type: 'episode',
        grandparentTitle: 'Lost',
        parentIndex: 1,
        index: 1,
        viewedAt: 1699999999,
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
    it('should parse MediaContainer Metadata response', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            { ratingKey: '1', title: 'Item 1', type: 'movie' },
            { ratingKey: '2', title: 'Item 2', type: 'episode', grandparentTitle: 'Show' },
          ],
        },
      };

      const items = parseWatchHistoryResponse(response);

      expect(items).toHaveLength(2);
      expect(items[1]!.episode?.showTitle).toBe('Show');
    });
  });
});

// ============================================================================
// Server Resource Parsing Tests
// ============================================================================

describe('Plex Server Resource Parser', () => {
  describe('parseServerConnection', () => {
    it('should parse connection with all fields', () => {
      const rawConn = {
        protocol: 'https',
        address: 'plex.example.com',
        port: 32400,
        uri: 'https://plex.example.com:32400',
        local: false,
      };

      const conn = parseServerConnection(rawConn);

      expect(conn.protocol).toBe('https');
      expect(conn.address).toBe('plex.example.com');
      expect(conn.port).toBe(32400);
      expect(conn.uri).toBe('https://plex.example.com:32400');
      expect(conn.local).toBe(false);
    });

    it('should use defaults for missing fields', () => {
      const conn = parseServerConnection({});

      expect(conn.protocol).toBe('http');
      expect(conn.port).toBe(32400);
      expect(conn.local).toBe(false);
    });
  });

  describe('parseServerResourcesResponse', () => {
    it('should filter for owned Plex Media Servers only', () => {
      const resources = [
        {
          name: 'My Server',
          product: 'Plex Media Server',
          provides: 'server',
          owned: true,
          connections: [{ uri: 'http://localhost:32400' }],
        },
        {
          name: 'Shared Server',
          product: 'Plex Media Server',
          provides: 'server',
          owned: false, // Not owned - should be filtered
          connections: [],
        },
        {
          name: 'Player',
          product: 'Plex Web',
          provides: 'player', // Not a server - should be filtered
          owned: true,
          connections: [],
        },
      ];

      const servers = parseServerResourcesResponse(resources, 'fallback-token');

      expect(servers).toHaveLength(1);
      expect(servers[0]!.name).toBe('My Server');
    });
  });
});

// ============================================================================
// XML Parsing Tests
// ============================================================================

describe('Plex XML Parser', () => {
  describe('extractXmlAttribute', () => {
    it('should extract attribute value', () => {
      const xml = '<User id="123" username="john" email="john@example.com" />';

      expect(extractXmlAttribute(xml, 'id')).toBe('123');
      expect(extractXmlAttribute(xml, 'username')).toBe('john');
      expect(extractXmlAttribute(xml, 'email')).toBe('john@example.com');
    });

    it('should return empty string for missing attribute', () => {
      const xml = '<User id="123" />';
      expect(extractXmlAttribute(xml, 'email')).toBe('');
    });
  });

  describe('extractXmlId', () => {
    it('should extract id attribute with various patterns', () => {
      expect(extractXmlId('<User id="123">')).toBe('123');
      expect(extractXmlId(' id="456"')).toBe('456');
      expect(extractXmlId('<Element id="789" other="x">')).toBe('789');
    });
  });

  describe('parseXmlUsersResponse', () => {
    it('should parse multiple users from XML', () => {
      const xml = `
        <MediaContainer>
          <User id="1" username="user1" email="user1@example.com" />
          <User id="2" username="user2" email="user2@example.com" home="1" />
        </MediaContainer>
      `;

      const users = parseXmlUsersResponse(xml);

      expect(users).toHaveLength(2);
      expect(users[0]!.id).toBe('1');
      expect(users[0]!.username).toBe('user1');
      expect(users[1]!.isHomeUser).toBe(true);
    });

    it('should handle self-closing User tags', () => {
      const xml = '<MediaContainer><User id="1" username="test" /></MediaContainer>';
      const users = parseXmlUsersResponse(xml);

      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe('1');
    });
  });

  describe('parseSharedServersXml', () => {
    it('should parse shared server info with libraries', () => {
      const xml = `
        <MediaContainer>
          <SharedServer id="1" userID="100" accessToken="token-100">
            <Section key="1" title="Movies" shared="1" />
            <Section key="2" title="TV" shared="1" />
            <Section key="3" title="Music" shared="0" />
          </SharedServer>
          <SharedServer id="2" userID="200" accessToken="token-200">
            <Section key="1" title="Movies" shared="1" />
          </SharedServer>
        </MediaContainer>
      `;

      const userMap = parseSharedServersXml(xml);

      expect(userMap.size).toBe(2);

      const user100 = userMap.get('100');
      expect(user100?.serverToken).toBe('token-100');
      expect(user100?.sharedLibraries).toEqual(['1', '2']);

      const user200 = userMap.get('200');
      expect(user200?.sharedLibraries).toEqual(['1']);
    });

    it('should return empty map for no shared servers', () => {
      const xml = '<MediaContainer></MediaContainer>';
      const userMap = parseSharedServersXml(xml);
      expect(userMap.size).toBe(0);
    });
  });
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

// ============================================================================
// Live TV Parsing Tests
// ============================================================================

describe('Plex Live TV Parser', () => {
  it('should detect Live TV when live="1" is set', () => {
    const rawSession = {
      sessionKey: 'live-session',
      ratingKey: 'channel-123',
      title: 'CNN',
      type: 'movie', // Live TV can have any type
      live: '1', // This flag indicates Live TV
      User: { id: '1', title: 'John' },
      Player: { title: 'TV', machineIdentifier: 'tv-1' },
      Media: [
        {
          channelTitle: 'CNN',
          channelIdentifier: '202',
          channelThumb: '/library/metadata/channel-123/thumb',
        },
      ],
    };

    const session = parseSession(rawSession);

    expect(session.media.type).toBe('live');
    expect(session.live).toBeDefined();
    expect(session.live?.channelTitle).toBe('CNN');
    expect(session.live?.channelIdentifier).toBe('202');
    expect(session.live?.channelThumb).toBe('/library/metadata/channel-123/thumb');
  });

  it('should use sourceTitle for channel name when available', () => {
    const rawSession = {
      sessionKey: 'live-session',
      sourceTitle: 'ESPN',
      type: 'episode',
      live: '1',
      User: {},
      Player: {},
    };

    const session = parseSession(rawSession);

    expect(session.media.type).toBe('live');
    expect(session.live?.channelTitle).toBe('ESPN');
  });

  it('keeps the show and its poster for a live episode', () => {
    // An XMLTV guide's episode carries its picture only on the show:
    // Plex sends grandparentThumb (often an absolute URL) and no thumb.
    const rawSession = {
      sessionKey: 'live-episode',
      ratingKey: '38389',
      title: 'Observation',
      type: 'episode',
      live: '1',
      grandparentTitle: 'Alien: Earth',
      grandparentThumb: 'https://guide.example.com/api/programs/abc/artwork/poster',
      parentIndex: 1,
      index: 4,
      User: {},
      Player: {},
    };

    const session = parseSession(rawSession);

    expect(session.media.type).toBe('live');
    expect(session.media.thumbPath).toBeUndefined();
    expect(session.episode?.showTitle).toBe('Alien: Earth');
    expect(session.episode?.seasonNumber).toBe(1);
    expect(session.episode?.episodeNumber).toBe(4);
    expect(session.episode?.showThumbPath).toBe(
      'https://guide.example.com/api/programs/abc/artwork/poster'
    );
  });

  it('leaves episode metadata off a live movie', () => {
    const rawSession = {
      sessionKey: 'live-movie',
      title: 'Coherence',
      type: 'movie',
      live: '1',
      thumb: '/library/metadata/38389/thumb/1792036612',
      User: {},
      Player: {},
    };

    const session = parseSession(rawSession);

    expect(session.media.type).toBe('live');
    expect(session.episode).toBeUndefined();
    expect(session.media.thumbPath).toBe('/library/metadata/38389/thumb/1792036612');
  });

  it('should not set live metadata when live flag is not "1"', () => {
    const rawSession = {
      sessionKey: 'not-live',
      type: 'movie',
      live: '0',
      User: {},
      Player: {},
    };

    const session = parseSession(rawSession);

    expect(session.media.type).toBe('movie');
    expect(session.live).toBeUndefined();
  });

  it('should not set live metadata when live flag is missing', () => {
    const rawSession = {
      sessionKey: 'regular-movie',
      type: 'movie',
      User: {},
      Player: {},
    };

    const session = parseSession(rawSession);

    expect(session.media.type).toBe('movie');
    expect(session.live).toBeUndefined();
  });
});

// ============================================================================
// Music Track Parsing Tests
// ============================================================================

describe('Plex Music Track Parser', () => {
  it('should parse music track with full metadata', () => {
    const rawSession = {
      sessionKey: 'music-session',
      ratingKey: 'track-123',
      title: 'Bohemian Rhapsody',
      type: 'track',
      duration: 354000, // 5:54 in ms
      viewOffset: 120000,
      grandparentTitle: 'Queen', // Artist
      parentTitle: 'A Night at the Opera', // Album
      index: 11, // Track number
      parentIndex: 1, // Disc number
      User: { id: '1', title: 'John' },
      Player: { title: 'Phone', machineIdentifier: 'phone-1' },
    };

    const session = parseSession(rawSession);

    expect(session.media.type).toBe('track');
    expect(session.media.title).toBe('Bohemian Rhapsody');
    expect(session.music).toBeDefined();
    expect(session.music?.artistName).toBe('Queen');
    expect(session.music?.albumName).toBe('A Night at the Opera');
    expect(session.music?.trackNumber).toBe(11);
    expect(session.music?.discNumber).toBe(1);
  });

  it('should parse music track with partial metadata', () => {
    const rawSession = {
      sessionKey: 'music-partial',
      title: 'Unknown Track',
      type: 'track',
      grandparentTitle: 'Unknown Artist',
      // Missing parentTitle, index, parentIndex
      User: {},
      Player: {},
    };

    const session = parseSession(rawSession);

    expect(session.media.type).toBe('track');
    expect(session.music).toBeDefined();
    expect(session.music?.artistName).toBe('Unknown Artist');
    expect(session.music?.albumName).toBeUndefined();
    expect(session.music?.trackNumber).toBeUndefined();
    expect(session.music?.discNumber).toBeUndefined();
  });

  it('should not set music metadata for non-track types', () => {
    const rawSession = {
      sessionKey: 'movie-not-track',
      title: 'A Movie',
      type: 'movie',
      grandparentTitle: 'Some Title', // Should be ignored
      User: {},
      Player: {},
    };

    const session = parseSession(rawSession);

    expect(session.media.type).toBe('movie');
    expect(session.music).toBeUndefined();
  });

  it('should handle track from parseSessionsResponse', () => {
    const response = {
      MediaContainer: {
        Metadata: [
          {
            sessionKey: '1',
            title: 'Song A',
            type: 'track',
            grandparentTitle: 'Artist A',
            parentTitle: 'Album A',
            index: 5,
            User: { id: '1' },
            Player: {},
          },
          {
            sessionKey: '2',
            title: 'Movie B',
            type: 'movie',
            User: { id: '1' },
            Player: {},
          },
        ],
      },
    };

    const sessions = parseSessionsResponse(response);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.media.type).toBe('track');
    expect(sessions[0]!.music?.artistName).toBe('Artist A');
    expect(sessions[1]!.media.type).toBe('movie');
    expect(sessions[1]!.music).toBeUndefined();
  });
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

describe('Plex Parser Edge Cases', () => {
  it('should handle null/undefined inputs gracefully', () => {
    expect(parseUsersResponse(null)).toEqual([]);
    expect(parseLibrariesResponse(null)).toEqual([]);
    expect(parseWatchHistoryResponse(null)).toEqual([]);
  });

  it('should throw for malformed session responses', () => {
    expect(() => parseSessionsResponse(null)).toThrow();
    expect(() => parseSessionsResponse(undefined)).toThrow();
  });

  it('should handle media type conversion', () => {
    expect(parseSession({ type: 'MOVIE', Player: {}, User: {} }).media.type).toBe('movie');
    expect(parseSession({ type: 'Episode', Player: {}, User: {} }).media.type).toBe('episode');
    expect(parseSession({ type: 'Track', Player: {}, User: {} }).media.type).toBe('track');
    expect(parseSession({ type: 'Photo', Player: {}, User: {} }).media.type).toBe('photo');
    expect(parseSession({ type: 'unknown_type', Player: {}, User: {} }).media.type).toBe('unknown');
  });

  it('should handle buffering state', () => {
    const session = parseSession({
      Player: { state: 'buffering' },
      User: {},
    });
    expect(session.playback.state).toBe('buffering');
  });

  it('should calculate progress percentage correctly', () => {
    // 50% progress
    const session1 = parseSession({
      duration: 10000,
      viewOffset: 5000,
      Player: {},
      User: {},
    });
    expect(session1.playback.progressPercent).toBe(50);

    // 0% progress (no duration)
    const session2 = parseSession({
      duration: 0,
      viewOffset: 5000,
      Player: {},
      User: {},
    });
    expect(session2.playback.progressPercent).toBe(0);

    // Cap at 100%
    const session3 = parseSession({
      duration: 10000,
      viewOffset: 15000,
      Player: {},
      User: {},
    });
    expect(session3.playback.progressPercent).toBe(100);
  });
});

// ============================================================================
// Original Media Metadata Parsing Tests (Issue #200 fix)
// ============================================================================

describe('Plex Original Media Metadata Parser', () => {
  describe('parseMediaMetadataResponse', () => {
    it('should parse complete media metadata response', () => {
      const rawResponse = {
        MediaContainer: {
          Metadata: [
            {
              Media: [
                {
                  bitrate: 24725,
                  width: 3832,
                  height: 1600,
                  container: 'mkv',
                  Part: [
                    {
                      Stream: [
                        {
                          streamType: 1, // Video
                          bitrate: 23957,
                          width: 3832,
                          height: 1600,
                          codec: 'hevc',
                          frameRate: '24.0',
                          bitDepth: 10,
                          colorSpace: 'bt2020nc',
                          profile: 'main 10',
                          level: '150',
                        },
                        {
                          streamType: 2, // Audio
                          bitrate: 768,
                          channels: 6,
                          codec: 'eac3',
                          audioChannelLayout: '5.1(side)',
                          language: 'English',
                          samplingRate: 48000,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };

      const result = parseMediaMetadataResponse(rawResponse);

      expect(result).not.toBeNull();
      expect(result!.videoBitrate).toBe(23957);
      expect(result!.audioBitrate).toBe(768);
      expect(result!.videoWidth).toBe(3832);
      expect(result!.videoHeight).toBe(1600);
      expect(result!.bitrate).toBe(24725);
      expect(result!.videoCodec).toBe('HEVC');
      expect(result!.audioCodec).toBe('EAC3');
      expect(result!.audioChannels).toBe(6);
      expect(result!.container).toBe('MKV');

      // Source video details
      expect(result!.sourceVideoDetails).toBeDefined();
      expect(result!.sourceVideoDetails!.bitrate).toBe(23957);
      expect(result!.sourceVideoDetails!.framerate).toBe('24.0');
      expect(result!.sourceVideoDetails!.colorDepth).toBe(10);
      expect(result!.sourceVideoDetails!.colorSpace).toBe('bt2020nc');
      expect(result!.sourceVideoDetails!.profile).toBe('main 10');
      expect(result!.sourceVideoDetails!.level).toBe('150');

      // Source audio details
      expect(result!.sourceAudioDetails).toBeDefined();
      expect(result!.sourceAudioDetails!.bitrate).toBe(768);
      expect(result!.sourceAudioDetails!.channelLayout).toBe('5.1(side)');
      expect(result!.sourceAudioDetails!.language).toBe('English');
      expect(result!.sourceAudioDetails!.sampleRate).toBe(48000);
    });

    it('should return null for empty response', () => {
      expect(parseMediaMetadataResponse({})).toBeNull();
      expect(parseMediaMetadataResponse({ MediaContainer: {} })).toBeNull();
      expect(parseMediaMetadataResponse({ MediaContainer: { Metadata: [] } })).toBeNull();
    });

    it('should return null when no Media array', () => {
      const response = {
        MediaContainer: {
          Metadata: [{ title: 'No Media' }],
        },
      };
      expect(parseMediaMetadataResponse(response)).toBeNull();
    });

    it('should select the selected Media version when multiple exist', () => {
      const rawResponse = {
        MediaContainer: {
          Metadata: [
            {
              Media: [
                {
                  bitrate: 50000, // 4K version
                  Part: [{ Stream: [{ streamType: 1, bitrate: 49000, codec: 'hevc' }] }],
                },
                {
                  bitrate: 10000, // 1080p version - SELECTED
                  selected: '1',
                  Part: [{ Stream: [{ streamType: 1, bitrate: 9500, codec: 'h264' }] }],
                },
              ],
            },
          ],
        },
      };

      const result = parseMediaMetadataResponse(rawResponse);

      expect(result).not.toBeNull();
      expect(result!.bitrate).toBe(10000);
      expect(result!.videoBitrate).toBe(9500);
      expect(result!.videoCodec).toBe('H264');
    });

    it('should select Media by targetMediaId when provided', () => {
      const rawResponse = {
        MediaContainer: {
          Metadata: [
            {
              Media: [
                {
                  id: 456,
                  bitrate: 50000,
                  selected: '1',
                  Part: [
                    {
                      Stream: [
                        { streamType: 1, bitrate: 49000, codec: 'hevc', width: 3840, height: 2160 },
                      ],
                    },
                  ],
                },
                {
                  id: 789,
                  bitrate: 10000,
                  Part: [
                    {
                      Stream: [
                        { streamType: 1, bitrate: 9500, codec: 'h264', width: 1920, height: 1080 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };

      const result = parseMediaMetadataResponse(rawResponse, '789');

      expect(result).not.toBeNull();
      expect(result!.bitrate).toBe(10000);
      expect(result!.videoBitrate).toBe(9500);
      expect(result!.videoCodec).toBe('H264');
      expect(result!.videoWidth).toBe(1920);
      expect(result!.videoHeight).toBe(1080);
    });

    it('should fall back to selected=1 when targetMediaId does not match', () => {
      const rawResponse = {
        MediaContainer: {
          Metadata: [
            {
              Media: [
                {
                  id: 456,
                  bitrate: 50000,
                  selected: '1',
                  Part: [
                    {
                      Stream: [
                        { streamType: 1, bitrate: 49000, codec: 'hevc', width: 3840, height: 2160 },
                      ],
                    },
                  ],
                },
                {
                  id: 789,
                  bitrate: 10000,
                  Part: [
                    {
                      Stream: [
                        { streamType: 1, bitrate: 9500, codec: 'h264', width: 1920, height: 1080 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };

      const result = parseMediaMetadataResponse(rawResponse, '999');

      expect(result).not.toBeNull();
      // Falls back to selected=1 (id: 456, 4K)
      expect(result!.bitrate).toBe(50000);
      expect(result!.videoWidth).toBe(3840);
    });
  });

  describe('getTranscodingSessionRatingKeys', () => {
    it('should return ratingKeys for transcoding sessions', () => {
      const sessionsResponse = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '123',
              TranscodeSession: { videoDecision: 'transcode', audioDecision: 'copy' },
            },
            {
              ratingKey: '456',
              TranscodeSession: { videoDecision: 'directplay', audioDecision: 'directplay' },
            },
            {
              ratingKey: '789',
              TranscodeSession: { videoDecision: 'copy', audioDecision: 'transcode' },
            },
          ],
        },
      };

      const keys = getTranscodingSessionRatingKeys(sessionsResponse);
      const ratingKeys = keys.map((k) => k.ratingKey);

      expect(ratingKeys).toContain('123'); // Video transcoding
      expect(ratingKeys).not.toContain('456'); // Direct play
      expect(ratingKeys).toContain('789'); // Audio transcoding
      expect(keys).toHaveLength(2);
    });

    it('should return empty array when no transcoding sessions', () => {
      const sessionsResponse = {
        MediaContainer: {
          Metadata: [
            { ratingKey: '123', TranscodeSession: { videoDecision: 'directplay' } },
            { ratingKey: '456' }, // No TranscodeSession at all
          ],
        },
      };

      const keys = getTranscodingSessionRatingKeys(sessionsResponse);

      expect(keys).toHaveLength(0);
    });

    it('should handle empty or invalid response', () => {
      expect(getTranscodingSessionRatingKeys({})).toEqual([]);
      expect(getTranscodingSessionRatingKeys({ MediaContainer: {} })).toEqual([]);
      expect(getTranscodingSessionRatingKeys(null)).toEqual([]);
    });

    it('should extract sessionMediaId from the selected Media element', () => {
      const sessionsResponse = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '123',
              TranscodeSession: { videoDecision: 'transcode', audioDecision: 'copy' },
              Media: [{ id: 456, selected: '1' }, { id: 789 }],
            },
            {
              ratingKey: '999',
              TranscodeSession: { videoDecision: 'transcode', audioDecision: 'copy' },
              // No Media array
            },
          ],
        },
      };

      const entries = getTranscodingSessionRatingKeys(sessionsResponse);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ ratingKey: '123', sessionMediaId: '456' });
      expect(entries[1]).toEqual({ ratingKey: '999', sessionMediaId: undefined });
    });
  });

  describe('parseSession with originalMedia (transcoding fix)', () => {
    it('should use originalMedia for source info when transcoding', () => {
      // Session data shows transcoded output (720p, 2.8 Mbps)
      const rawSession = {
        sessionKey: 'transcode-session',
        ratingKey: '12345',
        title: 'Predator: Badlands',
        type: 'movie',
        duration: 6444791,
        viewOffset: 268000,
        User: { id: '1', title: 'John' },
        Player: { title: 'Chrome', machineIdentifier: 'browser-1', state: 'playing' },
        Media: [
          {
            bitrate: 2849, // Transcoded bitrate
            width: 1278,
            height: 534,
            container: 'mp4',
            Part: [
              {
                Stream: [
                  {
                    streamType: 1,
                    bitrate: 2687, // Transcoded video bitrate
                    width: 1278,
                    height: 534,
                    codec: 'hevc',
                  },
                  {
                    streamType: 2,
                    bitrate: 162, // Transcoded audio bitrate
                    channels: 2,
                    codec: 'aac',
                  },
                ],
              },
            ],
          },
        ],
        TranscodeSession: {
          videoDecision: 'transcode',
          audioDecision: 'transcode',
          sourceVideoCodec: 'hevc',
          sourceAudioCodec: 'eac3',
          videoCodec: 'hevc',
          audioCodec: 'aac',
        },
      };

      // Original media from /library/metadata (4K source, ~24 Mbps)
      const originalMedia: PlexOriginalMedia = {
        videoBitrate: 23957,
        audioBitrate: 768,
        videoWidth: 3832,
        videoHeight: 1600,
        bitrate: 24725,
        videoCodec: 'HEVC',
        audioCodec: 'EAC3',
        audioChannels: 6,
        container: 'MKV',
        sourceVideoDetails: {
          bitrate: 23957,
          framerate: '24.0',
          dynamicRange: 'HDR10',
          colorDepth: 10,
          colorSpace: 'bt2020nc',
        },
        sourceAudioDetails: {
          bitrate: 768,
          channelLayout: '5.1(side)',
          language: 'English',
          sampleRate: 48000,
        },
      };

      const session = parseSession(rawSession, originalMedia);

      // Source info should come from originalMedia (4K source)
      expect(session.quality.videoWidth).toBe(3832);
      expect(session.quality.videoHeight).toBe(1600);
      expect(session.quality.sourceVideoDetails?.bitrate).toBe(23957);
      expect(session.quality.sourceAudioDetails?.bitrate).toBe(768);
      expect(session.quality.sourceVideoDetails?.dynamicRange).toBe('HDR10');
      expect(session.quality.sourceAudioDetails?.channelLayout).toBe('5.1(side)');

      // Stream info should come from session (transcoded 720p)
      expect(session.quality.streamVideoDetails?.width).toBe(1278);
      expect(session.quality.streamVideoDetails?.height).toBe(534);
      expect(session.quality.streamVideoDetails?.bitrate).toBe(2687);
      expect(session.quality.streamAudioDetails?.bitrate).toBe(162);

      // Codecs should be correct
      expect(session.quality.sourceVideoCodec).toBe('HEVC');
      expect(session.quality.sourceAudioCodec).toBe('EAC3');
      expect(session.quality.streamVideoCodec).toBe('HEVC');
      expect(session.quality.streamAudioCodec).toBe('AAC');

      // Transcode info should include source container
      expect(session.quality.transcodeInfo?.sourceContainer).toBe('MKV');
    });

    it('should use session data as source when not transcoding', () => {
      const rawSession = {
        sessionKey: 'direct-play',
        ratingKey: '67890',
        title: 'Direct Play Movie',
        type: 'movie',
        duration: 3600000,
        viewOffset: 0,
        User: { id: '1', title: 'John' },
        Player: { title: 'TV', machineIdentifier: 'tv-1', state: 'playing' },
        Media: [
          {
            bitrate: 10000,
            width: 1920,
            height: 1080,
            Part: [
              {
                Stream: [
                  { streamType: 1, bitrate: 9500, width: 1920, height: 1080, codec: 'h264' },
                  { streamType: 2, bitrate: 500, channels: 6, codec: 'dts' },
                ],
              },
            ],
          },
        ],
        TranscodeSession: { videoDecision: 'directplay', audioDecision: 'directplay' },
      };

      // Even with originalMedia provided, direct play should use session data
      const originalMedia: PlexOriginalMedia = {
        videoBitrate: 9500,
        audioBitrate: 500,
        videoWidth: 1920,
        videoHeight: 1080,
        bitrate: 10000,
      };

      const session = parseSession(rawSession, originalMedia);

      // For direct play, session data IS the source
      expect(session.quality.videoWidth).toBe(1920);
      expect(session.quality.videoHeight).toBe(1080);
      expect(session.quality.sourceVideoDetails?.bitrate).toBe(9500);
      expect(session.quality.sourceAudioDetails?.bitrate).toBe(500);
      expect(session.quality.isTranscode).toBe(false);
    });

    it('should fall back to session data when originalMedia not provided for transcode', () => {
      const rawSession = {
        sessionKey: 'transcode-no-metadata',
        ratingKey: '99999',
        title: 'Transcode Without Metadata',
        type: 'movie',
        duration: 3600000,
        viewOffset: 0,
        User: { id: '1', title: 'John' },
        Player: { title: 'Phone', machineIdentifier: 'phone-1', state: 'playing' },
        Media: [
          {
            bitrate: 3000,
            width: 1280,
            height: 720,
            Part: [
              {
                Stream: [
                  { streamType: 1, bitrate: 2800, width: 1280, height: 720, codec: 'h264' },
                  { streamType: 2, bitrate: 200, channels: 2, codec: 'aac' },
                ],
              },
            ],
          },
        ],
        TranscodeSession: {
          videoDecision: 'transcode',
          audioDecision: 'transcode',
          sourceVideoCodec: 'hevc',
          sourceAudioCodec: 'truehd',
        },
      };

      // No originalMedia provided
      const session = parseSession(rawSession);

      // Should still work, using session data (which shows transcoded output)
      expect(session.quality.videoWidth).toBe(1280);
      expect(session.quality.videoHeight).toBe(720);
      expect(session.quality.sourceVideoCodec).toBe('HEVC'); // From TranscodeSession
      expect(session.quality.sourceAudioCodec).toBe('TRUEHD'); // From TranscodeSession
      expect(session.quality.isTranscode).toBe(true);
    });
  });
});

// ============================================================================
// Library Item Parsing Tests (Plan 02-02)
// ============================================================================

describe('Plex Library Item Parser', () => {
  describe('parseLibraryItemsResponse', () => {
    it('should parse movie with new agent GUIDs', () => {
      const response = {
        MediaContainer: {
          totalSize: 1,
          Metadata: [
            {
              ratingKey: '12345',
              title: 'Inception',
              type: 'movie',
              year: 2010,
              addedAt: 1609459200, // 2021-01-01
              guid: 'plex://movie/5d7768264de0ee001fcc87e0', // Internal ID - should be ignored
              Guid: [{ id: 'imdb://tt1375666' }, { id: 'tmdb://27205' }, { id: 'tvdb://12345' }],
              thumb: '/library/metadata/12345/thumb/1700000000',
              Media: [
                {
                  videoResolution: '4k',
                  videoCodec: 'hevc',
                  audioCodec: 'truehd',
                  audioChannels: 8,
                  container: 'mkv',
                  Part: [{ size: 45000000000, file: '/movies/Inception/Inception (2010).mkv' }],
                },
              ],
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.ratingKey).toBe('12345');
      expect(item.title).toBe('Inception');
      expect(item.mediaType).toBe('movie');
      expect(item.year).toBe(2010);
      expect(item.imdbId).toBe('tt1375666');
      expect(item.tmdbId).toBe(27205);
      expect(item.tvdbId).toBe(12345);
      expect(item.videoResolution).toBe('4k');
      expect(item.videoCodec).toBe('HEVC');
      expect(item.audioCodec).toBe('TRUEHD');
      expect(item.audioChannels).toBe(8);
      expect(item.fileSize).toBe(45000000000);
      expect(item.container).toBe('mkv');
      expect(item.filePath).toBe('/movies/Inception/Inception (2010).mkv');
      expect(item.thumbPath).toBe('/library/metadata/12345/thumb/1700000000');
    });

    it('reads Atmos from the media audio profile and the edition from the item', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '1',
              title: 'Aliens',
              type: 'movie',
              addedAt: 1609459200,
              editionTitle: 'Extended Cut',
              Media: [{ id: 5, audioCodec: 'truehd', audioProfile: 'dolby truehd + dolby atmos' }],
            },
          ],
        },
      };

      const version = parseLibraryItemsResponse(response)[0]!.versions?.[0];

      expect(version?.audioAtmos).toBe(true);
      expect(version?.editionTitle).toBe('Extended Cut');
    });

    it('leaves thumbPath undefined when the item has no thumb', () => {
      const response = {
        MediaContainer: {
          Metadata: [{ ratingKey: '1', title: 'No Poster', type: 'movie', addedAt: 1609459200 }],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items[0]!.thumbPath).toBeUndefined();
    });

    it('parses Genre tags into genres', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '1',
              title: 'X',
              type: 'movie',
              addedAt: 1609459200,
              Genre: [{ tag: 'Action' }, { tag: 'Crime' }],
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items[0]!.genres).toEqual(['Action', 'Crime']);
    });

    it('should normalize video resolution with p suffix', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '1',
              title: 'Movie 1080',
              type: 'movie',
              addedAt: 1609459200,
              Media: [{ videoResolution: '1080' }],
            },
            {
              ratingKey: '2',
              title: 'Movie 720',
              type: 'movie',
              addedAt: 1609459200,
              Media: [{ videoResolution: '720' }],
            },
            {
              ratingKey: '3',
              title: 'Movie SD',
              type: 'movie',
              addedAt: 1609459200,
              Media: [{ videoResolution: 'sd' }],
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items[0]!.videoResolution).toBe('1080p');
      expect(items[1]!.videoResolution).toBe('720p');
      expect(items[2]!.videoResolution).toBe('sd');
    });

    it('normalizes videoDynamicRange from the Media element', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '1',
              title: 'HDR10 Movie',
              type: 'movie',
              addedAt: 1609459200,
              Media: [{ videoDynamicRange: 'HDR10' }],
            },
            {
              ratingKey: '2',
              title: 'Dolby Vision Movie',
              type: 'movie',
              addedAt: 1609459200,
              Media: [{ videoDynamicRange: 'Dolby Vision' }],
            },
            {
              ratingKey: '3',
              title: 'SDR Movie',
              type: 'movie',
              addedAt: 1609459200,
              Media: [{ videoDynamicRange: 'SDR' }],
            },
            {
              ratingKey: '4',
              title: 'No Media Element',
              type: 'movie',
              addedAt: 1609459200,
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items[0]!.videoDynamicRange).toBe('hdr10');
      expect(items[1]!.videoDynamicRange).toBe('dolby vision');
      expect(items[2]!.videoDynamicRange).toBe('sdr');
      expect(items[3]!.videoDynamicRange).toBeUndefined();
    });

    it('should parse episode with show hierarchy', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '67890',
              title: 'Pilot',
              type: 'episode',
              grandparentTitle: 'Breaking Bad',
              grandparentRatingKey: '11111',
              parentIndex: 1,
              index: 1,
              addedAt: 1609459200,
              Guid: [{ id: 'imdb://tt0959621' }, { id: 'tmdb://62085' }, { id: 'tvdb://349232' }],
              Media: [
                {
                  videoResolution: '1080',
                  videoCodec: 'h264',
                  Part: [{ size: 3500000000 }],
                },
              ],
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.mediaType).toBe('episode');
      expect(item.grandparentTitle).toBe('Breaking Bad');
      expect(item.grandparentRatingKey).toBe('11111');
      expect(item.parentIndex).toBe(1);
      expect(item.itemIndex).toBe(1);
      expect(item.imdbId).toBe('tt0959621');
      expect(item.tmdbId).toBe(62085);
      expect(item.tvdbId).toBe(349232);
    });

    it('should parse music track with artist and album', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '99999',
              title: 'Bohemian Rhapsody',
              type: 'track',
              grandparentTitle: 'Queen', // Artist
              parentTitle: 'A Night at the Opera', // Album
              index: 11, // Track number
              addedAt: 1609459200,
              Media: [
                {
                  audioCodec: 'flac',
                  audioChannels: 2,
                  Part: [{ size: 50000000 }],
                },
              ],
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.mediaType).toBe('track');
      expect(item.grandparentTitle).toBe('Queen');
      expect(item.parentTitle).toBe('A Night at the Opera');
      expect(item.itemIndex).toBe(11);
      expect(item.audioCodec).toBe('FLAC');
      expect(item.audioChannels).toBe(2);
    });

    it('should handle missing optional fields gracefully', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '55555',
              title: 'Minimal Movie',
              type: 'movie',
              // No year, no addedAt, no Guid, no Media
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.ratingKey).toBe('55555');
      expect(item.title).toBe('Minimal Movie');
      expect(item.mediaType).toBe('movie');
      expect(item.year).toBeUndefined();
      expect(item.imdbId).toBeUndefined();
      expect(item.tmdbId).toBeUndefined();
      expect(item.tvdbId).toBeUndefined();
      expect(item.videoResolution).toBeUndefined();
      expect(item.videoCodec).toBeUndefined();
      expect(item.fileSize).toBeUndefined();
      expect(item.addedAt).toBeInstanceOf(Date); // Should have a fallback date
    });

    it('should handle empty MediaContainer', () => {
      expect(parseLibraryItemsResponse({})).toEqual([]);
      expect(parseLibraryItemsResponse({ MediaContainer: {} })).toEqual([]);
      expect(parseLibraryItemsResponse({ MediaContainer: { Metadata: [] } })).toEqual([]);
      expect(parseLibraryItemsResponse(null)).toEqual([]);
    });

    it('should parse TV show type correctly', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '22222',
              title: 'Breaking Bad',
              type: 'show',
              year: 2008,
              addedAt: 1609459200,
              Guid: [{ id: 'imdb://tt0903747' }, { id: 'tmdb://1396' }, { id: 'tvdb://81189' }],
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.mediaType).toBe('show');
      expect(item.imdbId).toBe('tt0903747');
      expect(item.tmdbId).toBe(1396);
      expect(item.tvdbId).toBe(81189);
    });

    it('should map photo type correctly', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '44444',
              title: 'Vacation Photos',
              type: 'photo',
              addedAt: 1609459200,
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items).toHaveLength(1);
      expect(items[0]!.mediaType).toBe('photo');
    });

    it('should ignore invalid external ID formats', () => {
      const response = {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: '33333',
              title: 'Test Movie',
              type: 'movie',
              addedAt: 1609459200,
              Guid: [
                { id: 'plex://movie/internal' }, // Should be ignored
                { id: 'imdb://tt1234567' }, // Valid
                { id: 'tmdb://notanumber' }, // Invalid - not a number
                { id: 'unknown://12345' }, // Unknown provider - ignored
              ],
            },
          ],
        },
      };

      const items = parseLibraryItemsResponse(response);

      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.imdbId).toBe('tt1234567');
      expect(item.tmdbId).toBeUndefined(); // Invalid number parsed as NaN
      expect(item.tvdbId).toBeUndefined();
    });
  });
});

describe('multi-version library items', () => {
  const covenantResponse = () => ({
    MediaContainer: {
      Metadata: [
        {
          ratingKey: '683',
          title: 'The Covenant',
          type: 'movie',
          addedAt: 1700000000,
          Media: [
            {
              id: 3207,
              videoResolution: '4k',
              videoCodec: 'hevc',
              audioCodec: 'eac3',
              audioChannels: 6,
              bitrate: 15512,
              container: 'mkv',
              Part: [{ size: 13330000000, file: '/data/a.mkv' }],
            },
            {
              id: 98869,
              videoResolution: '1080',
              videoCodec: 'h264',
              audioCodec: 'aac',
              audioChannels: 2,
              bitrate: 10000,
              container: 'mkv',
              Part: [
                { size: 2000000000, file: '/data/b-cd1.mkv' },
                { size: 2100000000, file: '/data/b-cd2.mkv' },
              ],
            },
          ],
        },
      ],
    },
  });

  it('parses every Media child as a version, summing multi-part sizes', () => {
    const [item] = parseLibraryItemsResponse(covenantResponse());

    expect(item!.versions).toHaveLength(2);
    expect(item!.versions![0]).toMatchObject({
      serverVersionKey: '3207',
      videoResolution: '4k',
      videoCodec: 'HEVC',
      bitrate: 15512,
      fileSize: 13330000000,
      partCount: 1,
      filePath: '/data/a.mkv',
    });
    expect(item!.versions![1]).toMatchObject({
      serverVersionKey: '98869',
      videoResolution: '1080p',
      fileSize: 4100000000,
      partCount: 2,
      filePath: '/data/b-cd1.mkv',
    });
  });

  it('rolls up size as the sum and quality from the best version', () => {
    const [item] = parseLibraryItemsResponse(covenantResponse());

    expect(item!.fileSize).toBe(13330000000 + 4100000000);
    expect(item!.videoResolution).toBe('4k');
    expect(item!.videoCodec).toBe('HEVC');
    expect(item!.audioChannels).toBe(6);
    expect(item!.filePath).toBe('/data/a.mkv');
    expect(item!.versionsFingerprint).toBeTruthy();
  });

  it('fingerprint is stable across Media order', () => {
    const forward = parseLibraryItemsResponse(covenantResponse());
    const response = covenantResponse();
    response.MediaContainer.Metadata[0]!.Media.reverse();
    const reversed = parseLibraryItemsResponse(response);

    expect(forward[0]!.versionsFingerprint).toBe(reversed[0]!.versionsFingerprint);
  });

  it('containers with no Media produce an empty version list', () => {
    const [item] = parseLibraryItemsResponse({
      MediaContainer: {
        Metadata: [{ ratingKey: '10', title: 'A Show', type: 'show', addedAt: 1700000000 }],
      },
    });

    expect(item!.versions).toEqual([]);
    expect(item!.fileSize).toBeUndefined();
    expect(item!.versionsFingerprint).toBeTruthy();
  });
});

describe('findStreamByType', () => {
  it('picks the selected stream when the JSON API sends boolean selected', () => {
    const part = {
      Stream: [
        { streamType: 2, codec: 'eac3', language: 'eng' },
        { streamType: 2, codec: 'aac', language: 'jpn', selected: true },
      ],
    };

    const result = findStreamByType(part, STREAM_TYPE.AUDIO);

    expect(result?.codec).toBe('aac');
    expect(result?.language).toBe('jpn');
  });

  it('picks the selected stream with string selected', () => {
    const part = {
      Stream: [
        { streamType: 3, codec: 'srt', selected: '1' },
        { streamType: 2, codec: 'eac3' },
      ],
    };

    expect(findStreamByType(part, STREAM_TYPE.SUBTITLE)?.codec).toBe('srt');
  });

  it('falls back to the first matching stream when none are selected', () => {
    const part = {
      Stream: [
        { streamType: 1, codec: 'hevc' },
        { streamType: 2, codec: 'eac3' },
        { streamType: 2, codec: 'aac' },
      ],
    };

    expect(findStreamByType(part, STREAM_TYPE.AUDIO)?.codec).toBe('eac3');
  });
});

describe('parseStatisticsResourcesResponse', () => {
  it('maps fields and sorts newest first', () => {
    const response = {
      MediaContainer: {
        size: 2,
        StatisticsResources: [
          {
            timespan: 6,
            at: 1786145458,
            hostCpuUtilization: 1.2,
            processCpuUtilization: 0.01,
            hostMemoryUtilization: 12.0,
            processMemoryUtilization: 0.3,
          },
          {
            timespan: 6,
            at: 1786145464,
            hostCpuUtilization: 2.757,
            processCpuUtilization: 0.025,
            hostMemoryUtilization: 12.41,
            processMemoryUtilization: 0.371,
          },
        ],
      },
    };

    const points = parseStatisticsResourcesResponse(response);

    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      timespan: 6,
      at: 1786145464,
      hostCpuUtilization: 2.757,
      processCpuUtilization: 0.025,
      hostMemoryUtilization: 12.41,
      processMemoryUtilization: 0.371,
    });
    expect(points[1]?.at).toBe(1786145458);
  });

  it('returns empty for malformed input', () => {
    expect(parseStatisticsResourcesResponse(null)).toEqual([]);
    expect(parseStatisticsResourcesResponse({})).toEqual([]);
    expect(parseStatisticsResourcesResponse({ MediaContainer: {} })).toEqual([]);
  });
});

describe('parseStatisticsBandwidthResponse', () => {
  const response = {
    MediaContainer: {
      size: 3,
      Account: [
        { id: 1, key: '/accounts/1', name: 'Gallapagos', thumb: 'https://plex.tv/users/a/avatar' },
        { id: 99, key: '/accounts/99', name: 'Unreferenced' },
      ],
      Device: [
        { id: 1, name: 'Chromecast', platform: 'Chromecast', clientIdentifier: '' },
        { id: 382, name: 'Web Player', platform: 'Chrome' },
        { id: 777, name: 'Stale Device', platform: 'iOS' },
      ],
      StatisticsBandwidth: [
        { accountID: 1577033, deviceID: 260, timespan: 6, at: 100, lan: false, bytes: 22 },
        { accountID: 1, deviceID: 1, timespan: 6, at: 101, lan: true, bytes: 28 },
        { accountID: 1, deviceID: 382, timespan: 6, at: 101, lan: false, bytes: 729 },
      ],
    },
  };

  it('keeps per-account/device samples sorted newest first', () => {
    const { samples } = parseStatisticsBandwidthResponse(response);

    expect(samples).toEqual([
      { at: 101, accountId: 1, deviceId: 1, lan: true, bytes: 28 },
      { at: 101, accountId: 1, deviceId: 382, lan: false, bytes: 729 },
      { at: 100, accountId: 1577033, deviceId: 260, lan: false, bytes: 22 },
    ]);
  });

  it('aggregates points per timestamp with lan/wan split and timespan normalized to 1', () => {
    const { points } = parseStatisticsBandwidthResponse(response);

    expect(points).toEqual([
      { at: 101, timespan: 1, lanBytes: 28, wanBytes: 729 },
      { at: 100, timespan: 1, lanBytes: 0, wanBytes: 22 },
    ]);
  });

  it('filters account and device maps to ids referenced by samples', () => {
    const { accounts, devices } = parseStatisticsBandwidthResponse(response);

    expect(accounts).toEqual([
      { id: 1, name: 'Gallapagos', thumb: 'https://plex.tv/users/a/avatar' },
    ]);
    expect(devices).toEqual([
      { id: 1, name: 'Chromecast', platform: 'Chromecast' },
      { id: 382, name: 'Web Player', platform: 'Chrome' },
    ]);
  });

  it('returns empty structure for malformed input', () => {
    const empty = { points: [], samples: [], accounts: [], devices: [] };
    expect(parseStatisticsBandwidthResponse(null)).toEqual(empty);
    expect(parseStatisticsBandwidthResponse({})).toEqual(empty);
    expect(parseStatisticsBandwidthResponse({ MediaContainer: {} })).toEqual(empty);
  });
});

describe('transcode progress fields', () => {
  const buildSession = (transcodeSession: Record<string, unknown>) => ({
    MediaContainer: {
      Metadata: [
        {
          sessionKey: 'tk-1',
          ratingKey: '55',
          title: 'Movie',
          type: 'movie',
          User: { id: '1', title: 'Alice' },
          Player: { title: 'TV', machineIdentifier: 'tv1', state: 'playing' },
          TranscodeSession: transcodeSession,
          Media: [{ id: 1, selected: '1', container: 'mkv', Part: [{ container: 'mkv' }] }],
        },
      ],
    },
  });

  it('parses progress, maxOffsetAvailable, speed, and json-boolean throttled', () => {
    const sessions = parseSessionsResponse(
      buildSession({
        videoDecision: 'transcode',
        audioDecision: 'copy',
        speed: 1.8,
        throttled: true,
        progress: 42.5,
        maxOffsetAvailable: 913.4,
        container: 'mkv',
      })
    );

    const info = sessions[0]?.quality.transcodeInfo;
    expect(info?.progress).toBe(42.5);
    expect(info?.maxOffsetAvailable).toBe(913.4);
    expect(info?.speed).toBe(1.8);
    expect(info?.throttled).toBe(true);
  });

  it('parses xml-style throttled and keeps progress 0', () => {
    const sessions = parseSessionsResponse(
      buildSession({
        videoDecision: 'transcode',
        throttled: '1',
        progress: 0,
      })
    );

    const info = sessions[0]?.quality.transcodeInfo;
    expect(info?.throttled).toBe(true);
    expect(info?.progress).toBe(0);
  });

  it('omits progress fields when absent', () => {
    const sessions = parseSessionsResponse(
      buildSession({ videoDecision: 'transcode', container: 'mp4' })
    );

    const info = sessions[0]?.quality.transcodeInfo;
    expect(info?.progress).toBeUndefined();
    expect(info?.maxOffsetAvailable).toBeUndefined();
  });
});
