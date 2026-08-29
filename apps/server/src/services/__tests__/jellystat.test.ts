/**
 * Jellystat Import Service Tests
 *
 * Comprehensive tests covering:
 * - Zod schema validation against Jellystat backup structures
 * - Backup parsing and validation
 * - Activity to session transformation
 * - Duration/tick conversions
 * - GeoIP integration
 * - User matching logic
 * - Progress tracking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import production functions for testing
import {
  parseJellystatBackup,
  transformActivityToSession,
  importJellystatBackup,
  extractJellystatStreamDetails,
} from '../jellystat.js';

// Import schemas for validation tests
import {
  jellystatPlaybackActivitySchema,
  jellystatBackupSchema,
  jellystatPlayStateSchema,
  jellystatTranscodingInfoSchema,
} from '@tracearr/shared';
import type { JellystatPlaybackActivity } from '@tracearr/shared';

// ============================================================================
// TEST DATA - Jellystat backup structure
// ============================================================================

// Movie activity (DirectPlay, completed)
const MOVIE_ACTIVITY = {
  Id: '1001',
  IsPaused: null,
  UserId: 'a91468af8ed947e0add77f191736dab5',
  UserName: 'TestUser',
  Client: 'Jellyfin Web',
  DeviceName: 'Samsung TV',
  DeviceId: 'TW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDtXaW4',
  ApplicationVersion: null,
  NowPlayingItemId: 'e5a547eef1d6ed70045cc4bc83e0dad5',
  NowPlayingItemName: 'The Matrix',
  SeasonId: null,
  SeriesName: null,
  EpisodeId: null,
  PlaybackDuration: '7200',
  ActivityDateInserted: '2024-12-15T10:30:00.000Z',
  PlayMethod: 'DirectPlay' as const,
  MediaStreams: null,
  TranscodingInfo: null,
  PlayState: {
    IsPaused: false,
    IsMuted: null,
    VolumeLevel: null,
    RepeatMode: null,
    PlaybackOrder: null,
    PositionTicks: 72000000000,
    RuntimeTicks: 81000000000,
    PercentComplete: 88,
    IsActive: null,
    Completed: true,
    CanSeek: true,
    IsStalled: false,
  },
  OriginalContainer: null,
  RemoteEndPoint: '73.160.197.140',
  ServerId: '1',
  imported: false,
};

// Episode activity (Transcode, not completed)
const EPISODE_ACTIVITY = {
  Id: '1002',
  IsPaused: null,
  UserId: 'a91468af8ed947e0add77f191736dab5',
  UserName: 'TestUser',
  Client: 'Jellyfin iOS',
  DeviceName: 'iPhone',
  DeviceId: 'aW9zLWRldmljZS1pZC0xMjM0NTY3ODkw',
  ApplicationVersion: '10.8.0',
  NowPlayingItemId: 'd939b68baceb6abb85bd879250c54a7b',
  NowPlayingItemName: 'The One Where They All Turn Thirty',
  SeasonId: 'c715c2ef4cf928fa47b361f4b7723572',
  SeriesName: 'Friends',
  EpisodeId: 'd939b68baceb6abb85bd879250c54a7b',
  PlaybackDuration: '1350',
  ActivityDateInserted: '2024-12-14T22:15:00.000Z',
  PlayMethod: 'Transcode' as const,
  MediaStreams: null,
  TranscodingInfo: {
    AudioCodec: 'aac',
    VideoCodec: 'h264',
    Container: 'ts',
    IsVideoDirect: false,
    IsAudioDirect: false,
    Bitrate: 3500000,
    CompletionPercentage: null,
    Width: 1920,
    Height: 1080,
    AudioChannels: 2,
    HardwareAccelerationType: null,
    TranscodeReasons: ['ContainerBitrateExceedsLimit'],
  },
  PlayState: {
    IsPaused: false,
    IsMuted: null,
    VolumeLevel: null,
    RepeatMode: null,
    PlaybackOrder: null,
    PositionTicks: 13500000000,
    RuntimeTicks: 14400000000,
    PercentComplete: 93,
    IsActive: null,
    Completed: false,
    CanSeek: true,
    IsStalled: false,
  },
  OriginalContainer: null,
  RemoteEndPoint: '104.128.161.124',
  ServerId: '1',
  imported: false,
};

// Activity with null PlayState and minimal data
const MINIMAL_ACTIVITY = {
  Id: '1003',
  IsPaused: null,
  UserId: 'b82579cf9de048e1bc88f292847eab6c',
  UserName: null,
  Client: 'Jellyfin Roku',
  DeviceName: 'Roku',
  DeviceId: 'cm9rdS1kZXZpY2UtaWQtYWJjZGVm',
  ApplicationVersion: null,
  NowPlayingItemId: 'c824f5ae3d1b49d8a9e2f0c4b7d6e5a3',
  NowPlayingItemName: 'Interstellar',
  SeasonId: null,
  SeriesName: null,
  EpisodeId: null,
  PlaybackDuration: '3600',
  ActivityDateInserted: '2024-12-13T15:00:00.000Z',
  PlayMethod: 'DirectStream' as const,
  MediaStreams: null,
  TranscodingInfo: null,
  PlayState: null,
  OriginalContainer: null,
  RemoteEndPoint: null,
  ServerId: '1',
  imported: false,
};

// Activity with RuntimeTicks = 0 (tests falsy value handling)
const ZERO_RUNTIME_ACTIVITY = {
  Id: '1004',
  IsPaused: null,
  UserId: 'a91468af8ed947e0add77f191736dab5',
  UserName: null,
  Client: 'Jellyfin Web',
  DeviceName: 'Opera',
  DeviceId: 'TW96aWxsYS81LjAgKFdpbmRvd3MgTlQxMC4w',
  ApplicationVersion: null,
  NowPlayingItemId: 'e5a547eef1d6ed70045cc4bc83e0dad5',
  NowPlayingItemName: 'Pilot',
  SeasonId: 'c715c2ef4cf928fa47b361f4b7723572',
  SeriesName: 'Code Black',
  EpisodeId: 'd939b68baceb6abb85bd879250c54a7b',
  PlaybackDuration: '1079',
  ActivityDateInserted: '2025-04-05T10:40:28.000Z',
  PlayMethod: 'Transcode' as const,
  MediaStreams: null,
  TranscodingInfo: {
    AudioCodec: null,
    VideoCodec: null,
    Container: null,
    IsVideoDirect: null,
    IsAudioDirect: null,
    Bitrate: null,
    CompletionPercentage: null,
    Width: null,
    Height: null,
    AudioChannels: null,
    HardwareAccelerationType: null,
    TranscodeReasons: [],
  },
  PlayState: {
    IsPaused: null,
    IsMuted: null,
    VolumeLevel: null,
    RepeatMode: null,
    PlaybackOrder: null,
    PositionTicks: 1093790,
    RuntimeTicks: 0, // Zero - tests falsy value bug fix
    PercentComplete: 0,
    IsActive: null,
    Completed: false,
    CanSeek: true,
    IsStalled: false,
  },
  OriginalContainer: null,
  RemoteEndPoint: null,
  ServerId: '1',
  imported: false,
};

// Backup structures
const VALID_BACKUP_SINGLE = [{ jf_playback_activity: [MOVIE_ACTIVITY] }];
const VALID_BACKUP_MULTIPLE = [
  { jf_playback_activity: [MOVIE_ACTIVITY, EPISODE_ACTIVITY, MINIMAL_ACTIVITY] },
];
const EMPTY_BACKUP = [{ jf_playback_activity: [] }];

// ============================================================================
// SCHEMA VALIDATION TESTS
// ============================================================================

describe('jellystatPlayStateSchema', () => {
  it('should validate a complete PlayState object', () => {
    const playState = {
      IsPaused: false,
      PositionTicks: 72000000000,
      RuntimeTicks: 81000000000,
      Completed: true,
    };
    const result = jellystatPlayStateSchema.safeParse(playState);
    expect(result.success).toBe(true);
  });

  it('should validate PlayState with only some fields', () => {
    const playState = {
      Completed: false,
    };
    const result = jellystatPlayStateSchema.safeParse(playState);
    expect(result.success).toBe(true);
  });

  it('should validate empty PlayState', () => {
    const result = jellystatPlayStateSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('jellystatTranscodingInfoSchema', () => {
  it('should validate TranscodingInfo with Bitrate', () => {
    const info = { Bitrate: 5000000 };
    const result = jellystatTranscodingInfoSchema.safeParse(info);
    expect(result.success).toBe(true);
  });

  it('should validate empty TranscodingInfo', () => {
    const result = jellystatTranscodingInfoSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('jellystatPlaybackActivitySchema', () => {
  describe('movie activity', () => {
    it('should validate movie activity record', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(MOVIE_ACTIVITY);
      expect(result.success).toBe(true);
    });

    it('should handle null SeriesName for movies', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(MOVIE_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SeriesName).toBeNull();
      }
    });
  });

  describe('episode activity', () => {
    it('should validate episode activity record', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(EPISODE_ACTIVITY);
      expect(result.success).toBe(true);
    });

    it('should preserve SeriesName for episodes', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(EPISODE_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SeriesName).toBe('Friends');
      }
    });

    it('should preserve TranscodingInfo for transcoded content', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(EPISODE_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.TranscodingInfo?.Bitrate).toBe(3500000);
      }
    });
  });

  describe('partial/minimal activity', () => {
    it('should validate activity with minimal fields', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(MINIMAL_ACTIVITY);
      expect(result.success).toBe(true);
    });

    it('should handle null UserName', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(MINIMAL_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.UserName).toBeNull();
      }
    });

    it('should handle null RemoteEndPoint', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(MINIMAL_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.RemoteEndPoint).toBeNull();
      }
    });

    it('should handle string PlaybackDuration', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(MINIMAL_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PlaybackDuration).toBe('3600');
      }
    });
  });

  describe('edge cases', () => {
    it('should reject activity missing required Id', () => {
      const invalidActivity = { ...MOVIE_ACTIVITY };
      delete (invalidActivity as any).Id;
      const result = jellystatPlaybackActivitySchema.safeParse(invalidActivity);
      expect(result.success).toBe(false);
    });

    it('should reject activity missing required UserId', () => {
      const invalidActivity = { ...MOVIE_ACTIVITY };
      delete (invalidActivity as any).UserId;
      const result = jellystatPlaybackActivitySchema.safeParse(invalidActivity);
      expect(result.success).toBe(false);
    });
  });

  describe('passthrough and nullable fields', () => {
    it('should validate with all extra fields via passthrough', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(ZERO_RUNTIME_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        // Core fields preserved
        expect(result.data.Id).toBe('1004');
        expect(result.data.SeriesName).toBe('Code Black');
        // Extra fields passed through
        expect((result.data as any).ApplicationVersion).toBeNull();
        expect((result.data as any).MediaStreams).toBeNull();
        expect((result.data as any).ServerId).toBe('1');
        expect((result.data as any).imported).toBe(false);
      }
    });

    it('should handle null PlayState (nullable().optional())', () => {
      // MINIMAL_ACTIVITY has PlayState: null
      const result = jellystatPlaybackActivitySchema.safeParse(MINIMAL_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PlayState).toBeNull();
      }
    });

    it('should handle top-level IsPaused field', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(MOVIE_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.IsPaused).toBeNull();
      }
    });

    it('should preserve PlayState extra fields via passthrough', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(MOVIE_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.PlayState?.IsMuted).toBeNull();
        expect(result.data.PlayState?.CanSeek).toBe(true);
        expect(result.data.PlayState?.IsStalled).toBe(false);
      }
    });

    it('should preserve TranscodingInfo extra fields via passthrough', () => {
      const result = jellystatPlaybackActivitySchema.safeParse(ZERO_RUNTIME_ACTIVITY);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.TranscodingInfo?.AudioCodec).toBeNull();
        expect(result.data.TranscodingInfo?.VideoCodec).toBeNull();
        expect((result.data.TranscodingInfo as any)?.TranscodeReasons).toEqual([]);
      }
    });
  });
});

describe('jellystatBackupSchema', () => {
  it('should validate a backup with single activity', () => {
    const result = jellystatBackupSchema.safeParse(VALID_BACKUP_SINGLE);
    expect(result.success).toBe(true);
  });

  it('should validate a backup with multiple activities', () => {
    const result = jellystatBackupSchema.safeParse(VALID_BACKUP_MULTIPLE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0]?.jf_playback_activity?.length).toBe(3);
    }
  });

  it('should validate an empty backup', () => {
    const result = jellystatBackupSchema.safeParse(EMPTY_BACKUP);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0]?.jf_playback_activity?.length).toBe(0);
    }
  });

  it('should validate backup with missing jf_playback_activity', () => {
    const backupWithoutActivity = [{}];
    const result = jellystatBackupSchema.safeParse(backupWithoutActivity);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0]?.jf_playback_activity).toBeUndefined();
    }
  });

  it('should validate empty array backup', () => {
    const result = jellystatBackupSchema.safeParse([]);
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// BACKUP PARSING TESTS
// ============================================================================

describe('parseJellystatBackup', () => {
  it('should parse valid backup with activities', () => {
    const json = JSON.stringify(VALID_BACKUP_MULTIPLE);
    const activities = parseJellystatBackup(json);
    expect(activities).toHaveLength(3);
    // parseJellystatBackup returns unknown[] for deferred validation
    expect((activities[0] as Record<string, unknown>)?.Id).toBe(MOVIE_ACTIVITY.Id);
  });

  it('should return empty array for empty backup', () => {
    const json = JSON.stringify(EMPTY_BACKUP);
    const activities = parseJellystatBackup(json);
    expect(activities).toHaveLength(0);
  });

  it('should return empty array when jf_playback_activity is missing', () => {
    const json = JSON.stringify([{}]);
    const activities = parseJellystatBackup(json);
    expect(activities).toHaveLength(0);
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseJellystatBackup('not valid json')).toThrow();
  });

  it('should throw on invalid backup structure', () => {
    const invalidBackup = { not: 'an array' };
    expect(() => parseJellystatBackup(JSON.stringify(invalidBackup))).toThrow(
      /Invalid Jellystat backup format/
    );
  });
});

// ============================================================================
// TRANSFORMATION TESTS
// ============================================================================

describe('extractJellystatStreamDetails', () => {
  it('should thread TranscodeReasons into transcodeInfo.reasons', () => {
    const result = extractJellystatStreamDetails(null, {
      VideoCodec: 'h264',
      AudioCodec: 'aac',
      Container: 'ts',
      IsVideoDirect: false,
      IsAudioDirect: false,
      HardwareAccelerationType: null,
      TranscodeReasons: ['ContainerBitrateExceedsLimit'],
    });

    expect(result.transcodeInfo?.reasons).toEqual(['ContainerBitrateExceedsLimit']);
  });

  it('should trim, drop empty strings, and dedupe TranscodeReasons', () => {
    const result = extractJellystatStreamDetails(null, {
      TranscodeReasons: [
        ' VideoCodecNotSupported ',
        'ContainerBitrateExceedsLimit',
        '',
        'VideoCodecNotSupported',
      ],
    });

    expect(result.transcodeInfo?.reasons).toEqual([
      'VideoCodecNotSupported',
      'ContainerBitrateExceedsLimit',
    ]);
  });

  it('should leave transcodeInfo.reasons absent when TranscodeReasons is empty or missing', () => {
    const noReasons = extractJellystatStreamDetails(null, {
      TranscodeReasons: [],
      Container: 'ts',
    });
    expect(noReasons.transcodeInfo?.reasons).toBeUndefined();
    expect(noReasons.transcodeInfo?.streamContainer).toBe('ts');

    const noTranscoding = extractJellystatStreamDetails(null, null);
    expect(noTranscoding.transcodeInfo).toBeNull();
  });

  it('should coercively handle non-string TranscodeReasons elements', () => {
    // The interface types TranscodeReasons as string[], but Jellystat backups are
    // not schema-validated at this layer, so a malformed backup could carry
    // non-string entries. parseString() coerces them defensively.
    const result = extractJellystatStreamDetails(null, {
      TranscodeReasons: [
        'ContainerBitrateExceedsLimit',
        null,
        undefined,
        42,
      ] as unknown as string[],
    });

    expect(result.transcodeInfo?.reasons).toEqual(['ContainerBitrateExceedsLimit', '42']);
  });
});

describe('transformActivityToSession', () => {
  // Mock GeoIP result
  const mockGeo = {
    city: 'Jersey City',
    region: 'New Jersey',
    country: 'US',
    countryCode: 'US',
    continent: 'North America',
    postal: '07302',
    lat: 40.7282,
    lon: -74.0776,
    asnNumber: 7922,
    asnOrganization: 'Comcast Cable Communications, LLC',
  };

  const serverId = 'server-uuid-1234';
  const serverUserId = 'server-user-uuid-1234';

  describe('basic transformation', () => {
    it('should transform movie activity correctly', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.serverId).toBe(serverId);
      expect(session.serverUserId).toBe(serverUserId);
      expect(session.sessionKey).toBe(MOVIE_ACTIVITY.Id);
      expect(session.ratingKey).toBe(MOVIE_ACTIVITY.NowPlayingItemId);
      expect(session.externalSessionId).toBe(MOVIE_ACTIVITY.Id);
      expect(session.state).toBe('stopped');
      expect(session.mediaType).toBe('movie');
      expect(session.mediaTitle).toBe('The Matrix');
    });

    it('should transform episode activity correctly', () => {
      const session = transformActivityToSession(EPISODE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.mediaType).toBe('episode');
      expect(session.mediaTitle).toBe('The One Where They All Turn Thirty');
      expect(session.grandparentTitle).toBe('Friends');
    });
  });

  describe('duration calculations', () => {
    it('should convert numeric PlaybackDuration to milliseconds', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.durationMs).toBe(7200000); // 2 hours
    });

    it('should convert string PlaybackDuration to milliseconds', () => {
      const session = transformActivityToSession(MINIMAL_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.durationMs).toBe(3600000); // 1 hour
    });

    it('should handle invalid PlaybackDuration', () => {
      const activityWithInvalidDuration = {
        ...MOVIE_ACTIVITY,
        PlaybackDuration: 'invalid',
      };
      const session = transformActivityToSession(
        activityWithInvalidDuration,
        serverId,
        serverUserId,
        mockGeo
      );

      expect(session.durationMs).toBe(0);
    });
  });

  describe('tick conversions', () => {
    it('should convert PositionTicks to progressMs', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      // 72000000000 ticks / 10000 = 7200000 ms
      expect(session.progressMs).toBe(7200000);
    });

    it('should convert RuntimeTicks to totalDurationMs', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      // 81000000000 ticks / 10000 = 8100000 ms
      expect(session.totalDurationMs).toBe(8100000);
    });

    it('should handle missing PlayState ticks', () => {
      const session = transformActivityToSession(MINIMAL_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.progressMs).toBeNull();
      expect(session.totalDurationMs).toBeNull();
    });

    it('should handle RuntimeTicks = 0 with no PercentComplete fallback', () => {
      // ZERO_RUNTIME_ACTIVITY has RuntimeTicks: 0 and PercentComplete: 0
      // Since both are 0, we can't determine the total duration
      const session = transformActivityToSession(
        ZERO_RUNTIME_ACTIVITY,
        serverId,
        serverUserId,
        mockGeo
      );

      // RuntimeTicks: 0 and PercentComplete: 0 means unknown duration
      expect(session.totalDurationMs).toBeNull();
      // PositionTicks: 1093790 / 10000 = 109 ms
      expect(session.progressMs).toBe(109);
    });

    it('should use PercentComplete to derive totalDurationMs when RuntimeTicks is 0', () => {
      // Create activity with RuntimeTicks: 0 but valid PercentComplete
      const activityWithPercent = {
        ...ZERO_RUNTIME_ACTIVITY,
        PlaybackDuration: '1800', // 30 minutes watched
        PlayState: {
          ...ZERO_RUNTIME_ACTIVITY.PlayState,
          RuntimeTicks: 0,
          PercentComplete: 50, // 50% means total is 60 minutes
        },
      };

      const session = transformActivityToSession(
        activityWithPercent,
        serverId,
        serverUserId,
        mockGeo
      );

      // 1800s * 1000ms = 1800000ms watched, at 50% = 3600000ms total (60 min)
      expect(session.totalDurationMs).toBe(3600000);
    });

    it('should use PercentComplete to derive totalDurationMs when RuntimeTicks is null', () => {
      // Create activity with null RuntimeTicks but valid PercentComplete
      const activityWithPercent = {
        ...MINIMAL_ACTIVITY,
        PlaybackDuration: '900', // 15 minutes watched
        PlayState: {
          PositionTicks: null,
          RuntimeTicks: null,
          PercentComplete: 25, // 25% means total is 60 minutes
        },
      };

      const session = transformActivityToSession(
        activityWithPercent,
        serverId,
        serverUserId,
        mockGeo
      );

      // 900s * 1000ms = 900000ms watched, at 25% = 3600000ms total (60 min)
      expect(session.totalDurationMs).toBe(3600000);
    });
  });

  describe('timestamp calculations', () => {
    it('should set stoppedAt from ActivityDateInserted', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      const expectedStoppedAt = new Date('2024-12-15T10:30:00.000Z');
      expect(session.stoppedAt?.getTime()).toBe(expectedStoppedAt.getTime());
    });

    it('should calculate startedAt from stoppedAt minus duration', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      const stoppedAt = new Date('2024-12-15T10:30:00.000Z');
      const expectedStartedAt = new Date(stoppedAt.getTime() - 7200000);
      expect(session.startedAt?.getTime()).toBe(expectedStartedAt.getTime());
    });
  });

  describe('media type detection', () => {
    it('should detect movie when SeriesName is null', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.mediaType).toBe('movie');
    });

    it('should detect episode when SeriesName is present', () => {
      const session = transformActivityToSession(EPISODE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.mediaType).toBe('episode');
    });
  });

  describe('transcode detection', () => {
    it('should detect transcode (PlayMethod = Transcode)', () => {
      const session = transformActivityToSession(EPISODE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.isTranscode).toBe(true);
      expect(session.quality).toBeNull(); // Quality not available from Jellystat
    });

    it('should detect direct play (PlayMethod = DirectPlay)', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.isTranscode).toBe(false);
      expect(session.quality).toBeNull(); // Quality not available from Jellystat
    });

    it('should treat DirectStream without TranscodingInfo as DirectPlay', () => {
      // Jellystat exports "DirectStream" for what Emby shows as "DirectPlay"
      // When TranscodingInfo is absent, treat as DirectPlay
      const session = transformActivityToSession(MINIMAL_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.isTranscode).toBe(false);
      expect(session.videoDecision).toBe('directplay');
      expect(session.audioDecision).toBe('directplay');
    });

    it('should treat DirectStream with non-direct stream as copy', () => {
      // Real DirectStream (container remux) has TranscodingInfo with IsVideoDirect/IsAudioDirect = false
      const activityWithRealDirectStream = {
        ...MINIMAL_ACTIVITY,
        Id: '1003-ds',
        TranscodingInfo: {
          IsVideoDirect: false,
          IsAudioDirect: true,
        },
      };
      const session = transformActivityToSession(
        activityWithRealDirectStream,
        serverId,
        serverUserId,
        mockGeo
      );

      expect(session.isTranscode).toBe(false);
      expect(session.videoDecision).toBe('copy');
      expect(session.audioDecision).toBe('copy');
    });
  });

  describe('bitrate conversion', () => {
    it('should convert bitrate from bps to kbps', () => {
      const session = transformActivityToSession(EPISODE_ACTIVITY, serverId, serverUserId, mockGeo);

      // 3500000 bps / 1000 = 3500 kbps
      expect(session.bitrate).toBe(3500);
    });

    it('should handle missing bitrate', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.bitrate).toBeNull();
    });
  });

  describe('GeoIP integration', () => {
    it('should include geo data in session', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.geoCity).toBe('Jersey City');
      expect(session.geoRegion).toBe('New Jersey');
      expect(session.geoCountry).toBe('US');
      expect(session.geoLat).toBe(40.7282);
      expect(session.geoLon).toBe(-74.0776);
    });

    it('should handle null geo data', () => {
      const nullGeo = {
        city: null,
        region: null,
        country: null,
        countryCode: null,
        continent: null,
        postal: null,
        lat: null,
        lon: null,
        asnNumber: null,
        asnOrganization: null,
      };
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, nullGeo);

      expect(session.geoCity).toBeNull();
      expect(session.geoLat).toBeNull();
    });
  });

  describe('IP address handling', () => {
    it('should use RemoteEndPoint for IP address', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.ipAddress).toBe('73.160.197.140');
    });

    it('should default to 0.0.0.0 for null RemoteEndPoint', () => {
      const session = transformActivityToSession(MINIMAL_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.ipAddress).toBe('0.0.0.0');
    });
  });

  describe('watched status', () => {
    it('should set watched from PlayState.Completed', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.watched).toBe(true);
    });

    it('should set watched to false when not completed', () => {
      const session = transformActivityToSession(EPISODE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.watched).toBe(false);
    });

    it('should default watched to false when PlayState is null', () => {
      const session = transformActivityToSession(MINIMAL_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.watched).toBe(false);
    });
  });

  describe('device/player info', () => {
    it('should set playerName from DeviceName', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.playerName).toBe('Samsung TV');
    });

    it('should fall back to Client for playerName', () => {
      const activityWithoutDeviceName = {
        ...MOVIE_ACTIVITY,
        DeviceName: null,
      } as unknown as JellystatPlaybackActivity;
      const session = transformActivityToSession(
        activityWithoutDeviceName,
        serverId,
        serverUserId,
        mockGeo
      );

      expect(session.playerName).toBe('Jellyfin Web');
    });

    it('should set product and platform from Client', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.product).toBe('Jellyfin Web');
      // Platform is normalized by normalizeClient
      expect(session.platform).toBe('Web');
    });
  });

  describe('enrichment data', () => {
    it('should include enrichment data when provided', () => {
      const enrichment = {
        seasonNumber: 7,
        episodeNumber: 14,
        year: 2001,
        thumbPath: '/Items/item-episode-uuid/Images/Primary',
      };

      const session = transformActivityToSession(
        EPISODE_ACTIVITY,
        serverId,
        serverUserId,
        mockGeo,
        enrichment
      );

      expect(session.seasonNumber).toBe(7);
      expect(session.episodeNumber).toBe(14);
      expect(session.year).toBe(2001);
      expect(session.thumbPath).toBe('/Items/item-episode-uuid/Images/Primary');
    });

    it('should use null for missing enrichment', () => {
      const session = transformActivityToSession(EPISODE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.seasonNumber).toBeNull();
      expect(session.episodeNumber).toBeNull();
      expect(session.year).toBeNull();
      expect(session.thumbPath).toBeNull();
    });
  });

  describe('Jellyfin-specific fields', () => {
    it('should set plexSessionId to null (not applicable for Jellyfin)', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.plexSessionId).toBeNull();
    });

    it('should set lastPausedAt to null (not available from Jellystat)', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.lastPausedAt).toBeNull();
    });

    it('should set referenceId to null (not available from Jellystat)', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.referenceId).toBeNull();
    });

    it('should set forceStopped to false (historical imports)', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.forceStopped).toBe(false);
    });

    it('should set device from DeviceName', () => {
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.device).toBe('Samsung TV');
    });

    it('should fall back to Client for device when DeviceName is null', () => {
      const activityWithoutDeviceName = {
        ...MOVIE_ACTIVITY,
        DeviceName: null,
      } as unknown as JellystatPlaybackActivity;
      const session = transformActivityToSession(
        activityWithoutDeviceName,
        serverId,
        serverUserId,
        mockGeo
      );

      // Device is normalized by normalizeClient when DeviceName is null
      expect(session.device).toBe('Browser');
    });
  });

  describe('shortSession detection', () => {
    it('should mark session as short when duration < 2 minutes', () => {
      // PlaybackDuration: '60' (60 seconds = 1 minute < 2 minutes)
      const shortActivity = {
        ...MOVIE_ACTIVITY,
        PlaybackDuration: '60',
      };
      const session = transformActivityToSession(shortActivity, serverId, serverUserId, mockGeo);

      expect(session.shortSession).toBe(true);
      expect(session.durationMs).toBe(60000);
    });

    it('should not mark session as short when duration >= 2 minutes', () => {
      // MOVIE_ACTIVITY has PlaybackDuration: '7200' (2 hours)
      const session = transformActivityToSession(MOVIE_ACTIVITY, serverId, serverUserId, mockGeo);

      expect(session.shortSession).toBe(false);
      expect(session.durationMs).toBe(7200000);
    });

    it('should mark session as short at exactly 119 seconds', () => {
      const borderlineActivity = {
        ...MOVIE_ACTIVITY,
        PlaybackDuration: '119',
      };
      const session = transformActivityToSession(
        borderlineActivity,
        serverId,
        serverUserId,
        mockGeo
      );

      expect(session.shortSession).toBe(true);
      expect(session.durationMs).toBe(119000);
    });

    it('should not mark session as short at exactly 120 seconds', () => {
      const borderlineActivity = {
        ...MOVIE_ACTIVITY,
        PlaybackDuration: '120',
      };
      const session = transformActivityToSession(
        borderlineActivity,
        serverId,
        serverUserId,
        mockGeo
      );

      expect(session.shortSession).toBe(false);
      expect(session.durationMs).toBe(120000);
    });
  });
});

// ============================================================================
// USER MATCHING TESTS
// ============================================================================

describe('User Matching Logic', () => {
  function findUserByJellyfinId(
    userMap: Map<string, string>,
    jellyfinUserId: string
  ): string | null {
    return userMap.get(jellyfinUserId) ?? null;
  }

  it('should match user by Jellyfin GUID', () => {
    const userMap = new Map<string, string>();
    userMap.set('a91468af8ed947e0add77f191736dab5', 'tracearr-user-1');
    userMap.set('b82579cf9de048e1bc88f292847eab6c', 'tracearr-user-2');

    const result = findUserByJellyfinId(userMap, MOVIE_ACTIVITY.UserId);
    expect(result).toBe('tracearr-user-1');
  });

  it('should return null for unmatched user', () => {
    const userMap = new Map<string, string>();
    userMap.set('different-user-id', 'tracearr-user-1');

    const result = findUserByJellyfinId(userMap, MOVIE_ACTIVITY.UserId);
    expect(result).toBeNull();
  });

  describe('skipped user tracking', () => {
    interface SkippedUser {
      jellyfinUserId: string;
      username: string | null;
      count: number;
    }

    function trackSkippedUser(
      skippedUsers: Map<string, SkippedUser>,
      activity: JellystatPlaybackActivity
    ): void {
      const existing = skippedUsers.get(activity.UserId);
      if (existing) {
        existing.count++;
      } else {
        skippedUsers.set(activity.UserId, {
          jellyfinUserId: activity.UserId,
          username: activity.UserName ?? null,
          count: 1,
        });
      }
    }

    it('should track first occurrence of skipped user', () => {
      const skippedUsers = new Map<string, SkippedUser>();
      trackSkippedUser(skippedUsers, MOVIE_ACTIVITY);

      expect(skippedUsers.size).toBe(1);
      expect(skippedUsers.get(MOVIE_ACTIVITY.UserId)).toEqual({
        jellyfinUserId: 'a91468af8ed947e0add77f191736dab5',
        username: 'TestUser',
        count: 1,
      });
    });

    it('should increment count for repeated skipped user', () => {
      const skippedUsers = new Map<string, SkippedUser>();
      trackSkippedUser(skippedUsers, MOVIE_ACTIVITY);
      trackSkippedUser(skippedUsers, EPISODE_ACTIVITY); // Same UserId

      expect(skippedUsers.size).toBe(1);
      expect(skippedUsers.get(MOVIE_ACTIVITY.UserId)?.count).toBe(2);
    });

    it('should track multiple different skipped users', () => {
      const skippedUsers = new Map<string, SkippedUser>();
      trackSkippedUser(skippedUsers, MOVIE_ACTIVITY);
      trackSkippedUser(skippedUsers, MINIMAL_ACTIVITY); // Different UserId

      expect(skippedUsers.size).toBe(2);
    });

    it('should handle null username', () => {
      const skippedUsers = new Map<string, SkippedUser>();
      trackSkippedUser(skippedUsers, MINIMAL_ACTIVITY);

      expect(skippedUsers.get(MINIMAL_ACTIVITY.UserId)?.username).toBeNull();
    });
  });
});

// ============================================================================
// DEDUPLICATION TESTS
// ============================================================================

describe('Deduplication Logic', () => {
  function isDuplicate(existingSessionIds: Set<string>, activityId: string): boolean {
    return existingSessionIds.has(activityId);
  }

  it('should detect duplicate by activity ID', () => {
    const existingIds = new Set(['1001']); // String number format
    expect(isDuplicate(existingIds, MOVIE_ACTIVITY.Id)).toBe(true);
  });

  it('should not flag new activity as duplicate', () => {
    const existingIds = new Set(['different-id']);
    expect(isDuplicate(existingIds, MOVIE_ACTIVITY.Id)).toBe(false);
  });

  it('should handle empty existing set', () => {
    const existingIds = new Set<string>();
    expect(isDuplicate(existingIds, MOVIE_ACTIVITY.Id)).toBe(false);
  });
});

// ============================================================================
// PROGRESS TRACKING TESTS
// ============================================================================

describe('Progress Tracking', () => {
  interface ImportProgress {
    status: 'idle' | 'parsing' | 'enriching' | 'processing' | 'complete' | 'error';
    totalRecords: number;
    processedRecords: number;
    importedRecords: number;
    skippedRecords: number;
    errorRecords: number;
    enrichedRecords: number;
    message: string;
  }

  function createProgress(): ImportProgress {
    return {
      status: 'idle',
      totalRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      enrichedRecords: 0,
      message: 'Starting import...',
    };
  }

  it('should initialize with correct defaults', () => {
    const progress = createProgress();
    expect(progress.status).toBe('idle');
    expect(progress.totalRecords).toBe(0);
    expect(progress.processedRecords).toBe(0);
    expect(progress.importedRecords).toBe(0);
    expect(progress.skippedRecords).toBe(0);
    expect(progress.errorRecords).toBe(0);
    expect(progress.enrichedRecords).toBe(0);
  });

  it('should track status transitions', () => {
    const progress = createProgress();

    progress.status = 'parsing';
    expect(progress.status).toBe('parsing');

    progress.status = 'enriching';
    expect(progress.status).toBe('enriching');

    progress.status = 'processing';
    expect(progress.status).toBe('processing');

    progress.status = 'complete';
    expect(progress.status).toBe('complete');
  });

  it('should calculate completion percentage', () => {
    const progress = createProgress();
    progress.totalRecords = 1000;
    progress.processedRecords = 500;

    const percentage = Math.round((progress.processedRecords / progress.totalRecords) * 100);
    expect(percentage).toBe(50);
  });

  it('should track enrichment separately', () => {
    const progress = createProgress();
    progress.totalRecords = 100;
    progress.processedRecords = 100;
    progress.importedRecords = 80;
    progress.skippedRecords = 20;
    progress.enrichedRecords = 75;

    expect(progress.enrichedRecords).toBe(75);
    expect(progress.importedRecords + progress.skippedRecords).toBe(100);
  });
});

// ============================================================================
// IMPORT RESULT TESTS
// ============================================================================

describe('Import Result Generation', () => {
  interface SkippedUserInfo {
    jellyfinUserId: string;
    username: string | null;
    recordCount: number;
  }

  interface ImportResult {
    success: boolean;
    imported: number;
    skipped: number;
    errors: number;
    enriched: number;
    message: string;
    skippedUsers?: SkippedUserInfo[];
  }

  function createSuccessResult(
    imported: number,
    skipped: number,
    errors: number,
    enriched: number,
    skippedUsers?: Map<string, { username: string | null; count: number }>
  ): ImportResult {
    let message = `Import complete: ${imported} imported, ${skipped} skipped, ${errors} errors`;
    if (enriched > 0) {
      message += `, ${enriched} media items enriched`;
    }

    const result: ImportResult = {
      success: true,
      imported,
      skipped,
      errors,
      enriched,
      message,
    };

    if (skippedUsers && skippedUsers.size > 0) {
      result.skippedUsers = [...skippedUsers.entries()].map(([id, data]) => ({
        jellyfinUserId: id,
        username: data.username,
        recordCount: data.count,
      }));
    }

    return result;
  }

  it('should create success result with counts', () => {
    const result = createSuccessResult(100, 5, 2, 80);
    expect(result.success).toBe(true);
    expect(result.imported).toBe(100);
    expect(result.skipped).toBe(5);
    expect(result.errors).toBe(2);
    expect(result.enriched).toBe(80);
  });

  it('should include enriched count in message', () => {
    const result = createSuccessResult(100, 0, 0, 75);
    expect(result.message).toContain('75 media items enriched');
  });

  it('should include skipped users when present', () => {
    const skippedUsers = new Map<string, { username: string | null; count: number }>();
    skippedUsers.set('user-1', { username: 'User One', count: 15 });
    skippedUsers.set('user-2', { username: null, count: 3 });

    const result = createSuccessResult(100, 18, 0, 50, skippedUsers);

    expect(result.skippedUsers).toBeDefined();
    expect(result.skippedUsers).toHaveLength(2);
    expect(result.skippedUsers?.[0]).toEqual({
      jellyfinUserId: 'user-1',
      username: 'User One',
      recordCount: 15,
    });
  });

  it('should not include skippedUsers when empty', () => {
    const skippedUsers = new Map<string, { username: string | null; count: number }>();
    const result = createSuccessResult(100, 0, 0, 50, skippedUsers);
    expect(result.skippedUsers).toBeUndefined();
  });
});

// ============================================================================
// GEOIP CACHE TESTS
// ============================================================================

describe('GeoIP Caching', () => {
  it('should reuse cached geo results for same IP', () => {
    const geoCache = new Map<string, { city: string | null }>();
    const lookupCount = { count: 0 };

    function cachedLookup(ip: string): { city: string | null } {
      let cached = geoCache.get(ip);
      if (cached) return cached;

      lookupCount.count++;
      cached = { city: `City for ${ip}` };
      geoCache.set(ip, cached);
      return cached;
    }

    // First lookup
    cachedLookup('1.2.3.4');
    expect(lookupCount.count).toBe(1);

    // Second lookup - should use cache
    cachedLookup('1.2.3.4');
    expect(lookupCount.count).toBe(1);

    // Different IP - new lookup
    cachedLookup('5.6.7.8');
    expect(lookupCount.count).toBe(2);
  });
});

// ============================================================================
// INTEGRATION TESTS - importJellystatBackup
// ============================================================================

// Real data from actual Jellystat backup (structure verified against backup file)
const REAL_BACKUP_ACTIVITY_1 = {
  Id: '1305',
  IsPaused: null,
  UserId: 'a91468af8ed947e0add77f191736dab5',
  UserName: null,
  Client: 'Jellyfin Web',
  DeviceName: 'Opera',
  DeviceId: 'TW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCk',
  ApplicationVersion: null,
  NowPlayingItemId: 'e5a547eef1d6ed70045cc4bc83e0dad5',
  NowPlayingItemName: 'Pilot',
  SeasonId: 'c715c2ef4cf928fa47b361f4b7723572',
  SeriesName: 'Code Black',
  EpisodeId: 'd939b68baceb6abb85bd879250c54a7b',
  PlaybackDuration: '1937',
  ActivityDateInserted: '2025-04-05T10:40:29.000Z',
  PlayMethod: 'Transcode' as const,
  MediaStreams: null,
  TranscodingInfo: {
    AudioCodec: null,
    VideoCodec: null,
    Container: null,
    IsVideoDirect: null,
    IsAudioDirect: null,
    Bitrate: null,
    CompletionPercentage: null,
    Width: null,
    Height: null,
    AudioChannels: null,
    HardwareAccelerationType: null,
    TranscodeReasons: [],
  },
  PlayState: {
    IsPaused: null,
    IsMuted: null,
    VolumeLevel: null,
    RepeatMode: null,
    PlaybackOrder: null,
    PositionTicks: 19370000000,
    RuntimeTicks: 25800000000,
    PercentComplete: 75,
    IsActive: null,
    Completed: false,
    CanSeek: true,
    IsStalled: false,
  },
  OriginalContainer: null,
  RemoteEndPoint: '73.160.197.140',
  ServerId: '1',
  imported: false,
};

const REAL_BACKUP_ACTIVITY_2 = {
  Id: '1384',
  IsPaused: null,
  UserId: 'a91468af8ed947e0add77f191736dab5',
  UserName: 'JohnDoe',
  Client: 'Jellyfin Web',
  DeviceName: 'Chrome',
  DeviceId: 'TW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCk',
  ApplicationVersion: null,
  NowPlayingItemId: 'movie123456',
  NowPlayingItemName: 'Parasite',
  SeasonId: null,
  SeriesName: null,
  EpisodeId: null,
  PlaybackDuration: '7200',
  ActivityDateInserted: '2025-04-06T20:00:00.000Z',
  PlayMethod: 'DirectPlay' as const,
  MediaStreams: null,
  TranscodingInfo: null,
  PlayState: {
    IsPaused: false,
    PositionTicks: 72000000000,
    RuntimeTicks: 72000000000,
    Completed: true,
  },
  RemoteEndPoint: '192.168.1.100',
  ServerId: '1',
};

const REAL_BACKUP_ACTIVITY_UNKNOWN_USER = {
  Id: '1500',
  IsPaused: null,
  UserId: 'unknown-user-id-not-in-tracearr',
  UserName: 'UnknownUser',
  Client: 'Jellyfin iOS',
  DeviceName: 'iPhone',
  DeviceId: 'ios-device-123',
  ApplicationVersion: null,
  NowPlayingItemId: 'movie789',
  NowPlayingItemName: 'Unknown Movie',
  SeasonId: null,
  SeriesName: null,
  EpisodeId: null,
  PlaybackDuration: '3600',
  ActivityDateInserted: '2025-04-07T15:00:00.000Z',
  PlayMethod: 'DirectPlay' as const,
  MediaStreams: null,
  TranscodingInfo: null,
  PlayState: null,
  RemoteEndPoint: '10.0.0.1',
  ServerId: '1',
};

// Theme song activity (short audio, no SeriesName - typical of extras)
const THEME_SONG_ACTIVITY = {
  Id: '1600',
  IsPaused: null,
  UserId: 'a91468af8ed947e0add77f191736dab5',
  UserName: 'TestUser',
  Client: 'Jellyfin Web',
  DeviceName: 'Chrome',
  DeviceId: 'chrome-device-456',
  ApplicationVersion: null,
  NowPlayingItemId: 'theme-song-item-id',
  NowPlayingItemName: 'Theme Song',
  SeasonId: null,
  SeriesName: null,
  EpisodeId: null,
  PlaybackDuration: '30',
  ActivityDateInserted: '2025-04-08T12:00:00.000Z',
  PlayMethod: 'DirectPlay' as const,
  MediaStreams: null,
  TranscodingInfo: null,
  PlayState: null,
  OriginalContainer: null,
  RemoteEndPoint: '73.160.197.140',
  ServerId: '1',
  imported: false,
};

// Trailer activity - exercises the broadened ExtraType allowlist (any non-empty
// ExtraType is an extra, not just ThemeSong/ThemeVideo)
const TRAILER_ACTIVITY = {
  Id: '1601',
  IsPaused: null,
  UserId: 'a91468af8ed947e0add77f191736dab5',
  UserName: 'TestUser',
  Client: 'Jellyfin Web',
  DeviceName: 'Chrome',
  DeviceId: 'chrome-device-789',
  ApplicationVersion: null,
  NowPlayingItemId: 'trailer-item-id',
  NowPlayingItemName: 'Trailer',
  SeasonId: null,
  SeriesName: null,
  EpisodeId: null,
  PlaybackDuration: '30',
  ActivityDateInserted: '2025-04-09T12:00:00.000Z',
  PlayMethod: 'DirectPlay' as const,
  MediaStreams: null,
  TranscodingInfo: null,
  PlayState: null,
  OriginalContainer: null,
  RemoteEndPoint: '73.160.197.140',
  ServerId: '1',
  imported: false,
};

// Mock modules
vi.mock('../geoip.js', () => ({
  geoipService: {
    lookup: vi.fn((ip: string) => ({
      city: ip === '73.160.197.140' ? 'Jersey City' : 'Unknown',
      region: ip === '73.160.197.140' ? 'New Jersey' : null,
      country: ip === '73.160.197.140' ? 'US' : null,
      countryCode: ip === '73.160.197.140' ? 'US' : null,
      continent: ip === '73.160.197.140' ? 'North America' : null,
      postal: ip === '73.160.197.140' ? '07302' : null,
      lat: ip === '73.160.197.140' ? 40.7282 : null,
      lon: ip === '73.160.197.140' ? -74.0776 : null,
      asnNumber: null,
      asnOrganization: null,
    })),
  },
}));

vi.mock('../geoasn.js', () => ({
  geoasnService: {
    lookup: vi.fn((ip: string) => ({
      number: ip === '73.160.197.140' ? 7922 : null,
      organization: ip === '73.160.197.140' ? 'Comcast Cable Communications, LLC' : null,
    })),
  },
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../db/timescale.js', () => ({
  refreshAggregates: vi.fn().mockResolvedValue(undefined),
  uncapDecompressionForTx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../jobs/poller/database.js', () => ({
  batchGetLibraryItemIdentity: vi.fn(async () => new Map()),
}));

// Shared mock for JellyfinClient.getItems - can be configured per test
let mockJellyfinGetItems = vi.fn();

// Mock JellyfinClient class - must use actual class syntax for vi.mock
vi.mock('../mediaServer/jellyfin/client.js', () => {
  return {
    JellyfinClient: class {
      getItems(...args: unknown[]) {
        return mockJellyfinGetItems(...args);
      }
    },
  };
});

// Mock EmbyClient class - must use actual class syntax for vi.mock
vi.mock('../mediaServer/emby/client.js', () => {
  return {
    EmbyClient: class {
      getItems = vi.fn().mockResolvedValue([]);
    },
  };
});

// Helper to reset and configure the JellyfinClient mock
function configureMockJellyfinClient(
  returnValue: unknown[] = [
    {
      Id: 'e5a547eef1d6ed70045cc4bc83e0dad5',
      ParentIndexNumber: 1,
      IndexNumber: 1,
      ProductionYear: 2015,
      ImageTags: { Primary: 'abc123' },
    },
    {
      Id: 'movie123456',
      ProductionYear: 2019,
      ImageTags: { Primary: 'def456' },
    },
  ]
) {
  mockJellyfinGetItems = vi.fn().mockResolvedValue(returnValue);
}

function configureMockJellyfinClientError(error: Error) {
  mockJellyfinGetItems = vi.fn().mockRejectedValue(error);
}

describe('importJellystatBackup', () => {
  const serverId = 'server-uuid-1234';
  const mockServer = {
    id: serverId,
    name: 'Test Jellyfin Server',
    type: 'jellyfin' as const,
    url: 'http://jellyfin.local:8096',
    token: 'test-token',
  };
  const _mockEmbyServer = {
    ...mockServer,
    type: 'emby' as const,
    name: 'Test Emby Server',
  };
  const mockPlexServer = {
    ...mockServer,
    type: 'plex' as const,
    name: 'Test Plex Server',
  };

  const mockServerUser = {
    id: 'tracearr-user-uuid-1234',
    serverId,
    externalId: 'a91468af8ed947e0add77f191736dab5',
    username: 'TestUser',
  };

  let mockDbSelect: ReturnType<typeof vi.fn>;
  let mockDbInsert: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Configure default JellyfinClient mock for enrichment
    configureMockJellyfinClient();

    // Import the mocked db
    const { db } = await import('../../db/client.js');

    // Setup chained mock for select().from().where().limit()
    const mockLimit = vi.fn();
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDbSelect = vi.fn().mockReturnValue({ from: mockFrom });
    (db.select as ReturnType<typeof vi.fn>) = mockDbSelect;

    // Setup chained mock for insert().values()
    const mockValues = vi.fn().mockResolvedValue(undefined);
    mockDbInsert = vi.fn().mockReturnValue({ values: mockValues });
    (db.insert as ReturnType<typeof vi.fn>) = mockDbInsert;

    // batchProcessor wraps chunk inserts in db.transaction - hand the same
    // mocked db back as `tx` so mockDbInsert still sees the calls.
    (db.transaction as ReturnType<typeof vi.fn>) = vi.fn(
      async (callback: (tx: typeof db) => Promise<unknown>) => callback(db)
    );

    // Default: return server, users, and empty sessions
    mockLimit.mockImplementation(() => {
      // First call is for server lookup
      return Promise.resolve([mockServer]);
    });

    // Track call count to return different data
    let selectCallCount = 0;
    mockDbSelect.mockImplementation(() => {
      selectCallCount++;
      const mockLimit2 = vi.fn();
      const mockWhere2 = vi.fn().mockReturnValue({ limit: mockLimit2 });
      const mockFrom2 = vi.fn().mockReturnValue({ where: mockWhere2 });

      if (selectCallCount === 1) {
        // Server lookup
        mockLimit2.mockResolvedValue([mockServer]);
      } else if (selectCallCount === 2) {
        // ServerUsers lookup (no limit)
        mockWhere2.mockResolvedValue([mockServerUser]);
      } else {
        // Existing sessions lookup (no limit)
        mockWhere2.mockResolvedValue([]);
      }

      return { from: mockFrom2 };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('server validation', () => {
    it('should throw error when server not found', async () => {
      const { db } = await import('../../db/client.js');
      const mockLimit = vi.fn().mockResolvedValue([]);
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: mockFrom });

      const backup = JSON.stringify([{ jf_playback_activity: [REAL_BACKUP_ACTIVITY_1] }]);

      const result = await importJellystatBackup('nonexistent-server', backup, false);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Server not found');
    });

    it('should throw error for Plex server type', async () => {
      const { db } = await import('../../db/client.js');
      const mockLimit = vi.fn().mockResolvedValue([mockPlexServer]);
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: mockFrom });

      const backup = JSON.stringify([{ jf_playback_activity: [REAL_BACKUP_ACTIVITY_1] }]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(false);
      expect(result.message).toContain('only supports Jellyfin/Emby');
    });
  });

  describe('empty backup handling', () => {
    it('should handle empty jf_playback_activity array', async () => {
      const { db } = await import('../../db/client.js');
      const mockLimit = vi.fn().mockResolvedValue([mockServer]);
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: mockFrom });

      const backup = JSON.stringify([{ jf_playback_activity: [] }]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(0);
      expect(result.message).toContain('No playback activity records');
    });

    it('should handle backup with missing jf_playback_activity', async () => {
      const { db } = await import('../../db/client.js');
      const mockLimit = vi.fn().mockResolvedValue([mockServer]);
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      (db.select as ReturnType<typeof vi.fn>).mockReturnValue({ from: mockFrom });

      const backup = JSON.stringify([{}]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(0);
    });
  });

  describe('invalid backup handling', () => {
    it('should fail on invalid JSON', async () => {
      const result = await importJellystatBackup(serverId, 'not valid json', false);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Import failed');
    });

    it('should fail on invalid backup structure', async () => {
      const result = await importJellystatBackup(serverId, JSON.stringify({ not: 'array' }), false);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid Jellystat backup format');
    });
  });

  describe('user matching', () => {
    it('should skip records for unknown users and track them', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          // Return empty user list - no users match
          mockWhere.mockResolvedValue([]);
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const backup = JSON.stringify([
        {
          jf_playback_activity: [REAL_BACKUP_ACTIVITY_UNKNOWN_USER],
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.skippedUsers).toBeDefined();
      expect(result.skippedUsers?.[0]?.username).toBe('UnknownUser');
      expect(result.skippedUsers?.[0]?.recordCount).toBe(1);
    });
  });

  describe('deduplication', () => {
    it('should skip duplicate sessions that already exist', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]);
        } else {
          // Return existing session with same ID
          mockWhere.mockResolvedValue([{ id: 'existing-1', externalSessionId: '1305' }]);
        }

        return { from: mockFrom };
      });

      const backup = JSON.stringify([
        {
          jf_playback_activity: [REAL_BACKUP_ACTIVITY_1],
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  describe('successful import', () => {
    it('should import valid records with enrichment disabled', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]);
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const backup = JSON.stringify([
        {
          jf_playback_activity: [REAL_BACKUP_ACTIVITY_1, REAL_BACKUP_ACTIVITY_2],
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.enriched).toBe(0);
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should import multiple records from same user', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]);
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      // Create multiple records with same user
      const backup = JSON.stringify([
        {
          jf_playback_activity: [
            REAL_BACKUP_ACTIVITY_1,
            REAL_BACKUP_ACTIVITY_2,
            { ...REAL_BACKUP_ACTIVITY_1, Id: '9999' }, // Different ID
          ],
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(3);
    });

    it('should handle mixed known and unknown users', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]); // Only known user
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const backup = JSON.stringify([
        {
          jf_playback_activity: [
            REAL_BACKUP_ACTIVITY_1, // Known user
            REAL_BACKUP_ACTIVITY_UNKNOWN_USER, // Unknown user
          ],
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe('progress tracking', () => {
    it('should publish progress updates via pubSubService', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]);
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const mockPubSub = {
        publish: vi.fn().mockResolvedValue(undefined),
      };

      const backup = JSON.stringify([
        {
          jf_playback_activity: [REAL_BACKUP_ACTIVITY_1],
        },
      ]);

      await importJellystatBackup(serverId, backup, false, mockPubSub as any);

      expect(mockPubSub.publish).toHaveBeenCalled();
      const calls = mockPubSub.publish.mock.calls;
      expect(calls.some((c: unknown[]) => c[0] === 'import:jellystat:progress')).toBe(true);
    });

    it('should handle pubSubService publish errors gracefully', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]);
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const mockPubSub = {
        publish: vi.fn().mockRejectedValue(new Error('Publish failed')),
      };

      const backup = JSON.stringify([
        {
          jf_playback_activity: [REAL_BACKUP_ACTIVITY_1],
        },
      ]);

      // Should not throw despite publish errors
      const result = await importJellystatBackup(serverId, backup, false, mockPubSub as any);

      expect(result.success).toBe(true);
    });
  });

  describe('aggregate refresh', () => {
    it('should call refreshAggregates after successful import', async () => {
      const { db } = await import('../../db/client.js');
      const { refreshAggregates } = await import('../../db/timescale.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]);
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const backup = JSON.stringify([
        {
          jf_playback_activity: [REAL_BACKUP_ACTIVITY_1],
        },
      ]);

      await importJellystatBackup(serverId, backup, false);

      expect(refreshAggregates).toHaveBeenCalled();
    });

    it('should continue even if refreshAggregates fails', async () => {
      const { db } = await import('../../db/client.js');
      const { refreshAggregates } = await import('../../db/timescale.js');
      (refreshAggregates as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Aggregate refresh failed')
      );

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]);
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const backup = JSON.stringify([
        {
          jf_playback_activity: [REAL_BACKUP_ACTIVITY_1],
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      // Should still succeed even with aggregate refresh failure
      expect(result.success).toBe(true);
    });
  });

  describe('result message formatting', () => {
    it('should format basic success message correctly', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]);
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const backup = JSON.stringify([
        {
          jf_playback_activity: [REAL_BACKUP_ACTIVITY_1],
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.message).toContain('Import complete');
      expect(result.message).toContain('imported');
      expect(result.message).toContain('skipped');
      expect(result.message).toContain('errors');
    });

    it('should include skipped user warning when users not found', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([]); // No users
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const backup = JSON.stringify([
        {
          jf_playback_activity: [REAL_BACKUP_ACTIVITY_UNKNOWN_USER],
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.message).toContain('Warning');
      expect(result.message).toContain('users not found in Tracearr');
      expect(result.message).toContain('Sync your server');
    });

    it('should handle large batch and trigger batch flush', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([mockServerUser]);
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      const insertedBatches: unknown[][] = [];
      const mockValues = vi.fn().mockImplementation((data) => {
        insertedBatches.push(Array.isArray(data) ? data : [data]);
        return Promise.resolve(undefined);
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      // Generate 600 records to trigger batch flush (BATCH_SIZE = 500)
      const activities = [];
      for (let i = 0; i < 600; i++) {
        activities.push({
          ...REAL_BACKUP_ACTIVITY_1,
          Id: `record-${i}`,
        });
      }

      const backup = JSON.stringify([
        {
          jf_playback_activity: activities,
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(true);
      expect(result.imported).toBe(600);
      // Should have triggered at least 2 insert calls (500 + 100)
      expect(insertedBatches.length).toBeGreaterThanOrEqual(2);
    });

    it('should sort skipped users by count and limit display to top 5', async () => {
      const { db } = await import('../../db/client.js');

      let callCount = 0;
      (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        const mockLimit = vi.fn();
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

        if (callCount === 1) {
          mockLimit.mockResolvedValue([mockServer]);
        } else if (callCount === 2) {
          mockWhere.mockResolvedValue([]); // No users match
        } else {
          mockWhere.mockResolvedValue([]);
        }

        return { from: mockFrom };
      });

      // Create multiple unknown users with different record counts
      const unknownUser1 = {
        ...REAL_BACKUP_ACTIVITY_UNKNOWN_USER,
        Id: '2001',
        UserId: 'unknown-1',
        UserName: 'Alice',
      };
      const unknownUser2 = {
        ...REAL_BACKUP_ACTIVITY_UNKNOWN_USER,
        Id: '2002',
        UserId: 'unknown-2',
        UserName: 'Bob',
      };
      const unknownUser3 = {
        ...REAL_BACKUP_ACTIVITY_UNKNOWN_USER,
        Id: '2003',
        UserId: 'unknown-2',
        UserName: 'Bob',
      }; // Same user as 2
      const unknownUser4 = {
        ...REAL_BACKUP_ACTIVITY_UNKNOWN_USER,
        Id: '2004',
        UserId: 'unknown-3',
        UserName: 'Charlie',
      };
      const unknownUser5 = {
        ...REAL_BACKUP_ACTIVITY_UNKNOWN_USER,
        Id: '2005',
        UserId: 'unknown-3',
        UserName: 'Charlie',
      };
      const unknownUser6 = {
        ...REAL_BACKUP_ACTIVITY_UNKNOWN_USER,
        Id: '2006',
        UserId: 'unknown-3',
        UserName: 'Charlie',
      }; // Charlie has 3 records

      const backup = JSON.stringify([
        {
          jf_playback_activity: [
            unknownUser1,
            unknownUser2,
            unknownUser3,
            unknownUser4,
            unknownUser5,
            unknownUser6,
          ],
        },
      ]);

      const result = await importJellystatBackup(serverId, backup, false);

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(6);
      expect(result.skippedUsers).toHaveLength(3); // 3 unique users
      // The message should list users sorted by count descending - Charlie (3) should appear first
      expect(result.message).toContain('Charlie (3 records)');
      // Verify all skipped users are tracked
      const userCounts = result.skippedUsers?.map((u) => u.recordCount);
      expect(userCounts).toContain(1); // Alice
      expect(userCounts).toContain(2); // Bob
      expect(userCounts).toContain(3); // Charlie
    });
  });
});

// ============================================================================
// FETCH MEDIA ENRICHMENT TESTS (via import function)
// ============================================================================

describe('Media Enrichment', () => {
  it('should enrich episode with season and episode numbers', async () => {
    // This is tested indirectly through importJellystatBackup
    // The mock JellyfinClient returns enrichment data
    const { db } = await import('../../db/client.js');

    const mockServer = {
      id: 'server-1',
      name: 'Test Server',
      type: 'jellyfin' as const,
      url: 'http://jellyfin.local:8096',
      token: 'test-token',
    };

    const mockServerUser = {
      id: 'user-1',
      serverId: 'server-1',
      externalId: 'a91468af8ed947e0add77f191736dab5',
    };

    let callCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      const mockLimit = vi.fn();
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

      if (callCount === 1) {
        mockLimit.mockResolvedValue([mockServer]);
      } else if (callCount === 2) {
        mockWhere.mockResolvedValue([mockServerUser]);
      } else {
        mockWhere.mockResolvedValue([]);
      }

      return { from: mockFrom };
    });

    // Track what gets inserted
    const insertedSessions: unknown[] = [];
    const mockValues = vi.fn().mockImplementation((data) => {
      insertedSessions.push(...(Array.isArray(data) ? data : [data]));
      return Promise.resolve(undefined);
    });
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

    const backup = JSON.stringify([
      {
        jf_playback_activity: [REAL_BACKUP_ACTIVITY_1],
      },
    ]);

    const result = await importJellystatBackup('server-1', backup, true);

    expect(result.success).toBe(true);
    expect(result.enriched).toBeGreaterThan(0);

    // Check that enrichment was applied to inserted session
    if (insertedSessions.length > 0) {
      const session = insertedSessions[0] as Record<string, unknown>;
      // The mock returns season 1, episode 1, year 2015 for REAL_BACKUP_ACTIVITY_1's NowPlayingItemId
      expect(session.seasonNumber).toBe(1);
      expect(session.episodeNumber).toBe(1);
      expect(session.year).toBe(2015);
      expect(session.thumbPath).toBe('/Items/e5a547eef1d6ed70045cc4bc83e0dad5/Images/Primary');
    }
  });

  it('should handle enrichment API failures gracefully', async () => {
    const { db } = await import('../../db/client.js');

    // Configure mock to throw error for getItems
    configureMockJellyfinClientError(new Error('API Error'));

    const mockServer = {
      id: 'server-1',
      name: 'Test Server',
      type: 'jellyfin' as const,
      url: 'http://jellyfin.local:8096',
      token: 'test-token',
    };

    const mockServerUser = {
      id: 'user-1',
      serverId: 'server-1',
      externalId: 'a91468af8ed947e0add77f191736dab5',
    };

    let callCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      const mockLimit = vi.fn();
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

      if (callCount === 1) {
        mockLimit.mockResolvedValue([mockServer]);
      } else if (callCount === 2) {
        mockWhere.mockResolvedValue([mockServerUser]);
      } else {
        mockWhere.mockResolvedValue([]);
      }

      return { from: mockFrom };
    });

    const backup = JSON.stringify([
      {
        jf_playback_activity: [REAL_BACKUP_ACTIVITY_1],
      },
    ]);

    // Should not throw - enrichment failures are logged but don't stop import
    const result = await importJellystatBackup('server-1', backup, true);

    expect(result.success).toBe(true);
    expect(result.imported).toBe(1);
    expect(result.enriched).toBe(0); // No enrichment due to API error
  });
});

// ============================================================================
// Theme Music / Extra Filtering
// ============================================================================

describe('Theme Music Filtering', () => {
  it('should filter out theme song items during import', async () => {
    const { db } = await import('../../db/client.js');

    const mockServer = {
      id: 'server-1',
      name: 'Test Server',
      type: 'jellyfin' as const,
      url: 'http://jellyfin.local:8096',
      token: 'test-token',
    };

    const mockServerUser = {
      id: 'user-1',
      serverId: 'server-1',
      externalId: 'a91468af8ed947e0add77f191736dab5',
    };

    // Configure mock to return theme song metadata for the theme song item
    // and normal metadata for the regular item
    configureMockJellyfinClient([
      {
        Id: 'e5a547eef1d6ed70045cc4bc83e0dad5',
        Type: 'Episode',
        ParentIndexNumber: 1,
        IndexNumber: 1,
        ProductionYear: 2015,
        ImageTags: { Primary: 'abc123' },
      },
      {
        Id: 'theme-song-item-id',
        Type: 'Audio',
        ExtraType: 'ThemeSong',
      },
    ]);

    let callCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      const mockLimit = vi.fn();
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

      if (callCount === 1) {
        mockLimit.mockResolvedValue([mockServer]);
      } else if (callCount === 2) {
        mockWhere.mockResolvedValue([mockServerUser]);
      } else {
        mockWhere.mockResolvedValue([]);
      }

      return { from: mockFrom };
    });

    const insertedSessions: unknown[] = [];
    const mockValues = vi.fn().mockImplementation((data) => {
      insertedSessions.push(...(Array.isArray(data) ? data : [data]));
      return Promise.resolve(undefined);
    });
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

    const backup = JSON.stringify([
      {
        jf_playback_activity: [REAL_BACKUP_ACTIVITY_1, THEME_SONG_ACTIVITY],
      },
    ]);

    const result = await importJellystatBackup('server-1', backup, true);

    expect(result.success).toBe(true);
    expect(result.imported).toBe(1); // Only the episode, not the theme song
    expect(result.filtered).toBe(1); // Theme song was filtered
    expect(insertedSessions).toHaveLength(1);

    // Verify the inserted session is the episode, not the theme song
    const session = insertedSessions[0] as Record<string, unknown>;
    expect(session.mediaTitle).toBe('Pilot');
  });

  it('should filter out theme video items during import', async () => {
    const { db } = await import('../../db/client.js');

    const mockServer = {
      id: 'server-1',
      name: 'Test Server',
      type: 'jellyfin' as const,
      url: 'http://jellyfin.local:8096',
      token: 'test-token',
    };

    const mockServerUser = {
      id: 'user-1',
      serverId: 'server-1',
      externalId: 'a91468af8ed947e0add77f191736dab5',
    };

    configureMockJellyfinClient([
      {
        Id: 'theme-song-item-id',
        Type: 'Video',
        ExtraType: 'ThemeVideo',
      },
    ]);

    let callCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      const mockLimit = vi.fn();
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

      if (callCount === 1) {
        mockLimit.mockResolvedValue([mockServer]);
      } else if (callCount === 2) {
        mockWhere.mockResolvedValue([mockServerUser]);
      } else {
        mockWhere.mockResolvedValue([]);
      }

      return { from: mockFrom };
    });

    const mockValues = vi.fn().mockResolvedValue(undefined);
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

    const backup = JSON.stringify([
      {
        jf_playback_activity: [THEME_SONG_ACTIVITY],
      },
    ]);

    const result = await importJellystatBackup('server-1', backup, true);

    expect(result.success).toBe(true);
    expect(result.imported).toBe(0);
    expect(result.filtered).toBe(1);
  });

  it('should filter out trailer items during import (broadened ExtraType coverage)', async () => {
    const { db } = await import('../../db/client.js');

    const mockServer = {
      id: 'server-1',
      name: 'Test Server',
      type: 'jellyfin' as const,
      url: 'http://jellyfin.local:8096',
      token: 'test-token',
    };

    const mockServerUser = {
      id: 'user-1',
      serverId: 'server-1',
      externalId: 'a91468af8ed947e0add77f191736dab5',
    };

    // Configure mock to return trailer metadata for the trailer item
    // and normal metadata for the regular episode
    configureMockJellyfinClient([
      {
        Id: 'e5a547eef1d6ed70045cc4bc83e0dad5',
        Type: 'Episode',
        ParentIndexNumber: 1,
        IndexNumber: 1,
        ProductionYear: 2015,
        ImageTags: { Primary: 'abc123' },
      },
      {
        Id: 'trailer-item-id',
        Type: 'Video',
        ExtraType: 'Trailer',
      },
    ]);

    let callCount = 0;
    (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      const mockLimit = vi.fn();
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });

      if (callCount === 1) {
        mockLimit.mockResolvedValue([mockServer]);
      } else if (callCount === 2) {
        mockWhere.mockResolvedValue([mockServerUser]);
      } else {
        mockWhere.mockResolvedValue([]);
      }

      return { from: mockFrom };
    });

    const insertedSessions: unknown[] = [];
    const mockValues = vi.fn().mockImplementation((data) => {
      insertedSessions.push(...(Array.isArray(data) ? data : [data]));
      return Promise.resolve(undefined);
    });
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

    const backup = JSON.stringify([
      {
        jf_playback_activity: [REAL_BACKUP_ACTIVITY_1, TRAILER_ACTIVITY],
      },
    ]);

    const result = await importJellystatBackup('server-1', backup, true);

    expect(result.success).toBe(true);
    expect(result.imported).toBe(1); // Only the episode, not the trailer
    expect(result.filtered).toBe(1); // Trailer was filtered
    expect(insertedSessions).toHaveLength(1);

    // Verify the inserted session is the episode, not the trailer
    const session = insertedSessions[0] as Record<string, unknown>;
    expect(session.mediaTitle).toBe('Pilot');
  });

  it('should still transform theme song activities correctly', () => {
    // transformActivityToSession should work regardless - the filtering
    // happens at the import level, not the transformation level
    const session = transformActivityToSession(THEME_SONG_ACTIVITY, 'server-1', 'user-1', {
      city: null,
      region: null,
      country: null,
      countryCode: null,
      continent: null,
      postal: null,
      lat: null,
      lon: null,
      asnNumber: null,
      asnOrganization: null,
    });

    expect(session.mediaTitle).toBe('Theme Song');
    expect(session.serverId).toBe('server-1');
    expect(session.serverUserId).toBe('user-1');
  });
});
