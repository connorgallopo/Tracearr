/**
 * Jellyfin Parser Tests
 *
 * Uses shared test factories for common behavior, with Jellyfin-specific
 * tests for platform differences (LastPausedDate, DirectStream handling).
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
} from '../jellyfin/parser.js';
import { createAllSharedParserTests } from './shared/jellyfinEmbyParserTests.js';

// ============================================================================
// Shared Tests (Common to Jellyfin and Emby)
// ============================================================================

createAllSharedParserTests(
  {
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
  },
  'jellyfin'
);

// ============================================================================
// Jellyfin-Specific: DirectStream Handling
// ============================================================================

describe('Jellyfin Parser - DirectStream Behavior', () => {
  it('treats DirectStream without TranscodingInfo as direct play (static file)', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        PlayMethod: 'DirectStream',
        IsPaused: false,
      },
    });

    expect(session!.quality.isTranscode).toBe(false);
    expect(session!.quality.videoDecision).toBe('directplay');
    expect(session!.quality.audioDecision).toBe('directplay');
  });

  it('treats TranscodingInfo with both streams copied as a remux whatever the client reports', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: { PlayMethod: 'DirectStream', IsPaused: false },
      TranscodingInfo: { VideoCodec: 'h264', IsVideoDirect: true, IsAudioDirect: true },
    });

    expect(session!.quality.isTranscode).toBe(false);
    expect(session!.quality.videoDecision).toBe('copy');
    expect(session!.quality.audioDecision).toBe('copy');
  });

  it('treats TranscodingInfo with re-encoded video as a transcode under a DirectPlay report', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: { PlayMethod: 'DirectPlay', IsPaused: false },
      TranscodingInfo: { VideoCodec: 'h264', IsVideoDirect: false, IsAudioDirect: true },
    });

    expect(session!.quality.isTranscode).toBe(true);
    expect(session!.quality.videoDecision).toBe('transcode');
    expect(session!.quality.audioDecision).toBe('copy');
  });

  it.each([
    { isAudioDirect: true, audioDecision: 'copy', isTranscode: false },
    { isAudioDirect: false, audioDecision: 'transcode', isTranscode: true },
  ])(
    'reads an audio-only job as video direct play (audio direct: $isAudioDirect)',
    ({ isAudioDirect, audioDecision, isTranscode }) => {
      const session = parseSession({
        Id: 'session-1',
        NowPlayingItem: { Id: '1', Name: 'Song', Type: 'Audio' },
        PlayState: { PlayMethod: 'Transcode', IsPaused: false },
        TranscodingInfo: { VideoCodec: null, IsVideoDirect: false, IsAudioDirect: isAudioDirect },
      });

      expect(session!.quality.videoDecision).toBe('directplay');
      expect(session!.quality.audioDecision).toBe(audioDecision);
      expect(session!.quality.isTranscode).toBe(isTranscode);
    }
  );

  it('should fall back to TranscodingInfo when PlayMethod not available', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        IsPaused: false,
      },
      TranscodingInfo: {
        VideoCodec: 'h264',
        IsVideoDirect: false,
      },
    });

    expect(session!.quality.isTranscode).toBe(true);
    expect(session!.quality.videoDecision).toBe('transcode');
  });
});

// ============================================================================
// Jellyfin-Specific: TranscodingInfo held across reads
// ============================================================================

describe('Jellyfin Parser - TranscodingInfo latch', () => {
  const read = (id: string, itemId: string, playMethod: string, withInfo: boolean) =>
    parseSessionsResponse([
      {
        Id: id,
        NowPlayingItem: { Id: itemId, Name: 'Test', Type: 'Movie' },
        PlayState: { PlayMethod: playMethod, IsPaused: false },
        ...(withInfo && {
          TranscodingInfo: {
            VideoCodec: 'h264',
            IsVideoDirect: false,
            IsAudioDirect: true,
            Bitrate: 4_000_000,
          },
        }),
      },
    ])[0]!;

  it('keeps a transcode steady when Jellyfin clears TranscodingInfo between reads', () => {
    read('latch-hold', 'item-1', 'DirectStream', true);
    const next = read('latch-hold', 'item-1', 'DirectStream', false);

    expect(next.quality.isTranscode).toBe(true);
    expect(next.quality.videoDecision).toBe('transcode');
    expect(next.quality.bitrate).toBe(4000);
  });

  it('lets go when the client reports a different play method', () => {
    read('latch-method', 'item-1', 'Transcode', true);
    const next = read('latch-method', 'item-1', 'DirectPlay', false);

    expect(next.quality.isTranscode).toBe(false);
    expect(next.quality.videoDecision).toBe('directplay');
  });

  it('lets go when the session moves to another item', () => {
    read('latch-item', 'item-1', 'DirectStream', true);
    const next = read('latch-item', 'item-2', 'DirectStream', false);

    expect(next.quality.videoDecision).toBe('directplay');
  });
});

// ============================================================================
// Jellyfin-Specific: Version Identity
// ============================================================================

describe('Jellyfin Parser - version identity', () => {
  it('stamps serverVersionKey from PlayState.MediaSourceId', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: {
        IsPaused: false,
        MediaSourceId: 'afae55612a42810f43ad292d9a910ff8',
      },
    });

    expect(session!.serverVersionKey).toBe('afae55612a42810f43ad292d9a910ff8');
  });

  it('leaves serverVersionKey unset when PlayState omits MediaSourceId', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: { IsPaused: false },
    });

    expect(session!.serverVersionKey).toBeUndefined();
  });
});

// ============================================================================
// Jellyfin-Specific: LastPausedDate Support
// ============================================================================

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

describe('Jellyfin Parser - transcode progress parity', () => {
  it('parses progress, derived speed, and hardware acceleration', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: {
        Id: '1',
        Name: 'Test',
        Type: 'Movie',
        MediaStreams: [{ Type: 'Video', RealFrameRate: 23.976, Codec: 'hevc' }],
      },
      PlayState: { IsPaused: false },
      TranscodingInfo: {
        IsVideoDirect: false,
        CompletionPercentage: 42.5,
        Framerate: 96,
        HardwareAccelerationType: 'qsv',
        Container: 'ts',
      },
    });

    const info = session!.quality.transcodeInfo;
    expect(info?.progress).toBe(42.5);
    expect(info?.speed).toBe(4);
    expect(info?.hwRequested).toBe(true);
    expect(info?.hwEncoding).toBe('qsv');
    expect(info?.throttled).toBeUndefined();
    expect(info?.maxOffsetAvailable).toBeUndefined();
  });

  it('sets no hardware fields when acceleration is none', () => {
    const session = parseSession({
      Id: 'session-1',
      NowPlayingItem: { Id: '1', Name: 'Test', Type: 'Movie' },
      PlayState: { IsPaused: false },
      TranscodingInfo: {
        IsVideoDirect: false,
        CompletionPercentage: 10,
        HardwareAccelerationType: 'none',
      },
    });

    const info = session!.quality.transcodeInfo;
    expect(info?.progress).toBe(10);
    expect(info?.hwRequested).toBeUndefined();
    expect(info?.hwEncoding).toBeUndefined();
    expect(info?.speed).toBeUndefined();
  });
});
